import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EngineerPublicationManager } from "./publication-manager.js";
import { LocalArtifactStore } from "./artifact-store.js";
import type { EngineerRun } from "./contracts.js";
import type { EngineerSupervisor } from "./supervisor.js";
import {
  SignedSupervisorPrCommandSchema,
  type ApprovalAuthorityExpectation,
  type ApprovalRequestRecord,
  type GitOperationRecord,
} from "./control-contracts.js";
import { sha256 } from "./hash.js";
import { ApprovalAuthorityConflictError, IdempotencyConflictError } from "./errors.js";

const checkpointAttestor = {
  algorithm: "test-sha256", keyId: "publication-test-key",
  sign: (payload: Uint8Array) => `test:${sha256(payload)}`,
  verify: (payload: Uint8Array, signature: string) => signature === `test:${sha256(payload)}`,
};

function expectedApproval(request: ApprovalRequestRecord): ApprovalAuthorityExpectation {
  return {
    expectedVerifiedCheckpointId: request.verifiedCheckpointId!,
    expectedVerifiedCheckpointHash: request.verifiedCheckpointHash!,
    expectedApprovalRevision: request.approvalRevision,
  };
}

function checkpointBoundSupervisor(supervisor: EngineerSupervisor, runId: string): EngineerSupervisor {
  const requiredLaneContractHash = sha256(`required-lane:${runId}`);
  const environmentDigest = sha256(`environment:${runId}`);
  const listGitOperations = supervisor.listGitOperations?.bind(supervisor) ?? (() => []);
  return Object.assign(supervisor, {
    listGitOperations,
    isOptionalHardeningChild: () => false,
    async getVerifiedCandidateCheckpoint() {
      const run = supervisor.getRun(runId);
      const evidence = supervisor.getPublicationEvidence(runId);
      return {
        checkpoint: {
          checkpointId: sha256(`checkpoint-id:${runId}`), checkpointHash: sha256(`checkpoint-hash:${runId}`),
          runId, requesterUserId: run.userId, repositoryId: run.repository.repositoryId,
          requiredLaneContractHash, manifestHash: run.manifestHash, baseCommitSha: run.repository.baseCommitSha,
          resultCommitSha: evidence.resultCommitSha, diffHash: evidence.reviewerDiffHash,
          evidenceBundleId: evidence.evidenceBundleId, evidenceBundleHash: evidence.evidenceBundleHash,
          environmentDigest, reviewerSessionId: evidence.reviewerSessionId,
          classificationHash: evidence.classificationHash, classificationResult: evidence.classificationResult,
        },
        attestation: {},
      } as never;
    },
    getRequiredLaneContract: () => ({ contractHash: requiredLaneContractHash }),
    listEvidenceBundles: () => {
      const run = supervisor.getRun(runId);
      const evidence = supervisor.getPublicationEvidence(runId);
      return [{
        evidenceBundleId: evidence.evidenceBundleId,
        bundleHash: evidence.evidenceBundleHash,
        bundle: {
          runId, manifestHash: run.manifestHash, baseCommitSha: run.repository.baseCommitSha,
          resultCommitSha: evidence.resultCommitSha, reviewerSessionId: evidence.reviewerSessionId,
          classificationHash: evidence.classificationHash, classificationResult: evidence.classificationResult,
          environmentDigest,
        },
      }] as never;
    },
    listApprovalDecisions: (approvalRequestId: string) => {
      const approval = supervisor.latestApprovalRequest?.(runId);
      if (!approval || approval.status !== "APPROVED" || approval.approvalRequestId !== approvalRequestId) return [];
      return [{
        approvalDecisionId: `decision:${approvalRequestId}`, approvalRequestId,
        actorId: approval.assignedReviewerId ?? "reviewer-1", decision: "APPROVE", reason: "Approved.",
        decidedAt: approval.requestedAt, expectedVerifiedCheckpointId: approval.verifiedCheckpointId,
        expectedVerifiedCheckpointHash: approval.verifiedCheckpointHash,
        expectedApprovalRevision: approval.approvalRevision - 1,
      }];
    },
  });
}

function restartPublicationHarness(root: string, reconciliation: "SUCCEEDED" | "NOT_FOUND", operationLeaseMs = 5_000, seedStarted = true, reclassified = false) {
  const diff = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n";
  const resultCommitSha = "b".repeat(40);
  const evidenceBundleHash = `sha256:${"c".repeat(64)}`;
  const checkpointId = sha256("checkpoint-id:run-restart");
  const checkpointHash = sha256("checkpoint-hash:run-restart");
  let state: EngineerRun["state"] = "PR_CREATING";
  const run = (): EngineerRun => ({
    runId: "run-restart", userId: "user-1",
    repository: { repositoryId: "repo-1", provider: "github", owner: "o", name: "r", baseBranch: "main", baseCommitSha: "d".repeat(40) },
    requestOriginal: "change", requestNormalized: "change", state, stateVersion: 10,
    manifestHash: `sha256:${"a".repeat(64)}`, riskTier: "LOW", humanGateRequired: false,
    createdAt: "2026-07-14T09:00:00.000Z", updatedAt: "2026-07-14T10:00:00.000Z", terminalAt: null,
  });
  const operations = new Map<string, GitOperationRecord>();
  const branchKey = `git:branch:run-restart:${checkpointHash.slice("sha256:".length)}:${resultCommitSha}`;
  if (seedStarted) {
    operations.set(branchKey, {
      gitOperationId: "operation-started", runId: "run-restart", operationType: "CREATE_BRANCH", requestedBy: "SUPERVISOR",
      idempotencyKey: branchKey, expectedBaseCommitSha: run().repository.baseCommitSha, resultCommitSha,
      approvalId: null, evidenceBundleHash, status: "STARTED", remoteReference: null,
      verifiedCheckpointId: checkpointId, verifiedCheckpointHash: checkpointHash,
      startedAt: "2026-07-14T10:00:00.000Z", completedAt: null, errorCode: null,
    });
  }
  const artifacts: Array<{ artifactId: string; type: string }> = [];
  const failures: unknown[] = [];
  let lastError: string | null = null;
  const supervisor = {
    getRun: () => run(),
    latestApprovalRequest: () => null,
    listRuns: (states: EngineerRun["state"][]) => states.includes(state) ? [run()] : [],
    listFailures: () => failures as Array<{ reasonCode: string; retryable: boolean }>,
    setLastError: (_runId: string, message: string | null) => { lastError = message; },
    listOpenDecisions: () => [],
    getPublicationEvidence: () => ({
      runId: "run-restart", reviewerSessionId: "reviewer-1", reviewerDecision: "APPROVE",
      classificationHash: sha256(reclassified ? "classification-replaced" : "classification-ready"), classificationResult: "READY",
      reviewerDiffHash: sha256(diff), reviewerEvidenceBundleHash: evidenceBundleHash, reviewerIsolationVerified: true,
      evidenceBundleId: reclassified ? "bundle-2" : "bundle-1",
      evidenceBundleHash: reclassified ? `sha256:${"e".repeat(64)}` : evidenceBundleHash, resultCommitSha,
      allRequiredChecksPassed: true, openCriticalSecurityFindings: 0,
    }),
    findGitOperation: (_runId: string, key: string) => operations.get(key) ?? null,
    listGitOperations: () => [...operations.values()],
    recordGitOperation: (record: GitOperationRecord) => { operations.set(record.idempotencyKey, record); return record; },
    recordArtifact: (artifact: { artifactId: string; type: string }) => { artifacts.push(artifact); return artifact; },
    recordFailure: (failure: unknown) => { failures.push(failure); return failure; },
    transition: (input: { nextState: EngineerRun["state"] }) => { state = input.nextState; return { run: run() }; },
    getManifest: () => null,
    listClaimEvidence: () => [],
  } as unknown as EngineerSupervisor;
  const calls = { reconcile: 0, createBranch: 0, push: 0, createPr: 0 };
  const restartManager = () => new EngineerPublicationManager({
    supervisor: checkpointBoundSupervisor(supervisor, "run-restart"),
    artifactStore: new LocalArtifactStore({ root: join(root, "artifacts") }),
    diffForRun: () => diff,
    commandSigningSecret: "phase4-restart-signing-secret-at-least-32-bytes",
    checkpointAttestor,
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
  const manager = restartManager();
  return { manager, restartManager, supervisor, state: () => state, operations, branchKey, artifacts, failures, calls, lastError: () => lastError };
}

function activePublicationHarness(root: string, options: { inspectMatches: boolean[]; maxArtifactBytes?: number }) {
  const diff = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n";
  const resultCommitSha = "b".repeat(40);
  const evidenceBundleHash = `sha256:${"c".repeat(64)}`;
  let state: EngineerRun["state"] = "REVIEW_APPROVED";
  let lastError: string | null = null;
  const failures: Array<{ reasonCode?: string; retryable?: boolean }> = [];
  const artifacts: Array<Record<string, unknown>> = [];
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
      classificationHash: sha256("classification-ready"), classificationResult: "READY",
      reviewerDiffHash: sha256(diff), reviewerEvidenceBundleHash: evidenceBundleHash, reviewerIsolationVerified: true,
      evidenceBundleId: "bundle-1", evidenceBundleHash, resultCommitSha,
      allRequiredChecksPassed: true, openCriticalSecurityFindings: 0,
    }),
    findGitOperation: (_runId: string, key: string) => operations.get(key) ?? null,
    listGitOperations: () => [...operations.values()],
    recordGitOperation: (record: GitOperationRecord) => { operations.set(record.idempotencyKey, record); return record; },
    recordArtifact: (artifact: Record<string, unknown>) => { artifacts.push(artifact); return artifact; },
    recordFailure: (failure: { reasonCode?: string; retryable?: boolean }) => { failures.push(failure); return failure; },
    listRuns: (states: EngineerRun["state"][]) => states.includes(state) ? [run()] : [],
    listFailures: () => failures,
    transition: (input: { nextState: EngineerRun["state"] }) => { state = input.nextState; return { run: run() }; },
    setLastError: (_runId: string, value: string | null) => { lastError = value; },
    getManifest: () => null, listClaimEvidence: () => [],
  } as unknown as EngineerSupervisor;
  const manager = new EngineerPublicationManager({
    supervisor: checkpointBoundSupervisor(supervisor, "run-active"),
    artifactStore: new LocalArtifactStore({ root: join(root, "artifacts"), ...(options.maxArtifactBytes ? { maxArtifactBytes: options.maxArtifactBytes } : {}) }),
    diffForRun: () => diff,
    commandSigningSecret: "phase4-active-signing-secret-at-least-32-bytes",
    checkpointAttestor,
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
  return { manager, supervisor, operations, artifacts, state: () => state, lastError: () => lastError, failures, calls };
}

describe("Phase 4 approval deadlines", () => {
  test("translates a real approval CAS loser into the stable candidate-changed conflict", async () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-phase4-approval-cas-race-"));
    const runId = "run-approval-cas-race";
    let status: ApprovalRequestRecord["status"] = "PENDING";
    let revision = 0;
    let transitionCalls = 0;
    const request = (): ApprovalRequestRecord => ({
      approvalRequestId: "approval-cas-race", runId, riskTier: "HIGH", assignedReviewerId: "reviewer-1",
      requestedAt: "2026-07-17T09:00:00.000Z", deadlineAt: "2026-07-18T09:00:00.000Z",
      reminderSchedule: [], timeoutAction: "HUMAN_REVIEW_REQUIRED", manifestHash: sha256("manifest-cas-race"),
      diffHash: sha256("diff-cas-race"), evidenceBundleHash: sha256("bundle-cas-race"),
      reviewerSessionId: "reviewer-1", classificationHash: sha256("classification-cas-race"),
      classificationResult: "READY", status, approvalRevision: revision,
      verifiedCheckpointId: sha256("checkpoint-id-cas-race"), verifiedCheckpointHash: sha256("checkpoint-hash-cas-race"),
    });
    const run = (): EngineerRun => ({
      runId, userId: "user-1",
      repository: { repositoryId: "repo-1", provider: "github", owner: "o", name: "r", baseBranch: "main", baseCommitSha: "d".repeat(40) },
      requestOriginal: "change", requestNormalized: "change", state: status === "PENDING" ? "HUMAN_APPROVAL_PENDING" : "FIX_REQUESTED",
      stateVersion: 10 + revision, manifestHash: request().manifestHash, riskTier: "HIGH", humanGateRequired: true,
      createdAt: "2026-07-17T09:00:00.000Z", updatedAt: "2026-07-17T09:00:00.000Z", terminalAt: null,
    });
    const evidence = () => ({
      runId, reviewerSessionId: "reviewer-1", reviewerDecision: "APPROVE" as const,
      classificationHash: request().classificationHash!, classificationResult: "READY" as const,
      reviewerDiffHash: request().diffHash, reviewerEvidenceBundleHash: request().evidenceBundleHash,
      reviewerIsolationVerified: true as const, evidenceBundleId: "bundle-cas-race",
      evidenceBundleHash: request().evidenceBundleHash, resultCommitSha: "b".repeat(40),
      allRequiredChecksPassed: true, openCriticalSecurityFindings: 0,
    });
    let arrivals = 0;
    let release!: () => void;
    const bothArrived = new Promise<void>((resolve) => { release = resolve; });
    const supervisor = {
      isOptionalHardeningChild: () => false,
      getRun: () => run(),
      latestApprovalRequest: () => request(),
      getPublicationEvidence: () => evidence(),
      async getVerifiedCandidateCheckpoint() {
        arrivals += 1;
        if (arrivals === 2) release();
        await bothArrived;
        return { checkpoint: {
          checkpointId: request().verifiedCheckpointId, checkpointHash: request().verifiedCheckpointHash,
          runId, manifestHash: request().manifestHash, diffHash: request().diffHash,
          evidenceBundleHash: request().evidenceBundleHash, reviewerSessionId: request().reviewerSessionId,
          classificationHash: request().classificationHash, classificationResult: request().classificationResult,
        }, attestation: {} };
      },
      decideApproval: (decision: { expectedApprovalRevision: number }) => {
        if (status !== "PENDING" || revision !== decision.expectedApprovalRevision) {
          throw new IdempotencyConflictError(runId, "approval:approval-cas-race");
        }
        status = "CHANGES_REQUESTED"; revision += 1;
        return decision;
      },
      transition: () => { transitionCalls += 1; return { run: run() }; },
    } as unknown as EngineerSupervisor;
    const manager = new EngineerPublicationManager({
      supervisor, artifactStore: new LocalArtifactStore({ root: join(root, "artifacts") }), diffForRun: () => "diff-cas-race",
      commandSigningSecret: "phase4-cas-race-signing-secret-at-least-32-bytes", checkpointAttestor,
      gitService: {
        async inspectBaseBranch() { throw new Error("unused"); }, async createRunBranch() { throw new Error("unused"); },
        async pushVerifiedCommit() { throw new Error("unused"); }, async createPullRequest() { throw new Error("unused"); },
      },
    });
    const expected = expectedApproval(request());
    const outcomes = await Promise.allSettled([
      manager.requestChanges(runId, "reviewer-1", "first browser", expected),
      manager.requestChanges(runId, "reviewer-1", "second browser", expected),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
    expect(rejected?.reason).toBeInstanceOf(ApprovalAuthorityConflictError);
    expect(transitionCalls).toBe(1);
    rmSync(root, { recursive: true, force: true });
  });

  test("rejects every legacy, malformed, or stale approval binding before any Git call", async () => {
    const cases: Array<[string, Partial<ApprovalRequestRecord>]> = [
      ["legacy reviewer", { reviewerSessionId: null }],
      ["legacy classification hash", { classificationHash: null }],
      ["legacy classification result", { classificationResult: null }],
      ["legacy checkpoint id", { verifiedCheckpointId: null }],
      ["legacy checkpoint hash", { verifiedCheckpointHash: null }],
      ["stale checkpoint id", { verifiedCheckpointId: sha256("stale-checkpoint-id") }],
      ["stale checkpoint hash", { verifiedCheckpointHash: sha256("stale-checkpoint-hash") }],
      ["stale manifest", { manifestHash: sha256("stale-manifest") }],
      ["stale diff", { diffHash: sha256("stale-diff") }],
      ["stale bundle", { evidenceBundleHash: sha256("stale-bundle") }],
      ["stale reviewer", { reviewerSessionId: "reviewer-stale" }],
      ["stale classification", { classificationHash: sha256("stale-classification") }],
      ["stale result", { classificationResult: "READY_WITH_ADVISORIES" }],
      ["malformed classification", { classificationHash: "not-a-hash" as ApprovalRequestRecord["classificationHash"] }],
    ];
    for (const [label, override] of cases) {
      const root = mkdtempSync(join(tmpdir(), `zintus-phase4-approval-${label.replaceAll(" ", "-")}-`));
      const diff = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n";
      const evidence = {
        runId: "run-approval-resume", reviewerSessionId: "reviewer-1", reviewerDecision: "APPROVE" as const,
        classificationHash: sha256("classification-ready"), classificationResult: "READY" as const,
        reviewerDiffHash: sha256(diff), reviewerEvidenceBundleHash: sha256("reviewer-bundle"), reviewerIsolationVerified: true as const,
        evidenceBundleId: "bundle-1", evidenceBundleHash: sha256("bundle-1"), resultCommitSha: "b".repeat(40),
        allRequiredChecksPassed: true, openCriticalSecurityFindings: 0,
      };
      const run: EngineerRun = {
        runId: evidence.runId, userId: "user-1",
        repository: { repositoryId: "repo-1", provider: "github", owner: "o", name: "r", baseBranch: "main", baseCommitSha: "d".repeat(40) },
        requestOriginal: "change", requestNormalized: "change", state: "HUMAN_APPROVED", stateVersion: 11,
        manifestHash: sha256("manifest"), riskTier: "MEDIUM", humanGateRequired: true,
        createdAt: "2026-07-17T09:00:00.000Z", updatedAt: "2026-07-17T10:00:00.000Z", terminalAt: null,
      };
      const approval = {
        approvalRequestId: "approval-1", runId: run.runId, riskTier: run.riskTier, assignedReviewerId: "reviewer@example.test",
        requestedAt: run.createdAt, deadlineAt: "2026-07-18T10:00:00.000Z", reminderSchedule: [], timeoutAction: "HUMAN_REVIEW_REQUIRED" as const,
        manifestHash: run.manifestHash!, diffHash: evidence.reviewerDiffHash, evidenceBundleHash: evidence.evidenceBundleHash,
        reviewerSessionId: evidence.reviewerSessionId, classificationHash: evidence.classificationHash,
        classificationResult: evidence.classificationResult, status: "APPROVED" as const,
        approvalRevision: 1,
        verifiedCheckpointId: sha256(`checkpoint-id:${run.runId}`),
        verifiedCheckpointHash: sha256(`checkpoint-hash:${run.runId}`), ...override,
      } as ApprovalRequestRecord;
      let gitCalls = 0;
      const supervisor = {
        getRun: () => run, listOpenDecisions: () => [], getPublicationEvidence: () => evidence,
        latestApprovalRequest: () => approval,
      } as unknown as EngineerSupervisor;
      const manager = new EngineerPublicationManager({
        supervisor: checkpointBoundSupervisor(supervisor, run.runId), artifactStore: new LocalArtifactStore({ root: join(root, "artifacts") }), diffForRun: () => diff,
        commandSigningSecret: "phase4-approval-signing-secret-at-least-32-bytes",
        checkpointAttestor,
        gitService: {
          async inspectBaseBranch() { gitCalls += 1; throw new Error("must not inspect Git"); },
          async createRunBranch() { gitCalls += 1; throw new Error("must not create branch"); },
          async pushVerifiedCommit() { gitCalls += 1; throw new Error("must not push"); },
          async createPullRequest() { gitCalls += 1; throw new Error("must not create PR"); },
        },
      });
      const resumed = manager.resume(run.runId);
      if (label === "stale checkpoint id") {
        await expect(resumed).rejects.toThrow("approved request does not bind");
      } else {
        await expect(resumed).rejects.toThrow();
      }
      expect(gitCalls).toBe(0);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("low-risk auto publication requires a valid checkpoint before every Git call", async () => {
    for (const mode of ["MISSING", "INVALID"] as const) {
      const root = mkdtempSync(join(tmpdir(), `zintus-phase4-low-checkpoint-${mode.toLowerCase()}-`));
      let gitCalls = 0;
      const diff = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n";
      const run: EngineerRun = {
        runId: `run-low-${mode.toLowerCase()}`, userId: "user-1",
        repository: { repositoryId: "repo-1", provider: "github", owner: "o", name: "r", baseBranch: "main", baseCommitSha: "d".repeat(40) },
        requestOriginal: "change", requestNormalized: "change", state: "REVIEW_APPROVED", stateVersion: 10,
        manifestHash: sha256("manifest"), riskTier: "LOW", humanGateRequired: false,
        createdAt: "2026-07-17T09:00:00.000Z", updatedAt: "2026-07-17T10:00:00.000Z", terminalAt: null,
      };
      const supervisor = {
        getRun: () => run, listOpenDecisions: () => [],
        getVerifiedCandidateCheckpoint: async () => {
          if (mode === "MISSING") return null;
          throw new Error("checkpoint attestation signature verification failed");
        },
      } as unknown as EngineerSupervisor;
      const manager = new EngineerPublicationManager({
        supervisor, artifactStore: new LocalArtifactStore({ root: join(root, "artifacts") }), diffForRun: () => diff,
        commandSigningSecret: "phase4-low-checkpoint-secret-at-least-32-bytes", checkpointAttestor,
        autoPublishLowRisk: true,
        gitService: {
          async inspectBaseBranch() { gitCalls += 1; throw new Error("must not inspect Git"); },
          async createRunBranch() { gitCalls += 1; throw new Error("must not create branch"); },
          async pushVerifiedCommit() { gitCalls += 1; throw new Error("must not push"); },
          async createPullRequest() { gitCalls += 1; throw new Error("must not create PR"); },
        },
      });
      await expect(manager.start(run.runId, "reviewer-1")).rejects.toThrow();
      expect(gitCalls).toBe(0);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("complete publication authority rejects every malformed binding before any Git service method", async () => {
    const modes = [
      "BAD_SIGNATURE", "MISSING_CHECKPOINT", "LEGACY_NULL", "STALE_HASH", "STALE_DIFF", "STALE_BASE",
      "STALE_RESULT", "STALE_CLASSIFICATION", "STALE_EVIDENCE", "WRONG_RUN", "WRONG_REPOSITORY",
      "WRONG_APPROVAL_DECISION", "STALE_APPROVAL_REVISION",
      "EXTENSION_WRONG_REQUEST", "EXTENSION_WRONG_PAIR", "EXTENSION_WRONG_ACTOR", "EXTENSION_AFTER_APPROVAL",
    ] as const;
    for (const mode of modes) {
      const root = mkdtempSync(join(tmpdir(), `zintus-phase4-authority-${mode.toLowerCase()}-`));
      const runId = `run-authority-${mode.toLowerCase()}`;
      const diff = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n";
      const run: EngineerRun = {
        runId, userId: "user-1",
        repository: { repositoryId: "repo-1", provider: "github", owner: "o", name: "r", baseBranch: "main", baseCommitSha: "d".repeat(40) },
        requestOriginal: "change", requestNormalized: "change", state: "HUMAN_APPROVED", stateVersion: 12,
        manifestHash: sha256(`manifest:${mode}`), riskTier: "HIGH", humanGateRequired: true,
        createdAt: "2026-07-18T09:00:00.000Z", updatedAt: "2026-07-18T10:00:00.000Z", terminalAt: null,
      };
      const evidence = {
        runId, reviewerSessionId: "reviewer-1", reviewerDecision: "APPROVE" as const,
        classificationHash: sha256(`classification:${mode}`), classificationResult: "READY" as const,
        reviewerDiffHash: sha256(diff), reviewerEvidenceBundleHash: sha256(`bundle:${mode}`), reviewerIsolationVerified: true as const,
        evidenceBundleId: `bundle-${mode.toLowerCase()}`, evidenceBundleHash: sha256(`bundle:${mode}`), resultCommitSha: "b".repeat(40),
        allRequiredChecksPassed: true, openCriticalSecurityFindings: 0,
      };
      const approval = {
        approvalRequestId: `approval-${mode.toLowerCase()}`, runId, riskTier: run.riskTier,
        assignedReviewerId: "reviewer-1", requestedAt: run.createdAt, deadlineAt: "2026-07-20T10:00:00.000Z",
        reminderSchedule: [], timeoutAction: "HUMAN_REVIEW_REQUIRED", manifestHash: run.manifestHash!,
        diffHash: evidence.reviewerDiffHash, evidenceBundleHash: evidence.evidenceBundleHash,
        reviewerSessionId: evidence.reviewerSessionId, classificationHash: evidence.classificationHash,
        classificationResult: evidence.classificationResult, status: "APPROVED",
        approvalRevision: mode.startsWith("EXTENSION_") ? 2 : 1,
        verifiedCheckpointId: mode === "LEGACY_NULL" ? null : sha256(`checkpoint-id:${runId}`),
        verifiedCheckpointHash: mode === "LEGACY_NULL" ? null
          : mode === "STALE_HASH" ? sha256("stale-checkpoint-hash") : sha256(`checkpoint-hash:${runId}`),
      } as ApprovalRequestRecord;
      const rawSupervisor = {
        getRun: () => run,
        getPublicationEvidence: () => evidence,
        latestApprovalRequest: () => approval,
        listOpenDecisions: () => [],
      } as unknown as EngineerSupervisor;
      const supervisor = checkpointBoundSupervisor(rawSupervisor, runId);
      const validCheckpoint = supervisor.getVerifiedCandidateCheckpoint.bind(supervisor);
      const validDecisions = supervisor.listApprovalDecisions.bind(supervisor);
      Object.assign(supervisor, {
        async getVerifiedCandidateCheckpoint(reference: { runId: string } | { checkpointId: string }, attestor: typeof checkpointAttestor) {
          if (mode === "BAD_SIGNATURE") throw new Error("checkpoint attestation signature verification failed");
          if (mode === "MISSING_CHECKPOINT") return null;
          const signed = await validCheckpoint(reference, attestor);
          if (!signed) return null;
          const checkpoint = { ...signed.checkpoint };
          if (mode === "STALE_DIFF") checkpoint.diffHash = sha256("stale-diff");
          if (mode === "STALE_BASE") checkpoint.baseCommitSha = "e".repeat(40);
          if (mode === "STALE_RESULT") checkpoint.resultCommitSha = "c".repeat(40);
          if (mode === "STALE_CLASSIFICATION") checkpoint.classificationHash = sha256("stale-classification");
          if (mode === "STALE_EVIDENCE") checkpoint.evidenceBundleHash = sha256("stale-evidence");
          if (mode === "WRONG_RUN") checkpoint.runId = "wrong-run";
          if (mode === "WRONG_REPOSITORY") checkpoint.repositoryId = "wrong-repository";
          return { ...signed, checkpoint };
        },
        listApprovalDecisions(approvalRequestId: string) {
          const decisions = validDecisions(approvalRequestId);
          if (mode === "WRONG_APPROVAL_DECISION") {
            return decisions.map((decision) => ({ ...decision, decision: "REJECT" as const }));
          }
          if (mode === "STALE_APPROVAL_REVISION") {
            return decisions.map((decision) => ({ ...decision, expectedApprovalRevision: 1 }));
          }
          if (mode.startsWith("EXTENSION_") && decisions[0]) {
            const approvalDecision = { ...decisions[0], expectedApprovalRevision: 1 };
            const extensionDecision = {
              ...decisions[0],
              approvalDecisionId: `extension:${approvalRequestId}`,
              decision: "EXTEND" as const,
              expectedApprovalRevision: 0,
            };
            if (mode === "EXTENSION_WRONG_REQUEST") extensionDecision.approvalRequestId = "wrong-approval";
            if (mode === "EXTENSION_WRONG_PAIR") extensionDecision.expectedVerifiedCheckpointHash = sha256("wrong-extension-pair");
            if (mode === "EXTENSION_WRONG_ACTOR") extensionDecision.actorId = "wrong-reviewer";
            return mode === "EXTENSION_AFTER_APPROVAL"
              ? [approvalDecision, { ...extensionDecision, expectedApprovalRevision: 1 }]
              : [extensionDecision, approvalDecision];
          }
          return decisions;
        },
      });
      const calls = { inspect: 0, reconcile: 0, branch: 0, push: 0, pr: 0 };
      const manager = new EngineerPublicationManager({
        supervisor, artifactStore: new LocalArtifactStore({ root: join(root, "artifacts") }), diffForRun: () => diff,
        commandSigningSecret: "phase4-complete-authority-secret-at-least-32-bytes", checkpointAttestor,
        gitService: {
          async inspectBaseBranch() { calls.inspect += 1; throw new Error("must not inspect"); },
          async reconcilePublicationOperation() { calls.reconcile += 1; throw new Error("must not reconcile"); },
          async createRunBranch() { calls.branch += 1; throw new Error("must not create branch"); },
          async pushVerifiedCommit() { calls.push += 1; throw new Error("must not push"); },
          async createPullRequest() { calls.pr += 1; throw new Error("must not create PR"); },
        },
      });
      await expect(manager.resume(runId)).rejects.toThrow();
      expect(calls).toEqual({ inspect: 0, reconcile: 0, branch: 0, push: 0, pr: 0 });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("credentialed mutation revalidation rejects changed checkpoint authority after safe inspection", async () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-phase4-authority-revalidation-"));
    const harness = activePublicationHarness(root, { inspectMatches: [true] });
    const supervisor = harness.supervisor;
    const original = supervisor.getVerifiedCandidateCheckpoint.bind(supervisor);
    let reads = 0;
    Object.assign(supervisor, {
      async getVerifiedCandidateCheckpoint(reference: { runId: string } | { checkpointId: string }, attestor: typeof checkpointAttestor) {
        const signed = await original(reference, attestor);
        reads += 1;
        return reads < 3 || !signed ? signed : {
          ...signed,
          checkpoint: { ...signed.checkpoint, classificationHash: sha256("changed-after-inspection") },
        };
      },
    });
    await expect(harness.manager.start("run-active", "reviewer-1")).rejects.toThrow("complete publication authority");
    expect(harness.calls).toEqual({ inspect: 1, createBranch: 0, push: 0, createPr: 0 });
    rmSync(root, { recursive: true, force: true });
  });

  test("delayed checkpoint attestation refetches state before first inspection and credentialed mutation", async () => {
    for (const mode of ["BEFORE_INSPECTION", "BEFORE_MUTATION"] as const) {
      const root = mkdtempSync(join(tmpdir(), `zintus-phase4-delayed-state-${mode.toLowerCase()}-`));
      const harness = activePublicationHarness(root, { inspectMatches: [true] });
      const original = harness.supervisor.getVerifiedCandidateCheckpoint.bind(harness.supervisor);
      let reads = 0;
      let signal!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => { signal = resolve; });
      const released = new Promise<void>((resolve) => { release = resolve; });
      Object.assign(harness.supervisor, {
        async getVerifiedCandidateCheckpoint(reference: { runId: string } | { checkpointId: string }, attestor: typeof checkpointAttestor) {
          reads += 1;
          const shouldDelay = mode === "BEFORE_INSPECTION" ? reads === 2 : reads === 3;
          if (shouldDelay) {
            signal();
            await released;
          }
          return original(reference, attestor);
        },
      });
      const action = harness.manager.start("run-active", "reviewer-1");
      await started;
      harness.supervisor.transition({ nextState: "FAILED" } as never);
      release();
      await expect(action).rejects.toThrow(mode === "BEFORE_INSPECTION"
        ? "publication resume is not valid" : "publication authority is not valid");
      expect(harness.calls).toEqual({
        inspect: mode === "BEFORE_INSPECTION" ? 0 : 1,
        createBranch: 0, push: 0, createPr: 0,
      });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("every human action rejects a stale expected checkpoint before decision or Git", async () => {
    for (const action of ["APPROVE", "REQUEST_CHANGES", "REJECT", "EXTEND", "EXPIRE"] as const) {
      const root = mkdtempSync(join(tmpdir(), `zintus-phase4-stale-action-${action.toLowerCase()}-`));
      const diff = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n";
      const run: EngineerRun = {
        runId: `run-action-${action.toLowerCase()}`, userId: "user-1",
        repository: { repositoryId: "repo-1", provider: "github", owner: "o", name: "r", baseBranch: "main", baseCommitSha: "d".repeat(40) },
        requestOriginal: "change", requestNormalized: "change", state: "HUMAN_APPROVAL_PENDING", stateVersion: 11,
        manifestHash: sha256("manifest"), riskTier: "MEDIUM", humanGateRequired: true,
        createdAt: "2026-07-17T09:00:00.000Z", updatedAt: "2026-07-17T10:00:00.000Z", terminalAt: null,
      };
      const evidence = {
        runId: run.runId, reviewerSessionId: "reviewer-1", reviewerDecision: "APPROVE" as const,
        classificationHash: sha256("classification"), classificationResult: "READY" as const,
        reviewerDiffHash: sha256(diff), reviewerEvidenceBundleHash: sha256("bundle"), reviewerIsolationVerified: true,
        evidenceBundleId: "bundle-1", evidenceBundleHash: sha256("bundle"), resultCommitSha: "b".repeat(40),
        allRequiredChecksPassed: true, openCriticalSecurityFindings: 0,
      };
      const request: ApprovalRequestRecord = {
        approvalRequestId: "approval-1", runId: run.runId, riskTier: run.riskTier,
        assignedReviewerId: "reviewer-1", requestedAt: run.createdAt,
        deadlineAt: action === "EXPIRE" ? "2026-07-17T09:30:00.000Z" : "2026-07-17T11:00:00.000Z",
        reminderSchedule: [], timeoutAction: "HUMAN_REVIEW_REQUIRED", manifestHash: run.manifestHash!,
        diffHash: evidence.reviewerDiffHash, evidenceBundleHash: evidence.evidenceBundleHash,
        reviewerSessionId: evidence.reviewerSessionId, classificationHash: evidence.classificationHash,
        classificationResult: evidence.classificationResult, status: "PENDING",
        approvalRevision: 0,
        verifiedCheckpointId: sha256(`checkpoint-id:${run.runId}`),
        verifiedCheckpointHash: sha256("stale-checkpoint-hash"),
      };
      let decisionCalls = 0;
      let gitCalls = 0;
      const supervisor = {
        getRun: () => run, listOpenDecisions: () => [], getPublicationEvidence: () => evidence,
        latestApprovalRequest: () => request,
        decideApproval: () => { decisionCalls += 1; throw new Error("must not decide"); },
        extendApproval: () => { decisionCalls += 1; throw new Error("must not extend"); },
      } as unknown as EngineerSupervisor;
      const manager = new EngineerPublicationManager({
        supervisor: checkpointBoundSupervisor(supervisor, run.runId),
        artifactStore: new LocalArtifactStore({ root: join(root, "artifacts") }), diffForRun: () => diff,
        commandSigningSecret: "phase4-stale-action-secret-at-least-32-bytes", checkpointAttestor,
        now: () => new Date("2026-07-17T10:00:00.000Z"),
        gitService: {
          async inspectBaseBranch() { gitCalls += 1; throw new Error("must not inspect Git"); },
          async createRunBranch() { gitCalls += 1; throw new Error("must not create branch"); },
          async pushVerifiedCommit() { gitCalls += 1; throw new Error("must not push"); },
          async createPullRequest() { gitCalls += 1; throw new Error("must not create PR"); },
        },
      });
      const expected = expectedApproval(request);
      const operation = action === "APPROVE" ? manager.approve(run.runId, "reviewer-1", "approve", expected)
        : action === "REQUEST_CHANGES" ? manager.requestChanges(run.runId, "reviewer-1", "change", expected)
          : action === "REJECT" ? manager.reject(run.runId, "reviewer-1", "reject", expected)
            : action === "EXTEND" ? manager.extend(run.runId, "reviewer-1", "extend", 60, expected)
              : manager.expire(run.runId, expected);
      await expect(operation).rejects.toThrow("checkpoint authority");
      expect(decisionCalls).toBe(0);
      expect(gitCalls).toBe(0);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("every human action rejects a stale displayed revision before attestation, CAS, or Git", async () => {
    for (const action of ["APPROVE", "REQUEST_CHANGES", "REJECT", "EXTEND", "EXPIRE"] as const) {
      const root = mkdtempSync(join(tmpdir(), `zintus-phase4-displayed-cas-${action.toLowerCase()}-`));
      const runId = `run-displayed-${action.toLowerCase()}`;
      const checkpointId = sha256(`checkpoint-id:${runId}`);
      const checkpointHash = sha256(`checkpoint-hash:${runId}`);
      const request: ApprovalRequestRecord = {
        approvalRequestId: `approval-${action.toLowerCase()}`, runId, riskTier: "HIGH",
        assignedReviewerId: "reviewer-1", requestedAt: "2026-07-17T09:00:00.000Z",
        deadlineAt: action === "EXPIRE" ? "2026-07-17T09:30:00.000Z" : "2026-07-17T11:00:00.000Z",
        reminderSchedule: [], timeoutAction: "HUMAN_REVIEW_REQUIRED", manifestHash: sha256("manifest"),
        diffHash: sha256("diff"), evidenceBundleHash: sha256("bundle"), reviewerSessionId: "reviewer-1",
        classificationHash: sha256("classification"), classificationResult: "READY", status: "PENDING",
        approvalRevision: 2, verifiedCheckpointId: checkpointId, verifiedCheckpointHash: checkpointHash,
      };
      let authorityCalls = 0;
      let decisionCalls = 0;
      let gitCalls = 0;
      const supervisor = {
        isOptionalHardeningChild: () => false,
        getRun: () => ({ runId, state: "HUMAN_APPROVAL_PENDING" }),
        latestApprovalRequest: () => request,
        getVerifiedCandidateCheckpoint: async () => { authorityCalls += 1; throw new Error("must not attest"); },
        decideApproval: () => { decisionCalls += 1; throw new Error("must not decide"); },
        extendApproval: () => { decisionCalls += 1; throw new Error("must not extend"); },
      } as unknown as EngineerSupervisor;
      const manager = new EngineerPublicationManager({
        supervisor, artifactStore: new LocalArtifactStore({ root: join(root, "artifacts") }), diffForRun: () => "diff",
        commandSigningSecret: "phase4-browser-cas-secret-at-least-32-bytes", checkpointAttestor,
        now: () => new Date("2026-07-17T10:00:00.000Z"),
        gitService: {
          async inspectBaseBranch() { gitCalls += 1; throw new Error("must not inspect"); },
          async createRunBranch() { gitCalls += 1; throw new Error("must not branch"); },
          async pushVerifiedCommit() { gitCalls += 1; throw new Error("must not push"); },
          async createPullRequest() { gitCalls += 1; throw new Error("must not create PR"); },
        },
      });
      const stale = { ...expectedApproval(request), expectedApprovalRevision: 1 };
      const operation = action === "APPROVE" ? manager.approve(runId, "reviewer-1", "approve", stale)
        : action === "REQUEST_CHANGES" ? manager.requestChanges(runId, "reviewer-1", "change", stale)
          : action === "REJECT" ? manager.reject(runId, "reviewer-1", "reject", stale)
            : action === "EXTEND" ? manager.extend(runId, "reviewer-1", "extend", 60, stale)
              : manager.expire(runId, stale);
      await expect(operation).rejects.toMatchObject({ code: "ENGINEER_CANDIDATE_CHANGED", action: "REFRESH_APPROVAL" });
      expect({ authorityCalls, decisionCalls, gitCalls }).toEqual({ authorityCalls: 0, decisionCalls: 0, gitCalls: 0 });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("publishes a Reviewer escalation only after an exact bundle-bound human override", async () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-phase4-human-review-binding-"));
    const diff = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n";
    const evidenceBundleHash = `sha256:${"c".repeat(64)}`;
    let state: EngineerRun["state"] = "REVIEW_APPROVED";
    let events: Array<Record<string, unknown>> = [];
    const run = (): EngineerRun => ({
      runId: "run-human-review", userId: "user-1",
      repository: { repositoryId: "repo-1", provider: "github", owner: "o", name: "r", baseBranch: "main", baseCommitSha: "d".repeat(40) },
      requestOriginal: "change", requestNormalized: "change", state, stateVersion: 10,
      manifestHash: `sha256:${"a".repeat(64)}`, riskTier: "MEDIUM", humanGateRequired: true,
      createdAt: "2026-07-17T09:00:00.000Z", updatedAt: "2026-07-17T10:00:00.000Z", terminalAt: null,
    });
    const supervisor = {
      getRun: () => run(), listOpenDecisions: () => [], latestEventSequence: () => events.length,
      listEvents: () => events,
      getPublicationEvidence: () => ({
        runId: run().runId, reviewerSessionId: "reviewer-1", reviewerDecision: "HUMAN_REVIEW_REQUIRED",
        classificationHash: sha256("classification-human"), classificationResult: "HUMAN_REVIEW_REQUIRED",
        reviewerDiffHash: sha256(diff), reviewerEvidenceBundleHash: evidenceBundleHash, reviewerIsolationVerified: true,
        evidenceBundleId: "bundle-1", evidenceBundleHash, resultCommitSha: "b".repeat(40),
        allRequiredChecksPassed: true, openCriticalSecurityFindings: 0,
      }),
      recordApprovalRequest: (record: ApprovalRequestRecord) => record,
      transition: (input: { nextState: EngineerRun["state"] }) => { state = input.nextState; return { run: run() }; },
    } as unknown as EngineerSupervisor;
    const manager = new EngineerPublicationManager({
      supervisor: checkpointBoundSupervisor(supervisor, "run-human-review"),
      artifactStore: new LocalArtifactStore({ root: join(root, "artifacts") }),
      diffForRun: () => diff,
      commandSigningSecret: "phase4-human-review-signing-secret-at-least-32-bytes",
      checkpointAttestor,
      now: () => new Date("2026-07-17T10:00:00.000Z"),
      gitService: {
        async inspectBaseBranch() { throw new Error("not used"); },
        async createRunBranch() { throw new Error("not used"); },
        async pushVerifiedCommit() { throw new Error("not used"); },
        async createPullRequest() { throw new Error("not used"); },
      },
    });

    await expect(manager.start(run().runId, "reviewer-2"))
      .rejects.toThrow("deterministic review classification is not ready");
    events = [{
      nextState: "REVIEW_APPROVED", reasonCode: "HUMAN_REVIEW_APPROVED", actorType: "HUMAN",
      evidenceIds: ["bundle-1"],
    }];
    await expect(manager.start(run().runId, "reviewer-2"))
      .rejects.toThrow("deterministic review classification is not ready");
    expect(String(state)).toBe("REVIEW_APPROVED");
    rmSync(root, { recursive: true, force: true });
  });

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

  test("every Git operation and signed PR command carries the exact checkpoint pair", async () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-phase4-strict-publication-pair-"));
    const harness = activePublicationHarness(root, { inspectMatches: [true, true, true] });
    await expect(harness.manager.start("run-active", "reviewer-1")).resolves.toMatchObject({ status: "PUBLISHED" });
    const checkpointId = sha256("checkpoint-id:run-active");
    const checkpointHash = sha256("checkpoint-hash:run-active");
    const checkpointKey = checkpointHash.slice("sha256:".length);
    const operations = [...harness.operations.values()];
    expect(new Set(operations.map((operation) => operation.operationType)))
      .toEqual(new Set(["INSPECT_BASE", "CREATE_BRANCH", "PUSH_COMMIT", "CREATE_PR"]));
    expect(operations.length).toBe(6);
    for (const operation of operations) {
      expect(operation).toMatchObject({ verifiedCheckpointId: checkpointId, verifiedCheckpointHash: checkpointHash });
      expect(operation.idempotencyKey).toContain(`run-active:${checkpointKey}:`);
      expect(operation.idempotencyKey).toContain("b".repeat(40));
    }
    const commandArtifact = harness.artifacts.find((artifact) => artifact.type === "SUPERVISOR_PR_COMMAND");
    expect(commandArtifact).toBeDefined();
    const signed = SignedSupervisorPrCommandSchema.parse(JSON.parse(readFileSync(String(commandArtifact!.storageReference), "utf8")));
    expect(signed.command).toMatchObject({ verifiedCheckpointId: checkpointId, verifiedCheckpointHash: checkpointHash });
    const verify = (harness.manager as unknown as { verifySignature(input: unknown): boolean }).verifySignature.bind(harness.manager);
    expect(verify(signed)).toBe(true);
    expect(verify({ ...signed, command: { ...signed.command, verifiedCheckpointId: sha256("tampered-id") } })).toBe(false);
    expect(verify({ ...signed, command: { ...signed.command, verifiedCheckpointHash: sha256("tampered-hash") } })).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  test("checkpoint hash changes every publication operation namespace", async () => {
    const roots = [
      mkdtempSync(join(tmpdir(), "zintus-phase4-checkpoint-key-a-")),
      mkdtempSync(join(tmpdir(), "zintus-phase4-checkpoint-key-b-")),
    ];
    const branchKeys: string[] = [];
    for (const [index, root] of roots.entries()) {
      const harness = activePublicationHarness(root, { inspectMatches: [true, true, true] });
      if (index === 1) {
        const original = harness.supervisor.getVerifiedCandidateCheckpoint.bind(harness.supervisor);
        Object.assign(harness.supervisor, {
          async getVerifiedCandidateCheckpoint(reference: { runId: string } | { checkpointId: string }, attestor: typeof checkpointAttestor) {
            const signed = await original(reference, attestor);
            return signed ? { ...signed, checkpoint: {
              ...signed.checkpoint,
              checkpointId: sha256("replacement-checkpoint-id"),
              checkpointHash: sha256("replacement-checkpoint-hash"),
            } } : null;
          },
        });
      }
      await expect(harness.manager.start("run-active", "reviewer-1")).resolves.toMatchObject({ status: "PUBLISHED" });
      branchKeys.push([...harness.operations.values()].find((operation) => operation.operationType === "CREATE_BRANCH")!.idempotencyKey);
    }
    expect(branchKeys[0]).not.toBe(branchKeys[1]);
    expect(branchKeys[0]).toContain(sha256("checkpoint-hash:run-active").slice("sha256:".length));
    expect(branchKeys[1]).toContain(sha256("replacement-checkpoint-hash").slice("sha256:".length));
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  test("persists a non-retryable publication failure when the artifact budget is exhausted", async () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-phase4-artifact-limit-"));
    const harness = activePublicationHarness(root, { inspectMatches: [true], maxArtifactBytes: 1 });
    await expect(harness.manager.start("run-active", "reviewer-1")).rejects.toThrow("artifact exceeds");
    expect(harness.lastError()).toContain("artifact exceeds");
    expect(harness.failures).toContainEqual(expect.objectContaining({
      reasonCode: "PUBLICATION_ARTIFACT_LIMIT_EXCEEDED", retryable: false,
    }));
    expect(harness.state()).toBe("FAILED");
    const callsAfterFailure = { ...harness.calls };
    await expect(harness.manager.recoverPending()).resolves.toEqual({ resumedRunIds: [], failedRunIds: [] });
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
        classificationHash: sha256("classification-ready"), classificationResult: "READY",
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
      supervisor: checkpointBoundSupervisor(supervisor, "run-deferred"),
      artifactStore: new LocalArtifactStore({ root: join(root, "artifacts") }),
      diffForRun: () => diff,
      commandSigningSecret: "phase4-deferred-signing-secret-at-least-32-bytes",
      checkpointAttestor,
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

  test("a replacement manager recovers the exact same checkpoint once and completes idempotently", async () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-phase4-process-restart-same-checkpoint-"));
    const harness = restartPublicationHarness(root, "SUCCEEDED");
    const replacement = harness.restartManager();
    await expect(replacement.recoverPending()).resolves.toEqual({
      resumedRunIds: ["run-restart"], failedRunIds: [],
    });
    expect(harness.state()).toBe("COMPLETED");
    expect(harness.calls).toEqual({ reconcile: 1, createBranch: 0, push: 1, createPr: 1 });
    await expect(harness.restartManager().recoverPending()).resolves.toEqual({ resumedRunIds: [], failedRunIds: [] });
    expect(harness.calls).toEqual({ reconcile: 1, createBranch: 0, push: 1, createPr: 1 });
    rmSync(root, { recursive: true, force: true });
  });

  test("boot recovery marks checkpointless legacy authority manual and never retries Git", async () => {
    for (const legacyKind of ["OPERATION", "APPROVAL"] as const) {
      const root = mkdtempSync(join(tmpdir(), `zintus-phase4-recovery-legacy-${legacyKind.toLowerCase()}-`));
      const harness = restartPublicationHarness(root, "SUCCEEDED");
      if (legacyKind === "OPERATION") {
        const operation = harness.operations.get(harness.branchKey)!;
        harness.operations.delete(harness.branchKey);
        harness.operations.set(`git:branch:run-restart:${"b".repeat(40)}`, {
          ...operation,
          idempotencyKey: `git:branch:run-restart:${"b".repeat(40)}`,
          verifiedCheckpointId: null,
          verifiedCheckpointHash: null,
        });
      } else {
        Object.assign(harness.supervisor, {
          latestApprovalRequest: () => ({
            approvalRequestId: "legacy-approval-restart",
            verifiedCheckpointId: null,
            verifiedCheckpointHash: null,
          }),
        });
      }
      await expect(harness.restartManager().recoverPending()).resolves.toEqual({
        resumedRunIds: [], failedRunIds: ["run-restart"],
      });
      expect(harness.calls).toEqual({ reconcile: 0, createBranch: 0, push: 0, createPr: 0 });
      expect(harness.failures).toHaveLength(1);
      expect(harness.failures[0]).toMatchObject({
        reasonCode: "PUBLICATION_LEGACY_AUTHORITY_MANUAL_REVIEW", retryable: false,
      });
      expect(harness.lastError()).toContain("read-only");
      await expect(harness.restartManager().recoverPending()).resolves.toEqual({
        resumedRunIds: [], failedRunIds: ["run-restart"],
      });
      expect(harness.failures).toHaveLength(1);
      expect(harness.calls).toEqual({ reconcile: 0, createBranch: 0, push: 0, createPr: 0 });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("boot recovery rejects stale strict operation authority before reconciliation", async () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-phase4-recovery-stale-operation-"));
    const harness = restartPublicationHarness(root, "SUCCEEDED");
    const operation = harness.operations.get(harness.branchKey)!;
    harness.operations.set(harness.branchKey, {
      ...operation, verifiedCheckpointHash: sha256("stale-recovery-operation-checkpoint"),
    } as GitOperationRecord);
    await expect(harness.restartManager().recoverPending()).resolves.toEqual({
      resumedRunIds: [], failedRunIds: ["run-restart"],
    });
    expect(harness.calls).toEqual({ reconcile: 0, createBranch: 0, push: 0, createPr: 0 });
    expect(harness.operations.get(harness.branchKey)?.status).toBe("STARTED");
    rmSync(root, { recursive: true, force: true });
  });

  test("boot recovery makes an ambiguous remote result manual without repeating the mutation", async () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-phase4-recovery-ambiguous-"));
    const harness = restartPublicationHarness(root, "NOT_FOUND");
    await expect(harness.restartManager().recoverPending()).resolves.toEqual({
      resumedRunIds: [], failedRunIds: ["run-restart"],
    });
    expect(harness.state()).toBe("HUMAN_REVIEW_REQUIRED");
    expect(harness.calls).toEqual({ reconcile: 1, createBranch: 0, push: 0, createPr: 0 });
    rmSync(root, { recursive: true, force: true });
  });

  test("restart revalidates the same checkpoint before credentialed reconciliation", async () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-phase4-reconcile-authority-change-"));
    const harness = restartPublicationHarness(root, "SUCCEEDED");
    const supervisor = harness.supervisor;
    const original = supervisor.getVerifiedCandidateCheckpoint.bind(supervisor);
    let reads = 0;
    Object.assign(supervisor, {
      async getVerifiedCandidateCheckpoint(reference: { runId: string } | { checkpointId: string }, attestor: typeof checkpointAttestor) {
        const signed = await original(reference, attestor);
        reads += 1;
        return reads === 1 || !signed ? signed : {
          ...signed,
          checkpoint: { ...signed.checkpoint, evidenceBundleHash: sha256("changed-before-reconcile") },
        };
      },
    });
    await expect(harness.manager.resume("run-restart")).rejects.toThrow("complete publication authority");
    expect(harness.calls.reconcile).toBe(0);
    expect(harness.calls.createBranch).toBe(0);
    rmSync(root, { recursive: true, force: true });
  });

  test("delayed reconciliation attestation refetches state before provider recovery", async () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-phase4-delayed-reconcile-state-"));
    const harness = restartPublicationHarness(root, "SUCCEEDED");
    const original = harness.supervisor.getVerifiedCandidateCheckpoint.bind(harness.supervisor);
    let reads = 0;
    let signal!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { signal = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    Object.assign(harness.supervisor, {
      async getVerifiedCandidateCheckpoint(reference: { runId: string } | { checkpointId: string }, attestor: typeof checkpointAttestor) {
        reads += 1;
        if (reads === 2) {
          signal();
          await released;
        }
        return original(reference, attestor);
      },
    });
    const action = harness.manager.resume("run-restart");
    await started;
    harness.supervisor.transition({ nextState: "FAILED" } as never);
    release();
    await expect(action).rejects.toThrow("publication authority is not valid");
    expect(harness.calls.reconcile).toBe(0);
    expect(harness.calls.createBranch).toBe(0);
    rmSync(root, { recursive: true, force: true });
  });

  test("restart marks an unreconciled STARTED operation stale and requires human review", async () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-phase4-restart-stale-"));
    const harness = restartPublicationHarness(root, "NOT_FOUND");
    await expect(harness.manager.resume("run-restart")).rejects.toThrow("requires human recovery review");
    expect(harness.state()).toBe("HUMAN_REVIEW_REQUIRED");
    expect(harness.calls).toEqual({ reconcile: 1, createBranch: 0, push: 0, createPr: 0 });
    expect([...harness.operations.values()].find((operation) => operation.operationType === "CREATE_BRANCH"))
      .toMatchObject({ status: "STALE", errorCode: "RECONCILIATION_NOT_FOUND" });
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

  test("historical legacy publication rows remain readable but cannot reconcile or mutate", async () => {
    for (const status of ["STARTED", "SUCCEEDED"] as const) {
      const root = mkdtempSync(join(tmpdir(), `zintus-phase4-legacy-${status.toLowerCase()}-publication-`));
      const harness = restartPublicationHarness(root, "SUCCEEDED");
      const legacy = harness.operations.get(harness.branchKey)!;
      const historicalKey = `git:branch:run-restart:${"b".repeat(40)}`;
      harness.operations.delete(harness.branchKey);
      harness.operations.set(historicalKey, {
        ...legacy,
        idempotencyKey: historicalKey,
        status,
        remoteReference: status === "SUCCEEDED" ? "refs/heads/legacy-run-restart" : null,
        completedAt: status === "SUCCEEDED" ? "2026-07-14T10:01:00.000Z" : null,
        verifiedCheckpointId: null,
        verifiedCheckpointHash: null,
      });
      await expect(harness.manager.resume("run-restart"))
        .rejects.toThrow("legacy Git operation cannot resume, reconcile, or mutate publication");
      expect(harness.calls).toEqual({ reconcile: 0, createBranch: 0, push: 0, createPr: 0 });
      expect(harness.operations.get(historicalKey)).toMatchObject({
        status, verifiedCheckpointId: null, verifiedCheckpointHash: null,
      });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("conflicting checkpoint or approval replay fails before Git reconciliation", async () => {
    for (const conflict of ["CHECKPOINT", "APPROVAL"] as const) {
      const root = mkdtempSync(join(tmpdir(), `zintus-phase4-${conflict.toLowerCase()}-operation-conflict-`));
      const harness = restartPublicationHarness(root, "SUCCEEDED");
      const operation = harness.operations.get(harness.branchKey)!;
      const conflictingOperation = (conflict === "CHECKPOINT"
        ? { ...operation, verifiedCheckpointHash: sha256("different-checkpoint") }
        : { ...operation, approvalId: "different-approval" }) as GitOperationRecord;
      harness.operations.set(harness.branchKey, conflictingOperation);
      await expect(harness.manager.resume("run-restart"))
        .rejects.toThrow("publication operation replay does not match current classified authority");
      expect(harness.calls).toEqual({ reconcile: 0, createBranch: 0, push: 0, createPr: 0 });
      expect(harness.operations.get(harness.branchKey)?.status).toBe("STARTED");
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("COMPLETED and PR_CREATED fast replay validate exact PR authority before returning", async () => {
    for (const state of ["COMPLETED", "PR_CREATED"] as const) {
      for (const conflict of ["CHECKPOINT", "APPROVAL"] as const) {
        const root = mkdtempSync(join(tmpdir(), `zintus-phase4-${state.toLowerCase()}-${conflict.toLowerCase()}-replay-`));
        const harness = activePublicationHarness(root, { inspectMatches: [true, true, true] });
        await expect(harness.manager.start("run-active", "reviewer-1")).resolves.toMatchObject({ status: "PUBLISHED" });
        if (state === "PR_CREATED") harness.supervisor.transition({ nextState: "PR_CREATED" } as never);
        const pr = [...harness.operations.values()].find((operation) => operation.operationType === "CREATE_PR")!;
        harness.operations.set(pr.idempotencyKey, conflict === "CHECKPOINT"
          ? { ...pr, verifiedCheckpointHash: sha256("fast-replay-conflicting-checkpoint") } as GitOperationRecord
          : { ...pr, approvalId: "fast-replay-conflicting-approval" } as GitOperationRecord);
        const callsBeforeReplay = { ...harness.calls };
        await expect(harness.manager.resume("run-active"))
          .rejects.toThrow("publication operation replay does not match current classified authority");
        expect(harness.calls).toEqual(callsBeforeReplay);
        expect(harness.state()).toBe(state);
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test("an ambiguous remote-call failure is reconciled or made stale, never retried blindly", async () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-phase4-ambiguous-call-"));
    const harness = restartPublicationHarness(root, "NOT_FOUND", 5_000, false);
    await expect(harness.manager.resume("run-restart")).rejects.toThrow("requires human recovery review");
    expect(harness.state()).toBe("HUMAN_REVIEW_REQUIRED");
    expect(harness.calls).toEqual({ reconcile: 1, createBranch: 1, push: 0, createPr: 0 });
    expect([...harness.operations.values()].find((operation) => operation.operationType === "CREATE_BRANCH"))
      .toMatchObject({ status: "STALE", errorCode: "RECONCILIATION_NOT_FOUND" });
    await expect(harness.manager.resume("run-restart")).rejects.toThrow("not valid from HUMAN_REVIEW_REQUIRED");
    expect(harness.calls.createBranch).toBe(1);
    rmSync(root, { recursive: true, force: true });
  });

  test("never reuses a prior Git operation after classification authority changes on the same commit", async () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-phase4-reclassified-replay-"));
    const harness = restartPublicationHarness(root, "SUCCEEDED", 5_000, true, true);
    await expect(harness.manager.resume("run-restart"))
      .rejects.toThrow("publication operation replay does not match current classified authority");
    expect(harness.calls).toEqual({ reconcile: 0, createBranch: 0, push: 0, createPr: 0 });
    expect(harness.operations.get(harness.branchKey)?.status).toBe("STARTED");
    rmSync(root, { recursive: true, force: true });
  });

  test("expires a pending approval fail-closed and records the terminal human-review state", async () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-phase4-timeout-"));
    let state: EngineerRun["state"] = "HUMAN_APPROVAL_PENDING";
    let requestStatus: ApprovalRequestRecord["status"] = "PENDING";
    const failures: unknown[] = [];
    const request: ApprovalRequestRecord = {
      approvalRequestId: "approval-1", runId: "run-1", riskTier: "HIGH", assignedReviewerId: "reviewer-1",
      requestedAt: "2026-07-14T10:00:00.000Z", deadlineAt: "2026-07-14T11:00:00.000Z",
      reminderSchedule: [], timeoutAction: "HUMAN_REVIEW_REQUIRED",
      manifestHash: `sha256:${"a".repeat(64)}`, diffHash: sha256("expiry diff"),
      evidenceBundleHash: `sha256:${"c".repeat(64)}`, status: "PENDING",
      approvalRevision: 0,
      reviewerSessionId: "reviewer-1", classificationHash: sha256("classification-expiry"),
      classificationResult: "READY", verifiedCheckpointId: sha256("checkpoint-id:run-1"),
      verifiedCheckpointHash: sha256("checkpoint-hash:run-1"),
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
      getPublicationEvidence: () => ({
        runId: "run-1", reviewerSessionId: request.reviewerSessionId, reviewerDecision: "APPROVE",
        classificationHash: request.classificationHash, classificationResult: request.classificationResult,
        reviewerDiffHash: request.diffHash, reviewerEvidenceBundleHash: request.evidenceBundleHash,
        reviewerIsolationVerified: true, evidenceBundleId: "bundle-1", evidenceBundleHash: request.evidenceBundleHash,
        resultCommitSha: "b".repeat(40), allRequiredChecksPassed: true, openCriticalSecurityFindings: 0,
      }),
      latestApprovalRequest: () => ({ ...request, status: requestStatus }),
      decideApproval: (_decision: unknown, status: ApprovalRequestRecord["status"]) => { requestStatus = status; return _decision; },
      recordFailure: (failure: unknown) => { failures.push(failure); return failure; },
      transition: (input: { nextState: EngineerRun["state"] }) => { state = input.nextState; return { run: run() }; },
    } as unknown as EngineerSupervisor;
    const manager = new EngineerPublicationManager({
      supervisor: checkpointBoundSupervisor(supervisor, "run-1"), artifactStore: new LocalArtifactStore({ root: join(root, "artifacts") }), diffForRun: () => "expiry diff",
      commandSigningSecret: "phase4-timeout-signing-secret-at-least-32-bytes",
      checkpointAttestor,
      now: () => new Date("2026-07-14T12:00:00.000Z"),
      gitService: {
        async inspectBaseBranch() { throw new Error("unused"); }, async createRunBranch() { throw new Error("unused"); },
        async pushVerifiedCommit() { throw new Error("unused"); }, async createPullRequest() { throw new Error("unused"); },
      },
    });
    await manager.expire("run-1", expectedApproval(request));
    expect(String(requestStatus)).toBe("EXPIRED");
    expect(String(state)).toBe("HUMAN_REVIEW_REQUIRED");
    expect(failures).toHaveLength(1);
    rmSync(root, { recursive: true, force: true });
  });

  test("async checkpoint attestation cannot authorize a late approval or stale expiry after extension", async () => {
    for (const mode of ["APPROVE_CROSSES_DEADLINE", "EXPIRY_LOSES_TO_EXTENSION"] as const) {
      const root = mkdtempSync(join(tmpdir(), `zintus-phase4-delayed-attestor-${mode.toLowerCase()}-`));
      const runId = `run-delayed-${mode.toLowerCase()}`;
      const diff = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n";
      const manifestHash = sha256(`manifest:${mode}`);
      const evidenceBundleHash = sha256(`bundle:${mode}`);
      const classificationHash = sha256(`classification:${mode}`);
      const checkpointId = sha256(`checkpoint-id:${runId}`);
      const checkpointHash = sha256(`checkpoint-hash:${runId}`);
      let now = mode === "APPROVE_CROSSES_DEADLINE"
        ? new Date("2026-07-17T10:00:00.000Z")
        : new Date("2026-07-17T12:00:00.000Z");
      let request: ApprovalRequestRecord = {
        approvalRequestId: `approval-${mode.toLowerCase()}`, runId, riskTier: "MEDIUM",
        assignedReviewerId: "reviewer-1", requestedAt: "2026-07-17T09:00:00.000Z",
        deadlineAt: "2026-07-17T11:00:00.000Z", reminderSchedule: [],
        timeoutAction: "HUMAN_REVIEW_REQUIRED", manifestHash, diffHash: sha256(diff),
        evidenceBundleHash, reviewerSessionId: "reviewer-1", classificationHash,
        classificationResult: "READY", status: "PENDING", approvalRevision: 0,
        verifiedCheckpointId: checkpointId, verifiedCheckpointHash: checkpointHash,
      };
      const run = (): EngineerRun => ({
        runId, userId: "user-1",
        repository: { repositoryId: "repo-1", provider: "github", owner: "o", name: "r", baseBranch: "main", baseCommitSha: "d".repeat(40) },
        requestOriginal: "change", requestNormalized: "change", state: "HUMAN_APPROVAL_PENDING", stateVersion: 11,
        manifestHash, riskTier: "MEDIUM", humanGateRequired: true,
        createdAt: "2026-07-17T09:00:00.000Z", updatedAt: "2026-07-17T10:00:00.000Z", terminalAt: null,
      });
      let releaseAttestation!: () => void;
      let signalAttestation!: () => void;
      const attestationStarted = new Promise<void>((resolve) => { signalAttestation = resolve; });
      const attestationRelease = new Promise<void>((resolve) => { releaseAttestation = resolve; });
      const observedRevisions: number[] = [];
      let transitionCalls = 0;
      const supervisor = {
        isOptionalHardeningChild: () => false,
        getRun: () => run(),
        latestApprovalRequest: () => ({ ...request }),
        listOpenDecisions: () => [],
        getPublicationEvidence: () => ({
          runId, reviewerSessionId: "reviewer-1", reviewerDecision: "APPROVE",
          classificationHash, classificationResult: "READY", reviewerDiffHash: sha256(diff),
          reviewerEvidenceBundleHash: evidenceBundleHash, reviewerIsolationVerified: true,
          evidenceBundleId: "bundle-1", evidenceBundleHash, resultCommitSha: "b".repeat(40),
          allRequiredChecksPassed: true, openCriticalSecurityFindings: 0,
        }),
        async getVerifiedCandidateCheckpoint() {
          signalAttestation();
          await attestationRelease;
          return {
            checkpoint: {
              checkpointId, checkpointHash, runId, manifestHash, diffHash: sha256(diff), evidenceBundleHash,
              reviewerSessionId: "reviewer-1", classificationHash, classificationResult: "READY",
            },
            attestation: {},
          };
        },
        decideApproval: (decision: { expectedApprovalRevision: number }, status: ApprovalRequestRecord["status"]) => {
          observedRevisions.push(decision.expectedApprovalRevision);
          if (decision.expectedApprovalRevision !== request.approvalRevision) {
            throw new Error("approval revision conflict");
          }
          const deadline = new Date(request.deadlineAt).getTime();
          if (status === "EXPIRED" ? now.getTime() <= deadline : now.getTime() > deadline) {
            throw new Error("approval deadline conflict");
          }
          throw new Error("test expected the decision to remain fenced");
        },
        transition: () => { transitionCalls += 1; throw new Error("must not transition"); },
        recordFailure: () => { throw new Error("must not record a timeout after losing the CAS"); },
      } as unknown as EngineerSupervisor;
      const manager = new EngineerPublicationManager({
        supervisor, artifactStore: new LocalArtifactStore({ root: join(root, "artifacts") }),
        diffForRun: () => diff, commandSigningSecret: "phase4-delayed-attestor-secret-at-least-32-bytes",
        checkpointAttestor, now: () => now,
        gitService: {
          async inspectBaseBranch() { throw new Error("unused"); }, async createRunBranch() { throw new Error("unused"); },
          async pushVerifiedCommit() { throw new Error("unused"); }, async createPullRequest() { throw new Error("unused"); },
        },
      });
      const action = mode === "APPROVE_CROSSES_DEADLINE"
        ? manager.approve(runId, "reviewer-1", "approve", expectedApproval(request))
        : manager.expire(runId, expectedApproval(request));
      await attestationStarted;
      if (mode === "APPROVE_CROSSES_DEADLINE") {
        now = new Date("2026-07-17T12:00:00.000Z");
      } else {
        request = { ...request, deadlineAt: "2026-07-18T11:00:00.000Z", approvalRevision: 1 };
      }
      releaseAttestation();
      await expect(action).rejects.toThrow(mode === "APPROVE_CROSSES_DEADLINE"
        ? "approval deadline conflict" : "approval revision conflict");
      expect(observedRevisions).toEqual([0]);
      expect(transitionCalls).toBe(0);
      expect(request.status).toBe("PENDING");
      rmSync(root, { recursive: true, force: true });
    }
  });
});
