import { listProviders } from "@zintus/providers";
import type { ProviderId } from "@zintus/types";
import { fetchGatewayHealth, type GatewaySavings } from "./gateway";

export interface DesktopProviderInfo {
  id: ProviderId;
  name: string;
  color: string;
  /** Real quota ceiling from the gateway, or null when it reports none — NEVER a
   *  fabricated denominator (the UI shows "limit unknown" instead of a fake %). */
  quotaLimit: number | null;
  quotaUsed: number;
  enabled: boolean;
  hasKey: boolean;
  priority: number;
  inCooldown: boolean;
}

const providerMeta = Object.fromEntries(
  listProviders().map((p) => [
    p.id,
    { name: p.name, color: p.color, priority: p.priority },
  ]),
) as Record<ProviderId, { name: string; color: string; priority: number }>;

/**
 * Provider status for the desktop UI comes exclusively from the gateway's
 * `/health` endpoint — the gateway owns the quota ledger, keychain, and cooldown
 * state (bun:sqlite). The desktop is a static webview and deliberately does not
 * run a parallel router; when the gateway is down every provider is reported as
 * unavailable rather than falling back to a divergent local view.
 */
function buildProviderInfos(
  health: Awaited<ReturnType<typeof fetchGatewayHealth>>,
): DesktopProviderInfo[] {
  const statuses = new Map(health?.health.providers.map((p) => [p.id, p]));

  return listProviders()
    .map((provider) => {
      const meta = providerMeta[provider.id];
      const status = statuses.get(provider.id);
      return {
        id: provider.id,
        name: meta.name,
        color: meta.color,
        priority: meta.priority,
        quotaLimit: status?.quotaLimit ?? null,
        quotaUsed: status?.quotaUsed ?? 0,
        enabled: status?.available ?? false,
        hasKey: status?.hasKey ?? false,
        inCooldown: status?.inCooldown ?? false,
      };
    })
    .sort((a, b) => a.priority - b.priority);
}

export async function fetchProviderInfos(): Promise<DesktopProviderInfo[]> {
  const gatewayHealth = await fetchGatewayHealth();
  return buildProviderInfos(gatewayHealth);
}

/**
 * Single gateway round-trip that returns provider status plus the savings
 * estimate from `/health`, so the usage screen can show both without a second
 * fetch (savings live alongside providers in the same payload).
 */
export async function fetchProviderSnapshot(): Promise<{
  providers: DesktopProviderInfo[];
  savings: GatewaySavings | null;
}> {
  const gatewayHealth = await fetchGatewayHealth();
  return {
    providers: buildProviderInfos(gatewayHealth),
    savings: gatewayHealth?.health.savings ?? null,
  };
}
