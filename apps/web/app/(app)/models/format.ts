import type { CSSProperties } from "react";
import { PROVIDER_METADATA } from "@zintus/providers";
import type { ProviderId } from "@zintus/types";
import type {
  CatalogDataPolicyBadge,
  CatalogModelDto,
  CatalogStructuredOutput,
} from "@/lib/gateway";

// Reverse lookup: the catalog DTO carries `owned_by` (the provider's DISPLAY
// name, e.g. "Gemini"), not the raw provider id. The gateway derived it from
// `PROVIDER_METADATA[id].name`, so we invert that exact map to recover the id
// needed by `setSelectedProvider`. Falls back to a normalized match (and finally
// null) so an unknown owner never crashes the "Use this model" action.
const NAME_TO_PROVIDER_ID = new Map<string, ProviderId>(
  (Object.entries(PROVIDER_METADATA) as Array<[ProviderId, { name: string }]>)
    .flatMap(([id, meta]) => [
      [meta.name.toLowerCase(), id] as const,
      [id.toLowerCase(), id] as const,
    ]),
);

/** Recover the `ProviderId` for a catalog model from its `owned_by` display name. */
export function resolveProviderId(ownedBy: string): ProviderId | null {
  return NAME_TO_PROVIDER_ID.get(ownedBy.trim().toLowerCase()) ?? null;
}

/** localStorage key the chat composer reads to preselect a catalog model. */
export const SELECTED_MODEL_KEY = "zintus:selected-model";

/** What we persist when the user clicks "Use this model". */
export interface SelectedModel {
  id: string;
  provider: string;
  displayName: string;
}

/** Compact context-window label, e.g. 1_000_000 → "1M", 128_000 → "128K".
 *  Mirrors the providers page's `formatContext`. */
export function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}

/** USD-per-1M figure → "$0.30" / "$15". `null` is the caller's concern. */
function usd(value: number): string {
  if (value === 0) return "$0";
  if (value < 1) return `$${value.toFixed(2)}`;
  return `$${Number.isInteger(value) ? value : value.toFixed(2)}`;
}

export interface PriceLabel {
  /** Headline word/figure: "Free", "Local", "price unknown", or input price. */
  headline: string;
  /** Optional second line, e.g. "$0.30 in · $2.50 out / 1M". */
  detail?: string;
  /** Visual tone for the headline. */
  tone: "free" | "local" | "unknown" | "priced";
}

/**
 * Honest price label for a catalog model. NEVER renders $0 for an unknown price:
 * a `null` on either side of `pricing` collapses to "price unknown". "Free" is
 * shown only when `free === true`; "Local" only when `local === true`.
 */
export function priceLabel(model: CatalogModelDto): PriceLabel {
  if (model.free) {
    return { headline: "Free", tone: "free" };
  }
  if (model.local) {
    return { headline: "Local", tone: "local" };
  }
  const { input_per_1m, output_per_1m } = model.pricing;
  if (input_per_1m == null || output_per_1m == null) {
    return { headline: "price unknown", tone: "unknown" };
  }
  return {
    headline: `${usd(input_per_1m)} / 1M in`,
    detail: `${usd(input_per_1m)} in · ${usd(output_per_1m)} out / 1M`,
    tone: "priced",
  };
}

/** Sort key for price; models without a concrete input price sort last. */
export function priceSortKey(model: CatalogModelDto): number {
  if (model.free) return 0;
  const v = model.pricing.input_per_1m;
  return v == null ? Number.POSITIVE_INFINITY : v;
}

/** True when the model can produce JSON / structured output of any kind. */
export function supportsJson(level: CatalogStructuredOutput): boolean {
  return level !== "none";
}

export function structuredOutputLabel(level: CatalogStructuredOutput): string {
  switch (level) {
    case "json_schema":
      return "Schema-constrained (guaranteed)";
    case "json_object":
      return "JSON mode";
    default:
      return "No native structured output";
  }
}

/**
 * Honest, MEASURED per-provider performance attached to each `/v1/models` entry
 * (`stats` block on the gateway response). Each metric is `null` until the
 * provider has enough recent samples to publish a truthful value — we NEVER
 * fabricate a 0 ms / 100% for an unmeasured provider. `samples` is the raw
 * attempt count behind the numbers.
 *   - `latency_p95_ms` — p95 latency in milliseconds over a recent window
 *   - `throughput_tps` — output tokens/sec
 *   - `uptime`         — success rate in 0..1
 */
export interface CatalogModelStats {
  latency_p95_ms: number | null;
  throughput_tps: number | null;
  uptime: number | null;
  samples: number;
}

/**
 * Read the measured `stats` block off a catalog model defensively. The gateway
 * adds it to every `/v1/models` entry, but it may be absent on an older gateway —
 * `null` then, so the UI shows "no data yet" rather than guessing. Each metric is
 * coerced to a real number or `null` (never a fabricated default).
 */
export function modelStats(model: CatalogModelDto): CatalogModelStats | null {
  const raw = (model as { stats?: Partial<CatalogModelStats> | null }).stats;
  if (!raw || typeof raw !== "object") return null;
  return {
    latency_p95_ms:
      typeof raw.latency_p95_ms === "number" ? raw.latency_p95_ms : null,
    throughput_tps:
      typeof raw.throughput_tps === "number" ? raw.throughput_tps : null,
    uptime: typeof raw.uptime === "number" ? raw.uptime : null,
    samples: typeof raw.samples === "number" ? raw.samples : 0,
  };
}

/** True when at least one metric has been measured (so the row is worth showing). */
export function hasMeasuredStats(stats: CatalogModelStats | null): boolean {
  return (
    stats != null &&
    (stats.latency_p95_ms != null ||
      stats.throughput_tps != null ||
      stats.uptime != null)
  );
}

/** p95 latency → "320 ms"; `null` (insufficient samples) → "—". Never a fake 0. */
export function formatLatencyMs(value: number | null): string {
  return value == null ? "—" : `${Math.round(value)} ms`;
}

/** Throughput → "45.5 tok/s" / "120 tok/s"; `null` → "—". */
export function formatThroughputTps(value: number | null): string {
  if (value == null) return "—";
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} tok/s`;
}

/** Uptime (success rate 0..1) → "99%" / "99.5%"; `null` → "—". Never a fake 100%. */
export function formatUptime(value: number | null): string {
  if (value == null) return "—";
  const pct = Math.round(value * 1000) / 10;
  return `${Number.isInteger(pct) ? pct : pct.toFixed(1)}%`;
}

export const DATA_POLICY_LABEL: Record<CatalogDataPolicyBadge, string> = {
  "no-training": "🟢 No training",
  trains: "🔴 May train",
  zdr: "🔵 Zero retention",
  unknown: "⚪ Policy unknown",
};

// Capability-chip styles — reuse the providers page's CAP_ON / CAP_OFF vocabulary
// (green when supported, dim when not) so the two surfaces read identically.
export const CAP_ON: CSSProperties = {
  color: "var(--color-green)",
  border: "1px solid color-mix(in oklch, var(--color-green) 35%, transparent)",
  background: "color-mix(in oklch, var(--color-green) 12%, transparent)",
};
export const CAP_OFF: CSSProperties = {
  color: "var(--color-text-muted)",
  border: "1px solid var(--c-border)",
  background: "transparent",
  opacity: 0.6,
};
export const CAP_CTX: CSSProperties = {
  color: "var(--color-text-sub)",
  border: "1px solid var(--c-border)",
  background: "transparent",
};
