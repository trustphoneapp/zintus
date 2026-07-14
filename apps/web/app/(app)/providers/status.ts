/**
 * Pure status derivation for the Provider Control Center cards.
 *
 * Kept free of React/CSS so the honesty rules are unit-tested directly: a status
 * is only "Connected"/"Running" on real signals, "Quota exhausted" ONLY when the
 * gateway reports a real denominator (`quotaLimit > 0`) that has been reached —
 * never fabricated from a missing/zero limit — and local runtimes are "unknown"
 * (not silently "running") when the gateway is offline and can't probe them.
 */

export type ProviderStatusKey =
  | "connected"
  | "needs-key"
  | "cooldown"
  | "exhausted"
  | "unavailable"
  | "local-running"
  | "local-stopped"
  | "local-unknown";

/** Color token (mapped to a CSS var by the card) — kept stylesheet-agnostic. */
export type ProviderStatusTone = "green" | "warn" | "danger" | "muted";

/** Icon name (subset of `Icons.tsx`) used for the status pill. */
export type ProviderStatusIcon = "check" | "plus" | "refresh" | "zap" | "x";

export interface ProviderStatusInput {
  /** Ollama / LM Studio — no API key, no quota, detected locally. */
  isLocal: boolean;
  /** Whether the loopback gateway answered `/v1/status` this poll. */
  gatewayConnected: boolean;
  hasKey: boolean;
  available: boolean;
  inCooldown: boolean;
  /** Raw gateway figures — both required to assert "exhausted". */
  quotaUsed?: number;
  quotaLimit?: number;
}

export interface ProviderStatusDescriptor {
  key: ProviderStatusKey;
  label: string;
  tone: ProviderStatusTone;
  icon: ProviderStatusIcon;
}

/**
 * Map a normalized provider row to its honest status descriptor. The ordering of
 * the cloud branch is deliberate: a missing key beats cooldown beats a *proven*
 * quota exhaustion beats availability — an unkeyed provider never reads
 * "exhausted", and a provider with no quota denominator never does either.
 */
export function deriveProviderStatus(
  input: ProviderStatusInput,
): ProviderStatusDescriptor {
  if (input.isLocal) {
    if (!input.gatewayConnected) {
      return {
        key: "local-unknown",
        label: "Detection needs gateway",
        tone: "muted",
        icon: "x",
      };
    }
    if (input.available) {
      return { key: "local-running", label: "Running", tone: "green", icon: "check" };
    }
    return {
      key: "local-stopped",
      label: "Not running",
      tone: "muted",
      icon: "x",
    };
  }

  if (!input.hasKey) {
    return { key: "needs-key", label: "Needs key", tone: "muted", icon: "plus" };
  }
  if (input.inCooldown) {
    return { key: "cooldown", label: "In cooldown", tone: "warn", icon: "refresh" };
  }
  const hasDenominator =
    typeof input.quotaLimit === "number" && input.quotaLimit > 0;
  const used = typeof input.quotaUsed === "number" ? input.quotaUsed : 0;
  if (hasDenominator && used >= (input.quotaLimit as number)) {
    return { key: "exhausted", label: "Quota exhausted", tone: "danger", icon: "zap" };
  }
  if (input.available) {
    return { key: "connected", label: "Connected", tone: "green", icon: "check" };
  }
  return { key: "unavailable", label: "Unavailable", tone: "danger", icon: "x" };
}

/** A problem status warrants the route-options "why / best next action" advisor. */
export function statusNeedsAdvice(key: ProviderStatusKey): boolean {
  return key === "cooldown" || key === "exhausted" || key === "unavailable";
}

/** Raw per-provider signals from the gateway poll + browser key vault — the
 *  same shapes as `GatewayProviderStatus` (lib/gateway.ts) and
 *  `WebProviderStatus` (lib/store.ts), kept structural here so this module
 *  stays free of React/store imports. */
export interface RawProviderSignals {
  isLocal: boolean;
  gatewayConnected: boolean;
  gateway?: {
    available: boolean;
    hasKey: boolean;
    inCooldown?: boolean;
    quotaUsed?: number;
    quotaLimit?: number;
  };
  vault?: { hasKey: boolean; enabled: boolean };
}

/**
 * Normalize raw gateway + vault signals into a `ProviderStatusInput`. This is
 * the ONE place "does this provider have a usable key / is it available" is
 * computed — the Providers page and the chat composer's pinned-provider
 * notice both call it so a provider is never independently re-judged.
 */
export function resolveProviderStatusInput(
  signals: RawProviderSignals,
): ProviderStatusInput {
  const { isLocal, gatewayConnected, gateway, vault } = signals;
  const gatewayHasKey = Boolean(gateway?.hasKey);
  const vaultHasKey = Boolean(vault?.hasKey);
  // A key is "configured" if the gateway holds it server-side OR the browser
  // vault holds it — vault keys are sent per-request to the loopback gateway,
  // so a vault-only key is just as usable as a server-side one.
  const hasKey = gatewayHasKey || vaultHasKey || isLocal;
  const available = gatewayConnected
    ? Boolean(gateway?.available) || vaultHasKey
    : Boolean(vault?.enabled);
  const inCooldown = gatewayConnected ? Boolean(gateway?.inCooldown) : false;
  // The gateway only tracks quota for keys IT holds. A vault-only key's quota
  // is unknown to the gateway, so leave the raw figures undefined → "—".
  const gatewayTracksQuota = gatewayConnected && gatewayHasKey;
  const quotaUsed = gatewayTracksQuota ? gateway?.quotaUsed : undefined;
  const quotaLimit = gatewayTracksQuota ? gateway?.quotaLimit : undefined;
  return { isLocal, gatewayConnected, hasKey, available, inCooldown, quotaUsed, quotaLimit };
}
