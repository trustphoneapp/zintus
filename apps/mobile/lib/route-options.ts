import type { ProviderId } from "@zintus/types";

import { getGatewayUrl } from "@/lib/chat";

// Mirrors EXPO_PUBLIC_GATEWAY_TOKEN bearer auth used by chat.ts / gateway.ts.
const GATEWAY_TOKEN = process.env.EXPO_PUBLIC_GATEWAY_TOKEN?.trim() || "";

function gatewayAuthHeaders(): Record<string, string> {
  return GATEWAY_TOKEN ? { Authorization: `Bearer ${GATEWAY_TOKEN}` } : {};
}

/**
 * The four BYOK-only actions the gateway's quota-exhaustion decision API can
 * recommend. There is intentionally NO paid/credits/overflow option — Zintus
 * never takes key custody or bills (MANAGED_KEYS_AVAILABLE=false).
 */
export type RouteOption =
  | "compress_harder"
  | "switch_provider"
  | "use_local"
  | "wait";

export interface RouteAlternative {
  provider: ProviderId;
  model: string;
  estInputPer1M: number;
  estOutputPer1M: number;
}

/**
 * Response of `GET /v1/route/options` — a LOCAL, BYOK-only decision API that
 * derives, from gateway-side quota/runtime state ONLY, what the UI should do
 * when a provider's free-tier quota runs low. Every field is derived; no keys,
 * prompt content, or secrets pass through it.
 */
export interface RouteOptions {
  provider: ProviderId;
  /** 0..1 remaining free-tier budget, or null when genuinely unknown. */
  quotaRemaining: number | null;
  /** Seconds until the provider's cooldown clears, or null when unknown. */
  resetIn: number | null;
  resetReason?: string;
  best: RouteOption;
  options: RouteOption[];
  reason: string;
  alternatives: RouteAlternative[];
  localAvailable: boolean;
}

/** UI labels + one-line rationale for each BYOK action, for action chips. */
export const ROUTE_OPTION_META: Record<
  RouteOption,
  { label: string; hint: string }
> = {
  compress_harder: {
    label: "Compress harder",
    hint: "Squeeze more out of the remaining free-tier budget with compression.",
  },
  switch_provider: {
    label: "Switch provider",
    hint: "Route to another healthy provider you hold a key for.",
  },
  use_local: {
    label: "Use local",
    hint: "Run on a local Ollama / LM Studio model at no API cost.",
  },
  wait: {
    label: "Wait for reset",
    hint: "No healthy alternative — let the quota recover.",
  },
};

/**
 * Fetch the gateway's quota-exhaustion decision for a provider. Returns null
 * when the gateway is unreachable / unauthorized / returns a non-OK status, so
 * the footer simply omits the quota strip rather than fabricating values.
 *
 * @param quotaHint optional client-side 0..1 estimate; the gateway prefers its
 *   own ledger value when the provider is keyed and ignores out-of-range hints.
 */
export async function fetchRouteOptions(
  provider: ProviderId,
  quotaHint?: number,
  signal?: AbortSignal,
): Promise<RouteOptions | null> {
  const url = new URL(`${getGatewayUrl()}/v1/route/options`);
  url.searchParams.set("provider", provider);
  if (
    quotaHint != null &&
    Number.isFinite(quotaHint) &&
    quotaHint >= 0 &&
    quotaHint <= 1
  ) {
    url.searchParams.set("quota", String(quotaHint));
  }

  try {
    const response = await fetch(url.toString(), {
      headers: { ...gatewayAuthHeaders() },
      signal,
    });
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as RouteOptions;
  } catch {
    return null;
  }
}

/** True when the gateway flags this provider's quota as low enough to act on. */
export function isQuotaLow(options: RouteOptions | null): boolean {
  if (!options) {
    return false;
  }
  // The gateway recommends compress_harder when healthy; anything else (or a
  // quotaRemaining at/below the low threshold) means the user should consider
  // acting. We surface actions whenever `best` is not the healthy default.
  return options.best !== "compress_harder" || (options.quotaRemaining ?? 1) <= 0.2;
}
