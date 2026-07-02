import { describe, expect, test } from "bun:test";
import type { ProviderId } from "@zintus/types";
import {
  PRICING_CATALOG,
  getModelPricing,
  listPricing,
  estimateCostUsd,
} from "./pricing.js";

const LOCAL: ProviderId[] = ["lmstudio", "ollama"];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

describe("PRICING_CATALOG is well-formed", () => {
  test("every entry has the required, sane fields", () => {
    expect(PRICING_CATALOG.length).toBeGreaterThan(0);
    for (const e of PRICING_CATALOG) {
      expect(typeof e.provider).toBe("string");
      expect(e.model.length).toBeGreaterThan(0);
      expect(ISO_DATE.test(e.updatedAt)).toBe(true);
      // Prices are non-negative; local runtimes are exactly 0.
      expect(e.inputPer1M).toBeGreaterThanOrEqual(0);
      expect(e.outputPer1M).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(e.inputPer1M)).toBe(true);
      expect(Number.isFinite(e.outputPer1M)).toBe(true);
    }
  });

  test("non-local, non-free models have positive prices", () => {
    for (const e of PRICING_CATALOG) {
      // ":free" = OpenRouter's free-route convention; "-Free" = Together's
      // (e.g. Llama-3.3-70B-Instruct-Turbo-Free). Both are genuine $0 routes.
      const isFreeRoute = e.model.endsWith(":free") || /-free$/i.test(e.model);
      if (LOCAL.includes(e.provider) || isFreeRoute) {
        expect(e.inputPer1M).toBe(0);
        expect(e.outputPer1M).toBe(0);
      } else {
        expect(e.inputPer1M).toBeGreaterThan(0);
        expect(e.outputPer1M).toBeGreaterThan(0);
      }
    }
  });

  test("no duplicate (provider, model) pairs", () => {
    const keys = PRICING_CATALOG.map((e) => `${e.provider}:${e.model}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("getModelPricing round-trips", () => {
  test("returns the exact entry for every catalog pair", () => {
    for (const e of PRICING_CATALOG) {
      const got = getModelPricing(e.provider, e.model);
      expect(got).toEqual(e);
    }
  });

  test("returns undefined for an unknown model", () => {
    expect(getModelPricing("groq", "no-such-model")).toBeUndefined();
  });

  test("returns undefined when model belongs to a different provider", () => {
    // command-r-plus is a Cohere model, not a Groq one.
    expect(getModelPricing("groq", "command-r-plus-08-2024")).toBeUndefined();
  });
});

describe("listPricing", () => {
  test("returns all entries as a mutable copy", () => {
    const list = listPricing();
    expect(list.length).toBe(PRICING_CATALOG.length);
    list.pop();
    // Mutating the copy must not affect the source.
    expect(PRICING_CATALOG.length).toBe(list.length + 1);
  });
});

describe("estimateCostUsd math", () => {
  test("computes input*in + output*out per 1M", () => {
    // Groq 70B: $0.59 in / $0.79 out. 1M in + 1M out = 0.59 + 0.79 = 1.38.
    const cost = estimateCostUsd(
      "groq",
      "llama-3.3-70b-versatile",
      1_000_000,
      1_000_000,
    );
    expect(cost).toBeCloseTo(1.38, 10);
  });

  test("scales linearly with token count", () => {
    const half = estimateCostUsd("groq", "llama-3.1-8b-instant", 500_000, 0);
    // 0.5M * $0.05/1M = 0.025.
    expect(half).toBeCloseTo(0.025, 10);
  });

  test("unknown pair costs 0", () => {
    expect(estimateCostUsd("groq", "nope", 1_000_000, 1_000_000)).toBe(0);
  });

  test("local runtimes cost 0 even for huge requests", () => {
    expect(estimateCostUsd("ollama", "llama3.3", 5_000_000, 5_000_000)).toBe(0);
  });

  test("negative token counts clamp to 0", () => {
    expect(
      estimateCostUsd("groq", "llama-3.3-70b-versatile", -1000, -1000),
    ).toBe(0);
  });
});
