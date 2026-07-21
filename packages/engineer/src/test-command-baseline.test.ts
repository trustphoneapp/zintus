import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandExecutionRecordSchema } from "./execution-contracts.js";
import { isBaselineRunnableCommand } from "./execution-manager.js";
import { sha256 } from "./hash.js";
import { failureLabels, isInheritedBaselineFailure, TestCommandBaselineSchema } from "./test-command-baseline.js";
import type { LocalArtifactStore } from "./artifact-store.js";

const NOW = "2026-07-20T17:00:00.000Z";
const HASH = `sha256:${"a".repeat(64)}`;

function record() {
  const artifact = (id: string) => ({ artifactId: id, runId: "run", type: "COMMAND_STDERR", sha256: HASH,
    producerType: "EXECUTOR" as const, producerId: "sandbox", storageReference: id, sizeBytes: 1, trusted: true, createdAt: NOW });
  return CommandExecutionRecordSchema.parse({
    commandExecutionId: "command", runId: "run", sandboxId: "sandbox", command: "bun test", executorId: "sandbox",
    exitCode: 1, timedOut: false, startedAt: NOW, finishedAt: NOW, stdoutArtifact: artifact("stdout"), stderrArtifact: artifact("stderr"),
    environmentDigest: HASH, commitSha: "a".repeat(40), status: "FAILED", idempotencyKey: "key",
  });
}

function baseline(labels: string[], output: string) {
  const content = { policyVersion: "engineer-command-baseline-v1" as const, runId: "run", manifestHash: HASH,
    entries: [{ testId: "regression", command: "bun test", status: "FAILED" as const, failureLabels: labels, outputFingerprint: sha256(output) }], createdAt: NOW };
  return TestCommandBaselineSchema.parse({ ...content, baselineHash: sha256(content) });
}

describe("command outcome baseline", () => {
  test("extracts stable Bun failure names without timing noise", () => {
    expect(failureLabels("(fail) existing suite > remains broken [12.4ms]\n(fail) another failure [1ms]"))
      .toEqual(["another failure", "existing suite > remains broken"]);
  });

  test("treats an unchanged red full suite as inherited but blocks a new failing name", () => {
    const inherited = "(fail) existing suite > remains broken [12ms]";
    const store = { read: (artifact: { artifactId: string }) => Buffer.from(artifact.artifactId === "stderr" ? inherited : "") } as unknown as LocalArtifactStore;
    const existing = record();
    expect(isInheritedBaselineFailure({ baseline: baseline(failureLabels(inherited), inherited), testId: "regression", record: existing, artifactStore: store })).toBe(true);
    const changed = "(fail) existing suite > remains broken [12ms]\n(fail) scheduler > new regression [2ms]";
    const changedStore = { read: (artifact: { artifactId: string }) => Buffer.from(artifact.artifactId === "stderr" ? changed : "") } as unknown as LocalArtifactStore;
    expect(isInheritedBaselineFailure({ baseline: baseline(failureLabels(inherited), inherited), testId: "regression", record: existing, artifactStore: changedStore })).toBe(false);
  });

  test("admits only base-runnable checks to the no-cost preflight", () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-baseline-command-"));
    try {
      mkdirSync(join(root, "test"), { recursive: true });
      writeFileSync(join(root, "test", "existing.test.ts"), "export {};\n");
      expect(isBaselineRunnableCommand("bun run test", root)).toBe(true);
      expect(isBaselineRunnableCommand("bun test", root)).toBe(true);
      expect(isBaselineRunnableCommand("bun test test/existing.test.ts", root)).toBe(true);
      // Existing source directories are broad suites, not exact test targets.
      // They must never bypass the no-cost base health check.
      expect(isBaselineRunnableCommand("bun test test", root)).toBe(false);
      // The Builder has not created this task-specific file yet, so this must
      // not turn into a false baseline/environment failure.
      expect(isBaselineRunnableCommand("bun test test/new-feature.test.ts", root)).toBe(false);
      expect(isBaselineRunnableCommand("bun test ../outside.test.ts", root)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
