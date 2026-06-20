import { describe, expect, it } from "bun:test";
import {
  PAID_EQUIVALENT_USD_PER_MTOK,
  paidEquivalentUsdPerMTok,
} from "./limits.js";

describe("paidEquivalentUsdPerMTok", () => {
  it("uses the per-model anchor when one exists", () => {
    // Groq's 8B tier is much cheaper than its 70B provider anchor.
    expect(paidEquivalentUsdPerMTok("groq", "llama-3.1-8b-instant")).toBe(0.08);
    expect(paidEquivalentUsdPerMTok("groq", "llama-3.3-70b-versatile")).toBe(0.6);
  });

  it("values smaller OpenRouter :free models below the provider anchor", () => {
    expect(paidEquivalentUsdPerMTok("openrouter", "google/gemma-2-9b-it:free")).toBe(
      0.2,
    );
    expect(paidEquivalentUsdPerMTok("openrouter")).toBe(
      PAID_EQUIVALENT_USD_PER_MTOK.openrouter,
    );
  });

  it("falls back to the provider anchor for unknown/absent models", () => {
    expect(paidEquivalentUsdPerMTok("gemini", "some-unmapped-model")).toBe(
      PAID_EQUIVALENT_USD_PER_MTOK.gemini,
    );
    expect(paidEquivalentUsdPerMTok("gemini")).toBe(
      PAID_EQUIVALENT_USD_PER_MTOK.gemini,
    );
  });

  it("treats local providers as free", () => {
    expect(paidEquivalentUsdPerMTok("ollama")).toBe(0);
    expect(paidEquivalentUsdPerMTok("lmstudio")).toBe(0);
  });
});
