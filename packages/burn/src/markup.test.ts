import { describe, expect, test } from "bun:test";
import {
  isModelAllowed,
  multiplierFor,
  PUBLIC_MARKUP,
  publicRateRow,
  TIER_MODEL_ACCESS,
} from "./markup.js";
import { MODEL_CLASSES } from "./rates.js";
import { BUNDLED_SNAPSHOT } from "./snapshot.js";

describe("PUBLIC_MARKUP — the markup is public, displayable data", () => {
  test("every model class has a multiplier >= 1", () => {
    for (const cls of MODEL_CLASSES) {
      expect(PUBLIC_MARKUP[cls]).toBeGreaterThanOrEqual(1);
      expect(multiplierFor(cls)).toBe(PUBLIC_MARKUP[cls]);
    }
  });

  test("free class carries no markup — you cannot mark up zero honestly", () => {
    expect(PUBLIC_MARKUP.free).toBe(1);
  });

  test("multipliers decrease as raw model cost increases (public rationale)", () => {
    expect(PUBLIC_MARKUP.cheap).toBeGreaterThanOrEqual(PUBLIC_MARKUP.mid);
    expect(PUBLIC_MARKUP.mid).toBeGreaterThanOrEqual(PUBLIC_MARKUP.frontier);
    expect(PUBLIC_MARKUP.frontier).toBeGreaterThanOrEqual(PUBLIC_MARKUP.ultra);
  });
});

describe("tier gating", () => {
  test("frontier and ultra are gated OFF the starter ($15) tier", () => {
    expect(isModelAllowed("starter", "frontier")).toBe(false);
    expect(isModelAllowed("starter", "ultra")).toBe(false);
    expect(isModelAllowed("starter", "cheap")).toBe(true);
    expect(isModelAllowed("starter", "mid")).toBe(true);
  });

  test("access is strictly monotonic: each tier includes everything below it", () => {
    const order = ["free", "starter", "growth", "scale"] as const;
    for (let i = 1; i < order.length; i++) {
      const lower = new Set(TIER_MODEL_ACCESS[order[i - 1] as (typeof order)[number]]);
      const higher = new Set(TIER_MODEL_ACCESS[order[i] as (typeof order)[number]]);
      for (const cls of lower) {
        expect(higher.has(cls)).toBe(true);
      }
      expect(higher.size).toBeGreaterThanOrEqual(lower.size);
    }
  });

  test("only scale unlocks ultra", () => {
    expect(isModelAllowed("scale", "ultra")).toBe(true);
    expect(isModelAllowed("growth", "ultra")).toBe(false);
  });
});

describe("publicRateRow — the Everlane table", () => {
  test("row exposes raw rate, zintus rate, and the margin as separate fields", () => {
    const row = publicRateRow("cheap", 0.14, 0.28);
    expect(row.multiplier).toBe(1.5);
    expect(row.zintusInPer1M).toBeCloseTo(0.21, 6);
    expect(row.zintusOutPer1M).toBeCloseTo(0.42, 6);
    expect(row.marginInPer1M).toBeCloseTo(0.07, 6);
    expect(row.marginOutPer1M).toBeCloseTo(0.14, 6);
  });

  test("margin is exactly zintus − raw (the receipt adds up)", () => {
    for (const rate of BUNDLED_SNAPSHOT.rates) {
      const row = publicRateRow(rate.class, rate.inPer1M, rate.outPer1M);
      expect(row.zintusInPer1M - row.rawInPer1M).toBeCloseTo(row.marginInPer1M, 6);
      expect(row.zintusOutPer1M - row.rawOutPer1M).toBeCloseTo(row.marginOutPer1M, 6);
    }
  });
});
