import { describe, it, expect } from "bun:test";
import { alignCache } from "../src/transforms/cache-aligner";
import type { CompressContext } from "../src/pipeline/types";

const BASE_CTX: CompressContext = {
  provider: "anthropic",
  model: "claude-sonnet-4-6",
};

describe("CacheAligner (non-destructive)", () => {
  it("never reorders the prompt — combined is byte-identical to the input", () => {
    const prompt = `You are a helpful assistant. Today is 2024-01-15T10:00:00Z. Be concise.`;
    const result = alignCache(prompt, BASE_CTX);
    expect(result.combined).toBe(prompt);
    expect(result.staticPrefix).toBe(prompt);
  });

  it("does not extract a dynamic tail", () => {
    const prompt = `You are an assistant. Session: 550e8400-e29b-41d4-a716-446655440000. Always be helpful.`;
    const result = alignCache(prompt, BASE_CTX);
    expect(result.dynamicTail).toBe("");
    expect(result.combined).toBe(prompt);
  });

  it("keeps a date constraint adjacent to its instruction (no semantic split)", () => {
    const prompt = `Today is 2024-01-15.\nOnly schedule meetings after this date.`;
    const result = alignCache(prompt, BASE_CTX);
    // Reordering would have hoisted the date line away from the rule below it.
    expect(result.combined).toBe(prompt);
    expect(result.combined).not.toContain("---");
  });

  it("token count is unchanged (transform never grows/shrinks the prompt)", () => {
    const prompt = `You are an assistant. User: {{username}}. Context: {{context}}.`;
    const result = alignCache(prompt, BASE_CTX);
    expect(result.compressedTokens).toBe(result.originalTokens);
    expect(result.ratio).toBe(1);
  });

  it("emits an Anthropic cache_control breakpoint when over the min token threshold", () => {
    // Sonnet 4.x threshold is 2048; build a prompt large enough to clear it.
    const big = "You are a helpful assistant. ".repeat(600);
    const result = alignCache(big, BASE_CTX);
    expect(result.cacheBlocks).toBeDefined();
    const blocks = result.cacheBlocks ?? [];
    expect(blocks[blocks.length - 1]?.cache_control).toEqual({ type: "ephemeral" });
    expect(result.transforms).toContain("cache-hint");
  });

  it("emits no cache blocks below the min token threshold", () => {
    const small = "You are a helpful coding assistant. Be concise and accurate.";
    const result = alignCache(small, BASE_CTX);
    expect(result.cacheBlocks).toBeUndefined();
    expect(result.transforms).toHaveLength(0);
  });

  it("emits no cache blocks for providers without a prefix cache (groq)", () => {
    const big = "You are a helpful assistant. ".repeat(600);
    const result = alignCache(big, { provider: "groq", model: "llama-3.3-70b" });
    expect(result.cacheBlocks).toBeUndefined();
    expect(result.combined).toBe(big);
  });

  it("never throws on any input", () => {
    expect(() => alignCache("", BASE_CTX)).not.toThrow();
    expect(() => alignCache("a".repeat(10000), BASE_CTX)).not.toThrow();
  });

  it("static prefix is byte-identical across calls (stable cache key)", () => {
    const prompt = `Static part of system prompt. Today's date is 2024-01-15T00:00:00Z. User session: abc123.`;
    const result1 = alignCache(prompt, BASE_CTX);
    const result2 = alignCache(prompt, BASE_CTX);
    expect(result1.staticPrefix).toBe(result2.staticPrefix);
    expect(result1.staticPrefix).toBe(prompt);
  });
});
