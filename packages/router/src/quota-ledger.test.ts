import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { QuotaLedger } from "./quota-ledger.js";

describe("QuotaLedger", () => {
  let dbPath: string;
  let ledger: QuotaLedger;

  afterEach(() => {
    ledger?.close();
    if (dbPath) {
      rmSync(dbPath, { force: true });
    }
  });

  it("tracks usage and enforces daily limits", () => {
    const dir = mkdtempSync(join(tmpdir(), "zintus-test-"));
    dbPath = join(dir, "quota.db");
    ledger = new QuotaLedger(dbPath);

    const now = Date.UTC(2026, 5, 15, 12, 0, 0);
    expect(ledger.isQuotaAvailable("gemini", now)).toBe(true);

    // 1500 successful requests exhaust gemini's requestsPerDay (1500). Only a
    // success debits the daily request budget (see the zero-cost-on-error tests
    // below), so this must use status "success" to drive requestsToday to the cap.
    for (let i = 0; i < 1_500; i++) {
      ledger.recordUsage("gemini", { status: "success" }, now);
    }

    expect(ledger.getProvider("gemini")!.requestsToday).toBe(1_500);
    expect(ledger.isQuotaAvailable("gemini", now)).toBe(false);
  });

  it("a failed request does not debit the daily request budget (zero-cost-on-error)", () => {
    const dir = mkdtempSync(join(tmpdir(), "zintus-test-"));
    dbPath = join(dir, "quota.db");
    ledger = new QuotaLedger(dbPath);

    const now = Date.UTC(2026, 5, 15, 12, 0, 0);
    ledger.ensureProvider("gemini");
    expect(ledger.getProvider("gemini")!.requestsToday).toBe(0);

    // A provider error / rate-limit returns no usable response and bills zero
    // tokens — it must consume NEITHER the daily token budget NOR the daily
    // request count.
    ledger.recordUsage("gemini", { status: "error", errorCode: 500 }, now);
    ledger.recordUsage("gemini", { status: "rate_limited", errorCode: 429 }, now);

    const row = ledger.getProvider("gemini")!;
    expect(row.requestsToday).toBe(0);
    expect(row.tokensToday).toBe(0);
  });

  it("a successful request debits the daily request budget by exactly one", () => {
    const dir = mkdtempSync(join(tmpdir(), "zintus-test-"));
    dbPath = join(dir, "quota.db");
    ledger = new QuotaLedger(dbPath);

    const now = Date.UTC(2026, 5, 15, 12, 0, 0);
    ledger.recordUsage("gemini", { status: "success", tokensIn: 10, tokensOut: 5 }, now);

    let row = ledger.getProvider("gemini")!;
    expect(row.requestsToday).toBe(1);
    expect(row.tokensToday).toBe(15);

    // A failure in between leaves the request count untouched; the next success
    // advances it by one again — failures never inflate the daily request count.
    ledger.recordUsage("gemini", { status: "error", errorCode: 500 }, now);
    ledger.recordUsage("gemini", { status: "success" }, now);

    row = ledger.getProvider("gemini")!;
    expect(row.requestsToday).toBe(2);
  });

  it("a failed request is still logged for the rolling window and error streak", () => {
    const dir = mkdtempSync(join(tmpdir(), "zintus-test-"));
    dbPath = join(dir, "quota.db");
    ledger = new QuotaLedger(dbPath);

    const now = Date.UTC(2026, 5, 15, 12, 0, 0);
    ledger.recordUsage("groq", { status: "error", errorCode: 500 }, now);

    // Not charged to the persisted DAILY request budget...
    expect(ledger.getProvider("groq")!.requestsToday).toBe(0);
    // ...but still recorded in usage_log so the rolling 60s RPM window (a failed
    // call DID hit the provider's rate limiter) and the health-aware error streak
    // both continue to see it — the live concurrency/health guards are intact.
    expect(ledger.countRecentUsage("groq", 60_000, now).requests).toBe(1);
    expect(ledger.recentErrorCount("groq", 60_000, now)).toBe(1);
  });

  it("values savings per-model, not just per-provider", () => {
    const dir = mkdtempSync(join(tmpdir(), "zintus-test-"));
    dbPath = join(dir, "quota.db");
    ledger = new QuotaLedger(dbPath);

    const now = Date.UTC(2026, 5, 15, 12, 0, 0);
    // 1M tokens on Groq's cheap 8B tier ($0.08/Mtok) and 1M on its 70B tier
    // ($0.60/Mtok). A per-provider anchor would value both at 0.60.
    ledger.recordUsage(
      "groq",
      { status: "success", tokensIn: 1_000_000, model: "llama-3.1-8b-instant" },
      now,
    );
    ledger.recordUsage(
      "groq",
      { status: "success", tokensIn: 1_000_000, model: "llama-3.3-70b-versatile" },
      now,
    );

    const savings = ledger.savingsUsd();
    expect(savings.byProvider.groq).toBeCloseTo(0.08 + 0.6, 5);
    expect(savings.total).toBeCloseTo(0.68, 5);
  });

  it("applies Groq rolling-window reset from headers", () => {
    const dir = mkdtempSync(join(tmpdir(), "zintus-test-"));
    dbPath = join(dir, "quota.db");
    ledger = new QuotaLedger(dbPath);

    const now = 1_700_000_000_000;
    ledger.recordUsage("groq", { status: "rate_limited", errorCode: 429 }, now);
    ledger.applyGroqRateLimitFromHeaders("groq", "0", "30s", now);

    expect(ledger.isQuotaAvailable("groq", now)).toBe(false);
    expect(ledger.isQuotaAvailable("groq", now + 31_000)).toBe(true);
  });

  it("sets exponential cooldown", () => {
    const dir = mkdtempSync(join(tmpdir(), "zintus-test-"));
    dbPath = join(dir, "quota.db");
    ledger = new QuotaLedger(dbPath);

    const now = 1_700_000_000_000;
    ledger.setCooldown("gemini", 1, now);
    expect(ledger.isQuotaAvailable("gemini", now)).toBe(false);
    expect(ledger.isQuotaAvailable("gemini", now + 60_001)).toBe(true);
  });

  it("recentStats: null metrics when there are too few samples (honest)", () => {
    const dir = mkdtempSync(join(tmpdir(), "zintus-test-"));
    dbPath = join(dir, "quota.db");
    ledger = new QuotaLedger(dbPath);

    const now = 1_700_000_000_000;
    // Untouched provider: zero samples → every metric null, samples 0.
    const empty = ledger.recentStats("groq", {}, now);
    expect(empty).toEqual({
      latencyP95Ms: null,
      successRate: null,
      throughputTps: null,
      samples: 0,
    });

    // Two successes (default minSamples is 3) → still null, never a guess.
    ledger.recordUsage(
      "groq",
      { status: "success", tokensOut: 100, latencyMs: 200 },
      now,
    );
    ledger.recordUsage(
      "groq",
      { status: "success", tokensOut: 100, latencyMs: 200 },
      now,
    );
    const two = ledger.recentStats("groq", {}, now);
    expect(two.samples).toBe(2);
    expect(two.latencyP95Ms).toBeNull();
    expect(two.successRate).toBeNull();
    expect(two.throughputTps).toBeNull();
  });

  it("recentStats: measured p95 / success-rate / throughput once enough samples", () => {
    const dir = mkdtempSync(join(tmpdir(), "zintus-test-"));
    dbPath = join(dir, "quota.db");
    ledger = new QuotaLedger(dbPath);

    const now = 1_700_000_000_000;
    // 3 successes (latency 100/200/300 ms, 100 output tokens each) + 1 error.
    // tokens/sec per success: 1000, 500, 333.3 → median 500.
    ledger.recordUsage(
      "groq",
      { status: "success", tokensOut: 100, latencyMs: 100 },
      now,
    );
    ledger.recordUsage(
      "groq",
      { status: "success", tokensOut: 100, latencyMs: 200 },
      now,
    );
    ledger.recordUsage(
      "groq",
      { status: "success", tokensOut: 100, latencyMs: 300 },
      now,
    );
    ledger.recordUsage("groq", { status: "error", errorCode: 500 }, now);

    const stats = ledger.recentStats("groq", {}, now);
    expect(stats.samples).toBe(4);
    // 3 successes / 4 total attempts.
    expect(stats.successRate).toBeCloseTo(0.75, 5);
    // p95 over [100,200,300] → top sample.
    expect(stats.latencyP95Ms).toBe(300);
    // median tokens/sec.
    expect(stats.throughputTps).toBeCloseTo(500, 5);
  });
});
