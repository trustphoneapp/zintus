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

    for (let i = 0; i < 1_500; i++) {
      ledger.recordUsage("gemini", { status: "ok" }, now);
    }

    expect(ledger.isQuotaAvailable("gemini", now)).toBe(false);
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
});
