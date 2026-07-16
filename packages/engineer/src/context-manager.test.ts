import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalArtifactStore } from "./artifact-store.js";
import { ContextEngine } from "./context-engine.js";
import { EngineerContextManager } from "./context-manager.js";
import { EngineerSupervisor } from "./supervisor.js";

function git(cwd: string, args: string[]) {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

class SlowContextEngine extends ContextEngine {
  calls = 0;
  override async build(input: Parameters<ContextEngine["build"]>[0]) {
    this.calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return super.build(input);
  }
}

describe("Engineer context manager concurrency", () => {
  test("shares one scan and one durable snapshot across concurrent plan requests", async () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-context-manager-"));
    const repositoryRoot = join(root, "repository");
    mkdirSync(repositoryRoot);
    git(repositoryRoot, ["init", "-b", "main"]);
    git(repositoryRoot, ["config", "user.email", "test@zintus.local"]);
    git(repositoryRoot, ["config", "user.name", "Zintus Test"]);
    writeFileSync(join(repositoryRoot, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
    git(repositoryRoot, ["add", "."]); git(repositoryRoot, ["commit", "-m", "fixture"]);
    const sha = git(repositoryRoot, ["rev-parse", "HEAD"]);
    const supervisor = new EngineerSupervisor({ dbPath: join(root, "engineer.db") });
    supervisor.receiveRequest({
      runId: "concurrent-context", userId: "owner", request: "Inspect package scripts",
      repository: { repositoryId: "repo", provider: "local", owner: "local", name: "fixture", baseBranch: "main", baseCommitSha: sha },
    });
    const engine = new SlowContextEngine({});
    const manager = new EngineerContextManager({
      supervisor, contextEngine: engine, artifactStore: new LocalArtifactStore({ root: join(root, "artifacts") }),
      repositoryRootFor: () => repositoryRoot,
    });
    const [first, second] = await Promise.all([manager.build("concurrent-context"), manager.build("concurrent-context")]);
    expect(first).toEqual(second);
    expect(engine.calls).toBe(1);
    expect(supervisor.listArtifacts("concurrent-context").filter((artifact) => artifact.type === "CONTEXT_MANIFEST")).toHaveLength(1);
    supervisor.close(); rmSync(root, { recursive: true, force: true });
  });

  test("two process-like managers converge durably without orphan context artifacts", async () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-context-manager-processes-"));
    const repositoryRoot = join(root, "repository");
    mkdirSync(repositoryRoot);
    git(repositoryRoot, ["init", "-b", "main"]);
    git(repositoryRoot, ["config", "user.email", "test@zintus.local"]);
    git(repositoryRoot, ["config", "user.name", "Zintus Test"]);
    writeFileSync(join(repositoryRoot, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
    git(repositoryRoot, ["add", "."]); git(repositoryRoot, ["commit", "-m", "fixture"]);
    const sha = git(repositoryRoot, ["rev-parse", "HEAD"]);
    const dbPath = join(root, "engineer.db");
    const firstSupervisor = new EngineerSupervisor({ dbPath });
    firstSupervisor.receiveRequest({
      runId: "cross-process-context", userId: "owner", request: "Inspect package scripts",
      repository: { repositoryId: "repo", provider: "local", owner: "local", name: "fixture", baseBranch: "main", baseCommitSha: sha },
    });
    const secondSupervisor = new EngineerSupervisor({ dbPath });
    const firstEngine = new SlowContextEngine({});
    const secondEngine = new SlowContextEngine({});
    const artifactRoot = join(root, "artifacts");
    const firstManager = new EngineerContextManager({
      supervisor: firstSupervisor, contextEngine: firstEngine, artifactStore: new LocalArtifactStore({ root: artifactRoot }),
      repositoryRootFor: () => repositoryRoot,
    });
    const secondManager = new EngineerContextManager({
      supervisor: secondSupervisor, contextEngine: secondEngine, artifactStore: new LocalArtifactStore({ root: artifactRoot }),
      repositoryRootFor: () => repositoryRoot,
    });
    const [first, second] = await Promise.all([
      firstManager.build("cross-process-context"),
      secondManager.build("cross-process-context"),
    ]);
    expect(first).toEqual(second);
    expect(firstEngine.calls + secondEngine.calls).toBe(2);
    expect(firstSupervisor.listArtifacts("cross-process-context").filter((artifact) => artifact.type === "CONTEXT_MANIFEST")).toHaveLength(1);
    expect(secondSupervisor.latestContextSnapshot("cross-process-context")).toEqual(first);
    expect(readdirSync(join(artifactRoot, "cross-process-context"))).toHaveLength(1);
    secondSupervisor.close(); firstSupervisor.close(); rmSync(root, { recursive: true, force: true });
  });
});
