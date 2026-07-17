import { randomUUID } from "node:crypto";
import {
  EvidenceBundleSchema,
  RepairContextSchema,
  ReviewerInputSchema,
  ReviewerOutputSchema,
  TrustedEvidenceSchema,
  reviewerEvidenceBundleHash,
  type ModelRole,
  type ReviewerOutput,
  type RunStateEvent,
  type TaskManifest,
  type TrustedEvidence,
} from "./contracts.js";
import { FailureRecordSchema } from "./control-contracts.js";
import type { LocalArtifactStore } from "./artifact-store.js";
import { BuilderContinuationSchema, BuilderNoProgressError, CODEX_BUILDER_PROMPT_VERSION, CodexBuilder, isProviderModelTimeout, type ResponsesTransport } from "./codex-builder.js";
import { ArtifactRecordSchema, type AgentExecutionRecord, type ArtifactRecord, type SandboxRecord } from "./execution-contracts.js";
import type { EngineerExecutionManager } from "./execution-manager.js";
import type { ISandbox, ProvisionedSandbox } from "./sandbox-manager.js";
import { sha256 } from "./hash.js";
import { IndependentVerifier, IndependentVerificationFailure, StableRequiredTestFailure, type IndependentVerificationOutput } from "./independent-verifier.js";
import {
  IsolatedReviewer,
  REVIEWER_POLICY_VERSION,
  reviewerFindingFingerprint,
  reviewerFindingRecords,
} from "./isolated-reviewer.js";
import { LUNA_FAILURE_ADVISOR_POLICY_VERSION, LunaFailureAdvisor } from "./luna-failure-advisor.js";
import { resolveEngineerModel, type EngineerModelConfiguration } from "./model-routing.js";
import type { EngineerSupervisor } from "./supervisor.js";
import { TERRA_ADVISOR_POLICY_VERSION, TerraAdvisors } from "./terra-advisors.js";
import { TrustedCommandExecutor } from "./trusted-executor.js";
import { canTransition, isTerminalState } from "./state-machine.js";
import { derivePostVerificationRiskFeatures } from "./post-verification-risk.js";
import { RuntimeBudgetExhaustedError } from "./runtime-budget.js";
import { BudgetPausedError, BuilderModelCallLimitError } from "./errors.js";
import { WorkerLeaseConflictError, type EngineerWorkerLeaseManager, type WorkerLeaseGrant } from "./worker-lease.js";
import { TestIntegrityGuard, TestIntegrityViolationError, type TestIntegrityComparison } from "./test-integrity.js";
import {
  buildAdversarialCoverageReport,
  type AdversarialCoverageReport,
} from "./adversarial-coverage.js";
import {
  ClaimEvidenceRecordSchema,
  EvidenceBundleRecordSchema,
  ReviewerSessionRecordSchema,
  SecurityFindingRecordSchema,
  VerificationExecutionRecordSchema,
  trustedEvidenceSupportsCriterion,
  VerificationResultSchema,
  type ClaimEvidenceRecord,
  type VerificationResult,
} from "./verification-contracts.js";

export function reviewerClaimEvidenceId(input: {
  runId: string;
  attempt: number;
  kind: "CRITERION" | "UNSUPPORTED";
  key: string;
}): string {
  return sha256({ namespace: "reviewer-claim-evidence-v1", ...input });
}

export interface EngineerVerificationManagerOptions {
  supervisor: EngineerSupervisor;
  executionManager: EngineerExecutionManager;
  sandboxManager: ISandbox;
  artifactStore: LocalArtifactStore;
  transportForRole: (runId: string, role: "BUILDER" | "TESTER" | "SECURITY" | "REVIEWER") =>
    ResponsesTransport | Promise<ResponsesTransport>;
  transportForFailureClassifier?: (runId: string) => ResponsesTransport | Promise<ResponsesTransport>;
  modelConfiguration?: EngineerModelConfiguration;
  now?: () => Date;
  idFactory?: () => string;
  safetyIdentifierForUser?: (userId: string) => string;
  leaseManager?: EngineerWorkerLeaseManager;
  workerOwnerId?: string;
  leaseTtlMs?: number;
  heartbeatIntervalMs?: number;
}

interface AgentContext {
  id: string;
  role: ModelRole;
  startedAt: string;
  inputHash: string;
  route: ReturnType<typeof resolveEngineerModel>;
}

/** Phase-3 authority: independent tools verify, Terra advises, isolated Sol challenges. */
export class EngineerVerificationManager {
  private readonly options: EngineerVerificationManagerOptions;
  private readonly active = new Map<string, Promise<VerificationResult>>();
  private readonly abortControllers = new Map<string, AbortController>();
  private readonly activeLeases = new Map<string, WorkerLeaseGrant>();

  constructor(options: EngineerVerificationManagerOptions) {
    this.options = options;
  }

  isActive(runId: string): boolean { return this.active.has(runId); }

  ownsBudgetCheckpoint(runId: string): boolean {
    const latestWorkTransition = this.latestRepairCheckpoint(runId);
    return latestWorkTransition?.nextState === "IMPLEMENTING"
      && ["REVIEW_REPAIR_STARTED", "STABLE_REQUIRED_TEST_REPAIR_STARTED"].includes(latestWorkTransition.reasonCode);
  }

  verify(runId: string): Promise<VerificationResult> {
    return this.runActive(runId, () => this.verifyPass(runId));
  }

  resumeBudgetCheckpoint(runId: string): Promise<VerificationResult> {
    return this.runActive(runId, () => this.recoverInterruptedVerification(runId));
  }

  private runActive(runId: string, operation: () => Promise<VerificationResult>): Promise<VerificationResult> {
    const existing = this.active.get(runId);
    if (existing) return existing;
    const controller = new AbortController();
    this.abortControllers.set(runId, controller);
    const promise = this.withWorkerLease(runId, controller, operation)
      .catch((error) => {
        if (!(error instanceof BudgetPausedError) && !(error instanceof WorkerLeaseConflictError) && !controller.signal.aborted) {
          this.failClosed(runId, error);
        }
        throw error;
      })
      .finally(() => {
        this.active.delete(runId);
        this.abortControllers.delete(runId);
        this.activeLeases.delete(runId);
      });
    this.active.set(runId, promise);
    return promise;
  }

  cancel(runId: string): void {
    this.abortControllers.get(runId)?.abort(new Error("Engineer verification was cancelled"));
  }

  resumeRecovered(runId: string): void {
    const existing = this.active.get(runId);
    if (existing) {
      this.cancel(runId);
      void existing.finally(() => {
        const run = this.options.supervisor.getRun(runId);
        if (!run.terminalAt && run.state !== "CANCELLATION_PENDING") {
          void this.resumeBudgetCheckpoint(runId).catch(() => undefined);
        }
      });
      return;
    }
    const run = this.options.supervisor.getRun(runId);
    if (!run.terminalAt && run.state !== "CANCELLATION_PENDING") {
      void this.resumeBudgetCheckpoint(runId).catch(() => undefined);
    }
  }

  private async withWorkerLease(
    runId: string,
    controller: AbortController,
    operation: () => Promise<VerificationResult>,
  ): Promise<VerificationResult> {
    const leaseManager = this.options.leaseManager;
    if (!leaseManager) return operation();
    const ownerId = this.options.workerOwnerId ?? "engineer-verification-worker";
    let grant = leaseManager.acquire({
      resourceKey: `run:${runId}`,
      ownerId,
      ttlMs: this.options.leaseTtlMs ?? 30_000,
      idempotencyKey: `verify:${runId}:${this.options.supervisor.getRun(runId).stateVersion}`,
    });
    this.activeLeases.set(runId, grant);
    let heartbeatSequence = 0;
    const timer = setInterval(() => {
      heartbeatSequence += 1;
      try {
        const lease = leaseManager.heartbeat({
          leaseId: grant.lease.leaseId,
          ownerId,
          fencingToken: grant.lease.fencingToken,
          leaseToken: grant.leaseToken,
          idempotencyKey: `verify-heartbeat:${heartbeatSequence}`,
        });
        grant = { ...grant, lease };
        this.activeLeases.set(runId, grant);
      } catch (error) {
        clearInterval(timer);
        controller.abort(error);
      }
    }, this.options.heartbeatIntervalMs ?? 10_000);
    timer.unref?.();
    try {
      return await operation();
    } finally {
      clearInterval(timer);
      try {
        leaseManager.release({
          leaseId: grant.lease.leaseId,
          ownerId,
          fencingToken: grant.lease.fencingToken,
          leaseToken: grant.leaseToken,
          idempotencyKey: `verify-release:${grant.lease.renewalCount}`,
        });
      } catch { /* an expired/fenced lease is already released from authority */ }
    }
  }

  recoverReady(): Array<{ runId: string; promise: Promise<VerificationResult> }> {
    const states = [
      "FAST_CHECKS", "UNIT_TESTING", "INTEGRATION_TESTING", "E2E_TESTING", "FLAKE_QUARANTINE",
      "SECURITY_REVIEW", "CODE_REVIEW", "EVIDENCE_SYNTHESIS", "REVIEWING",
      "REVIEW_CHANGES_REQUESTED", "REVIEW_FIX_PREPARING", "VERIFICATION_RECOVERY", "IMPLEMENTING",
      "HUMAN_REVIEW_REQUIRED",
    ] as const;
    const recoveries: Array<{ runId: string; promise: Promise<VerificationResult> }> = [];
    for (const run of this.options.supervisor.listRuns([...states])) {
      const runningModelAgent = (this.options.supervisor.exportRunRecords(run.runId)?.agent_executions ?? [])
        .some((agent) => agent.status === "RUNNING" && typeof agent.role === "string" &&
          ["TESTER", "SECURITY", "REVIEWER"].includes(agent.role));
      if (runningModelAgent && canTransition(run.state, "MODEL_PROVIDER_RETRY_PENDING")) {
        const now = this.timestamp();
        this.options.supervisor.finalizeRunningAgentExecutions(run.runId, "FAILED", "VERIFICATION_PROCESS_INTERRUPTED", now);
        this.options.supervisor.recordFailure(FailureRecordSchema.parse({
          failureId: this.id(), runId: run.runId, failureClass: "MODEL_FAILURE",
          reasonCode: "VERIFICATION_PROVIDER_OUTCOME_AMBIGUOUS",
          fingerprint: sha256({ runId: run.runId, stateVersion: run.stateVersion, reason: "VERIFICATION_PROVIDER_OUTCOME_AMBIGUOUS" }),
          evidenceIds: [], retryable: true, createdAt: now,
        }));
        this.transition(run.runId, "MODEL_PROVIDER_RETRY_PENDING", "VERIFICATION_PROVIDER_OUTCOME_AMBIGUOUS");
        continue;
      }
      if (run.state === "HUMAN_REVIEW_REQUIRED"
        ? this.options.supervisor.reviewerPersistenceRecoveryCandidate(run.runId) === null
        : run.state === "IMPLEMENTING" && !this.isInterruptedPhase3Repair(run.runId)) continue;
      recoveries.push({
        runId: run.runId,
        promise: run.state === "FAST_CHECKS"
          ? this.verify(run.runId)
          : run.state === "HUMAN_REVIEW_REQUIRED"
            ? this.runActive(run.runId, () => this.recoverReviewerPersistence(run.runId))
            : this.resumeBudgetCheckpoint(run.runId),
      });
    }
    return recoveries;
  }

  private async recoverReviewerPersistence(runId: string): Promise<VerificationResult> {
    const supervisor = this.options.supervisor;
    const candidate = supervisor.reviewerPersistenceRecoveryCandidate(runId);
    if (!candidate) throw new Error("run has no recoverable isolated Reviewer persistence failure");
    const artifact = supervisor.listArtifacts(runId).find((item) => item.artifactId === candidate.outputArtifactId);
    if (!artifact || artifact.type !== "REVIEWER_OUTPUT" || artifact.producerId !== candidate.agentExecutionId || artifact.trusted) {
      throw new Error("recoverable Reviewer output artifact is missing or has invalid provenance");
    }
    const output = ReviewerOutputSchema.parse(JSON.parse(this.options.artifactStore.read(artifact).toString("utf8")));
    const run = supervisor.getRun(runId);
    const manifest = supervisor.getManifest(runId);
    if (!manifest || !run.manifestHash || output.reviewPolicyVersion !== REVIEWER_POLICY_VERSION) {
      throw new Error("recoverable Reviewer output is not bound to the current frozen contract");
    }
    const reviewerSessionId = sha256({
      namespace: "recovered-reviewer-session-v1",
      runId,
      outputArtifactId: artifact.artifactId,
      inputHash: candidate.inputHash,
    });
    const session = ReviewerSessionRecordSchema.parse({
      reviewerSessionId,
      runId,
      attempt: supervisor.nextReviewerAttempt(runId),
      modelTier: candidate.modelTier,
      resolvedModel: candidate.resolvedModel,
      inputHash: candidate.inputHash,
      manifestHash: run.manifestHash,
      diffHash: output.reviewedDiffHash,
      evidenceBundleHash: output.reviewedEvidenceBundleHash,
      policyVersion: REVIEWER_POLICY_VERSION,
      cacheKey: candidate.cacheKey,
      cacheHit: candidate.cacheHit,
      startedAt: candidate.startedAt,
      completedAt: candidate.completedAt,
      decision: output.decision,
      isolationVerified: true,
      output,
    });
    const findings = reviewerFindingRecords(reviewerSessionId, output);
    if (findings.length === 0 || output.decision !== "REQUEST_CHANGES") {
      throw new Error("only a structured REQUEST_CHANGES result can use automatic Reviewer persistence recovery");
    }

    const sandbox = await this.options.executionManager.recoverSandbox(runId, true);
    const workspaceManager = this.options.sandboxManager.workspaceManager();
    const [currentCommitSha, currentDiff] = await Promise.all([
      workspaceManager.currentCommitAsync(sandbox.workspace),
      workspaceManager.diffAsync(sandbox.workspace),
    ]);
    if (sha256(currentDiff) !== output.reviewedDiffHash) {
      throw new Error("workspace changed after the isolated review; persistence recovery is stale");
    }

    supervisor.recoverReviewerSession(session, findings, artifact.artifactId);
    supervisor.setLastError(runId, null);
    this.transition(runId, "REVIEW_CHANGES_REQUESTED", "REVIEWER_PERSISTENCE_RECOVERED", [artifact.artifactId], {
      reviewerFindingsActionable: true,
    });
    const retry = supervisor.authorizeRetry({
      runId,
      expectedStateVersion: supervisor.getRun(runId).stateVersion,
      kind: "REVIEWER_FIX",
      failureFingerprint: sha256(findings.map((finding) => finding.fingerprint).sort()),
      patchHash: sha256(currentDiff),
      progressMetric: -findings.length,
    });
    if (!retry.allowed) {
      this.transition(runId, "RETRY_BUDGET_EXHAUSTED", retry.reasonCode, [artifact.artifactId]);
      throw new Error(`Reviewer persistence recovered, but repair was not authorized: ${retry.reasonCode}`);
    }
    this.transition(runId, "REVIEW_FIX_PREPARING", "REVIEW_REPAIR_CONTEXT_PREPARING", [artifact.artifactId], {
      retryBudgetAvailable: true,
      scopeWithinManifest: true,
    });
    const repairContext = RepairContextSchema.parse({
      runId,
      manifestHash: manifest.manifestHash,
      manifest,
      reviewFindings: output.findings,
      reviewFindingsHash: sha256(output.findings),
      currentCommitSha,
      allowedPaths: manifest.allowedPaths,
      remainingReviewFixAttempts: retry.remainingKindAttempts,
    });
    this.transition(runId, "IMPLEMENTING", "REVIEW_REPAIR_STARTED", [artifact.artifactId], { scopeWithinManifest: true });
    await this.repair(manifest, sandbox, repairContext, "REVIEW_REPAIR_IMPLEMENTED");
    return this.verifyPass(runId);
  }

  private async verifyPass(runId: string): Promise<VerificationResult> {
    const supervisor = this.options.supervisor;
    const initial = supervisor.getRun(runId);
    if (!["FAST_CHECKS", "SECURITY_REVIEW"].includes(initial.state) || !initial.manifestHash) {
      throw new Error(`Phase 3 verification requires FAST_CHECKS or a durable SECURITY_REVIEW checkpoint, not ${initial.state}`);
    }
    const manifest = supervisor.getManifest(runId);
    if (!manifest) throw new Error("frozen manifest is unavailable");
    const safetyIdentifier = this.options.safetyIdentifierForUser?.(initial.userId);
    const sandbox = this.options.executionManager.getSandbox(runId)
      ?? await this.options.executionManager.recoverSandbox(runId, false);
    const workspaceManager = this.options.sandboxManager.workspaceManager();
    const testIntegrity = TestIntegrityGuard.load({
      supervisor,
      artifactStore: this.options.artifactStore,
      manifest,
      workspace: sandbox.workspace,
      now: this.options.now,
    });
    const resultCommitSha = await workspaceManager.checkpointAsync(sandbox.workspace, `zintus engineer ${runId} verification checkpoint`);
    const diff = await workspaceManager.diffAsync(sandbox.workspace);
    supervisor.recordArtifact(this.options.artifactStore.put({
        runId, type: "FINAL_DIFF", bytes: diff, producerType: "SYSTEM", producerId: "engineer-verification", trusted: true,
    }));
    const pass = supervisor.nextReviewerAttempt(runId);
    let verified = this.loadIndependentVerificationCheckpoint(runId, manifest.manifestHash, sha256(diff), resultCommitSha);
    if (!verified) {
      if (initial.state !== "FAST_CHECKS") throw new Error("durable independent-verification checkpoint is unavailable");
      const preVerificationIntegrity = testIntegrity.attest("PRE_VERIFICATION");
      const executor = this.executor(manifest, sandbox);
      try {
      const verification = new IndependentVerifier({
        supervisor,
        artifactStore: this.options.artifactStore,
        manifest,
        executor,
        diff: () => diff,
        // Every return to FAST_CHECKS has a new durable state version, including
        // Builder repair loops that occur before any Reviewer session exists.
        verificationPass: initial.stateVersion,
        beforeCommand: () => testIntegrity.captureCommandSnapshot(),
        afterCommand: (command, beforeSnapshot) => testIntegrity.assertCommandDidNotMutate(beforeSnapshot, command),
        now: this.options.now,
        idFactory: this.options.idFactory,
      }).run();
      verified = await verification;
      verified.trustedEvidence.unshift(this.testIntegrityEvidence(preVerificationIntegrity.artifact, preVerificationIntegrity.comparison));
      const postVerificationIntegrity = testIntegrity.attest("POST_INDEPENDENT_VERIFICATION");
      verified.trustedEvidence.push(this.testIntegrityEvidence(postVerificationIntegrity.artifact, postVerificationIntegrity.comparison));
      } catch (error) {
        if (error instanceof StableRequiredTestFailure) {
          return this.repairStableRequiredTest(manifest, sandbox, resultCommitSha, diff, error);
        }
        if (error instanceof IndependentVerificationFailure) {
          await this.recordLunaFailureAdvisory(manifest, error).catch(() => undefined);
        }
        throw error;
      }
      this.storeIndependentVerificationCheckpoint(runId, manifest.manifestHash, sha256(diff), resultCommitSha, verified);
    }
    if (!verified) throw new Error("independent verification checkpoint resolution failed");

    const advisorAgents = new Map<"TESTER" | "SECURITY", AgentContext>();
    const advisors = new TerraAdvisors({
      signal: this.abortControllers.get(runId)?.signal,
      transportForRole: (role) => this.options.transportForRole(runId, role),
      modelConfiguration: this.options.modelConfiguration,
      safetyIdentifier,
      reserveModelCall: ({ role, model, inputTokenUpperBound, maxOutputTokens, attempt }) => {
        const agent = advisorAgents.get(role);
        if (!agent) throw new Error(`missing ${role} execution context for budget reservation`);
        return supervisor.reserveModelBudget({
          runId, reservationId: sha256({ runId, agentExecutionId: agent.id, role, pass, attempt, purpose: "advisor-model-call" }),
          agentExecutionId: agent.id,
          model, inputTokenUpperBound, maxOutputTokens,
        });
      },
      authorizeModelRetry: ({ role, error, attempt, failedAttempt, inputHash, cacheKey, reservationId, latencyMs }) => {
        const agent = advisorAgents.get(role);
        if (!agent) throw new Error(`missing ${role} execution context for failed call evidence`);
        supervisor.recordModelCall({
          modelCallId: this.id(), runId, agentExecutionId: agent.id,
          logicalTier: agent.route.logicalTier, resolvedModel: agent.route.model,
          promptTemplateVersion: TERRA_ADVISOR_POLICY_VERSION, inputContextRefs: [manifest.manifestHash, inputHash],
          outputSchemaVersion: "phase3-advisory-v1", cacheKey, cacheHit: null, latencyMs,
          inputTokens: null, outputTokens: null, retryCount: failedAttempt, status: "FAILED", createdAt: this.timestamp(),
        }, reservationId);
        return this.authorizeTransientModelRetry(runId, role, error, attempt);
      },
      onModelCall: (observation) => {
        const agent = advisorAgents.get(observation.role);
        if (!agent) throw new Error(`missing ${observation.role} execution context`);
        supervisor.recordModelCall({
          modelCallId: this.id(), runId, agentExecutionId: agent.id,
          logicalTier: agent.route.logicalTier, resolvedModel: agent.route.model,
          promptTemplateVersion: TERRA_ADVISOR_POLICY_VERSION,
          inputContextRefs: [manifest.manifestHash, observation.inputHash], outputSchemaVersion: "phase3-advisory-v1",
          cacheKey: observation.cacheKey, cacheHit: observation.cachedInputTokens > 0, latencyMs: observation.latencyMs,
          inputTokens: observation.inputTokens, outputTokens: observation.outputTokens,
          cachedInputTokens: observation.cachedInputTokens, cacheWriteInputTokens: observation.cacheWriteInputTokens,
          retryCount: observation.retryCount, status: "SUCCEEDED", createdAt: this.timestamp(),
        }, observation.reservationId);
      },
    });
    const testerAgent = this.startAgent(runId, "TESTER", sha256({ manifest: manifest.manifestHash, diff: sha256(diff), evidence: verified.trustedEvidence }));
    advisorAgents.set("TESTER", testerAgent);
    let testAdvisory;
    let adversarialCoverage: AdversarialCoverageReport;
    try {
      testAdvisory = await advisors.testCoverage(manifest, diff, verified.trustedEvidence);
      this.assertLeaseAuthority(runId);
      this.storeAgentOutput(runId, testerAgent, "TEST_ADVISORY", testAdvisory);
      adversarialCoverage = buildAdversarialCoverageReport(manifest, testAdvisory);
      const coverageArtifact = supervisor.recordArtifact(this.options.artifactStore.put({
        runId,
        type: "ADVERSARIAL_COVERAGE_REPORT",
        bytes: JSON.stringify(adversarialCoverage),
        producerType: "SYSTEM",
        producerId: "adversarial-coverage-policy",
        trusted: true,
      }));
      verified.trustedEvidence.push(TrustedEvidenceSchema.parse({
        evidenceId: coverageArtifact.artifactId,
        runId,
        eventType: "ADVERSARIAL_COVERAGE_REPORT",
        producerType: "SYSTEM",
        producerId: "adversarial-coverage-policy",
        sha256: coverageArtifact.sha256,
        payload: adversarialCoverage,
        createdAt: coverageArtifact.createdAt,
      }));
    } catch (error) {
      this.failAgent(runId, testerAgent);
      throw error;
    }

    const securityAgent = this.startAgent(runId, "SECURITY", sha256({ manifest: manifest.manifestHash, diff: sha256(diff) }));
    advisorAgents.set("SECURITY", securityAgent);
    let securityAdvisory;
    let securityArtifact;
    try {
      securityAdvisory = await advisors.security(manifest, diff);
      this.assertLeaseAuthority(runId);
      securityArtifact = this.storeAgentOutput(runId, securityAgent, "SECURITY_ADVISORY", securityAdvisory);
    } catch (error) {
      this.failAgent(runId, securityAgent);
      throw error;
    }
    const advisoryFindingRecords = securityAdvisory.findings.map((finding) =>
      supervisor.recordSecurityFinding(SecurityFindingRecordSchema.parse({
        securityFindingId: this.id(), runId, severity: finding.severity,
        category: `AI_ADVISORY_${finding.category}`.slice(0, 200), description: finding.description,
        file: finding.file || null, lineStart: finding.lineStart || null, lineEnd: finding.lineEnd || null,
        evidenceIds: [securityArtifact.artifactId], status: "OPEN", createdAt: this.timestamp(),
      })),
    );
    // Model security advice remains non-certifying. The adversarial coverage
    // report above is trusted only as a system-validated risk-floor record; it
    // can block approval but can never substantiate an acceptance criterion.
    const trustedEvidence = verified.trustedEvidence;
    const preReviewIntegrity = testIntegrity.attest("PRE_REVIEW");
    trustedEvidence.push(this.testIntegrityEvidence(preReviewIntegrity.artifact, preReviewIntegrity.comparison));
    const finalRiskFeatures = derivePostVerificationRiskFeatures({
      diff,
      requiredChecksPassed: verified.executions.every((execution) => execution.status === "PASSED"),
      retryCount: supervisor.retryAttemptCount(runId),
      unresolvedWarnings: securityAdvisory.findings.length
        + adversarialCoverage.blockingGapIds.length
        + adversarialCoverage.warnings.length,
      securityFindings: [
        ...verified.securityFindings,
        ...advisoryFindingRecords,
      ],
    });
    supervisor.assertRuntimeBudget(runId, { diffLines: finalRiskFeatures.diffLines });
    const finalRiskAssessment = supervisor.assessRunRisk(runId, supervisor.getRun(runId).stateVersion, finalRiskFeatures, { autoApproveLowRisk: true });
    this.transition(runId, "REVIEWING", "INDEPENDENT_VERIFICATION_COMPLETE", trustedEvidence.map((item) => item.evidenceId));

    const evidenceBundleHash = reviewerEvidenceBundleHash({
      manifestHash: manifest.manifestHash,
      diffHash: sha256(diff),
      resultCommitSha,
      trustedEvidence,
      riskAssessment: finalRiskAssessment,
    });
    const reviewSessionId = this.id();
    const reviewerInput = ReviewerInputSchema.parse({
      reviewSessionId, runId, reviewAttempt: pass, manifest, manifestHash: manifest.manifestHash,
      finalDiff: diff, diffHash: sha256(diff), trustedEvidence, evidenceBundleHash, resultCommitSha,
      riskAssessment: finalRiskAssessment,
      reviewPolicyVersion: REVIEWER_POLICY_VERSION, createdAt: this.timestamp(),
    });
    const reviewerAgent = this.startAgent(runId, "REVIEWER", sha256(reviewerInput));
    let reviewerTransport;
    try {
      reviewerTransport = await this.options.transportForRole(runId, "REVIEWER");
    } catch (error) {
      this.failAgent(runId, reviewerAgent);
      throw error;
    }
    const reviewer = new IsolatedReviewer({
      signal: this.abortControllers.get(runId)?.signal,
      transport: reviewerTransport,
      modelConfiguration: this.options.modelConfiguration,
      now: this.options.now,
      safetyIdentifier,
      reserveModelCall: ({ model, inputTokenUpperBound, maxOutputTokens, attempt }) => supervisor.reserveModelBudget({
        runId, reservationId: sha256({ runId, reviewSessionId, pass, attempt, purpose: "reviewer-model-call" }),
        agentExecutionId: reviewerAgent.id,
        model, inputTokenUpperBound, maxOutputTokens,
      }),
      authorizeModelRetry: ({ error, attempt, failedAttempt, inputHash, cacheKey, reservationId, latencyMs }) => {
        supervisor.recordModelCall({
          modelCallId: this.id(), runId, agentExecutionId: reviewerAgent.id,
          logicalTier: reviewerAgent.route.logicalTier, resolvedModel: reviewerAgent.route.model,
          promptTemplateVersion: REVIEWER_POLICY_VERSION, inputContextRefs: [manifest.manifestHash, inputHash],
          outputSchemaVersion: "reviewer-output-v1", cacheKey, cacheHit: null, latencyMs,
          inputTokens: null, outputTokens: null, retryCount: failedAttempt, status: "FAILED", createdAt: this.timestamp(),
        }, reservationId);
        return this.authorizeTransientModelRetry(runId, "REVIEWER", error, attempt);
      },
      onModelCall: (observation) => {
        supervisor.recordModelCall({
          modelCallId: this.id(), runId, agentExecutionId: reviewerAgent.id,
          logicalTier: reviewerAgent.route.logicalTier, resolvedModel: reviewerAgent.route.model,
          promptTemplateVersion: REVIEWER_POLICY_VERSION,
          inputContextRefs: [manifest.manifestHash, observation.dynamicInputHash], outputSchemaVersion: "reviewer-output-v1",
          cacheKey: observation.cacheKey, cacheHit: observation.cachedInputTokens > 0, latencyMs: observation.latencyMs,
          inputTokens: observation.inputTokens, outputTokens: observation.outputTokens,
          cachedInputTokens: observation.cachedInputTokens, cacheWriteInputTokens: observation.cacheWriteInputTokens,
          retryCount: observation.retryCount, status: "SUCCEEDED", createdAt: this.timestamp(),
        }, observation.reservationId);
      },
    });
    let review;
    let reviewArtifact;
    try {
      review = await reviewer.review(reviewerInput, pass);
      this.assertLeaseAuthority(runId);
      const [reviewedCommitSha, reviewedDiff] = await Promise.all([
        workspaceManager.currentCommitAsync(sandbox.workspace),
        workspaceManager.diffAsync(sandbox.workspace),
      ]);
      if (reviewedCommitSha !== resultCommitSha || sha256(reviewedDiff) !== reviewerInput.diffHash) {
        throw new Error("workspace changed during isolated review; Reviewer decision is stale");
      }
      reviewArtifact = this.storeAgentOutput(runId, reviewerAgent, "REVIEWER_OUTPUT", review.session.output);
    } catch (error) {
      this.failAgent(runId, reviewerAgent);
      throw error;
    }
    this.assertLeaseAuthority(runId);
    supervisor.recordReviewerSession(review.session, review.findings);
    const claims = this.mapClaims(manifest, review.session.output, trustedEvidence, pass);
    for (const claim of claims) supervisor.recordClaimEvidence(claim);
    const evidenceBundle = this.bundle(
      manifest, sandbox.record, resultCommitSha, claims, review.session.decision,
      supervisor.listArtifacts(runId),
    );
    supervisor.recordEvidenceBundle(evidenceBundle);

    const result = VerificationResultSchema.parse({
      runId,
      verificationExecutions: verified.executions,
      securityFindings: [
        ...verified.securityFindings,
        ...advisoryFindingRecords,
      ],
      reviewerSession: review.session,
      claims,
      evidenceBundle,
    });
    if (review.session.decision === "APPROVE") {
      this.transition(runId, "REVIEW_APPROVED", "ISOLATED_REVIEW_APPROVED", [reviewArtifact.artifactId, evidenceBundle.evidenceBundleId], {
        reviewerDecisionValid: true, freshReviewerSession: true,
      });
      return result;
    }
    if (review.session.decision === "REJECT") {
      this.transition(runId, "REVIEW_REJECTED", "ISOLATED_REVIEW_REJECTED", [reviewArtifact.artifactId]);
      this.transition(runId, "REJECTED", "REVIEW_REJECTION_FINAL", [evidenceBundle.evidenceBundleId]);
      return result;
    }
    if (review.session.decision === "HUMAN_REVIEW_REQUIRED") {
      this.transition(runId, "HUMAN_REVIEW_REQUIRED", "REVIEWER_REQUIRES_HUMAN", [reviewArtifact.artifactId, evidenceBundle.evidenceBundleId]);
      return result;
    }
    if (review.findings.length === 0) throw new Error("REQUEST_CHANGES requires at least one structured finding");
    this.transition(runId, "REVIEW_CHANGES_REQUESTED", "ISOLATED_REVIEW_REQUESTED_CHANGES", [reviewArtifact.artifactId], {
      reviewerFindingsActionable: true,
    });
    const retry = supervisor.authorizeRetry({
      runId,
      expectedStateVersion: supervisor.getRun(runId).stateVersion,
      kind: "REVIEWER_FIX",
      failureFingerprint: sha256(review.findings.map((finding) => finding.fingerprint).sort()),
      patchHash: sha256(diff),
      progressMetric: -review.findings.length,
    });
    if (!retry.allowed) {
      this.transition(runId, "RETRY_BUDGET_EXHAUSTED", retry.reasonCode, [reviewArtifact.artifactId]);
      return result;
    }
    this.transition(runId, "REVIEW_FIX_PREPARING", "REVIEW_REPAIR_CONTEXT_PREPARING", [reviewArtifact.artifactId], {
      retryBudgetAvailable: true, scopeWithinManifest: true,
    });
    const repairContext = RepairContextSchema.parse({
      runId, manifestHash: manifest.manifestHash, manifest,
      reviewFindings: review.session.output.findings,
      reviewFindingsHash: sha256(review.session.output.findings),
      currentCommitSha: resultCommitSha,
      allowedPaths: manifest.allowedPaths,
      remainingReviewFixAttempts: retry.remainingKindAttempts,
    });
    this.transition(runId, "IMPLEMENTING", "REVIEW_REPAIR_STARTED", [reviewArtifact.artifactId], { scopeWithinManifest: true });
    await this.repair(manifest, sandbox, repairContext, "REVIEW_REPAIR_IMPLEMENTED");
    return this.verifyPass(runId);
  }

  private async repairStableRequiredTest(
    manifest: TaskManifest,
    sandbox: ProvisionedSandbox,
    currentCommitSha: string,
    diff: string,
    failure: StableRequiredTestFailure,
  ): Promise<VerificationResult> {
    const runId = manifest.runId;
    const supervisor = this.options.supervisor;
    const evidenceIds = failure.evidence.map((item) => item.evidenceId);
    const retry = supervisor.authorizeRetry({
      runId,
      expectedStateVersion: supervisor.getRun(runId).stateVersion,
      kind: "BUILDER_REPAIR",
      failureFingerprint: failure.failureFingerprint,
      patchHash: sha256(diff),
    });
    supervisor.recordFailure(FailureRecordSchema.parse({
      failureId: this.id(),
      runId,
      failureClass: "TEST_FAILURE",
      reasonCode: "STABLE_REQUIRED_TEST_FAILED",
      fingerprint: failure.failureFingerprint,
      evidenceIds,
      retryable: retry.allowed,
      createdAt: this.timestamp(),
    }));
    if (!retry.allowed) {
      this.transition(runId, "RETRY_BUDGET_EXHAUSTED", retry.reasonCode, evidenceIds);
      throw new Error(`Builder repair denied for ${failure.test.testId}: ${retry.reasonCode}`);
    }
    const reviewFindings = [{
      findingId: `verification-${failure.test.testId}-${retry.attemptNumber}`,
      severity: "HIGH" as const,
      category: "REQUIRED_TEST_FAILURE",
      file: "",
      lineStart: 0,
      lineEnd: 0,
      criterionIds: failure.requiredCriterionIds,
      description: `Frozen required test ${failure.test.testId} failed independently in three comparable executions.`,
      requiredChange: `Repair the implementation within frozen scope so ${failure.test.command ?? failure.test.testId} passes. Do not weaken, remove, or skip the test.`,
      evidenceIds,
    }];
    const repairContext = RepairContextSchema.parse({
      runId,
      manifestHash: manifest.manifestHash,
      manifest,
      reviewFindings,
      reviewFindingsHash: sha256(reviewFindings),
      currentCommitSha,
      allowedPaths: manifest.allowedPaths,
      remainingReviewFixAttempts: retry.remainingKindAttempts,
    });
    const repairContextArtifact = supervisor.recordArtifact(this.options.artifactStore.put({
      runId,
      type: "STABLE_REQUIRED_TEST_REPAIR_CONTEXT",
      bytes: JSON.stringify(repairContext),
      producerType: "SYSTEM",
      producerId: "engineer-verification",
      trusted: true,
    }));
    this.transition(runId, "IMPLEMENTING", "STABLE_REQUIRED_TEST_REPAIR_STARTED", [...evidenceIds, repairContextArtifact.artifactId], {
      retryBudgetAvailable: true,
      scopeWithinManifest: true,
    });
    await this.repair(manifest, sandbox, repairContext, "STABLE_REQUIRED_TEST_REPAIR_IMPLEMENTED");
    return this.verifyPass(runId);
  }

  private async repair(
    manifest: TaskManifest,
    sandbox: ProvisionedSandbox,
    repairContext: ReturnType<typeof RepairContextSchema.parse>,
    completionReason: "REVIEW_REPAIR_IMPLEMENTED" | "STABLE_REQUIRED_TEST_REPAIR_IMPLEMENTED",
  ): Promise<void> {
    const runId = manifest.runId;
    const executor = this.executor(manifest, sandbox);
    const testIntegrity = TestIntegrityGuard.load({
      supervisor: this.options.supervisor,
      artifactStore: this.options.artifactStore,
      manifest,
      workspace: sandbox.workspace,
      now: this.options.now,
    });
    const agent = this.startAgent(runId, "BUILDER", sha256(repairContext));
    let transport;
    try {
      transport = await this.options.transportForRole(runId, "BUILDER");
    } catch (error) {
      this.failAgent(runId, agent);
      throw error;
    }
    const continuation = this.options.supervisor.listArtifacts(runId)
      .filter((artifact) => artifact.type === "BUILDER_REPAIR_CONTINUATION" && artifact.trusted &&
        artifact.producerType === "SYSTEM" && artifact.producerId === "engineer-builder-checkpoint")
      .reverse()
      .flatMap((artifact) => {
        try {
          const parsed = BuilderContinuationSchema.parse(
            JSON.parse(this.options.artifactStore.read(artifact).toString("utf8")),
          );
          return parsed.manifestHash === manifest.manifestHash &&
            parsed.inputContextHash === sha256(repairContext) ? [parsed] : [];
        } catch { return []; }
      })[0];
    const builder = new CodexBuilder({
      transport,
      manifest,
      workspace: sandbox.workspace,
      workspaceManager: this.options.sandboxManager.workspaceManager(),
      executor,
      modelConfiguration: this.options.modelConfiguration,
      repairContext,
      ...(continuation ? { continuation } : {}),
      onContinuation: (checkpoint) => {
        this.options.supervisor.recordArtifact(this.options.artifactStore.put({
          runId,
          type: "BUILDER_REPAIR_CONTINUATION",
          bytes: JSON.stringify(checkpoint),
          producerType: "SYSTEM",
          producerId: "engineer-builder-checkpoint",
          trusted: true,
        }));
      },
      now: this.options.now,
      safetyIdentifier: this.options.safetyIdentifierForUser?.(this.options.supervisor.getRun(runId).userId),
      reserveModelCall: ({ model, inputTokenUpperBound, maxOutputTokens, round, attempt }) => this.options.supervisor.reserveModelBudget({
        runId, reservationId: sha256({ runId, agentExecutionId: agent.id, round, attempt, purpose: "repair-model-call" }),
        agentExecutionId: agent.id,
        model, inputTokenUpperBound, maxOutputTokens,
      }),
      authorizeModelRetry: ({ error, attempt, failedAttempt, inputHash, cacheKey, reservationId, latencyMs }) => {
        const message = error instanceof Error ? error.message : String(error);
        const current = this.options.supervisor.getRun(runId);
        this.options.supervisor.recordModelCall({
          modelCallId: this.id(), runId, agentExecutionId: agent.id,
          logicalTier: agent.route.logicalTier, resolvedModel: agent.route.model,
          promptTemplateVersion: CODEX_BUILDER_PROMPT_VERSION,
          inputContextRefs: [manifest.manifestHash, inputHash], outputSchemaVersion: null,
          cacheKey, cacheHit: null, latencyMs, inputTokens: null, outputTokens: null,
          retryCount: failedAttempt, status: "FAILED", createdAt: this.timestamp(),
        }, reservationId);
        const retry = this.options.supervisor.authorizeRetry({
          runId, expectedStateVersion: current.stateVersion, kind: "TRANSIENT_MODEL",
          failureFingerprint: sha256({ role: "BUILDER", message }), patchHash: null, progressMetric: attempt,
        });
        if (!retry.allowed && canTransition(current.state, "RETRY_BUDGET_EXHAUSTED")) {
          this.transition(runId, "RETRY_BUDGET_EXHAUSTED", retry.reasonCode);
        }
        return retry.allowed;
      },
      onModelCall: (observation) => {
        this.options.supervisor.recordModelCall({
          modelCallId: this.id(), runId, agentExecutionId: agent.id,
          logicalTier: agent.route.logicalTier, resolvedModel: agent.route.model,
          promptTemplateVersion: CODEX_BUILDER_PROMPT_VERSION,
          inputContextRefs: [manifest.manifestHash, repairContext.reviewFindingsHash, observation.inputHash],
          outputSchemaVersion: null, cacheKey: observation.cacheKey, cacheHit: observation.cachedInputTokens > 0,
          latencyMs: observation.latencyMs, inputTokens: observation.inputTokens, outputTokens: observation.outputTokens,
          cachedInputTokens: observation.cachedInputTokens, cacheWriteInputTokens: observation.cacheWriteInputTokens,
          retryCount: observation.retryCount, status: "SUCCEEDED", createdAt: this.timestamp(),
        }, observation.reservationId);
      },
    });
    try {
      const builderResult = await builder.run();
      const artifact = this.storeAgentOutput(runId, agent, "BUILDER_REPAIR_RESULT", builderResult);
      const integrity = testIntegrity.attest("POST_REPAIR");
      this.transition(runId, "FAST_CHECKS", completionReason, [artifact.artifactId, integrity.artifact.artifactId]);
    } catch (error) {
      this.failAgent(runId, agent);
      throw error;
    }
  }

  private executor(manifest: TaskManifest, sandbox: ProvisionedSandbox): TrustedCommandExecutor {
    return new TrustedCommandExecutor({
      artifactStore: this.options.artifactStore,
      workspace: sandbox.workspace,
      sandbox: sandbox.record,
      manifest,
      runner: sandbox.commandRunner,
      ...(sandbox.commandRunnerAsync ? { runnerAsync: sandbox.commandRunnerAsync } : {}),
      currentCommit: () => this.options.sandboxManager.currentCommit(sandbox.workspace),
      currentCommitAsync: () => this.options.sandboxManager.currentCommitAsync(sandbox.workspace),
      onRecord: (record) => { this.options.supervisor.recordCommandExecution(record); },
      now: this.options.now,
      idFactory: this.options.idFactory,
      signal: this.abortControllers.get(manifest.runId)?.signal,
    });
  }

  private async recordLunaFailureAdvisory(
    manifest: TaskManifest,
    failure: IndependentVerificationFailure,
  ): Promise<void> {
    const transportFactory = this.options.transportForFailureClassifier;
    if (!transportFactory) return;
    const runId = manifest.runId;
    const input = {
      runId,
      manifestHash: manifest.manifestHash,
      failureClass: failure.failureClass,
      reasonCode: failure.reasonCode,
      evidenceIds: failure.evidenceIds,
      details: failure.details,
    };
    const agent = this.startAgent(runId, "FAILURE_CLASSIFIER", sha256(input));
    try {
      const transport = await transportFactory(runId);
      const advisor = new LunaFailureAdvisor({
        transport,
        modelConfiguration: this.options.modelConfiguration,
        safetyIdentifier: this.options.safetyIdentifierForUser?.(this.options.supervisor.getRun(runId).userId),
        reserveModelCall: ({ model, inputTokenUpperBound, maxOutputTokens }) => this.options.supervisor.reserveModelBudget({
          runId,
          reservationId: sha256({ runId, agentExecutionId: agent.id, reasonCode: failure.reasonCode, purpose: "luna-failure-advisory" }),
          agentExecutionId: agent.id,
          model,
          inputTokenUpperBound,
          maxOutputTokens,
        }),
        onModelCall: (observation) => this.options.supervisor.recordModelCall({
          modelCallId: this.id(), runId, agentExecutionId: agent.id,
          logicalTier: agent.route.logicalTier, resolvedModel: agent.route.model,
          promptTemplateVersion: LUNA_FAILURE_ADVISOR_POLICY_VERSION,
          inputContextRefs: [manifest.manifestHash, observation.inputHash], outputSchemaVersion: "luna-failure-advisory-v1",
          cacheKey: observation.cacheKey, cacheHit: observation.cachedInputTokens > 0, latencyMs: observation.latencyMs,
          inputTokens: observation.inputTokens, outputTokens: observation.outputTokens,
          cachedInputTokens: observation.cachedInputTokens, cacheWriteInputTokens: observation.cacheWriteInputTokens,
          retryCount: 0, status: "SUCCEEDED", createdAt: this.timestamp(),
        }, observation.reservationId),
      });
      const advisory = await advisor.advise(input);
      this.storeAgentOutput(runId, agent, "LUNA_FAILURE_ADVISORY", advisory);
    } catch (error) {
      this.failAgent(runId, agent);
      throw error;
    }
  }

  private async recoverInterruptedVerification(runId: string): Promise<VerificationResult> {
    const initial = this.options.supervisor.getRun(runId);
    this.options.supervisor.finalizeRunningAgentExecutions(
      runId,
      "FAILED",
      "VERIFICATION_PROCESS_INTERRUPTED",
      this.timestamp(),
    );
    const sandbox = await this.options.executionManager.recoverSandbox(runId, true);
    const repairCheckpoint = this.latestRepairCheckpoint(runId);
    if (repairCheckpoint?.reasonCode === "REVIEW_REPAIR_STARTED" ||
        repairCheckpoint?.reasonCode === "REVIEW_REPAIR_CONTEXT_PREPARING") {
      return this.recoverInterruptedReviewRepair(runId, sandbox, repairCheckpoint);
    }
    if (repairCheckpoint?.reasonCode === "STABLE_REQUIRED_TEST_REPAIR_STARTED") {
      return this.recoverInterruptedStableRequiredTestRepair(runId, sandbox, repairCheckpoint);
    }
    if (this.hasIndependentVerificationCheckpoint(runId)) {
      if (initial.state !== "VERIFICATION_RECOVERY") {
        this.transition(runId, "VERIFICATION_RECOVERY", "PHASE3_PROCESS_INTERRUPTED", [sandbox.record.sandboxId]);
      }
      this.transition(runId, "SECURITY_REVIEW", "INDEPENDENT_VERIFICATION_CHECKPOINT_RESUMED", [sandbox.record.sandboxId]);
      return this.verifyPass(runId);
    }
    if (initial.state !== "VERIFICATION_RECOVERY") {
      this.transition(runId, "VERIFICATION_RECOVERY", "PHASE3_PROCESS_INTERRUPTED", [sandbox.record.sandboxId]);
    }
    this.transition(runId, "FAST_CHECKS", "PHASE3_RECOVERY_RESTARTED", [sandbox.record.sandboxId]);
    return this.verifyPass(runId);
  }

  private latestRepairCheckpoint(runId: string): RunStateEvent | undefined {
    const sequence = this.options.supervisor.latestEventSequence(runId);
    if (sequence === 0) return undefined;
    const events = this.options.supervisor.listEvents(runId, Math.max(0, sequence - 100), 100).reverse();
    return events.find((event) =>
      event.nextState !== "PAUSED_BUDGET" && event.reasonCode !== "BUDGET_RESUMED",
    );
  }

  private async recoverInterruptedReviewRepair(
    runId: string,
    sandbox: ProvisionedSandbox,
    checkpoint: RunStateEvent,
  ): Promise<VerificationResult> {
    const supervisor = this.options.supervisor;
    const manifest = supervisor.getManifest(runId);
    if (!manifest) throw new Error("frozen manifest is unavailable for Reviewer repair recovery");
    const artifacts = supervisor.listArtifacts(runId);
    const artifact = checkpoint.evidenceIds
      .map((artifactId) => artifacts.find((item) => item.artifactId === artifactId))
      .find((item) => item?.type === "REVIEWER_OUTPUT");
    if (!artifact || artifact.trusted) {
      throw new Error("Reviewer repair recovery requires its recorded isolated output artifact");
    }
    const recorded = supervisor.recordedReviewerOutput(runId, artifact.artifactId);
    const output = ReviewerOutputSchema.parse(JSON.parse(this.options.artifactStore.read(artifact).toString("utf8")));
    if (!recorded || recorded.decision !== "REQUEST_CHANGES" || output.decision !== "REQUEST_CHANGES" ||
        recorded.diffHash !== output.reviewedDiffHash ||
        recorded.evidenceBundleHash !== output.reviewedEvidenceBundleHash ||
        output.reviewPolicyVersion !== REVIEWER_POLICY_VERSION || output.findings.length === 0) {
      throw new Error("Reviewer repair recovery evidence is stale or invalid");
    }
    const reviewFindings = [...output.findings];
    const findingFingerprints = new Set(reviewFindings.map(reviewerFindingFingerprint));
    for (const laterArtifact of artifacts) {
      if (laterArtifact.type !== "REVIEWER_OUTPUT" || laterArtifact.artifactId === artifact.artifactId) continue;
      const laterRecord = supervisor.recordedReviewerOutput(runId, laterArtifact.artifactId);
      if (!laterRecord || laterRecord.attempt <= recorded.attempt || laterRecord.decision !== "REQUEST_CHANGES" ||
          laterRecord.diffHash !== recorded.diffHash) continue;
      const laterOutput = ReviewerOutputSchema.parse(JSON.parse(this.options.artifactStore.read(laterArtifact).toString("utf8")));
      if (laterOutput.decision !== "REQUEST_CHANGES" || laterOutput.reviewedDiffHash !== laterRecord.diffHash ||
          laterOutput.reviewedEvidenceBundleHash !== laterRecord.evidenceBundleHash ||
          laterOutput.reviewPolicyVersion !== REVIEWER_POLICY_VERSION) continue;
      for (const finding of laterOutput.findings) {
        const fingerprint = reviewerFindingFingerprint(finding);
        if (findingFingerprints.has(fingerprint)) continue;
        findingFingerprints.add(fingerprint);
        reviewFindings.push(finding);
      }
    }
    const currentCommitSha = await this.options.sandboxManager.workspaceManager().currentCommitAsync(sandbox.workspace);
    const repairContext = RepairContextSchema.parse({
      runId,
      manifestHash: manifest.manifestHash,
      manifest,
      reviewFindings,
      reviewFindingsHash: sha256(reviewFindings),
      currentCommitSha,
      allowedPaths: manifest.allowedPaths,
      remainingReviewFixAttempts: 0,
    });
    const current = supervisor.getRun(runId);
    if (current.state === "REVIEW_FIX_PREPARING") {
      this.transition(runId, "IMPLEMENTING", "REVIEW_REPAIR_RESUMED", [artifact.artifactId], { scopeWithinManifest: true });
    } else if (current.state !== "IMPLEMENTING") {
      throw new Error(`Reviewer repair recovery requires IMPLEMENTING, not ${current.state}`);
    }
    await this.repair(manifest, sandbox, repairContext, "REVIEW_REPAIR_IMPLEMENTED");
    return this.verifyPass(runId);
  }

  private async recoverInterruptedStableRequiredTestRepair(
    runId: string,
    sandbox: ProvisionedSandbox,
    checkpoint: RunStateEvent,
  ): Promise<VerificationResult> {
    const supervisor = this.options.supervisor;
    const manifest = supervisor.getManifest(runId);
    if (!manifest) throw new Error("frozen manifest is unavailable for stable required-test repair recovery");
    const artifacts = supervisor.listArtifacts(runId);
    const artifact = checkpoint.evidenceIds
      .map((artifactId) => artifacts.find((item) => item.artifactId === artifactId))
      .find((item) => item?.type === "STABLE_REQUIRED_TEST_REPAIR_CONTEXT");
    if (!artifact || !artifact.trusted || artifact.producerType !== "SYSTEM" || artifact.producerId !== "engineer-verification") {
      throw new Error("stable required-test repair recovery requires its trusted repair context artifact");
    }
    const repairContext = RepairContextSchema.parse(
      JSON.parse(this.options.artifactStore.read(artifact).toString("utf8")),
    );
    if (repairContext.runId !== runId || repairContext.manifestHash !== manifest.manifestHash ||
        repairContext.manifest.manifestHash !== manifest.manifestHash) {
      throw new Error("stable required-test repair recovery context is stale or belongs to another run");
    }
    const current = supervisor.getRun(runId);
    if (current.state !== "IMPLEMENTING") {
      throw new Error(`stable required-test repair recovery requires IMPLEMENTING, not ${current.state}`);
    }
    await this.repair(manifest, sandbox, repairContext, "STABLE_REQUIRED_TEST_REPAIR_IMPLEMENTED");
    return this.verifyPass(runId);
  }

  private isInterruptedPhase3Repair(runId: string): boolean {
    const latest = this.latestRepairCheckpoint(runId);
    return latest?.nextState === "IMPLEMENTING"
      && ["REVIEW_REPAIR_STARTED", "STABLE_REQUIRED_TEST_REPAIR_STARTED"].includes(latest.reasonCode);
  }

  private hasIndependentVerificationCheckpoint(runId: string): boolean {
    return this.options.supervisor.listArtifacts(runId).some((artifact) =>
      artifact.type === "INDEPENDENT_VERIFICATION_CHECKPOINT" && artifact.trusted &&
      artifact.producerType === "SYSTEM" && artifact.producerId === "engineer-verification");
  }

  private storeIndependentVerificationCheckpoint(
    runId: string,
    manifestHash: string,
    diffHash: string,
    resultCommitSha: string,
    verified: IndependentVerificationOutput,
  ): void {
    this.assertLeaseAuthority(runId);
    this.options.supervisor.recordArtifact(this.options.artifactStore.put({
      runId,
      type: "INDEPENDENT_VERIFICATION_CHECKPOINT",
      bytes: JSON.stringify({ version: 1, runId, manifestHash, diffHash, resultCommitSha, verified }),
      producerType: "SYSTEM",
      producerId: "engineer-verification",
      trusted: true,
    }));
  }

  private loadIndependentVerificationCheckpoint(
    runId: string,
    manifestHash: string,
    diffHash: string,
    resultCommitSha: string,
  ): IndependentVerificationOutput | null {
    const artifacts = this.options.supervisor.listArtifacts(runId)
      .filter((artifact) => artifact.type === "INDEPENDENT_VERIFICATION_CHECKPOINT" && artifact.trusted &&
        artifact.producerType === "SYSTEM" && artifact.producerId === "engineer-verification")
      .reverse();
    for (const artifact of artifacts) {
      try {
        const value = JSON.parse(this.options.artifactStore.read(artifact).toString("utf8")) as Record<string, unknown>;
        if (value.version !== 1 || value.runId !== runId || value.manifestHash !== manifestHash ||
            value.diffHash !== diffHash || value.resultCommitSha !== resultCommitSha || !value.verified ||
            typeof value.verified !== "object" || Array.isArray(value.verified)) continue;
        const verified = value.verified as Record<string, unknown>;
        return {
          executions: VerificationExecutionRecordSchema.array().parse(verified.executions),
          securityFindings: SecurityFindingRecordSchema.array().parse(verified.securityFindings),
          trustedEvidence: TrustedEvidenceSchema.array().parse(verified.trustedEvidence),
          securityReportArtifact: ArtifactRecordSchema.parse(verified.securityReportArtifact),
        };
      } catch { /* ignore malformed or stale checkpoints */ }
    }
    return null;
  }

  private startAgent(runId: string, role: ModelRole, inputHash: string): AgentContext {
    this.assertLeaseAuthority(runId);
    const route = resolveEngineerModel(role, this.options.modelConfiguration);
    const context = { id: this.id(), role, startedAt: this.timestamp(), inputHash, route };
    this.options.supervisor.recordAgentExecution({
      agentExecutionId: context.id, runId, role, modelTier: route.logicalTier,
      status: "RUNNING", inputHash, outputArtifactId: null, startedAt: context.startedAt, completedAt: null,
    });
    this.options.supervisor.recordModelRouting({
      routingDecisionId: this.id(), runId, agentExecutionId: context.id, agentRole: role, logicalTier: route.logicalTier,
      resolvedModel: route.model, routingPolicyVersion: route.policyVersion,
      fallbackUsed: false, fallbackReason: null, cacheKey: null, timestamp: context.startedAt,
    });
    return context;
  }

  private storeAgentOutput(runId: string, agent: AgentContext, type: string, output: unknown): ArtifactRecord {
    this.assertLeaseAuthority(runId);
    const artifact = this.options.supervisor.recordArtifact(this.options.artifactStore.put({
      runId, type, bytes: JSON.stringify(output), producerType: "SYSTEM", producerId: agent.id, trusted: false,
    }));
    const record: AgentExecutionRecord = {
      agentExecutionId: agent.id, runId, role: agent.role, modelTier: agent.route.logicalTier,
      status: "SUCCEEDED", inputHash: agent.inputHash, outputArtifactId: artifact.artifactId,
      startedAt: agent.startedAt, completedAt: this.timestamp(),
    };
    this.options.supervisor.recordAgentExecution(record);
    return artifact;
  }

  private testIntegrityEvidence(artifact: ArtifactRecord, comparison: TestIntegrityComparison): TrustedEvidence {
    return TrustedEvidenceSchema.parse({
      evidenceId: artifact.artifactId,
      runId: comparison.runId,
      eventType: "TEST_INTEGRITY_ATTESTATION",
      producerType: "SYSTEM",
      producerId: artifact.producerId,
      sha256: artifact.sha256,
      payload: comparison,
      createdAt: artifact.createdAt,
    });
  }

  private failAgent(runId: string, agent: AgentContext): void {
    const paused = this.options.supervisor.getRun(runId).state === "PAUSED_BUDGET";
    this.options.supervisor.recordAgentExecution({
      agentExecutionId: agent.id, runId, role: agent.role, modelTier: agent.route.logicalTier,
      status: paused ? "PAUSED" : "FAILED", inputHash: agent.inputHash, outputArtifactId: null,
      startedAt: agent.startedAt, completedAt: this.timestamp(),
    });
  }

  private authorizeTransientModelRetry(runId: string, role: ModelRole, error: unknown, attempt: number): boolean {
    const message = error instanceof Error ? error.message : String(error);
    const current = this.options.supervisor.getRun(runId);
    if (isProviderModelTimeout(error) && canTransition(current.state, "MODEL_PROVIDER_RETRY_PENDING")) {
      this.options.supervisor.recordFailure(FailureRecordSchema.parse({
        failureId: this.id(), runId, failureClass: "MODEL_FAILURE",
        reasonCode: "VERIFICATION_PROVIDER_OUTCOME_AMBIGUOUS",
        fingerprint: sha256({ role, message, reasonCode: "VERIFICATION_PROVIDER_OUTCOME_AMBIGUOUS" }),
        evidenceIds: [], retryable: true, createdAt: this.timestamp(),
      }));
      this.transition(runId, "MODEL_PROVIDER_RETRY_PENDING", "VERIFICATION_PROVIDER_OUTCOME_AMBIGUOUS");
      return false;
    }
    const retry = this.options.supervisor.authorizeRetry({
      runId, expectedStateVersion: current.stateVersion, kind: "TRANSIENT_MODEL",
      failureFingerprint: sha256({ role, message }), patchHash: null, progressMetric: attempt,
    });
    if (!retry.allowed && canTransition(current.state, "RETRY_BUDGET_EXHAUSTED")) {
      this.transition(runId, "RETRY_BUDGET_EXHAUSTED", retry.reasonCode);
    }
    return retry.allowed;
  }

  private mapClaims(
    manifest: TaskManifest,
    review: ReviewerOutput,
    trustedEvidence: TrustedEvidence[],
    attempt: number,
  ): ClaimEvidenceRecord[] {
    const knownEvidence = new Set(trustedEvidence.map((item) => item.evidenceId));
    const now = this.timestamp();
    const claims = manifest.acceptanceCriteria.map((criterion) => {
      const coverage = review.requirementCoverage.find((item) => item.criterionId === criterion.criterionId);
      const evidenceIds = coverage?.evidenceIds.filter((id) => knownEvidence.has(id)) ?? [];
      const criterionEvidenceIds = evidenceIds.filter((id) => {
        const evidence = trustedEvidence.find((item) => item.evidenceId === id);
        return evidence ? trustedEvidenceSupportsCriterion(evidence, criterion.criterionId) : false;
      });
      const status = coverage?.status === "SATISFIED" && criterionEvidenceIds.length > 0
        ? "VERIFIED"
        : coverage?.status === "PARTIAL" && criterionEvidenceIds.length > 0
          ? "PARTIALLY_VERIFIED"
          : coverage?.status === "FAILED"
            ? "FAILED"
            : "UNVERIFIED";
      return ClaimEvidenceRecordSchema.parse({
        claimId: reviewerClaimEvidenceId({
          runId: manifest.runId, attempt, kind: "CRITERION", key: criterion.criterionId,
        }),
        runId: manifest.runId,
        criterionId: criterion.criterionId,
        claim: criterion.statement,
        status,
        evidenceIds: criterionEvidenceIds,
        notes: coverage?.explanation ?? "Reviewer supplied no coverage record.",
        createdAt: now,
      });
    });
    for (const [index, unsupported] of review.unsupportedClaims.entries()) {
      claims.push(ClaimEvidenceRecordSchema.parse({
        claimId: reviewerClaimEvidenceId({
          runId: manifest.runId, attempt, kind: "UNSUPPORTED", key: String(index + 1),
        }), runId: manifest.runId, criterionId: null,
        claim: unsupported, status: "UNVERIFIED", evidenceIds: [], notes: "Explicitly unsupported by the isolated Reviewer.", createdAt: now,
      }));
    }
    return claims;
  }

  private bundle(
    manifest: TaskManifest,
    sandbox: SandboxRecord,
    resultCommitSha: string,
    claims: ClaimEvidenceRecord[],
    finalDecision: string,
    artifacts: ArtifactRecord[],
  ) {
    const bundle = EvidenceBundleSchema.parse({
      bundleVersion: 1,
      runId: manifest.runId,
      manifestHash: manifest.manifestHash,
      baseCommitSha: manifest.repository.baseCommitSha,
      resultCommitSha,
      environmentDigest: sandbox.environmentDigest,
      artifacts: artifacts.filter((artifact) => artifact.trusted).map((artifact) => ({
        artifactId: artifact.artifactId, type: artifact.type, sha256: artifact.sha256,
        createdAt: artifact.createdAt, producer: artifact.producerId, sizeBytes: artifact.sizeBytes,
      })),
      claims: claims.map(({ runId: _runId, criterionId: _criterionId, createdAt: _createdAt, ...claim }) => claim),
      finalDecision,
      createdAt: this.timestamp(),
    });
    return EvidenceBundleRecordSchema.parse({ evidenceBundleId: this.id(), bundle, bundleHash: sha256(bundle) });
  }

  private transition(
    runId: string,
    nextState: Parameters<EngineerSupervisor["transition"]>[0]["nextState"],
    reasonCode: string,
    evidenceIds: string[] = [],
    facts?: Parameters<EngineerSupervisor["transition"]>[0]["facts"],
  ): void {
    this.assertLeaseAuthority(runId);
    const run = this.options.supervisor.getRun(runId);
    this.options.supervisor.transition({
      runId, expectedStateVersion: run.stateVersion, nextState, reasonCode, evidenceIds,
      manifestHash: run.manifestHash, idempotencyKey: `phase3:${nextState.toLowerCase()}:${run.stateVersion + 1}`,
      ...(facts ? { facts } : {}),
    });
  }

  private assertLeaseAuthority(runId: string): void {
    const lease = this.activeLeases.get(runId);
    if (lease && this.options.leaseManager) {
      this.options.leaseManager.assertActive({
        leaseId: lease.lease.leaseId,
        ownerId: this.options.workerOwnerId ?? "engineer-verification-worker",
        fencingToken: lease.lease.fencingToken,
        leaseToken: lease.leaseToken,
      });
    }
    const signal = this.abortControllers.get(runId)?.signal;
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("verification worker authority was revoked");
  }

  private failClosed(runId: string, error: unknown): void {
    const run = this.options.supervisor.getRun(runId);
    if (isTerminalState(run.state) || run.state === "REVIEW_APPROVED") return;
    if (error instanceof BuilderModelCallLimitError) {
      this.options.supervisor.recordFailure(FailureRecordSchema.parse({
        failureId: this.id(), runId, failureClass: "WORKFLOW_FAILURE",
        reasonCode: "BUILDER_MODEL_CALL_LIMIT_REACHED",
        fingerprint: sha256({ reasonCode: "BUILDER_MODEL_CALL_LIMIT_REACHED", limit: error.limit }),
        evidenceIds: [], retryable: false, createdAt: this.timestamp(),
      }));
      if (canTransition(run.state, "RETRY_BUDGET_EXHAUSTED")) {
        this.transition(runId, "RETRY_BUDGET_EXHAUSTED", "BUILDER_MODEL_CALL_LIMIT_REACHED");
      }
      return;
    }
    if (error instanceof RuntimeBudgetExhaustedError) {
      this.options.supervisor.recordFailure(FailureRecordSchema.parse({
        failureId: this.id(), runId, failureClass: "WORKFLOW_FAILURE",
        reasonCode: "RUNTIME_BUDGET_EXHAUSTED",
        fingerprint: sha256({ reasonCode: "RUNTIME_BUDGET_EXHAUSTED", reasons: error.decision.hardLimitReasons }),
        evidenceIds: [], retryable: false, createdAt: this.timestamp(),
      }));
      if (canTransition(run.state, "RETRY_BUDGET_EXHAUSTED")) {
        this.transition(runId, "RETRY_BUDGET_EXHAUSTED", "RUNTIME_BUDGET_EXHAUSTED");
      }
      return;
    }
    if (error instanceof TestIntegrityViolationError) {
      const nextState = canTransition(run.state, "SECURITY_ESCALATION") ? "SECURITY_ESCALATION" : "VERIFICATION_INCOMPLETE";
      this.options.supervisor.recordFailure(FailureRecordSchema.parse({
        failureId: this.id(),
        runId,
        failureClass: "SECURITY_FAILURE",
        reasonCode: error.reasonCode,
        fingerprint: sha256({ reasonCode: error.reasonCode, state: run.state, message: error.message }),
        evidenceIds: error.evidenceId ? [error.evidenceId] : [],
        retryable: false,
        createdAt: this.timestamp(),
      }));
      if (canTransition(run.state, nextState)) {
        this.transition(runId, nextState, error.reasonCode, error.evidenceId ? [error.evidenceId] : []);
      }
      return;
    }
    if (error instanceof BuilderNoProgressError) {
      const nextState = canTransition(run.state, "VERIFICATION_INCOMPLETE") ? "VERIFICATION_INCOMPLETE" : "FAILED";
      this.options.supervisor.recordFailure(FailureRecordSchema.parse({
        failureId: this.id(),
        runId,
        failureClass: "DEPENDENCY_FAILURE",
        reasonCode: "BUILDER_NO_PROGRESS",
        fingerprint: sha256({ reasonCode: "BUILDER_NO_PROGRESS", command: error.command, state: run.state }),
        evidenceIds: [...error.commandExecutionIds],
        retryable: false,
        createdAt: this.timestamp(),
      }));
      if (canTransition(run.state, nextState)) this.transition(runId, nextState, "BUILDER_NO_PROGRESS", [...error.commandExecutionIds]);
      return;
    }
    const preferred = ["FAST_CHECKS", "UNIT_TESTING", "INTEGRATION_TESTING", "E2E_TESTING", "VERIFICATION_RECOVERY", "REVERIFYING"].includes(run.state)
      ? "VERIFICATION_INCOMPLETE"
      : run.state === "FLAKE_QUARANTINE"
        ? "HUMAN_REVIEW_REQUIRED"
      : run.state === "SECURITY_REVIEW"
        ? "SECURITY_ESCALATION"
        : ["REVIEWING", "REVIEW_CHANGES_REQUESTED"].includes(run.state)
          ? "HUMAN_REVIEW_REQUIRED"
          : ["IMPLEMENTING", "EVIDENCE_SYNTHESIS"].includes(run.state)
            ? "FAILED"
            : "RETRY_BUDGET_EXHAUSTED";
    if (!canTransition(run.state, preferred)) return;
    const message = error instanceof Error ? error.message : String(error);
    this.options.supervisor.recordFailure(FailureRecordSchema.parse({
      failureId: this.id(),
      runId,
      failureClass: "WORKFLOW_FAILURE",
      reasonCode: "PHASE3_UNEXPECTED_FAILURE",
      fingerprint: sha256({ failureClass: "WORKFLOW_FAILURE", reasonCode: "PHASE3_UNEXPECTED_FAILURE", state: run.state, message }),
      evidenceIds: [],
      retryable: false,
      createdAt: this.timestamp(),
    }));
    this.transition(runId, preferred, "PHASE3_UNEXPECTED_FAILURE");
  }

  private id(): string { return (this.options.idFactory ?? randomUUID)(); }
  private timestamp(): string { return (this.options.now ?? (() => new Date()))().toISOString(); }
}
