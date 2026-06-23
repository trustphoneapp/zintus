import type { SearchResult } from "../types.js";

export interface OpenRouterSearchTool {
  type: "openrouter:web_search";
  max_results?: number;
  engine: "auto" | "native" | "exa" | "firecrawl";
}

/**
 * The tool entry for OpenRouter's web search. `engine: "auto"` uses a model's
 * native search when available (Gemini/Anthropic/Perplexity), else falls back
 * to Exa automatically. Works on any tool-calling model. The legacy
 * `plugins: [{ id: "web" }]` form is deprecated and not used.
 */
export function openrouterSearchTool(options?: {
  maxResults?: number;
  engine?: OpenRouterSearchTool["engine"];
}): OpenRouterSearchTool {
  return {
    type: "openrouter:web_search",
    ...(options?.maxResults ? { max_results: options.maxResults } : {}),
    engine: options?.engine ?? "auto",
  };
}

interface OpenRouterAnnotation {
  type?: string;
  url_citation?: { url?: string; title?: string; content?: string };
}

interface OpenRouterResponseShape {
  choices?: Array<{
    message?: { annotations?: OpenRouterAnnotation[] };
  }>;
}

/** Pull url_citation annotations out of an OpenRouter response for display. */
export function parseOpenRouterCitations(response: unknown): SearchResult[] {
  const annotations = (response as OpenRouterResponseShape)?.choices?.[0]
    ?.message?.annotations;
  if (!Array.isArray(annotations)) {
    return [];
  }
  return annotations
    .filter((annotation) => annotation.type === "url_citation")
    .map((annotation) => ({
      title: annotation.url_citation?.title ?? "",
      url: annotation.url_citation?.url ?? "",
      content: annotation.url_citation?.content ?? "",
    }))
    .filter((result) => result.url);
}
