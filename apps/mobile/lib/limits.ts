import type { ProviderId } from "@zintus/types";

// Provider limits and the limit type come from the single shared source of
// truth so mobile can never drift from the gateway/desktop. Do not redefine
// PROVIDER_LIMITS here.
export { PROVIDER_LIMITS } from "@zintus/router/limits";
export type { ProviderLimits } from "@zintus/router/limits";

export const QUOTA_WARNING_THRESHOLD = 0.2;

export const VALIDATE_URL =
  process.env.EXPO_PUBLIC_VALIDATE_URL ?? "http://localhost:3000/api/validate";

export interface ProviderQuotaRow {
  id: ProviderId;
  requestsToday: number;
  tokensToday: number;
  lastReset: number | null;
  cooldownUntil: number | null;
}
