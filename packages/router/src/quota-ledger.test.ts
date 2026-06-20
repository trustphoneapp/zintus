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
