import type { PriceSnapshot } from "./rates.js";

/**
 * BUNDLED price snapshot — the billing-grade fallback table compiled into the
 * client. The pricing worker (`workers/pricing`) publishes fresher snapshots
 * to KV with higher `version`s; consumers take the highest valid version they
 * can reach and fall back to this one offline. Burn receipts record which
 * version priced them either way.
 *
 * Coverage tracks the (provider, model) routes Zintus actually sends traffic
 * to (the `defaultModel` set — same coverage rule as the display catalog in
 * `@zintus/providers/pricing.ts`, which is NOT a billing source and must stay
 * un-imported here; see pricing-billing-guard.test.ts).
 *
 * Every rate below was read from the provider's first-party pricing page on
 * `updatedAt`. Cache rates are listed only where the provider publishes one —
 * absent cache rates bill at the full input rate (conservative by design).
 */
export const BUNDLED_SNAPSHOT: PriceSnapshot = {
  version: 1,
  generatedAt: "2026-07-03T00:00:00.000Z",
  rates: [
    {
      provider: "cerebras",
      model: "llama-3.3-70b",
      class: "cheap",
      inPer1M: 0.85,
      outPer1M: 1.2,
      updatedAt: "2026-07-03",
      source: "https://www.cerebras.ai/pricing",
    },
    {
      provider: "groq",
      model: "llama-3.3-70b-versatile",
      class: "cheap",
      inPer1M: 0.59,
      outPer1M: 0.79,
      updatedAt: "2026-07-03",
      source: "https://groq.com/pricing",
    },
    {
      provider: "groq",
      model: "llama-3.1-8b-instant",
      class: "cheap",
      inPer1M: 0.05,
      outPer1M: 0.08,
      updatedAt: "2026-07-03",
      source: "https://groq.com/pricing",
    },
    {
      provider: "groq",
      model: "openai/gpt-oss-120b",
      class: "cheap",
      inPer1M: 0.15,
      outPer1M: 0.6,
      updatedAt: "2026-07-03",
      source: "https://groq.com/pricing",
    },
    {
      provider: "gemini",
      model: "gemini-2.5-flash",
      class: "cheap",
      inPer1M: 0.3,
      outPer1M: 2.5,
      // Gemini publishes context-cache reads at ~10% of input.
      cacheReadPer1M: 0.03,
      updatedAt: "2026-07-03",
      source: "https://ai.google.dev/gemini-api/docs/pricing",
    },
    {
      provider: "openrouter",
      model: "meta-llama/llama-3.3-70b-instruct:free",
      class: "free",
      inPer1M: 0,
      outPer1M: 0,
      updatedAt: "2026-07-03",
      source: "https://openrouter.ai/models",
    },
    {
      provider: "cohere",
      model: "command-r-plus-08-2024",
      class: "mid",
      inPer1M: 2.5,
      outPer1M: 10.0,
      updatedAt: "2026-07-03",
      source: "https://cohere.com/pricing",
    },
    {
      provider: "mistral",
      model: "mistral-large-latest",
      class: "mid",
      inPer1M: 2.0,
      outPer1M: 6.0,
      updatedAt: "2026-07-03",
      source: "https://mistral.ai/pricing",
    },
    {
      provider: "deepseek",
      model: "deepseek-chat",
      class: "cheap",
      inPer1M: 0.14,
      outPer1M: 0.28,
      // DeepSeek publishes cache-hit input at $0.0028/1M (V4 Flash line).
      cacheReadPer1M: 0.0028,
      updatedAt: "2026-07-03",
      source: "https://api-docs.deepseek.com/quick_start/pricing",
    },
    {
      provider: "fireworks",
      model: "accounts/fireworks/models/llama-v3p1-8b-instruct",
      class: "cheap",
      inPer1M: 0.2,
      outPer1M: 0.2,
      updatedAt: "2026-07-03",
      source: "https://fireworks.ai/pricing",
    },
    {
      provider: "xai",
      model: "grok-2-latest",
      class: "mid",
      inPer1M: 2.0,
      outPer1M: 10.0,
      updatedAt: "2026-07-03",
      source: "https://docs.x.ai/developers/models",
    },
    {
      provider: "huggingface",
      model: "meta-llama/Llama-3.3-70B-Instruct",
      class: "cheap",
      inPer1M: 0.6,
      outPer1M: 0.9,
      updatedAt: "2026-07-03",
      source: "https://huggingface.co/docs/inference-providers/pricing",
    },
    {
      provider: "lmstudio",
      model: "local-model",
      class: "free",
      inPer1M: 0,
      outPer1M: 0,
      updatedAt: "2026-07-03",
      source: "local runtime — no per-token charge",
    },
    {
      provider: "ollama",
      model: "llama3.3",
      class: "free",
      inPer1M: 0,
      outPer1M: 0,
      updatedAt: "2026-07-03",
      source: "local runtime — no per-token charge",
    },
  ],
};
