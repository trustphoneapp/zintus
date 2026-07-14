import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { LocalArtifactStore } from "./artifact-store.js";
import {
  ApprovalDecisionRecordSchema,
  ApprovalRequestRecordSchema,
  FailureRecordSchema,
  GitOperationRecordSchema,
  SignedSupervisorPrCommandSchema,
  type ApprovalRequestRecord,
  type GitOperationRecord,
} from "./control-contracts.js";
import { SupervisorPrCommandSchema, type EngineerRun } from "./contracts.js";
import type { GitService, PullRequestResult } from "./git-service.js";
import { sha256 } from "./hash.js";
import type { EngineerSupervisor } from "./supervisor.js";

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
}

export type PublicationStartResult =
  | { status: "AWAITING_APPROVAL"; approval: ApprovalRequestRecord }
  | { status: "PUBLISHED"; pullRequest: PullRequestResult }
  | { status: "BASE_STALE"; currentBaseCommitSha: string };

/** Phase-4 authority for human decisions and credentialed publication. */
export class EngineerPublicationManager {
  private readonly options: EngineerPublicationManagerOptions;
  constructor(options: EngineerPublicationManagerOptions) {
    if (options.commandSigningSecret.length < 32) throw new Error("publication command signing secret must be at least 32 characters");
    this.options = options;
  }

  async start(runId: string, assignedReviewerId: string | null = null): Promise<PublicationStartResult> {
    const run = this.options.supervisor.getRun(runId);
    if (run.state !== "REVIEW_APPROVED") throw new Error(`publication requires REVIEW_APPROVED, not ${run.state}`);
    if (run.riskTier === "CRITICAL") {
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

  requestChanges(runId: string, actorId: string, reason: string): void {
    const request = this.requirePendingApproval(runId);
    const decision = this.options.supervisor.decideApproval(ApprovalDecisionRecordSchema.parse({
      approvalDecisionId: this.id(), approvalRequestId: request.approvalRequestId,
      actorId, decision: "REQUEST_CHANGES", reason, decidedAt: this.timestamp(),
    }), "CHANGES_REQUESTED");
    this.transition(runId, "FIX_REQUESTED", "HUMAN_REQUESTED_CHANGES", [decision.approvalDecisionId], "HUMAN", actorId);
  }

  reject(runId: string, actorId: string, reason: string): void {
    const request = this.requirePendingApproval(runId);
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
    if (run.terminalAt) throw new Error(`terminal run ${run.state} cannot be cancelled`);
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

  private async publish(runId: string): Promise<PublicationStartResult> {
    const supervisor = this.options.supervisor;
    const run = supervisor.getRun(runId);
    const evidence = this.currentEvidence(runId);
    const approval = run.state === "HUMAN_APPROVED" ? this.requireApprovedBinding(runId, evidence.evidenceBundleHash) : null;
    const prIdempotencyKey = `pr:create:${runId}:${evidence.resultCommitSha}`;
    const replay = supervisor.findGitOperation(runId, prIdempotencyKey);
    if (replay?.status === "SUCCEEDED" && replay.remoteReference) {
      return { status: "PUBLISHED", pullRequest: { id: replay.gitOperationId, number: 0, url: replay.remoteReference } };
    }
    const inspect = await this.operation(run, "INSPECT_BASE", `git:inspect:${runId}:${run.repository.baseCommitSha}`, evidence, approval?.approvalRequestId ?? null,
      async () => {
        const status = await this.options.gitService.inspectBaseBranch({ repository: run.repository, expectedBaseCommitSha: run.repository.baseCommitSha });
        return { reference: status.currentCommitSha, value: status };
      });
    const base = inspect.value as { currentCommitSha: string; matchesExpected: boolean };
    if (!base.matchesExpected) {
      this.transition(runId, "BASE_BRANCH_STALE", "BASE_BRANCH_CHANGED", [inspect.record.gitOperationId]);
      this.recordFailure(runId, "GIT_FAILURE", "BASE_BRANCH_CHANGED", new Error(base.currentCommitSha), true, [inspect.record.gitOperationId]);
      return { status: "BASE_STALE", currentBaseCommitSha: base.currentCommitSha };
    }
    this.transition(runId, "PR_PREFLIGHT", "PUBLICATION_PREFLIGHT_PASSED", [evidence.evidenceBundleId, inspect.record.gitOperationId], "SUPERVISOR", "engineer-supervisor", {
      reviewerDecisionValid: true, allRequiredChecksPassed: evidence.allRequiredChecksPassed,
      noCriticalSecurityFindings: evidence.openCriticalSecurityFindings === 0,
      evidenceBundleComplete: true, baseBranchCurrent: true,
      ...(approval ? { humanApprovalValid: true } : {}),
    });
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
    this.transition(runId, "PR_CREATING", "SUPERVISOR_PR_COMMAND_AUTHORIZED", [commandArtifact.artifactId]);
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
    if (existing?.status === "SUCCEEDED" && existing.remoteReference) {
      const value = operationType === "CREATE_BRANCH"
        ? { branchName: existing.remoteReference.replace(/^refs\/heads\//, ""), remoteReference: existing.remoteReference }
        : operationType === "INSPECT_BASE"
          ? { currentCommitSha: existing.remoteReference, matchesExpected: existing.remoteReference.toLowerCase() === run.repository.baseCommitSha.toLowerCase() }
          : { url: existing.remoteReference, remoteReference: existing.remoteReference };
      return { record: existing, value };
    }
    const id = existing?.gitOperationId ?? this.id();
    const startedAt = existing?.startedAt ?? this.timestamp();
    this.options.supervisor.recordGitOperation(GitOperationRecordSchema.parse({
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
      this.options.supervisor.recordGitOperation(GitOperationRecordSchema.parse({
        gitOperationId: id, runId: run.runId, operationType, requestedBy: "SUPERVISOR", idempotencyKey,
        expectedBaseCommitSha: run.repository.baseCommitSha, resultCommitSha: evidence.resultCommitSha,
        approvalId, evidenceBundleHash: evidence.evidenceBundleHash, status: "FAILED",
        remoteReference: null, startedAt, completedAt: this.timestamp(), errorCode: "GIT_SERVICE_ERROR",
      }));
      throw error;
    }
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

  private recordFailure(runId: string, failureClass: "GIT_FAILURE" | "WORKFLOW_FAILURE", reasonCode: string, error: unknown, retryable: boolean, evidenceIds: string[] = []): void {
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
