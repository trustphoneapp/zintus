import { execFile } from "node:child_process";

export interface AsyncProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes: number;
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
    execFile(executable, args, {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeoutMs,
      maxBuffer: options.maxOutputBytes,
      encoding: "utf8",
      windowsHide: true,
    }, (failure, stdout, stderr) => {
      if (!failure) {
        resolve({ status: 0, signal: null, stdout, stderr });
        return;
      }
      const error = failure as ExecFailure;
      const capturedStdout = typeof error.stdout === "string" ? error.stdout : error.stdout?.toString("utf8") ?? stdout;
      const capturedStderr = typeof error.stderr === "string" ? error.stderr : error.stderr?.toString("utf8") ?? stderr;
      if (typeof error.code === "number") {
        resolve({ status: error.code, signal: error.signal ?? null, stdout: capturedStdout, stderr: capturedStderr });
        return;
      }
      if (error.killed || error.signal) {
        const timeoutError = new Error(`process exceeded ${options.timeoutMs}ms`) as NodeJS.ErrnoException;
        timeoutError.code = "ETIMEDOUT";
        resolve({ status: null, signal: error.signal ?? null, stdout: capturedStdout, stderr: capturedStderr, error: timeoutError });
        return;
      }
      resolve({ status: null, signal: error.signal ?? null, stdout: capturedStdout, stderr: capturedStderr, error });
    });
  });
}
