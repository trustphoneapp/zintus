import type { ProviderId } from "@zintus/types";
import {
  extendedCapabilities,
  extendedVisionModels,
} from "./manifest.js";

/**
 * Data-driven model-capability registry — the single source of truth for what
 * each provider's DEFAULT model can do. Replaces the hardcoded `CAPABILITY_RANK`
 * that used to live in the router and gives the (future) multimodal / tool /
 * structured-output routing a real place to filter candidates instead of
 * guessing from a brand ranking.
 *
 * IMPORTANT — this describes the provider/model **API** capability. As of
 * 2026-06-28 the engine DOES emit these features on the wire: vision via Gemini
 * `inlineData` and OpenAI-compat `image_url` data-URLs, plus `tools` /
 * `tool_choice` and `response_format` (see `providers/gemini.ts` and
 * `openai-compat.ts`). The `vision` / `tools` / `json` / `structuredOutput`
 * flags are what each default model's API supports, and the router uses them to
 * GATE and route those live features (an image/tool/schema only reaches a model
 * marked capable). Values are **best-effort** against provider docs (reviewed
 * 2026-06) — re-verify before relying on them, exactly like `data-policies.ts`.
 * `contextWindow` is the model's real max window (NOT the engine's
 * deliberately-conservative compile budget in `engine.ts`).
 *
 * `capabilityTier`: deliberate provider-quality ordering for the `capability` /
 * `quality` / `balanced` routing strategies (lower = preferred). Centralized
 * here from the old router rank; the numbers are unchanged so routing order is
 * preserved — revisit them here (one place) rather than in the router.
 */
/** Strongest structured-output guarantee a model's API provides.
 *  - "json_schema": constrained decode to a supplied schema (GUARANTEED conformant)
 *  - "json_object": valid-JSON mode only (NOT schema-conformant)
 *  - "none": no native structured output (must be emulated + post-validated) */
export type StructuredLevel = "json_schema" | "json_object" | "none";

export interface ModelCapabilities {
  /** Default model id the provider serves (matches the runtime `defaultModel`). */
  model: string;
  /** Real maximum context window in tokens for `model`. */
  contextWindow: number;
  /** `model` natively accepts image input (multimodal vision). */
  vision: boolean;
  /** `model` + its API support tool/function calling. */
  tools: boolean;
  /** `model` + its API support structured/JSON output (response_format/json mode).
   *  DERIVED convenience flag = `structuredOutput !== "none"`. Prefer the 3-state
   *  `structuredOutput` below, which distinguishes GUARANTEED schema conformance
   *  from best-effort json-mode. */
  json: boolean;
  /** The STRONGEST structured-output level the default model's API guarantees:
   *  - "json_schema": constrained decode to a supplied schema (GUARANTEED conformant)
   *  - "json_object": valid-JSON mode only (NOT schema-conformant)
   *  - "none": no native structured output (emulated via prompt + post-validate)
   *  This 3-state replaces the boolean `json`'s conflation so routing can honor a
   *  strict-schema request only on a provider that truly guarantees it. */
  structuredOutput: StructuredLevel;
  /** Routing rank for capability/quality/balanced (lower = preferred). */
  capabilityTier: number;
}

// `structuredOutput` is CONSERVATIVE: only providers whose API confidently
// guarantees schema-constrained decoding are "json_schema" (gemini's
// responseSchema). Everyone with native JSON mode is "json_object"; providers with
// no native structured output are "none". This keeps `json` consistent as
// `structuredOutput !== "none"`. Re-verify before promoting a provider to
// "json_schema" — a wrong claim breaks the GUARANTEED-conformance contract.
// Providers added after 2026-07-02 declare capabilities in manifest.ts (one
// entry per provider); their slice is spread in below the original 12.
export const MODEL_CAPABILITIES: Record<ProviderId, ModelCapabilities> = {
  ...(extendedCapabilities() as Record<ProviderId, ModelCapabilities>),
  gemini:      { model: "gemini-2.5-flash",                                   contextWindow: 1_000_000, vision: true,  tools: true,  json: true,  structuredOutput: "json_schema", capabilityTier: 1 },
  openrouter:  { model: "meta-llama/llama-3.3-70b-instruct:free",            contextWindow: 128_000,   vision: false, tools: true,  json: true,  structuredOutput: "json_object", capabilityTier: 2 },
  fireworks:   { model: "accounts/fireworks/models/llama-v3p1-8b-instruct",  contextWindow: 128_000,   vision: false, tools: true,  json: true,  structuredOutput: "json_object", capabilityTier: 3 },
  xai:         { model: "grok-2-latest",                                      contextWindow: 131_072,   vision: false, tools: true,  json: true,  structuredOutput: "json_object", capabilityTier: 4 },
  deepseek:    { model: "deepseek-chat",                                      contextWindow: 64_000,    vision: false, tools: true,  json: true,  structuredOutput: "json_object", capabilityTier: 5 },
  mistral:     { model: "mistral-large-latest",                              contextWindow: 128_000,   vision: false, tools: true,  json: true,  structuredOutput: "json_object", capabilityTier: 6 },
  huggingface: { model: "meta-llama/Llama-3.3-70B-Instruct",                 contextWindow: 128_000,   vision: false, tools: false, json: false, structuredOutput: "none",        capabilityTier: 7 },
  cohere:      { model: "command-r-plus-08-2024",                           contextWindow: 128_000,   vision: false, tools: true,  json: false, structuredOutput: "none",        capabilityTier: 8 },
  cerebras:    { model: "llama-3.3-70b",                                     contextWindow: 128_000,   vision: false, tools: true,  json: true,  structuredOutput: "json_object", capabilityTier: 9 },
  groq:        { model: "llama-3.3-70b-versatile",                           contextWindow: 128_000,   vision: false, tools: true,  json: true,  structuredOutput: "json_object", capabilityTier: 10 },
  lmstudio:    { model: "local-model",                                       contextWindow: 32_000,    vision: false, tools: false, json: false, structuredOutput: "none",        capabilityTier: 98 },
  ollama:      { model: "llama3.3",                                          contextWindow: 128_000,   vision: false, tools: true,  json: true,  structuredOutput: "json_object", capabilityTier: 99 },
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
// provider's API. xAI vision is model-specific and stays UNMAPPED until a route
// is explicitly verified + tested. Local providers (ollama/lmstudio) require a
// runtime-DETECTED local vision model — never asserted here.
//
// openrouter: the listed Llama 3.2 Vision models are verified OpenAI-compatible
// vision routes (image_url data-URL parts via `toOpenAiContentParts`). The
// provider DEFAULT (`meta-llama/llama-3.3-70b-instruct:free`) stays NON-vision —
// only the specific models below are vision, never the whole provider.
const VISION_MODELS: Partial<Record<ProviderId, ReadonlySet<string>>> = {
  // Manifest providers' verified vision routes (e.g. openai gpt-4o family).
  ...extendedVisionModels(),
  gemini: new Set([
    "gemini-2.5-flash",
    "gemini-2.5-pro",
    "gemini-2.5-flash-lite",
    "gemini-2.0-flash",
    "gemini-1.5-pro",
    "gemini-1.5-flash",
  ]),
  openrouter: new Set([
    "meta-llama/llama-3.2-90b-vision-instruct",
    "meta-llama/llama-3.2-11b-vision-instruct",
  ]),
  // Mistral's Pixtral Large is a documented multimodal model; the OpenAI-compat
  // adapter sends image_url data-URL parts, which the Mistral API accepts.
  mistral: new Set(["pixtral-large-latest"]),
};

// Ollama model families verified to accept image input via the native
// `/api/chat` `images: [base64]` field. Matched against the BASE name (the part
// before the `:tag`), so `llava:13b` and `moondream:latest` both qualify.
// Deliberately conservative — a family is added only when Ollama's library
// documents it as multimodal. Whether such a family is INSTALLED stays a
// runtime question (the gateway resolves it against `/api/tags`).
//
// ORDERED strongest → weakest at dense/OCR-ish inputs (screenshots, documents):
// the runtime resolver picks the best-ranked INSTALLED model, so pulling
// minicpm-v upgrades every image turn even while moondream stays installed.
const OLLAMA_VISION_FAMILIES = [
  "minicpm-v",
  "qwen2.5vl",
  "qwen2-vl",
  "llama3.2-vision",
  "llava-llama3",
  "llava",
  "bakllava",
  "llava-phi3",
  "granite3.2-vision",
  "gemma3",
  "moondream",
] as const;

/** True when an Ollama model NAME (e.g. "llava:13b") belongs to a documented
 *  multimodal family. Purely name-based — installation is checked at runtime. */
export function isOllamaVisionModel(model: string): boolean {
  const base = model.split(":")[0]?.toLowerCase() ?? "";
  return (OLLAMA_VISION_FAMILIES as readonly string[]).includes(base);
}

/** Quality rank of a vision model name within OLLAMA_VISION_FAMILIES
 *  (lower = stronger); Infinity for non-vision names. Used by the runtime
 *  resolver to prefer the BEST installed model, not the first listed. */
export function ollamaVisionRank(model: string): number {
  const base = model.split(":")[0]?.toLowerCase() ?? "";
  const idx = (OLLAMA_VISION_FAMILIES as readonly string[]).indexOf(base);
  return idx === -1 ? Infinity : idx;
}

/**
 * Model-aware vision check.
 * - With a `model`: true ONLY if that specific model is known to accept image
 *   input (never a whole-provider assumption). For ollama the check is
 *   family-name-based (see OLLAMA_VISION_FAMILIES) — the gateway only pins an
 *   ollama model here after resolving it against the installed `/api/tags`.
 * - Without a `model` (the provider's default): the default model's `vision`
 *   flag from the registry. Local providers stay false here — a bare provider
 *   pick needs the runtime-detected vision model, decided at the gateway.
 */
export function supportsVision(providerId: ProviderId, model?: string): boolean {
  if (model) {
    if (providerId === "ollama") return isOllamaVisionModel(model);
    return VISION_MODELS[providerId]?.has(model) ?? false;
  }
  return MODEL_CAPABILITIES[providerId]?.vision ?? false;
}

// Per-provider sets of model ids verified to support tool/function calling, for the
// model-aware `supportsTools` check. Like `VISION_MODELS` this is deliberately
// allowlist-based — a specific model id is only treated as tool-capable when it is
// listed here OR it is the provider's default model (whose `tools` flag lives in
// MODEL_CAPABILITIES). An unknown specific model fails closed so the router
// hard-errors rather than silently sending tools to a model that drops them.
// Local providers (ollama/lmstudio) are runtime-dependent and never asserted here.
const TOOL_MODELS: Partial<Record<ProviderId, ReadonlySet<string>>> = {
  gemini: new Set([
    "gemini-2.5-flash",
    "gemini-2.5-pro",
    "gemini-2.5-flash-lite",
    "gemini-2.0-flash",
    "gemini-1.5-pro",
    "gemini-1.5-flash",
  ]),
  groq: new Set([
    "llama-3.3-70b-versatile",
    "llama-3.1-8b-instant",
    // OpenAI's open-weight MoE models on GroqCloud — function calling supported.
    "openai/gpt-oss-120b",
    "openai/gpt-oss-20b",
  ]),
  // Cohere Command models that document tool use (via the OpenAI-compat surface).
  cohere: new Set([
    "command-a-03-2025",
    "command-a-reasoning-08-2025",
    "command-r7b-12-2024",
  ]),
  // Mistral instruct models expose native function calling on /v1/chat/completions.
  mistral: new Set([
    "mistral-medium-latest",
    "ministral-8b-latest",
    "ministral-3b-latest",
    "pixtral-large-latest",
  ]),
  // Fireworks serves OpenAI-style function calling for its Llama instruct models.
  fireworks: new Set(["accounts/fireworks/models/llama-v3p3-70b-instruct"]),
  // Cerebras serves tool calling for gpt-oss-120b.
  cerebras: new Set(["gpt-oss-120b"]),
};

/**
 * Model-aware tool/function-calling check (mirrors `supportsVision`).
 * - With a `model`: true if that model is in the provider's verified `TOOL_MODELS`
 *   set, OR it is the provider's default model and the registry marks the default
 *   `tools: true`. Any other specific model is treated as NOT tool-capable
 *   (fail-closed) until explicitly verified + listed.
 * - Without a `model` (the provider's default): the default model's `tools` flag.
 * For local providers (ollama/lmstudio) any SPECIFIC model id fails closed (no
 * static allowlist) — a tool-capable local model must be runtime-detected at the
 * gateway, not asserted here.
 */
export function supportsTools(providerId: ProviderId, model?: string): boolean {
  const caps = MODEL_CAPABILITIES[providerId];
  if (model) {
    if (TOOL_MODELS[providerId]?.has(model)) return true;
    // Default model is the one whose `tools` flag the registry tracks.
    if (caps?.model === model) return caps.tools;
    return false;
  }
  return caps?.tools ?? false;
}

// Per-provider sets of model ids verified to GUARANTEE schema-constrained decoding
// (level "json_schema"), for the model-aware `structuredOutputLevel` check. Like
// VISION_MODELS/TOOL_MODELS this is a conservative allowlist — a non-default model
// is only "json_schema" when listed here; otherwise it falls back to the default's
// registry level. Promote a model here only after verifying its API truly
// constrains output to the schema (not just JSON mode).
const JSON_SCHEMA_MODELS: Partial<Record<ProviderId, ReadonlySet<string>>> = {
  gemini: new Set([
    "gemini-2.5-flash",
    "gemini-2.5-pro",
    "gemini-2.5-flash-lite",
    "gemini-2.0-flash",
    "gemini-1.5-pro",
    "gemini-1.5-flash",
  ]),
  // GroqCloud documents a "JSON Schema Mode" (constrained decode) for gpt-oss.
  groq: new Set([
    "openai/gpt-oss-120b",
    "openai/gpt-oss-20b",
  ]),
};

/**
 * Model-aware structured-output level (mirrors `supportsTools`).
 * - With a `model`: "json_schema" if the model is in the verified
 *   `JSON_SCHEMA_MODELS` set, else the provider default's registry level when it IS
 *   the default model, else "none" (fail closed — an unknown model is not assumed
 *   to support structured output).
 * - Without a `model`: the default model's `structuredOutput` level.
 */
export function structuredOutputLevel(
  providerId: ProviderId,
  model?: string,
): StructuredLevel {
  const caps = MODEL_CAPABILITIES[providerId];
  if (model) {
    if (JSON_SCHEMA_MODELS[providerId]?.has(model)) return "json_schema";
    if (caps?.model === model) return caps.structuredOutput;
    return "none";
  }
  return caps?.structuredOutput ?? "none";
}
