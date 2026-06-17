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
