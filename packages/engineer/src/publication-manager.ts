import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { LocalArtifactStore } from "./artifact-store.js";
import {
  ApprovalDecisionRecordSchema,
  ApprovalRequestRecordSchema,
  FailureRecordSchema,
  GitOperationRecordSchema,
  hasUnreconciledRemotePublication,
  SignedSupervisorPrCommandSchema,
  type FailureRecord,
  type ApprovalRequestRecord,
  type GitOperationRecord,
} from "./control-contracts.js";
import { SupervisorPrCommandSchema, type EngineerRun } from "./contracts.js";
import type { GitService, PullRequestResult } from "./git-service.js";
import { sha256 } from "./hash.js";
import type { EngineerSupervisor } from "./supervisor.js";
import { operationalFailurePolicy } from "./failure-policy.js";
import { isCancellationAllowed } from "./state-machine.js";

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
  autoPublishLowRisk?: boolean;
  now?: () => Date;
  idFactory?: () => string;
  cleanupRun?: (runId: string) => void | Promise<void>;
  /** Time after which a durable STARTED claim must be reconciled instead of treated as live. */
  operationLeaseMs?: number;
}

export type PublicationStartResult =
  | { status: "AWAITING_APPROVAL"; approval: ApprovalRequestRecord }
  | { status: "PUBLISHED"; pullRequest: PullRequestResult }
  | { status: "BASE_STALE"; currentBaseCommitSha: string };

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

  async start(runId: string, assignedReviewerId: string): Promise<PublicationStartResult> {
    if (!assignedReviewerId.trim()) throw new Error("an authenticated assigned reviewer is required for publication");
    const run = this.options.supervisor.getRun(runId);
    if (run.state !== "REVIEW_APPROVED") throw new Error(`publication requires REVIEW_APPROVED, not ${run.state}`);
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
    const approval = this.options.supervisor.recordApprovalRequest(ApprovalRequestRecordSchema.parse({
      approvalRequestId: this.id(), runId, riskTier: run.riskTier, assignedReviewerId,
      requestedAt, deadlineAt,
      reminderSchedule: [0.5, 0.8].map((ratio) => new Date(new Date(requestedAt).getTime() + deadlineMs * ratio).toISOString()),
      timeoutAction: run.riskTier === "HIGH" ? "HUMAN_REVIEW_REQUIRED" : "HUMAN_REVIEW_REQUIRED",
      manifestHash: run.manifestHash, diffHash: evidence.reviewerDiffHash,
      evidenceBundleHash: evidence.evidenceBundleHash, status: "PENDING",
    }));
    this.transition(runId, "HUMAN_APPROVAL_PENDING", "HUMAN_APPROVAL_REQUESTED", [approval.approvalRequestId]);
    return { status: "AWAITING_APPROVAL", approval };
  }

  async approve(runId: string, actorId: string, reason: string): Promise<PublicationStartResult> {
    const request = this.requirePendingApproval(runId);
    this.assertDecisionActor(request, actorId);
    this.assertBeforeDeadline(request);
    this.assertApprovalBinding(request);
    const decision = this.options.supervisor.decideApproval(ApprovalDecisionRecordSchema.parse({
      approvalDecisionId: this.id(), approvalRequestId: request.approvalRequestId,
      actorId, decision: "APPROVE", reason, decidedAt: this.timestamp(),
    }), "APPROVED");
    this.transition(runId, "HUMAN_APPROVED", "HUMAN_APPROVAL_VALIDATED", [decision.approvalDecisionId], "HUMAN", actorId, { humanApprovalValid: true });
    return this.publish(runId);
  }

  /** Replays an interrupted publication idempotently; successful PR creation is never duplicated. */
  resume(runId: string): Promise<PublicationStartResult> {
    return this.publish(runId);
  }

  /** Recovers only durable publication states; failures remain visible and retryable. */
  async recoverPending(): Promise<{ resumedRunIds: string[]; failedRunIds: string[] }> {
    const states: EngineerRun["state"][] = ["HUMAN_APPROVED", "PR_PREFLIGHT", "PR_CREATING", "PR_CREATED", "PR_CREATION_FAILED"];
    const resumedRunIds: string[] = [];
    const failedRunIds: string[] = [];
    for (const run of this.options.supervisor.listRuns(states)) {
      try {
        await this.resume(run.runId);
        resumedRunIds.push(run.runId);
      } catch {
        failedRunIds.push(run.runId);
      }
    }
    return { resumedRunIds, failedRunIds };
  }

  requestChanges(runId: string, actorId: string, reason: string): void {
    const request = this.requirePendingApproval(runId);
    this.assertDecisionActor(request, actorId);
    const decision = this.options.supervisor.decideApproval(ApprovalDecisionRecordSchema.parse({
      approvalDecisionId: this.id(), approvalRequestId: request.approvalRequestId,
      actorId, decision: "REQUEST_CHANGES", reason, decidedAt: this.timestamp(),
    }), "CHANGES_REQUESTED");
    this.transition(runId, "FIX_REQUESTED", "HUMAN_REQUESTED_CHANGES", [decision.approvalDecisionId], "HUMAN", actorId);
  }

  reject(runId: string, actorId: string, reason: string): void {
    const request = this.requirePendingApproval(runId);
    this.assertDecisionActor(request, actorId);
    const decision = this.options.supervisor.decideApproval(ApprovalDecisionRecordSchema.parse({
      approvalDecisionId: this.id(), approvalRequestId: request.approvalRequestId,
      actorId, decision: "REJECT", reason, decidedAt: this.timestamp(),
    }), "REJECTED");
    this.transition(runId, "REJECTED", "HUMAN_REJECTED", [decision.approvalDecisionId], "HUMAN", actorId);
  }

  extend(runId: string, actorId: string, reason: string, extensionSeconds: number): ApprovalRequestRecord {
    if (!Number.isInteger(extensionSeconds) || extensionSeconds < 60 || extensionSeconds > 7 * 24 * 60 * 60) {
      throw new Error("approval extension must be between 60 seconds and 7 days");
    }
    const request = this.requirePendingApproval(runId);
    this.assertDecisionActor(request, actorId);
    const deadlineAt = new Date(new Date(request.deadlineAt).getTime() + extensionSeconds * 1_000).toISOString();
    return this.options.supervisor.extendApproval(ApprovalDecisionRecordSchema.parse({
      approvalDecisionId: this.id(), approvalRequestId: request.approvalRequestId,
      actorId, decision: "EXTEND", reason, decidedAt: this.timestamp(),
    }), deadlineAt, [new Date(new Date(request.deadlineAt).getTime() + extensionSeconds * 500).toISOString()]);
  }

  expire(runId: string): void {
    const request = this.requirePendingApproval(runId);
    if (new Date(this.timestamp()).getTime() <= new Date(request.deadlineAt).getTime()) throw new Error("approval deadline has not expired");
    this.options.supervisor.decideApproval(ApprovalDecisionRecordSchema.parse({
      approvalDecisionId: this.id(), approvalRequestId: request.approvalRequestId,
      actorId: "engineer-supervisor", decision: "REJECT", reason: "Approval deadline expired.", decidedAt: this.timestamp(),
    }), "EXPIRED");
    const policy = operationalFailurePolicy("TIMEOUT");
    this.recordFailure(runId, policy.failureClass, policy.reasonCode, new Error("human approval deadline expired"), policy.retryable, [request.approvalRequestId]);
    this.transition(runId, "HUMAN_REVIEW_REQUIRED", "HUMAN_APPROVAL_TIMEOUT", [request.approvalRequestId]);
  }

  sweepExpired(): string[] {
    const expired: string[] = [];
    for (const run of this.options.supervisor.listRuns(["HUMAN_APPROVAL_PENDING"])) {
      const request = this.options.supervisor.latestApprovalRequest(run.runId);
      if (request && request.status === "PENDING" && new Date(this.timestamp()).getTime() > new Date(request.deadlineAt).getTime()) {
        this.expire(run.runId);
        expired.push(run.runId);
      }
    }
    return expired;
  }

  async cancel(runId: string, actorId: string, reason: string): Promise<void> {
    const run = this.options.supervisor.getRun(runId);
    if (actorId !== run.userId) throw new Error("cancellation actor does not own this run");
    if (run.terminalAt) throw new Error(`terminal run ${run.state} cannot be cancelled`);
    if (!isCancellationAllowed(run.state)) {
      throw new Error(`cancellation is fenced while publication state is ${run.state}; remote cleanup is not safely available`);
    }
    if (hasUnreconciledRemotePublication(this.options.supervisor.listGitOperations(runId))) {
      throw new Error("cancellation is fenced because remote publication was attempted and no durable remote cleanup is available");
    }
    const artifact = this.options.supervisor.recordArtifact(this.options.artifactStore.put({
      runId, type: "CANCELLATION_REQUEST", bytes: JSON.stringify({ actorId, reason, requestedAt: this.timestamp() }),
      producerType: "SYSTEM", producerId: "engineer-supervisor", trusted: true,
    }));
    this.transition(runId, "CANCELLATION_PENDING", "USER_CANCELLATION_REQUESTED", [artifact.artifactId], "HUMAN", actorId);
    try {
      await this.options.cleanupRun?.(runId);
      this.transition(runId, "CANCELLED", "RUN_CLEANUP_COMPLETE");
    } catch (error) {
      this.recordFailure(runId, "WORKFLOW_FAILURE", "CANCELLATION_CLEANUP_FAILED", error, false);
      this.transition(runId, "FAILED", "CANCELLATION_CLEANUP_FAILED");
      throw error;
    }
  }

  authorizeStaleReverification(runId: string): void {
    const run = this.options.supervisor.getRun(runId);
    if (run.state !== "BASE_BRANCH_STALE") throw new Error("stale-base re-verification requires BASE_BRANCH_STALE");
    this.transition(runId, "REVERIFYING", "STALE_BASE_REVERIFICATION_REQUIRED");
  }

  /** Discovers and locally synchronizes a new base for a clean replacement run. */
  async replacementRepositoryForStale(runId: string): Promise<EngineerRun["repository"]> {
    const run = this.options.supervisor.getRun(runId);
    if (run.state !== "BASE_BRANCH_STALE") throw new Error("stale-base recovery requires BASE_BRANCH_STALE");
    const status = await this.options.gitService.inspectBaseBranch({
      repository: run.repository,
      expectedBaseCommitSha: run.repository.baseCommitSha,
    });
    if (status.matchesExpected) throw new Error("stale-base recovery is unnecessary because the base matches again");
    if (!this.options.gitService.synchronizeBaseBranch) {
      throw new Error("Git service cannot synchronize the inspected replacement base");
    }
    await this.options.gitService.synchronizeBaseBranch({ repository: run.repository, expectedCommitSha: status.currentCommitSha });
    return { ...run.repository, baseCommitSha: status.currentCommitSha };
  }

  private async publish(runId: string): Promise<PublicationStartResult> {
    if (this.activePublicationRuns.has(runId)) throw new PublicationOperationInProgressError(runId);
    this.activePublicationRuns.add(runId);
    try {
      return await this.publishFenced(runId);
    } finally {
      this.activePublicationRuns.delete(runId);
    }
  }

  private async publishFenced(runId: string): Promise<PublicationStartResult> {
    const supervisor = this.options.supervisor;
    let run = supervisor.getRun(runId);
    const evidence = this.currentEvidence(runId);
    const approval = run.humanGateRequired ? this.requireApprovedBinding(runId, evidence.evidenceBundleHash) : null;
    const prIdempotencyKey = `pr:create:${runId}:${evidence.resultCommitSha}`;
    const replay = supervisor.findGitOperation(runId, prIdempotencyKey);
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
    const inspect = await this.operation(run, "INSPECT_BASE", `git:inspect:${runId}:${run.repository.baseCommitSha}:${this.id()}`, evidence, approval?.approvalRequestId ?? null,
      async () => {
        const status = await this.options.gitService.inspectBaseBranch({ repository: run.repository, expectedBaseCommitSha: run.repository.baseCommitSha });
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
      runId, repositoryId: run.repository.repositoryId, baseBranch: run.repository.baseBranch,
      expectedBaseCommitSha: run.repository.baseCommitSha, resultCommitSha: evidence.resultCommitSha,
      manifestHash: run.manifestHash, evidenceBundleHash: evidence.evidenceBundleHash,
      reviewDecisionId: evidence.reviewerSessionId, humanApprovalId: approval?.approvalRequestId ?? null,
      riskTier: run.riskTier, idempotencyKey: prIdempotencyKey,
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
      const branch = await this.operation(run, "CREATE_BRANCH", `git:branch:${runId}:${evidence.resultCommitSha}`, evidence, approval?.approvalRequestId ?? null,
        async () => {
          const value = await this.options.gitService.createRunBranch({ runId, repository: run.repository, resultCommitSha: evidence.resultCommitSha });
          return { reference: value.remoteReference, value };
        });
      const branchValue = branch.value as { branchName: string; remoteReference: string };
      await this.operation(run, "PUSH_COMMIT", `git:push:${runId}:${evidence.resultCommitSha}`, evidence, approval?.approvalRequestId ?? null,
        async () => {
          const value = await this.options.gitService.pushVerifiedCommit({ runId, repository: run.repository, resultCommitSha: evidence.resultCommitSha, branchName: branchValue.branchName });
          return { reference: value.remoteReference, value };
        });
      if (replay?.status === "SUCCEEDED" && replay.remoteReference) {
        this.transition(runId, "PR_CREATED", "PULL_REQUEST_RECOVERED", [replay.gitOperationId]);
        this.transition(runId, "COMPLETED", "ENGINEER_RUN_COMPLETED", [replay.gitOperationId, evidence.evidenceBundleId]);
        await this.options.cleanupRun?.(runId);
        return { status: "PUBLISHED", pullRequest: { id: replay.gitOperationId, number: 0, url: replay.remoteReference } };
      }
      const body = this.prBody(run, evidence.evidenceBundleHash);
      const created = await this.operation(run, "CREATE_PR", prIdempotencyKey, evidence, approval?.approvalRequestId ?? null,
        async () => {
          const value = await this.options.gitService.createPullRequest({ runId, repository: run.repository, branchName: branchValue.branchName,
            baseBranch: run.repository.baseBranch, title: run.requestNormalized || run.requestOriginal, body, idempotencyKey: prIdempotencyKey });
          return { reference: value.url, value };
        });
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
    const diff = this.options.diffForRun(runId);
    if (sha256(diff) !== evidence.reviewerDiffHash) throw new Error("current diff no longer matches the isolated Reviewer decision");
    if (!evidence.allRequiredChecksPassed || evidence.openCriticalSecurityFindings > 0) throw new Error("publication evidence gates are not satisfied");
    return evidence;
  }

  private requirePendingApproval(runId: string): ApprovalRequestRecord {
    const run = this.options.supervisor.getRun(runId);
    if (run.state !== "HUMAN_APPROVAL_PENDING") throw new Error(`human decision requires HUMAN_APPROVAL_PENDING, not ${run.state}`);
    const request = this.options.supervisor.latestApprovalRequest(runId);
    if (!request || request.status !== "PENDING") throw new Error("pending approval request is unavailable");
    return request;
  }

  private requireApprovedBinding(runId: string, evidenceBundleHash: string): ApprovalRequestRecord {
    const request = this.options.supervisor.latestApprovalRequest(runId);
    if (!request || request.status !== "APPROVED" || request.evidenceBundleHash !== evidenceBundleHash) {
      throw new Error("exact hash-bound human approval is unavailable");
    }
    return request;
  }

  private assertDecisionActor(request: ApprovalRequestRecord, actorId: string): void {
    if (request.assignedReviewerId && request.assignedReviewerId !== actorId) {
      throw new Error("human decision actor is not the assigned reviewer");
    }
  }

  private assertApprovalBinding(request: ApprovalRequestRecord): void {
    const run = this.options.supervisor.getRun(request.runId);
    const evidence = this.currentEvidence(request.runId);
    if (run.manifestHash !== request.manifestHash || evidence.reviewerDiffHash !== request.diffHash || evidence.evidenceBundleHash !== request.evidenceBundleHash) {
      throw new Error("approval request no longer matches current manifest, diff, or evidence");
    }
  }

  private assertBeforeDeadline(request: ApprovalRequestRecord): void {
    if (new Date(this.timestamp()).getTime() > new Date(request.deadlineAt).getTime()) throw new Error("approval request has expired");
  }

  private async operation(
    run: EngineerRun, operationType: GitOperationRecord["operationType"], idempotencyKey: string,
    evidence: ReturnType<EngineerSupervisor["getPublicationEvidence"]>, approvalId: string | null,
    execute: () => Promise<{ reference: string; value: unknown }>,
  ): Promise<{ record: GitOperationRecord; value: unknown }> {
    const existing = this.options.supervisor.findGitOperation(run.runId, idempotencyKey);
    if (existing?.status === "STARTED") {
      return this.reconcileExpiredOperation(run, existing, evidence);
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
    const id = existing?.gitOperationId ?? this.id();
    const startedAt = existing?.startedAt ?? this.timestamp();
    const started = this.options.supervisor.recordGitOperation(GitOperationRecordSchema.parse({
      gitOperationId: id, runId: run.runId, operationType, requestedBy: "SUPERVISOR", idempotencyKey,
      expectedBaseCommitSha: run.repository.baseCommitSha, resultCommitSha: evidence.resultCommitSha,
      approvalId, evidenceBundleHash: evidence.evidenceBundleHash, status: "STARTED",
      remoteReference: null, startedAt, completedAt: null, errorCode: null,
    }));
    try {
      const result = await execute();
      const record = this.options.supervisor.recordGitOperation(GitOperationRecordSchema.parse({
        gitOperationId: id, runId: run.runId, operationType, requestedBy: "SUPERVISOR", idempotencyKey,
        expectedBaseCommitSha: run.repository.baseCommitSha, resultCommitSha: evidence.resultCommitSha,
        approvalId, evidenceBundleHash: evidence.evidenceBundleHash, status: "SUCCEEDED",
        remoteReference: result.reference, startedAt, completedAt: this.timestamp(), errorCode: null,
      }));
      return { record, value: result.value };
    } catch (error) {
      if (operationType !== "INSPECT_BASE" && operationType !== "REBASE_CANDIDATE") {
        return this.reconcileUncertainOperation(run, started, evidence, "EXECUTION_RESULT_UNKNOWN");
      }
      this.options.supervisor.recordGitOperation(GitOperationRecordSchema.parse({
        gitOperationId: id, runId: run.runId, operationType, requestedBy: "SUPERVISOR", idempotencyKey,
        expectedBaseCommitSha: run.repository.baseCommitSha, resultCommitSha: evidence.resultCommitSha,
        approvalId, evidenceBundleHash: evidence.evidenceBundleHash, status: "FAILED",
        remoteReference: null, startedAt, completedAt: this.timestamp(), errorCode: "GIT_SERVICE_ERROR",
      }));
      throw error;
    }
  }

  private async reconcileExpiredOperation(
    run: EngineerRun,
    operation: GitOperationRecord,
    evidence: ReturnType<EngineerSupervisor["getPublicationEvidence"]>,
  ): Promise<{ record: GitOperationRecord; value: unknown }> {
    const ageMs = new Date(this.timestamp()).getTime() - new Date(operation.startedAt).getTime();
    const leaseMs = this.options.operationLeaseMs ?? 2 * 60_000;
    if (!Number.isFinite(ageMs) || ageMs < leaseMs) throw new PublicationOperationInProgressError(run.runId);

    return this.reconcileUncertainOperation(run, operation, evidence, "LEASE_EXPIRED", leaseMs);
  }

  private async reconcileUncertainOperation(
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
