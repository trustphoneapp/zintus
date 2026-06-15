import { describe, expect, it } from "vitest";
import { parseGroqResetHeader } from "./groq-reset.js";

describe("parseGroqResetHeader", () => {
  const now = 1_700_000_000_000;

  it("parses seconds suffix", () => {
    expect(parseGroqResetHeader("2.5s", now)).toBe(now + 2_500);
  });

  it("parses minutes suffix", () => {
    expect(parseGroqResetHeader("1m", now)).toBe(now + 60_000);
  });

  it("parses bare numeric seconds", () => {
    expect(parseGroqResetHeader("3", now)).toBe(now + 3_000);
  });

  it("falls back to 60s for unknown format", () => {
    expect(parseGroqResetHeader("invalid", now)).toBe(now + 60_000);
  });
});
