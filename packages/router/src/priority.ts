import type { Provider, ProviderId, RoutingStrategy } from "@zintus/types";
import { providerCapabilityTier } from "@zintus/providers";

// Model-capability ranking now lives in the data-driven registry
// (`@zintus/providers` capabilities.ts) so vision/tools/json/contextWindow and
// the routing tier share one source of truth. `providerCapabilityTier` returns
// the same numbers the old inline CAPABILITY_RANK did (lower = preferred,
// unknown → 50), so routing order is unchanged.

function byUserPriority(
  a: Provider,
  b: Provider,
  providerPriority?: ProviderId[],
): number {
  if (!providerPriority?.length) {
    return a.priority - b.priority;
  }

  const rank = new Map(providerPriority.map((id, index) => [id, index]));
  const aRank = rank.get(a.id) ?? Number.MAX_SAFE_INTEGER;
  const bRank = rank.get(b.id) ?? Number.MAX_SAFE_INTEGER;
  return aRank - bRank || a.priority - b.priority;
}

/**
 * Latency assumed for a provider with too few recent samples to score. Chosen
 * so unmeasured providers are still explored (tried ahead of any provider known
 * to be slower than this), but measured-fast providers win. Their real latency
 * is recorded on first use and feeds subsequent decisions.
 */
export const UNKNOWN_LATENCY_MS = 1_000;

/**
 * Quota floor below which `economy` treats a provider as "running low" and
 * demotes it behind every provider that still has healthy quota — even cheaper
 * ones. This keeps economy from routing into a near-exhausted provider (and the
 * failover churn that follows) just because it is the cheapest paid-equivalent.
 */
export const LOW_QUOTA_FLOOR = 0.15;

export interface SortContext {
  remainingRatio: (id: Provider["id"]) => number;
  providerPriority?: ProviderId[];
  /** p95 latency (ms) over recent successes, or null when not enough samples. */
  latencyP95?: (id: Provider["id"]) => number | null;
  /**
   * Paid-equivalent cost (USD per 1M tokens) for the model class a provider
   * serves, used by `economy` to prefer the cheapest free model. When omitted,
   * `economy` falls back to ordering by remaining quota alone.
   */
  costPerMillion?: (id: Provider["id"]) => number;
}

export function sortProviders(
  providers: Provider[],
  strategy: RoutingStrategy,
  ctx: SortContext,
): Provider[] {
  const { remainingRatio, providerPriority, latencyP95, costPerMillion } = ctx;
  switch (strategy) {
    case "economy": {
      // "Cheapest free model that still has quota": rank by the cheapest
      // paid-equivalent cost first, but quota-aware — a provider whose remaining
      // quota has dropped below LOW_QUOTA_FLOOR is bucketed behind every
      // healthy provider so we don't route into a near-empty (about-to-fail)
      // provider just because it is cheap. Within a bucket: cheapest first, then
      // most quota remaining, then user priority. With no cost accessor this
      // degrades to pure remaining-quota ordering (back-compat).
      const cost = (id: Provider["id"]) => costPerMillion?.(id) ?? 0;
      const scarce = (id: Provider["id"]) =>
        remainingRatio(id) < LOW_QUOTA_FLOOR ? 1 : 0;
      return [...providers].sort(
        (a, b) =>
          scarce(a.id) - scarce(b.id) ||
          cost(a.id) - cost(b.id) ||
          remainingRatio(b.id) - remainingRatio(a.id) ||
          byUserPriority(a, b, providerPriority),
      );
    }
    case "capability":
      return [...providers].sort(
        (a, b) =>
          providerCapabilityTier(a.id) - providerCapabilityTier(b.id) ||
          byUserPriority(a, b, providerPriority),
      );
    case "quality": {
      // Largest context window first (proxied by capability rank DESC),
      // then lowest latency P95 as tie-break.
      const cap = (id: Provider["id"]) => providerCapabilityTier(id);
      const latScore = (id: Provider["id"]) =>
        latencyP95?.(id) ?? UNKNOWN_LATENCY_MS;
      return [...providers].sort(
        (a, b) =>
          cap(a.id) - cap(b.id) ||
          latScore(a.id) - latScore(b.id) ||
          byUserPriority(a, b, providerPriority),
      );
    }
    case "balanced": {
      // Weighted score: 40% capability, 30% economy (cost), 30% speed (latency).
      // All normalized to 0-1 range; lower score wins.
      const maxCap = Math.max(
        ...providers.map((p) => providerCapabilityTier(p.id)),
      );
      const costs = providers.map((p) => costPerMillion?.(p.id) ?? 0);
      const maxCost = Math.max(...costs, 1);
      const latencies = providers.map(
        (p) => latencyP95?.(p.id) ?? UNKNOWN_LATENCY_MS,
      );
      const maxLat = Math.max(...latencies, 1);

      const score = (p: Provider) => {
        const capNorm = providerCapabilityTier(p.id) / maxCap;
        const costNorm = (costPerMillion?.(p.id) ?? 0) / maxCost;
        const latNorm = (latencyP95?.(p.id) ?? UNKNOWN_LATENCY_MS) / maxLat;
        return 0.4 * capNorm + 0.3 * costNorm + 0.3 * latNorm;
      };

      return [...providers].sort(
        (a, b) =>
          score(a) - score(b) || byUserPriority(a, b, providerPriority),
      );
    }
    case "fastest":
    default: {
      // Real latency routing: order by lowest measured p95 over recent
      // successes. Falls back to configured priority order as a tie-break and
      // until enough samples exist to score a provider.
      const score = (id: Provider["id"]) =>
        latencyP95?.(id) ?? UNKNOWN_LATENCY_MS;
      return [...providers].sort(
        (a, b) =>
          score(a.id) - score(b.id) || byUserPriority(a, b, providerPriority),
      );
    }
  }
}
