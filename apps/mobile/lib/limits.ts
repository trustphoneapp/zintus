import type { ProviderId } from "@multipleai/types";

export const QUOTA_WARNING_THRESHOLD = 0.2;

export const VALIDATE_URL =
  process.env.EXPO_PUBLIC_VALIDATE_URL ?? "http://localhost:3000/api/validate";

export interface ProviderLimits {
  requestsPerDay?: number;
  tokensPerDay?: number;
  rollingWindow?: boolean;
}

/** Mirrors packages/router/src/limits.ts */
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

export interface ProviderQuotaRow {
  id: ProviderId;
  requestsToday: number;
  tokensToday: number;
  lastReset: number | null;
  cooldownUntil: number | null;
}
