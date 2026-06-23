import type { SearchResult } from "../types.js";
import { SearchQuotaExceededError } from "./tavily.js";

interface SerperResponse {
  organic?: Array<{ title?: string; link?: string; snippet?: string }>;
}

/**
 * Serper (google.serper.dev) — cheapest external fallback at scale. Free tier:
 * 2,500 searches/month. Used automatically when Tavily quota is exhausted.
 */
export async function serperSearch(
  query: string,
  options: { maxResults?: number; signal?: AbortSignal },
  apiKey: string,
): Promise<SearchResult[]> {
  if (!apiKey) {
    throw new Error("SERPER_API_KEY not configured");
  }

  const response = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-KEY": apiKey,
    },
    signal: options.signal,
    body: JSON.stringify({ q: query, num: options.maxResults ?? 10 }),
  });

  if (response.status === 429) {
    throw new SearchQuotaExceededError("serper");
  }
  if (!response.ok) {
    throw new Error(`Serper search failed (${response.status})`);
  }

  const data = (await response.json()) as SerperResponse;
  return (data.organic ?? [])
    .map((result) => ({
      title: result.title ?? "",
      url: result.link ?? "",
      content: result.snippet ?? "",
    }))
    .filter((result) => result.url);
}
