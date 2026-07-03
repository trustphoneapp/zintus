import { describe, expect, test } from "bun:test";
import {
  burn,
  formatUsd,
  MICROCENTS_PER_CREDIT,
  microcentsToCredits,
} from "./burn.js";
import type { ModelRates } from "./rates.js";

const cheapRates: ModelRates = {
  provider: "deepseek",
  model: "deepseek-chat",
  class: "cheap",
  inPer1M: 0.14,
  outPer1M: 0.28,
  cacheReadPer1M: 0.0028,
  updatedAt: "2026-07-03",
  source: "test",
};

const midRates: ModelRates = {
  provider: "mistral",
  model: "mistral-large-latest",
  class: "mid",
  inPer1M: 2.0,
  outPer1M: 6.0,
  updatedAt: "2026-07-03",
  source: "test",
};

describe("burn — microcent math", () => {
  test("USD-per-1M rate is microcents-per-token: 1M in + 1M out at $2/$6 = $8", () => {
    const receipt = burn(
      { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      midRates,
      { multiplier: 1 },
    );
    // $2 + $6 = $8 = 8,000,000 µ¢
    expect(receipt.rawMicrocents).toBe(8_000_000);
    expect(receipt.billedMicrocents).toBe(8_000_000);
    expect(receipt.markupMicrocents).toBe(0);
  });

  test("legs are integers and sum exactly to rawMicrocents", () => {
    const receipt = burn(
      { inputTokens: 12_345, outputTokens: 6_789 },
      cheapRates,
    );
    for (const l of receipt.legs) {
      expect(Number.isInteger(l.microcents)).toBe(true);
    }
    expect(receipt.legs.reduce((s, l) => s + l.microcents, 0)).toBe(
      receipt.rawMicrocents,
    );
  });

  test("default multiplier comes from the model class (cheap = 1.5x) and is on the receipt", () => {
    const receipt = burn(
      { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      cheapRates,
    );
    // raw: 140,000 + 280,000 = 420,000 µ¢ ($0.42); billed 1.5x = 630,000 µ¢
    expect(receipt.rawMicrocents).toBe(420_000);
    expect(receipt.multiplier).toBe(1.5);
    expect(receipt.billedMicrocents).toBe(630_000);
    expect(receipt.markupMicrocents).toBe(210_000);
  });

  test("zero-rate (free/local) models burn zero regardless of volume", () => {
    const receipt = burn(
      { inputTokens: 5_000_000, outputTokens: 5_000_000 },
      {
        provider: "ollama",
        model: "llama3.3",
        class: "free",
        inPer1M: 0,
        outPer1M: 0,
        updatedAt: "2026-07-03",
        source: "test",
      },
    );
    expect(receipt.rawMicrocents).toBe(0);
    expect(receipt.billedMicrocents).toBe(0);
  });

  test("rejects multipliers below 1 or non-finite", () => {
    expect(() =>
      burn({ inputTokens: 1, outputTokens: 1 }, cheapRates, { multiplier: 0.5 }),
    ).toThrow(RangeError);
    expect(() =>
      burn({ inputTokens: 1, outputTokens: 1 }, cheapRates, {
        multiplier: Number.NaN,
      }),
    ).toThrow(RangeError);
  });

  test("negative and non-finite token counts clamp to 0", () => {
    const receipt = burn(
      { inputTokens: -50, outputTokens: Number.NaN },
      cheapRates,
    );
    expect(receipt.rawMicrocents).toBe(0);
  });

  test("snapshotVersion is recorded on the receipt when provided", () => {
    const receipt = burn({ inputTokens: 10, outputTokens: 5 }, cheapRates, {
      snapshotVersion: 7,
    });
    expect(receipt.snapshotVersion).toBe(7);
  });
});

describe("burn — cache legs", () => {
  test("cache reads are carved out of input and priced at the cache rate", () => {
    const receipt = burn(
      { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 600_000 },
      cheapRates,
      { multiplier: 1 },
    );
    const input = receipt.legs.find((l) => l.kind === "input");
    const cacheRead = receipt.legs.find((l) => l.kind === "cache_read");
    expect(input?.tokens).toBe(400_000);
    expect(input?.microcents).toBe(Math.round(400_000 * 0.14));
    expect(cacheRead?.tokens).toBe(600_000);
    expect(cacheRead?.microcents).toBe(Math.round(600_000 * 0.0028));
  });

  test("cache reads exceeding inputTokens are clamped to the input size", () => {
    const receipt = burn(
      { inputTokens: 100, outputTokens: 0, cacheReadTokens: 500 },
      cheapRates,
      { multiplier: 1 },
    );
    const input = receipt.legs.find((l) => l.kind === "input");
    const cacheRead = receipt.legs.find((l) => l.kind === "cache_read");
    expect(input?.tokens).toBe(0);
    expect(cacheRead?.tokens).toBe(100);
  });

  test("missing cache-read rate falls back to the FULL input rate (never undercharges)", () => {
    const receipt = burn(
      { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 1_000_000 },
      midRates, // no cacheReadPer1M listed
      { multiplier: 1 },
    );
    expect(receipt.rawMicrocents).toBe(2_000_000); // full $2 input rate
  });

  test("cache writes bill in ADDITION to input tokens", () => {
    const receipt = burn(
      { inputTokens: 1_000_000, outputTokens: 0, cacheWriteTokens: 500_000 },
      midRates,
      { multiplier: 1 },
    );
    // 1M input at $2 + 0.5M cache-write at $2 fallback = $3
    expect(receipt.rawMicrocents).toBe(3_000_000);
  });
});

describe("burn — reasoning tokens", () => {
  test("OpenAI convention (included in output) adds NO extra leg", () => {
    const receipt = burn(
      {
        inputTokens: 0,
        outputTokens: 1_000_000,
        reasoningTokens: 400_000,
        reasoningIncludedInOutput: true,
      },
      midRates,
      { multiplier: 1 },
    );
    expect(receipt.legs.some((l) => l.kind === "reasoning")).toBe(false);
    expect(receipt.rawMicrocents).toBe(6_000_000);
  });

  test("default (flag omitted) treats reasoning as included — no double billing", () => {
    const receipt = burn(
      { inputTokens: 0, outputTokens: 1_000_000, reasoningTokens: 400_000 },
      midRates,
      { multiplier: 1 },
    );
    expect(receipt.rawMicrocents).toBe(6_000_000);
  });

  test("Gemini convention (separate) bills reasoning at the output rate", () => {
    const receipt = burn(
      {
        inputTokens: 0,
        outputTokens: 1_000_000,
        reasoningTokens: 500_000,
        reasoningIncludedInOutput: false,
      },
      midRates,
      { multiplier: 1 },
    );
    const reasoning = receipt.legs.find((l) => l.kind === "reasoning");
    expect(reasoning?.microcents).toBe(3_000_000); // 0.5M × $6
    expect(receipt.rawMicrocents).toBe(9_000_000);
  });
});

describe("credits and formatting", () => {
  test("1 credit = 1 cent = 10,000 microcents", () => {
    expect(MICROCENTS_PER_CREDIT).toBe(10_000);
    expect(microcentsToCredits(10_000)).toBe(1);
  });

  test("ledger mode rounds partial credits UP; exact mode keeps the fraction", () => {
    expect(microcentsToCredits(10_001)).toBe(2);
    expect(microcentsToCredits(10_001, "exact")).toBeCloseTo(1.0001);
    expect(microcentsToCredits(0)).toBe(0);
  });

  test("formatUsd renders sub-cent burns without noise", () => {
    expect(formatUsd(1_000_000)).toBe("$1.00");
    expect(formatUsd(630_000)).toBe("$0.63");
    expect(formatUsd(59)).toBe("$0.000059");
  });
});
