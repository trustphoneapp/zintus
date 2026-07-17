import { execFile } from "node:child_process";

export interface AsyncProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
  killGraceMs?: number;
}

export interface AsyncProcessResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

type ExecFailure = Error & {
  code?: string | number | null;
  killed?: boolean;
  signal?: NodeJS.Signals | null;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
};

/**
 * Runs an argv-only child process without blocking the gateway event loop.
 * Non-zero exits remain ordinary command results; spawn, timeout, and output
 * bound failures are returned as infrastructure errors.
 */
export function runProcessAsync(
  executable: string,
  args: string[],
  options: AsyncProcessOptions,
): Promise<AsyncProcessResult> {
  return new Promise((resolve) => {
    let settled = false;
    let terminationReason: "TIMEOUT" | "ABORTED" | null = null;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    let hardStopTimer: ReturnType<typeof setTimeout> | null = null;
    const graceMs = options.killGraceMs ?? 250;
    const finish = (result: AsyncProcessResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      if (hardStopTimer) clearTimeout(hardStopTimer);
      options.signal?.removeEventListener("abort", abort);
      resolve(result);
    };
    const child = execFile(executable, args, {
      cwd: options.cwd,
      env: options.env,
      maxBuffer: options.maxOutputBytes,
      encoding: "utf8",
      windowsHide: true,
    }, (failure, stdout, stderr) => {
      if (terminationReason) {
        const processError = new Error(terminationReason === "TIMEOUT"
          ? `process exceeded ${options.timeoutMs}ms`
          : "process was cancelled") as NodeJS.ErrnoException;
        processError.code = terminationReason === "TIMEOUT" ? "ETIMEDOUT" : "ABORT_ERR";
        finish({ status: null, signal: (failure as ExecFailure | null)?.signal ?? null, stdout, stderr, error: processError });
        return;
      }
      if (!failure) {
        finish({ status: 0, signal: null, stdout, stderr });
        return;
      }
      const error = failure as ExecFailure;
      const capturedStdout = typeof error.stdout === "string" ? error.stdout : error.stdout?.toString("utf8") ?? stdout;
      const capturedStderr = typeof error.stderr === "string" ? error.stderr : error.stderr?.toString("utf8") ?? stderr;
      if (typeof error.code === "number") {
        finish({ status: error.code, signal: error.signal ?? null, stdout: capturedStdout, stderr: capturedStderr });
        return;
      }
      if (error.killed || error.signal) {
        const timeoutError = new Error(`process exceeded ${options.timeoutMs}ms`) as NodeJS.ErrnoException;
        timeoutError.code = "ETIMEDOUT";
        finish({ status: null, signal: error.signal ?? null, stdout: capturedStdout, stderr: capturedStderr, error: timeoutError });
        return;
      }
      finish({ status: null, signal: error.signal ?? null, stdout: capturedStdout, stderr: capturedStderr, error });
    });
    const terminate = (reason: "TIMEOUT" | "ABORTED") => {
      if (settled || terminationReason) return;
      terminationReason = reason;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), graceMs);
      killTimer.unref?.();
      // Resolve even if an unhealthy process/runtime never reports its exit.
      hardStopTimer = setTimeout(() => {
        const processError = new Error(reason === "TIMEOUT"
          ? `process exceeded ${options.timeoutMs}ms`
          : "process was cancelled") as NodeJS.ErrnoException;
        processError.code = reason === "TIMEOUT" ? "ETIMEDOUT" : "ABORT_ERR";
        finish({ status: null, signal: "SIGKILL", stdout: "", stderr: "", error: processError });
      }, graceMs * 2);
      hardStopTimer.unref?.();
    };
    const abort = () => terminate("ABORTED");
    const timeoutTimer = setTimeout(() => terminate("TIMEOUT"), options.timeoutMs);
    timeoutTimer.unref?.();
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });
  });
}
