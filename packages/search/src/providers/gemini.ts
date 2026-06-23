import type { SearchResult } from "../types.js";

/**
 * The tool entry that enables Google Search grounding on Gemini 2.5+ models.
 * Free on Gemini 2.5 Flash. Add it to the request's `tools` array.
 */
export function geminiSearchTool(): { googleSearch: Record<string, never> } {
  return { googleSearch: {} };
}

interface GeminiGroundingChunk {
  web?: { title?: string; uri?: string; snippet?: string };
}

interface GeminiResponseShape {
  candidates?: Array<{
    groundingMetadata?: {
      webSearchQueries?: string[];
      groundingChunks?: GeminiGroundingChunk[];
    };
  }>;
}

/**
 * Extract the search queries Gemini ran and the sources it grounded on, from a
 * (non-streamed) response or an aggregated final chunk.
 */
export function parseGeminiGrounding(response: unknown): {
  sources: SearchResult[];
  searchQueries: string[];
} {
  const metadata = (response as GeminiResponseShape)?.candidates?.[0]
    ?.groundingMetadata;
  if (!metadata) {
    return { sources: [], searchQueries: [] };
  }
  return {
    searchQueries: metadata.webSearchQueries ?? [],
    sources: (metadata.groundingChunks ?? [])
      .map((chunk) => ({
        title: chunk.web?.title ?? "",
        url: chunk.web?.uri ?? "",
        content: chunk.web?.snippet ?? "",
      }))
      .filter((source) => source.url),
  };
}
