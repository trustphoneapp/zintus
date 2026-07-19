import { describe, expect, test } from "bun:test";
import {
  ApprovalDecisionReadRecordSchema,
  ApprovalDecisionRecordSchema,
  ApprovalRequestReadRecordSchema,
  ApprovalRequestRecordSchema,
  GitOperationReadRecordSchema,
  GitOperationRecordSchema,
  canTransitionGitOperationStatus,
  hasUnreconciledRemotePublication,
  type GitOperationRecord,
} from "./control-contracts.js";
import { LegacySupervisorPrCommandSchema, SupervisorPrCommandSchema } from "./contracts.js";

describe("publication control contracts", () => {
  test("treats STARTED as an exclusive operation claim and terminal success as monotonic", () => {
    expect(canTransitionGitOperationStatus("STARTED", "STARTED")).toBe(false);
    expect(canTransitionGitOperationStatus("STARTED", "SUCCEEDED")).toBe(true);
    expect(canTransitionGitOperationStatus("SUCCEEDED", "STARTED")).toBe(false);
    expect(canTransitionGitOperationStatus("FAILED", "STARTED")).toBe(true);
    expect(canTransitionGitOperationStatus("STALE", "STARTED")).toBe(false);
  });

  test("keeps cancellation fenced after any remote mutation attempt", () => {
    const operation = (operationType: GitOperationRecord["operationType"]): GitOperationRecord => ({
      gitOperationId: `operation-${operationType}`, runId: "run-1", operationType,
      requestedBy: "SUPERVISOR", idempotencyKey: `git:${operationType}`,
      expectedBaseCommitSha: "a".repeat(40), resultCommitSha: "b".repeat(40),
      approvalId: null, evidenceBundleHash: `sha256:${"c".repeat(64)}`,
      status: "FAILED", remoteReference: null, startedAt: "2026-07-15T12:00:00.000Z",
      completedAt: "2026-07-15T12:00:01.000Z", errorCode: "GIT_SERVICE_ERROR",
    });
    expect(hasUnreconciledRemotePublication([operation("INSPECT_BASE")])).toBe(false);
    for (const type of ["CREATE_BRANCH", "PUSH_COMMIT", "CREATE_PR"] as const) {
      expect(hasUnreconciledRemotePublication([operation(type)])).toBe(true);
    }
  });

  test("keeps legacy rows readable while every new publication authority requires an exact checkpoint pair", () => {
    const approval = {
      approvalRequestId: "approval-1", runId: "run-1", riskTier: "LOW" as const, assignedReviewerId: null,
      requestedAt: "2026-07-17T12:00:00.000Z", deadlineAt: "2026-07-18T12:00:00.000Z",
      reminderSchedule: [], timeoutAction: "PAUSE" as const, manifestHash: `sha256:${"a".repeat(64)}`,
      diffHash: `sha256:${"b".repeat(64)}`, evidenceBundleHash: `sha256:${"c".repeat(64)}`,
      status: "PENDING" as const, approvalRevision: 0,
    };
    expect(ApprovalRequestReadRecordSchema.parse(approval)).toMatchObject(approval);
    expect(() => ApprovalRequestRecordSchema.parse(approval)).toThrow("Required");
    expect(() => ApprovalRequestRecordSchema.parse({ ...approval, verifiedCheckpointId: `sha256:${"d".repeat(64)}` }))
      .toThrow("Required");
    expect(ApprovalRequestRecordSchema.parse({
      ...approval, verifiedCheckpointId: `sha256:${"d".repeat(64)}`, verifiedCheckpointHash: `sha256:${"e".repeat(64)}`,
    })).toMatchObject({ verifiedCheckpointId: `sha256:${"d".repeat(64)}`, verifiedCheckpointHash: `sha256:${"e".repeat(64)}` });

    const operation = {
      gitOperationId: "git-1", runId: "run-1", operationType: "INSPECT_BASE" as const, requestedBy: "SUPERVISOR" as const,
      idempotencyKey: "git:1", expectedBaseCommitSha: "a".repeat(40), resultCommitSha: null,
      approvalId: null, evidenceBundleHash: null, status: "STARTED" as const, remoteReference: null,
      startedAt: "2026-07-17T12:00:00.000Z", completedAt: null, errorCode: null,
    };
    expect(GitOperationReadRecordSchema.parse(operation)).toMatchObject(operation);
    expect(() => GitOperationRecordSchema.parse(operation)).toThrow("Required");
    expect(() => GitOperationRecordSchema.parse({ ...operation, verifiedCheckpointHash: `sha256:${"e".repeat(64)}` }))
      .toThrow("Required");
    expect(GitOperationRecordSchema.parse({
      ...operation, verifiedCheckpointId: `sha256:${"d".repeat(64)}`, verifiedCheckpointHash: `sha256:${"e".repeat(64)}`,
    })).toMatchObject({ verifiedCheckpointId: `sha256:${"d".repeat(64)}` });

    const decision = {
      approvalDecisionId: "decision-1", approvalRequestId: "approval-1", actorId: "human-1",
      decision: "APPROVE" as const, reason: "Reviewed exact candidate.", decidedAt: "2026-07-17T12:30:00.000Z",
    };
    expect(ApprovalDecisionReadRecordSchema.parse(decision)).toMatchObject(decision);
    expect(() => ApprovalDecisionRecordSchema.parse(decision)).toThrow("Required");
    expect(() => ApprovalDecisionRecordSchema.parse({
      ...decision, expectedVerifiedCheckpointId: `sha256:${"d".repeat(64)}`,
    })).toThrow("Required");
    expect(ApprovalDecisionRecordSchema.parse({
      ...decision, expectedVerifiedCheckpointId: `sha256:${"d".repeat(64)}`,
      expectedVerifiedCheckpointHash: `sha256:${"e".repeat(64)}`,
      expectedApprovalRevision: 0,
    })).toMatchObject({ expectedVerifiedCheckpointHash: `sha256:${"e".repeat(64)}` });

    const command = {
      runId: "run-1", repositoryId: "repo-1", baseBranch: "main", expectedBaseCommitSha: "a".repeat(40),
      resultCommitSha: "b".repeat(40), manifestHash: `sha256:${"a".repeat(64)}`,
      evidenceBundleHash: `sha256:${"c".repeat(64)}`, reviewDecisionId: "review-1",
      classificationHash: `sha256:${"f".repeat(64)}`, classificationResult: "READY" as const,
      humanApprovalId: "approval-1", riskTier: "LOW" as const,
      idempotencyKey: `pr:create:run-1:${"c".repeat(64)}:${"b".repeat(40)}`,
    };
    expect(LegacySupervisorPrCommandSchema.parse(command)).toMatchObject(command);
    expect(() => SupervisorPrCommandSchema.parse(command)).toThrow("Required");
    expect(SupervisorPrCommandSchema.parse({
      ...command, verifiedCheckpointId: `sha256:${"d".repeat(64)}`,
      verifiedCheckpointHash: `sha256:${"e".repeat(64)}`,
    })).toMatchObject({ verifiedCheckpointId: `sha256:${"d".repeat(64)}` });
  });
});
