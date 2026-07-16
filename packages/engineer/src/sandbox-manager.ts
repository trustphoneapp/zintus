import { randomUUID } from "node:crypto";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import type { GitWorkspaceManager } from "./git-workspace.js";
import {
  SandboxRecordSchema,
  type SandboxRecord,
  type WorkspaceRecord,
} from "./execution-contracts.js";
import { sha256 } from "./hash.js";
import type { AsyncCommandRunner, CommandProcessResult, CommandRunner } from "./trusted-executor.js";
import { runProcessAsync, type AsyncProcessResult } from "./async-process.js";
import {
  NO_LOCKFILE_HASH,
  workspaceLockfileHash,
  type WarmSandboxPool,
  type WarmSandboxDescriptor,
} from "./warm-sandbox-pool.js";
import type { OfflineDependencyBundle } from "./offline-dependencies.js";

export const SANDBOX_POLICY_VERSION = "engineer-sandbox-v1";
export const NETWORK_POLICY_VERSION = "engineer-network-deny-v1";

export interface DockerSandboxLimits {
  cpus?: number;
  memory?: string;
  pids?: number;
}

export interface DockerSandboxManagerOptions {
  workspaceManager: GitWorkspaceManager;
  imageReference: string;
  imageDigest: string;
  limits?: DockerSandboxLimits;
  dockerSpawn?: typeof spawnSync;
  dockerRunAsync?: (args: string[], options: { timeoutMs: number; maxOutputBytes: number; env?: NodeJS.ProcessEnv }) => Promise<AsyncProcessResult>;
  now?: () => Date;
  idFactory?: () => string;
  warmPool?: {
    pool: WarmSandboxPool;
    lockfileHash: string;
    toolchainHash: string;
  };
  offlineDependencies?: OfflineDependencyBundle;
}

export interface ProvisionedSandbox {
  record: SandboxRecord;
  workspace: WorkspaceRecord;
  commandRunner: CommandRunner;
  commandRunnerAsync?: AsyncCommandRunner;
}

export type WarmClaimResult =
  | { status: "CLAIMED"; sandbox: ProvisionedSandbox }
  | { status: "UNAVAILABLE" }
  | { status: "INVALID" };

/** Execution-provider boundary shared by local Docker and future cloud micro-VM adapters. */
export interface ISandbox {
  warmEnabled(): boolean;
  claimWarmAsync(input: { runId: string; repositoryId: string; repositoryRoot: string; baseCommitSha: string }): Promise<WarmClaimResult>;
  provisionColdAsync(input: { runId: string; repositoryRoot: string; baseCommitSha: string }): Promise<ProvisionedSandbox>;
  recoverAsync(input: { workspace: WorkspaceRecord; sandbox: SandboxRecord; resetToHead: boolean }): Promise<ProvisionedSandbox>;
  destroy(sandbox: ProvisionedSandbox): SandboxRecord;
  destroyAsync(sandbox: ProvisionedSandbox): Promise<SandboxRecord>;
  currentCommit(workspace: WorkspaceRecord): string;
  currentCommitAsync(workspace: WorkspaceRecord): Promise<string>;
  workspaceManager(): GitWorkspaceManager;
}

function combined(result: SpawnSyncReturns<string>): string {
  return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
}

/** Cold Docker sandbox provisioning with a run-specific exact-base Git worktree. */
export class DockerSandboxManager implements ISandbox {
  private readonly options: DockerSandboxManagerOptions;
  private readonly dockerRunAsync: NonNullable<DockerSandboxManagerOptions["dockerRunAsync"]>;

  constructor(options: DockerSandboxManagerOptions) {
    if (!/^sha256:[a-f0-9]{64}$/.test(options.imageDigest)) throw new TypeError("imageDigest must be sha256-pinned");
    if (!options.imageReference.includes("@sha256:")) throw new TypeError("imageReference must use an immutable @sha256 digest");
    if (!options.imageReference.endsWith(options.imageDigest)) throw new TypeError("image reference and configured digest disagree");
    this.options = options;
    this.dockerRunAsync = options.dockerRunAsync ?? (options.dockerSpawn
      ? async (args, processOptions) => {
          const result = options.dockerSpawn!("docker", args, {
            shell: false, encoding: "utf8", timeout: processOptions.timeoutMs,
            maxBuffer: processOptions.maxOutputBytes, env: processOptions.env,
            stdio: ["ignore", "pipe", "pipe"],
          });
          return {
            status: result.status, signal: result.signal,
            stdout: result.stdout ?? "", stderr: result.stderr ?? "",
            ...(result.error ? { error: result.error } : {}),
          };
        }
      : (args, processOptions) => runProcessAsync("docker", args, {
          timeoutMs: processOptions.timeoutMs,
          maxOutputBytes: processOptions.maxOutputBytes,
          env: processOptions.env,
        }));
  }

  provision(input: { runId: string; repositoryRoot: string; baseCommitSha: string }): ProvisionedSandbox {
    return this.provisionCold(input);
  }

  warmEnabled(): boolean {
    return this.options.warmPool !== undefined;
  }

  prewarm(input: {
    repositoryId: string;
    repositoryRoot: string;
    baseCommitSha: string;
    ttlMs?: number;
  }): WarmSandboxDescriptor {
    const warm = this.options.warmPool;
    if (!warm) throw new Error("warm sandbox pool is not configured");
    this.verifyDocker();
    const warmId = `warm-${(this.options.idFactory ?? randomUUID)()}`;
    const workspace = this.options.workspaceManager.create({
      runId: warmId,
      repositoryRoot: input.repositoryRoot,
      baseCommitSha: input.baseCommitSha,
    });
    const actualLockfileHash = workspaceLockfileHash(workspace.workspaceRoot);
    if (actualLockfileHash !== warm.lockfileHash) {
      this.options.workspaceManager.remove(workspace);
      throw new Error("prewarmed workspace lockfile does not match the configured warm key");
    }
    const now = (this.options.now ?? (() => new Date()))();
    return warm.pool.register({
      repositoryId: input.repositoryId,
      repositoryRoot: workspace.repositoryRoot,
      workspaceRoot: workspace.workspaceRoot,
      originUrl: workspace.originUrl,
      baseCommitSha: workspace.baseCommitSha,
      imageDigest: this.options.imageDigest,
      lockfileHash: actualLockfileHash,
      toolchainHash: warm.toolchainHash,
      networkPolicyVersion: NETWORK_POLICY_VERSION,
      sandboxPolicyVersion: SANDBOX_POLICY_VERSION,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + (input.ttlMs ?? 30 * 60_000)).toISOString(),
    });
  }

  claimWarm(input: {
    runId: string;
    repositoryId: string;
    repositoryRoot: string;
    baseCommitSha: string;
  }): WarmClaimResult {
    const warm = this.options.warmPool;
    if (!warm) return { status: "UNAVAILABLE" };
    this.verifyDocker();
    const descriptor = warm.pool.claim({
      repositoryId: input.repositoryId,
      baseCommitSha: input.baseCommitSha,
      imageDigest: this.options.imageDigest,
      lockfileHash: warm.lockfileHash,
      toolchainHash: warm.toolchainHash,
      networkPolicyVersion: NETWORK_POLICY_VERSION,
      sandboxPolicyVersion: SANDBOX_POLICY_VERSION,
    });
    if (!descriptor) return { status: "UNAVAILABLE" };
    try {
      if (workspaceLockfileHash(descriptor.workspaceRoot) !== descriptor.lockfileHash) {
        throw new Error("warm workspace lockfile hash mismatch");
      }
      const workspace = this.options.workspaceManager.claimWarm({
        runId: input.runId,
        repositoryRoot: input.repositoryRoot,
        workspaceRoot: descriptor.workspaceRoot,
        baseCommitSha: input.baseCommitSha,
        expectedOriginUrl: descriptor.originUrl,
      });
      if (workspaceLockfileHash(workspace.workspaceRoot) !== NO_LOCKFILE_HASH) {
        throw new Error("dependency-bearing warm workspaces require asynchronous offline dependency verification");
      }
      return { status: "CLAIMED", sandbox: this.provisioned(input.runId, workspace, "WARM") };
    } catch (error) {
      warm.pool.quarantine(descriptor);
      return { status: "INVALID" };
    }
  }

  async claimWarmAsync(input: {
    runId: string;
    repositoryId: string;
    repositoryRoot: string;
    baseCommitSha: string;
  }): Promise<WarmClaimResult> {
    const warm = this.options.warmPool;
    if (!warm) return { status: "UNAVAILABLE" };
    await this.verifyDockerAsync();
    const descriptor = warm.pool.claim({
      repositoryId: input.repositoryId,
      baseCommitSha: input.baseCommitSha,
      imageDigest: this.options.imageDigest,
      lockfileHash: warm.lockfileHash,
      toolchainHash: warm.toolchainHash,
      networkPolicyVersion: NETWORK_POLICY_VERSION,
      sandboxPolicyVersion: SANDBOX_POLICY_VERSION,
    });
    if (!descriptor) return { status: "UNAVAILABLE" };
    try {
      if (workspaceLockfileHash(descriptor.workspaceRoot) !== descriptor.lockfileHash) throw new Error("warm workspace lockfile hash mismatch");
      const workspace = await this.options.workspaceManager.claimWarmAsync({
        runId: input.runId, repositoryRoot: input.repositoryRoot, workspaceRoot: descriptor.workspaceRoot,
        baseCommitSha: input.baseCommitSha, expectedOriginUrl: descriptor.originUrl,
      });
      await this.verifyOfflineDependencies(workspace);
      return { status: "CLAIMED", sandbox: this.provisioned(input.runId, workspace, "WARM") };
    } catch {
      warm.pool.quarantine(descriptor);
      return { status: "INVALID" };
    }
  }

  provisionCold(input: { runId: string; repositoryRoot: string; baseCommitSha: string }): ProvisionedSandbox {
    this.verifyDocker();
    const workspace = this.options.workspaceManager.create(input);
    if (workspaceLockfileHash(workspace.workspaceRoot) !== NO_LOCKFILE_HASH) {
      this.options.workspaceManager.remove(workspace);
      throw new Error("dependency-bearing repositories require asynchronous offline dependency verification");
    }
    return this.provisioned(input.runId, workspace, "COLD");
  }

  async provisionColdAsync(input: { runId: string; repositoryRoot: string; baseCommitSha: string }): Promise<ProvisionedSandbox> {
    await this.verifyDockerAsync();
    const workspace = await this.options.workspaceManager.createAsync(input);
    try {
      await this.verifyOfflineDependencies(workspace);
      return this.provisioned(input.runId, workspace, "COLD");
    } catch (error) {
      await this.options.workspaceManager.removeAsync(workspace).catch(() => undefined);
      throw error;
    }
  }

  /** Reconstructs command runners for a hash-bound retained Phase-2 sandbox. */
  async recoverAsync(input: {
    workspace: WorkspaceRecord;
    sandbox: SandboxRecord;
    resetToHead: boolean;
  }): Promise<ProvisionedSandbox> {
    const record = SandboxRecordSchema.parse(input.sandbox);
    if (record.status !== "READY" || record.destroyedAt !== null) throw new Error("retained sandbox is not recoverable");
    if (record.imageReference !== this.options.imageReference || record.imageDigest !== this.options.imageDigest) {
      throw new Error("retained sandbox image does not match current immutable configuration");
    }
    if (record.networkPolicyVersion !== NETWORK_POLICY_VERSION || record.sandboxPolicyVersion !== SANDBOX_POLICY_VERSION) {
      throw new Error("retained sandbox policy version is no longer accepted");
    }
    if (record.environmentDigest !== this.environmentDigest()) throw new Error("retained sandbox environment digest mismatch");
    await this.verifyDockerAsync();
    const workspace = await this.options.workspaceManager.recoverExistingAsync(input.workspace, input.resetToHead);
    if (record.runId !== workspace.runId || record.workspaceIdentity !== workspace.workspaceIdentity) {
      throw new Error("retained sandbox is bound to another workspace");
    }
    await this.verifyOfflineDependencies(workspace);
    return {
      record,
      workspace,
      commandRunner: this.dockerRunner(workspace),
      commandRunnerAsync: this.dockerRunnerAsync(workspace),
    };
  }

  private async verifyOfflineDependencies(workspace: WorkspaceRecord): Promise<void> {
    const lockfileHash = workspaceLockfileHash(workspace.workspaceRoot);
    if (lockfileHash === NO_LOCKFILE_HASH) return;
    const bundle = this.options.offlineDependencies;
    if (!bundle) throw new Error("dependency-bearing repositories require an immutable offline dependency bundle");
    if (bundle.manifest.lockfileHash !== lockfileHash) throw new Error("offline dependency bundle does not match the exact workspace lockfile");
    await bundle.verify();
  }

  private verifyDocker(): void {
    const dockerSpawn = this.options.dockerSpawn ?? spawnSync;
    const info = dockerSpawn("docker", ["info", "--format", "{{.ServerVersion}}"], {
      shell: false, encoding: "utf8", timeout: 5_000,
    });
    if (info.status !== 0) throw new Error(`Docker is unavailable: ${combined(info)}`);
    const inspect = dockerSpawn("docker", ["image", "inspect", "--format", "{{json .RepoDigests}}", this.options.imageReference], {
      shell: false, encoding: "utf8", timeout: 30_000,
    });
    if (inspect.status !== 0 || !combined(inspect).includes(this.options.imageDigest)) {
      throw new Error("pinned sandbox image is unavailable or its digest cannot be verified");
    }
  }

  private async verifyDockerAsync(): Promise<void> {
    const info = await this.dockerRunAsync(["info", "--format", "{{.ServerVersion}}"], {
      timeoutMs: 5_000, maxOutputBytes: 1024 * 1024,
    });
    if (info.status !== 0) throw new Error(`Docker is unavailable: ${`${info.stdout}${info.stderr}`.trim() || info.error?.message || "unknown error"}`);
    const inspect = await this.dockerRunAsync(["image", "inspect", "--format", "{{json .RepoDigests}}", this.options.imageReference], {
      timeoutMs: 30_000, maxOutputBytes: 1024 * 1024,
    });
    if (inspect.status !== 0 || !`${inspect.stdout}${inspect.stderr}`.includes(this.options.imageDigest)) {
      throw new Error("pinned sandbox image is unavailable or its digest cannot be verified");
    }
  }

  private provisioned(runId: string, workspace: WorkspaceRecord, source: "COLD" | "WARM"): ProvisionedSandbox {
    const now = this.options.now ?? (() => new Date());
    const idFactory = this.options.idFactory ?? randomUUID;
    const environmentDigest = this.environmentDigest();
    const record = SandboxRecordSchema.parse({
      sandboxId: idFactory(),
      runId,
      workspaceIdentity: workspace.workspaceIdentity,
      imageReference: this.options.imageReference,
      imageDigest: this.options.imageDigest,
      environmentDigest,
      networkPolicyVersion: NETWORK_POLICY_VERSION,
      sandboxPolicyVersion: SANDBOX_POLICY_VERSION,
      status: "READY",
      source,
      createdAt: now().toISOString(),
      destroyedAt: null,
    });
    return { record, workspace, commandRunner: this.dockerRunner(workspace), commandRunnerAsync: this.dockerRunnerAsync(workspace) };
  }

  private environmentDigest(): string {
    return sha256({
      imageDigest: this.options.imageDigest,
      offlineDependencyHash: this.options.offlineDependencies?.manifest.contentHash ?? null,
      sandboxPolicyVersion: SANDBOX_POLICY_VERSION,
      networkPolicyVersion: NETWORK_POLICY_VERSION,
      limits: {
        cpus: this.options.limits?.cpus ?? 2,
        memory: this.options.limits?.memory ?? "2g",
        pids: this.options.limits?.pids ?? 256,
      },
    });
  }

  destroy(sandbox: ProvisionedSandbox): SandboxRecord {
    this.options.workspaceManager.remove(sandbox.workspace);
    return SandboxRecordSchema.parse({
      ...sandbox.record,
      status: "DESTROYED",
      destroyedAt: (this.options.now ?? (() => new Date()))().toISOString(),
    });
  }

  async destroyAsync(sandbox: ProvisionedSandbox): Promise<SandboxRecord> {
    await this.options.workspaceManager.removeAsync(sandbox.workspace);
    return SandboxRecordSchema.parse({
      ...sandbox.record,
      status: "DESTROYED",
      destroyedAt: (this.options.now ?? (() => new Date()))().toISOString(),
    });
  }

  currentCommit(workspace: WorkspaceRecord): string {
    return this.options.workspaceManager.currentCommit(workspace);
  }

  currentCommitAsync(workspace: WorkspaceRecord): Promise<string> {
    return this.options.workspaceManager.currentCommitAsync(workspace);
  }

  workspaceManager(): GitWorkspaceManager {
    return this.options.workspaceManager;
  }

  private dockerRunner(workspace: WorkspaceRecord): CommandRunner {
    const dockerSpawn = this.options.dockerSpawn ?? spawnSync;
    const limits = {
      cpus: this.options.limits?.cpus ?? 2,
      memory: this.options.limits?.memory ?? "2g",
      pids: this.options.limits?.pids ?? 256,
    };
    return (executable, args, commandOptions): CommandProcessResult => {
      const containerEnvironment = Object.entries(commandOptions.env)
        .filter((entry): entry is [string, string] => entry[1] !== undefined)
        .flatMap(([name, value]) => ["--env", `${name}=${value}`]);
      const dockerArgs = [
        "run", "--rm", "--network=none", "--read-only", "--cap-drop=ALL",
        "--security-opt", "no-new-privileges", "--user", "1000:1000",
        "--cpus", String(limits.cpus), "--memory", limits.memory,
        "--pids-limit", String(limits.pids), "--tmpfs", "/tmp:rw,noexec,nosuid,size=256m",
        // Writable is the default for Docker's long --mount syntax. Current
        // Docker releases reject a bare `rw` field as an invalid key.
        "--mount", `type=bind,src=${workspace.workspaceRoot},dst=/workspace`,
        ...(this.options.offlineDependencies ? ["--mount", `type=bind,src=${this.options.offlineDependencies.nodeModulesRoot},dst=/workspace/node_modules,readonly`] : []),
        "--workdir", "/workspace", ...containerEnvironment,
        this.options.imageReference, executable, ...args,
      ];
      const hostEnvironment: NodeJS.ProcessEnv = {};
      for (const name of ["PATH", "HOME", "TMPDIR", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "XDG_RUNTIME_DIR"] as const) {
        if (process.env[name]) hostEnvironment[name] = process.env[name];
      }
      const result = dockerSpawn("docker", dockerArgs, {
        shell: false,
        encoding: "utf8",
        timeout: commandOptions.timeoutMs,
        maxBuffer: commandOptions.maxOutputBytes,
        env: hostEnvironment,
        stdio: ["ignore", "pipe", "pipe"],
      });
      return {
        status: result.status,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        ...(result.error ? { error: result.error } : {}),
      };
    };
  }


  private dockerRunnerAsync(workspace: WorkspaceRecord): AsyncCommandRunner {
    const limits = {
      cpus: this.options.limits?.cpus ?? 2,
      memory: this.options.limits?.memory ?? "2g",
      pids: this.options.limits?.pids ?? 256,
    };
    return async (executable, args, commandOptions): Promise<CommandProcessResult> => {
      const containerEnvironment = Object.entries(commandOptions.env)
        .filter((entry): entry is [string, string] => entry[1] !== undefined)
        .flatMap(([name, value]) => ["--env", `${name}=${value}`]);
      const dockerArgs = [
        "run", "--rm", "--network=none", "--read-only", "--cap-drop=ALL",
        "--security-opt", "no-new-privileges", "--user", "1000:1000",
        "--cpus", String(limits.cpus), "--memory", limits.memory,
        "--pids-limit", String(limits.pids), "--tmpfs", "/tmp:rw,noexec,nosuid,size=256m",
        "--mount", `type=bind,src=${workspace.workspaceRoot},dst=/workspace`,
        ...(this.options.offlineDependencies ? ["--mount", `type=bind,src=${this.options.offlineDependencies.nodeModulesRoot},dst=/workspace/node_modules,readonly`] : []),
        "--workdir", "/workspace", ...containerEnvironment,
        this.options.imageReference, executable, ...args,
      ];
      const hostEnvironment: NodeJS.ProcessEnv = {};
      for (const name of ["PATH", "HOME", "TMPDIR", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "XDG_RUNTIME_DIR"] as const) {
        if (process.env[name]) hostEnvironment[name] = process.env[name];
      }
      return this.dockerRunAsync(dockerArgs, {
        timeoutMs: commandOptions.timeoutMs,
        maxOutputBytes: commandOptions.maxOutputBytes,
        env: hostEnvironment,
      });
    };
  }
}
