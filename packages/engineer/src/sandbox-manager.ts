import { randomUUID } from "node:crypto";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import type { GitWorkspaceManager } from "./git-workspace.js";
import {
  SandboxRecordSchema,
  type SandboxRecord,
  type WorkspaceRecord,
} from "./execution-contracts.js";
import { sha256 } from "./hash.js";
import type { CommandProcessResult, CommandRunner } from "./trusted-executor.js";
import {
  workspaceLockfileHash,
  type WarmSandboxPool,
  type WarmSandboxDescriptor,
} from "./warm-sandbox-pool.js";

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
  now?: () => Date;
  idFactory?: () => string;
  warmPool?: {
    pool: WarmSandboxPool;
    lockfileHash: string;
    toolchainHash: string;
  };
}

export interface ProvisionedSandbox {
  record: SandboxRecord;
  workspace: WorkspaceRecord;
  commandRunner: CommandRunner;
}

export type WarmClaimResult =
  | { status: "CLAIMED"; sandbox: ProvisionedSandbox }
  | { status: "UNAVAILABLE" }
  | { status: "INVALID" };

function combined(result: SpawnSyncReturns<string>): string {
  return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
}

/** Cold Docker sandbox provisioning with a run-specific exact-base Git worktree. */
export class DockerSandboxManager {
  private readonly options: DockerSandboxManagerOptions;

  constructor(options: DockerSandboxManagerOptions) {
    if (!/^sha256:[a-f0-9]{64}$/.test(options.imageDigest)) throw new TypeError("imageDigest must be sha256-pinned");
    if (!options.imageReference.includes("@sha256:")) throw new TypeError("imageReference must use an immutable @sha256 digest");
    if (!options.imageReference.endsWith(options.imageDigest)) throw new TypeError("image reference and configured digest disagree");
    this.options = options;
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
      return { status: "CLAIMED", sandbox: this.provisioned(input.runId, workspace, "WARM") };
    } catch (error) {
      warm.pool.quarantine(descriptor);
      return { status: "INVALID" };
    }
  }

  provisionCold(input: { runId: string; repositoryRoot: string; baseCommitSha: string }): ProvisionedSandbox {
    this.verifyDocker();
    const workspace = this.options.workspaceManager.create(input);
    return this.provisioned(input.runId, workspace, "COLD");
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

  private provisioned(runId: string, workspace: WorkspaceRecord, source: "COLD" | "WARM"): ProvisionedSandbox {
    const now = this.options.now ?? (() => new Date());
    const idFactory = this.options.idFactory ?? randomUUID;
    const environmentDigest = sha256({
      imageDigest: this.options.imageDigest,
      sandboxPolicyVersion: SANDBOX_POLICY_VERSION,
      networkPolicyVersion: NETWORK_POLICY_VERSION,
      limits: {
        cpus: this.options.limits?.cpus ?? 2,
        memory: this.options.limits?.memory ?? "2g",
        pids: this.options.limits?.pids ?? 256,
      },
    });
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
    return { record, workspace, commandRunner: this.dockerRunner(workspace) };
  }

  destroy(sandbox: ProvisionedSandbox): SandboxRecord {
    this.options.workspaceManager.remove(sandbox.workspace);
    return SandboxRecordSchema.parse({
      ...sandbox.record,
      status: "DESTROYED",
      destroyedAt: (this.options.now ?? (() => new Date()))().toISOString(),
    });
  }

  currentCommit(workspace: WorkspaceRecord): string {
    return this.options.workspaceManager.currentCommit(workspace);
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
        "--mount", `type=bind,src=${workspace.workspaceRoot},dst=/workspace,rw`,
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
}
