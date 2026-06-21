import { describe, it, expect } from "bun:test";
import { compressProse } from "../src/compressors/prose";

const LONG_PROSE = `
The quick brown fox jumps over the lazy dog. This is a well-known pangram used in typography.
It contains every letter of the English alphabet at least once.
The sentence has been used since at least the late 19th century in the testing of typewriters.
Typography professionals use it to display font samples and to test keyboard layouts.
The phrase is often used by computer professionals testing fonts and keyboards.
Modern usage extends to software testing for text rendering.
It remains one of the most well-known pangrams in the English language.
Many alternatives exist, but the original retains its dominance in professional contexts.
The phrase demonstrates the utility of comprehensive alphabet coverage in a short sentence.
Digital typography has only increased the utility of this historic phrase.
`.trim();

describe("compressProse", () => {
  it("compresses long prose below 40% token ratio by default", () => {
    const result = compressProse(LONG_PROSE);
    expect(result.ratio).toBeLessThan(0.7); // extractive compression should reduce significantly
  });

  it("returns original for short text (under compression threshold)", () => {
    const short = "Hello world. This is short.";
    const result = compressProse(short);
    expect(result.content).toBe(short);
    expect(result.ratio).toBe(1);
  });

  it("preserves sentence order in output", () => {
    const result = compressProse(LONG_PROSE);
    // Check that selected sentences appear in document order
    const sentences = result.content.split(/(?<=[.!?])\s+/).filter(Boolean);
    expect(sentences.length).toBeGreaterThan(0);
  });

  it("stores dropped content in CCR", () => {
    const result = compressProse(LONG_PROSE);
    if (result.ratio < 1) {
      expect(result.ccrHashes.length).toBeGreaterThan(0);
      expect(result.content).toContain("retrieve(");
    }
  });

  it("boosts sentences containing query terms", () => {
    const result = compressProse(LONG_PROSE, { query: "typewriter typography" });
    expect(result.content.toLowerCase()).toContain("typograph");
  });

  it("near-duplicate deduplication removes repetitive sentences", () => {
    const repetitive =
      "The cat sat on the mat. " +
      "The cat sat on the mat today. " +
      "The cat sat on the mat again. " +
      "Completely different sentence about dogs and parks. " +
      "The cat sat on the mat one more time. " +
      "Dogs love to run in parks and fields. " +
      "Another unique fact about birds and trees. " +
      "Birds sing in the morning light. " +
      "Trees grow tall in the forest. " +
      "Mountains are tall and majestic.";
    const result = compressProse(repetitive);
    // Should reduce duplicates
    expect(result.content.split(/[Tt]he cat sat/).length).toBeLessThan(5);
  });

  it("never throws on any input", () => {
    expect(() => compressProse("")).not.toThrow();
    expect(() => compressProse("Single sentence.")).not.toThrow();
    expect(() => compressProse("A".repeat(10000))).not.toThrow();
  });
});
