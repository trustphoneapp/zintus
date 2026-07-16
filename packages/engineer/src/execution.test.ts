import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  BuilderNoProgressError,
  BudgetPausedError,
  CodexBuilder,
  DockerSandboxManager,
  EngineerExecutionManager,
  EngineerWorkerLeaseManager,
  EngineerSupervisor,
  GitWorkspaceManager,
  LocalArtifactStore,
  MAX_BUILDER_TOOL_CALLS_PER_RESPONSE,
  MAX_BUILDER_TOOL_CALLS_PER_RUN,
  BUILDER_CONTEXT_COMPACTION_THRESHOLD_TOKENS,
  BUILDER_MAX_OUTPUT_TOKENS,
  MAX_BUILDER_MODEL_TOOL_OUTPUT_BYTES,
  OpenAIResponsesTransport,
  countResponseInputTokens,
  estimateResponseInputTokens,
  isProviderModelTimeout,
  modelRetryBackoffMs,
  OfflineDependencyBundle,
  OFFLINE_DEPENDENCY_MANIFEST,
  TaskManifestSchema,
  TrustedCommandExecutor,
  WarmSandboxPool,
  isManifestPathAllowed,
  resolveEngineerModel,
  resolveManifestPath,
  sha256,
  workspaceLockfileHash,
  hashDependencyTree,
  type ResponsesTransport,
  type BuilderContinuation,
  type SandboxRecord,
  type TaskManifest,
  type WorkspaceRecord,
} from "./index.js";
import { transitionToPlanReadyForTest } from "./test-planning-evidence.js";

const roots: string[] = [];

const bunGitSpawn = ((command: string, args: readonly string[]) => {
  const capture = mkdtempSync(join(tmpdir(), "zintus-test-git-"));
  const stdoutPath = join(capture, "stdout");
  const stderrPath = join(capture, "stderr");
  const result = Bun.spawnSync([
    "/bin/sh", "-c", 'out="$1"; err="$2"; shift 2; "$@" >"$out" 2>"$err"',
    "zintus-test-git", stdoutPath, stderrPath, command, ...args,
  ], { stdout: "ignore", stderr: "ignore" });
  const stdout = readFileSync(stdoutPath, "utf8");
  const stderr = readFileSync(stderrPath, "utf8");
  rmSync(capture, { recursive: true, force: true });
  return {
    pid: result.pid,
    status: result.exitCode,
    signal: result.signalCode == null ? null : String(result.signalCode),
    stdout,
    stderr,
    output: [null, stdout, stderr],
    error: undefined,
  };
}) as typeof import("node:child_process").spawnSync;
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "zintus-engineer-phase2-")));
  roots.push(root);
  return root;
}

function initRepository(root: string, includeLockfile = false): { sha: string; path: string } {
  const path = join(root, "repository");
  mkdirSync(join(path, "src"), { recursive: true });
  writeFileSync(join(path, "src", "value.ts"), "export const value = 1;\n");
  if (includeLockfile) writeFileSync(join(path, "bun.lock"), '{"lockfileVersion":1}\n');
  execFileSync("git", ["init", "-q", path]);
  execFileSync("git", ["-C", path, "config", "user.email", "test@zintus.local"]);
  execFileSync("git", ["-C", path, "config", "user.name", "Zintus Test"]);
  execFileSync("git", ["-C", path, "add", "."]);
  execFileSync("git", ["-C", path, "commit", "-qm", "base"]);
  const head = readFileSync(join(path, ".git", "HEAD"), "utf8").trim();
  if (!head.startsWith("ref: ")) throw new Error("fixture HEAD is unexpectedly detached");
  const sha = readFileSync(join(path, ".git", head.slice(5)), "utf8").trim();
  return { path, sha };
}

function manifest(runId: string, sha: string, overrides: Partial<TaskManifest> = {}): TaskManifest {
  const content = {
    manifestVersion: 1,
    runId,
    repository: {
      repositoryId: "repo-1",
      provider: "local" as const,
      owner: "local",
      name: "fixture",
      baseBranch: "main",
      baseCommitSha: sha,
    },
    request: { original: "Change value", normalized: "Change src/value.ts to export value 2." },
    acceptanceCriteria: [{
      criterionId: "criterion-1", statement: "Value is two", verificationMethod: "unit test", priority: "MUST" as const,
    }],
    testPlan: [{
      testId: "test-1", criterionIds: ["criterion-1"], type: "UNIT" as const,
      description: "Run tests", command: "bun run test",
    }],
    allowedPaths: ["src/**"],
    deniedPaths: [],
    allowedCommands: ["bun run test"],
    prohibitedCommands: [],
    riskTier: "MEDIUM" as const,
    humanGateRequired: true,
    retryBudgets: {
      sameFailureAttempts: 2, builderRepairAttempts: 4, reviewerFixAttempts: 2,
      plannerRestarts: 1, sandboxProvisioningAttempts: 3, transientModelAttempts: 3,
    },
    timeBudgetSeconds: 600,
    tokenBudget: 100_000,
    costBudgetUsd: 10,
    createdAt: "2026-07-14T12:00:00.000Z",
  };
  return TaskManifestSchema.parse({ ...content, ...overrides, manifestHash: sha256({ ...content, ...overrides }) });
}

function records(root: string, runId: string, sha: string): {
  workspace: WorkspaceRecord;
  sandbox: SandboxRecord;
} {
  const workspace = {
    workspaceIdentity: "workspace-1", runId, repositoryRoot: root, workspaceRoot: root,
    branchName: "zintus/engineer/test", baseCommitSha: sha, originUrl: null,
    createdAt: "2026-07-14T12:00:00.000Z",
  } satisfies WorkspaceRecord;
  const sandbox = {
    sandboxId: "sandbox-1", runId, workspaceIdentity: workspace.workspaceIdentity,
    imageReference: `oven/bun@sha256:${"a".repeat(64)}`,
    imageDigest: `sha256:${"a".repeat(64)}`,
    environmentDigest: `sha256:${"b".repeat(64)}`,
    networkPolicyVersion: "network-v1", sandboxPolicyVersion: "sandbox-v1",
    status: "READY" as const, source: "COLD" as const,
    createdAt: "2026-07-14T12:00:00.000Z", destroyedAt: null,
  } satisfies SandboxRecord;
  return { workspace, sandbox };
}

describe("Phase 2 immutable artifacts", () => {
  test("stores content-addressed bytes and detects later tampering", () => {
    const root = temporaryRoot();
    const store = new LocalArtifactStore({ root: join(root, "artifacts"), idFactory: () => "artifact-1" });
    const record = store.put({
      runId: "run-1", type: "COMMAND_STDOUT", bytes: "trusted output",
      producerType: "EXECUTOR", producerId: "sandbox-1", trusted: true,
    });
    expect(record.sha256).toBe(`sha256:${record.storageReference.split("/").at(-1)}`);
    expect(record.sha256).toBe("sha256:ddf0f2a1a25187e39d547b4c3bb3ff9a5442dc2f7d5e7ad7593409d9c733ad52");
    expect(store.read(record).toString()).toBe("trusted output");
    writeFileSync(record.storageReference, "tampered");
    expect(() => store.read(record)).toThrow("integrity check failed");
  });

  test("enforces the configured artifact size cap", () => {
    const root = temporaryRoot();
    const store = new LocalArtifactStore({ root, maxArtifactBytes: 3 });
    expect(() => store.put({
      runId: "run-1", type: "LOG", bytes: "four", producerType: "SYSTEM", producerId: "system", trusted: true,
    })).toThrow("byte limit");
  });

  test("rejects aggregate run artifacts before writing beyond the run cap", () => {
    const root = temporaryRoot();
    const store = new LocalArtifactStore({ root, maxArtifactBytes: 4, maxRunArtifactBytes: 8 });
    store.put({
      runId: "run-1", type: "LOG", bytes: "four", producerType: "SYSTEM", producerId: "system", trusted: true,
    });
    expect(() => store.put({
      runId: "run-1", type: "LOG", bytes: "more", producerType: "SYSTEM", producerId: "system", trusted: true,
    })).toThrow("run artifacts exceed");
    expect(store.put({
      runId: "run-2", type: "LOG", bytes: "more", producerType: "SYSTEM", producerId: "system", trusted: true,
    }).sizeBytes).toBe(4);
  });
});

describe("Phase 2 exact-base Git workspaces", () => {
  test("creates a distinct run branch at the exact requested commit", () => {
    const root = temporaryRoot();
    const repository = initRepository(root);
    const manager = new GitWorkspaceManager({ workspaceRoot: join(root, "workspaces"), gitSpawn: bunGitSpawn });
    const workspace = manager.create({ runId: "run-1", repositoryRoot: repository.path, baseCommitSha: repository.sha });
    expect(manager.currentCommit(workspace)).toBe(repository.sha);
    expect(workspace.branchName).toStartWith("zintus/engineer/run-1-");
    expect(workspace.workspaceRoot).not.toBe(repository.path);
    manager.remove(workspace);
  });

  test("rejects a base SHA that does not exist", () => {
    const root = temporaryRoot();
    const repository = initRepository(root);
    const manager = new GitWorkspaceManager({ workspaceRoot: join(root, "workspaces"), gitSpawn: bunGitSpawn });
    expect(() => manager.create({
      runId: "run-1", repositoryRoot: repository.path, baseCommitSha: "0".repeat(40),
    })).toThrow();
  });
});

describe("Phase 2 manifest file boundary", () => {
  test("honors allowed and denied globs and permanently blocks .git", () => {
    const task = manifest("run-1", "1".repeat(40), { deniedPaths: ["src/private/**"] });
    expect(isManifestPathAllowed("src/value.ts", task)).toBe(true);
    expect(isManifestPathAllowed("src/private/key.ts", task)).toBe(false);
    expect(() => isManifestPathAllowed(".git/config", task)).toThrow(".git");
  });

  test("keeps explicit deny rules authoritative over broad allow rules", () => {
    const task = manifest("run-1", "1".repeat(40), {
      allowedPaths: ["src/**"],
      deniedPaths: ["src/private/**"],
    });
    expect(isManifestPathAllowed("src/public/value.ts", task)).toBe(true);
    expect(isManifestPathAllowed("src/private/key.ts", task)).toBe(false);
  });

  test("rejects a symlink even when its apparent path is allowed", () => {
    const root = temporaryRoot();
    mkdirSync(join(root, "src"));
    symlinkSync("/tmp", join(root, "src", "escape"));
    expect(() => resolveManifestPath(root, "src/escape", manifest("run-1", "1".repeat(40)))).toThrow("symlinks");
  });

  test("rejects a write parent whose canonical path only shares the root prefix", () => {
    const root = mkdtempSync(join(tmpdir(), "engineer-root-"));
    const sibling = `${root}-sibling`;
    mkdirSync(sibling, { recursive: true });
    mkdirSync(join(root, "src"));
    symlinkSync(sibling, join(root, "src", "linked"));
    const task = manifest("run-prefix", "1".repeat(40), { allowedPaths: ["src/**"] });
    expect(() => resolveManifestPath(root, "src/linked/new.txt", task, true)).toThrow("write parent resolved outside workspace root");
  });
});

describe("Phase 2 trusted executor", () => {
  test("runs an exact manifest command without a shell and captures trusted artifacts", () => {
    const root = temporaryRoot();
    const { workspace, sandbox } = records(root, "run-1", "1".repeat(40));
    let invocation: unknown[] = [];
    const executor = new TrustedCommandExecutor({
      artifactStore: new LocalArtifactStore({ root: join(root, "artifacts") }),
      workspace, sandbox, manifest: manifest("run-1", "1".repeat(40)), currentCommit: () => "1".repeat(40),
      runner(executable, args, options) {
        invocation = [executable, args, options.cwd];
        return { status: 0, stdout: "1 pass", stderr: "" };
      },
    });
    const result = executor.execute("bun run test", "command-1");
    expect(invocation).toEqual(["bun", ["run", "test"], root]);
    expect(result.status).toBe("SUCCEEDED");
    expect(result.environmentDigest).toBe(sandbox.environmentDigest);
    expect(readFileSync(result.stdoutArtifact.storageReference, "utf8")).toBe("1 pass");
    expect(executor.execute("bun run test", "command-1")).toEqual(result);
  });

  test("rejects shell injection before invoking a runner", () => {
    const root = temporaryRoot();
    const { workspace, sandbox } = records(root, "run-1", "1".repeat(40));
    let invoked = false;
    const task = manifest("run-1", "1".repeat(40), { allowedCommands: ["bun run test && rm -rf ."] });
    const executor = new TrustedCommandExecutor({
      artifactStore: new LocalArtifactStore({ root: join(root, "artifacts") }), workspace, sandbox, manifest: task,
      currentCommit: () => "1".repeat(40), runner: () => { invoked = true; return { status: 0, stdout: "", stderr: "" }; },
    });
    expect(() => executor.execute("bun run test && rm -rf .", "command-1")).toThrow("metacharacters");
    expect(invoked).toBe(false);
  });
});

describe("Phase 2 Docker sandbox", () => {
  test("pins the image and wraps commands in a hardened offline container", () => {
    const root = temporaryRoot();
    const repository = initRepository(root);
    const workspaceManager = new GitWorkspaceManager({ workspaceRoot: join(root, "workspaces"), gitSpawn: bunGitSpawn });
    const digest = `sha256:${"a".repeat(64)}`;
    const calls: string[][] = [];
    const dockerSpawn = ((executable: string, args: string[]) => {
      calls.push([executable, ...args]);
      if (args[0] === "info") return { status: 0, stdout: "27", stderr: "" };
      if (args[0] === "image") return { status: 0, stdout: `[\"oven/bun@${digest}\"]`, stderr: "" };
      return { status: 0, stdout: "ok", stderr: "" };
    }) as typeof import("node:child_process").spawnSync;
    const manager = new DockerSandboxManager({
      workspaceManager, imageReference: `oven/bun@${digest}`, imageDigest: digest, dockerSpawn,
    });
    const sandbox = manager.provision({ runId: "run-1", repositoryRoot: repository.path, baseCommitSha: repository.sha });
    sandbox.commandRunner("bun", ["run", "test"], {
      cwd: sandbox.workspace.workspaceRoot, timeoutMs: 1_000, maxOutputBytes: 1_000, env: { PATH: "/bin" },
    });
    const run = calls.find((call) => call[1] === "run")!;
    expect(run).toContain("--network=none");
    expect(run).toContain("--read-only");
    expect(run).toContain("--cap-drop=ALL");
    expect(run).toContain("no-new-privileges");
    expect(run).toContain("1000:1000");
    expect(run).toContain("--env");
    expect(run).toContain("PATH=/bin");
    expect(run).toContain(`type=bind,src=${sandbox.workspace.workspaceRoot},dst=/workspace`);
    expect(run.some((argument) => argument.endsWith("dst=/workspace,rw"))).toBe(false);
    manager.destroy(sandbox);
  });

  test("atomically claims a validated warm workspace once and never returns it to the pool", () => {
    const root = temporaryRoot();
    const repository = initRepository(root);
    const workspaceManager = new GitWorkspaceManager({
      workspaceRoot: join(root, "workspaces"), gitSpawn: bunGitSpawn,
    });
    const digest = `sha256:${"a".repeat(64)}`;
    const dockerSpawn = ((_: string, args: string[]) => {
      if (args[0] === "info") return { status: 0, stdout: "27", stderr: "" };
      if (args[0] === "image") return { status: 0, stdout: `[\"oven/bun@${digest}\"]`, stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    }) as typeof import("node:child_process").spawnSync;
    const pool = new WarmSandboxPool({ root: join(root, "warm-pool") });
    const manager = new DockerSandboxManager({
      workspaceManager,
      imageReference: `oven/bun@${digest}`,
      imageDigest: digest,
      dockerSpawn,
      warmPool: {
        pool,
        lockfileHash: workspaceLockfileHash(repository.path),
        toolchainHash: sha256("bun-toolchain-v1"),
      },
    });
    manager.prewarm({
      repositoryId: "repo-1", repositoryRoot: repository.path, baseCommitSha: repository.sha,
    });
    const claim = manager.claimWarm({
      runId: "run-warm", repositoryId: "repo-1", repositoryRoot: repository.path, baseCommitSha: repository.sha,
    });
    expect(claim.status).toBe("CLAIMED");
    if (claim.status !== "CLAIMED") throw new Error("warm claim unexpectedly failed");
    expect(claim.sandbox.record.source).toBe("WARM");
    expect(manager.claimWarm({
      runId: "run-warm-2", repositoryId: "repo-1", repositoryRoot: repository.path, baseCommitSha: repository.sha,
    }).status).toBe("UNAVAILABLE");
    expect(manager.destroy(claim.sandbox).status).toBe("DESTROYED");
  });
});

describe("Phase 2 offline dependency bundle", () => {
  test("requires production bundles to match the exact repository commit", async () => {
    const root = temporaryRoot();
    const repository = initRepository(root, true);
    const bundleRoot = join(root, "commit-bound-bundle");
    mkdirSync(join(bundleRoot, "node_modules", "fixture"), { recursive: true });
    writeFileSync(join(bundleRoot, "node_modules", "fixture", "index.js"), "export {};\n");
    const lockfileHash = workspaceLockfileHash(repository.path);
    const toolchainHash = sha256("commit-bound-toolchain");
    const contentHash = await hashDependencyTree(join(bundleRoot, "node_modules"));
    writeFileSync(join(bundleRoot, OFFLINE_DEPENDENCY_MANIFEST), JSON.stringify({
      schemaVersion: 1, lockfileHash, toolchainHash, contentHash, nodeModulesPath: "node_modules",
    }));
    expect(() => new OfflineDependencyBundle({
      root: bundleRoot, expectedLockfileHash: lockfileHash, expectedToolchainHash: toolchainHash, expectedRepositoryCommit: repository.sha,
    })).toThrow("not bound to a repository commit");
    writeFileSync(join(bundleRoot, OFFLINE_DEPENDENCY_MANIFEST), JSON.stringify({
      schemaVersion: 2, lockfileHash, toolchainHash, repositoryCommit: "f".repeat(40), contentHash, nodeModulesPath: "node_modules",
    }));
    expect(() => new OfflineDependencyBundle({
      root: bundleRoot, expectedLockfileHash: lockfileHash, expectedToolchainHash: toolchainHash, expectedRepositoryCommit: repository.sha,
    })).toThrow("repository commit mismatch");
  });

  test("binds dependency bytes to the exact lockfile and detects later tampering", async () => {
    const root = temporaryRoot();
    const repository = initRepository(root, true);
    const bundleRoot = join(root, "dependency-bundle");
    mkdirSync(join(bundleRoot, "node_modules", "fixture"), { recursive: true });
    writeFileSync(join(bundleRoot, "node_modules", "fixture", "index.js"), "export const fixture = true;\n");
    const contentHash = await hashDependencyTree(join(bundleRoot, "node_modules"));
    const lockfileHash = workspaceLockfileHash(repository.path);
    const toolchainHash = sha256("bun-test-toolchain");
    writeFileSync(join(bundleRoot, OFFLINE_DEPENDENCY_MANIFEST), JSON.stringify({
      schemaVersion: 1, lockfileHash, toolchainHash, contentHash, nodeModulesPath: "node_modules",
    }));
    const bundle = new OfflineDependencyBundle({ root: bundleRoot, expectedLockfileHash: lockfileHash, expectedToolchainHash: toolchainHash });
    await expect(bundle.verify()).resolves.toBeUndefined();
    writeFileSync(join(bundle.nodeModulesRoot, "fixture", "index.js"), "tampered\n");
    await expect(bundle.verify()).rejects.toThrow("content hash mismatch");
  });

  test("fails closed without a bundle and mounts an admitted bundle read-only", async () => {
    const root = temporaryRoot();
    const repository = initRepository(root, true);
    const workspaceManager = new GitWorkspaceManager({ workspaceRoot: join(root, "workspaces"), gitSpawn: bunGitSpawn });
    const digest = `sha256:${"d".repeat(64)}`;
    const imageReference = `oven/bun@${digest}`;
    const dockerCalls: string[][] = [];
    const dockerRunAsync = async (args: string[]) => {
      dockerCalls.push(args);
      if (args[0] === "info") return { status: 0, signal: null, stdout: "27.0", stderr: "" };
      if (args[0] === "image") return { status: 0, signal: null, stdout: JSON.stringify([`oven/bun@${digest}`]), stderr: "" };
      return { status: 0, signal: null, stdout: "ok", stderr: "" };
    };
    const withoutBundle = new DockerSandboxManager({ workspaceManager, imageReference, imageDigest: digest, dockerRunAsync });
    await expect(withoutBundle.provisionColdAsync({ runId: "run-no-deps", repositoryRoot: repository.path, baseCommitSha: repository.sha }))
      .rejects.toThrow("require an immutable offline dependency bundle");

    const bundleRoot = join(root, "dependency-bundle");
    mkdirSync(join(bundleRoot, "node_modules", "fixture"), { recursive: true });
    writeFileSync(join(bundleRoot, "node_modules", "fixture", "index.js"), "export {};\n");
    const lockfileHash = workspaceLockfileHash(repository.path);
    const toolchainHash = sha256("bun-test-toolchain");
    writeFileSync(join(bundleRoot, OFFLINE_DEPENDENCY_MANIFEST), JSON.stringify({
      schemaVersion: 1, lockfileHash, toolchainHash,
      contentHash: await hashDependencyTree(join(bundleRoot, "node_modules")), nodeModulesPath: "node_modules",
    }));
    const offlineDependencies = new OfflineDependencyBundle({ root: bundleRoot, expectedLockfileHash: lockfileHash, expectedToolchainHash: toolchainHash });
    const manager = new DockerSandboxManager({ workspaceManager, imageReference, imageDigest: digest, dockerRunAsync, offlineDependencies });
    const sandbox = await manager.provisionColdAsync({ runId: "run-with-deps", repositoryRoot: repository.path, baseCommitSha: repository.sha });
    await sandbox.commandRunnerAsync!("bun", ["test"], { cwd: sandbox.workspace.workspaceRoot, timeoutMs: 1_000, maxOutputBytes: 1024, env: {} });
    const runArgs = dockerCalls.find((args) => args[0] === "run") ?? [];
    expect(runArgs).toContain("--network=none");
    expect(runArgs).toContain(`type=bind,src=${sandbox.workspace.workspaceRoot},dst=/workspace`);
    expect(runArgs.some((argument) => argument.endsWith("dst=/workspace,rw"))).toBe(false);
    expect(runArgs).toContain(`type=bind,src=${offlineDependencies.nodeModulesRoot},dst=/workspace/node_modules,readonly`);
    await manager.destroyAsync(sandbox);
  });
});

describe("Phase 2 Codex Builder", () => {
  test("stops repeated identical command failures before exhausting tool rounds", async () => {
    const root = temporaryRoot();
    const repository = initRepository(root);
    const workspaceManager = new GitWorkspaceManager({ workspaceRoot: join(root, "no-progress-workspaces"), gitSpawn: bunGitSpawn });
    const workspace = workspaceManager.create({ runId: "run-no-progress", repositoryRoot: repository.path, baseCommitSha: repository.sha });
    const task = manifest("run-no-progress", repository.sha);
    const { sandbox } = records(workspace.workspaceRoot, task.runId, repository.sha);
    const executor = new TrustedCommandExecutor({
      artifactStore: new LocalArtifactStore({ root: join(root, "no-progress-artifacts") }),
      workspace, sandbox, manifest: task,
      currentCommit: () => workspaceManager.currentCommit(workspace),
      runner: () => ({ status: 2, stdout: "", stderr: "same dependency failure" }),
    });
    let calls = 0;
    const builder = new CodexBuilder({
      manifest: task, workspace, workspaceManager, executor,
      transport: { async create() { calls += 1; return {
        id: `no-progress-${calls}`,
        output: [{ type: "function_call", call_id: `no-progress-call-${calls}`, name: "run_command", arguments: JSON.stringify({ command: "bun run test" }) }],
      }; } },
    });
    await expect(builder.run()).rejects.toBeInstanceOf(BuilderNoProgressError);
    expect(calls).toBe(2);
    workspaceManager.remove(workspace);
  });

  test("stops alternating tool failures after two model rounds without semantic progress", async () => {
    const root = temporaryRoot();
    const repository = initRepository(root);
    const workspaceManager = new GitWorkspaceManager({ workspaceRoot: join(root, "alternating-failure-workspaces"), gitSpawn: bunGitSpawn });
    const workspace = workspaceManager.create({ runId: "run-alternating-failures", repositoryRoot: repository.path, baseCommitSha: repository.sha });
    const task = manifest("run-alternating-failures", repository.sha);
    const { sandbox } = records(workspace.workspaceRoot, task.runId, repository.sha);
    const executor = new TrustedCommandExecutor({
      artifactStore: new LocalArtifactStore({ root: join(root, "alternating-failure-artifacts") }),
      workspace, sandbox, manifest: task,
      currentCommit: () => workspaceManager.currentCommit(workspace),
      runner: () => { throw new Error("an unauthorized command must never reach the runner"); },
    });
    let calls = 0;
    const builder = new CodexBuilder({
      manifest: task, workspace, workspaceManager, executor,
      transport: { async create() {
        calls += 1;
        return calls === 1
          ? { id: "policy-failure", output: [{
            type: "function_call", call_id: "policy-failure-call", name: "run_command",
            arguments: JSON.stringify({ command: "bun run unauthorized" }),
          }] }
          : { id: "path-failure", output: [{
            type: "function_call", call_id: "path-failure-call", name: "read_file",
            arguments: JSON.stringify({ path: "../outside.ts" }),
          }] };
      } },
    });
    await expect(builder.run()).rejects.toThrow("no semantic progress in 2 consecutive model rounds");
    expect(calls).toBe(2);
    workspaceManager.remove(workspace);
  });

  test("does not treat write counters as progress when a round restores the candidate diff", async () => {
    const root = temporaryRoot();
    const repository = initRepository(root);
    const workspaceManager = new GitWorkspaceManager({ workspaceRoot: join(root, "no-op-mutation-workspaces"), gitSpawn: bunGitSpawn });
    const workspace = workspaceManager.create({ runId: "run-no-op-mutations", repositoryRoot: repository.path, baseCommitSha: repository.sha });
    const task = manifest("run-no-op-mutations", repository.sha);
    const { sandbox } = records(workspace.workspaceRoot, task.runId, repository.sha);
    const executor = new TrustedCommandExecutor({
      artifactStore: new LocalArtifactStore({ root: join(root, "no-op-mutation-artifacts") }),
      workspace, sandbox, manifest: task,
      currentCommit: () => workspaceManager.currentCommit(workspace),
      runner: () => ({ status: 0, stdout: "", stderr: "" }),
    });
    let calls = 0;
    const builder = new CodexBuilder({
      manifest: task, workspace, workspaceManager, executor,
      transport: { async create() {
        calls += 1;
        return { id: `no-op-mutation-${calls}`, output: [
          { type: "function_call", call_id: `change-${calls}`, name: "write_file", arguments: JSON.stringify({
            path: "src/value.ts", content: "export const value = 2;\n",
          }) },
          { type: "function_call", call_id: `restore-${calls}`, name: "write_file", arguments: JSON.stringify({
            path: "src/value.ts", content: "export const value = 1;\n",
          }) },
        ] };
      } },
    });
    await expect(builder.run()).rejects.toThrow("no semantic progress in 2 consecutive model rounds");
    expect(calls).toBe(2);
    expect(await workspaceManager.diffAsync(workspace)).toBe("");
    workspaceManager.remove(workspace);
  });

  test("rolls back candidate mutations authored by an allowed repository command", async () => {
    const root = temporaryRoot();
    const repository = initRepository(root);
    const workspaceManager = new GitWorkspaceManager({ workspaceRoot: join(root, "command-mutation-workspaces"), gitSpawn: bunGitSpawn });
    const workspace = workspaceManager.create({ runId: "run-command-mutation", repositoryRoot: repository.path, baseCommitSha: repository.sha });
    const task = manifest("run-command-mutation", repository.sha);
    const { sandbox } = records(workspace.workspaceRoot, task.runId, repository.sha);
    const executor = new TrustedCommandExecutor({
      artifactStore: new LocalArtifactStore({ root: join(root, "command-mutation-artifacts") }),
      workspace, sandbox, manifest: task,
      currentCommit: () => workspaceManager.currentCommit(workspace),
      runner: () => {
        writeFileSync(join(workspace.workspaceRoot, "src", "value.ts"), "export const value = 999;\n");
        return { status: 0, stdout: "tests passed", stderr: "" };
      },
    });
    let calls = 0;
    const builder = new CodexBuilder({
      manifest: task, workspace, workspaceManager, executor,
      transport: { async create() {
        calls += 1;
        return { id: `command-mutation-${calls}`, output: [{
          type: "function_call", call_id: `command-mutation-call-${calls}`, name: "run_command",
          arguments: JSON.stringify({ command: "bun run test" }),
        }] };
      } },
    });
    await expect(builder.run()).rejects.toThrow("no semantic progress in 2 consecutive model rounds");
    expect(readFileSync(join(workspace.workspaceRoot, "src", "value.ts"), "utf8")).toBe("export const value = 1;\n");
    expect(await workspaceManager.diffAsync(workspace)).toBe("");
    expect(calls).toBe(2);
    workspaceManager.remove(workspace);
  });

  test("bounds large tool results before they enter the next paid model request", async () => {
    const root = temporaryRoot();
    const repository = initRepository(root);
    writeFileSync(join(repository.path, "src", "large.ts"), "x".repeat(MAX_BUILDER_MODEL_TOOL_OUTPUT_BYTES * 2));
    execFileSync("git", ["-C", repository.path, "add", "src/large.ts"]);
    execFileSync("git", ["-C", repository.path, "commit", "-m", "large fixture"]);
    const baseCommitSha = execFileSync("git", ["-C", repository.path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const workspaceManager = new GitWorkspaceManager({ workspaceRoot: join(root, "bounded-output-workspaces"), gitSpawn: bunGitSpawn });
    const workspace = workspaceManager.create({ runId: "run-bounded-output", repositoryRoot: repository.path, baseCommitSha });
    const task = manifest("run-bounded-output", baseCommitSha);
    const { sandbox } = records(workspace.workspaceRoot, task.runId, baseCommitSha);
    const executor = new TrustedCommandExecutor({
      artifactStore: new LocalArtifactStore({ root: join(root, "bounded-output-artifacts") }),
      workspace, sandbox, manifest: task,
      currentCommit: () => workspaceManager.currentCommit(workspace),
      runner: () => ({ status: 0, stdout: "", stderr: "" }),
    });
    let calls = 0;
    const builder = new CodexBuilder({
      manifest: task, workspace, workspaceManager, executor,
      transport: { async create(request) {
        calls += 1;
        if (calls === 1) return { id: "bounded-output-read", output: [{
          type: "function_call", call_id: "bounded-output-read-call", name: "read_file",
          arguments: JSON.stringify({ path: "src/large.ts" }),
        }] };
        const serialized = JSON.stringify(request.input);
        expect(serialized).toContain("MODEL_VIEW_TRUNCATED");
        expect(Buffer.byteLength(serialized, "utf8")).toBeLessThan(MAX_BUILDER_MODEL_TOOL_OUTPUT_BYTES + 4_000);
        return { id: "bounded-output-finish", output: [], output_text: "Inspected bounded source context." };
      } },
    });
    await builder.run();
    expect(calls).toBe(2);
    workspaceManager.remove(workspace);
  });

  test("resumes a durable Builder continuation without replaying completed paid rounds", async () => {
    const root = temporaryRoot();
    const repository = initRepository(root);
    const workspaceManager = new GitWorkspaceManager({ workspaceRoot: join(root, "continuation-workspaces"), gitSpawn: bunGitSpawn });
    const workspace = workspaceManager.create({ runId: "run-continuation", repositoryRoot: repository.path, baseCommitSha: repository.sha });
    const task = manifest("run-continuation", repository.sha);
    const { sandbox } = records(workspace.workspaceRoot, task.runId, repository.sha);
    const executor = new TrustedCommandExecutor({
      artifactStore: new LocalArtifactStore({ root: join(root, "continuation-artifacts") }),
      workspace, sandbox, manifest: task,
      currentCommit: () => workspaceManager.currentCommit(workspace),
      runner: () => ({ status: 0, stdout: "", stderr: "" }),
    });
    let paidCalls = 0;
    let reservations = 0;
    let continuation: BuilderContinuation | undefined;
    const interrupted = new CodexBuilder({
      manifest: task, workspace, workspaceManager, executor,
      transport: { async create() {
        paidCalls += 1;
        return { id: "continuation-write", output: [{
          type: "function_call", call_id: "continuation-write-call", name: "write_file",
          arguments: JSON.stringify({ path: "src/value.ts", content: "export const value = 2;\n" }),
        }] };
      } },
      reserveModelCall: () => {
        reservations += 1;
        if (reservations === 2) throw new BudgetPausedError(task.runId, "continuation checkpoint test");
        return `reservation-${reservations}`;
      },
      onContinuation: (checkpoint) => { continuation = checkpoint; },
    });
    await expect(interrupted.run()).rejects.toThrow("continuation checkpoint test");
    expect(paidCalls).toBe(1);
    expect(continuation).toBeDefined();

    const result = await new CodexBuilder({
      manifest: task, workspace, workspaceManager, executor, continuation,
      transport: { async create(request) {
        paidCalls += 1;
        expect(JSON.stringify(request.input)).toContain("continuation-write-call");
        return { id: "continuation-finish", output: [], output_text: "Resumed from the durable tool transcript." };
      } },
    }).run();
    expect(paidCalls).toBe(2);
    expect(result.responseIds).toEqual(["continuation-write", "continuation-finish"]);
    expect(result.changedFiles).toEqual(["src/value.ts"]);
    workspaceManager.remove(workspace);
  });

  test("rejects a response above its tool-call ceiling before executing any call", async () => {
    const root = temporaryRoot();
    const repository = initRepository(root);
    const workspaceManager = new GitWorkspaceManager({ workspaceRoot: join(root, "response-call-limit-workspaces"), gitSpawn: bunGitSpawn });
    const workspace = workspaceManager.create({ runId: "run-response-call-limit", repositoryRoot: repository.path, baseCommitSha: repository.sha });
    const task = manifest("run-response-call-limit", repository.sha);
    const { sandbox } = records(workspace.workspaceRoot, task.runId, repository.sha);
    const executor = new TrustedCommandExecutor({
      artifactStore: new LocalArtifactStore({ root: join(root, "response-call-limit-artifacts") }),
      workspace, sandbox, manifest: task,
      currentCommit: () => workspaceManager.currentCommit(workspace),
      runner: () => ({ status: 0, stdout: "", stderr: "" }),
    });
    const builder = new CodexBuilder({
      manifest: task, workspace, workspaceManager, executor,
      transport: { async create() { return {
        id: "too-many-calls",
        output: Array.from({ length: MAX_BUILDER_TOOL_CALLS_PER_RESPONSE + 1 }, (_, index) => ({
          type: "function_call", call_id: `call-${index}`, name: "write_file",
          arguments: JSON.stringify({ path: "src/value.ts", content: `export const value = ${index + 2};\n` }),
        })),
      }; } },
    });
    await expect(builder.run()).rejects.toThrow(`${MAX_BUILDER_TOOL_CALLS_PER_RESPONSE}-call per-response tool limit`);
    expect(readFileSync(join(workspace.workspaceRoot, "src", "value.ts"), "utf8")).toBe("export const value = 1;\n");
    workspaceManager.remove(workspace);
  });

  test("rejects calls above the Builder-run ceiling before executing the crossing response", async () => {
    const root = temporaryRoot();
    const repository = initRepository(root);
    const workspaceManager = new GitWorkspaceManager({ workspaceRoot: join(root, "run-call-limit-workspaces"), gitSpawn: bunGitSpawn });
    const workspace = workspaceManager.create({ runId: "run-call-limit", repositoryRoot: repository.path, baseCommitSha: repository.sha });
    const task = manifest("run-call-limit", repository.sha);
    const { sandbox } = records(workspace.workspaceRoot, task.runId, repository.sha);
    const executor = new TrustedCommandExecutor({
      artifactStore: new LocalArtifactStore({ root: join(root, "run-call-limit-artifacts") }),
      workspace, sandbox, manifest: task,
      currentCommit: () => workspaceManager.currentCommit(workspace),
      runner: () => ({ status: 0, stdout: "", stderr: "" }),
    });
    let response = 0;
    const builder = new CodexBuilder({
      manifest: task, workspace, workspaceManager, executor,
      transport: { async create() {
        response += 1;
        const count = response <= MAX_BUILDER_TOOL_CALLS_PER_RUN / MAX_BUILDER_TOOL_CALLS_PER_RESPONSE
          ? MAX_BUILDER_TOOL_CALLS_PER_RESPONSE
          : 1;
        return { id: `run-limit-${response}`, output: Array.from({ length: count }, (_, index) => ({
          type: "function_call", call_id: `run-limit-${response}-${index}`, name: "write_file",
          arguments: JSON.stringify({
            path: "src/value.ts",
            content: `// round ${response} call ${index + 1}\nexport const value = ${response};\n`,
          }),
        })) };
      } },
    });
    await expect(builder.run()).rejects.toThrow(`${MAX_BUILDER_TOOL_CALLS_PER_RUN}-call per-run tool limit`);
    expect(response).toBe(6);
    expect(readFileSync(join(workspace.workspaceRoot, "src", "value.ts"), "utf8")).toContain("round 5 call 8");
    workspaceManager.remove(workspace);
  });

  test("classifies provider timeouts without treating unrelated failures as timeouts", () => {
    const timeout = new Error("Request timed out.");
    timeout.name = "APIConnectionTimeoutError";
    expect(isProviderModelTimeout(timeout)).toBe(true);
    expect(isProviderModelTimeout(new Error("dependency timed out while installing"))).toBe(false);
    expect(isProviderModelTimeout(new Error("rate limit"))).toBe(false);
  });

  test("backs retryable model failures off with bounded full jitter", () => {
    expect(modelRetryBackoffMs(1, () => 0)).toBe(0);
    expect(modelRetryBackoffMs(1, () => 0.999999)).toBe(249);
    expect(modelRetryBackoffMs(5, () => 0.999999)).toBe(3_999);
    expect(modelRetryBackoffMs(20, () => 0.999999)).toBe(3_999);
    expect(() => modelRetryBackoffMs(0)).toThrow("positive integer");
  });

  test("counts the exact provider input instead of treating UTF-8 bytes as tokens", async () => {
    const request = { model: "gpt-5.6-sol", instructions: "Plan safely", input: "a".repeat(120_000), max_output_tokens: 8_000 };
    const localEstimate = estimateResponseInputTokens(request);
    expect(localEstimate).toBe(Buffer.byteLength(JSON.stringify({ model: request.model, instructions: request.instructions, input: request.input })));
    const fallback = await countResponseInputTokens({ async create() { return { id: "unused", output: [] }; } }, request);
    expect(fallback).toBe(localEstimate);

    const countBodies: Array<Record<string, unknown>> = [];
    const transport = new OpenAIResponsesTransport({
      apiKey: "sk-test-never-in-prompt",
      fetch: (async (url, init) => {
        if (String(url).endsWith("/responses/input_tokens")) {
          countBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
          return new Response(JSON.stringify({ object: "response.input_tokens", input_tokens: 31_337 }), {
            status: 200, headers: { "Content-Type": "application/json" },
          });
        }
        throw new Error("unexpected endpoint");
      }) as typeof fetch,
    });
    expect(await countResponseInputTokens(transport, request)).toBe(31_337);
    expect(countBodies).toEqual([{ model: request.model, instructions: request.instructions, input: request.input }]);
  });

  test("keeps the OpenAI credential in the transport header and requests no provider storage", async () => {
    let observedBody = "";
    const transport = new OpenAIResponsesTransport({
      apiKey: "sk-test-never-in-prompt",
      fetch: (async (_url, init) => {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer sk-test-never-in-prompt");
        observedBody = String(init?.body ?? "");
        return new Response(JSON.stringify({ id: "response-1", output: [] }), {
          status: 200, headers: { "Content-Type": "application/json" },
        });
      }) as typeof fetch,
    });
    await transport.create({ model: "gpt-5.6-sol", input: [], store: false });
    expect(observedBody).not.toContain("sk-test-never-in-prompt");
    expect(JSON.parse(observedBody).store).toBe(false);
  });

  test("executes Responses function calls and returns a real scoped Git diff", async () => {
    const root = temporaryRoot();
    const repository = initRepository(root);
    const workspaceManager = new GitWorkspaceManager({ workspaceRoot: join(root, "workspaces"), gitSpawn: bunGitSpawn });
    const workspace = workspaceManager.create({ runId: "run-1", repositoryRoot: repository.path, baseCommitSha: repository.sha });
    const task = manifest("run-1", repository.sha);
    const { sandbox } = records(workspace.workspaceRoot, "run-1", repository.sha);
    const executor = new TrustedCommandExecutor({
      artifactStore: new LocalArtifactStore({ root: join(root, "artifacts") }), workspace, sandbox, manifest: task,
      currentCommit: () => workspaceManager.currentCommit(workspace),
      runner: () => ({ status: 0, stdout: "pass", stderr: "" }),
    });
    let requestCount = 0;
    const cacheKeys: string[] = [];
    const transport: ResponsesTransport = {
      async create(request) {
        requestCount += 1;
        expect(request.model).toBe("gpt-5.6-terra");
        expect(request.store).toBe(false);
        expect(request.max_output_tokens).toBe(BUILDER_MAX_OUTPUT_TOKENS);
        expect(request.prompt_cache_options).toEqual({ mode: "explicit", ttl: "30m" });
        expect(request.context_management).toEqual([{ type: "compaction", compact_threshold: BUILDER_CONTEXT_COMPACTION_THRESHOLD_TOKENS }]);
        expect(request.input).toEqual(expect.arrayContaining([expect.objectContaining({
          content: expect.arrayContaining([expect.objectContaining({ prompt_cache_breakpoint: { mode: "explicit" } })]),
        })]));
        cacheKeys.push(String(request.prompt_cache_key));
        if (requestCount === 1) return {
          id: "resp-1",
          output: [{ type: "function_call", call_id: "call-1", name: "write_file", arguments: JSON.stringify({
            path: "src/value.ts", content: "export const value = 2;\n",
          }) }],
        };
        return { id: "resp-2", output: [], output_text: "Updated the requested value." };
      },
    };
    const result = await new CodexBuilder({
      transport, manifest: task, workspace, workspaceManager, executor,
      now: () => new Date("2026-07-14T12:00:00.000Z"),
    }).run();
    expect(result.model).toBe("gpt-5.6-terra");
    expect(result.changedFiles).toEqual(["src/value.ts"]);
    expect(result.diff).toContain("value = 2");
    expect(result.responseIds).toEqual(["resp-1", "resp-2"]);
    expect(new Set(cacheKeys).size).toBe(1);
    expect(cacheKeys[0]).not.toBe("undefined");
    workspaceManager.remove(workspace);
  });

  test("hands off immediately after executor evidence succeeds for the latest mutation", async () => {
    const root = temporaryRoot();
    const repository = initRepository(root);
    const workspaceManager = new GitWorkspaceManager({ workspaceRoot: join(root, "evidence-workspaces"), gitSpawn: bunGitSpawn });
    const workspace = workspaceManager.create({ runId: "run-evidence-handoff", repositoryRoot: repository.path, baseCommitSha: repository.sha });
    const task = manifest("run-evidence-handoff", repository.sha);
    const { sandbox } = records(workspace.workspaceRoot, task.runId, repository.sha);
    const executor = new TrustedCommandExecutor({
      artifactStore: new LocalArtifactStore({ root: join(root, "evidence-artifacts") }),
      workspace, sandbox, manifest: task,
      currentCommit: () => workspaceManager.currentCommit(workspace),
      runner: () => ({ status: 0, stdout: "pass", stderr: "" }),
    });
    let calls = 0;
    const result = await new CodexBuilder({
      manifest: task, workspace, workspaceManager, executor,
      transport: {
        async create() {
          calls += 1;
          if (calls === 1) return {
            id: "evidence-write", output: [{
              type: "function_call", call_id: "evidence-write-call", name: "write_file",
              arguments: JSON.stringify({ path: "src/value.ts", content: "export const value = 2;\n" }),
            }],
          };
          if (calls === 2) return {
            id: "evidence-command", output: [{
              type: "function_call", call_id: "evidence-command-call", name: "run_command",
              arguments: JSON.stringify({ command: "bun run test" }),
            }],
          };
          throw new Error("a final narrative model call must not be made");
        },
      },
    }).run();
    expect(calls).toBe(2);
    expect(result.responseIds).toEqual(["evidence-write", "evidence-command"]);
    expect(result.implementationSummary).toContain("independent verification is pending");
    expect(result.changedFiles).toEqual(["src/value.ts"]);
    workspaceManager.remove(workspace);
  });

  test("resolves every fixed role without cross-tier fallback", () => {
    expect(resolveEngineerModel("BUILDER").model).toBe("gpt-5.6-terra");
    expect(resolveEngineerModel("PLANNER").model).toBe("gpt-5.6-terra");
    expect(resolveEngineerModel("DOCS").model).toBe("gpt-5.6-luna");
    expect(resolveEngineerModel("BUILDER", { terra: "pinned-terra" }).model).toBe("pinned-terra");
    expect(() => resolveEngineerModel("BUILDER", { terra: " " })).toThrow("must not be empty");
  });
});

describe("Phase 2 authoritative execution worker", () => {
  test("cleans an interrupted workspace and durably requeues from IMPLEMENTING", async () => {
    const root = temporaryRoot();
    const repository = initRepository(root);
    const supervisor = new EngineerSupervisor({ dbPath: join(root, "recovery.db") });
    const received = supervisor.receiveRequest({
      runId: "run-recovery", userId: "user-1",
      repository: { repositoryId: "repo-1", provider: "local", owner: "local", name: "fixture", baseBranch: "main", baseCommitSha: repository.sha },
      request: "Change value",
    });
    const taskForRun = manifest(received.runId, repository.sha);
    const { manifestHash: _proposalHash, ...proposal } = taskForRun;
    const planReady = transitionToPlanReadyForTest({
      supervisor, received, normalizedRequest: proposal.request.normalized, manifest: proposal,
      key: "recovery", artifactRoot: join(root, "recovery-planning-artifacts"),
    });
    let run = supervisor.freezePlan({
      runId: planReady.runId, expectedStateVersion: planReady.stateVersion, manifest: proposal,
      actorId: "test-planner", idempotencyKey: "freeze-recovery",
    }).run;
    for (const nextState of ["QUEUED", "SANDBOX_COLD_PROVISIONING", "SANDBOX_PREFLIGHT", "SANDBOX_READY", "CONTEXT_BUILDING", "IMPLEMENTING"] as const) {
      run = supervisor.transition({
        runId: run.runId, expectedStateVersion: run.stateVersion, nextState,
        reasonCode: `TEST_${nextState}`, manifestHash: run.manifestHash,
        idempotencyKey: `recovery-state:${nextState}`,
      }).run;
    }
    const workspaceManager = new GitWorkspaceManager({ workspaceRoot: join(root, "recovery-workspaces"), gitSpawn: bunGitSpawn });
    const workspace = await workspaceManager.createAsync({ runId: run.runId, repositoryRoot: repository.path, baseCommitSha: repository.sha });
    supervisor.recordSandbox({
      sandboxId: "recovery-sandbox", runId: run.runId, workspaceIdentity: workspace.workspaceIdentity,
      imageReference: `oven/bun@sha256:${"a".repeat(64)}`, imageDigest: `sha256:${"a".repeat(64)}`,
      environmentDigest: `sha256:${"b".repeat(64)}`, networkPolicyVersion: "network-v1", sandboxPolicyVersion: "sandbox-v1",
      status: "READY", source: "COLD", createdAt: "2026-07-14T12:00:00.000Z", destroyedAt: null,
    });
    const sandboxManager = new DockerSandboxManager({
      workspaceManager, imageReference: `oven/bun@sha256:${"a".repeat(64)}`, imageDigest: `sha256:${"a".repeat(64)}`,
      dockerRunAsync: async () => ({ status: 0, signal: null, stdout: "", stderr: "" }),
    });
    const manager = new EngineerExecutionManager({
      supervisor, sandboxManager, artifactStore: new LocalArtifactStore({ root: join(root, "recovery-artifacts") }),
      repositoryRootFor: () => repository.path,
      transportForRun: async () => ({ create: async () => ({ id: "unused", output: [] }) }),
    });
    expect(await manager.recoverInterrupted(run.runId, "expired-lease-1")).toBe("REQUEUED");
    expect(existsSync(workspace.workspaceRoot)).toBe(false);
    expect(supervisor.getRun(run.runId).state).toBe("QUEUED");
    expect(supervisor.listFailures(run.runId)).toMatchObject([{
      reasonCode: "WORKER_PROCESS_INTERRUPTED", retryable: true, evidenceIds: ["expired-lease-1"],
    }]);
    const audit = new Database(join(root, "recovery.db"), { readonly: true });
    expect(audit.query("SELECT status FROM sandboxes WHERE run_id = ?").get(run.runId)).toEqual({ status: "DESTROYED" });
    audit.close();
    expect(await manager.recoverInterrupted(run.runId, "expired-lease-1")).toBe("IGNORED");
    supervisor.close();
  });

  test("moves a frozen run to FAST_CHECKS and persists executor artifacts", async () => {
    const root = temporaryRoot();
    const repository = initRepository(root);
    const supervisor = new EngineerSupervisor({ dbPath: join(root, "engineer.db") });
    const received = supervisor.receiveRequest({
      runId: "run-worker",
      userId: "user-1",
      repository: {
        repositoryId: "repo-1", provider: "local", owner: "local", name: "fixture",
        baseBranch: "main", baseCommitSha: repository.sha,
      },
      request: "Change value",
    });
    const taskForRun = manifest(received.runId, repository.sha);
    const { manifestHash: _proposalHash, ...proposalContent } = taskForRun;
    let run = transitionToPlanReadyForTest({
      supervisor,
      received,
      normalizedRequest: "Change src/value.ts to export value 2.",
      manifest: proposalContent,
      key: "worker",
      artifactRoot: join(root, "planning-artifacts"),
    });
    const frozen = supervisor.freezePlan({
      runId: run.runId,
      expectedStateVersion: run.stateVersion,
      manifest: (() => {
        const task = manifest(run.runId, repository.sha);
        const { manifestHash: _manifestHash, ...content } = task;
        return content;
      })(),
      actorId: "test-planner",
      idempotencyKey: "freeze-worker",
    }).run;
    expect(frozen.state).toBe("PLAN_FROZEN");

    const digest = `sha256:${"a".repeat(64)}`;
    const dockerSpawn = ((_: string, args: string[]) => {
      if (args[0] === "info") return { status: 0, stdout: "27", stderr: "" };
      if (args[0] === "image") return { status: 0, stdout: `[\"oven/bun@${digest}\"]`, stderr: "" };
      return { status: 0, stdout: "1 pass", stderr: "" };
    }) as typeof import("node:child_process").spawnSync;
    const workspaceManager = new GitWorkspaceManager({
      workspaceRoot: join(root, "workspaces"), gitSpawn: bunGitSpawn,
    });
    const sandboxManager = new DockerSandboxManager({
      workspaceManager, imageReference: `oven/bun@${digest}`, imageDigest: digest, dockerSpawn,
    });
    let response = 0;
    let transportMode: "normal" | "partial-budget" | "partial-timeout" | "recovered" = "normal";
    let budgetResponse = 0;
    let timeoutResponse = 0;
    const transport: ResponsesTransport = {
      async countInputTokens() { return 100; },
      async create() {
        if (transportMode === "partial-budget") {
          budgetResponse += 1;
          if (budgetResponse === 1) return {
            id: "worker-budget-partial", usage: { input_tokens: 100, output_tokens: 6_000 },
            output: [{ type: "function_call", call_id: "budget-write", name: "write_file", arguments: JSON.stringify({
              path: "src/value.ts", content: "export const value = 4;\n",
            }) }],
          };
          throw new Error("a second budget model request must be stopped before transport");
        }
        if (transportMode === "partial-timeout") {
          timeoutResponse += 1;
          if (timeoutResponse === 1) return {
            id: "worker-timeout-partial", usage: { input_tokens: 50, output_tokens: 25 },
            output: [{ type: "function_call", call_id: "timeout-write", name: "write_file", arguments: JSON.stringify({
              path: "src/value.ts", content: "export const value = 3;\n",
            }) }],
          };
          const error = new Error("Request timed out.");
          error.name = "APIConnectionTimeoutError";
          throw error;
        }
        if (transportMode === "recovered") return {
          id: "worker-recovered", usage: { input_tokens: 50, output_tokens: 10 }, output: [],
          output_text: "Recovered from the retained workspace checkpoint.",
        };
        response += 1;
        if (response === 1) throw new Error("transient provider failure");
        if (response === 2) return {
          id: "worker-response-1", usage: { input_tokens: 100, output_tokens: 100 },
          output: [{ type: "function_call", call_id: "write-1", name: "write_file", arguments: JSON.stringify({
            path: "src/value.ts", content: "export const value = 2;\n",
          }) }],
        };
        if (response === 3) return {
          id: "worker-response-2", usage: { input_tokens: 100, output_tokens: 100 },
          output: [{ type: "function_call", call_id: "command-1", name: "run_command", arguments: JSON.stringify({
            command: "bun run test",
          }) }],
        };
        return { id: "worker-response-3", usage: { input_tokens: 100, output_tokens: 100 }, output: [], output_text: "Implementation complete; executor evidence is separate." };
      },
    };
    const leaseManager = new EngineerWorkerLeaseManager({
      dbPath: join(root, "worker-leases.db"),
      tokenSecret: "a".repeat(64),
      maxConcurrentLeases: 1,
      recoverExpiredLease: () => undefined,
    });
    const artifactStore = new LocalArtifactStore({ root: join(root, "artifacts") });
    const createExecutionManager = () => new EngineerExecutionManager({
      supervisor, sandboxManager, artifactStore,
      repositoryRootFor: (repositoryId) => {
        expect(repositoryId).toBe("repo-1");
        return repository.path;
      },
      transportForRun: () => transport,
      leaseManager,
      workerOwnerId: "test-worker",
      leaseTtlMs: 30_000,
    });
    let manager = createExecutionManager();
    const result = await manager.execute(run.runId);
    expect(result.changedFiles).toEqual(["src/value.ts"]);
    expect(supervisor.getRun(run.runId).state).toBe("FAST_CHECKS");
    expect(leaseManager.listActive()).toHaveLength(0);
    const artifacts = supervisor.listArtifacts(run.runId);
    expect(artifacts.map((artifact) => artifact.type)).toContain("COMMAND_STDOUT");
    expect(artifacts.map((artifact) => artifact.type)).toContain("COMMAND_STDERR");
    expect(artifacts.map((artifact) => artifact.type)).toContain("BUILDER_RESULT");
    expect(artifacts.map((artifact) => artifact.type)).toContain("TEST_BASELINE_MANIFEST");
    expect(artifacts.map((artifact) => artifact.type)).toContain("TEST_INTEGRITY_COMPARISON");
    const auditDb = new Database(join(root, "engineer.db"), { readonly: true });
    expect((auditDb.query("SELECT COUNT(*) AS count FROM command_executions").get() as { count: number }).count).toBe(1);
    expect((auditDb.query("SELECT COUNT(*) AS count FROM agent_executions").get() as { count: number }).count).toBe(1);
    expect(auditDb.query("SELECT status, retry_count, budget_reservation_id FROM model_calls ORDER BY rowid").all()).toEqual([
      { status: "FAILED", retry_count: 0, budget_reservation_id: expect.any(String) },
      { status: "SUCCEEDED", retry_count: 1, budget_reservation_id: expect.any(String) },
      { status: "SUCCEEDED", retry_count: 0, budget_reservation_id: expect.any(String) },
    ]);
    expect((auditDb.query("SELECT COUNT(*) AS count FROM cost_records WHERE source_type = 'MODEL_RESERVATION'").get() as { count: number }).count).toBe(1);
    expect(auditDb.query("SELECT reservation_status FROM cost_records WHERE source_type = 'MODEL_RESERVATION'").get()).toEqual({
      reservation_status: "AMBIGUOUS_PROVIDER_OUTCOME",
    });
    expect(supervisor.getBudget(run.runId).ambiguous).toMatchObject({ tokens: expect.any(Number), costUsd: expect.any(Number) });
    expect(supervisor.getBudget(run.runId).ambiguous.tokens).toBeGreaterThan(0);
    auditDb.close();

    const budgetReceived = supervisor.receiveRequest({
      runId: "run-worker-budget-stop", userId: "user-1",
      repository: {
        repositoryId: "repo-1", provider: "local", owner: "local", name: "fixture",
        baseBranch: "main", baseCommitSha: repository.sha,
      },
      request: "Change value",
    });
    const budgetTask = manifest(budgetReceived.runId, repository.sha, { tokenBudget: 7_000 });
    const { manifestHash: _budgetProposalHash, ...budgetProposalContent } = budgetTask;
    const budgetPlanReady = transitionToPlanReadyForTest({
      supervisor, received: budgetReceived,
      normalizedRequest: budgetProposalContent.request.normalized,
      manifest: budgetProposalContent,
      key: "worker-budget-stop",
      artifactRoot: join(root, "planning-budget-artifacts"),
    });
    const budgetFrozen = supervisor.freezePlan({
      runId: budgetPlanReady.runId,
      expectedStateVersion: budgetPlanReady.stateVersion,
      manifest: budgetProposalContent,
      actorId: "test-planner",
      idempotencyKey: "freeze-worker-budget-stop",
    }).run;
    expect(budgetFrozen.state).toBe("PLAN_FROZEN");
    transportMode = "partial-budget";
    await expect(manager.execute(budgetFrozen.runId)).rejects.toThrow("paused safely");
    expect(supervisor.getRun(budgetFrozen.runId).state).toBe("PAUSED_BUDGET");
    expect(supervisor.listEvents(budgetFrozen.runId)).toContainEqual(expect.objectContaining({
      nextState: "PAUSED_BUDGET", reasonCode: "TOKEN_LIMIT_REACHED",
    }));
    expect(supervisor.listFailures(budgetFrozen.runId)).toEqual([]);
    expect(supervisor.exportRunRecords(budgetFrozen.runId).agent_executions).toMatchObject([{ status: "PAUSED" }]);
    const pausedDiff = await workspaceManager.diffAsync(manager.getSandbox(budgetFrozen.runId)!.workspace);
    expect(pausedDiff).toContain("value = 4");
    manager.destroyAll({ preserveResumable: true });
    expect(manager.getSandbox(run.runId)).toBeNull();
    expect(manager.getSandbox(budgetFrozen.runId)).not.toBeNull();
    manager = createExecutionManager();
    const pausedRun = supervisor.getRun(budgetFrozen.runId);
    const pausedBudget = supervisor.getBudget(budgetFrozen.runId);
    const toppedBudget = supervisor.topUpBudget({
      runId: budgetFrozen.runId, expectedRevision: pausedBudget.revision,
      topUp: { addTokenBudget: 100_000, addCostBudgetUsd: 1, addTimeBudgetSeconds: 60 },
      actorId: "user-1", idempotencyKey: "worker-budget-top-up",
    });
    supervisor.resumeBudget({
      runId: budgetFrozen.runId, expectedStateVersion: pausedRun.stateVersion,
      expectedBudgetRevision: toppedBudget.revision, actorId: "user-1", idempotencyKey: "worker-budget-resume",
    });
    expect((await manager.resumeBudgetCheckpoint(budgetFrozen.runId)).state).toBe("QUEUED");
    expect(await workspaceManager.diffAsync(manager.getSandbox(budgetFrozen.runId)!.workspace)).toBe(pausedDiff);
    transportMode = "recovered";
    await manager.runQueued(budgetFrozen.runId);
    expect(supervisor.getRun(budgetFrozen.runId).state).toBe("FAST_CHECKS");
    expect((supervisor.exportRunRecords(budgetFrozen.runId).agent_executions ?? []).map((agent) => agent.status)).toEqual(["PAUSED", "SUCCEEDED"]);

    const timeoutReceived = supervisor.receiveRequest({
      runId: "run-worker-provider-timeout", userId: "user-1",
      repository: {
        repositoryId: "repo-1", provider: "local", owner: "local", name: "fixture",
        baseBranch: "main", baseCommitSha: repository.sha,
      },
      request: "Change value",
    });
    const timeoutTask = manifest(timeoutReceived.runId, repository.sha);
    const { manifestHash: _timeoutHash, ...timeoutContent } = timeoutTask;
    const timeoutPlanReady = transitionToPlanReadyForTest({
      supervisor, received: timeoutReceived, normalizedRequest: timeoutContent.request.normalized,
      manifest: timeoutContent, key: "worker-provider-timeout", artifactRoot: join(root, "planning-timeout-artifacts"),
    });
    const timeoutFrozen = supervisor.freezePlan({
      runId: timeoutPlanReady.runId, expectedStateVersion: timeoutPlanReady.stateVersion,
      manifest: timeoutContent, actorId: "test-planner", idempotencyKey: "freeze-worker-provider-timeout",
    }).run;
    transportMode = "partial-timeout";
    await expect(manager.execute(timeoutFrozen.runId)).rejects.toThrow("Request timed out");
    expect(supervisor.getRun(timeoutFrozen.runId).state).toBe("MODEL_PROVIDER_RETRY_PENDING");
    expect(await workspaceManager.diffAsync(manager.getSandbox(timeoutFrozen.runId)!.workspace)).toContain("value = 3");
    expect(supervisor.listFailures(timeoutFrozen.runId)).toContainEqual(expect.objectContaining({
      failureClass: "MODEL_FAILURE", reasonCode: "MODEL_PROVIDER_TIMEOUT", retryable: true,
    }));
    const timeoutBudget = supervisor.getBudget(timeoutFrozen.runId);
    expect(timeoutBudget.used.costUsd).toBeGreaterThan(0);
    expect(timeoutBudget.reserved.costUsd).toBeGreaterThan(0);
    const timeoutAudit = new Database(join(root, "engineer.db"), { readonly: true });
    expect((timeoutAudit.query("SELECT COUNT(*) AS count FROM model_calls WHERE run_id = ? AND status = 'FAILED'")
      .get(timeoutFrozen.runId) as { count: number }).count).toBe(1);
    timeoutAudit.close();

    const timeoutDiff = await workspaceManager.diffAsync(manager.getSandbox(timeoutFrozen.runId)!.workspace);
    expect(timeoutDiff).toContain("value = 3");
    manager.destroyAll({ preserveResumable: true });
    expect(manager.getSandbox(budgetFrozen.runId)).toBeNull();
    expect(manager.getSandbox(timeoutFrozen.runId)).not.toBeNull();
    manager = createExecutionManager();
    transportMode = "recovered";
    expect((await manager.retryProviderTimeout(timeoutFrozen.runId)).state).toBe("QUEUED");
    expect(await workspaceManager.diffAsync(manager.getSandbox(timeoutFrozen.runId)!.workspace)).toBe(timeoutDiff);
    await manager.runQueued(timeoutFrozen.runId);
    expect(supervisor.getRun(timeoutFrozen.runId).state).toBe("FAST_CHECKS");
    expect(supervisor.listEvents(timeoutFrozen.runId)).toContainEqual(expect.objectContaining({
      nextState: "SANDBOX_READY", reasonCode: "RETAINED_WORKSPACE_CHECKPOINT_REUSED",
    }));

    expect(manager.destroy(timeoutFrozen.runId)?.status).toBe("DESTROYED");
    leaseManager.close();
    supervisor.close();
  });
});
