import type { SearchDepth, SearchResult } from "../types.js";

export class SearchQuotaExceededError extends Error {
  constructor(public provider: "tavily" | "serper") {
    super(`${provider} search quota exceeded`);
    this.name = "SearchQuotaExceededError";
  }
}

interface TavilyResponse {
  results?: Array<{
    title?: string;
    url?: string;
    content?: string;
    score?: number;
  }>;
  answer?: string;
}

/**
 * Tavily search — the primary external fallback for providers without native
 * search. Free tier: 1,000 searches/month. Throws SearchQuotaExceededError on
 * 429 so the caller can fall back to Serper.
 */
export async function tavilySearch(
  query: string,
  options: { depth?: SearchDepth; maxResults?: number; signal?: AbortSignal },
  apiKey: string,
): Promise<SearchResult[]> {
  if (!apiKey) {
    throw new Error("TAVILY_API_KEY not configured");
  }

  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    signal: options.signal,
    body: JSON.stringify({
      query,
      search_depth: options.depth === "deep" ? "advanced" : "basic",
      include_answer: true,
      max_results: options.maxResults ?? 5,
    }),
  });

  if (response.status === 429) {
    throw new SearchQuotaExceededError("tavily");
  }
  if (!response.ok) {
    throw new Error(`Tavily search failed (${response.status})`);
  }

  const data = (await response.json()) as TavilyResponse;
  return (data.results ?? [])
    .map((result) => ({
      title: result.title ?? "",
      url: result.url ?? "",
      content: result.content ?? "",
      score: result.score,
    }))
    .filter((result) => result.url);
}
