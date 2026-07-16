import {
  RepositoryReferenceSchema,
  TaskManifestContentSchema,
  type EngineerExecutionManager,
  type EngineerContextManager,
  type EngineerPublicationManager,
  type EngineerPlanningManager,
  type EngineerVerificationManager,
  type EngineerRun,
  type EngineerSupervisor,
  type RepositoryReference,
  type TaskManifestContent,
  type LocalArtifactStore,
  type BudgetTopUp,
  type EngineerBudgetSelection,
  type EngineerBudgetSnapshot,
  engineerObservabilitySnapshot,
  createCorrectedRunDirective,
  manifestPatternMatchesPath,
  type SafeCorrectionCode,
  isCancellationAllowed,
  hasUnreconciledRemotePublication,
  sha256,
  canTransition,
  EngineerPlanningCancelledError,
  EngineerPlanningTimeoutError,
  FailureRecordSchema,
} from "@zintus/engineer";
import type { EngineerPrincipal } from "./engineer-identity.js";
import { previewEngineerArtifact } from "./engineer-artifact-preview.js";
import type { EngineerCapabilityPreflight, EngineerReadiness } from "./engineer-preflight.js";
import { redactSecrets } from "@zintus/router";
import { createHash, randomUUID } from "node:crypto";

export interface EngineerRunManagerOptions {
  supervisor: EngineerSupervisor;
  execution?: EngineerExecutionManager;
  verification?: EngineerVerificationManager;
  publication?: EngineerPublicationManager;
  diffForRun?: (runId: string) => string;
  planning?: EngineerPlanningManager;
  artifactStore?: LocalArtifactStore;
  cleanupRun?: (runId: string) => void | Promise<void>;
  preflight: EngineerCapabilityPreflight;
  principal: EngineerPrincipal;
  context?: EngineerContextManager;
}

/** Gateway facade. It exposes no generic state-transition endpoint. */
export class EngineerRunManager {
  private readonly options: EngineerRunManagerOptions;
  private readonly background = new Set<Promise<void>>();
  private readonly activePlanning = new Map<string, AbortController>();
  private draining = false;

  constructor(options: EngineerRunManagerOptions) {
    if (!options.preflight || !options.principal) throw new Error("Engineer principal and capability preflight are mandatory");
    this.options = options;
  }

  principal(): EngineerPrincipal { return { ...this.options.principal }; }
  readiness(): EngineerReadiness { return this.options.preflight.readiness(); }
  ensureReady(): Promise<void> { return this.options.preflight.assertStartup(); }

  repository(principal: EngineerPrincipal): RepositoryReference {
    this.assertPrincipal(principal);
    return this.options.preflight.repository();
  }

  repositories(principal: EngineerPrincipal): RepositoryReference[] {
    this.assertPrincipal(principal);
    return this.options.preflight.repositories();
  }

  async create(principal: EngineerPrincipal, input: {
    runId?: string;
    repository: RepositoryReference;
    request: string;
    budget?: Partial<EngineerBudgetSelection>;
  }): Promise<EngineerRun> {
    this.assertPrincipal(principal);
    const repository = RepositoryReferenceSchema.parse(input.repository);
    await this.options.preflight.assertRunAdmission(repository);
    return this.options.supervisor.receiveRequest({
      ...input,
      userId: principal.ownerId,
      repository,
    });
  }

  get(runId: string): { run: EngineerRun; budget: EngineerBudgetSnapshot; lastError: string | null } {
    this.assertOwner(runId, this.options.principal);
    return { run: this.options.supervisor.getRun(runId), budget: this.options.supervisor.reconcileBudget(runId), lastError: this.options.supervisor.getLastError(runId) };
  }

  /** One ownership-checked projection for the active UI; individual routes remain for compatibility. */
  snapshot(principal: EngineerPrincipal, runId: string) {
    this.assertPrincipal(principal);
    this.assertOwner(runId, principal);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const beforeRun = this.options.supervisor.getRun(runId);
      const beforeSequence = this.options.supervisor.latestEventSequence(runId);
      const errors: Array<{ section: string; message: string }> = [];
      const section = <T>(name: string, read: () => T, fallback: T): T => {
        try { return read(); }
        catch (error) {
          errors.push({ section: name, message: redactSecrets(error instanceof Error ? error.message : String(error)) });
          return fallback;
        }
      };
      const events = this.options.supervisor.listEvents(runId, Math.max(0, beforeSequence - 500), 500);
      const reachedImplementation = events.some((event) => [
        "IMPLEMENTING", "FAST_CHECKS", "UNIT_TESTING", "INTEGRATION_TESTING", "E2E_TESTING",
        "VERIFICATION_RECOVERY", "REVERIFYING",
      ].includes(event.nextState));
      const reachedVerification = events.some((event) => [
        "FAST_CHECKS", "UNIT_TESTING", "INTEGRATION_TESTING", "E2E_TESTING", "FLAKE_QUARANTINE",
        "SECURITY_REVIEW", "CODE_REVIEW", "EVIDENCE_SYNTHESIS", "REVIEWING", "REVIEW_APPROVED",
        "REVIEW_CHANGES_REQUESTED", "REVIEW_REJECTED", "HUMAN_REVIEW_REQUIRED", "HUMAN_APPROVAL_PENDING",
        "HUMAN_APPROVED", "PR_PREFLIGHT", "PR_CREATING", "PR_CREATED", "COMPLETED",
      ].includes(event.nextState));
      const status = this.get(runId);
      const data = {
        artifacts: section("artifacts", () => this.artifacts(runId), []),
        claims: reachedVerification ? section("claims", () => this.claims(runId), []) : [],
        evidenceBundles: reachedVerification ? section("evidence", () => this.evidenceBundles(runId), []) : [],
        tests: reachedVerification ? section("tests", () => this.tests(runId), []) : [],
        securityFindings: reachedVerification ? section("security", () => this.security(runId), []) : [],
        failures: section("failures", () => this.failures(runId), []),
        gitOperations: reachedVerification ? section("publication", () => this.gitOperations(runId), []) : [],
        diff: reachedImplementation ? section("diff", () => this.diff(runId), "") : "",
        approval: reachedVerification ? section("approval", () => this.approval(runId), null) : null,
        decisions: section("decisions", () => this.decisions(principal, runId), []),
        errors,
      };
      const afterSequence = this.options.supervisor.latestEventSequence(runId);
      const afterRun = this.options.supervisor.getRun(runId);
      const lastEvent = events.at(-1);
      const coherent = beforeSequence === afterSequence &&
        beforeRun.stateVersion === afterRun.stateVersion &&
        status.run.stateVersion === afterRun.stateVersion && status.run.state === afterRun.state &&
        (afterSequence === 0
          ? events.length === 0 && afterRun.stateVersion === 0
          : lastEvent?.sequence === afterSequence && lastEvent.stateVersion === afterRun.stateVersion && lastEvent.nextState === afterRun.state);
      if (coherent) {
        return {
          status,
          events,
          latestEventSequence: afterSequence,
          snapshotFence: { stateVersion: afterRun.stateVersion, eventSequence: afterSequence },
          data,
        };
      }
    }
    throw new Error("Engineer run changed repeatedly while building a consistent snapshot; retry the read");
  }

  budget(principal: EngineerPrincipal, runId: string): EngineerBudgetSnapshot {
    this.assertOwner(runId, principal);
    return this.options.supervisor.reconcileBudget(runId);
  }

  topUpBudget(principal: EngineerPrincipal, runId: string, input: {
    expectedRevision: number; topUp: BudgetTopUp; idempotencyKey: string;
  }): EngineerBudgetSnapshot {
    this.assertOwner(runId, principal);
    return this.options.supervisor.topUpBudget({ runId, ...input, actorId: principal.ownerId });
  }

  resumeBudget(principal: EngineerPrincipal, runId: string, input: {
    expectedStateVersion: number; expectedBudgetRevision: number; idempotencyKey: string;
  }): EngineerRun {
    this.assertOwner(runId, principal);
    const result = this.options.supervisor.resumeBudget({ runId, ...input, actorId: principal.ownerId });
    this.clearError(runId);
    return result.run;
  }

  list(principal: EngineerPrincipal): EngineerRun[] {
    this.assertPrincipal(principal);
    // Compatibility path: callers of the original list API receive the full
    // owner-scoped history. New UIs should use listPage for bounded reads.
    return this.options.supervisor.listRuns().filter((run) => run.userId === principal.ownerId).reverse();
  }

  listPage(principal: EngineerPrincipal, input: { limit: number; before?: { createdAt: string; runId: string } }) {
    this.assertPrincipal(principal);
    const rows = this.options.supervisor.listRunsForUser(principal.ownerId, Math.min(100, input.limit + 1), input.before);
    const hasMore = rows.length > input.limit;
    const runs = rows.slice(0, input.limit);
    const last = runs.at(-1);
    return { runs, nextCursor: hasMore && last ? Buffer.from(JSON.stringify([last.createdAt, last.runId])).toString("base64url") : null };
  }

  observability() { return engineerObservabilitySnapshot(this.options.supervisor, new Date(), this.options.principal.ownerId); }

  reviewApprovedEndsStream(): boolean { return !this.options.publication; }

  async freeze(principal: EngineerPrincipal, runId: string, input: {
    expectedStateVersion: number;
    manifest: TaskManifestContent;
    idempotencyKey: string;
  }): Promise<EngineerRun> {
    this.assertPrincipal(principal);
    this.assertOwner(runId, principal);
    await this.options.preflight.assertRunAdmission(this.options.supervisor.getRun(runId).repository);
    return this.options.supervisor.freezePlan({
      runId,
      expectedStateVersion: input.expectedStateVersion,
      manifest: TaskManifestContentSchema.parse(input.manifest),
      actorId: principal.reviewerId,
      idempotencyKey: input.idempotencyKey,
    }).run;
  }

  async plan(principal: EngineerPrincipal, runId: string) {
    this.assertPrincipal(principal);
    this.assertOwner(runId, principal);
    await this.options.preflight.assertRunAdmission(this.options.supervisor.getRun(runId).repository);
    if (!this.options.context) throw new Error("Engineer context is not configured on this gateway");
    if (!this.options.planning) throw new Error("Engineer planning is not configured on this gateway");
    if (this.activePlanning.has(runId)) throw new Error("Evidence planning is already active for this run");
    const cancellation = new AbortController();
    this.activePlanning.set(runId, cancellation);
    this.beginPlanning(runId);
    this.clearError(runId);
    const failureCountBefore = this.options.supervisor.listFailures(runId).length;
    try {
      await this.options.context.build(runId);
      if (cancellation.signal.aborted) throw new EngineerPlanningCancelledError();
      const plan = await this.options.planning.plan(runId, cancellation.signal);
      this.clearError(runId);
      return plan;
    } catch (error) {
      if (cancellation.signal.aborted || error instanceof EngineerPlanningCancelledError) {
        this.clearError(runId);
        throw error instanceof EngineerPlanningCancelledError ? error : new EngineerPlanningCancelledError();
      }
      const message = this.persistError(runId, error);
      const failures = this.options.supervisor.listFailures(runId);
      if (failures.length === failureCountBefore) {
        this.options.supervisor.recordFailure(FailureRecordSchema.parse({
          failureId: randomUUID(),
          runId,
          failureClass: "WORKFLOW_FAILURE",
          reasonCode: "PLANNING_PIPELINE_FAILED",
          fingerprint: sha256({ reasonCode: "PLANNING_PIPELINE_FAILED", message }),
          evidenceIds: [],
          retryable: !(error instanceof EngineerPlanningTimeoutError),
          createdAt: new Date().toISOString(),
        }));
      }
      const latestFailure = this.options.supervisor.listFailures(runId).at(-1);
      const current = this.options.supervisor.getRun(runId);
      const timedOut = error instanceof EngineerPlanningTimeoutError;
      const terminalFailure = timedOut || latestFailure?.retryable === false || current.state === "REPLANNING";
      const nextState = terminalFailure ? "FAILED" : "REPLANNING";
      if (canTransition(current.state, nextState)) {
        this.options.supervisor.transition({
          runId,
          expectedStateVersion: current.stateVersion,
          nextState,
          reasonCode: timedOut ? "PLANNING_STEP_TIMED_OUT" : terminalFailure ? "PLANNING_FAILED" : "PLANNING_RETRY_REQUIRED",
          idempotencyKey: `gateway:planning-error:${current.stateVersion}:${latestFailure?.fingerprint ?? sha256(message)}`,
        });
      }
      throw error;
    } finally {
      if (this.activePlanning.get(runId) === cancellation) this.activePlanning.delete(runId);
    }
  }

  planProposal(runId: string) {
    this.assertOwner(runId, this.options.principal);
    return this.options.supervisor.latestPlanProposal(runId);
  }

  async start(principal: EngineerPrincipal, runId: string): Promise<EngineerRun> {
    this.assertPrincipal(principal);
    this.assertOwner(runId, principal);
    await this.options.preflight.assertRunAdmission(this.options.supervisor.getRun(runId).repository);
    if (!this.options.execution) throw new Error("Engineer execution is not configured on this gateway");
    const run = this.options.execution.enqueue(runId);
    this.clearError(runId);
    this.launchExecution(runId);
    return run;
  }

  async retryProviderTimeout(principal: EngineerPrincipal, runId: string): Promise<EngineerRun> {
    this.assertPrincipal(principal);
    this.assertOwner(runId, principal);
    await this.options.preflight.assertRunAdmission(this.options.supervisor.getRun(runId).repository);
    if (!this.options.execution) throw new Error("Engineer execution is not configured on this gateway");
    const run = await this.options.execution.retryProviderTimeout(runId);
    this.clearError(runId);
    this.launchExecution(runId);
    return run;
  }

  private launchExecution(runId: string): void {
    const job = (async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      if (this.draining) throw new Error("Engineer gateway is draining");
      await this.options.execution!.runQueued(runId).then(async () => {
        if (this.options.verification) await this.options.verification.verify(runId);
        if (this.options.publication && this.options.supervisor.getRun(runId).state === "REVIEW_APPROVED") {
          await this.options.preflight.assertRunAdmission(this.options.supervisor.getRun(runId).repository);
          await this.options.publication.start(runId, this.options.principal.reviewerId);
        }
      });
    })().catch((error) => {
      this.persistError(runId, error);
    });
    this.background.add(job);
    void job.finally(() => this.background.delete(job));
  }

  /** Recreates stale work as a new immutable run on the credentialed current base. */
  async recoverStaleBase(principal: EngineerPrincipal, runId: string): Promise<{ supersededRun: EngineerRun; replacementRun: EngineerRun }> {
    this.assertPrincipal(principal);
    this.assertOwner(runId, principal);
    if (!this.options.publication || !this.options.planning || !this.options.context || !this.options.execution || !this.options.artifactStore) {
      throw new Error("stale-base recovery is not configured on this gateway");
    }
    const staleRun = this.options.supervisor.getRun(runId);
    const repository = await this.options.publication.replacementRepositoryForStale(runId);
    this.options.preflight.acceptAdvancedBase(staleRun.repository.baseCommitSha, repository);
    const replacementRunId = `recovery-${sha256({ runId, baseCommitSha: repository.baseCommitSha }).slice(0, 32)}`;
    let replacement = this.options.supervisor.listRuns().find((item) => item.runId === replacementRunId);
    if (!replacement) {
      replacement = this.options.supervisor.receiveRequest({
        runId: replacementRunId,
        userId: principal.ownerId,
        repository,
        request: staleRun.requestOriginal,
      });
    }
    if (replacement.state === "REQUEST_RECEIVED" || replacement.state === "PLANNING" || replacement.state === "REPLANNING") {
      const proposal = await this.plan(principal, replacement.runId);
      replacement = this.options.supervisor.getRun(replacement.runId);
      if (replacement.state === "PLAN_READY") {
        replacement = this.options.supervisor.freezePlan({
          runId: replacement.runId,
          expectedStateVersion: replacement.stateVersion,
          manifest: proposal.manifest,
          actorId: "engineer-supervisor",
          idempotencyKey: `stale-recovery:freeze:${replacement.runId}:${proposal.manifest.manifestVersion}`,
        }).run;
      }
    }
    if (replacement.state === "PLAN_FROZEN") replacement = await this.start(principal, replacement.runId);

    const relation = this.options.supervisor.recordArtifact(this.options.artifactStore.put({
      runId,
      type: "STALE_BASE_REPLACEMENT",
      bytes: JSON.stringify({ replacementRunId: replacement.runId, previousBaseCommitSha: staleRun.repository.baseCommitSha, currentBaseCommitSha: repository.baseCommitSha }),
      producerType: "SYSTEM",
      producerId: "engineer-supervisor",
      trusted: true,
    }));
    const currentStale = this.options.supervisor.getRun(runId);
    const supersededRun = currentStale.state === "BASE_BRANCH_STALE"
      ? this.options.supervisor.transition({
          runId,
          expectedStateVersion: currentStale.stateVersion,
          nextState: "HUMAN_REVIEW_REQUIRED",
          reasonCode: "STALE_BASE_SUPERSEDED_BY_REPLACEMENT_RUN",
          evidenceIds: [relation.artifactId],
          manifestHash: currentStale.manifestHash,
          idempotencyKey: `stale-recovery:supersede:${replacement.runId}`,
        }).run
      : currentStale;
    return { supersededRun, replacementRun: replacement };
  }

  /**
   * Creates a distinct run with the exact original request and acceptance
   * criteria. Only bounded, policy-defined corrections derived from durable
   * findings/failures cross into the replacement run.
   */
  async createCorrectedRun(principal: EngineerPrincipal, runId: string): Promise<{
    sourceRun: EngineerRun;
    replacementRun: EngineerRun;
    plan: Awaited<ReturnType<EngineerPlanningManager["plan"]>>;
  }> {
    this.assertPrincipal(principal);
    this.assertOwner(runId, principal);
    if (!this.options.planning || !this.options.context || !this.options.artifactStore) {
      throw new Error("corrected-run recovery is not configured on this gateway");
    }
    const sourceRun = this.options.supervisor.getRun(runId);
    if (!["SECURITY_ESCALATION", "VERIFICATION_INCOMPLETE", "REJECTED", "REVIEW_REJECTED", "FAILED"].includes(sourceRun.state)) {
      throw new Error(`corrected-run recovery is not available from ${sourceRun.state}`);
    }
    const sourceManifest = this.options.supervisor.getManifest(runId);
    if (!sourceManifest) throw new Error("corrected-run recovery requires the original frozen manifest");
    await this.options.preflight.assertRunAdmission(sourceRun.repository);

    const actions = this.deriveSafeCorrections(runId, sourceManifest.allowedPaths);
    if (actions.length === 0) {
      throw new Error("no structured safe correction is available for this run; inspect the evidence and create a bounded new request");
    }
    const replacementRunId = `corrected-${sha256({
      sourceRunId: runId,
      sourceManifestHash: sourceManifest.manifestHash,
      actions,
    }).slice("sha256:".length, "sha256:".length + 32)}`;
    let replacement = this.options.supervisor.listRuns().find((candidate) => candidate.runId === replacementRunId);
    if (!replacement) {
      replacement = this.options.supervisor.receiveRequest({
        runId: replacementRunId,
        userId: principal.ownerId,
        repository: sourceRun.repository,
        request: sourceRun.requestOriginal,
      });
    }
    if (replacement.requestOriginal !== sourceRun.requestOriginal || sha256(replacement.repository) !== sha256(sourceRun.repository)) {
      throw new Error("existing corrected run does not match its immutable source identity");
    }

    const existingDirective = this.options.supervisor.listArtifacts(replacementRunId)
      .find((artifact) => artifact.type === "CORRECTED_RUN_DIRECTIVE");
    if (!existingDirective) {
      const createdAt = new Date().toISOString();
      const directive = createCorrectedRunDirective({
        policyVersion: "engineer-corrected-run-v1",
        sourceRunId: runId,
        replacementRunId,
        sourceManifestHash: sourceManifest.manifestHash,
        requestOriginalHash: sha256(sourceRun.requestOriginal),
        requestNormalized: sourceManifest.request.normalized,
        acceptanceCriteria: sourceManifest.acceptanceCriteria,
        acceptanceCriteriaHash: sha256(sourceManifest.acceptanceCriteria),
        testPlan: sourceManifest.testPlan,
        allowedPaths: sourceManifest.allowedPaths,
        deniedPaths: sourceManifest.deniedPaths,
        allowedCommands: sourceManifest.allowedCommands,
        actions,
        createdAt,
      });
      this.options.supervisor.recordArtifact(this.options.artifactStore.put({
        runId: replacementRunId,
        type: "CORRECTED_RUN_DIRECTIVE",
        bytes: JSON.stringify(directive),
        producerType: "SYSTEM",
        producerId: "engineer-correction-policy",
        trusted: true,
      }));
    }

    if (replacement.state === "REQUEST_RECEIVED") await this.options.context.build(replacementRunId);
    let plan = this.options.supervisor.latestPlanProposal(replacementRunId);
    if (["REQUEST_RECEIVED", "PLANNING", "REPLANNING"].includes(replacement.state)) {
      plan = await this.options.planning.plan(replacementRunId);
    }
    if (!plan) throw new Error(`corrected run ${replacement.state} has no durable plan proposal`);
    replacement = this.options.supervisor.getRun(replacementRunId);
    return { sourceRun, replacementRun: replacement, plan };
  }

  private deriveSafeCorrections(runId: string, allowedPaths: string[]): Array<{
    code: SafeCorrectionCode;
    sourceRecordIds: string[];
    file: string | null;
    lineStart: number | null;
    lineEnd: number | null;
  }> {
    const actions: Array<{
      code: SafeCorrectionCode;
      sourceRecordIds: string[];
      file: string | null;
      lineStart: number | null;
      lineEnd: number | null;
    }> = [];
    for (const finding of this.options.supervisor.listSecurityFindings(runId).filter((item) => item.status === "OPEN")) {
      const signal = `${finding.category} ${finding.description}`.toLowerCase();
      const boundedFile = finding.file && !finding.file.startsWith("/") && !finding.file.includes("\\") &&
          !finding.file.split("/").some((segment) => !segment || segment === "." || segment === "..") &&
          allowedPaths.some((pattern) => manifestPatternMatchesPath(pattern, finding.file!))
        ? finding.file
        : null;
      const code: SafeCorrectionCode = /possible.secret|credential.like|hard.?coded (?:secret|credential)|test secret/.test(signal)
        ? "GENERATE_NON_SECRET_TEST_FIXTURES"
        : /unauthori[sz]ed|outside (?:the )?(?:allowlist|allowed paths)|scope violation/.test(signal)
          ? "REMOVE_UNAUTHORIZED_PATH_CHANGES"
          : /test (?:integrity|baseline)|baseline test/.test(signal)
            ? "RESTORE_TEST_BASELINE_INTEGRITY"
            : "ADDRESS_RECORDED_SECURITY_FINDING";
      actions.push({
        code,
        sourceRecordIds: [finding.securityFindingId],
        file: boundedFile,
        lineStart: boundedFile ? finding.lineStart : null,
        lineEnd: boundedFile ? finding.lineEnd : null,
      });
    }
    for (const failure of this.options.supervisor.listFailures(runId)) {
      if (failure.failureClass !== "TEST_FAILURE" && !/TEST|VERIFICATION/.test(failure.reasonCode)) continue;
      actions.push({
        code: "REPAIR_FAILED_VERIFICATION",
        sourceRecordIds: [failure.failureId],
        file: null,
        lineStart: null,
        lineEnd: null,
      });
    }
    const unique = new Map(actions.map((action) => [sha256(action), action]));
    return [...unique.values()];
  }

  /** Prevents new detached work, aborts execution, and waits for verification/publication cleanup. */
  async drain(): Promise<void> {
    this.draining = true;
    await this.options.execution?.drain(false);
    await Promise.allSettled([...this.background]);
    for (const run of this.options.supervisor.listRuns(["QUEUED"])) {
      this.options.supervisor.transition({
        runId: run.runId,
        expectedStateVersion: run.stateVersion,
        nextState: "TIMED_OUT",
        reasonCode: "GATEWAY_DRAINED_BEFORE_EXECUTION",
        manifestHash: run.manifestHash,
        idempotencyKey: `gateway-drain:${run.stateVersion}`,
      });
    }
    this.options.execution?.destroyAll();
  }

  events(runId: string) {
    this.assertOwner(runId, this.options.principal);
    return this.options.supervisor.listEvents(runId);
  }

  artifacts(runId: string) {
    this.assertOwner(runId, this.options.principal);
    return this.options.supervisor.listArtifacts(runId).map(({ storageReference: _privateStorageReference, ...artifact }) => artifact);
  }

  artifactPreview(principal: EngineerPrincipal, runId: string, artifactId: string) {
    this.assertPrincipal(principal);
    this.assertOwner(runId, principal);
    if (!this.options.artifactStore) throw new Error("Engineer artifact store is not configured");
    const artifact = this.options.supervisor.listArtifacts(runId).find((item) => item.artifactId === artifactId);
    if (!artifact) throw new Error("Engineer artifact not found");
    return previewEngineerArtifact(this.options.artifactStore, artifact);
  }

  claims(runId: string) {
    this.assertOwner(runId, this.options.principal);
    return this.options.supervisor.listClaimEvidence(runId);
  }

  evidenceBundles(runId: string) {
    this.assertOwner(runId, this.options.principal);
    return this.options.supervisor.listEvidenceBundles(runId);
  }

  evidenceExport(principal: EngineerPrincipal, runId: string) {
    this.assertPrincipal(principal);
    this.assertOwner(runId, principal);
    if (!this.options.artifactStore) throw new Error("Engineer artifact store is required for a complete evidence export");
    const snapshot = this.options.supervisor.evidenceExportSnapshot(runId);
    const artifactPayloads = snapshot.artifacts.map((artifact) => ({
      artifactId: artifact.artifactId,
      sha256: artifact.sha256,
      sizeBytes: artifact.sizeBytes,
      encoding: "base64" as const,
      content: this.options.artifactStore!.read(artifact).toString("base64"),
    }));
    const content = {
      exportVersion: 2,
      run: snapshot.run,
      manifest: snapshot.manifest,
      riskAssessment: snapshot.riskAssessment,
      events: snapshot.events,
      completeness: { eventsComplete: snapshot.events.length === snapshot.latestEventSequence, eventCount: snapshot.events.length },
      artifacts: snapshot.artifacts,
      artifactPayloads,
      durableRecords: snapshot.durableRecords,
      claims: snapshot.claims,
      evidenceBundles: snapshot.evidenceBundles,
      tests: snapshot.tests,
      securityFindings: snapshot.securityFindings,
      failures: snapshot.failures,
      decisions: snapshot.decisions,
    };
    return { ...content, exportHash: sha256(content) };
  }

  evidenceExportStream(principal: EngineerPrincipal, runId: string): ReadableStream<Uint8Array> {
    this.assertPrincipal(principal);
    this.assertOwner(runId, principal);
    if (!this.options.artifactStore) throw new Error("Engineer artifact store is required for a complete evidence export");
    const snapshot = this.options.supervisor.evidenceExportSummary(runId);
    const supervisor = this.options.supervisor;
    const artifactStore = this.options.artifactStore;
    const hash = createHash("sha256");
    const encoder = new TextEncoder();
    const encoded = (value: string, checksum = true): Uint8Array => {
      if (checksum) hash.update(value, "utf8");
      return encoder.encode(value);
    };
    const record = (value: Record<string, unknown>): Uint8Array => encoded(`${JSON.stringify(value)}\n`);
    const stripStorageReferences = (value: unknown): string => JSON.stringify(value, (key, item) =>
      key === "storage_reference" || key === "storageReference" ? undefined : item);

    async function* chunks(): AsyncGenerator<Uint8Array> {
      const artifacts = snapshot.artifacts.map(({ storageReference: _privateStorageReference, ...artifact }) => artifact);
      yield record({ type: "header", exportVersion: 3, runId, generatedAt: new Date().toISOString(), format: "application/x-ndjson" });
      yield record({ type: "run", value: snapshot.run });
      yield record({ type: "manifest", value: snapshot.manifest });
      yield record({ type: "riskAssessment", value: snapshot.riskAssessment });

      yield encoded('{"type":"events","value":[');
      let eventCursor = 0;
      let eventCount = 0;
      let firstEvent = true;
      while (eventCursor < snapshot.latestEventSequence) {
        const page = supervisor.listEvents(runId, eventCursor, 1_000)
          .filter((event) => event.sequence <= snapshot.latestEventSequence);
        if (page.length === 0) break;
        for (const event of page) {
          yield encoded(`${firstEvent ? "" : ","}${JSON.stringify(event)}`);
          firstEvent = false;
          eventCount += 1;
        }
        const nextCursor = page.at(-1)!.sequence;
        if (nextCursor <= eventCursor) throw new Error("Engineer event export cursor did not advance");
        eventCursor = nextCursor;
      }
      yield encoded(`],"complete":${eventCount === snapshot.latestEventSequence}}\n`);
      yield record({ type: "artifacts", value: artifacts });

      yield encoded('{"type":"durableRecords","value":{');
      let firstTable = true;
      for (const table of supervisor.exportRunRecordTables(runId)) {
        yield encoded(`${firstTable ? "" : ","}${JSON.stringify(table)}:[`);
        firstTable = false;
        let firstRow = true;
        for (let offset = 0; ; offset += 500) {
          const page = supervisor.exportRunRecordPage(runId, table, offset, 500);
          for (const row of page) {
            yield encoded(`${firstRow ? "" : ","}${stripStorageReferences(row)}`);
            firstRow = false;
          }
          if (page.length < 500) break;
        }
        yield encoded("]");
      }
      yield encoded("}}\n");

      yield record({ type: "claims", value: snapshot.claims });
      yield record({ type: "evidenceBundles", value: snapshot.evidenceBundles });
      yield record({ type: "tests", value: snapshot.tests });
      yield record({ type: "securityFindings", value: snapshot.securityFindings });
      yield record({ type: "failures", value: snapshot.failures });
      yield record({ type: "decisions", value: snapshot.decisions });

      for (const artifact of snapshot.artifacts) {
        const prefix = JSON.stringify({
          type: "artifactPayload",
          artifactId: artifact.artifactId,
          sha256: artifact.sha256,
          sizeBytes: artifact.sizeBytes,
          encoding: "base64",
        });
        yield encoded(`${prefix.slice(0, -1)},"content":"`);
        let carry = Buffer.alloc(0);
        for await (const bytes of artifactStore.verifiedChunks(artifact)) {
          const combined = carry.byteLength === 0 ? bytes : Buffer.concat([carry, bytes]);
          const completeBytes = combined.byteLength - (combined.byteLength % 3);
          if (completeBytes > 0) yield encoded(combined.subarray(0, completeBytes).toString("base64"));
          carry = completeBytes === combined.byteLength ? Buffer.alloc(0) : Buffer.from(combined.subarray(completeBytes));
        }
        if (carry.byteLength > 0) yield encoded(carry.toString("base64"));
        yield encoded('"}\n');
      }

      yield encoded(`${JSON.stringify({ type: "checksum", algorithm: "sha256", value: `sha256:${hash.digest("hex")}` })}\n`, false);
    }

    const iterator = chunks();
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await iterator.next();
          if (next.done) controller.close();
          else controller.enqueue(next.value);
        } catch (error) {
          controller.error(error);
        }
      },
      async cancel() { await iterator.return?.(undefined); },
    });
  }

  tests(runId: string) { this.assertOwner(runId, this.options.principal); return this.options.supervisor.listTestExecutions(runId); }

  security(runId: string) { this.assertOwner(runId, this.options.principal); return this.options.supervisor.listSecurityFindings(runId); }

  failures(runId: string) { this.assertOwner(runId, this.options.principal); return this.options.supervisor.listFailures(runId); }

  gitOperations(runId: string) { this.assertOwner(runId, this.options.principal); return this.options.supervisor.listGitOperations(runId); }

  decisions(principal: EngineerPrincipal, runId: string) {
    this.assertPrincipal(principal);
    this.assertOwner(runId, principal);
    return this.options.supervisor.listDecisions(runId).map((decision) => {
      const resolution = this.options.supervisor.getDecisionResolution(runId, decision.decisionId);
      return {
        decisionId: decision.decisionId,
        question: decision.question,
        classification: decision.classification,
        reasonCodes: decision.reasonCodes,
        options: decision.options.map(({ sourceEvidenceIds: _sourceEvidenceIds, ...option }) => option),
        recommendedOptionId: decision.recommendedOptionId,
        status: resolution ? "RESOLVED" as const : "OPEN" as const,
        selectedOptionId: resolution?.selectedOptionId ?? null,
        createdAt: decision.createdAt,
        selectionMode: "EXCLUSIVE" as const,
        provenance: { origin: "AI_GENERATED" as const, trust: "UNTRUSTED_MODEL_OUTPUT" as const },
      };
    });
  }

  async resolveDecision(principal: EngineerPrincipal, runId: string, decisionId: string, input: {
    expectedStateVersion: number;
    selectedOptionId: string;
    rationale: string;
    idempotencyKey: string;
  }) {
    this.assertPrincipal(principal);
    this.assertOwner(runId, principal);
    await this.options.preflight.assertRunAdmission(this.options.supervisor.getRun(runId).repository);
    const resolution = this.options.supervisor.resolveDecision({
      runId,
      decisionId,
      expectedStateVersion: input.expectedStateVersion,
      selectedOptionId: input.selectedOptionId,
      actorId: principal.reviewerId,
      rationale: input.rationale,
      sourceEvidence: [{
        evidenceId: `human-response:${input.expectedStateVersion}`,
        runId,
        sourceType: "HUMAN_RESPONSE",
        trust: "TRUSTED_HUMAN",
        summary: "Authenticated local Engineer principal selected this option.",
      }],
      idempotencyKey: input.idempotencyKey,
    });
    let plan = null;
    let planningError: string | null = null;
    if (this.options.supervisor.getRun(runId).state === "PLANNING") {
      if (!this.options.planning) {
        planningError = "Engineer planning is not configured on this gateway";
      } else {
        try {
          plan = await this.options.planning.plan(runId);
          this.clearError(runId);
        } catch (error) {
          planningError = redactSecrets(error instanceof Error ? error.message : String(error));
          this.options.supervisor.setLastError(runId, planningError);
        }
      }
    }
    return { resolution, plan, planningError };
  }

  private beginPlanning(runId: string): void {
    let run = this.options.supervisor.getRun(runId);
    if (run.state !== "REQUEST_RECEIVED") return;
    run = this.options.supervisor.normalizeRequest({
      runId,
      expectedStateVersion: run.stateVersion,
      normalizedRequest: run.requestOriginal,
      idempotencyKey: `gateway:planning-normalize:${sha256(run.requestOriginal)}`,
    }).run;
    this.options.supervisor.transition({
      runId,
      expectedStateVersion: run.stateVersion,
      nextState: "PLANNING",
      reasonCode: "EVIDENCE_PLANNING_STARTED",
      idempotencyKey: `gateway:planning-start:${run.stateVersion}`,
    });
  }

  private persistError(runId: string, error: unknown): string {
    const message = redactSecrets(error instanceof Error ? error.message : String(error));
    this.options.supervisor.setLastError(runId, message);
    return message;
  }

  private clearError(runId: string): void {
    this.options.supervisor.setLastError(runId, null);
  }

  diff(runId: string) {
    this.assertOwner(runId, this.options.principal);
    if (!this.options.diffForRun) throw new Error("Engineer diff is not available on this gateway");
    return this.options.diffForRun(runId);
  }

  approval(runId: string) {
    this.assertOwner(runId, this.options.principal);
    return this.options.supervisor.latestApprovalRequest(runId);
  }

  async approve(principal: EngineerPrincipal, runId: string, reason: string) {
    this.assertPrincipal(principal);
    this.assertOwner(runId, principal);
    await this.options.preflight.assertRunAdmission(this.options.supervisor.getRun(runId).repository);
    if (!this.options.publication) throw new Error("Engineer publication is not configured on this gateway");
    return this.options.publication.approve(runId, principal.reviewerId, reason);
  }

  async requestChanges(principal: EngineerPrincipal, runId: string, reason: string): Promise<void> {
    this.assertPrincipal(principal);
    this.assertOwner(runId, principal);
    await this.options.preflight.assertRunAdmission(this.options.supervisor.getRun(runId).repository);
    if (!this.options.publication) throw new Error("Engineer publication is not configured on this gateway");
    this.options.publication.requestChanges(runId, principal.reviewerId, reason);
  }

  async reject(principal: EngineerPrincipal, runId: string, reason: string): Promise<void> {
    this.assertPrincipal(principal);
    this.assertOwner(runId, principal);
    await this.options.preflight.assertRunAdmission(this.options.supervisor.getRun(runId).repository);
    if (!this.options.publication) throw new Error("Engineer publication is not configured on this gateway");
    this.options.publication.reject(runId, principal.reviewerId, reason);
  }

  async resolveHumanReview(principal: EngineerPrincipal, runId: string, decision: "approve" | "reject", reason: string) {
    this.assertPrincipal(principal);
    this.assertOwner(runId, principal);
    await this.options.preflight.assertRunAdmission(this.options.supervisor.getRun(runId).repository);
    const run = this.options.supervisor.getRun(runId);
    if (run.state !== "HUMAN_REVIEW_REQUIRED") throw new Error(`human review requires HUMAN_REVIEW_REQUIRED, not ${run.state}`);
    const bundle = this.options.supervisor.listEvidenceBundles(runId).at(-1);
    if (!bundle) throw new Error("human review requires an immutable evidence bundle");
    const evidenceIds = [bundle.evidenceBundleId];
    if (decision === "reject") {
      return { run: this.options.supervisor.transition({
        runId, expectedStateVersion: run.stateVersion, nextState: "REJECTED",
        reasonCode: "HUMAN_REVIEW_REJECTED", actorType: "HUMAN", actorId: principal.reviewerId,
        evidenceIds, manifestHash: run.manifestHash, idempotencyKey: `human-review:reject:${run.stateVersion}:${sha256(reason)}`,
      }).run };
    }
    const approved = this.options.supervisor.transition({
      runId, expectedStateVersion: run.stateVersion, nextState: "REVIEW_APPROVED",
      reasonCode: "HUMAN_REVIEW_APPROVED", actorType: "HUMAN", actorId: principal.reviewerId,
      evidenceIds, manifestHash: run.manifestHash, idempotencyKey: `human-review:approve:${run.stateVersion}:${sha256(reason)}`,
      facts: { reviewerDecisionValid: true, freshReviewerSession: true },
    }).run;
    if (!this.options.publication) return { run: approved, publication: null };
    const publication = await this.options.publication.start(runId, principal.reviewerId);
    return { run: approved, publication };
  }

  async extendApproval(principal: EngineerPrincipal, runId: string, reason: string, extensionSeconds: number) {
    this.assertPrincipal(principal);
    this.assertOwner(runId, principal);
    await this.options.preflight.assertRunAdmission(this.options.supervisor.getRun(runId).repository);
    if (!this.options.publication) throw new Error("Engineer publication is not configured on this gateway");
    return this.options.publication.extend(runId, principal.reviewerId, reason, extensionSeconds);
  }

  async cancel(principal: EngineerPrincipal, runId: string, reason: string): Promise<void> {
    this.assertPrincipal(principal);
    this.assertOwner(runId, principal);
    this.activePlanning.get(runId)?.abort(new EngineerPlanningCancelledError());
    // Cancellation is a fail-safe control, not a new execution admission.
    // A run must remain stoppable after its base becomes stale or a connector
    // grant is revoked; ownership and publication cleanup fences still apply.
    if (this.options.publication) return this.options.publication.cancel(runId, principal.ownerId, reason);
    return this.cancelWithoutPublication(runId, principal.ownerId, reason);
  }

  private assertOwner(runId: string, principal: EngineerPrincipal): void {
    if (this.options.supervisor.getRun(runId).userId !== principal.ownerId) {
      throw new Error("authenticated Engineer principal does not own this run");
    }
  }

  private assertPrincipal(principal: EngineerPrincipal): void {
    if (principal.ownerId !== this.options.principal.ownerId ||
        principal.reviewerId !== this.options.principal.reviewerId ||
        principal.sessionId !== this.options.principal.sessionId ||
        principal.safetyIdentifier !== this.options.principal.safetyIdentifier) {
      throw new Error("untrusted Engineer principal");
    }
  }

  private async cancelWithoutPublication(runId: string, actorId: string, reason: string): Promise<void> {
    const artifactStore = this.options.artifactStore;
    if (!artifactStore) throw new Error("Engineer control is not configured on this gateway");
    const run = this.options.supervisor.getRun(runId);
    if (actorId !== run.userId) throw new Error("cancellation actor does not own this run");
    if (run.terminalAt) throw new Error(`terminal run ${run.state} cannot be cancelled`);
    const resumingPendingCleanup = run.state === "CANCELLATION_PENDING";
    if (!resumingPendingCleanup && !isCancellationAllowed(run.state)) {
      throw new Error(`cancellation is fenced while publication state is ${run.state}; remote cleanup is not safely available`);
    }
    if (hasUnreconciledRemotePublication(this.options.supervisor.listGitOperations(runId))) {
      throw new Error("cancellation is fenced because remote publication was attempted and no durable remote cleanup is available");
    }
    let current = run;
    if (!resumingPendingCleanup) {
      const artifact = this.options.supervisor.recordArtifact(artifactStore.put({
        runId, type: "CANCELLATION_REQUEST",
        bytes: JSON.stringify({ actorId, reason, requestedAt: new Date().toISOString() }),
        producerType: "SYSTEM", producerId: "engineer-supervisor", trusted: true,
      }));
      current = this.options.supervisor.transition({
        runId, expectedStateVersion: run.stateVersion, nextState: "CANCELLATION_PENDING",
        reasonCode: "USER_CANCELLATION_REQUESTED", actorType: "HUMAN", actorId,
        evidenceIds: [artifact.artifactId], manifestHash: run.manifestHash,
        idempotencyKey: `control:cancel:${run.stateVersion}`,
      }).run;
    }
    try {
      await this.options.cleanupRun?.(runId);
      current = this.options.supervisor.transition({
        runId, expectedStateVersion: current.stateVersion, nextState: "CANCELLED",
        reasonCode: "RUN_CLEANUP_COMPLETE", manifestHash: current.manifestHash,
        idempotencyKey: `control:cancelled:${current.stateVersion}`,
      }).run;
    } catch (error) {
      this.options.supervisor.transition({
        runId, expectedStateVersion: current.stateVersion, nextState: "FAILED",
        reasonCode: "CANCELLATION_CLEANUP_FAILED", manifestHash: current.manifestHash,
        idempotencyKey: `control:cancel-failed:${current.stateVersion}`,
      });
      throw error;
    }
  }

  subscribe(runId: string, afterSequence = 0): ReadableStream<Uint8Array> {
    this.assertOwner(runId, this.options.principal);
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new Error("invalid Engineer event cursor");
    const latestSequence = this.options.supervisor.latestEventSequence(runId);
    if (afterSequence > latestSequence) throw new Error("Engineer event cursor is ahead of the durable ledger");
    const encoder = new TextEncoder();
    let nextSequence = afterSequence + 1;
    let timer: ReturnType<typeof setInterval> | null = null;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let closed = false;
    let pendingEvents: ReturnType<EngineerSupervisor["listEvents"]> = [];
    const close = (controller: ReadableStreamDefaultController<Uint8Array>) => {
      if (closed) return;
      closed = true;
      if (timer) clearInterval(timer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      try { controller.close(); } catch { /* Client cancellation may close the controller first. */ }
    };
    const pump = (controller: ReadableStreamDefaultController<Uint8Array>) => {
      if (closed) return;
      if (controller.desiredSize !== null && controller.desiredSize <= 0) return;
      while (controller.desiredSize === null || controller.desiredSize > 0) {
        if (pendingEvents.length === 0) {
          pendingEvents = this.options.supervisor.listEvents(runId, nextSequence - 1, 250);
          if (pendingEvents.length === 0) break;
        }
        const event = pendingEvents.shift()!;
        controller.enqueue(encoder.encode(`id: ${event.sequence}\nevent: state\ndata: ${JSON.stringify(event)}\n\n`));
        nextSequence = event.sequence + 1;
      }
      if (pendingEvents.length > 0) return;
      const state = this.options.supervisor.getRun(runId).state;
      const ledgerIsDrained = nextSequence > this.options.supervisor.latestEventSequence(runId);
      if ([
        ...(!this.options.publication ? ["REVIEW_APPROVED"] : []),
        "COMPLETED", "REJECTED", "CANCELLED", "TIMED_OUT", "RETRY_BUDGET_EXHAUSTED",
        "BLOCKED_BY_ENVIRONMENT", "BLOCKED_BY_EXTERNAL_DEPENDENCY", "SECURITY_ESCALATION",
        "VERIFICATION_INCOMPLETE", "ROLLED_BACK", "FAILED",
      ].includes(state) && ledgerIsDrained) {
        close(controller);
      }
    };
    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        controller.enqueue(encoder.encode("retry: 1000\n\n"));
        pump(controller);
        if (!closed) {
          // Durable events are low-frequency relative to model/command work;
          // a one-second cadence keeps the UI live without four synchronous
          // SQLite polls per subscriber every second.
          timer = setInterval(() => pump(controller), 1_000);
          timer.unref?.();
          heartbeatTimer = setInterval(() => {
            if (!closed && (controller.desiredSize === null || controller.desiredSize > 0)) {
              controller.enqueue(encoder.encode(`: heartbeat ${Date.now()}\n\n`));
            }
          }, 15_000);
          heartbeatTimer.unref?.();
        }
      },
      pull: (controller) => pump(controller),
      cancel: () => {
        closed = true;
        if (timer) clearInterval(timer);
        if (heartbeatTimer) clearInterval(heartbeatTimer);
      },
    });
  }
}
