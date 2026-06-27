import { describe, expect, test } from "bun:test";
import type { ProviderId } from "@zintus/types";
import {
  MODEL_CAPABILITIES,
  modelCapabilities,
  providerCapabilityTier,
  supportsVision,
} from "./capabilities.js";
import { DATA_POLICIES } from "./data-policies.js";

// DATA_POLICIES is the canonical Record<ProviderId, …>, so its keys are the
// complete provider set — the registry must cover exactly the same ids.
const IDS = Object.keys(DATA_POLICIES) as ProviderId[];

describe("model capability registry", () => {
  test("covers every provider id, no extras", () => {
    expect(Object.keys(MODEL_CAPABILITIES).sort()).toEqual([...IDS].sort());
  });

  test("vision is true ONLY for gemini's default model (the audit invariant)", () => {
    for (const id of IDS) {
      expect(supportsVision(id)).toBe(id === "gemini");
    }
  });

  test("context windows are real positive token counts", () => {
    for (const id of IDS) {
      expect(MODEL_CAPABILITIES[id]!.contextWindow).toBeGreaterThan(0);
    }
    expect(MODEL_CAPABILITIES.gemini.contextWindow).toBe(1_000_000);
    expect(MODEL_CAPABILITIES.groq.contextWindow).toBe(128_000);
    expect(MODEL_CAPABILITIES.deepseek.contextWindow).toBe(64_000);
  });

  test("capabilityTier preserves the router's ordering (gemini best, ollama last)", () => {
    expect(providerCapabilityTier("gemini")).toBe(1);
    expect(providerCapabilityTier("groq")).toBe(10);
    expect(providerCapabilityTier("ollama")).toBe(99);
    // gemini < cerebras < groq — the exact invariant priority.test.ts asserts.
    expect(providerCapabilityTier("gemini")).toBeLessThan(
      providerCapabilityTier("cerebras"),
    );
    expect(providerCapabilityTier("cerebras")).toBeLessThan(
      providerCapabilityTier("groq"),
    );
  });

  test("tools/json are booleans (best-effort model-API capability flags)", () => {
    for (const id of IDS) {
      expect(typeof MODEL_CAPABILITIES[id]!.tools).toBe("boolean");
      expect(typeof MODEL_CAPABILITIES[id]!.json).toBe("boolean");
    }
  });

  test("modelCapabilities returns the provider's default model id", () => {
    expect(modelCapabilities("gemini")?.model).toBe("gemini-2.5-flash");
    expect(modelCapabilities("groq")?.model).toBe("llama-3.3-70b-versatile");
  });
});
