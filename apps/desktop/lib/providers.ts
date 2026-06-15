import { listProviders } from "@multipleai/providers";
import type { ProviderId } from "@multipleai/types";
import { getProviderStatus } from "./router";

export interface DesktopProviderInfo {
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

const providerMeta = Object.fromEntries(
  listProviders().map((p) => [
    p.id,
    {
      name: p.name,
      color: p.color,
      priority: p.priority,
      quotaLimit: 1_000_000,
    },
  ]),
) as Record<
  ProviderId,
  { name: string; color: string; priority: number; quotaLimit: number }
>;

export async function fetchProviderInfos(): Promise<DesktopProviderInfo[]> {
  const statuses = await getProviderStatus();

  return statuses
    .map((status) => {
      const meta = providerMeta[status.id];
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
    })
    .sort((a, b) => a.priority - b.priority);
}
