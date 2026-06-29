import { GATEWAY_URL, gatewayAuthHeaders } from "@/lib/gateway";

/**
 * One durable `/v1/activity` row — the gateway's 30-day store (bun:sqlite,
 * ~/.zintus/activity.db), NOT the in-memory trace ring. Honest by construction:
 * token counts / latency / route_reason are the REAL recorded values, cost is $0
 * on the free tier, and `route_reason` is absent when the turn never recorded one
 * (mirrors the gateway's activity-store.ts entry shape).
 */
export interface ActivityEntry {
  id: string;
  created: number;
  created_at: string;
  provider: string | null;
  model: string | null;
  tokens: { input: number; output: number; total: number };
  cost_usd: number;
  saved_vs_baseline_usd: number;
  latency_ms: number | null;
  cache_hit: boolean;
  route_reason?: string;
}

export interface ActivityFeed {
  data: ActivityEntry[];
  /** Server's retention window (days); null when the gateway didn't report it. */
  retentionDays: number | null;
  hasMore: boolean;
}

/** Default retention window shown before the gateway reports its own. */
export const DEFAULT_RETENTION_DAYS = 30;

/**
 * Normalize a raw `/v1/activity` JSON body into an {@link ActivityFeed}. Pure
 * (no I/O) so it is unit-testable: tolerates a missing `data`/`retention_days`/
 * `has_more` (older gateways, or the in-memory fallback path that omits the
 * durable-only fields) without throwing or fabricating values.
 */
export function parseActivityFeed(body: unknown): ActivityFeed {
  const obj = (body ?? {}) as {
    data?: ActivityEntry[];
    retention_days?: number;
    has_more?: boolean;
  };
  return {
    data: Array.isArray(obj.data) ? obj.data : [],
    retentionDays:
      typeof obj.retention_days === "number" ? obj.retention_days : null,
    hasMore: Boolean(obj.has_more),
  };
}

/**
 * Fetch the gateway's DURABLE activity feed (`GET /v1/activity`). Returns `null`
 * on any network/HTTP error so the page can render an honest empty/offline state
 * instead of throwing. Inlined here (not lib/gateway) to keep the usage-page
 * change self-contained.
 */
export async function fetchGatewayActivity(
  limit = 50,
): Promise<ActivityFeed | null> {
  try {
    const response = await fetch(`${GATEWAY_URL}/v1/activity?limit=${limit}`, {
      cache: "no-store",
      headers: { ...gatewayAuthHeaders() },
    });
    if (!response.ok) {
      return null;
    }
    return parseActivityFeed(await response.json());
  } catch {
    return null;
  }
}
