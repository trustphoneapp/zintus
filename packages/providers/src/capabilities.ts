import type { ProviderId } from "@zintus/types";

/**
 * Data-driven model-capability registry — the single source of truth for what
 * each provider's DEFAULT model can do. Replaces the hardcoded `CAPABILITY_RANK`
 * that used to live in the router and gives the (future) multimodal / tool /
 * structured-output routing a real place to filter candidates instead of
 * guessing from a brand ranking.
 *
 * IMPORTANT — this describes the provider/model **API** capability, NOT what the
 * Zintus runtime currently sends. As of 2026-06 the engine does not yet emit
 * image parts, `tools`, or `response_format`; the `vision` / `tools` / `json`
 * flags mark what each default model COULD do so those features can route
 * correctly once wired. Values are **best-effort** against provider docs
 * (reviewed 2026-06) — re-verify before relying on them, exactly like
 * `data-policies.ts`. `contextWindow` is the model's real max window (NOT the
 * engine's deliberately-conservative compile budget in `engine.ts`).
 *
 * `capabilityTier`: deliberate provider-quality ordering for the `capability` /
 * `quality` / `balanced` routing strategies (lower = preferred). Centralized
 * here from the old router rank; the numbers are unchanged so routing order is
 * preserved — revisit them here (one place) rather than in the router.
 */
export interface ModelCapabilities {
  /** Default model id the provider serves (matches the runtime `defaultModel`). */
  model: string;
  /** Real maximum context window in tokens for `model`. */
  contextWindow: number;
  /** `model` natively accepts image input (multimodal vision). */
  vision: boolean;
  /** `model` + its API support tool/function calling. */
  tools: boolean;
  /** `model` + its API support structured/JSON output (response_format/json mode). */
  json: boolean;
  /** Routing rank for capability/quality/balanced (lower = preferred). */
  capabilityTier: number;
}

export const MODEL_CAPABILITIES: Record<ProviderId, ModelCapabilities> = {
  gemini:      { model: "gemini-2.5-flash",                                   contextWindow: 1_000_000, vision: true,  tools: true,  json: true,  capabilityTier: 1 },
  openrouter:  { model: "meta-llama/llama-3.3-70b-instruct:free",            contextWindow: 128_000,   vision: false, tools: true,  json: true,  capabilityTier: 2 },
  fireworks:   { model: "accounts/fireworks/models/llama-v3p1-8b-instruct",  contextWindow: 128_000,   vision: false, tools: true,  json: true,  capabilityTier: 3 },
  xai:         { model: "grok-2-latest",                                      contextWindow: 131_072,   vision: false, tools: true,  json: true,  capabilityTier: 4 },
  deepseek:    { model: "deepseek-chat",                                      contextWindow: 64_000,    vision: false, tools: true,  json: true,  capabilityTier: 5 },
  mistral:     { model: "mistral-large-latest",                              contextWindow: 128_000,   vision: false, tools: true,  json: true,  capabilityTier: 6 },
  huggingface: { model: "meta-llama/Llama-3.3-70B-Instruct",                 contextWindow: 128_000,   vision: false, tools: false, json: false, capabilityTier: 7 },
  cohere:      { model: "command-r-plus-08-2024",                           contextWindow: 128_000,   vision: false, tools: true,  json: false, capabilityTier: 8 },
  cerebras:    { model: "llama-3.3-70b",                                     contextWindow: 128_000,   vision: false, tools: true,  json: true,  capabilityTier: 9 },
  groq:        { model: "llama-3.3-70b-versatile",                           contextWindow: 128_000,   vision: false, tools: true,  json: true,  capabilityTier: 10 },
  lmstudio:    { model: "local-model",                                       contextWindow: 32_000,    vision: false, tools: false, json: false, capabilityTier: 98 },
  ollama:      { model: "llama3.3",                                          contextWindow: 128_000,   vision: false, tools: true,  json: true,  capabilityTier: 99 },
};

/** Default-model capabilities for a provider (undefined for an unknown id). */
export function modelCapabilities(
  providerId: ProviderId,
): ModelCapabilities | undefined {
  return MODEL_CAPABILITIES[providerId];
}

/**
 * Capability-strategy ordering rank (lower = preferred). Falls back to 50 for an
 * unknown provider — the same default the router used previously.
 */
export function providerCapabilityTier(providerId: ProviderId): number {
  return MODEL_CAPABILITIES[providerId]?.capabilityTier ?? 50;
}

// Per-provider sets of model ids known to accept image input. Deliberately
// narrow and MODEL-SPECIFIC: a provider is never globally vision-capable just
// because one of its models is. Add an entry only when verified against the
// provider's API. OpenRouter/xAI vision is model-specific and stays UNMAPPED
// until a route is explicitly verified + tested. Local providers (ollama/
// lmstudio) require a runtime-DETECTED local vision model — never asserted here.
const VISION_MODELS: Partial<Record<ProviderId, ReadonlySet<string>>> = {
  gemini: new Set([
    "gemini-2.5-flash",
    "gemini-2.5-pro",
    "gemini-2.0-flash",
    "gemini-1.5-pro",
    "gemini-1.5-flash",
  ]),
};

/**
 * Model-aware vision check.
 * - With a `model`: true ONLY if that specific model is known to accept image
 *   input (never a whole-provider assumption).
 * - Without a `model` (the provider's default): the default model's `vision`
 *   flag from the registry.
 * Local providers (ollama/lmstudio) return false here — they require a
 * runtime-detected local vision model, decided at the gateway, not statically.
 */
export function supportsVision(providerId: ProviderId, model?: string): boolean {
  if (model) {
    return VISION_MODELS[providerId]?.has(model) ?? false;
  }
  return MODEL_CAPABILITIES[providerId]?.vision ?? false;
}
