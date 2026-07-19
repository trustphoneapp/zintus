import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { unlinkSync } from "node:fs";
import type { LocalArtifactStore } from "./artifact-store.js";
import {
  ApprovalDecisionRecordSchema,
  ApprovalAuthorityExpectationSchema,
  ApprovalRequestRecordSchema,
  FailureRecordSchema,
  GitOperationRecordSchema,
  hasUnreconciledRemotePublication,
  SignedSupervisorPrCommandSchema,
  type FailureRecord,
  type ApprovalDecisionRecord,
  type ApprovalAuthorityExpectation,
  type ApprovalRequestRecord,
  type NewApprovalRequestRecord,
  type GitOperationRecord,
  type PublicationEvidence,
} from "./control-contracts.js";
import { ApprovalAuthorityConflictError, HardeningGenericOperationForbiddenError, IdempotencyConflictError } from "./errors.js";
import { SupervisorPrCommandSchema, type EngineerRun } from "./contracts.js";
import type { GitService, PullRequestResult } from "./git-service.js";
import { sha256 } from "./hash.js";
import type { EngineerSupervisor } from "./supervisor.js";
import { operationalFailurePolicy } from "./failure-policy.js";
import { isCancellationAllowed } from "./state-machine.js";
import type { CheckpointAttestor, VerifiedCandidateCheckpoint } from "./verified-candidate-checkpoint.js";
import type { EvidenceBundleRecord } from "./verification-contracts.js";

class PublicationOperationInProgressError extends Error {
  constructor(runId: string) {
    super(`publication operation is already in progress for run ${runId}`);
    this.name = "PublicationOperationInProgressError";
  }
}

class PublicationOperationRecoveryRequiredError extends Error {
  constructor(runId: string, operationType: GitOperationRecord["operationType"]) {
    super(`publication operation ${operationType} for run ${runId} requires human recovery review`);
    this.name = "PublicationOperationRecoveryRequiredError";
  }
}

export interface EngineerPublicationManagerOptions {
  supervisor: EngineerSupervisor;
  gitService: GitService;
  artifactStore: LocalArtifactStore;
  diffForRun: (runId: string) => string;
  commandSigningSecret: string;
  checkpointAttestor: CheckpointAttestor;
  autoPublishLowRisk?: boolean;
  now?: () => Date;
  idFactory?: () => string;
  cleanupRun?: (runId: string) => void | Promise<void>;
  /** Time after which a durable STARTED claim must be reconciled instead of treated as live. */
  operationLeaseMs?: number;
}

export type PublicationStartResult =
  | { status: "AWAITING_APPROVAL"; approval: ApprovalRequestRecord }
  | { status: "DEFERRED_DECISIONS_PENDING"; decisionIds: string[] }
  | { status: "PUBLISHED"; pullRequest: PullRequestResult }
  | { status: "BASE_STALE"; currentBaseCommitSha: string };

interface PublicationAuthority {
  readonly route: "LOW_AUTO" | "HUMAN_APPROVED";
  readonly run: EngineerRun;
  readonly checkpoint: VerifiedCandidateCheckpoint;
  readonly evidence: PublicationEvidence;
  readonly evidenceBundle: EvidenceBundleRecord;
  readonly approval: ApprovalRequestRecord | null;
  readonly approvalDecision: ApprovalDecisionRecord | null;
  readonly fingerprint: string;
}

/** Phase-4 authority for human decisions and credentialed publication. */
export class EngineerPublicationManager {
  private readonly options: EngineerPublicationManagerOptions;
  private readonly activePublicationRuns = new Set<string>();
  constructor(options: EngineerPublicationManagerOptions) {
    if (options.commandSigningSecret.length < 32) throw new Error("publication command signing secret must be at least 32 characters");
    if (options.operationLeaseMs !== undefined && (!Number.isInteger(options.operationLeaseMs) || options.operationLeaseMs < 5_000 || options.operationLeaseMs > 15 * 60_000)) {
      throw new Error("publication operation lease must be between 5 seconds and 15 minutes");
    }
    this.options = options;
  }

  private assertOrdinaryPublicationLane(runId:string):void{
    if(this.options.supervisor.isOptionalHardeningChild(runId))
      throw new HardeningGenericOperationForbiddenError();
  }

  async start(runId: string, assignedReviewerId: string): Promise<PublicationStartResult> {
    this.assertOrdinaryPublicationLane(runId);
    if (!assignedReviewerId.trim()) throw new Error("an authenticated assigned reviewer is required for publication");
    const run = this.options.supervisor.getRun(runId);
    if (run.state !== "REVIEW_APPROVED") throw new Error(`publication requires REVIEW_APPROVED, not ${run.state}`);
    const checkpoint = await this.requireRunCheckpoint(runId);
    const deferred = this.deferredDecisionsPending(runId);
    if (deferred) return deferred;
    if (run.riskTier === "CRITICAL") {
      const policy = operationalFailurePolicy("PUBLICATION");
      this.recordFailure(runId, policy.failureClass, "CRITICAL_RISK_PUBLICATION_BLOCKED", new Error("critical-risk publication denied"), false);
      this.transition(runId, "SECURITY_ESCALATION", "CRITICAL_RISK_PUBLICATION_BLOCKED");
      throw new Error("critical-risk runs cannot be published");
    }
    if (run.riskTier === "LOW" && !run.humanGateRequired && this.options.autoPublishLowRisk === true) {
      return this.publish(runId);
    }
    const evidence = this.currentEvidence(runId);
    const requestedAt = this.timestamp();
    const deadlineMs = run.riskTier === "HIGH" ? 24 * 60 * 60_000 : 72 * 60 * 60_000;
    const deadlineAt = new Date(new Date(requestedAt).getTime() + deadlineMs).toISOString();
    const approval = await this.options.supervisor.recordApprovalRequest(ApprovalRequestRecordSchema.parse({
      approvalRequestId: this.id(), runId, riskTier: run.riskTier, assignedReviewerId,
      requestedAt, deadlineAt,
      reminderSchedule: [0.5, 0.8].map((ratio) => new Date(new Date(requestedAt).getTime() + deadlineMs * ratio).toISOString()),
      timeoutAction: run.riskTier === "HIGH" ? "HUMAN_REVIEW_REQUIRED" : "HUMAN_REVIEW_REQUIRED",
      manifestHash: run.manifestHash, diffHash: evidence.reviewerDiffHash,
      evidenceBundleHash: evidence.evidenceBundleHash, reviewerSessionId: evidence.reviewerSessionId,
      classificationHash: evidence.classificationHash, classificationResult: evidence.classificationResult,
      status: "PENDING", approvalRevision: 0,
      verifiedCheckpointId: checkpoint.checkpointId, verifiedCheckpointHash: checkpoint.checkpointHash,
    }), this.options.checkpointAttestor);
    this.transition(runId, "HUMAN_APPROVAL_PENDING", "HUMAN_APPROVAL_REQUESTED", [approval.approvalRequestId]);
    return { status: "AWAITING_APPROVAL", approval };
  }

  /**
   * Performs the local, durable authority check used by control-plane callers
   * before they invoke any potentially remote admission probe. The mutating
   * decision methods repeat this check immediately before their CAS so this is
   * a fail-fast guard, not a substitute for the atomic decision boundary.
   */
  assertApprovalAuthority(runId: string, expected: ApprovalAuthorityExpectation): void {
    this.requirePendingApproval(runId, expected);
  }

  async approve(runId: string, actorId: string, reason: string, expected: ApprovalAuthorityExpectation): Promise<PublicationStartResult> {
    this.assertOrdinaryPublicationLane(runId);
    const request = this.requirePendingApproval(runId, expected);
    this.assertDecisionActor(request, actorId);
    this.assertBeforeDeadline(request);
    await this.assertApprovalBinding(request);
    const decision = this.approvalCas(runId, () => this.options.supervisor.decideApproval(ApprovalDecisionRecordSchema.parse({
      approvalDecisionId: this.id(), approvalRequestId: request.approvalRequestId,
      actorId, decision: "APPROVE", reason, decidedAt: this.timestamp(),
      expectedVerifiedCheckpointId: request.verifiedCheckpointId,
      expectedVerifiedCheckpointHash: request.verifiedCheckpointHash,
      expectedApprovalRevision: request.approvalRevision,
    }), "APPROVED"));
    this.transition(runId, "HUMAN_APPROVED", "HUMAN_APPROVAL_VALIDATED", [decision.approvalDecisionId], "HUMAN", actorId, { humanApprovalValid: true });
    return this.publish(runId);
  }

  /** Replays an interrupted publication idempotently; successful PR creation is never duplicated. */
  resume(runId: string): Promise<PublicationStartResult> {
    this.assertOrdinaryPublicationLane(runId);
    const deferred = this.deferredDecisionsPending(runId);
    if (deferred) return Promise.resolve(deferred);
    return this.publish(runId);
  }

  /** Recovers only durable publication states; failures remain visible and retryable. */
  async recoverPending(): Promise<{ resumedRunIds: string[]; failedRunIds: string[] }> {
    const states: EngineerRun["state"][] = ["HUMAN_APPROVED", "PR_PREFLIGHT", "PR_CREATING", "PR_CREATED", "PR_CREATION_FAILED"];
    const resumedRunIds: string[] = [];
    const failedRunIds: string[] = [];
    for (const run of this.options.supervisor.listRuns(states)) {
      if(this.options.supervisor.isOptionalHardeningChild(run.runId)){failedRunIds.push(run.runId);continue;}
      const failures = this.options.supervisor.listFailures(run.runId);
      const permanentlyFailed = failures.some((failure) =>
        ["PUBLICATION_ARTIFACT_LIMIT_EXCEEDED", "PUBLICATION_LEGACY_AUTHORITY_MANUAL_REVIEW"].includes(failure.reasonCode) &&
        failure.retryable === false);
      if (permanentlyFailed) {
        failedRunIds.push(run.runId);
        continue;
      }
      const legacy = this.legacyRecoveryConflict(run.runId);
      if (legacy) {
        this.recordLegacyRecoveryConflict(run.runId, legacy.evidenceIds);
        failedRunIds.push(run.runId);
        continue;
      }
      try {
        await this.resume(run.runId);
        resumedRunIds.push(run.runId);
      } catch {
        failedRunIds.push(run.runId);
      }
    }
    return { resumedRunIds, failedRunIds };
  }

  private legacyRecoveryConflict(runId: string): { evidenceIds: string[] } | null {
    const approval = this.options.supervisor.latestApprovalRequest(runId);
    const operations = this.options.supervisor.listGitOperations(runId);
    const legacyOperations = operations.filter((operation) =>
      ["CREATE_BRANCH", "PUSH_COMMIT", "CREATE_PR"].includes(operation.operationType) &&
      (!operation.verifiedCheckpointId || !operation.verifiedCheckpointHash));
    if ((!approval || (approval.verifiedCheckpointId && approval.verifiedCheckpointHash)) && legacyOperations.length === 0) {
      return null;
    }
    return {
      evidenceIds: [
        ...(approval && (!approval.verifiedCheckpointId || !approval.verifiedCheckpointHash)
          ? [approval.approvalRequestId] : []),
        ...legacyOperations.map((operation) => operation.gitOperationId),
      ],
    };
  }

  private recordLegacyRecoveryConflict(runId: string, evidenceIds: string[]): void {
    if (this.options.supervisor.listFailures(runId).some((failure) =>
      failure.reasonCode === "PUBLICATION_LEGACY_AUTHORITY_MANUAL_REVIEW" && failure.retryable === false)) return;
    const error = new Error("Legacy publication authority is read-only and requires manual review; automatic recovery is disabled.");
    this.options.supervisor.setLastError?.(runId, error.message);
    this.recordFailure(runId, "WORKFLOW_FAILURE", "PUBLICATION_LEGACY_AUTHORITY_MANUAL_REVIEW", error, false, evidenceIds);
  }

  async requestChanges(runId: string, actorId: string, reason: string, expected: ApprovalAuthorityExpectation): Promise<void> {
    this.assertOrdinaryPublicationLane(runId);
    const request = this.requirePendingApproval(runId, expected);
    this.assertDecisionActor(request, actorId);
    await this.assertApprovalBinding(request);
    const decision = this.approvalCas(runId, () => this.options.supervisor.decideApproval(ApprovalDecisionRecordSchema.parse({
      approvalDecisionId: this.id(), approvalRequestId: request.approvalRequestId,
      actorId, decision: "REQUEST_CHANGES", reason, decidedAt: this.timestamp(),
      expectedVerifiedCheckpointId: request.verifiedCheckpointId,
      expectedVerifiedCheckpointHash: request.verifiedCheckpointHash,
      expectedApprovalRevision: request.approvalRevision,
    }), "CHANGES_REQUESTED"));
    this.transition(runId, "FIX_REQUESTED", "HUMAN_REQUESTED_CHANGES", [decision.approvalDecisionId], "HUMAN", actorId);
  }

  async reject(runId: string, actorId: string, reason: string, expected: ApprovalAuthorityExpectation): Promise<void> {
    const request = this.requirePendingApproval(runId, expected);
    this.assertDecisionActor(request, actorId);
    await this.assertApprovalBinding(request);
    const decision = this.approvalCas(runId, () => this.options.supervisor.decideApproval(ApprovalDecisionRecordSchema.parse({
      approvalDecisionId: this.id(), approvalRequestId: request.approvalRequestId,
      actorId, decision: "REJECT", reason, decidedAt: this.timestamp(),
      expectedVerifiedCheckpointId: request.verifiedCheckpointId,
      expectedVerifiedCheckpointHash: request.verifiedCheckpointHash,
      expectedApprovalRevision: request.approvalRevision,
    }), "REJECTED"));
    this.transition(runId, "REJECTED", "HUMAN_REJECTED", [decision.approvalDecisionId], "HUMAN", actorId);
  }

  async extend(runId: string, actorId: string, reason: string, extensionSeconds: number, expected: ApprovalAuthorityExpectation): Promise<ApprovalRequestRecord> {
    if (!Number.isInteger(extensionSeconds) || extensionSeconds < 60 || extensionSeconds > 7 * 24 * 60 * 60) {
      throw new Error("approval extension must be between 60 seconds and 7 days");
    }
    const request = this.requirePendingApproval(runId, expected);
    this.assertDecisionActor(request, actorId);
    await this.assertApprovalBinding(request);
    const deadlineAt = new Date(new Date(request.deadlineAt).getTime() + extensionSeconds * 1_000).toISOString();
    return this.approvalCas(runId, () => this.options.supervisor.extendApproval(ApprovalDecisionRecordSchema.parse({
      approvalDecisionId: this.id(), approvalRequestId: request.approvalRequestId,
      actorId, decision: "EXTEND", reason, decidedAt: this.timestamp(),
      expectedVerifiedCheckpointId: request.verifiedCheckpointId,
      expectedVerifiedCheckpointHash: request.verifiedCheckpointHash,
      expectedApprovalRevision: request.approvalRevision,
    }), deadlineAt, [new Date(new Date(request.deadlineAt).getTime() + extensionSeconds * 500).toISOString()]));
  }

  async expire(runId: string, expected: ApprovalAuthorityExpectation): Promise<void> {
    const request = this.requirePendingApproval(runId, expected);
    if (new Date(this.timestamp()).getTime() <= new Date(request.deadlineAt).getTime()) throw new Error("approval deadline has not expired");
    await this.assertApprovalBinding(request);
    this.approvalCas(runId, () => this.options.supervisor.decideApproval(ApprovalDecisionRecordSchema.parse({
      approvalDecisionId: this.id(), approvalRequestId: request.approvalRequestId,
      actorId: "engineer-supervisor", decision: "REJECT", reason: "Approval deadline expired.", decidedAt: this.timestamp(),
      expectedVerifiedCheckpointId: request.verifiedCheckpointId,
      expectedVerifiedCheckpointHash: request.verifiedCheckpointHash,
      expectedApprovalRevision: request.approvalRevision,
    }), "EXPIRED"));
    const policy = operationalFailurePolicy("TIMEOUT");
    this.recordFailure(runId, policy.failureClass, policy.reasonCode, new Error("human approval deadline expired"), policy.retryable, [request.approvalRequestId]);
    this.transition(runId, "HUMAN_REVIEW_REQUIRED", "HUMAN_APPROVAL_TIMEOUT", [request.approvalRequestId]);
  }

  async sweepExpired(): Promise<string[]> {
    const expired: string[] = [];
    for (const run of this.options.supervisor.listRuns(["HUMAN_APPROVAL_PENDING"])) {
      const request = this.options.supervisor.latestApprovalRequest(run.runId);
      if (request && request.status === "PENDING" && new Date(this.timestamp()).getTime() > new Date(request.deadlineAt).getTime()) {
        if (!request.verifiedCheckpointId || !request.verifiedCheckpointHash) {
          this.recordLegacyRecoveryConflict(run.runId, [request.approvalRequestId]);
          continue;
        }
        await this.expire(run.runId, {
          expectedVerifiedCheckpointId: request.verifiedCheckpointId,
          expectedVerifiedCheckpointHash: request.verifiedCheckpointHash,
          expectedApprovalRevision: request.approvalRevision,
        });
        expired.push(run.runId);
      }
    }
    return expired;
  }

  requestCancellation(runId:string,actorId:string,reason:string):void{
    const run = this.options.supervisor.getRun(runId);
    if (actorId !== run.userId) throw new Error("cancellation actor does not own this run");
    if(run.state==="CANCELLED")return;
    if (run.terminalAt) throw new Error(`terminal run ${run.state} cannot be cancelled`);
    if (hasUnreconciledRemotePublication(this.options.supervisor.listGitOperations(runId))) {
      throw new Error("cancellation is fenced because remote publication was attempted and no durable remote cleanup is available");
    }
    if(run.state==="CANCELLATION_PENDING")return;
    if (!isCancellationAllowed(run.state)) {
      throw new Error(`cancellation is fenced while publication state is ${run.state}; remote cleanup is not safely available`);
    }
    const artifact = this.options.artifactStore.put({
      runId, type: "CANCELLATION_REQUEST", bytes: JSON.stringify({ actorId, reason, requestedAt: this.timestamp() }),
      producerType: "SYSTEM", producerId: "engineer-supervisor", trusted: true,
    });
    try{
      const result=this.options.supervisor.requestRunCancellation({runId,actorId,artifact});
      if(!result.applied)this.removeUnreferencedCancellationArtifact(runId,artifact.storageReference);
    }catch(error){
      this.removeUnreferencedCancellationArtifact(runId,artifact.storageReference);
      throw error;
    }
  }

  async cancel(runId: string, actorId: string, reason: string): Promise<void> {
    this.requestCancellation(runId,actorId,reason);
    // Cleanup and the terminal CAS require the separate durable run lease.
    // EngineerRunManager owns that fenced asynchronous phase; this legacy
    // facade commits only the durable user intent and returns safely pending.
  }

  private removeUnreferencedCancellationArtifact(runId:string,storageReference:string):void{
    if(this.options.supervisor.listArtifacts(runId)
      .some((artifact)=>artifact.storageReference===storageReference))return;
    try{unlinkSync(storageReference);}catch{/* Missing candidate is already safe. */}
  }

  authorizeStaleReverification(runId: string): void {
    const run = this.options.supervisor.getRun(runId);
    if (run.state !== "BASE_BRANCH_STALE") throw new Error("stale-base re-verification requires BASE_BRANCH_STALE");
    this.transition(runId, "REVERIFYING", "STALE_BASE_REVERIFICATION_REQUIRED");
  }

  /** Discovers and locally synchronizes a new base for a clean replacement run. */
  async replacementRepositoryForStale(runId: string): Promise<EngineerRun["repository"]> {
    const authority = await this.publicationAuthority(runId);
    const run = authority.run;
    if (run.state !== "BASE_BRANCH_STALE") throw new Error("stale-base recovery requires BASE_BRANCH_STALE");
    const status = await this.options.gitService.inspectBaseBranch({
      repository: run.repository,
      expectedBaseCommitSha: run.repository.baseCommitSha,
    });
    if (status.matchesExpected) throw new Error("stale-base recovery is unnecessary because the base matches again");
    if (!this.options.gitService.synchronizeBaseBranch) {
      throw new Error("Git service cannot synchronize the inspected replacement base");
    }
    await this.revalidatePublicationAuthority(authority, ["BASE_BRANCH_STALE"]);
    await this.options.gitService.synchronizeBaseBranch({ repository: run.repository, expectedCommitSha: status.currentCommitSha });
    return { ...run.repository, baseCommitSha: status.currentCommitSha };
  }

  private async publish(runId: string): Promise<PublicationStartResult> {
    this.assertOrdinaryPublicationLane(runId);
    const deferred = this.deferredDecisionsPending(runId);
    if (deferred) return deferred;
    if (this.activePublicationRuns.has(runId)) throw new PublicationOperationInProgressError(runId);
    this.activePublicationRuns.add(runId);
    try {
      const result = await this.publishFenced(runId);
      this.options.supervisor.setLastError?.(runId, null);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof RangeError && /artifact.*(?:byte|limit)|run artifacts exceed/i.test(message)) {
        this.options.supervisor.setLastError?.(runId, message);
        this.recordFailure(runId, "WORKFLOW_FAILURE", "PUBLICATION_ARTIFACT_LIMIT_EXCEEDED", error, false);
        const current = this.options.supervisor.getRun(runId);
        if (current.state === "PR_PREFLIGHT" || current.state === "PR_CREATION_FAILED") {
          this.transition(runId, "FAILED", "PUBLICATION_ARTIFACT_LIMIT_EXCEEDED");
        } else if (current.state === "PR_CREATING") {
          // A remote side effect may be in flight. Preserve the uncertainty for
          // a human instead of falsely declaring the publication rolled back.
          this.transition(runId, "HUMAN_REVIEW_REQUIRED", "PUBLICATION_ARTIFACT_LIMIT_EXCEEDED");
        }
      }
      throw error;
    } finally {
      this.activePublicationRuns.delete(runId);
    }
  }

  private async publishFenced(runId: string): Promise<PublicationStartResult> {
    const supervisor = this.options.supervisor;
    const deferred = this.deferredDecisionsPending(runId);
    if (deferred) return deferred;
    const authority = await this.publicationAuthority(runId);
    let run = authority.run;
    const evidence = authority.evidence;
    const approval = authority.approval;
    const authorityKey = authority.checkpoint.checkpointHash.slice("sha256:".length);
    const prIdempotencyKey = `pr:create:${runId}:${authorityKey}:${authority.checkpoint.resultCommitSha}`;
    this.assertNoLegacyPublicationOperations(runId);
    const replay = supervisor.findGitOperation(runId, prIdempotencyKey);
    if (replay) {
      this.assertOperationReplay(authority, replay, "CREATE_PR", approval?.approvalRequestId ?? null);
    }
    if (run.state === "COMPLETED" && replay?.status === "SUCCEEDED" && replay.remoteReference) {
      return { status: "PUBLISHED", pullRequest: { id: replay.gitOperationId, number: 0, url: replay.remoteReference } };
    }
    if (run.state === "PR_CREATED" && replay?.status === "SUCCEEDED" && replay.remoteReference) {
      this.transition(runId, "COMPLETED", "ENGINEER_RUN_COMPLETED", [replay.gitOperationId, evidence.evidenceBundleId]);
      await this.options.cleanupRun?.(runId);
      return { status: "PUBLISHED", pullRequest: { id: replay.gitOperationId, number: 0, url: replay.remoteReference } };
    }
    if (!["REVIEW_APPROVED", "HUMAN_APPROVED", "PR_PREFLIGHT", "PR_CREATING", "PR_CREATION_FAILED"].includes(run.state)) {
      throw new Error(`publication resume is not valid from ${run.state}`);
    }
    // Inspection is read-only and intentionally gets a fresh attempt identity;
    // a crashed completed inspection must not strand publication recovery.
    const inspect = await this.operation(authority, authority.run, "INSPECT_BASE",
      `git:inspect:${runId}:${authorityKey}:${authority.checkpoint.resultCommitSha}:${this.id()}`,
      evidence, approval?.approvalRequestId ?? null,
      async () => {
        const status = await this.options.gitService.inspectBaseBranch({
          repository: authority.run.repository,
          expectedBaseCommitSha: authority.checkpoint.baseCommitSha,
        });
        return { reference: status.currentCommitSha, value: status };
      });
    const base = inspect.value as { currentCommitSha: string; matchesExpected: boolean; protectionEnforced: boolean };
    if (!base.matchesExpected) {
      this.transition(runId, "BASE_BRANCH_STALE", "BASE_BRANCH_CHANGED", [inspect.record.gitOperationId]);
      this.recordFailure(runId, "GIT_FAILURE", "BASE_BRANCH_CHANGED", new Error(base.currentCommitSha), true, [inspect.record.gitOperationId]);
      return { status: "BASE_STALE", currentBaseCommitSha: base.currentCommitSha };
    }
    if (run.state === "REVIEW_APPROVED" || run.state === "HUMAN_APPROVED" || run.state === "PR_CREATION_FAILED") {
      this.transition(runId, "PR_PREFLIGHT", run.state === "PR_CREATION_FAILED" ? "PUBLICATION_RECOVERY_RETRY" : "PUBLICATION_PREFLIGHT_PASSED", [evidence.evidenceBundleId, inspect.record.gitOperationId], "SUPERVISOR", "engineer-supervisor", {
        reviewerDecisionValid: true, allRequiredChecksPassed: evidence.allRequiredChecksPassed,
        noCriticalSecurityFindings: evidence.openCriticalSecurityFindings === 0,
        evidenceBundleComplete: true, baseBranchCurrent: true,
        ...(approval ? { humanApprovalValid: true } : {}),
      });
      run = supervisor.getRun(runId);
    }
    if (!base.protectionEnforced) {
      this.recordFailure(runId, "SECURITY_FAILURE", "BRANCH_PROTECTION_INSUFFICIENT", new Error("base branch does not enforce required reviews and strict status checks"), false, [inspect.record.gitOperationId]);
      this.transition(runId, "SECURITY_ESCALATION", "BRANCH_PROTECTION_INSUFFICIENT", [inspect.record.gitOperationId]);
      throw new Error("publication blocked: base branch protection is insufficient");
    }
    const command = SupervisorPrCommandSchema.parse({
      runId, repositoryId: authority.checkpoint.repositoryId, baseBranch: authority.run.repository.baseBranch,
      expectedBaseCommitSha: authority.checkpoint.baseCommitSha, resultCommitSha: authority.checkpoint.resultCommitSha,
      manifestHash: authority.checkpoint.manifestHash, evidenceBundleHash: authority.checkpoint.evidenceBundleHash,
      reviewDecisionId: evidence.reviewerSessionId, humanApprovalId: approval?.approvalRequestId ?? null,
      classificationHash: evidence.classificationHash, classificationResult: evidence.classificationResult,
      riskTier: authority.run.riskTier, idempotencyKey: prIdempotencyKey,
      verifiedCheckpointId: authority.checkpoint.checkpointId,
      verifiedCheckpointHash: authority.checkpoint.checkpointHash,
    });
    const signed = SignedSupervisorPrCommandSchema.parse({ command, signature: this.sign(command) });
    if (!this.verifySignature(signed)) throw new Error("internal publication command signature verification failed");
    const commandArtifact = supervisor.recordArtifact(this.options.artifactStore.put({
      runId, type: "SUPERVISOR_PR_COMMAND", bytes: JSON.stringify(signed), producerType: "SYSTEM",
      producerId: "engineer-supervisor", trusted: true,
    }));
    if (run.state !== "PR_CREATING") {
      this.transition(runId, "PR_CREATING", "SUPERVISOR_PR_COMMAND_AUTHORIZED", [commandArtifact.artifactId]);
      run = supervisor.getRun(runId);
    }
    try {
      const branch = await this.operation(authority, authority.run, "CREATE_BRANCH", `git:branch:${runId}:${authorityKey}:${authority.checkpoint.resultCommitSha}`, evidence, approval?.approvalRequestId ?? null,
        async () => {
          const value = await this.options.gitService.createRunBranch({
            runId, repository: authority.run.repository, resultCommitSha: authority.checkpoint.resultCommitSha,
          });
          return { reference: value.remoteReference, value };
        });
      const branchValue = branch.value as { branchName: string; remoteReference: string };
      await this.operation(authority, authority.run, "PUSH_COMMIT", `git:push:${runId}:${authorityKey}:${authority.checkpoint.resultCommitSha}`, evidence, approval?.approvalRequestId ?? null,
        async () => {
          const value = await this.options.gitService.pushVerifiedCommit({
            runId, repository: authority.run.repository, resultCommitSha: authority.checkpoint.resultCommitSha,
            branchName: branchValue.branchName,
          });
          return { reference: value.remoteReference, value };
        });
      const preCreateBase = await this.operation(authority, authority.run, "INSPECT_BASE",
        `git:inspect-before-pr:${runId}:${authorityKey}:${authority.checkpoint.resultCommitSha}:${this.id()}`,
        evidence, approval?.approvalRequestId ?? null,
        async () => {
          const value = await this.options.gitService.inspectBaseBranch({
            repository: authority.run.repository, expectedBaseCommitSha: authority.checkpoint.baseCommitSha,
          });
          return { reference: value.currentCommitSha, value };
        });
      const preCreateStatus = preCreateBase.value as { currentCommitSha: string; matchesExpected: boolean };
      if (!preCreateStatus.matchesExpected) {
        this.transition(runId, "BASE_BRANCH_STALE", "BASE_BRANCH_CHANGED_BEFORE_PR", [preCreateBase.record.gitOperationId]);
        this.recordFailure(runId, "GIT_FAILURE", "BASE_BRANCH_CHANGED_BEFORE_PR", new Error(preCreateStatus.currentCommitSha), true, [preCreateBase.record.gitOperationId]);
        return { status: "BASE_STALE", currentBaseCommitSha: preCreateStatus.currentCommitSha };
      }
      if (replay?.status === "SUCCEEDED" && replay.remoteReference) {
        this.transition(runId, "PR_CREATED", "PULL_REQUEST_RECOVERED", [replay.gitOperationId]);
        this.transition(runId, "COMPLETED", "ENGINEER_RUN_COMPLETED", [replay.gitOperationId, evidence.evidenceBundleId]);
        await this.options.cleanupRun?.(runId);
        return { status: "PUBLISHED", pullRequest: { id: replay.gitOperationId, number: 0, url: replay.remoteReference } };
      }
      const body = this.prBody(authority.run, authority.checkpoint.evidenceBundleHash);
      const created = await this.operation(authority, authority.run, "CREATE_PR", prIdempotencyKey, evidence, approval?.approvalRequestId ?? null,
        async () => {
          const value = await this.options.gitService.createPullRequest({
            runId, repository: authority.run.repository, branchName: branchValue.branchName,
            baseBranch: authority.run.repository.baseBranch,
            title: authority.run.requestNormalized || authority.run.requestOriginal,
            body, idempotencyKey: prIdempotencyKey,
          });
          return { reference: value.url, value };
        });
      const postCreateBase = await this.operation(authority, authority.run, "INSPECT_BASE",
        `git:inspect-after-pr:${runId}:${authorityKey}:${authority.checkpoint.resultCommitSha}:${this.id()}`,
        evidence, approval?.approvalRequestId ?? null,
        async () => {
          const value = await this.options.gitService.inspectBaseBranch({
            repository: authority.run.repository, expectedBaseCommitSha: authority.checkpoint.baseCommitSha,
          });
          return { reference: value.currentCommitSha, value };
        });
      const postCreateStatus = postCreateBase.value as { currentCommitSha: string; matchesExpected: boolean };
      if (!postCreateStatus.matchesExpected) {
        this.transition(runId, "BASE_BRANCH_STALE", "BASE_BRANCH_CHANGED_DURING_PR", [created.record.gitOperationId, postCreateBase.record.gitOperationId]);
        this.recordFailure(runId, "GIT_FAILURE", "BASE_BRANCH_CHANGED_DURING_PR", new Error(postCreateStatus.currentCommitSha), true,
          [created.record.gitOperationId, postCreateBase.record.gitOperationId]);
        return { status: "BASE_STALE", currentBaseCommitSha: postCreateStatus.currentCommitSha };
      }
      this.transition(runId, "PR_CREATED", "PULL_REQUEST_CREATED", [created.record.gitOperationId], "SUPERVISOR", "engineer-supervisor", { prCreated: true });
      this.transition(runId, "COMPLETED", "ENGINEER_RUN_COMPLETED", [created.record.gitOperationId, evidence.evidenceBundleId]);
      await this.options.cleanupRun?.(runId);
      return { status: "PUBLISHED", pullRequest: created.value as PullRequestResult };
    } catch (error) {
      if (error instanceof PublicationOperationInProgressError || error instanceof PublicationOperationRecoveryRequiredError) throw error;
      this.recordFailure(runId, "GIT_FAILURE", "PR_PUBLICATION_FAILED", error, true, [commandArtifact.artifactId]);
      const current = supervisor.getRun(runId);
      if (current.state === "PR_CREATING") this.transition(runId, "PR_CREATION_FAILED", "PR_PUBLICATION_FAILED", [commandArtifact.artifactId]);
      throw error;
    }
  }

  private currentEvidence(runId: string) {
    const evidence = this.options.supervisor.getPublicationEvidence(runId);
    if (!["READY", "READY_WITH_ADVISORIES"].includes(evidence.classificationResult)) {
      throw new Error("publication blocked: deterministic review classification is not ready");
    }
    const diff = this.options.diffForRun(runId);
    if (sha256(diff) !== evidence.reviewerDiffHash) throw new Error("current diff no longer matches the isolated Reviewer decision");
    if (!evidence.allRequiredChecksPassed || evidence.openCriticalSecurityFindings > 0) throw new Error("publication evidence gates are not satisfied");
    return evidence;
  }

  /**
   * Selects one durable publication authority. Human publication is anchored
   * to the checkpoint named by the approved request and never falls back to a
   * run-level/latest checkpoint lookup. LOW auto-publication uses the sole
   * promoted checkpoint for the run.
   */
  private async publicationAuthority(runId: string, expected?: PublicationAuthority): Promise<PublicationAuthority> {
    const supervisor = this.options.supervisor;
    let run = supervisor.getRun(runId);
    const selectedRoute: PublicationAuthority["route"] = run.riskTier === "LOW" && !run.humanGateRequired
      ? "LOW_AUTO" : "HUMAN_APPROVED";
    let approval: ApprovalRequestRecord | null = null;
    if (selectedRoute === "HUMAN_APPROVED") {
      approval = supervisor.latestApprovalRequest(runId);
      if (!approval || approval.status !== "APPROVED" || !approval.verifiedCheckpointId ||
          !approval.verifiedCheckpointHash || !approval.reviewerSessionId ||
          !approval.classificationHash || !approval.classificationResult) {
        throw new Error("publication requires an exact checkpoint-bound approved request");
      }
      if (expected?.approval && approval.approvalRequestId !== expected.approval.approvalRequestId) {
        throw new Error("publication approval authority changed during execution");
      }
    }

    const checkpointReference = expected
      ? { checkpointId: expected.checkpoint.checkpointId }
      : approval?.verifiedCheckpointId
        ? { checkpointId: approval.verifiedCheckpointId }
        : { runId };
    const signed = await supervisor.getVerifiedCandidateCheckpoint(
      checkpointReference, this.options.checkpointAttestor,
    );
    if (!signed) throw new Error("publication requires an exact verified candidate checkpoint");
    const checkpoint = signed.checkpoint;

    // The attestor may be remote or hardware-backed. Never carry the run or
    // approval snapshot from before that await across the publication fence.
    const currentRun = supervisor.getRun(runId);
    const route: PublicationAuthority["route"] = currentRun.riskTier === "LOW" && !currentRun.humanGateRequired
      ? "LOW_AUTO" : "HUMAN_APPROVED";
    if (route !== selectedRoute) throw new Error("publication route authority changed during checkpoint attestation");
    if (route === "HUMAN_APPROVED") {
      const currentApproval = supervisor.latestApprovalRequest(runId);
      if (!approval || !currentApproval || currentApproval.approvalRequestId !== approval.approvalRequestId ||
          sha256(currentApproval) !== sha256(approval)) {
        throw new Error("publication approval authority changed during checkpoint attestation");
      }
      approval = currentApproval;
    }
    run = currentRun;
    if (approval && (checkpoint.checkpointId !== approval.verifiedCheckpointId ||
        checkpoint.checkpointHash !== approval.verifiedCheckpointHash)) {
      throw new Error("approved request does not bind the rehydrated publication checkpoint");
    }

    // These mutable/current safety reads intentionally happen only after the
    // signature and durable checkpoint internals have been verified.
    const evidence = this.currentEvidence(runId);
    const contract = supervisor.getRequiredLaneContract(runId, run.manifestHash ?? undefined);
    const bundles = supervisor.listEvidenceBundles(runId)
      .filter((candidate) => candidate.evidenceBundleId === checkpoint.evidenceBundleId);
    if (bundles.length !== 1) throw new Error("publication checkpoint evidence bundle is unavailable or ambiguous");
    const evidenceBundle = bundles[0]!;
    const bundle = evidenceBundle.bundle;
    if (checkpoint.runId !== runId || checkpoint.requesterUserId !== run.userId ||
        checkpoint.repositoryId !== run.repository.repositoryId || !contract ||
        checkpoint.requiredLaneContractHash !== contract.contractHash || checkpoint.manifestHash !== run.manifestHash ||
        checkpoint.baseCommitSha.toLowerCase() !== run.repository.baseCommitSha.toLowerCase() ||
        checkpoint.resultCommitSha.toLowerCase() !== evidence.resultCommitSha.toLowerCase() ||
        checkpoint.diffHash !== evidence.reviewerDiffHash || checkpoint.reviewerSessionId !== evidence.reviewerSessionId ||
        checkpoint.classificationHash !== evidence.classificationHash ||
        checkpoint.classificationResult !== evidence.classificationResult ||
        checkpoint.evidenceBundleId !== evidence.evidenceBundleId ||
        checkpoint.evidenceBundleHash !== evidence.evidenceBundleHash ||
        evidenceBundle.bundleHash !== checkpoint.evidenceBundleHash || bundle.runId !== runId ||
        bundle.manifestHash !== checkpoint.manifestHash ||
        bundle.baseCommitSha.toLowerCase() !== checkpoint.baseCommitSha.toLowerCase() ||
        bundle.resultCommitSha.toLowerCase() !== checkpoint.resultCommitSha.toLowerCase() ||
        bundle.reviewerSessionId !== checkpoint.reviewerSessionId ||
        bundle.classificationHash !== checkpoint.classificationHash ||
        bundle.classificationResult !== checkpoint.classificationResult ||
        bundle.environmentDigest !== checkpoint.environmentDigest) {
      throw new Error("verified candidate checkpoint no longer matches complete publication authority");
    }

    let approvalDecision: ApprovalDecisionRecord | null = null;
    if (approval) {
      if (approval.runId !== runId || approval.riskTier !== run.riskTier ||
          approval.manifestHash !== checkpoint.manifestHash || approval.diffHash !== checkpoint.diffHash ||
          approval.evidenceBundleHash !== checkpoint.evidenceBundleHash ||
          approval.reviewerSessionId !== checkpoint.reviewerSessionId ||
          approval.classificationHash !== checkpoint.classificationHash ||
          approval.classificationResult !== checkpoint.classificationResult) {
        throw new Error("approved request no longer matches complete publication authority");
      }
      const decisions = supervisor.listApprovalDecisions(approval.approvalRequestId);
      const strictDecisions = decisions.map((decision) => ApprovalDecisionRecordSchema.parse(decision));
      if (strictDecisions.length === 0 || approval.approvalRevision !== strictDecisions.length ||
          strictDecisions.some((decision, index) =>
            decision.approvalRequestId !== approval!.approvalRequestId ||
            decision.expectedVerifiedCheckpointId !== checkpoint.checkpointId ||
            decision.expectedVerifiedCheckpointHash !== checkpoint.checkpointHash ||
            decision.expectedApprovalRevision !== index ||
            (approval!.assignedReviewerId !== null && decision.actorId !== approval!.assignedReviewerId) ||
            (index === strictDecisions.length - 1 ? decision.decision !== "APPROVE" : decision.decision !== "EXTEND"))) {
        throw new Error("approved request has invalid decision history or revision authority");
      }
      approvalDecision = strictDecisions.at(-1)!;
      if (approvalDecision.approvalRequestId !== approval.approvalRequestId ||
          approvalDecision.decision !== "APPROVE" ||
          approvalDecision.expectedVerifiedCheckpointId !== checkpoint.checkpointId ||
          approvalDecision.expectedVerifiedCheckpointHash !== checkpoint.checkpointHash ||
          approvalDecision.expectedApprovalRevision + 1 !== approval.approvalRevision ||
          (approval.assignedReviewerId !== null && approvalDecision.actorId !== approval.assignedReviewerId)) {
        throw new Error("approval decision does not bind the exact checkpoint and revision");
      }
    }

    const immutable = {
      route,
      run: {
        runId: run.runId, userId: run.userId, repository: run.repository,
        requestOriginal: run.requestOriginal, requestNormalized: run.requestNormalized,
        manifestHash: run.manifestHash, riskTier: run.riskTier, humanGateRequired: run.humanGateRequired,
      },
      checkpoint,
      evidence,
      evidenceBundle,
      approval,
      approvalDecision,
    };
    const fingerprint = sha256(immutable);
    if (expected && (expected.route !== route || expected.fingerprint !== fingerprint)) {
      throw new Error("publication authority changed during execution");
    }
    return Object.freeze({ ...immutable, run: Object.freeze({ ...run, repository: Object.freeze({ ...run.repository }) }), fingerprint });
  }

  private async revalidatePublicationAuthority(
    authority: PublicationAuthority,
    allowedStates: readonly EngineerRun["state"][],
  ): Promise<PublicationAuthority> {
    const current = await this.publicationAuthority(authority.run.runId, authority);
    if (!allowedStates.includes(current.run.state)) {
      throw new Error(`publication authority is not valid from current state ${current.run.state}`);
    }
    return current;
  }

  /** Publication never crosses into Git while an end-of-run human choice remains unresolved. */
  private deferredDecisionsPending(runId: string): Extract<PublicationStartResult, { status: "DEFERRED_DECISIONS_PENDING" }> | null {
    const decisionIds = this.options.supervisor.listOpenDecisions(runId)
      .filter((decision) => decision.classification === "DEFER")
      .map((decision) => decision.decisionId)
      .sort();
    return decisionIds.length > 0 ? { status: "DEFERRED_DECISIONS_PENDING", decisionIds } : null;
  }

  private approvalCas<T>(runId: string, operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      // At this boundary an idempotency conflict can only come from the exact
      // approval decision/extension CAS above. Translate that lost authority
      // race into the stable control-plane conflict; unrelated publication
      // idempotency errors occur outside this narrowly scoped callback.
      if (error instanceof IdempotencyConflictError) {
        throw new ApprovalAuthorityConflictError(runId);
      }
      throw error;
    }
  }

  private requirePendingApproval(runId: string, expectation: ApprovalAuthorityExpectation): NewApprovalRequestRecord {
    const expected = ApprovalAuthorityExpectationSchema.parse(expectation);
    const run = this.options.supervisor.getRun(runId);
    const request = this.options.supervisor.latestApprovalRequest(runId);
    if (!request || request.status !== "PENDING" || run.state !== "HUMAN_APPROVAL_PENDING" ||
        !request.verifiedCheckpointId || !request.verifiedCheckpointHash ||
        request.verifiedCheckpointId !== expected.expectedVerifiedCheckpointId ||
        request.verifiedCheckpointHash !== expected.expectedVerifiedCheckpointHash ||
        request.approvalRevision !== expected.expectedApprovalRevision) {
      throw new ApprovalAuthorityConflictError(runId);
    }
    return ApprovalRequestRecordSchema.parse(request);
  }

  private assertDecisionActor(request: ApprovalRequestRecord, actorId: string): void {
    if (request.assignedReviewerId && request.assignedReviewerId !== actorId) {
      throw new Error("human decision actor is not the assigned reviewer");
    }
  }

  private async requireRunCheckpoint(runId: string): Promise<VerifiedCandidateCheckpoint> {
    const authority = await this.options.supervisor.getVerifiedCandidateCheckpoint(
      { runId }, this.options.checkpointAttestor,
    );
    if (!authority) throw new Error("publication requires an exact verified candidate checkpoint");
    const run = this.options.supervisor.getRun(runId);
    const evidence = this.currentEvidence(runId);
    const checkpoint = authority.checkpoint;
    if (checkpoint.runId !== runId || checkpoint.manifestHash !== run.manifestHash ||
        checkpoint.diffHash !== evidence.reviewerDiffHash || checkpoint.evidenceBundleHash !== evidence.evidenceBundleHash ||
        checkpoint.reviewerSessionId !== evidence.reviewerSessionId ||
        checkpoint.classificationHash !== evidence.classificationHash ||
        checkpoint.classificationResult !== evidence.classificationResult) {
      throw new Error("verified candidate checkpoint no longer matches current publication authority");
    }
    return checkpoint;
  }

  private async assertApprovalBinding(request: ApprovalRequestRecord): Promise<void> {
    if (!request.verifiedCheckpointId || !request.verifiedCheckpointHash) {
      throw new Error("approval request has no verified checkpoint authority");
    }
    const authority = await this.options.supervisor.getVerifiedCandidateCheckpoint(
      { checkpointId: request.verifiedCheckpointId }, this.options.checkpointAttestor,
    );
    if (!authority || authority.checkpoint.checkpointId !== request.verifiedCheckpointId ||
        authority.checkpoint.checkpointHash !== request.verifiedCheckpointHash) {
      throw new Error("approval request verified checkpoint authority is unavailable or mismatched");
    }
    const run = this.options.supervisor.getRun(request.runId);
    const evidence = this.currentEvidence(request.runId);
    const checkpoint = authority.checkpoint;
    if (checkpoint.runId !== request.runId || checkpoint.manifestHash !== request.manifestHash ||
        checkpoint.diffHash !== request.diffHash || checkpoint.evidenceBundleHash !== request.evidenceBundleHash ||
        checkpoint.reviewerSessionId !== request.reviewerSessionId ||
        checkpoint.classificationHash !== request.classificationHash ||
        checkpoint.classificationResult !== request.classificationResult ||
        run.manifestHash !== request.manifestHash || evidence.reviewerDiffHash !== request.diffHash ||
        evidence.evidenceBundleHash !== request.evidenceBundleHash ||
        evidence.reviewerSessionId !== request.reviewerSessionId ||
        evidence.classificationHash !== request.classificationHash ||
        evidence.classificationResult !== request.classificationResult) {
      throw new Error("approval request no longer matches current manifest, diff, evidence, or classified Reviewer authority");
    }
  }

  private assertBeforeDeadline(request: ApprovalRequestRecord): void {
    if (new Date(this.timestamp()).getTime() > new Date(request.deadlineAt).getTime()) throw new Error("approval request has expired");
  }

  private async operation(
    authority: PublicationAuthority,
    run: EngineerRun, operationType: GitOperationRecord["operationType"], idempotencyKey: string,
    evidence: ReturnType<EngineerSupervisor["getPublicationEvidence"]>, approvalId: string | null,
    execute: () => Promise<{ reference: string; value: unknown }>,
  ): Promise<{ record: GitOperationRecord; value: unknown }> {
    const existing = this.options.supervisor.findGitOperation(run.runId, idempotencyKey);
    if (existing) this.assertOperationReplay(authority, existing, operationType, approvalId);
    if (existing?.status === "STARTED") {
      return this.reconcileExpiredOperation(authority, run, existing, evidence);
    }
    if (existing?.status === "STALE") throw new PublicationOperationRecoveryRequiredError(run.runId, operationType);
    if (operationType !== "INSPECT_BASE" && existing?.status === "SUCCEEDED" && existing.remoteReference) {
      const value = operationType === "CREATE_BRANCH"
        ? { branchName: existing.remoteReference.replace(/^refs\/heads\//, ""), remoteReference: existing.remoteReference }
        : operationType === "PUSH_COMMIT"
          ? { remoteReference: existing.remoteReference }
        : { url: existing.remoteReference, remoteReference: existing.remoteReference };
      return { record: existing, value };
    }
    if (operationType !== "INSPECT_BASE" && this.options.supervisor.getRun(run.runId).state !== "PR_CREATING") {
      throw new Error(`remote publication operation ${operationType} requires the PR_CREATING fence`);
    }
    if (operationType !== "INSPECT_BASE" && operationType !== "REBASE_CANDIDATE") {
      await this.revalidatePublicationAuthority(authority, ["PR_CREATING"]);
    }
    const id = existing?.gitOperationId ?? this.id();
    const startedAt = existing?.startedAt ?? this.timestamp();
    const started = this.options.supervisor.recordGitOperation(GitOperationRecordSchema.parse({
      gitOperationId: id, runId: run.runId, operationType, requestedBy: "SUPERVISOR", idempotencyKey,
      expectedBaseCommitSha: run.repository.baseCommitSha, resultCommitSha: evidence.resultCommitSha,
      approvalId, evidenceBundleHash: evidence.evidenceBundleHash, status: "STARTED",
      verifiedCheckpointId: authority.checkpoint.checkpointId,
      verifiedCheckpointHash: authority.checkpoint.checkpointHash,
      remoteReference: null, startedAt, completedAt: null, errorCode: null,
    }));
    try {
      const result = await execute();
      const record = this.options.supervisor.recordGitOperation(GitOperationRecordSchema.parse({
        gitOperationId: id, runId: run.runId, operationType, requestedBy: "SUPERVISOR", idempotencyKey,
        expectedBaseCommitSha: run.repository.baseCommitSha, resultCommitSha: evidence.resultCommitSha,
        approvalId, evidenceBundleHash: evidence.evidenceBundleHash, status: "SUCCEEDED",
        verifiedCheckpointId: authority.checkpoint.checkpointId,
        verifiedCheckpointHash: authority.checkpoint.checkpointHash,
        remoteReference: result.reference, startedAt, completedAt: this.timestamp(), errorCode: null,
      }));
      return { record, value: result.value };
    } catch (error) {
      if (operationType !== "INSPECT_BASE" && operationType !== "REBASE_CANDIDATE") {
        return this.reconcileUncertainOperation(authority, run, started, evidence, "EXECUTION_RESULT_UNKNOWN");
      }
      this.options.supervisor.recordGitOperation(GitOperationRecordSchema.parse({
        gitOperationId: id, runId: run.runId, operationType, requestedBy: "SUPERVISOR", idempotencyKey,
        expectedBaseCommitSha: run.repository.baseCommitSha, resultCommitSha: evidence.resultCommitSha,
        approvalId, evidenceBundleHash: evidence.evidenceBundleHash, status: "FAILED",
        verifiedCheckpointId: authority.checkpoint.checkpointId,
        verifiedCheckpointHash: authority.checkpoint.checkpointHash,
        remoteReference: null, startedAt, completedAt: this.timestamp(), errorCode: "GIT_SERVICE_ERROR",
      }));
      throw error;
    }
  }

  private assertNoLegacyPublicationOperations(runId: string): void {
    const operations = this.options.supervisor.listGitOperations(runId);
    const legacy = operations.find((operation) =>
      ["CREATE_BRANCH", "PUSH_COMMIT", "CREATE_PR"].includes(operation.operationType) &&
      (!operation.verifiedCheckpointId || !operation.verifiedCheckpointHash));
    if (legacy) {
      throw new Error("legacy Git operation cannot resume, reconcile, or mutate publication");
    }
  }

  private assertOperationReplay(
    authority: PublicationAuthority,
    operation: GitOperationRecord,
    expectedType: GitOperationRecord["operationType"],
    approvalId: string | null,
  ): void {
    if (!operation.verifiedCheckpointId || !operation.verifiedCheckpointHash) {
      throw new Error("legacy Git operation cannot resume, reconcile, or mutate publication");
    }
    if (operation.operationType !== expectedType ||
        operation.expectedBaseCommitSha !== authority.checkpoint.baseCommitSha ||
        operation.resultCommitSha !== authority.checkpoint.resultCommitSha ||
        operation.approvalId !== approvalId ||
        operation.evidenceBundleHash !== authority.checkpoint.evidenceBundleHash ||
        operation.verifiedCheckpointId !== authority.checkpoint.checkpointId ||
        operation.verifiedCheckpointHash !== authority.checkpoint.checkpointHash) {
      throw new Error("publication operation replay does not match current classified authority");
    }
  }

  private async reconcileExpiredOperation(
    authority: PublicationAuthority,
    run: EngineerRun,
    operation: GitOperationRecord,
    evidence: ReturnType<EngineerSupervisor["getPublicationEvidence"]>,
  ): Promise<{ record: GitOperationRecord; value: unknown }> {
    const ageMs = new Date(this.timestamp()).getTime() - new Date(operation.startedAt).getTime();
    const leaseMs = this.options.operationLeaseMs ?? 2 * 60_000;
    if (!Number.isFinite(ageMs) || ageMs < leaseMs) throw new PublicationOperationInProgressError(run.runId);

    return this.reconcileUncertainOperation(authority, run, operation, evidence, "LEASE_EXPIRED", leaseMs);
  }

  private async reconcileUncertainOperation(
    authority: PublicationAuthority,
    run: EngineerRun,
    operation: GitOperationRecord,
    evidence: ReturnType<EngineerSupervisor["getPublicationEvidence"]>,
    recoveryReason: "LEASE_EXPIRED" | "EXECUTION_RESULT_UNKNOWN",
    leaseMs = this.options.operationLeaseMs ?? 2 * 60_000,
  ): Promise<{ record: GitOperationRecord; value: unknown }> {

    let reconciliation: Awaited<ReturnType<NonNullable<typeof this.options.gitService.reconcilePublicationOperation>>>;
    if (operation.operationType === "INSPECT_BASE" || operation.operationType === "REBASE_CANDIDATE") {
      reconciliation = { status: "INDETERMINATE", detail: "operation does not have a remote publication reconciliation contract" };
    } else if (!this.options.gitService.reconcilePublicationOperation) {
      reconciliation = { status: "INDETERMINATE", detail: "Git provider does not support credentialed publication reconciliation" };
    } else {
      await this.revalidatePublicationAuthority(authority, ["PR_CREATING"]);
      try {
        reconciliation = await this.options.gitService.reconcilePublicationOperation({
          runId: run.runId,
          repository: run.repository,
          operationType: operation.operationType,
          resultCommitSha: evidence.resultCommitSha,
          baseBranch: run.repository.baseBranch,
          idempotencyKey: operation.idempotencyKey,
        });
      } catch {
        reconciliation = { status: "INDETERMINATE", detail: "credentialed reconciliation failed without a trustworthy remote result" };
      }
    }
    if (reconciliation.status === "SUCCEEDED" && reconciliation.remoteReference.trim()) {
      const record = this.options.supervisor.recordGitOperation(GitOperationRecordSchema.parse({
        ...operation,
        status: "SUCCEEDED",
        remoteReference: reconciliation.remoteReference,
        completedAt: this.timestamp(),
        errorCode: null,
      }));
      return { record, value: this.recoveredOperationValue(operation.operationType, reconciliation.remoteReference) };
    }
    if (reconciliation.status === "SUCCEEDED") {
      reconciliation = { status: "INDETERMINATE", detail: "credentialed reconciliation returned an empty remote reference" };
    }

    const stale = this.options.supervisor.recordGitOperation(GitOperationRecordSchema.parse({
      ...operation,
      status: "STALE",
      remoteReference: null,
      completedAt: this.timestamp(),
      errorCode: `RECONCILIATION_${reconciliation.status}`,
    }));
    const recovery = this.options.supervisor.recordArtifact(this.options.artifactStore.put({
      runId: run.runId,
      type: "PUBLICATION_RECOVERY_EVIDENCE",
      bytes: JSON.stringify({
        gitOperationId: operation.gitOperationId,
        operationType: operation.operationType,
        idempotencyKey: operation.idempotencyKey,
        startedAt: operation.startedAt,
        claimExpiresAt: new Date(new Date(operation.startedAt).getTime() + leaseMs).toISOString(),
        reconciledAt: this.timestamp(),
        recoveryReason,
        result: reconciliation.status,
        detail: reconciliation.detail,
        action: "No remote mutation was retried. Human reconciliation is required.",
      }),
      producerType: "SYSTEM",
      producerId: "engineer-supervisor",
      trusted: true,
    }));
    this.recordFailure(run.runId, "GIT_FAILURE", "PUBLICATION_OPERATION_RECOVERY_REQUIRED",
      new Error(reconciliation.detail), false, [stale.gitOperationId, recovery.artifactId]);
    const current = this.options.supervisor.getRun(run.runId);
    if (current.state !== "HUMAN_REVIEW_REQUIRED") {
      this.transition(run.runId, "HUMAN_REVIEW_REQUIRED", "PUBLICATION_OPERATION_RECOVERY_REQUIRED", [stale.gitOperationId, recovery.artifactId]);
    }
    throw new PublicationOperationRecoveryRequiredError(run.runId, operation.operationType);
  }

  private recoveredOperationValue(operationType: GitOperationRecord["operationType"], remoteReference: string): unknown {
    if (operationType === "CREATE_BRANCH") {
      return { branchName: remoteReference.replace(/^refs\/heads\//, ""), remoteReference };
    }
    if (operationType === "PUSH_COMMIT") return { remoteReference };
    return { id: "reconciled", number: 0, url: remoteReference, remoteReference };
  }

  private prBody(run: EngineerRun, evidenceBundleHash: string): string {
    const manifest = this.options.supervisor.getManifest(run.runId);
    const claims = this.options.supervisor.listClaimEvidence(run.runId);
    const changed = [...this.options.diffForRun(run.runId).matchAll(/^\+\+\+ b\/(.+)$/gm)].map((match) => match[1]);
    return [
      "## Zintus Engineer verified change",
      "", run.requestNormalized || run.requestOriginal, "",
      `Risk tier: ${run.riskTier}`, `Evidence bundle: ${evidenceBundleHash}`, "",
      "### Acceptance criteria", ...(manifest?.acceptanceCriteria.map((item) => `- ${item.statement}`) ?? []), "",
      "### Changed files", ...changed.map((file) => `- ${file}`), "",
      "### Evidence-backed claims", ...claims.map((claim) => `- [${claim.status}] ${claim.claim}`),
      "", "Generated from trusted Zintus system records; Builder narrative was not used.",
    ].join("\n");
  }

  private sign(command: unknown): string {
    return `hmac-sha256:${createHmac("sha256", this.options.commandSigningSecret).update(JSON.stringify(command)).digest("hex")}`;
  }

  private verifySignature(input: { command: unknown; signature: string }): boolean {
    const expected = this.sign(input.command);
    return expected.length === input.signature.length && timingSafeEqual(Buffer.from(expected), Buffer.from(input.signature));
  }

  private recordFailure(runId: string, failureClass: FailureRecord["failureClass"], reasonCode: string, error: unknown, retryable: boolean, evidenceIds: string[] = []): void {
    const message = error instanceof Error ? error.message : String(error);
    this.options.supervisor.recordFailure(FailureRecordSchema.parse({
      failureId: this.id(), runId, failureClass, reasonCode,
      fingerprint: sha256({ failureClass, reasonCode, message }), evidenceIds, retryable, createdAt: this.timestamp(),
    }));
  }

  private transition(
    runId: string, nextState: Parameters<EngineerSupervisor["transition"]>[0]["nextState"], reasonCode: string,
    evidenceIds: string[] = [], actorType: "SUPERVISOR" | "HUMAN" = "SUPERVISOR", actorId = "engineer-supervisor",
    facts?: Parameters<EngineerSupervisor["transition"]>[0]["facts"],
  ): void {
    const run = this.options.supervisor.getRun(runId);
    this.options.supervisor.transition({ runId, expectedStateVersion: run.stateVersion, nextState, reasonCode,
      actorType, actorId, evidenceIds, manifestHash: run.manifestHash,
      idempotencyKey: `phase4:${nextState.toLowerCase()}:${run.stateVersion + 1}`, ...(facts ? { facts } : {}) });
  }

  private id(): string { return (this.options.idFactory ?? randomUUID)(); }
  private timestamp(): string { return (this.options.now ?? (() => new Date()))().toISOString(); }
}
