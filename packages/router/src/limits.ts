import type { ProviderId } from "@multipleai/types";

export interface ProviderLimits {
  requestsPerDay?: number;
  tokensPerDay?: number;
  rollingWindow?: boolean;
}

/** Groq 70B tier — falls back to 8B model when exhausted (same API key). */
export const GROQ_MODEL_70B = "llama-3.3-70b-versatile";
export const GROQ_MODEL_8B = "llama-3.1-8b-instant";

export const GROQ_TIER_LIMITS = {
  [GROQ_MODEL_70B]: { requestsPerDay: 1_000, tokensPerDay: 100_000 },
  [GROQ_MODEL_8B]: { requestsPerDay: 14_400, tokensPerDay: 500_000 },
} as const;

export const PROVIDER_LIMITS: Record<ProviderId, ProviderLimits> = {
  cerebras: { tokensPerDay: 1_000_000 },
  groq: {
    requestsPerDay: 1_000,
    tokensPerDay: 100_000,
    rollingWindow: true,
  },
  gemini: { requestsPerDay: 1_500 },
  openrouter: { requestsPerDay: 50 },
  cohere: { requestsPerDay: 33 },
  mistral: { tokensPerDay: 1_000_000_000 },
  deepseek: { requestsPerDay: 1_000, tokensPerDay: 1_000_000 },
  ollama: {},
};
