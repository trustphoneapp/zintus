import { describe, expect, test } from "bun:test";
import { runProcessAsync } from "./async-process.js";

describe("Phase 2 non-blocking process boundary", () => {
  test("long child work does not block the gateway event loop", async () => {
    let timerObserved = false;
    const child = runProcessAsync(process.execPath, ["-e", "setTimeout(() => process.exit(0), 120)"], {
      timeoutMs: 2_000,
      maxOutputBytes: 1024,
    });
    await new Promise<void>((resolve) => setTimeout(() => { timerObserved = true; resolve(); }, 20));
    expect(timerObserved).toBe(true);
    expect((await child).status).toBe(0);
  });

  test("preserves non-zero exits without misclassifying them as spawn failures", async () => {
    const result = await runProcessAsync(process.execPath, ["-e", "process.stderr.write('failed'); process.exit(7)"], {
      timeoutMs: 2_000,
      maxOutputBytes: 1024,
    });
    expect(result).toMatchObject({ status: 7, stderr: "failed" });
    expect(result.error).toBeUndefined();
  });

  test("terminates and classifies bounded-time overruns", async () => {
    const result = await runProcessAsync(process.execPath, ["-e", "setTimeout(() => {}, 10_000)"], {
      timeoutMs: 25,
      maxOutputBytes: 1024,
    });
    expect(result.status).toBeNull();
    expect((result.error as NodeJS.ErrnoException | undefined)?.code).toBe("ETIMEDOUT");
  });
});
