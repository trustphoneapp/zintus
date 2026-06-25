import { describe, expect, test } from "bun:test";
import {
  estimateInputTokens,
  estimateTokensFromText,
  estimateUsage,
  usageFromProviderFields,
} from "./token-estimate.js";

describe("token estimation", () => {
  test("estimates ~1 token per 4 characters", () => {
    expect(estimateTokensFromText("")).toBe(0);
    expect(estimateTokensFromText("abcd")).toBe(1);
    expect(estimateTokensFromText("abcdefgh")).toBe(2);
  });

  test("counts both input messages and output text", () => {
    const messages = [
      { role: "system" as const, content: "you are helpful" },
      { role: "user" as const, content: "hello there" },
    ];
    const usage = estimateUsage(messages, "general kenobi");
    expect(usage.source).toBe("estimate");
    expect(usage.inputTokens).toBe(estimateInputTokens(messages));
    expect(usage.inputTokens).toBeGreaterThan(0);
    expect(usage.outputTokens).toBe(estimateTokensFromText("general kenobi"));
    expect(usage.totalTokens).toBe(usage.inputTokens + usage.outputTokens);
  });
});

describe("usageFromProviderFields", () => {
  test("normalizes OpenAI-style fields and marks them as provider-sourced", () => {
    const usage = usageFromProviderFields({
      inputTokens: 100,
      outputTokens: 25,
      totalTokens: 125,
    });
    expect(usage).toEqual({
      inputTokens: 100,
      outputTokens: 25,
      totalTokens: 125,
      source: "provider",
    });
  });

  test("derives a missing field from the total", () => {
    const usage = usageFromProviderFields({ outputTokens: 10, totalTokens: 30 });
    expect(usage?.inputTokens).toBe(20);
    expect(usage?.outputTokens).toBe(10);
  });

  test("returns null when no usable numbers are present", () => {
    expect(usageFromProviderFields({})).toBeNull();
    expect(
      usageFromProviderFields({ inputTokens: null, outputTokens: undefined }),
    ).toBeNull();
  });
});

describe("token estimation — content density & large input", () => {
  test("estimate is length-based, NOT content-aware: equal-length code and prose are equal", () => {
    // estimateTokensFromText is a length heuristic (ceil(len/CHARS_PER_TOKEN)),
    // not a real tokenizer — so code and prose of the SAME length estimate the
    // same. This pins that reality (the estimate is a tagged approximation).
    const len = 400;
    const prose = "sort the items in the array from low to high. ".repeat(20).slice(0, len);
    const code = "function s(a){return a.sort((x,y)=>x-y);} // c ".repeat(20).slice(0, len);
    expect(prose.length).toBe(len);
    expect(code.length).toBe(len);
    expect(estimateTokensFromText(code)).toBe(estimateTokensFromText(prose));
    expect(estimateTokensFromText(code)).toBeGreaterThan(0);
  });

  test("longer text estimates strictly more tokens", () => {
    const short = estimateTokensFromText("hi");
    const long = estimateTokensFromText("hi ".repeat(100));
    expect(long).toBeGreaterThan(short);
  });

  test("10KB input does not throw and stays consistent with the ~4-chars/token rule", () => {
    const huge = "word ".repeat(2000); // 10_000 chars
    let result = -1;
    expect(() => {
      result = estimateTokensFromText(huge);
    }).not.toThrow();
    expect(result).toBe(Math.ceil(huge.length / 4));
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThanOrEqual(huge.length);
  });
});
