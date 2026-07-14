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
  engineerObservabilitySnapshot,
  sha256,
} from "@zintus/engineer";
import type { EngineerPrincipal } from "./engineer-identity.js";
import type { EngineerCapabilityPreflight, EngineerReadiness } from "./engineer-preflight.js";
import { redactSecrets } from "@zintus/router";

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
  private readonly errors = new Map<string, string>();
  private readonly background = new Set<Promise<void>>();
  private draining = false;

  constructor(options: EngineerRunManagerOptions) {
    if (!options.preflight || !options.principal) throw new Error("Engineer principal and capability preflight are mandatory");
    this.options = options;
  }

  principal(): EngineerPrincipal { return { ...this.options.principal }; }
  readiness(): EngineerReadiness { return this.options.preflight.readiness(); }
  ensureReady(): Promise<void> { return this.options.preflight.assertStartup(); }

  async create(principal: EngineerPrincipal, input: {
    runId?: string;
    repository: RepositoryReference;
    request: string;
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

  get(runId: string): { run: EngineerRun; lastError: string | null } {
    this.assertOwner(runId, this.options.principal);
    return { run: this.options.supervisor.getRun(runId), lastError: this.errors.get(runId) ?? null };
  }

  list(principal: EngineerPrincipal): EngineerRun[] {
    this.assertPrincipal(principal);
    return this.options.supervisor.listRuns().filter((run) => run.userId === principal.ownerId).reverse();
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
    this.options.context.build(runId);
    const plan = await this.options.planning.plan(runId);
    this.errors.delete(runId);
    return plan;
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
    this.errors.delete(runId);
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
      this.errors.set(runId, redactSecrets(error instanceof Error ? error.message : String(error)));
    });
    this.background.add(job);
    void job.finally(() => this.background.delete(job));
    return run;
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
    return this.options.supervisor.listArtifacts(runId);
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

  tests(runId: string) { this.assertOwner(runId, this.options.principal); return this.options.supervisor.listTestExecutions(runId); }

  security(runId: string) { this.assertOwner(runId, this.options.principal); return this.options.supervisor.listSecurityFindings(runId); }

  failures(runId: string) { this.assertOwner(runId, this.options.principal); return this.options.supervisor.listFailures(runId); }

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
          this.errors.delete(runId);
        } catch (error) {
          planningError = redactSecrets(error instanceof Error ? error.message : String(error));
          this.errors.set(runId, planningError);
        }
      }
    }
    return { resolution, plan, planningError };
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
    await this.options.preflight.assertRunAdmission(this.options.supervisor.getRun(runId).repository);
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
    const artifact = this.options.supervisor.recordArtifact(artifactStore.put({
      runId, type: "CANCELLATION_REQUEST",
      bytes: JSON.stringify({ actorId, reason, requestedAt: new Date().toISOString() }),
      producerType: "SYSTEM", producerId: "engineer-supervisor", trusted: true,
    }));
    let current = this.options.supervisor.transition({
      runId, expectedStateVersion: run.stateVersion, nextState: "CANCELLATION_PENDING",
      reasonCode: "USER_CANCELLATION_REQUESTED", actorType: "HUMAN", actorId,
      evidenceIds: [artifact.artifactId], manifestHash: run.manifestHash,
      idempotencyKey: `control:cancel:${run.stateVersion}`,
    }).run;
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
        "HUMAN_REVIEW_REQUIRED", "VERIFICATION_INCOMPLETE", "ROLLED_BACK", "FAILED",
      ].includes(state) && ledgerIsDrained) {
        if (timer) clearInterval(timer);
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        closed = true;
        controller.close();
      }
    };
    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        controller.enqueue(encoder.encode("retry: 1000\n\n"));
        pump(controller);
        if (!closed) {
          timer = setInterval(() => pump(controller), 250);
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
      cancel: () => { if (timer) clearInterval(timer); if (heartbeatTimer) clearInterval(heartbeatTimer); },
    });
  }
}
