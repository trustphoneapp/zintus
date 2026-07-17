import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EngineerPublicationManager } from "./publication-manager.js";
import { LocalArtifactStore } from "./artifact-store.js";
import type { EngineerRun } from "./contracts.js";
import type { EngineerSupervisor } from "./supervisor.js";
import type { ApprovalRequestRecord, GitOperationRecord } from "./control-contracts.js";
import { sha256 } from "./hash.js";

function restartPublicationHarness(root: string, reconciliation: "SUCCEEDED" | "NOT_FOUND", operationLeaseMs = 5_000, seedStarted = true) {
  const diff = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n";
  const resultCommitSha = "b".repeat(40);
  const evidenceBundleHash = `sha256:${"c".repeat(64)}`;
  let state: EngineerRun["state"] = "PR_CREATING";
  const run = (): EngineerRun => ({
    runId: "run-restart", userId: "user-1",
    repository: { repositoryId: "repo-1", provider: "github", owner: "o", name: "r", baseBranch: "main", baseCommitSha: "d".repeat(40) },
    requestOriginal: "change", requestNormalized: "change", state, stateVersion: 10,
    manifestHash: `sha256:${"a".repeat(64)}`, riskTier: "LOW", humanGateRequired: false,
    createdAt: "2026-07-14T09:00:00.000Z", updatedAt: "2026-07-14T10:00:00.000Z", terminalAt: null,
  });
  const operations = new Map<string, GitOperationRecord>();
  const branchKey = `git:branch:run-restart:${resultCommitSha}`;
  if (seedStarted) {
    operations.set(branchKey, {
      gitOperationId: "operation-started", runId: "run-restart", operationType: "CREATE_BRANCH", requestedBy: "SUPERVISOR",
      idempotencyKey: branchKey, expectedBaseCommitSha: run().repository.baseCommitSha, resultCommitSha,
      approvalId: null, evidenceBundleHash, status: "STARTED", remoteReference: null,
      startedAt: "2026-07-14T10:00:00.000Z", completedAt: null, errorCode: null,
    });
  }
  const artifacts: Array<{ artifactId: string; type: string }> = [];
  const failures: unknown[] = [];
  const supervisor = {
    getRun: () => run(),
    listOpenDecisions: () => [],
    getPublicationEvidence: () => ({
      runId: "run-restart", reviewerSessionId: "reviewer-1", reviewerDecision: "APPROVE",
      reviewerDiffHash: sha256(diff), reviewerEvidenceBundleHash: evidenceBundleHash, reviewerIsolationVerified: true,
      evidenceBundleId: "bundle-1", evidenceBundleHash, resultCommitSha,
      allRequiredChecksPassed: true, openCriticalSecurityFindings: 0,
    }),
    findGitOperation: (_runId: string, key: string) => operations.get(key) ?? null,
    recordGitOperation: (record: GitOperationRecord) => { operations.set(record.idempotencyKey, record); return record; },
    recordArtifact: (artifact: { artifactId: string; type: string }) => { artifacts.push(artifact); return artifact; },
    recordFailure: (failure: unknown) => { failures.push(failure); return failure; },
    transition: (input: { nextState: EngineerRun["state"] }) => { state = input.nextState; return { run: run() }; },
    getManifest: () => null,
    listClaimEvidence: () => [],
  } as unknown as EngineerSupervisor;
  const calls = { reconcile: 0, createBranch: 0, push: 0, createPr: 0 };
  const manager = new EngineerPublicationManager({
    supervisor,
    artifactStore: new LocalArtifactStore({ root: join(root, "artifacts") }),
    diffForRun: () => diff,
    commandSigningSecret: "phase4-restart-signing-secret-at-least-32-bytes",
    now: () => new Date("2026-07-14T10:10:00.000Z"),
    operationLeaseMs,
    gitService: {
      async inspectBaseBranch(input) { return { currentCommitSha: input.expectedBaseCommitSha, matchesExpected: true, protectionEnforced: true }; },
      async reconcilePublicationOperation() {
        calls.reconcile += 1;
        return reconciliation === "SUCCEEDED"
          ? { status: "SUCCEEDED" as const, remoteReference: `refs/heads/zintus/engineer/run-restart-${resultCommitSha.slice(0, 12)}` }
          : { status: "NOT_FOUND" as const, detail: "remote result was not found" };
      },
      async createRunBranch() { calls.createBranch += 1; throw new Error("expired STARTED operation must not execute again"); },
      async pushVerifiedCommit(input) { calls.push += 1; return { remoteReference: `refs/heads/${input.branchName}` }; },
      async createPullRequest() { calls.createPr += 1; return { id: "pr-1", number: 1, url: "https://github.test/pull/1" }; },
    },
  });
  return { manager, state: () => state, operations, branchKey, artifacts, failures, calls };
}

function activePublicationHarness(root: string, options: { inspectMatches: boolean[]; maxArtifactBytes?: number }) {
  const diff = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n";
  const resultCommitSha = "b".repeat(40);
  const evidenceBundleHash = `sha256:${"c".repeat(64)}`;
  let state: EngineerRun["state"] = "REVIEW_APPROVED";
  let lastError: string | null = null;
  const failures: Array<{ reasonCode?: string; retryable?: boolean }> = [];
  const operations = new Map<string, GitOperationRecord>();
  const calls = { inspect: 0, createBranch: 0, push: 0, createPr: 0 };
  const run = (): EngineerRun => ({
    runId: "run-active", userId: "user-1",
    repository: { repositoryId: "repo-1", provider: "github", owner: "o", name: "r", baseBranch: "main", baseCommitSha: "d".repeat(40) },
    requestOriginal: "change", requestNormalized: "change", state, stateVersion: 10,
    manifestHash: `sha256:${"a".repeat(64)}`, riskTier: "LOW", humanGateRequired: false,
    createdAt: "2026-07-14T09:00:00.000Z", updatedAt: "2026-07-14T10:00:00.000Z", terminalAt: null,
  });
  const supervisor = {
    getRun: () => run(), listOpenDecisions: () => [],
    getPublicationEvidence: () => ({
      runId: run().runId, reviewerSessionId: "reviewer-1", reviewerDecision: "APPROVE",
      reviewerDiffHash: sha256(diff), reviewerEvidenceBundleHash: evidenceBundleHash, reviewerIsolationVerified: true,
      evidenceBundleId: "bundle-1", evidenceBundleHash, resultCommitSha,
      allRequiredChecksPassed: true, openCriticalSecurityFindings: 0,
    }),
    findGitOperation: (_runId: string, key: string) => operations.get(key) ?? null,
    recordGitOperation: (record: GitOperationRecord) => { operations.set(record.idempotencyKey, record); return record; },
    recordArtifact: (artifact: unknown) => artifact,
    recordFailure: (failure: { reasonCode?: string; retryable?: boolean }) => { failures.push(failure); return failure; },
    listRuns: (states: EngineerRun["state"][]) => states.includes(state) ? [run()] : [],
    listFailures: () => failures,
    transition: (input: { nextState: EngineerRun["state"] }) => { state = input.nextState; return { run: run() }; },
    setLastError: (_runId: string, value: string | null) => { lastError = value; },
    getManifest: () => null, listClaimEvidence: () => [],
  } as unknown as EngineerSupervisor;
  const manager = new EngineerPublicationManager({
    supervisor,
    artifactStore: new LocalArtifactStore({ root: join(root, "artifacts"), ...(options.maxArtifactBytes ? { maxArtifactBytes: options.maxArtifactBytes } : {}) }),
    diffForRun: () => diff,
    commandSigningSecret: "phase4-active-signing-secret-at-least-32-bytes",
    autoPublishLowRisk: true,
    gitService: {
      async inspectBaseBranch(input) {
        const matchesExpected = options.inspectMatches[calls.inspect] ?? options.inspectMatches.at(-1) ?? true;
        calls.inspect += 1;
        return { currentCommitSha: matchesExpected ? input.expectedBaseCommitSha : "e".repeat(40), matchesExpected, protectionEnforced: true };
      },
      async createRunBranch() { calls.createBranch += 1; return { branchName: "zintus/engineer/run-active", remoteReference: "refs/heads/zintus/engineer/run-active" }; },
      async pushVerifiedCommit(input) { calls.push += 1; return { remoteReference: `refs/heads/${input.branchName}` }; },
      async createPullRequest() { calls.createPr += 1; return { id: "pr-1", number: 1, url: "https://github.test/pull/1" }; },
    },
  });
  return { manager, state: () => state, lastError: () => lastError, failures, calls };
}

describe("Phase 4 approval deadlines", () => {
  test("rechecks the base immediately before PR creation and stops on mid-flight drift", async () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-phase4-base-toctou-"));
    const harness = activePublicationHarness(root, { inspectMatches: [true, false] });
    await expect(harness.manager.start("run-active", "reviewer-1")).resolves.toEqual({
      status: "BASE_STALE", currentBaseCommitSha: "e".repeat(40),
    });
    expect(harness.state()).toBe("BASE_BRANCH_STALE");
    expect(harness.calls).toEqual({ inspect: 2, createBranch: 1, push: 1, createPr: 0 });
    expect(harness.failures).toContainEqual(expect.objectContaining({ reasonCode: "BASE_BRANCH_CHANGED_BEFORE_PR" }));
    rmSync(root, { recursive: true, force: true });
  });

  test("detects a base move during draft PR creation and refuses to mark publication complete", async () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-phase4-base-post-create-"));
    const harness = activePublicationHarness(root, { inspectMatches: [true, true, false] });
    await expect(harness.manager.start("run-active", "reviewer-1")).resolves.toEqual({
      status: "BASE_STALE", currentBaseCommitSha: "e".repeat(40),
    });
    expect(harness.state()).toBe("BASE_BRANCH_STALE");
    expect(harness.calls).toEqual({ inspect: 3, createBranch: 1, push: 1, createPr: 1 });
    expect(harness.failures).toContainEqual(expect.objectContaining({ reasonCode: "BASE_BRANCH_CHANGED_DURING_PR" }));
    rmSync(root, { recursive: true, force: true });
  });

  test("persists a non-retryable publication failure when the artifact budget is exhausted", async () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-phase4-artifact-limit-"));
    const harness = activePublicationHarness(root, { inspectMatches: [true], maxArtifactBytes: 1 });
    await expect(harness.manager.start("run-active", "reviewer-1")).rejects.toThrow("artifact exceeds");
    expect(harness.lastError()).toContain("artifact exceeds");
    expect(harness.failures).toContainEqual(expect.objectContaining({
      reasonCode: "PUBLICATION_ARTIFACT_LIMIT_EXCEEDED", retryable: false,
    }));
    const callsAfterFailure = { ...harness.calls };
    await expect(harness.manager.recoverPending()).resolves.toEqual({ resumedRunIds: [], failedRunIds: ["run-active"] });
    expect(harness.calls).toEqual(callsAfterFailure);
    rmSync(root, { recursive: true, force: true });
  });

  test("defers every Git call until deferred decisions resolve and replay does not duplicate publication", async () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-phase4-deferred-decisions-"));
    const diff = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n";
    const resultCommitSha = "b".repeat(40);
    const evidenceBundleHash = `sha256:${"c".repeat(64)}`;
    let state: EngineerRun["state"] = "REVIEW_APPROVED";
    let deferredOpen = true;
    const operations = new Map<string, GitOperationRecord>();
    const calls = { inspect: 0, createBranch: 0, push: 0, createPr: 0 };
    const run = (): EngineerRun => ({
      runId: "run-deferred", userId: "user-1",
      repository: { repositoryId: "repo-1", provider: "github", owner: "o", name: "r", baseBranch: "main", baseCommitSha: "d".repeat(40) },
      requestOriginal: "change", requestNormalized: "change", state, stateVersion: 10,
      manifestHash: `sha256:${"a".repeat(64)}`, riskTier: "LOW", humanGateRequired: false,
      createdAt: "2026-07-14T09:00:00.000Z", updatedAt: "2026-07-14T10:00:00.000Z",
      terminalAt: state === "COMPLETED" ? "2026-07-14T10:05:00.000Z" : null,
    });
    const supervisor = {
      getRun: () => run(),
      listOpenDecisions: () => deferredOpen ? [{ decisionId: "decision-b", classification: "DEFER" }, { decisionId: "decision-a", classification: "DEFER" }] : [],
      getPublicationEvidence: () => ({
        runId: "run-deferred", reviewerSessionId: "reviewer-1", reviewerDecision: "APPROVE",
        reviewerDiffHash: sha256(diff), reviewerEvidenceBundleHash: evidenceBundleHash, reviewerIsolationVerified: true,
        evidenceBundleId: "bundle-1", evidenceBundleHash, resultCommitSha,
        allRequiredChecksPassed: true, openCriticalSecurityFindings: 0,
      }),
      findGitOperation: (_runId: string, key: string) => operations.get(key) ?? null,
      recordGitOperation: (record: GitOperationRecord) => { operations.set(record.idempotencyKey, record); return record; },
      recordArtifact: (artifact: unknown) => artifact,
      transition: (input: { nextState: EngineerRun["state"] }) => { state = input.nextState; return { run: run() }; },
      getManifest: () => null,
      listClaimEvidence: () => [],
    } as unknown as EngineerSupervisor;
    const manager = new EngineerPublicationManager({
      supervisor,
      artifactStore: new LocalArtifactStore({ root: join(root, "artifacts") }),
      diffForRun: () => diff,
      commandSigningSecret: "phase4-deferred-signing-secret-at-least-32-bytes",
      autoPublishLowRisk: true,
      gitService: {
        async inspectBaseBranch(input) { calls.inspect += 1; return { currentCommitSha: input.expectedBaseCommitSha, matchesExpected: true, protectionEnforced: true }; },
        async createRunBranch() { calls.createBranch += 1; return { branchName: "zintus/engineer/run-deferred", remoteReference: "refs/heads/zintus/engineer/run-deferred" }; },
        async pushVerifiedCommit(input) { calls.push += 1; return { remoteReference: `refs/heads/${input.branchName}` }; },
        async createPullRequest() { calls.createPr += 1; return { id: "pr-1", number: 1, url: "https://github.test/pull/1" }; },
      },
    });

    await expect(manager.start("run-deferred", "reviewer-1")).resolves.toEqual({
      status: "DEFERRED_DECISIONS_PENDING",
      decisionIds: ["decision-a", "decision-b"],
    });
    await expect(manager.resume("run-deferred")).resolves.toEqual({
      status: "DEFERRED_DECISIONS_PENDING",
      decisionIds: ["decision-a", "decision-b"],
    });
    expect(calls).toEqual({ inspect: 0, createBranch: 0, push: 0, createPr: 0 });

    deferredOpen = false;
    await expect(manager.start("run-deferred", "reviewer-1")).resolves.toMatchObject({ status: "PUBLISHED" });
    expect(String(state)).toBe("COMPLETED");
    expect(calls).toEqual({ inspect: 3, createBranch: 1, push: 1, createPr: 1 });

    await expect(manager.resume("run-deferred")).resolves.toMatchObject({ status: "PUBLISHED" });
    expect(calls).toEqual({ inspect: 3, createBranch: 1, push: 1, createPr: 1 });
    rmSync(root, { recursive: true, force: true });
  });

  test("restart reconciles an expired STARTED operation without repeating its remote action", async () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-phase4-restart-reconcile-"));
    const harness = restartPublicationHarness(root, "SUCCEEDED");
    const result = await harness.manager.resume("run-restart");
    expect(result.status).toBe("PUBLISHED");
    expect(harness.state()).toBe("COMPLETED");
    expect(harness.calls).toEqual({ reconcile: 1, createBranch: 0, push: 1, createPr: 1 });
    expect(harness.operations.get(harness.branchKey)?.status).toBe("SUCCEEDED");
    rmSync(root, { recursive: true, force: true });
  });

  test("restart marks an unreconciled STARTED operation stale and requires human review", async () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-phase4-restart-stale-"));
    const harness = restartPublicationHarness(root, "NOT_FOUND");
    await expect(harness.manager.resume("run-restart")).rejects.toThrow("requires human recovery review");
    expect(harness.state()).toBe("HUMAN_REVIEW_REQUIRED");
    expect(harness.calls).toEqual({ reconcile: 1, createBranch: 0, push: 0, createPr: 0 });
    expect(harness.operations.get(harness.branchKey)).toMatchObject({ status: "STALE", errorCode: "RECONCILIATION_NOT_FOUND" });
    expect(harness.artifacts.some((artifact) => artifact.type === "PUBLICATION_RECOVERY_EVIDENCE")).toBe(true);
    expect(harness.failures).toHaveLength(1);
    rmSync(root, { recursive: true, force: true });
  });

  test("restart preserves a live STARTED lease as an exclusive claim", async () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-phase4-restart-live-"));
    const harness = restartPublicationHarness(root, "SUCCEEDED", 15 * 60_000);
    await expect(harness.manager.resume("run-restart")).rejects.toThrow("already in progress");
    expect(harness.state()).toBe("PR_CREATING");
    expect(harness.calls).toEqual({ reconcile: 0, createBranch: 0, push: 0, createPr: 0 });
    expect(harness.operations.get(harness.branchKey)?.status).toBe("STARTED");
    rmSync(root, { recursive: true, force: true });
  });

  test("an ambiguous remote-call failure is reconciled or made stale, never retried blindly", async () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-phase4-ambiguous-call-"));
    const harness = restartPublicationHarness(root, "NOT_FOUND", 5_000, false);
    await expect(harness.manager.resume("run-restart")).rejects.toThrow("requires human recovery review");
    expect(harness.state()).toBe("HUMAN_REVIEW_REQUIRED");
    expect(harness.calls).toEqual({ reconcile: 1, createBranch: 1, push: 0, createPr: 0 });
    expect(harness.operations.get(harness.branchKey)).toMatchObject({ status: "STALE", errorCode: "RECONCILIATION_NOT_FOUND" });
    await expect(harness.manager.resume("run-restart")).rejects.toThrow("not valid from HUMAN_REVIEW_REQUIRED");
    expect(harness.calls.createBranch).toBe(1);
    rmSync(root, { recursive: true, force: true });
  });

  test("credentialed stale recovery synchronizes the inspected base without remote mutation", async () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-phase4-stale-recovery-"));
    let synchronized = "";
    const run = {
      runId: "run-stale", userId: "user-1",
      repository: { repositoryId: "repo-1", provider: "github" as const, owner: "o", name: "r", baseBranch: "main", baseCommitSha: "d".repeat(40) },
      requestOriginal: "change", requestNormalized: "change", state: "BASE_BRANCH_STALE" as const, stateVersion: 10,
      manifestHash: `sha256:${"a".repeat(64)}`, riskTier: "HIGH" as const, humanGateRequired: true,
      createdAt: "2026-07-14T09:00:00.000Z", updatedAt: "2026-07-14T10:00:00.000Z", terminalAt: null,
    };
    const manager = new EngineerPublicationManager({
      supervisor: { getRun: () => run } as unknown as EngineerSupervisor,
      artifactStore: new LocalArtifactStore({ root: join(root, "artifacts") }), diffForRun: () => "",
      commandSigningSecret: "phase4-stale-signing-secret-at-least-32-bytes",
      gitService: {
        async inspectBaseBranch() { return { currentCommitSha: "e".repeat(40), matchesExpected: false, protectionEnforced: true }; },
        async synchronizeBaseBranch(input) { synchronized = input.expectedCommitSha; },
        async createRunBranch() { throw new Error("must not mutate remote"); },
        async pushVerifiedCommit() { throw new Error("must not mutate remote"); },
        async createPullRequest() { throw new Error("must not mutate remote"); },
      },
    });
    expect(await manager.replacementRepositoryForStale(run.runId)).toEqual({ ...run.repository, baseCommitSha: "e".repeat(40) });
    expect(synchronized).toBe("e".repeat(40));
    rmSync(root, { recursive: true, force: true });
  });

  test("expires a pending approval fail-closed and records the terminal human-review state", () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-phase4-timeout-"));
    let state: EngineerRun["state"] = "HUMAN_APPROVAL_PENDING";
    let requestStatus: ApprovalRequestRecord["status"] = "PENDING";
    const failures: unknown[] = [];
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
      recordFailure: (failure: unknown) => { failures.push(failure); return failure; },
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
    expect(failures).toHaveLength(1);
    rmSync(root, { recursive: true, force: true });
  });
});
