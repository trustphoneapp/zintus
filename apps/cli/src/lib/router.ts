import { createEngine, type Engine } from "@zintus/engine";
import { listProviders } from "@zintus/providers";
import type { AppConfig, ProviderId, ProviderStatus } from "@zintus/types";
import { getDbPath } from "../db.js";

export interface ProviderInfo {
  id: ProviderId;
  name: string;
  color: string;
  /**
   * Provider's daily free-tier token cap, or `null` when the engine reports no
   * denominator. HONESTY: never fabricate a limit (the audit flagged the old
   * `1_000_000` placeholder) — `null` means "unknown" and the UI renders it as
   * such rather than against a made-up ceiling.
   */
  quotaLimit: number | null;
  quotaUsed: number;
  enabled: boolean;
  hasKey: boolean;
  priority: number;
  inCooldown: boolean;
}

export const PROVIDER_META = Object.fromEntries(
  listProviders().map((p) => [
    p.id,
    { name: p.name, color: p.color, priority: p.priority },
  ]),
) as Record<ProviderId, { name: string; color: string; priority: number }>;

function statusToInfo(status: ProviderStatus): ProviderInfo {
  return {
    id: status.id,
    name: status.name,
    color: status.color,
    // The engine's reported daily cap, or null when unknown — no fabrication.
    quotaLimit: status.tokensLimit ?? null,
    quotaUsed: status.tokensToday,
    enabled: status.available,
    hasKey: status.hasKey,
    priority: status.priority,
    inCooldown: status.inCooldown,
  };
}

export function createAppEngine(
  config: AppConfig,
  options?: { workspaceDir?: string },
): Engine {
  return createEngine({
    strategy: config.routingStrategy,
    providerPriority: config.providerPriority,
    defaultProvider: config.defaultProvider,
    dbPath: getDbPath(),
    workspaceDir: options?.workspaceDir,
  });
}

/** @deprecated Use createAppEngine */
export const createAppRouter = createAppEngine;

export async function getProviderInfos(engine: Engine): Promise<ProviderInfo[]> {
  const statuses = await engine.getProviderStatus();
  return statuses.map(statusToInfo).sort((a, b) => a.priority - b.priority);
}
