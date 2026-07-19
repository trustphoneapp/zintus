import { describe, expect, test } from "bun:test";
import { candidateConflictAppliesToRun, candidateMatchesApproval, engineerTrustState } from "./engineer-candidate";
import type { EngineerApproval, VerifiedCandidateSummary } from "./engineer";

const candidate = {
  checkpointId: `sha256:${"a".repeat(64)}`, checkpointHash: `sha256:${"b".repeat(64)}`,
  resultCommitSha: "c".repeat(40), classificationResult: "READY", requiredTestCount: 3,
  allRequiredChecksPassed: true, openBlockingCriticalCount: 0,
  environmentDigest: `sha256:${"d".repeat(64)}`, createdAt: "2026-07-17T12:00:00.000Z",
} satisfies VerifiedCandidateSummary;
const authority = {
  expectedVerifiedCheckpointId: candidate.checkpointId,
  expectedVerifiedCheckpointHash: candidate.checkpointHash,
  expectedApprovalRevision: 1,
};
const approval = { status: "PENDING" } as EngineerApproval;

describe("Engineer candidate truth matrix", () => {
  test("requires the exact displayed checkpoint pair", () => {
    expect(candidateMatchesApproval(candidate, authority)).toBe(true);
    expect(candidateMatchesApproval(candidate, { ...authority, expectedVerifiedCheckpointHash: `sha256:${"e".repeat(64)}` })).toBe(false);
    expect(candidateMatchesApproval(null, authority)).toBe(false);
    expect(candidateMatchesApproval(candidate, null)).toBe(false);
  });

  test("never reports human approval before a durable approved decision", () => {
    expect(engineerTrustState({ runState: "HUMAN_REVIEW_REQUIRED", candidate: null, approval: null, authority: null })).toBe("UNVERIFIED");
    expect(engineerTrustState({ runState: "REVIEW_APPROVED", candidate, approval: null, authority: null })).toBe("MACHINE_VERIFIED");
    expect(engineerTrustState({ runState: "HUMAN_APPROVAL_PENDING", candidate, approval, authority })).toBe("HUMAN_APPROVAL_PENDING");
    expect(engineerTrustState({ runState: "HUMAN_APPROVED", candidate, approval, authority })).not.toBe("HUMAN_APPROVED");
    expect(engineerTrustState({ runState: "HUMAN_APPROVED", candidate, approval: { ...approval, status: "APPROVED" }, authority })).toBe("HUMAN_APPROVED");
  });

  test("isolates stale conflicts to their run and a full open clears the scope", () => {
    let staleRunId: string | null = "run-a";
    expect(candidateConflictAppliesToRun(staleRunId, "run-a")).toBe(true);
    expect(candidateConflictAppliesToRun(staleRunId, "run-b")).toBe(false);
    // Successful openRun/full snapshot resets the run-scoped conflict.
    staleRunId = null;
    expect(candidateConflictAppliesToRun(staleRunId, "run-b")).toBe(false);
  });
});
