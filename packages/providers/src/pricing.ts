import type { ProviderId } from "@zintus/types";

/**
 * Static, NON-CUSTODIAL pricing catalog: published per-1M-token list prices for
 * the (provider, model) pairs Zintus actually routes to. This is reference data
 * only — Zintus never bills, holds funds, or manages keys; these numbers power
 * honest "provable savings" estimates and cheapest-routing hints. Every price is
 * an estimate of a third party's public list price at {@link ModelPricing.updatedAt},
 * not a promise — providers change prices, and free tiers/cache discounts vary.
 *
 * NOT BILLING TRUTH: never import this into an invoice, charge, credit-deduction,
 * or paid-metering path. It is for UI/savings display and routing hints only.
 *
 * Prices are USD per 1,000,000 tokens, split into input (prompt) and output
 * (completion). Local runtimes (LM Studio, Ollama) are 0 — they run on the
 * user's own hardware with no per-token API charge.
 *
 * Sources are cited inline per entry (verified June 2026). When a price is
 * uncertain (router-forwarded providers, ambiguous "-latest" aliases) it is
 * marked in the entry's `freeLimitNotes` and chosen conservatively.
 */
export interface ModelPricing {
  /** Provider this model is served by (keyed to the real provider set). */
  provider: ProviderId;
  /** Model id exactly as passed to the provider API (matches `defaultModel`). */
  model: string;
  /** USD per 1M input (prompt) tokens. 0 for local runtimes. */
  inputPer1M: number;
  /** USD per 1M output (completion) tokens. 0 for local runtimes. */
  outputPer1M: number;
  /** Free-tier allowance and/or any accuracy caveat for this entry. */
  freeLimitNotes?: string;
  /** ISO date the price was last verified (YYYY-MM-DD). */
  updatedAt: string;
}

const VERIFIED = "2026-06-26";

/**
 * The catalog. One entry per (provider, model) pair Zintus routes to — the
 * `defaultModel` of each runtime provider plus Groq's 8B failover tier and a
 * representative OpenRouter `:free` route.
 *
 * Source key (verified 2026-06-26):
 *  - Groq:        https://groq.com/pricing
 *  - Gemini:      https://ai.google.dev/gemini-api/docs/pricing
 *  - DeepSeek:    https://api-docs.deepseek.com/quick_start/pricing
 *  - Mistral:     https://mistral.ai/pricing/
 *  - Cohere:      https://cohere.com/pricing
 *  - xAI:         https://docs.x.ai/developers/models
 *  - Fireworks:   https://fireworks.ai/pricing
 *  - Cerebras:    https://www.cerebras.ai/pricing
 *  - OpenRouter:  https://openrouter.ai/models (`:free` routes)
 */
export const PRICING_CATALOG: readonly ModelPricing[] = [
  // Cerebras — wafer-scale Llama inference. Paid dev-tier list price.
  // Source: cerebras.ai/pricing (Llama 3.3 70B ~$0.85 in / $1.20 out).
  {
    provider: "cerebras",
    model: "llama-3.3-70b",
    inputPer1M: 0.85,
    outputPer1M: 1.2,
    freeLimitNotes:
      "Free tier ~1M tokens/day, ~30 req/min. Paid price approximate (dev tier).",
    updatedAt: VERIFIED,
  },

  // Groq — LPU inference. Source: groq.com/pricing.
  {
    provider: "groq",
    model: "llama-3.3-70b-versatile",
    inputPer1M: 0.59,
    outputPer1M: 0.79,
    freeLimitNotes: "Free tier ~1,000 req/day, ~30 req/min (per model).",
    updatedAt: VERIFIED,
  },
  {
    // Groq's 8B failover tier (same key); far cheaper than the 70B tier.
    provider: "groq",
    model: "llama-3.1-8b-instant",
    inputPer1M: 0.05,
    outputPer1M: 0.08,
    freeLimitNotes: "Free tier ~14,400 req/day. 8B failover for the 70B tier.",
    updatedAt: VERIFIED,
  },
  {
    // OpenAI gpt-oss-120b on GroqCloud. Source: console.groq.com/docs/model/openai/gpt-oss-120b.
    provider: "groq",
    model: "openai/gpt-oss-120b",
    inputPer1M: 0.15,
    outputPer1M: 0.6,
    freeLimitNotes:
      "Open-weight MoE on GroqCloud. Tool use + JSON Schema mode. Cached input ~$0.075/1M.",
    updatedAt: VERIFIED,
  },

  // Gemini — AI Studio / Developer API. Source: ai.google.dev/gemini-api/docs/pricing.
  {
    provider: "gemini",
    model: "gemini-2.5-flash",
    inputPer1M: 0.3,
    outputPer1M: 2.5,
    freeLimitNotes:
      "Free tier ~1,500 req/day, ~15 req/min. Output price is text; audio in differs.",
    updatedAt: VERIFIED,
  },

  // OpenRouter — `:free` route costs $0 (rate-limited, not always available).
  // Source: openrouter.ai/models (free routes).
  {
    provider: "openrouter",
    model: "meta-llama/llama-3.3-70b-instruct:free",
    inputPer1M: 0,
    outputPer1M: 0,
    freeLimitNotes:
      "$0 `:free` route; ~50 req/day, ~20 req/min, availability not guaranteed.",
    updatedAt: VERIFIED,
  },

  // Cohere — Command R+ (08-2024). Source: cohere.com/pricing.
  {
    provider: "cohere",
    model: "command-r-plus-08-2024",
    inputPer1M: 2.5,
    outputPer1M: 10.0,
    freeLimitNotes: "Trial keys are rate-limited (~33 req/day, ~10 req/min).",
    updatedAt: VERIFIED,
  },

  // Mistral — `mistral-large-latest` currently resolves to Mistral Large 2
  // ($2 in / $6 out). Source: mistral.ai/pricing.
  {
    provider: "mistral",
    model: "mistral-large-latest",
    inputPer1M: 2.0,
    outputPer1M: 6.0,
    freeLimitNotes:
      "`-latest` alias; price tracks Mistral Large 2. Free experiment tier available.",
    updatedAt: VERIFIED,
  },

  // DeepSeek — `deepseek-chat` (V4 Flash non-thinking). Source: api-docs.deepseek.com.
  {
    provider: "deepseek",
    model: "deepseek-chat",
    inputPer1M: 0.14,
    outputPer1M: 0.28,
    freeLimitNotes:
      "Pay-as-you-go (cache-hit input far cheaper). `deepseek-chat` alias slated for deprecation 2026-07-24.",
    updatedAt: VERIFIED,
  },

  // Fireworks — serverless 4-16B tier is a flat blended $0.20/1M (in == out).
  // Source: fireworks.ai/pricing.
  {
    provider: "fireworks",
    model: "accounts/fireworks/models/llama-v3p1-8b-instruct",
    inputPer1M: 0.2,
    outputPer1M: 0.2,
    freeLimitNotes: "Free trial credits. Serverless 4-16B flat rate (in == out).",
    updatedAt: VERIFIED,
  },

  // xAI — `grok-2-latest`. Source: docs.x.ai/developers/models (Grok 2 $2 / $10).
  {
    provider: "xai",
    model: "grok-2-latest",
    inputPer1M: 2.0,
    outputPer1M: 10.0,
    freeLimitNotes: "Trial credits vary. Legacy Grok 2 tier pricing.",
    updatedAt: VERIFIED,
  },

  // Hugging Face — Inference Router forwards to a third-party upstream, so the
  // effective price depends on which provider serves the request. UNCERTAIN:
  // anchored to a typical 70B-class list price, marked conservative.
  {
    provider: "huggingface",
    model: "meta-llama/Llama-3.3-70B-Instruct",
    inputPer1M: 0.6,
    outputPer1M: 0.9,
    freeLimitNotes:
      "UNCERTAIN: router forwards to an upstream provider; price varies. 70B-class anchor.",
    updatedAt: VERIFIED,
  },

  // Local runtimes — no per-token API charge (user's own hardware).
  {
    provider: "lmstudio",
    model: "local-model",
    inputPer1M: 0,
    outputPer1M: 0,
    freeLimitNotes: "Local — runs on your own hardware, no API charge.",
    updatedAt: VERIFIED,
  },
  {
    provider: "ollama",
    model: "llama3.3",
    inputPer1M: 0,
    outputPer1M: 0,
    freeLimitNotes: "Local — runs on your own hardware, no API charge.",
    updatedAt: VERIFIED,
  },
];

/**
 * Look up the pricing entry for an exact (provider, model) pair.
 * Returns `undefined` if the pair is not in the catalog.
 */
export function getModelPricing(
  provider: ProviderId,
  model: string,
): ModelPricing | undefined {
  return PRICING_CATALOG.find(
    (e) => e.provider === provider && e.model === model,
  );
}

/** All catalog entries (defensive copy so callers can't mutate the source). */
export function listPricing(): ModelPricing[] {
  return [...PRICING_CATALOG];
}

/**
 * Estimate the USD a paid API would charge for a request of the given token
 * counts on a specific (provider, model) pair. Returns 0 for unknown pairs and
 * for local runtimes (both priced at 0). Negative token counts are clamped to 0.
 */
export function estimateCostUsd(
  provider: ProviderId,
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const entry = getModelPricing(provider, model);
  if (!entry) {
    return 0;
  }
  const inTok = Math.max(0, inputTokens);
  const outTok = Math.max(0, outputTokens);
  return (
    (inTok / 1_000_000) * entry.inputPer1M +
    (outTok / 1_000_000) * entry.outputPer1M
  );
}
