import { randomUUID } from "node:crypto";
import {
  EvidenceBundleSchema,
  RepairContextSchema,
  ReviewerInputSchema,
  TrustedEvidenceSchema,
  reviewerEvidenceBundleHash,
  type ModelRole,
  type ReviewerOutput,
  type TaskManifest,
  type TrustedEvidence,
} from "./contracts.js";
import { FailureRecordSchema } from "./control-contracts.js";
import type { LocalArtifactStore } from "./artifact-store.js";
import { CODEX_BUILDER_PROMPT_VERSION, CodexBuilder, type ResponsesTransport } from "./codex-builder.js";
import type { AgentExecutionRecord, ArtifactRecord, SandboxRecord } from "./execution-contracts.js";
import type { EngineerExecutionManager } from "./execution-manager.js";
import type { DockerSandboxManager, ProvisionedSandbox } from "./sandbox-manager.js";
import { sha256 } from "./hash.js";
import { IndependentVerifier, IndependentVerificationFailure, StableRequiredTestFailure } from "./independent-verifier.js";
import { IsolatedReviewer, REVIEWER_POLICY_VERSION } from "./isolated-reviewer.js";
import { LUNA_FAILURE_ADVISOR_POLICY_VERSION, LunaFailureAdvisor } from "./luna-failure-advisor.js";
import { resolveEngineerModel, type EngineerModelConfiguration } from "./model-routing.js";
import type { EngineerSupervisor } from "./supervisor.js";
import { TERRA_ADVISOR_POLICY_VERSION, TerraAdvisors } from "./terra-advisors.js";
import { TrustedCommandExecutor } from "./trusted-executor.js";
import { canTransition, isTerminalState } from "./state-machine.js";
import { derivePostVerificationRiskFeatures } from "./post-verification-risk.js";
import { RuntimeBudgetExhaustedError } from "./runtime-budget.js";
import { TestIntegrityGuard, TestIntegrityViolationError, type TestIntegrityComparison } from "./test-integrity.js";
import {
  ClaimEvidenceRecordSchema,
  EvidenceBundleRecordSchema,
  SecurityFindingRecordSchema,
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
  sandboxManager: DockerSandboxManager;
  artifactStore: LocalArtifactStore;
  transportForRole: (runId: string, role: "BUILDER" | "TESTER" | "SECURITY" | "REVIEWER") =>
    ResponsesTransport | Promise<ResponsesTransport>;
  transportForFailureClassifier?: (runId: string) => ResponsesTransport | Promise<ResponsesTransport>;
  modelConfiguration?: EngineerModelConfiguration;
  now?: () => Date;
  idFactory?: () => string;
  safetyIdentifierForUser?: (userId: string) => string;
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

  constructor(options: EngineerVerificationManagerOptions) {
    this.options = options;
  }

  verify(runId: string): Promise<VerificationResult> {
    const existing = this.active.get(runId);
    if (existing) return existing;
    const promise = this.verifyPass(runId)
      .catch((error) => {
        this.failClosed(runId, error);
        throw error;
      })
      .finally(() => this.active.delete(runId));
    this.active.set(runId, promise);
    return promise;
  }

  recoverReady(): Array<{ runId: string; promise: Promise<VerificationResult> }> {
    const states = [
      "FAST_CHECKS", "UNIT_TESTING", "INTEGRATION_TESTING", "E2E_TESTING", "FLAKE_QUARANTINE",
      "SECURITY_REVIEW", "CODE_REVIEW", "EVIDENCE_SYNTHESIS", "REVIEWING",
      "REVIEW_CHANGES_REQUESTED", "REVIEW_FIX_PREPARING", "VERIFICATION_RECOVERY", "IMPLEMENTING",
    ] as const;
    return this.options.supervisor.listRuns([...states])
      .filter((run) => run.state !== "IMPLEMENTING" || this.isInterruptedPhase3Repair(run.runId))
      .map((run) => ({
        runId: run.runId,
        promise: run.state === "FAST_CHECKS" ? this.verify(run.runId) : this.recoverInterruptedVerification(run.runId),
      }));
  }

  private async verifyPass(runId: string): Promise<VerificationResult> {
    const supervisor = this.options.supervisor;
    const initial = supervisor.getRun(runId);
    if (initial.state !== "FAST_CHECKS" || !initial.manifestHash) {
      throw new Error(`Phase 3 verification requires FAST_CHECKS, not ${initial.state}`);
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
    const preVerificationIntegrity = testIntegrity.attest("PRE_VERIFICATION");
      const resultCommitSha = await workspaceManager.checkpointAsync(sandbox.workspace, `zintus engineer ${runId} verification checkpoint`);
      const diff = await workspaceManager.diffAsync(sandbox.workspace);
      supervisor.recordArtifact(this.options.artifactStore.put({
        runId, type: "FINAL_DIFF", bytes: diff, producerType: "SYSTEM", producerId: "engineer-verification", trusted: true,
      }));
    const pass = supervisor.nextReviewerAttempt(runId);
    const executor = this.executor(manifest, sandbox);
    let verified;
    try {
      verified = new IndependentVerifier({
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
      verified = await verified;
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

    const advisorAgents = new Map<"TESTER" | "SECURITY", AgentContext>();
    const advisors = new TerraAdvisors({
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
    try {
      testAdvisory = await advisors.testCoverage(manifest, diff, verified.trustedEvidence);
      this.storeAgentOutput(runId, testerAgent, "TEST_ADVISORY", testAdvisory);
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
    // Model advisories remain auditable artifacts/findings, but never cross the
    // trust boundary into Reviewer evidence or acceptance-claim certification.
    const trustedEvidence = verified.trustedEvidence;
    const preReviewIntegrity = testIntegrity.attest("PRE_REVIEW");
    trustedEvidence.push(this.testIntegrityEvidence(preReviewIntegrity.artifact, preReviewIntegrity.comparison));
    const finalRiskFeatures = derivePostVerificationRiskFeatures({
      diff,
      requiredChecksPassed: verified.executions.every((execution) => execution.status === "PASSED"),
      retryCount: supervisor.retryAttemptCount(runId),
      unresolvedWarnings: securityAdvisory.findings.length,
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
    this.transition(runId, "IMPLEMENTING", "STABLE_REQUIRED_TEST_REPAIR_STARTED", evidenceIds, {
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
    const builder = new CodexBuilder({
      transport,
      manifest,
      workspace: sandbox.workspace,
      workspaceManager: this.options.sandboxManager.workspaceManager(),
      executor,
      modelConfiguration: this.options.modelConfiguration,
      repairContext,
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
    try {
      const initial = this.options.supervisor.getRun(runId);
      const sandbox = await this.options.executionManager.recoverSandbox(runId, true);
      if (initial.state !== "VERIFICATION_RECOVERY") {
        this.transition(runId, "VERIFICATION_RECOVERY", "PHASE3_PROCESS_INTERRUPTED", [sandbox.record.sandboxId]);
      }
      this.transition(runId, "FAST_CHECKS", "PHASE3_RECOVERY_RESTARTED", [sandbox.record.sandboxId]);
      return this.verify(runId);
    } catch (error) {
      this.failClosed(runId, error);
      throw error;
    }
  }

  private isInterruptedPhase3Repair(runId: string): boolean {
    const sequence = this.options.supervisor.latestEventSequence(runId);
    if (sequence === 0) return false;
    const latest = this.options.supervisor.listEvents(runId, sequence - 1, 1)[0];
    return latest?.nextState === "IMPLEMENTING"
      && ["REVIEW_REPAIR_STARTED", "STABLE_REQUIRED_TEST_REPAIR_STARTED"].includes(latest.reasonCode);
  }

  private startAgent(runId: string, role: ModelRole, inputHash: string): AgentContext {
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
    this.options.supervisor.recordAgentExecution({
      agentExecutionId: agent.id, runId, role: agent.role, modelTier: agent.route.logicalTier,
      status: "FAILED", inputHash: agent.inputHash, outputArtifactId: null,
      startedAt: agent.startedAt, completedAt: this.timestamp(),
    });
  }

  private authorizeTransientModelRetry(runId: string, role: ModelRole, error: unknown, attempt: number): boolean {
    const message = error instanceof Error ? error.message : String(error);
    const current = this.options.supervisor.getRun(runId);
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
    const run = this.options.supervisor.getRun(runId);
    this.options.supervisor.transition({
      runId, expectedStateVersion: run.stateVersion, nextState, reasonCode, evidenceIds,
      manifestHash: run.manifestHash, idempotencyKey: `phase3:${nextState.toLowerCase()}:${run.stateVersion + 1}`,
      ...(facts ? { facts } : {}),
    });
  }

  private failClosed(runId: string, error: unknown): void {
    const run = this.options.supervisor.getRun(runId);
    if (isTerminalState(run.state) || run.state === "REVIEW_APPROVED") return;
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
    const preferred = ["FAST_CHECKS", "UNIT_TESTING", "INTEGRATION_TESTING", "E2E_TESTING", "VERIFICATION_RECOVERY", "REVERIFYING"].includes(run.state)
      ? "VERIFICATION_INCOMPLETE"
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
