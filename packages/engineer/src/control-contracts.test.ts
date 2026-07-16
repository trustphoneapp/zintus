import { describe, expect, test } from "bun:test";
import {
  canTransitionGitOperationStatus,
  hasUnreconciledRemotePublication,
  type GitOperationRecord,
} from "./control-contracts.js";

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
});
