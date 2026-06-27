import { describe, expect, test } from "bun:test";
import { mayTrainOnUserData, trainsOnUserData } from "./data-policies.js";

describe("data-policies privacy predicates", () => {
  test("trainsOnUserData is strict — only documented trainers", () => {
    expect(trainsOnUserData("gemini")).toBe(true);
    expect(trainsOnUserData("cohere")).toBe(true);
    // An "unknown" policy is NOT a documented trainer (badge-only use).
    expect(trainsOnUserData("openrouter")).toBe(false);
    expect(trainsOnUserData("deepseek")).toBe(false);
    expect(trainsOnUserData("groq")).toBe(false);
  });

  test("mayTrainOnUserData is conservative — trainers AND 'unknown' policies", () => {
    // Documented trainers.
    expect(mayTrainOnUserData("gemini")).toBe(true);
    expect(mayTrainOnUserData("cohere")).toBe(true);
    // "unknown" policies MUST be treated as may-train — this is the private-mode
    // leak fix: an undocumented provider can no longer pass the privacy filter.
    for (const id of ["openrouter", "deepseek", "xai", "huggingface"] as const) {
      expect(mayTrainOnUserData(id)).toBe(true);
    }
    // Genuinely safe providers (no-training / local) remain private-eligible.
    for (const id of [
      "groq",
      "cerebras",
      "mistral",
      "fireworks",
      "ollama",
      "lmstudio",
    ] as const) {
      expect(mayTrainOnUserData(id)).toBe(false);
    }
  });
});
