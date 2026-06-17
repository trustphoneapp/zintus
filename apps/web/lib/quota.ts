export interface GatewayQuotaSnapshot {
  hasKey: boolean;
  available: boolean;
  quotaUsed?: number | null;
  quotaLimit?: number | null;
}

export function getRemainingQuotaPercent(snapshot: GatewayQuotaSnapshot): number | null {
  if (!snapshot.hasKey || !snapshot.available) {
    return 0;
  }

  if (typeof snapshot.quotaLimit !== "number" || snapshot.quotaLimit <= 0) {
    return null;
  }

  const used = typeof snapshot.quotaUsed === "number" && snapshot.quotaUsed > 0
    ? snapshot.quotaUsed
    : 0;
  const remaining = ((snapshot.quotaLimit - used) / snapshot.quotaLimit) * 100;

  return Math.max(0, Math.min(100, Math.round(remaining)));
}
