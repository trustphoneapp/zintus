import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WorkspaceRecordSchema, type WorkspaceRecord } from "./execution-contracts.js";
import { runProcessAsync } from "./async-process.js";

type GitSpawn = typeof spawnSync;

export interface GitWorkspaceManagerOptions {
  workspaceRoot: string;
  gitSpawn?: GitSpawn;
  gitRunAsync?: (cwd: string, args: string[]) => Promise<CapturedGitResult>;
  now?: () => Date;
  idFactory?: () => string;
}

interface CapturedGitResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

function safeRunSegment(runId: string): string {
  const value = runId.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 80);
  if (!value) throw new TypeError("runId cannot form a safe workspace name");
  return value;
}

export class GitWorkspaceManager {
  private readonly workspaceRoot: string;
  private readonly gitSpawn: GitSpawn;
  private readonly gitRunAsync: (cwd: string, args: string[]) => Promise<CapturedGitResult>;
  private readonly now: () => Date;
  private readonly idFactory: () => string;

  constructor(options: GitWorkspaceManagerOptions) {
    this.workspaceRoot = resolve(options.workspaceRoot);
    this.gitSpawn = options.gitSpawn ?? spawnSync;
    this.gitRunAsync = options.gitRunAsync ?? (options.gitSpawn
      ? async (cwd, args) => this.runGit(cwd, args)
      : (cwd, args) => runProcessAsync("git", ["-C", cwd, ...args], {
          timeoutMs: 120_000,
          maxOutputBytes: 8 * 1024 * 1024,
        }));
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    mkdirSync(this.workspaceRoot, { recursive: true, mode: 0o700 });
  }

  create(input: { runId: string; repositoryRoot: string; baseCommitSha: string }): WorkspaceRecord {
    const repositoryRoot = realpathSync(input.repositoryRoot);
    const base = this.git(repositoryRoot, ["rev-parse", "--verify", `${input.baseCommitSha}^{commit}`]);
    if (base.toLowerCase() !== input.baseCommitSha.toLowerCase()) {
      throw new Error(`requested base commit did not resolve exactly: expected ${input.baseCommitSha}, got ${JSON.stringify(base)}`);
    }
    const suffix = this.idFactory().replace(/[^A-Za-z0-9]/g, "").slice(0, 12);
    const segment = safeRunSegment(input.runId);
    const workspaceRoot = resolve(this.workspaceRoot, `${segment}-${suffix}`);
    const branchName = `zintus/engineer/${segment}-${suffix}`;
    const add = this.runGit(repositoryRoot, ["worktree", "add", "--detach", workspaceRoot, input.baseCommitSha]);
    if (add.status !== 0) throw new Error(`git worktree add failed: ${add.stderr || add.error?.message || "unknown error"}`);
    try {
      this.git(workspaceRoot, ["switch", "-c", branchName]);
      const actual = this.git(workspaceRoot, ["rev-parse", "HEAD"]);
      if (actual.toLowerCase() !== input.baseCommitSha.toLowerCase()) {
        throw new Error(`workspace base mismatch: expected ${input.baseCommitSha}, got ${actual}`);
      }
      const originResult = this.runGit(repositoryRoot, ["remote", "get-url", "origin"]);
      return WorkspaceRecordSchema.parse({
        workspaceIdentity: this.idFactory(),
        runId: input.runId,
        repositoryRoot,
        workspaceRoot: realpathSync(workspaceRoot),
        branchName,
        baseCommitSha: actual,
        originUrl: originResult.status === 0 ? originResult.stdout.trim() : null,
        createdAt: this.now().toISOString(),
      });
    } catch (error) {
      this.removeRaw(repositoryRoot, workspaceRoot);
      throw error;
    }
  }

  async createAsync(input: { runId: string; repositoryRoot: string; baseCommitSha: string }): Promise<WorkspaceRecord> {
    const repositoryRoot = realpathSync(input.repositoryRoot);
    const base = await this.gitAsync(repositoryRoot, ["rev-parse", "--verify", `${input.baseCommitSha}^{commit}`]);
    if (base.toLowerCase() !== input.baseCommitSha.toLowerCase()) {
      throw new Error(`requested base commit did not resolve exactly: expected ${input.baseCommitSha}, got ${JSON.stringify(base)}`);
    }
    const suffix = this.idFactory().replace(/[^A-Za-z0-9]/g, "").slice(0, 12);
    const segment = safeRunSegment(input.runId);
    const workspaceRoot = resolve(this.workspaceRoot, `${segment}-${suffix}`);
    const branchName = `zintus/engineer/${segment}-${suffix}`;
    const add = await this.runGitAsync(repositoryRoot, ["worktree", "add", "--detach", workspaceRoot, input.baseCommitSha]);
    if (add.status !== 0) throw new Error(`git worktree add failed: ${add.stderr || add.error?.message || "unknown error"}`);
    try {
      await this.gitAsync(workspaceRoot, ["switch", "-c", branchName]);
      const actual = await this.gitAsync(workspaceRoot, ["rev-parse", "HEAD"]);
      if (actual.toLowerCase() !== input.baseCommitSha.toLowerCase()) {
        throw new Error(`workspace base mismatch: expected ${input.baseCommitSha}, got ${actual}`);
      }
      const originResult = await this.runGitAsync(repositoryRoot, ["remote", "get-url", "origin"]);
      return WorkspaceRecordSchema.parse({
        workspaceIdentity: this.idFactory(),
        runId: input.runId,
        repositoryRoot,
        workspaceRoot: realpathSync(workspaceRoot),
        branchName,
        baseCommitSha: actual,
        originUrl: originResult.status === 0 ? originResult.stdout.trim() : null,
        createdAt: this.now().toISOString(),
      });
    } catch (error) {
      await this.removeRawAsync(repositoryRoot, workspaceRoot);
      throw error;
    }
  }

  claimWarm(input: {
    runId: string;
    repositoryRoot: string;
    workspaceRoot: string;
    baseCommitSha: string;
    expectedOriginUrl: string | null;
  }): WorkspaceRecord {
    const repositoryRoot = realpathSync(input.repositoryRoot);
    const workspaceRoot = realpathSync(input.workspaceRoot);
    if (!workspaceRoot.startsWith(`${this.workspaceRoot}/`)) throw new Error("warm workspace is outside the managed root");
    this.git(workspaceRoot, ["reset", "--hard", input.baseCommitSha]);
    this.git(workspaceRoot, ["clean", "-ffdx"]);
    if (this.git(workspaceRoot, ["status", "--porcelain=v1"]) !== "") throw new Error("warm workspace is not clean");
    const actual = this.git(workspaceRoot, ["rev-parse", "HEAD"]);
    if (actual.toLowerCase() !== input.baseCommitSha.toLowerCase()) throw new Error("warm workspace base commit mismatch");
    const origin = this.runGit(repositoryRoot, ["remote", "get-url", "origin"]);
    const originUrl = origin.status === 0 ? origin.stdout.trim() : null;
    if (originUrl !== input.expectedOriginUrl) throw new Error("warm workspace origin mismatch");
    const suffix = this.idFactory().replace(/[^A-Za-z0-9]/g, "").slice(0, 12);
    const segment = safeRunSegment(input.runId);
    const branchName = `zintus/engineer/${segment}-${suffix}`;
    this.git(workspaceRoot, ["switch", "-c", branchName]);
    return WorkspaceRecordSchema.parse({
      workspaceIdentity: this.idFactory(),
      runId: input.runId,
      repositoryRoot,
      workspaceRoot,
      branchName,
      baseCommitSha: actual,
      originUrl,
      createdAt: this.now().toISOString(),
    });
  }

  async claimWarmAsync(input: {
    runId: string;
    repositoryRoot: string;
    workspaceRoot: string;
    baseCommitSha: string;
    expectedOriginUrl: string | null;
  }): Promise<WorkspaceRecord> {
    const repositoryRoot = realpathSync(input.repositoryRoot);
    const workspaceRoot = realpathSync(input.workspaceRoot);
    if (!workspaceRoot.startsWith(`${this.workspaceRoot}/`)) throw new Error("warm workspace is outside the managed root");
    await this.gitAsync(workspaceRoot, ["reset", "--hard", input.baseCommitSha]);
    await this.gitAsync(workspaceRoot, ["clean", "-ffdx"]);
    if (await this.gitAsync(workspaceRoot, ["status", "--porcelain=v1"]) !== "") throw new Error("warm workspace is not clean");
    const actual = await this.gitAsync(workspaceRoot, ["rev-parse", "HEAD"]);
    if (actual.toLowerCase() !== input.baseCommitSha.toLowerCase()) throw new Error("warm workspace base commit mismatch");
    const origin = await this.runGitAsync(repositoryRoot, ["remote", "get-url", "origin"]);
    const originUrl = origin.status === 0 ? origin.stdout.trim() : null;
    if (originUrl !== input.expectedOriginUrl) throw new Error("warm workspace origin mismatch");
    const suffix = this.idFactory().replace(/[^A-Za-z0-9]/g, "").slice(0, 12);
    const segment = safeRunSegment(input.runId);
    const branchName = `zintus/engineer/${segment}-${suffix}`;
    await this.gitAsync(workspaceRoot, ["switch", "-c", branchName]);
    return WorkspaceRecordSchema.parse({
      workspaceIdentity: this.idFactory(), runId: input.runId, repositoryRoot, workspaceRoot,
      branchName, baseCommitSha: actual, originUrl, createdAt: this.now().toISOString(),
    });
  }

  currentCommit(workspace: WorkspaceRecord): string {
    return this.git(workspace.workspaceRoot, ["rev-parse", "HEAD"]);
  }

  currentCommitAsync(workspace: WorkspaceRecord): Promise<string> {
    return this.gitAsync(workspace.workspaceRoot, ["rev-parse", "HEAD"]);
  }

  /** Creates a local evidence checkpoint only; this never pushes or contacts a remote. */
  checkpoint(workspace: WorkspaceRecord, message = "zintus engineer result checkpoint"): string {
    if (!this.diff(workspace)) return this.currentCommit(workspace);
    this.git(workspace.workspaceRoot, ["add", "-A", "--"]);
    this.git(workspace.workspaceRoot, [
      "-c", "user.name=Zintus Engineer",
      "-c", "user.email=engineer@zintus.local",
      "commit", "--no-gpg-sign", "-m", message,
    ]);
    return this.currentCommit(workspace);
  }

  async checkpointAsync(workspace: WorkspaceRecord, message = "zintus engineer result checkpoint"): Promise<string> {
    if (!await this.diffAsync(workspace)) return this.currentCommitAsync(workspace);
    await this.gitAsync(workspace.workspaceRoot, ["add", "-A", "--"]);
    await this.gitAsync(workspace.workspaceRoot, [
      "-c", "user.name=Zintus Engineer", "-c", "user.email=engineer@zintus.local",
      "commit", "--no-gpg-sign", "-m", message,
    ]);
    return this.currentCommitAsync(workspace);
  }

  diff(workspace: WorkspaceRecord): string {
    return this.git(workspace.workspaceRoot, ["diff", "--binary", "--no-ext-diff", workspace.baseCommitSha, "--"]);
  }

  diffAsync(workspace: WorkspaceRecord): Promise<string> {
    return this.gitAsync(workspace.workspaceRoot, ["diff", "--binary", "--no-ext-diff", workspace.baseCommitSha, "--"]);
  }

  changedFiles(workspace: WorkspaceRecord): string[] {
    const result = this.runGit(workspace.workspaceRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    if (result.status !== 0) throw new Error(`git status failed: ${result.stderr || result.error?.message || "unknown error"}`);
    const entries = result.stdout.split("\0").filter(Boolean);
    const files: string[] = [];
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]!;
      const status = entry.slice(0, 2);
      const path = entry.slice(3);
      if (status.includes("R") || status.includes("C")) index += 1;
      files.push(path.replace(/\\/g, "/"));
    }
    return [...new Set(files)].sort();
  }

  async changedFilesAsync(workspace: WorkspaceRecord): Promise<string[]> {
    const result = await this.runGitAsync(workspace.workspaceRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    if (result.status !== 0) throw new Error(`git status failed: ${result.stderr || result.error?.message || "unknown error"}`);
    const entries = result.stdout.split("\0").filter(Boolean);
    const files: string[] = [];
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]!;
      const status = entry.slice(0, 2);
      const path = entry.slice(3);
      if (status.includes("R") || status.includes("C")) index += 1;
      files.push(path.replace(/\\/g, "/"));
    }
    return [...new Set(files)].sort();
  }

  remove(workspace: WorkspaceRecord): void {
    this.removeRaw(workspace.repositoryRoot, workspace.workspaceRoot);
  }

  removeAsync(workspace: WorkspaceRecord): Promise<void> {
    return this.removeRawAsync(workspace.repositoryRoot, workspace.workspaceRoot);
  }

  /** Removes every managed worktree for one interrupted run, then prunes Git metadata. */
  async cleanupRunAsync(runId: string, repositoryRootInput: string): Promise<number> {
    const repositoryRoot = realpathSync(repositoryRootInput);
    const prefix = `${safeRunSegment(runId)}-`;
    const entries = await readdir(this.workspaceRoot, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    let removed = 0;
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
      const workspaceRoot = resolve(this.workspaceRoot, entry.name);
      if (!workspaceRoot.startsWith(`${this.workspaceRoot}/`)) throw new Error("managed workspace cleanup escaped its root");
      const result = await this.runGitAsync(repositoryRoot, ["worktree", "remove", "--force", workspaceRoot]);
      if (result.status !== 0) await rm(workspaceRoot, { recursive: true, force: true });
      removed += 1;
    }
    await this.runGitAsync(repositoryRoot, ["worktree", "prune"]);
    return removed;
  }

  private removeRaw(repositoryRoot: string, workspaceRoot: string): void {
    const result = this.runGit(repositoryRoot, ["worktree", "remove", "--force", workspaceRoot]);
    if (result.status !== 0) throw new Error(`git worktree cleanup failed: ${result.stderr || result.error?.message || "unknown error"}`);
    this.runGit(repositoryRoot, ["worktree", "prune"]);
  }

  private async removeRawAsync(repositoryRoot: string, workspaceRoot: string): Promise<void> {
    const result = await this.runGitAsync(repositoryRoot, ["worktree", "remove", "--force", workspaceRoot]);
    if (result.status !== 0) throw new Error(`git worktree cleanup failed: ${result.stderr || result.error?.message || "unknown error"}`);
    await this.runGitAsync(repositoryRoot, ["worktree", "prune"]);
  }

  private git(cwd: string, args: string[]): string {
    const result = this.runGit(cwd, args);
    if (result.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed (status=${String(result.status)}, signal=${String(result.signal)}): ${result.stderr || result.error?.message || "unknown error"}`);
    }
    return result.stdout.trim();
  }

  private async gitAsync(cwd: string, args: string[]): Promise<string> {
    const result = await this.runGitAsync(cwd, args);
    if (result.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed (status=${String(result.status)}, signal=${String(result.signal)}): ${result.stderr || result.error?.message || "unknown error"}`);
    }
    return result.stdout.trim();
  }

  private runGitAsync(cwd: string, args: string[]): Promise<CapturedGitResult> {
    return this.gitRunAsync(cwd, args);
  }

  /** Capture through private files because Bun's test runner may intercept child pipes. */
  private runGit(cwd: string, args: string[]): CapturedGitResult {
    const captureRoot = mkdtempSync(join(tmpdir(), "zintus-git-capture-"));
    const stdoutPath = join(captureRoot, "stdout");
    const stderrPath = join(captureRoot, "stderr");
    const stdoutFd = openSync(stdoutPath, "w+", 0o600);
    const stderrFd = openSync(stderrPath, "w+", 0o600);
    try {
      const gitSpawn = this.gitSpawn;
      const result = gitSpawn("git", ["-C", cwd, ...args], {
        shell: false,
        encoding: "utf8",
        timeout: 120_000,
        maxBuffer: 8 * 1024 * 1024,
        stdio: ["ignore", stdoutFd, stderrFd],
      });
      const resultStdout = result.stdout ?? result.output?.[1] ?? "";
      const resultStderr = result.stderr ?? result.output?.[2] ?? "";
      const capturedStdout = readFileSync(stdoutPath, "utf8") || Buffer.from(resultStdout).toString("utf8");
      const capturedStderr = readFileSync(stderrPath, "utf8") || Buffer.from(resultStderr).toString("utf8");
      return {
        status: result.status,
        signal: result.signal,
        stdout: capturedStdout,
        stderr: capturedStderr,
        ...(result.error ? { error: result.error } : {}),
      };
    } finally {
      closeSync(stdoutFd);
      closeSync(stderrFd);
      rmSync(captureRoot, { recursive: true, force: true });
    }
  }
}
