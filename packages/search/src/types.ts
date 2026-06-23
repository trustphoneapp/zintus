import type { ProviderId } from "@zintus/types";

/**
 * How aggressively to search.
 *   basic    — single quick lookup (Groq compound-mini, Tavily basic)
 *   standard — balanced (default)
 *   deep     — multiple/advanced searches (Groq compound, Tavily advanced)
 */
export type SearchDepth = "basic" | "standard" | "deep";

export interface SearchOptions {
  enabled: boolean;
  depth: SearchDepth;
  maxResults?: number;
  excludeDomains?: string[];
  includeDomains?: string[];
}

export const DEFAULT_SEARCH_OPTIONS: SearchOptions = {
  enabled: false,
  depth: "standard",
  maxResults: 5,
};

export interface SearchResult {
  title: string;
  url: string;
  content: string;
  /** Relevance score, when the upstream provides one (Tavily). */
  score?: number;
}

/**
 * How a given provider performs web search.
 *   groq-compound    — native, free; switch model to groq/compound[-mini]
 *   gemini-grounding — native, free; add the googleSearch tool
 *   openrouter-tool  — native (Exa fallback); add openrouter:web_search tool
 *   tavily-fallback  — external API; inject results into the prompt
 *   none             — provider has no search path configured
 */
export type SearchStrategy =
  | "groq-compound"
  | "gemini-grounding"
  | "openrouter-tool"
  | "tavily-fallback"
  | "none";

/** API keys for the external fallback search providers. */
export interface SearchEnv {
  tavilyApiKey?: string;
  serperApiKey?: string;
}

export type { ProviderId };
