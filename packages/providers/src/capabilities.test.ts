import { describe, expect, test } from "bun:test";
import type { ProviderId } from "@zintus/types";
import {
  MODEL_CAPABILITIES,
  modelCapabilities,
  providerCapabilityTier,
  supportsVision,
  supportsTools,
  structuredOutputLevel,
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

  test("supportsVision is model-aware — model-specific, never whole-provider", () => {
    // gemini default + its known vision models
    expect(supportsVision("gemini")).toBe(true);
    expect(supportsVision("gemini", "gemini-2.5-flash")).toBe(true);
    expect(supportsVision("gemini", "gemini-1.5-pro")).toBe(true);
    // a non-vision model name, even on a vision provider → false
    expect(supportsVision("gemini", "some-text-only-model")).toBe(false);
    // groq is never vision, with or without a model
    expect(supportsVision("groq")).toBe(false);
    expect(supportsVision("groq", "llama-3.3-70b-versatile")).toBe(false);
    // openrouter vision is model-specific: the verified Llama 3.2 Vision models
    // are mapped → true; everything else on openrouter (incl. the default) → false.
    expect(
      supportsVision("openrouter", "meta-llama/llama-3.2-90b-vision-instruct"),
    ).toBe(true);
    expect(
      supportsVision("openrouter", "meta-llama/llama-3.2-11b-vision-instruct"),
    ).toBe(true);
    expect(supportsVision("openrouter")).toBe(false); // default stays non-vision
    expect(
      supportsVision("openrouter", "meta-llama/llama-3.3-70b-instruct:free"),
    ).toBe(false);
    expect(supportsVision("openrouter", "some-unlisted-model")).toBe(false);
    // xai vision is model-specific and currently UNMAPPED → false
    expect(supportsVision("xai", "grok-2-vision")).toBe(false);
    // local providers are never globally vision (need runtime detection)
    expect(supportsVision("ollama")).toBe(false);
    expect(supportsVision("ollama", "llava")).toBe(false);
    expect(supportsVision("lmstudio")).toBe(false);
  });

  test("supportsTools defaults to the registry tools flag per provider", () => {
    for (const id of IDS) {
      expect(supportsTools(id)).toBe(MODEL_CAPABILITIES[id].tools);
    }
  });

  test("supportsTools is model-aware and fails closed on unknown specific models", () => {
    // default model + verified tool models
    expect(supportsTools("gemini", "gemini-2.5-flash")).toBe(true);
    expect(supportsTools("gemini", "gemini-1.5-pro")).toBe(true);
    expect(supportsTools("groq", "llama-3.3-70b-versatile")).toBe(true); // default
    expect(supportsTools("groq", "llama-3.1-8b-instant")).toBe(true); // listed
    // an unknown specific model on a tool-capable provider → fail closed
    expect(supportsTools("groq", "some-unknown-model")).toBe(false);
    expect(supportsTools("gemini", "gemini-text-only-future")).toBe(false);
    // a provider whose default lacks tools is false even for its default model
    expect(supportsTools("huggingface")).toBe(false);
    expect(
      supportsTools("huggingface", MODEL_CAPABILITIES.huggingface.model),
    ).toBe(false);
    // local providers never assert tools statically
    expect(supportsTools("ollama", "some-local-model")).toBe(false);
    expect(supportsTools("lmstudio", "local-model")).toBe(false);
  });

  test("json flag stays consistent with the 3-state structuredOutput level", () => {
    for (const id of IDS) {
      const caps = MODEL_CAPABILITIES[id];
      expect(caps.json).toBe(caps.structuredOutput !== "none");
    }
  });

  test("only gemini guarantees json_schema; others are conservative", () => {
    // gemini's responseSchema is the one verified GUARANTEED-conformant path.
    expect(structuredOutputLevel("gemini")).toBe("json_schema");
    expect(structuredOutputLevel("gemini", "gemini-1.5-pro")).toBe("json_schema");
    // a json-mode provider is json_object, never silently json_schema
    expect(structuredOutputLevel("groq")).toBe("json_object");
    // unknown specific model fails closed to none
    expect(structuredOutputLevel("groq", "some-unknown-model")).toBe("none");
    // a no-structured-output provider is none
    expect(structuredOutputLevel("huggingface")).toBe("none");
    // local providers: specific models fail closed
    expect(structuredOutputLevel("ollama", "random-local")).toBe("none");
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
