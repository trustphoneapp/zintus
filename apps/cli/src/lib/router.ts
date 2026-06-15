import { createEngine, type Engine } from "@multipleai/engine";
import { listProviders } from "@multipleai/providers";
import type { AppConfig, ProviderId, ProviderStatus } from "@multipleai/types";
import { getDbPath } from "../db.js";

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

export function createAppEngine(config: AppConfig): Engine {
  return createEngine({
    strategy: config.routingStrategy,
    providerPriority: config.providerPriority,
    defaultProvider: config.defaultProvider,
    dbPath: getDbPath(),
  });
}

/** @deprecated Use createAppEngine */
export const createAppRouter = createAppEngine;

export async function getProviderInfos(engine: Engine): Promise<ProviderInfo[]> {
  const statuses = await engine.getProviderStatus();
  return statuses.map(statusToInfo).sort((a, b) => a.priority - b.priority);
}
