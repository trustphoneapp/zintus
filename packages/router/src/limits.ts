import type { PolicyLimits, ProviderId } from "@zintus/types";

export interface ProviderLimits {
  requestsPerDay?: number;
  tokensPerDay?: number;
  /** Rolling 60s request cap. */
  requestsPerMinute?: number;
  /** Rolling 60s token cap. */
  tokensPerMinute?: number;
  rollingWindow?: boolean;
}

/** Groq 70B tier — falls back to 8B model when exhausted (same API key). */
export const GROQ_MODEL_70B = "llama-3.3-70b-versatile";
export const GROQ_MODEL_8B = "llama-3.1-8b-instant";

export const GROQ_TIER_LIMITS = {
  [GROQ_MODEL_70B]: { requestsPerDay: 1_000, tokensPerDay: 100_000 },
  [GROQ_MODEL_8B]: { requestsPerDay: 14_400, tokensPerDay: 500_000 },
} as const;

export const DEFAULT_PROVIDER_LIMITS: Record<ProviderId, ProviderLimits> = {
  // Cerebras promotional tier generally offers generous token budgets.
  cerebras: { tokensPerDay: 1_000_000 },
  groq: {
    requestsPerDay: 1_000,
    tokensPerDay: 100_000,
    requestsPerMinute: 30,
    rollingWindow: true,
  },
  // Gemini free tier varies by model; use conservative request budget.
  gemini: { requestsPerDay: 1_500, requestsPerMinute: 15 },
  // Fireworks free trial is small (~10 RPM), model/token credits vary by account.
  fireworks: { requestsPerDay: 10_000, tokensPerDay: 1_000_000, requestsPerMinute: 10 },
  // xAI trial credits vary; keep routing conservative for shared free usage.
  xai: { requestsPerDay: 300, tokensPerDay: 500_000 },
  // HF router server-side provider selection; free usage is credit-based and variable.
  huggingface: { requestsPerDay: 300, tokensPerDay: 1_000_000 },
  openrouter: { requestsPerDay: 50, requestsPerMinute: 20 },
  cohere: { requestsPerDay: 33, requestsPerMinute: 10 },
  mistral: { tokensPerDay: 1_000_000_000 },
  deepseek: { requestsPerDay: 1_000, tokensPerDay: 1_000_000 },
  // LM Studio is local; quotas are effectively host-bound.
  lmstudio: {},
  ollama: {},
};

/**
 * @deprecated Use {@link DEFAULT_PROVIDER_LIMITS} or a ledger's resolved limits.
 * Kept as an alias so existing imports keep working while policy.json overrides
 * become the source of truth.
 */
export const PROVIDER_LIMITS = DEFAULT_PROVIDER_LIMITS;

/**
 * Paid-equivalent reference pricing (USD per 1M tokens, blended in/out) for the
 * model class each free provider serves. Used to compute "provable savings":
 * tokens served for $0 on a free tier are valued at what an equivalent paid API
 * would have charged. These are deliberately conservative public list-price
 * anchors (2025/2026), not promises — savings are an estimate, labelled as such.
 */
export const PAID_EQUIVALENT_USD_PER_MTOK: Record<ProviderId, number> = {
  // ~Llama-3.3-70B / GPT-4o-mini class
  cerebras: 0.6,
  groq: 0.6,
  // Gemini 1.5/2.0 Flash class
  gemini: 0.3,
  fireworks: 0.6,
  // Grok mini class
  xai: 0.5,
  huggingface: 0.5,
  openrouter: 0.6,
  cohere: 0.5,
  mistral: 0.4,
  deepseek: 0.5,
  // Local models have no paid-API equivalent cost.
  lmstudio: 0,
  ollama: 0,
};

/** Merge policy.json limit overrides on top of the built-in defaults. */
export function resolveLimits(
  overrides?: Partial<Record<ProviderId, PolicyLimits>>,
): Record<ProviderId, ProviderLimits> {
  if (!overrides) {
    return DEFAULT_PROVIDER_LIMITS;
  }
  const merged = {} as Record<ProviderId, ProviderLimits>;
  for (const id of Object.keys(DEFAULT_PROVIDER_LIMITS) as ProviderId[]) {
    merged[id] = { ...DEFAULT_PROVIDER_LIMITS[id], ...(overrides[id] ?? {}) };
  }
  return merged;
}
