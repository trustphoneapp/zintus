import { describe, expect, it } from "bun:test";
import { QuotaController } from "../src/quota/controller";

// Tests the ACTUAL thresholds in controller.ts:88-93 (strict `>`), not the
// spec's assumed boundaries. getLevel is a pure function:
//   q > 0.5  -> 1   (no compression)
//   q > 0.3  -> 2
//   q > 0.15 -> 3
//   else     -> 4   (most aggressive)
// There is NO clamping of out-of-range / NaN inputs.
describe("QuotaController.getLevel — real thresholds", () => {
  const cases: Array<[number, 1 | 2 | 3 | 4]> = [
    [1.0, 1],
    [0.51, 1],
    [0.5, 2], // 0.5 > 0.5 is false -> not L1; 0.5 > 0.3 -> L2
    [0.31, 2],
    [0.3, 3], // boundary: 0.3 > 0.3 false -> L3
    [0.2, 3], // spec WRONGLY said L2
    [0.16, 3],
    [0.15, 4], // boundary: 0.15 > 0.15 false -> L4
    [0.05, 4], // spec WRONGLY said L3
    [0.04, 4],
    [0.0, 4],
  ];
  for (const [q, level] of cases) {
    it(`quotaRemaining=${q} -> Level ${level}`, () => {
      expect(QuotaController.getLevel(q)).toBe(level);
    });
  }

  it("does NOT clamp: negative -> 4, >1 -> 1 (all comparisons just fall through)", () => {
    expect(QuotaController.getLevel(-0.1)).toBe(4);
    expect(QuotaController.getLevel(-100)).toBe(4);
    expect(QuotaController.getLevel(1.5)).toBe(1);
    expect(QuotaController.getLevel(Number.POSITIVE_INFINITY)).toBe(1);
  });

  it("NaN silently degrades to the most aggressive level (every `>` is false)", () => {
    // This is a real, untested behavior worth pinning: a bad quota signal does
    // not throw — it compresses maximally.
    expect(QuotaController.getLevel(Number.NaN)).toBe(4);
  });
});

describe("QuotaController.getQuotaRemaining — signal aggregation", () => {
  it("returns 1.0 (assume full) when no signals are present", () => {
    const qc = new QuotaController();
    expect(qc.getQuotaRemaining({})).toBe(1.0);
  });

  it("takes the MINIMUM across provided signals (worst-case wins)", () => {
    const qc = new QuotaController();
    expect(
      qc.getQuotaRemaining({ remainingRequests: 0.8, remainingTokens: 0.2 }),
    ).toBe(0.2);
    expect(
      qc.getQuotaRemaining({ budgetRemaining: 0.05, routerRemaining: 0.9 }),
    ).toBe(0.05);
  });

  it("a single router signal flows straight through to a level", () => {
    const qc = new QuotaController();
    const q = qc.getQuotaRemaining({ routerRemaining: 0.1 });
    expect(q).toBe(0.1);
    expect(QuotaController.getLevel(q)).toBe(4);
  });
});
