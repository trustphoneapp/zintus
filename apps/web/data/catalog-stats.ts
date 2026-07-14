// Catalog summary stats. Numeric counts are DERIVED from the PROVIDERS and MODELS
// arrays so the headline strip can never drift from the data it summarizes.
// Only the descriptive string fields are authored.

import { PROVIDERS, MODELS, isRoutableProvider, isRoutableModel } from "./providers";

export interface CatalogStats {
  totalProviders: number;
  totalModels: number;
  freeModels: number;
  integratedProviders: number;
  /** Providers the router can reach today (the closed ProviderId union). */
  routableProviders: number;
  /** Providers listed for transparency but not yet routable ("coming-soon"). */
  plannedProviders: number;
  /** Models routable today (provider in ROUTABLE_PROVIDER_IDS). */
  routableModels: number;
  /** Models listed but "Planned — not yet routable". */
  plannedModels: number;
  directProviders: number;
  metaProviders: number;
  localProviders: number;
  cloudProviders: number;
  /** Routable providers (tier "direct") that also expose a no-key free tier —
   *  the number the marketing "free tier routes across N+ providers" copy
   *  must match. */
  freeTierRoutableProviders: number;
  /** Model count OpenRouter itself claims reachable via a single BYOK key
   *  (its own `models` field in PROVIDERS) — the "reach N+ models instantly"
   *  aggregator claim. */
  aggregatorModels: number;
  contextWindowMax: string;
  cheapestPaidModel: string;
  mostModelsProvider: string;
}

const openrouter = PROVIDERS.find((p) => p.id === "openrouter");

export const CATALOG_STATS: CatalogStats = {
  totalProviders: PROVIDERS.length,
  totalModels: MODELS.length,
  freeModels: MODELS.filter((m) => m.free).length,
  integratedProviders: PROVIDERS.filter((p) => p.badge === "integrated").length,
  routableProviders: PROVIDERS.filter((p) => isRoutableProvider(p.id)).length,
  plannedProviders: PROVIDERS.filter((p) => !isRoutableProvider(p.id)).length,
  routableModels: MODELS.filter((m) => isRoutableModel(m)).length,
  plannedModels: MODELS.filter((m) => !isRoutableModel(m)).length,
  directProviders: PROVIDERS.filter((p) => p.tier === "direct").length,
  metaProviders: PROVIDERS.filter((p) => p.tier === "meta").length,
  localProviders: PROVIDERS.filter((p) => p.tier === "local").length,
  cloudProviders: PROVIDERS.filter((p) => p.tier === "cloud").length,
  freeTierRoutableProviders: PROVIDERS.filter(
    (p) => p.freetier && isRoutableProvider(p.id),
  ).length,
  aggregatorModels: openrouter?.models ?? 0,
  // Descriptive fields — kept verbatim.
  contextWindowMax: "10M",
  cheapestPaidModel: "$0.04/M (Ministral 3B)",
  mostModelsProvider: "OpenRouter (400+ via key)",
};

/** Round down to the nearest `step` for a conservative "N+" marketing claim
 *  that stays true as the catalog grows (never overclaims). */
export function floorTo(value: number, step: number): number {
  return Math.floor(value / step) * step;
}
