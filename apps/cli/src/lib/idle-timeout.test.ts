import { describe, expect, it } from "bun:test";
import { IdleTimeoutError, withIdleTimeout } from "./idle-timeout.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function* emitting(gaps: number[]): AsyncGenerator<number> {
  for (const [i, gap] of gaps.entries()) {
    await sleep(gap);
    yield i;
  }
}

describe("withIdleTimeout", () => {
  it("passes every event through when gaps stay under the limit", async () => {
    const seen: number[] = [];
    for await (const v of withIdleTimeout(emitting([5, 5, 5]), 200)) {
      seen.push(v);
    }
    expect(seen).toEqual([0, 1, 2]);
  });

  it("throws IdleTimeoutError on a stalled gap (per-gap, not total)", async () => {
    const seen: number[] = [];
    // Total runtime exceeds idleMs but each early gap is fine; only the 500ms
    // stall trips it.
    const run = async () => {
      for await (const v of withIdleTimeout(emitting([5, 5, 500]), 60)) {
        seen.push(v);
      }
    };
    await expect(run()).rejects.toBeInstanceOf(IdleTimeoutError);
    expect(seen).toEqual([0, 1]);
  });

  it("asks the source to close without blocking its own exit on the stall", async () => {
    let closed = false;
    async function* stalls(): AsyncGenerator<number> {
      try {
        yield 1;
        await sleep(200);
        yield 2;
      } finally {
        closed = true;
      }
    }
    const started = Date.now();
    const run = async () => {
      for await (const _ of withIdleTimeout(stalls(), 50)) {
        // consume
      }
    };
    await expect(run()).rejects.toBeInstanceOf(IdleTimeoutError);
    // The watchdog must NOT wait out the 200ms stall to throw…
    expect(Date.now() - started).toBeLessThan(180);
    // …and the queued return() closes the source once its pending op settles.
    await sleep(300);
    expect(closed).toBe(true);
  });
});
