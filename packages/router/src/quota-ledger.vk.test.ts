import { afterEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { QuotaLedger } from "./quota-ledger.js";

const dbPaths: string[] = [];

function ledger(): QuotaLedger {
  const dbPath = join(tmpdir(), `zintus-vk-${Date.now()}-${Math.random()}.db`);
  dbPaths.push(dbPath);
  return new QuotaLedger(dbPath);
}

afterEach(() => {
  for (const path of dbPaths.splice(0)) {
    try {
      unlinkSync(path);
    } catch {
      // ignore
    }
  }
});

describe("virtual key rolling RPM/TPM", () => {
  test("requestsPerMinute rejects the 3rd request in a 60s window, recovers after it rolls", () => {
    const l = ledger();
    const t0 = 1_700_000_000_000;
    l.createVirtualKey("k", "test", null, null, { requestsPerMinute: 2 });

    // Two requests inside the window are allowed and recorded.
    expect(l.validateVirtualKey("k", t0)).toBe(true);
    l.recordVirtualKeyUsage("k", 1, 1, t0);
    expect(l.validateVirtualKey("k", t0 + 1_000)).toBe(true);
    l.recordVirtualKeyUsage("k", 1, 1, t0 + 1_000);

    // Third within 60s is rejected (2 already in window).
    expect(l.validateVirtualKey("k", t0 + 2_000)).toBe(false);

    // After the window rolls, it's allowed again.
    expect(l.validateVirtualKey("k", t0 + 61_000)).toBe(true);
  });

  test("tokensPerMinute rejects once the rolling token sum is reached", () => {
    const l = ledger();
    const t0 = 1_700_000_000_000;
    l.createVirtualKey("k", "test", null, null, { tokensPerMinute: 100 });

    expect(l.validateVirtualKey("k", t0)).toBe(true);
    l.recordVirtualKeyUsage("k", 60, 40, t0); // 100 tokens in window

    expect(l.validateVirtualKey("k", t0 + 1_000)).toBe(false);
    expect(l.validateVirtualKey("k", t0 + 61_000)).toBe(true);
  });

  test("daily-only keys are unaffected by minute windows", () => {
    const l = ledger();
    const t0 = 1_700_000_000_000;
    l.createVirtualKey("k", "test", 1000, null);
    for (let i = 0; i < 5; i++) {
      expect(l.validateVirtualKey("k", t0 + i * 100)).toBe(true);
      l.recordVirtualKeyUsage("k", 1, 1, t0 + i * 100);
    }
  });
});
