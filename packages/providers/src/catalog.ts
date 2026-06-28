import type { ProviderId } from "@zintus/types";
import {
  MODEL_CAPABILITIES,
  type StructuredLevel,
} from "./capabilities.js";
import { DATA_POLICIES } from "./data-policies.js";
import { getModelPricing } from "./pricing.js";

/**
 * ENUMERABLE per-model catalog — the foundation for an OpenRouter-grade
 * `/models` surface. Where {@link MODEL_CAPABILITIES} answers "what can each
 * provider's DEFAULT model do" and {@link PRICING_CATALOG} answers "what does a
 * routed (provider, model) pair cost", THIS file answers "which models exist and
 * what are their shape/price/policy flags" — a browsable list, not a per-provider
 * default.
 *
 * BEST-EFFORT, CURATED, NOT A LIVE MIRROR. Every entry is hand-seeded from
 * Zintus's OWN ground truth (the three sources below) and a few well-known real
 * models added per provider so the list feels like a catalog. It is honest seed
 * data — RE-VERIFY against the provider's docs before relying on any flag or
 * price. This is NOT scraped and NOT auto-synced; it will drift as providers ship
 * models. Treat it like `data-policies.ts`/`capabilities.ts`: a reviewed snapshot.
 *
 * SOURCING (no invented data):
 *  1. Every provider DEFAULT model id from `MODEL_CAPABILITIES` (capabilities.ts).
 *  2. Every priced (provider, model) pair from `PRICING_CATALOG` (pricing.ts) —
 *     prices are cross-referenced from there, never made up.
 *  3. Every model id already gated in `VISION_MODELS` / `TOOL_MODELS` /
 *     `JSON_SCHEMA_MODELS` (the capability allowlists in capabilities.ts).
 *  + a few extra well-known REAL models per provider, with CONSERVATIVE flags:
 *    when a capability is not verified it is marked vision:false / tools:false /
 *    structuredOutput:"none". Capability flags below mirror exactly what the
 *    model-aware checks in capabilities.ts return — `catalog.test.ts` asserts that
 *    agreement, so the catalog can never silently over-claim a capability.
 *
 * PRICE/POLICY rules:
 *  - `inputPer1M`/`outputPer1M`: the `PRICING_CATALOG` list price when present and
 *    POSITIVE, else `null`. A 0 in `PRICING_CATALOG` (local runtimes, `:free`
 *    routes) maps to `null` — "no per-token price" is signalled by `free`/`local`,
 *    not by a misleading 0. Never an invented number.
 *  - `dataPolicy`: derived from `DATA_POLICIES` (data-policies.ts).
 */

/** Coarse data-handling tag for a model, derived from `DATA_POLICIES`. */
export type DataPolicyTag =
  | "no_train"
  | "may_train"
  | "unknown"
  | "zero_retention";

export interface CatalogModel {
  /** Provider-native model id, exactly as passed to the provider API. */
  id: string;
  /** Provider this model is served by. */
  provider: ProviderId;
  /** Human-readable label for UI. */
  displayName: string;
  /** Real maximum context window in tokens. */
  contextWindow: number;
  /** Natively accepts image input (multimodal vision). */
  vision: boolean;
  /** Supports tool/function calling. */
  tools: boolean;
  /** Strongest native structured-output level (see capabilities.ts). */
  structuredOutput: StructuredLevel;
  /** USD per 1M input tokens; `null` = unknown / local / free (no list price). */
  inputPer1M: number | null;
  /** USD per 1M output tokens; `null` = unknown / local / free (no list price). */
  outputPer1M: number | null;
  /** A free tier / no-cost quota exists for this model. */
  free: boolean;
  /** Local-runtime model (ollama / lmstudio) — runs on the user's hardware. */
  local: boolean;
  /** Coarse data-handling tag, derived from `DATA_POLICIES`. */
  dataPolicy: DataPolicyTag;
  /** This id is the provider's default model in `MODEL_CAPABILITIES`. */
  isProviderDefault: boolean;
}

/** Map a provider's `DATA_POLICIES` entry to a coarse catalog tag. */
function dataPolicyTag(provider: ProviderId): DataPolicyTag {
  const p = DATA_POLICIES[provider];
  if (p.zdr) return "zero_retention";
  if (p.trainsOnData === true) return "may_train";
  if (p.trainsOnData === false) return "no_train";
  return "unknown";
}

/**
 * List price from `PRICING_CATALOG` for an exact (provider, model) pair, or
 * `null` when absent OR non-positive (0 = local/free, signalled elsewhere). Never
 * fabricates a price.
 */
function listPrice(
  provider: ProviderId,
  model: string,
  kind: "in" | "out",
): number | null {
  const p = getModelPricing(provider, model);
  if (!p) return null;
  const v = kind === "in" ? p.inputPer1M : p.outputPer1M;
  return v > 0 ? v : null;
}

interface CatalogSeed {
  id: string;
  displayName: string;
  contextWindow: number;
  vision: boolean;
  tools: boolean;
  structuredOutput: StructuredLevel;
  free: boolean;
}

const LOCAL_PROVIDERS: ReadonlySet<ProviderId> = new Set(["lmstudio", "ollama"]);

/** Build a full {@link CatalogModel} from a per-provider seed. */
function build(provider: ProviderId, seed: CatalogSeed): CatalogModel {
  return {
    id: seed.id,
    provider,
    displayName: seed.displayName,
    contextWindow: seed.contextWindow,
    vision: seed.vision,
    tools: seed.tools,
    structuredOutput: seed.structuredOutput,
    inputPer1M: listPrice(provider, seed.id, "in"),
    outputPer1M: listPrice(provider, seed.id, "out"),
    free: seed.free,
    local: LOCAL_PROVIDERS.has(provider),
    dataPolicy: dataPolicyTag(provider),
    isProviderDefault: MODEL_CAPABILITIES[provider].model === seed.id,
  };
}

// Per-provider seeds. Flags MIRROR the model-aware checks in capabilities.ts
// (supportsVision / supportsTools / structuredOutputLevel); extras default to the
// conservative vision:false / tools:false / structuredOutput:"none".
const SEEDS: ReadonlyArray<readonly [ProviderId, CatalogSeed]> = [
  // ── Gemini ─ all listed models are verified vision + tools + json_schema. ──
  ["gemini", { id: "gemini-2.5-flash", displayName: "Gemini 2.5 Flash", contextWindow: 1_000_000, vision: true, tools: true, structuredOutput: "json_schema", free: true }],
  ["gemini", { id: "gemini-2.5-pro", displayName: "Gemini 2.5 Pro", contextWindow: 1_000_000, vision: true, tools: true, structuredOutput: "json_schema", free: true }],
  ["gemini", { id: "gemini-2.5-flash-lite", displayName: "Gemini 2.5 Flash-Lite", contextWindow: 1_000_000, vision: true, tools: true, structuredOutput: "json_schema", free: true }],
  ["gemini", { id: "gemini-2.0-flash", displayName: "Gemini 2.0 Flash", contextWindow: 1_000_000, vision: true, tools: true, structuredOutput: "json_schema", free: true }],
  ["gemini", { id: "gemini-1.5-pro", displayName: "Gemini 1.5 Pro", contextWindow: 2_000_000, vision: true, tools: true, structuredOutput: "json_schema", free: true }],
  ["gemini", { id: "gemini-1.5-flash", displayName: "Gemini 1.5 Flash", contextWindow: 1_000_000, vision: true, tools: true, structuredOutput: "json_schema", free: true }],

  // ── OpenRouter ─ default `:free` route + verified Llama 3.2 Vision routes. ──
  ["openrouter", { id: "meta-llama/llama-3.3-70b-instruct:free", displayName: "Llama 3.3 70B Instruct (free)", contextWindow: 128_000, vision: false, tools: true, structuredOutput: "json_object", free: true }],
  ["openrouter", { id: "meta-llama/llama-3.2-90b-vision-instruct", displayName: "Llama 3.2 90B Vision Instruct", contextWindow: 128_000, vision: true, tools: false, structuredOutput: "none", free: false }],
  ["openrouter", { id: "meta-llama/llama-3.2-11b-vision-instruct", displayName: "Llama 3.2 11B Vision Instruct", contextWindow: 128_000, vision: true, tools: false, structuredOutput: "none", free: false }],

  // ── Fireworks (extra: serverless Llama 3.3 70B, function-calling verified) ──
  ["fireworks", { id: "accounts/fireworks/models/llama-v3p1-8b-instruct", displayName: "Llama 3.1 8B Instruct", contextWindow: 128_000, vision: false, tools: true, structuredOutput: "json_object", free: false }],
  ["fireworks", { id: "accounts/fireworks/models/llama-v3p3-70b-instruct", displayName: "Llama 3.3 70B Instruct", contextWindow: 131_072, vision: false, tools: true, structuredOutput: "none", free: false }],

  // ── xAI ──
  ["xai", { id: "grok-2-latest", displayName: "Grok 2", contextWindow: 131_072, vision: false, tools: true, structuredOutput: "json_object", free: false }],

  // ── DeepSeek (extra: deepseek-reasoner, conservative flags / no listed price) ──
  ["deepseek", { id: "deepseek-chat", displayName: "DeepSeek Chat", contextWindow: 64_000, vision: false, tools: true, structuredOutput: "json_object", free: false }],
  ["deepseek", { id: "deepseek-reasoner", displayName: "DeepSeek Reasoner", contextWindow: 64_000, vision: false, tools: false, structuredOutput: "none", free: false }],

  // ── Mistral (large default + verified -latest aliases; pixtral = vision) ──
  ["mistral", { id: "mistral-large-latest", displayName: "Mistral Large", contextWindow: 128_000, vision: false, tools: true, structuredOutput: "json_object", free: true }],
  ["mistral", { id: "mistral-medium-latest", displayName: "Mistral Medium", contextWindow: 128_000, vision: false, tools: true, structuredOutput: "none", free: true }],
  ["mistral", { id: "mistral-small-latest", displayName: "Mistral Small", contextWindow: 32_000, vision: false, tools: false, structuredOutput: "none", free: true }],
  ["mistral", { id: "ministral-8b-latest", displayName: "Ministral 8B", contextWindow: 128_000, vision: false, tools: true, structuredOutput: "none", free: true }],
  ["mistral", { id: "ministral-3b-latest", displayName: "Ministral 3B", contextWindow: 128_000, vision: false, tools: true, structuredOutput: "none", free: true }],
  ["mistral", { id: "pixtral-large-latest", displayName: "Pixtral Large", contextWindow: 128_000, vision: true, tools: true, structuredOutput: "none", free: true }],
  ["mistral", { id: "codestral-latest", displayName: "Codestral", contextWindow: 256_000, vision: false, tools: false, structuredOutput: "none", free: true }],
  ["mistral", { id: "magistral-medium-latest", displayName: "Magistral Medium", contextWindow: 128_000, vision: false, tools: false, structuredOutput: "none", free: true }],

  // ── Hugging Face (Inference Router; default has no native tools/json) ──
  ["huggingface", { id: "meta-llama/Llama-3.3-70B-Instruct", displayName: "Llama 3.3 70B Instruct", contextWindow: 128_000, vision: false, tools: false, structuredOutput: "none", free: true }],

  // ── Cohere (default R+ + Command A / R7B, tool-calling verified) ──
  ["cohere", { id: "command-r-plus-08-2024", displayName: "Command R+ (08-2024)", contextWindow: 128_000, vision: false, tools: true, structuredOutput: "none", free: true }],
  ["cohere", { id: "command-a-03-2025", displayName: "Command A (03-2025)", contextWindow: 256_000, vision: false, tools: true, structuredOutput: "none", free: true }],
  ["cohere", { id: "command-a-reasoning-08-2025", displayName: "Command A Reasoning (08-2025)", contextWindow: 256_000, vision: false, tools: true, structuredOutput: "none", free: true }],
  ["cohere", { id: "command-r7b-12-2024", displayName: "Command R7B (12-2024)", contextWindow: 128_000, vision: false, tools: true, structuredOutput: "none", free: true }],
  ["cohere", { id: "command-r-08-2024", displayName: "Command R (08-2024)", contextWindow: 128_000, vision: false, tools: false, structuredOutput: "none", free: true }],

  // ── Cerebras (extra: llama-3.1-8b, conservative — not in tool/json allowlists) ──
  ["cerebras", { id: "llama-3.3-70b", displayName: "Llama 3.3 70B", contextWindow: 128_000, vision: false, tools: true, structuredOutput: "json_object", free: true }],
  ["cerebras", { id: "llama-3.1-8b", displayName: "Llama 3.1 8B", contextWindow: 128_000, vision: false, tools: false, structuredOutput: "none", free: true }],
  ["cerebras", { id: "gpt-oss-120b", displayName: "GPT-OSS 120B", contextWindow: 131_072, vision: false, tools: true, structuredOutput: "none", free: true }],

  // ── Groq (default 70B + 8B tool model + gpt-oss MoE with JSON-schema mode) ──
  ["groq", { id: "llama-3.3-70b-versatile", displayName: "Llama 3.3 70B Versatile", contextWindow: 128_000, vision: false, tools: true, structuredOutput: "json_object", free: true }],
  ["groq", { id: "llama-3.1-8b-instant", displayName: "Llama 3.1 8B Instant", contextWindow: 128_000, vision: false, tools: true, structuredOutput: "none", free: true }],
  ["groq", { id: "openai/gpt-oss-120b", displayName: "GPT-OSS 120B", contextWindow: 131_072, vision: false, tools: true, structuredOutput: "json_schema", free: true }],
  ["groq", { id: "openai/gpt-oss-20b", displayName: "GPT-OSS 20B", contextWindow: 131_072, vision: false, tools: true, structuredOutput: "json_schema", free: true }],

  // ── Local runtimes (no per-token price; flags fail closed for specific ids) ──
  ["lmstudio", { id: "local-model", displayName: "Local Model (LM Studio)", contextWindow: 32_000, vision: false, tools: false, structuredOutput: "none", free: true }],
  ["ollama", { id: "llama3.3", displayName: "Llama 3.3", contextWindow: 128_000, vision: false, tools: true, structuredOutput: "json_object", free: true }],
];

/** The full enumerable catalog (frozen so callers can't mutate the source). */
export const MODEL_CATALOG: readonly CatalogModel[] = Object.freeze(
  SEEDS.map(([provider, seed]) => build(provider, seed)),
);

/** All catalog entries (defensive copy so callers can't mutate the source). */
export function listCatalogModels(): CatalogModel[] {
  return [...MODEL_CATALOG];
}

/** Look up a single catalog entry by exact (provider, id). */
export function getCatalogModel(
  provider: ProviderId,
  id: string,
): CatalogModel | undefined {
  return MODEL_CATALOG.find((m) => m.provider === provider && m.id === id);
}

/** All catalog entries served by a given provider (possibly empty). */
export function catalogModelsForProvider(provider: ProviderId): CatalogModel[] {
  return MODEL_CATALOG.filter((m) => m.provider === provider);
}
