import type { Provider, ProviderId, RoutingStrategy } from "@multipleai/types";

/** Lower rank = higher model capability (used by `capability` strategy). */
const CAPABILITY_RANK: Record<ProviderId, number> = {
  gemini: 1,
  openrouter: 2,
  fireworks: 3,
  xai: 4,
  deepseek: 5,
  mistral: 6,
  huggingface: 7,
  cohere: 8,
  cerebras: 9,
  groq: 10,
  lmstudio: 98,
  ollama: 99,
};

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

export interface SortContext {
  remainingRatio: (id: Provider["id"]) => number;
  providerPriority?: ProviderId[];
  /** p95 latency (ms) over recent successes, or null when not enough samples. */
  latencyP95?: (id: Provider["id"]) => number | null;
}

export function sortProviders(
  providers: Provider[],
  strategy: RoutingStrategy,
  ctx: SortContext,
): Provider[] {
  const { remainingRatio, providerPriority, latencyP95 } = ctx;
  switch (strategy) {
    case "economy":
      return [...providers].sort(
        (a, b) =>
          remainingRatio(b.id) - remainingRatio(a.id) ||
          byUserPriority(a, b, providerPriority),
      );
    case "capability":
      return [...providers].sort(
        (a, b) =>
          CAPABILITY_RANK[a.id] - CAPABILITY_RANK[b.id] ||
          byUserPriority(a, b, providerPriority),
      );
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
