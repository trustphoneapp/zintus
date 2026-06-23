import type {
  ProviderId,
  SearchEnv,
  SearchOptions,
  SearchResult,
  SearchStrategy,
} from "./types.js";
import { tavilySearch, SearchQuotaExceededError } from "./providers/tavily.js";
import { serperSearch } from "./providers/serper.js";

/** Map a provider to its web-search strategy. */
export function getSearchStrategy(provider: ProviderId | undefined): SearchStrategy {
  switch (provider) {
    case "groq":
      return "groq-compound";
    case "gemini":
      return "gemini-grounding";
    case "openrouter":
      return "openrouter-tool";
    // Providers with no native search → external fallback (Tavily → Serper).
    case "cerebras":
    case "mistral":
    case "deepseek":
    case "cohere":
    case "fireworks":
    case "xai":
    case "huggingface":
    case "lmstudio":
    case "ollama":
      return "tavily-fallback";
    default:
      // Unknown / auto-routed: fall back to external search.
      return "tavily-fallback";
  }
}

/** True when a strategy needs no external API key (native, free). */
export function isNativeStrategy(strategy: SearchStrategy): boolean {
  return (
    strategy === "groq-compound" ||
    strategy === "gemini-grounding" ||
    strategy === "openrouter-tool"
  );
}

export interface FallbackSearchOutcome {
  results: SearchResult[];
  /** Which external provider actually served the results. */
  servedBy: "tavily" | "serper" | "none";
}

/**
 * Run an external fallback search: Tavily first, automatically failing over to
 * Serper when Tavily's quota is exhausted. Returns an empty result set (rather
 * than throwing) when no key is configured, so callers degrade gracefully.
 */
export async function runFallbackSearch(
  query: string,
  options: SearchOptions,
  env: SearchEnv,
  signal?: AbortSignal,
): Promise<FallbackSearchOutcome> {
  if (!env.tavilyApiKey && !env.serperApiKey) {
    return { results: [], servedBy: "none" };
  }

  if (env.tavilyApiKey) {
    try {
      const results = await tavilySearch(
        query,
        { depth: options.depth, maxResults: options.maxResults, signal },
        env.tavilyApiKey,
      );
      return { results, servedBy: "tavily" };
    } catch (error) {
      // Fall through to Serper only on a quota error when Serper is available;
      // surface every other failure (and quota errors with no Serper fallback).
      const canFallback =
        error instanceof SearchQuotaExceededError && Boolean(env.serperApiKey);
      if (!canFallback) {
        throw error;
      }
    }
  }

  if (env.serperApiKey) {
    const results = await serperSearch(
      query,
      { maxResults: options.maxResults, signal },
      env.serperApiKey,
    );
    return { results, servedBy: "serper" };
  }

  return { results: [], servedBy: "none" };
}
