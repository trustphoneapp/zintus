import type { Provider, ProviderId, RoutingStrategy } from "@multipleai/types";

/** Lower rank = higher model capability (used by `capability` strategy). */
const CAPABILITY_RANK: Record<ProviderId, number> = {
  gemini: 1,
  openrouter: 2,
  deepseek: 3,
  mistral: 4,
  cohere: 5,
  cerebras: 6,
  groq: 7,
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

export function sortProviders(
  providers: Provider[],
  strategy: RoutingStrategy,
  remainingRatio: (id: Provider["id"]) => number,
  providerPriority?: ProviderId[],
): Provider[] {
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
    default:
      return [...providers].sort((a, b) =>
        byUserPriority(a, b, providerPriority),
      );
  }
}
