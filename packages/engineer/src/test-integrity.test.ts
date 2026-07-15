import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LocalArtifactStore,
  TaskManifestSchema,
  TestIntegrityGuard,
  TestIntegrityViolationError,
  compareTestBaseline,
  createTestBaseline,
  sha256,
  type ArtifactRecord,
  type EngineerSupervisor,
  type TaskManifest,
  type WorkspaceRecord,
} from "./index.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function repository(): { root: string; sha: string } {
  const root = mkdtempSync(join(tmpdir(), "zintus-test-integrity-"));
  roots.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "tests"), { recursive: true });
  writeFileSync(join(root, "src", "value.ts"), "export const value = 1;\n");
  writeFileSync(join(root, "tests", "value.test.ts"), "import { value } from '../src/value';\nif (value !== 1) throw new Error('bad');\n");
  writeFileSync(join(root, "package.json"), "{\"scripts\":{\"test\":\"bun test\"}}\n");
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "config", "user.email", "test@zintus.local"]);
  execFileSync("git", ["-C", root, "config", "user.name", "Zintus Test"]);
  execFileSync("git", ["-C", root, "add", "."]);
  execFileSync("git", ["-C", root, "commit", "-qm", "base"]);
  return { root, sha: execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim() };
}

function fixture(allowedPaths: string[] = ["src/**"]): { manifest: TaskManifest; workspace: WorkspaceRecord; root: string } {
  const repo = repository();
  const content = {
    manifestVersion: 1,
    runId: "run-test-integrity",
    repository: { repositoryId: "repo-1", provider: "local" as const, owner: "local", name: "fixture", baseBranch: "main", baseCommitSha: repo.sha },
    request: { original: "Change value", normalized: "Change src/value.ts to export value 2." },
    acceptanceCriteria: [{ criterionId: "criterion-1", statement: "Value is two", verificationMethod: "unit test", priority: "MUST" as const }],
    testPlan: [{ testId: "test-1", criterionIds: ["criterion-1"], type: "UNIT" as const, description: "Run tests", command: "bun test" }],
    allowedPaths,
    deniedPaths: [],
    allowedCommands: ["bun test"],
    prohibitedCommands: [],
    riskTier: "MEDIUM" as const,
    humanGateRequired: true,
    retryBudgets: { sameFailureAttempts: 2, builderRepairAttempts: 4, reviewerFixAttempts: 2, plannerRestarts: 1, sandboxProvisioningAttempts: 3, transientModelAttempts: 3 },
    timeBudgetSeconds: 600,
    tokenBudget: 100_000,
    costBudgetUsd: 10,
    createdAt: "2026-07-14T12:00:00.000Z",
  };
  const manifest = TaskManifestSchema.parse({ ...content, manifestHash: sha256(content) });
  const workspace = {
    workspaceIdentity: "workspace-test-integrity",
    runId: manifest.runId,
    repositoryRoot: repo.root,
    workspaceRoot: repo.root,
    branchName: "zintus/engineer/test-integrity",
    baseCommitSha: repo.sha,
    originUrl: null,
    createdAt: content.createdAt,
  } satisfies WorkspaceRecord;
  return { manifest, workspace, root: repo.root };
}

function fakeSupervisor(): { supervisor: EngineerSupervisor; artifacts: ArtifactRecord[] } {
  const artifacts: ArtifactRecord[] = [];
  const supervisor = {
    recordArtifact(record: ArtifactRecord) { artifacts.push(record); return record; },
    listArtifacts(runId: string) { return artifacts.filter((artifact) => artifact.runId === runId); },
  } as unknown as EngineerSupervisor;
  return { supervisor, artifacts };
}

describe("Supervisor test integrity baselines", () => {
  test("hashes the exact tracked test surface and classifies it from the frozen plan", () => {
    const { manifest, workspace } = fixture(["src/**", "tests/new.test.ts"]);
    const baseline = createTestBaseline({ runId: manifest.runId, manifest, workspace, now: () => new Date("2026-07-14T12:01:00.000Z") });

    expect(baseline.entries.map((entry) => entry.path)).toEqual(["package.json", "tests/value.test.ts"]);
    expect(baseline.entries.every((entry) => entry.classification === "IMMUTABLE")).toBe(true);
    expect(baseline.baselineHash).toBe(sha256({
      policyVersion: baseline.policyVersion,
      runId: baseline.runId,
      manifestHash: baseline.manifestHash,
      baseCommitSha: baseline.baseCommitSha,
      entries: baseline.entries,
      createdAt: baseline.createdAt,
    }));
  });

  test("blocks edits and deletion of immutable baseline tests", () => {
    const { manifest, workspace, root } = fixture();
    const baseline = createTestBaseline({ runId: manifest.runId, manifest, workspace });
    writeFileSync(join(root, "tests", "value.test.ts"), "// weakened by Builder\n");

    const comparison = compareTestBaseline({ baseline, workspaceRoot: root, stage: "POST_BUILDER" });
    expect(comparison.passed).toBe(false);
    expect(comparison.immutableChanges).toEqual(["tests/value.test.ts"]);
  });

  test("refuses to bless a test file that changed before preflight baseline capture", () => {
    const { manifest, workspace, root } = fixture();
    writeFileSync(join(root, "tests", "value.test.ts"), "// changed before Supervisor capture\n");
    execFileSync("git", ["-C", root, "add", "tests/value.test.ts"]);

    expect(() => createTestBaseline({ runId: manifest.runId, manifest, workspace }))
      .toThrow("workspace contains changes before test baseline capture");
  });

  test("allows plan-authorized test edits and separately reports Builder-authored tests", () => {
    const { manifest, workspace, root } = fixture(["src/**", "tests/**"]);
    const baseline = createTestBaseline({ runId: manifest.runId, manifest, workspace });
    writeFileSync(join(root, "tests", "value.test.ts"), "// stronger authorized test\n");
    writeFileSync(join(root, "tests", "edge.test.ts"), "// Builder-authored edge case\n");

    const comparison = compareTestBaseline({ baseline, workspaceRoot: root, stage: "POST_BUILDER" });
    expect(comparison.passed).toBe(true);
    expect(comparison.authorizedChanges).toEqual(["tests/value.test.ts"]);
    expect(comparison.builderAuthoredTests).toEqual(["tests/edge.test.ts"]);
  });

  test("detects a verification command that mutates any protected test-surface file", () => {
    const { manifest, workspace, root } = fixture(["src/**", "tests/**"]);
    const { supervisor, artifacts } = fakeSupervisor();
    const artifactStore = new LocalArtifactStore({ root: join(root, ".zintus-artifacts") });
    const guard = TestIntegrityGuard.createAndRecord({ supervisor, artifactStore, manifest, workspace });
    const before = guard.captureCommandSnapshot();
    writeFileSync(join(root, "tests", "value.test.ts"), "// test command mutation\n");

    expect(() => guard.assertCommandDidNotMutate(before, "bun test")).toThrow(TestIntegrityViolationError);
    expect(artifacts.map((artifact) => artifact.type)).toEqual(["TEST_BASELINE_MANIFEST", "TEST_COMMAND_MUTATION"]);
  });
});
