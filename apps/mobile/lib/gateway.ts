import type { ProviderId } from "@zintus/types";
import { getGatewayUrl } from "@/lib/chat";

const GATEWAY_TOKEN = process.env.EXPO_PUBLIC_GATEWAY_TOKEN?.trim() || "";

function gatewayAuthHeaders(): Record<string, string> {
  return GATEWAY_TOKEN ? { Authorization: `Bearer ${GATEWAY_TOKEN}` } : {};
}

export interface GatewayProviderStatus {
  id: ProviderId;
  available: boolean;
  hasKey: boolean;
  inCooldown?: boolean;
  quotaUsed?: number;
  quotaLimit?: number;
}

export interface GatewaySavings {
  estimatedUsdSaved: number;
  byProvider: Record<string, number>;
  note?: string;
}

export interface GatewayHealth {
  ok: boolean;
  providers: GatewayProviderStatus[];
  savings?: GatewaySavings;
}

/**
 * Fetch the gateway `/health` snapshot. Returns `null` when the gateway is
 * unreachable or returns a non-OK status, so callers can fall back to the
 * local expo-sqlite quota store while offline.
 */
export async function fetchGatewayHealth(
  signal?: AbortSignal,
): Promise<GatewayHealth | null> {
  try {
    const response = await fetch(`${getGatewayUrl()}/health`, {
      headers: { ...gatewayAuthHeaders() },
      signal,
    });
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as GatewayHealth;
  } catch {
    return null;
  }
}
