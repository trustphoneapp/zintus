import type { ProviderId } from "./provider-id.js";

export interface ProviderStatus {
  id: ProviderId;
  name: string;
  color: string;
  priority: number;
  available: boolean;
  hasKey: boolean;
  inCooldown: boolean;
  cooldownUntil: Date | null;
  requestsToday: number;
  tokensToday: number;
  lastReset: Date | null;
  requestsLimit?: number;
  tokensLimit?: number;
}
