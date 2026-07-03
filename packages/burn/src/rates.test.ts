import { describe, expect, test } from "bun:test";
import {
  diffSnapshots,
  findRates,
  RATE_ALERT_THRESHOLD,
  validateSnapshot,
  type ModelRates,
  type PriceSnapshot,
} from "./rates.js";
import { BUNDLED_SNAPSHOT } from "./snapshot.js";

function snapshotWith(rates: ModelRates[], version = 2): PriceSnapshot {
  return { version, generatedAt: new Date().toISOString(), rates };
}

const baseRate: ModelRates = {
  provider: "groq",
  model: "llama-3.3-70b-versatile",
  class: "cheap",
  inPer1M: 0.59,
  outPer1M: 0.79,
  updatedAt: "2026-07-03",
  source: "test",
};

describe("validateSnapshot", () => {
  test("the bundled snapshot is valid", () => {
    expect(validateSnapshot(BUNDLED_SNAPSHOT)).toEqual([]);
  });

  test("rejects negative rates, bad versions, duplicates, and unparseable dates", () => {
    const problems = validateSnapshot({
      version: 0,
      generatedAt: "not-a-date",
      rates: [
        { ...baseRate, inPer1M: -1 },
        { ...baseRate, updatedAt: "garbage" },
      ],
    });
    expect(problems.some((p) => p.includes("version"))).toBe(true);
    expect(problems.some((p) => p.includes("generatedAt"))).toBe(true);
    expect(problems.some((p) => p.includes("inPer1M"))).toBe(true);
    expect(problems.some((p) => p.includes("duplicate"))).toBe(true);
    expect(problems.some((p) => p.includes("updatedAt"))).toBe(true);
  });

  test("rejects an empty rate table", () => {
    expect(validateSnapshot(snapshotWith([]))).toContain("rates is empty");
  });
});

describe("findRates", () => {
  test("finds a listed route and returns null for unlisted ones", () => {
    expect(
      findRates(BUNDLED_SNAPSHOT, "deepseek", "deepseek-chat")?.inPer1M,
    ).toBe(0.14);
    expect(findRates(BUNDLED_SNAPSHOT, "deepseek", "nonexistent")).toBeNull();
  });
});

describe("diffSnapshots — the >10% alert", () => {
  test("a 50% output-price hike is a move AND an alert", () => {
    const prev = snapshotWith([baseRate], 1);
    const next = snapshotWith([{ ...baseRate, outPer1M: 0.79 * 1.5 }], 2);
    const diff = diffSnapshots(prev, next);
    expect(diff.moves).toHaveLength(1);
    expect(diff.alerts).toHaveLength(1);
    expect(diff.alerts[0]?.pctChange).toBeCloseTo(0.5, 6);
  });

  test("a 5% move is recorded but does NOT alert at the default threshold", () => {
    const prev = snapshotWith([baseRate], 1);
    const next = snapshotWith([{ ...baseRate, inPer1M: 0.59 * 1.05 }], 2);
    const diff = diffSnapshots(prev, next);
    expect(diff.moves).toHaveLength(1);
    expect(diff.alerts).toHaveLength(0);
    expect(RATE_ALERT_THRESHOLD).toBe(0.1);
  });

  test("added and removed routes are reported", () => {
    const other: ModelRates = { ...baseRate, model: "new-model" };
    const diff = diffSnapshots(
      snapshotWith([baseRate], 1),
      snapshotWith([other], 2),
    );
    expect(diff.added).toEqual([{ provider: "groq", model: "new-model" }]);
    expect(diff.removed).toEqual([
      { provider: "groq", model: "llama-3.3-70b-versatile" },
    ]);
  });

  test("a cache rate appearing is compared against the implicit input-rate fallback", () => {
    const prev = snapshotWith([baseRate], 1);
    // Cache read appears at ~10% of input — a real billed-price drop for cached
    // tokens, so it must surface as a (large, negative) move.
    const next = snapshotWith([{ ...baseRate, cacheReadPer1M: 0.059 }], 2);
    const diff = diffSnapshots(prev, next);
    expect(diff.moves).toHaveLength(1);
    expect(diff.moves[0]?.field).toBe("cacheReadPer1M");
    expect(diff.moves[0]?.pctChange).toBeCloseTo(-0.9, 6);
    expect(diff.alerts).toHaveLength(1);
  });

  test("a price rising from 0 reports Infinity pctChange and alerts", () => {
    const free: ModelRates = { ...baseRate, inPer1M: 0 };
    const diff = diffSnapshots(
      snapshotWith([free], 1),
      snapshotWith([{ ...free, inPer1M: 0.1 }], 2),
    );
    expect(diff.alerts[0]?.pctChange).toBe(Number.POSITIVE_INFINITY);
  });

  test("identical snapshots produce no moves, alerts, adds, or removes", () => {
    const diff = diffSnapshots(BUNDLED_SNAPSHOT, {
      ...BUNDLED_SNAPSHOT,
      version: 2,
    });
    expect(diff.moves).toEqual([]);
    expect(diff.alerts).toEqual([]);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
  });
});
