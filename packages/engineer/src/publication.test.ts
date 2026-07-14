import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EngineerPublicationManager } from "./publication-manager.js";
import { LocalArtifactStore } from "./artifact-store.js";
import type { EngineerRun } from "./contracts.js";
import type { EngineerSupervisor } from "./supervisor.js";
import type { ApprovalRequestRecord } from "./control-contracts.js";

describe("Phase 4 approval deadlines", () => {
  test("expires a pending approval fail-closed and records the terminal human-review state", () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-phase4-timeout-"));
    let state: EngineerRun["state"] = "HUMAN_APPROVAL_PENDING";
    let requestStatus: ApprovalRequestRecord["status"] = "PENDING";
    const request: ApprovalRequestRecord = {
      approvalRequestId: "approval-1", runId: "run-1", riskTier: "HIGH", assignedReviewerId: "reviewer-1",
      requestedAt: "2026-07-14T10:00:00.000Z", deadlineAt: "2026-07-14T11:00:00.000Z",
      reminderSchedule: [], timeoutAction: "HUMAN_REVIEW_REQUIRED",
      manifestHash: `sha256:${"a".repeat(64)}`, diffHash: `sha256:${"b".repeat(64)}`,
      evidenceBundleHash: `sha256:${"c".repeat(64)}`, status: "PENDING",
    };
    const run = (): EngineerRun => ({
      runId: "run-1", userId: "user-1",
      repository: { repositoryId: "repo-1", provider: "github", owner: "o", name: "r", baseBranch: "main", baseCommitSha: "d".repeat(40) },
      requestOriginal: "change", requestNormalized: "change", state, stateVersion: 10,
      manifestHash: request.manifestHash, riskTier: "HIGH", humanGateRequired: true,
      createdAt: "2026-07-14T09:00:00.000Z", updatedAt: "2026-07-14T10:00:00.000Z", terminalAt: null,
    });
    const supervisor = {
      getRun: () => run(),
      latestApprovalRequest: () => ({ ...request, status: requestStatus }),
      decideApproval: (_decision: unknown, status: ApprovalRequestRecord["status"]) => { requestStatus = status; return _decision; },
      transition: (input: { nextState: EngineerRun["state"] }) => { state = input.nextState; return { run: run() }; },
    } as unknown as EngineerSupervisor;
    const manager = new EngineerPublicationManager({
      supervisor, artifactStore: new LocalArtifactStore({ root: join(root, "artifacts") }), diffForRun: () => "",
      commandSigningSecret: "phase4-timeout-signing-secret-at-least-32-bytes",
      now: () => new Date("2026-07-14T12:00:00.000Z"),
      gitService: {
        async inspectBaseBranch() { throw new Error("unused"); }, async createRunBranch() { throw new Error("unused"); },
        async pushVerifiedCommit() { throw new Error("unused"); }, async createPullRequest() { throw new Error("unused"); },
      },
    });
    manager.expire("run-1");
    expect(String(requestStatus)).toBe("EXPIRED");
    expect(String(state)).toBe("HUMAN_REVIEW_REQUIRED");
    rmSync(root, { recursive: true, force: true });
  });
});
