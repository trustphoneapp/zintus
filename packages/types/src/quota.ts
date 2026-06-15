import type { ProviderId } from "./provider.js";

export type QuotaWindow = "fixed" | "rolling";

export interface QuotaEntry {
  providerId: ProviderId;
  remaining: number;
  limit: number;
  resetAt: Date;
  window: QuotaWindow;
}
