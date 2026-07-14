import { randomUUID } from "node:crypto";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { realpathSync } from "node:fs";
import type { TaskManifest } from "./contracts.js";
import type { LocalArtifactStore } from "./artifact-store.js";
import { runProcessAsync } from "./async-process.js";
import {
  CommandExecutionRecordSchema,
  type CommandExecutionRecord,
  type SandboxRecord,
  type WorkspaceRecord,
} from "./execution-contracts.js";

export const TRUSTED_COMMAND_POLICY_VERSION = "engineer-command-v1";
export const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_COMMAND_OUTPUT_BYTES = 8 * 1024 * 1024;

const SAFE_TOKEN = /^[A-Za-z0-9._/@:+,=-]+$/;
const PACKAGE_RUNNERS: Readonly<Record<string, ReadonlySet<string>>> = {
  bun: new Set(["run", "test"]),
  npm: new Set(["run", "test"]),
  pnpm: new Set(["run", "test"]),
  yarn: new Set(["run", "test"]),
};

export interface CommandProcessResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export type CommandRunner = (
  executable: string,
  args: string[],
  options: { cwd: string; timeoutMs: number; maxOutputBytes: number; env: NodeJS.ProcessEnv },
) => CommandProcessResult;

export type AsyncCommandRunner = (
  executable: string,
  args: string[],
  options: { cwd: string; timeoutMs: number; maxOutputBytes: number; env: NodeJS.ProcessEnv },
) => Promise<CommandProcessResult>;

function defaultRunner(
  executable: string,
  args: string[],
  options: { cwd: string; timeoutMs: number; maxOutputBytes: number; env: NodeJS.ProcessEnv },
): CommandProcessResult {
  const result: SpawnSyncReturns<string> = spawnSync(executable, args, {
    cwd: options.cwd,
    timeout: options.timeoutMs,
    maxBuffer: options.maxOutputBytes,
    shell: false,
    encoding: "utf8",
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    ...(result.error ? { error: result.error } : {}),
  };
}

function defaultAsyncRunner(
  executable: string,
  args: string[],
  options: { cwd: string; timeoutMs: number; maxOutputBytes: number; env: NodeJS.ProcessEnv },
): Promise<CommandProcessResult> {
  return runProcessAsync(executable, args, options);
}

export function parseTrustedCommand(command: string): string[] {
  if (command !== command.trim() || /[\r\n\0]/.test(command)) throw new Error("command must be a single trimmed line");
  const tokens = command.split(/\s+/);
  if (tokens.length < 2 || tokens.some((token) => !SAFE_TOKEN.test(token))) {
    throw new Error("command contains unsupported tokens or shell metacharacters");
  }
  const executable = tokens[0]!;
  const subcommand = tokens[1]!;
  if (!PACKAGE_RUNNERS[executable]?.has(subcommand)) {
    throw new Error(`executable/subcommand is blocked by ${TRUSTED_COMMAND_POLICY_VERSION}`);
  }
  if (subcommand === "test" && tokens.length > 3) throw new Error("test commands accept at most one target");
  if (subcommand === "run" && tokens.length < 3) throw new Error("run commands require an exact script name");
  return tokens;
}

function runtimeEnvironment(runId: string): NodeJS.ProcessEnv {
  const keep = ["PATH", "HOME", "TMPDIR", "TZ"] as const;
  const env: NodeJS.ProcessEnv = { CI: "1", ZINTUS_ENGINEER_RUN_ID: runId };
  for (const key of keep) if (process.env[key]) env[key] = process.env[key];
  return env;
}

export interface TrustedCommandExecutorOptions {
  artifactStore: LocalArtifactStore;
  workspace: WorkspaceRecord;
  sandbox: SandboxRecord;
  manifest: TaskManifest;
  runner?: CommandRunner;
  runnerAsync?: AsyncCommandRunner;
  timeoutMs?: number;
  maxOutputBytes?: number;
  now?: () => Date;
  idFactory?: () => string;
  currentCommit: () => string;
  currentCommitAsync?: () => Promise<string>;
  onRecord?: (record: CommandExecutionRecord) => void;
}

/** Executes only exact manifest commands through argv-only, no-shell process spawning. */
export class TrustedCommandExecutor {
  private readonly options: TrustedCommandExecutorOptions;
  private readonly seen = new Map<string, CommandExecutionRecord>();
  private readonly active = new Map<string, { command: string; promise: Promise<CommandExecutionRecord> }>();

  constructor(options: TrustedCommandExecutorOptions) {
    if (options.manifest.runId !== options.workspace.runId || options.manifest.runId !== options.sandbox.runId) {
      throw new Error("executor inputs belong to different runs");
    }
    if (realpathSync(options.workspace.workspaceRoot) !== options.workspace.workspaceRoot) {
      throw new Error("workspace root must be canonical");
    }
    this.options = options;
  }

  execute(command: string, idempotencyKey: string): CommandExecutionRecord {
    const previous = this.seen.get(idempotencyKey);
    if (previous) {
      if (previous.command !== command) throw new Error(`idempotency key reused for another command: ${idempotencyKey}`);
      return previous;
    }
    const argv = this.validate(command);
    const now = this.options.now ?? (() => new Date());
    const idFactory = this.options.idFactory ?? randomUUID;
    const commandExecutionId = idFactory();
    const startedAt = now().toISOString();
    const runner = this.options.runner ?? defaultRunner;
    const result = runner(argv[0]!, argv.slice(1), {
      cwd: this.options.workspace.workspaceRoot,
      timeoutMs: this.options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
      maxOutputBytes: this.options.maxOutputBytes ?? DEFAULT_MAX_COMMAND_OUTPUT_BYTES,
      env: runtimeEnvironment(this.options.manifest.runId),
    });
    return this.finalize(command, idempotencyKey, commandExecutionId, startedAt, result, this.options.currentCommit());
  }

  executeAsync(command: string, idempotencyKey: string): Promise<CommandExecutionRecord> {
    const previous = this.seen.get(idempotencyKey);
    if (previous) {
      if (previous.command !== command) return Promise.reject(new Error(`idempotency key reused for another command: ${idempotencyKey}`));
      return Promise.resolve(previous);
    }
    const running = this.active.get(idempotencyKey);
    if (running) {
      if (running.command !== command) return Promise.reject(new Error(`idempotency key reused for another command: ${idempotencyKey}`));
      return running.promise;
    }
    const argv = this.validate(command);
    const now = this.options.now ?? (() => new Date());
    const idFactory = this.options.idFactory ?? randomUUID;
    const commandExecutionId = idFactory();
    const startedAt = now().toISOString();
    const runner = this.options.runnerAsync ?? (this.options.runner
      ? async (executable, args, options) => this.options.runner!(executable, args, options)
      : defaultAsyncRunner);
    const promise = runner(argv[0]!, argv.slice(1), {
      cwd: this.options.workspace.workspaceRoot,
      timeoutMs: this.options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
      maxOutputBytes: this.options.maxOutputBytes ?? DEFAULT_MAX_COMMAND_OUTPUT_BYTES,
      env: runtimeEnvironment(this.options.manifest.runId),
    }).then(async (result) => this.finalize(
      command,
      idempotencyKey,
      commandExecutionId,
      startedAt,
      result,
      this.options.currentCommitAsync ? await this.options.currentCommitAsync() : this.options.currentCommit(),
    )).finally(() => this.active.delete(idempotencyKey));
    this.active.set(idempotencyKey, { command, promise });
    return promise;
  }

  private validate(command: string): string[] {
    if (!this.options.manifest.allowedCommands.includes(command)) {
      throw new Error("command is not present in the frozen manifest allowlist");
    }
    if (this.options.manifest.prohibitedCommands.includes(command)) {
      throw new Error("command is explicitly prohibited by the frozen manifest");
    }
    return parseTrustedCommand(command);
  }

  private finalize(
    command: string,
    idempotencyKey: string,
    commandExecutionId: string,
    startedAt: string,
    result: CommandProcessResult,
    commitSha: string,
  ): CommandExecutionRecord {
    const now = this.options.now ?? (() => new Date());
    const environmentDigest = this.options.sandbox.environmentDigest;
    const timedOut = result.error != null && (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
    const stderr = result.error && !timedOut
      ? `${result.stderr}\n${result.error.message}`.trim()
      : result.stderr;
    const stdoutArtifact = this.options.artifactStore.put({
      runId: this.options.manifest.runId,
      type: "COMMAND_STDOUT",
      bytes: result.stdout,
      producerType: "EXECUTOR",
      producerId: this.options.sandbox.sandboxId,
      trusted: true,
    });
    const stderrArtifact = this.options.artifactStore.put({
      runId: this.options.manifest.runId,
      type: "COMMAND_STDERR",
      bytes: stderr,
      producerType: "EXECUTOR",
      producerId: this.options.sandbox.sandboxId,
      trusted: true,
    });
    const status = timedOut
      ? "TIMED_OUT"
      : result.error
        ? "SPAWN_FAILED"
        : result.status === 0
          ? "SUCCEEDED"
          : "FAILED";
    const record = CommandExecutionRecordSchema.parse({
      commandExecutionId,
      runId: this.options.manifest.runId,
      sandboxId: this.options.sandbox.sandboxId,
      command,
      executorId: this.options.sandbox.sandboxId,
      exitCode: result.status,
      timedOut,
      startedAt,
      finishedAt: now().toISOString(),
      stdoutArtifact,
      stderrArtifact,
      environmentDigest,
      commitSha,
      status,
      idempotencyKey,
    });
    this.seen.set(idempotencyKey, record);
    this.options.onRecord?.(record);
    return record;
  }
}
