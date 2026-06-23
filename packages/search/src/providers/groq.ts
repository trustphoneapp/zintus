import type { SearchDepth, SearchResult } from "../types.js";

/**
 * Groq performs web search server-side via its "compound" models — no tool
 * definition or external key required. Selecting the model is the entire
 * integration: `compound` runs multiple searches per turn (deeper, slower),
 * `compound-mini` runs a single search (≈3× faster).
 */
export function groqCompoundModel(depth: SearchDepth): string {
  return depth === "deep" ? "groq/compound" : "groq/compound-mini";
}

interface GroqExecutedTool {
  type?: string;
  results?: Array<{ title?: string; url?: string; content?: string }>;
}

interface GroqResponseShape {
  choices?: Array<{
    message?: { executed_tools?: GroqExecutedTool[] };
  }>;
}

/** Pull the executed web-search results out of a Groq compound response. */
export function parseGroqSearchResults(response: unknown): SearchResult[] {
  const tools = (response as GroqResponseShape)?.choices?.[0]?.message
    ?.executed_tools;
  if (!Array.isArray(tools)) {
    return [];
  }
  return tools
    .filter((tool) => tool.type === "web_search")
    .flatMap((tool) => tool.results ?? [])
    .map((result) => ({
      title: result.title ?? "",
      url: result.url ?? "",
      content: result.content ?? "",
    }))
    .filter((result) => result.url);
}
