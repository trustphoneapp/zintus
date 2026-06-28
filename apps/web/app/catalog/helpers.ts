import type { Model } from "@/data/providers";

/** Tier badge palette. FREE=green, T0=teal, T1=blue, T2=violet, BYOK=muted. */
export const TIER_COLORS: Record<Model["tier"], string> = {
  FREE: "#22C55E",
  T0: "#14B8A6",
  T1: "#3B82F6",
  T2: "#7C3AED",
  BYOK: "#94A3B8",
};

/** Parse a context-window label ("128K", "1M", "∞") into a sortable number. */
export function contextTokens(label: string): number {
  if (label === "∞") return Number.POSITIVE_INFINITY;
  const match = label.match(/^([\d.]+)\s*([KMB]?)/i);
  if (!match || match[1] === undefined) return 0;
  const value = parseFloat(match[1]);
  const unit = (match[2] ?? "").toUpperCase();
  const factor = unit === "B" ? 1e9 : unit === "M" ? 1e6 : unit === "K" ? 1e3 : 1;
  return value * factor;
}

/** Price sort key: a free model is 0; everything else is its input price. */
export function priceKey(model: Model): number {
  return model.free ? 0 : model.inputPer1M;
}

/** USD-per-1M figure → "$0.04" / "$15". */
export function usd(value: number): string {
  if (value === 0) return "$0";
  if (value < 1) return `$${value.toFixed(2)}`;
  return `$${Number.isInteger(value) ? value : value.toFixed(2)}`;
}
