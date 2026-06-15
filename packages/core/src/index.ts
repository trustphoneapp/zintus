import type { AppConfig, ProviderId, ProviderStatus } from "@multipleai/types";
import { listProviders } from "@multipleai/providers";
import { createRouter, type Router } from "@multipleai/router";

export type { AppConfig, RoutingStrategy, ProviderStatus } from "@multipleai/types";
export { DEFAULT_CONFIG } from "@multipleai/types";

export interface ProviderInfo {
  id: ProviderId;
  name: string;
  color: string;
  quotaLimit: number;
  quotaUsed: number;
  enabled: boolean;
  hasKey: boolean;
  priority: number;
  inCooldown: boolean;
}

export const PROVIDER_META = Object.fromEntries(
  listProviders().map((p) => [
    p.id,
    { name: p.name, quotaLimit: 1_000_000, color: p.color, priority: p.priority },
  ]),
) as Record<
  ProviderId,
  { name: string; quotaLimit: number; color: string; priority: number }
>;

function statusToInfo(status: ProviderStatus): ProviderInfo {
  const meta = PROVIDER_META[status.id];
  return {
    id: status.id,
    name: status.name,
    color: status.color,
    quotaLimit: status.tokensLimit ?? meta.quotaLimit,
    quotaUsed: status.tokensToday,
    enabled: status.available,
    hasKey: status.hasKey,
    priority: status.priority,
    inCooldown: status.inCooldown,
  };
}

export function createAppRouter(config: AppConfig): Router {
  return createRouter({
    strategy: config.routingStrategy,
  });
}

export async function getProviderInfos(
  router: Router = createRouter(),
): Promise<ProviderInfo[]> {
  const statuses = await router.getProviderStatus();
  return statuses.map(statusToInfo).sort((a, b) => a.priority - b.priority);
}

export { createRouter, QuotaLedger, type Router } from "@multipleai/router";
export { listProviders, createProvider } from "@multipleai/providers";
