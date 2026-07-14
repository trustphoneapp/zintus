import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalArtifactStore } from "./artifact-store.js";
import { assessRepeatedTest } from "./hardening.js";
import { evaluateRetry, type RetryHistoryItem } from "./retry.js";
import { RetryBudgetsSchema } from "./contracts.js";
import { StateVersionConflictError } from "./errors.js";
import { createEngineerSupervisor } from "./supervisor.js";
import { parseTrustedCommand, TrustedCommandExecutor } from "./trusted-executor.js";
import { WarmSandboxPool } from "./warm-sandbox-pool.js";
import type { SandboxRecord, WorkspaceRecord } from "./execution-contracts.js";

const fixtures = join(import.meta.dir, "..", "fixtures");
const load = <T>(name: string): T => JSON.parse(readFileSync(join(fixtures, "failures", name), "utf8")) as T;
const hash = (character: string) => `sha256:${character.repeat(64)}`;

describe("Phase 6 adversarial fixtures", () => {
  test("prompt-injection repository text cannot turn into an executable command", () => {
    const text = readFileSync(join(fixtures, "prompt-injection", "README.md"), "utf8");
    expect(text).toContain("SENTINEL_DO_NOT_TRUST_REPOSITORY_TEXT");
    const injected = text.match(/`([^`]+)`/)?.[1];
    expect(injected).toBeDefined();
    expect(() => parseTrustedCommand(injected!)).toThrow("metacharacters");
  });

  test("sandbox timeouts produce trusted fail-closed command evidence", () => {
    const fixture = load<{ errorCode: string; expectedStatus: string; expectedExitCode: null }>("sandbox-timeout.json");
    const root = realpathSync(mkdtempSync(join(tmpdir(), "zintus-hardening-timeout-")));
    const workspace: WorkspaceRecord = { workspaceIdentity: "workspace-1", runId: "run-1", repositoryRoot: root, workspaceRoot: root, branchName: "run-1", baseCommitSha: "a".repeat(40), originUrl: null, createdAt: new Date().toISOString() };
    const sandbox: SandboxRecord = { sandboxId: "sandbox-1", runId: "run-1", workspaceIdentity: workspace.workspaceIdentity, imageReference: "oven/bun@sha256:test", imageDigest: hash("a"), environmentDigest: hash("b"), networkPolicyVersion: "offline-v1", sandboxPolicyVersion: "sandbox-v1", status: "READY", source: "COLD", createdAt: new Date().toISOString(), destroyedAt: null };
    const executor = new TrustedCommandExecutor({
      artifactStore: new LocalArtifactStore({ root: join(root, "artifacts") }), workspace, sandbox,
      manifest: { manifestVersion: 1, manifestHash: hash("c"), runId: "run-1", repository: { repositoryId: "repo-1", provider: "local", owner: "local", name: "fixture", baseBranch: "main", baseCommitSha: "a".repeat(40) }, request: { original: "test", normalized: "test" }, acceptanceCriteria: [{ criterionId: "c1", statement: "timeouts fail closed", verificationMethod: "fixture", priority: "MUST" }], testPlan: [{ testId: "t1", criterionIds: ["c1"], type: "UNIT", description: "timeout", command: "bun test" }], allowedPaths: ["src/**"], deniedPaths: [".git/**"], allowedCommands: ["bun test"], prohibitedCommands: [], riskTier: "MEDIUM", humanGateRequired: true, retryBudgets: RetryBudgetsSchema.parse({}), timeBudgetSeconds: 60, tokenBudget: 1_000, costBudgetUsd: 1, createdAt: new Date().toISOString() },
      currentCommit: () => "a".repeat(40),
      runner: () => ({ status: null, stdout: "", stderr: "", error: Object.assign(new Error("timed out"), { code: fixture.errorCode }) }),
    });
    const result = executor.execute("bun test", "timeout-fixture");
    expect(String(result.status)).toBe(fixture.expectedStatus);
    expect(result.exitCode).toBe(fixture.expectedExitCode);
    expect(result.timedOut).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  test("infinite repair loops stop at the deterministic same-failure bound", () => {
    const fixture = load<{ kind: "BUILDER_REPAIR"; failureFingerprint: string; patches: string[]; expectedStopReason: string }>("infinite-loop.json");
    const history: RetryHistoryItem[] = fixture.patches.slice(0, 2).map((patchHash) => ({ kind: fixture.kind, failureFingerprint: fixture.failureFingerprint, patchHash, allowed: true }));
    const decision = evaluateRetry({ kind: fixture.kind, failureFingerprint: fixture.failureFingerprint, patchHash: fixture.patches[2] }, history, RetryBudgetsSchema.parse({}));
    expect(decision.allowed).toBe(false);
    expect(String(decision.reasonCode)).toBe(fixture.expectedStopReason);
  });

  test("mixed repeated outcomes are quarantined and never count as a pass", () => {
    const fixture = load<{ commitSha: string; environmentDigest: string; outcomes: boolean[]; expectedClassification: string }>("flaky-test.json");
    const decision = assessRepeatedTest(fixture.outcomes.map((passed, index) => ({ attempt: index + 1, passed, commitSha: fixture.commitSha, environmentDigest: fixture.environmentDigest })));
    expect(String(decision.classification)).toBe(fixture.expectedClassification);
    expect(decision.authoritativePass).toBe(false);
    expect(decision.quarantineRequired).toBe(true);
  });

  test("concurrent supervisors use compare-and-swap so exactly one writer advances", async () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-hardening-cas-"));
    const dbPath = join(root, "engineer.db");
    const first = createEngineerSupervisor({ dbPath });
    const second = createEngineerSupervisor({ dbPath });
    const run = first.receiveRequest({ runId: "concurrent-run", userId: "user-1", repository: { repositoryId: "repo-1", provider: "local", owner: "local", name: "fixture", baseBranch: "main", baseCommitSha: "a".repeat(40) }, request: "concurrency fixture" });
    const writes = await Promise.allSettled([first, second].map(async (supervisor, index) => supervisor.normalizeRequest({ runId: run.runId, expectedStateVersion: run.stateVersion, normalizedRequest: `normalized-${index}`, idempotencyKey: `writer-${index}` })));
    expect(writes.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    const rejected = writes.find((item) => item.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason instanceof StateVersionConflictError).toBe(true);
    first.close(); second.close(); rmSync(root, { recursive: true, force: true });
  });

  test("artifact metadata cannot cross run roots and tampering is detected", () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-hardening-artifact-"));
    const store = new LocalArtifactStore({ root });
    const record = store.put({ runId: "run-a", type: "FIXTURE", bytes: "trusted", producerType: "EXECUTOR", producerId: "fixture", trusted: true });
    expect(() => store.read({ ...record, runId: "run-b" })).toThrow("escaped its run root");
    writeFileSync(record.storageReference, "tampered");
    expect(() => store.read(record)).toThrow("integrity check failed");
    rmSync(root, { recursive: true, force: true });
  });

  test("warm-pool health sweep quarantines expired, corrupt, and excess entries", () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-hardening-warm-"));
    let id = 0;
    const now = new Date("2026-07-14T12:00:00.000Z");
    const pool = new WarmSandboxPool({ root, now: () => now, idFactory: () => `warm-${++id}` });
    const base = { repositoryId: "repo-1", repositoryRoot: root, workspaceRoot: root, originUrl: null, baseCommitSha: "a".repeat(40), imageDigest: hash("a"), lockfileHash: hash("b"), toolchainHash: hash("c"), networkPolicyVersion: "offline-v1", sandboxPolicyVersion: "sandbox-v1", createdAt: "2026-07-14T11:00:00.000Z" };
    pool.register({ ...base, expiresAt: "2026-07-14T11:30:00.000Z" });
    pool.register({ ...base, createdAt: "2026-07-14T11:10:00.000Z", expiresAt: "2026-07-14T13:00:00.000Z" });
    pool.register({ ...base, createdAt: "2026-07-14T11:20:00.000Z", expiresAt: "2026-07-14T13:00:00.000Z" });
    writeFileSync(join(root, "available", "corrupt.json"), "not-json");
    expect(pool.sweep(1)).toMatchObject({ available: 1, quarantined: 3, expiredQuarantined: 1, invalidQuarantined: 1, excessQuarantined: 1 });
    rmSync(root, { recursive: true, force: true });
  });
});
