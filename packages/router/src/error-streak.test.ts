import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { QuotaLedger } from "./quota-ledger.js";

// The Zintus "circuit breaker" is NOT a textbook CLOSED/OPEN/HALF_OPEN enum. It
// is three cooperating mechanisms (see factory.ts):
//   1. exponential cooldown (computeCooldownMs)        — tested in cooldown.test.ts
//   2. error-streak demotion: a provider with >= ERROR_STREAK_THRESHOLD (3)
//      recent errors in ERROR_STREAK_WINDOW_MS (5min) is dropped by isEligible
//      WITHOUT needing a formal cooldown — driven by ledger.recentErrorCount
//   3. half-open single-probe gate                     — concurrency, integration
// This file pins mechanism (2)'s primitive deterministically using the
// injectable `now` on recordUsage/recentErrorCount (no real timers).

const THRESHOLD = 3; // ERROR_STREAK_THRESHOLD in factory.ts
const WINDOW_MS = 5 * 60_000; // ERROR_STREAK_WINDOW_MS in factory.ts

describe("error-streak rolling window (recentErrorCount)", () => {
  let dbPath: string;
  let ledger: QuotaLedger;

  afterEach(() => {
    ledger?.close();
    if (dbPath) rmSync(dbPath, { force: true });
  });

  function freshLedger(): QuotaLedger {
    const dir = mkdtempSync(join(tmpdir(), "zintus-streak-"));
    dbPath = join(dir, "quota.db");
    ledger = new QuotaLedger(dbPath);
    return ledger;
  }

  it("counts only error / rate_limited rows within the window", () => {
    const l = freshLedger();
    const t = Date.UTC(2026, 5, 15, 12, 0, 0);
    l.recordUsage("groq", { status: "ok" }, t);
    l.recordUsage("groq", { status: "ok" }, t);
    l.recordUsage("groq", { status: "error" }, t);
    l.recordUsage("groq", { status: "rate_limited" }, t);
    // 2 ok ignored; 1 error + 1 rate_limited counted.
    expect(l.recentErrorCount("groq", WINDOW_MS, t)).toBe(2);
  });

  it("is provider-scoped", () => {
    const l = freshLedger();
    const t = Date.UTC(2026, 5, 15, 12, 0, 0);
    l.recordUsage("groq", { status: "error" }, t);
    l.recordUsage("groq", { status: "error" }, t);
    expect(l.recentErrorCount("groq", WINDOW_MS, t)).toBe(2);
    expect(l.recentErrorCount("gemini", WINDOW_MS, t)).toBe(0);
  });

  it("crosses the demotion threshold at exactly 3 errors", () => {
    const l = freshLedger();
    const t = Date.UTC(2026, 5, 15, 12, 0, 0);
    l.recordUsage("groq", { status: "error" }, t);
    l.recordUsage("groq", { status: "error" }, t);
    // 2 errors → still BELOW threshold → provider stays eligible (half-open zone).
    expect(l.recentErrorCount("groq", WINDOW_MS, t) >= THRESHOLD).toBe(false);
    l.recordUsage("groq", { status: "error" }, t);
    // 3rd error → AT threshold → isEligible would now demote the provider.
    expect(l.recentErrorCount("groq", WINDOW_MS, t) >= THRESHOLD).toBe(true);
  });

  it("ages errors out of the window: a provider recovers automatically", () => {
    const l = freshLedger();
    const t = Date.UTC(2026, 5, 15, 12, 0, 0);
    for (let i = 0; i < 5; i++) l.recordUsage("groq", { status: "error" }, t);
    expect(l.recentErrorCount("groq", WINDOW_MS, t)).toBe(5);
    // 5min + 1ms later, all errors have aged out → count 0 → provider eligible again.
    expect(l.recentErrorCount("groq", WINDOW_MS, t + WINDOW_MS + 1)).toBe(0);
    // Just before the window edge they still count.
    expect(l.recentErrorCount("groq", WINDOW_MS, t + WINDOW_MS - 1)).toBe(5);
  });
});
