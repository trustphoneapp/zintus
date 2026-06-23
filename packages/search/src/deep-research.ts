import type { SearchResult } from "./types.js";

export type ResearchDepth = "quick" | "standard" | "deep";

export interface DeepResearchOptions {
  depth: ResearchDepth;
}

/** Number of parallel sub-searches per depth. */
export function subQueryCount(depth: ResearchDepth): number {
  return depth === "quick" ? 1 : depth === "standard" ? 3 : 5;
}

/**
 * Dependencies injected by the caller (the gateway wires these to the engine
 * and the configured search provider). Keeping them out of this package avoids
 * a dependency on the engine and keeps the orchestration unit-testable.
 */
export interface DeepResearchDeps {
  /** Break a question into N focused sub-queries. */
  decompose: (query: string, count: number) => Promise<string[]>;
  /** Run one web search. */
  search: (query: string) => Promise<SearchResult[]>;
  /** Stream a synthesized answer from the gathered context. */
  synthesize: (
    query: string,
    context: string,
  ) => AsyncIterable<string>;
}

export type DeepResearchEvent =
  | { type: "queries"; queries: string[] }
  | { type: "search_start"; index: number; query: string }
  | { type: "search_complete"; index: number; results: SearchResult[] }
  | { type: "synthesizing"; sourceCount: number }
  | { type: "answer_chunk"; text: string }
  | { type: "done"; sources: SearchResult[] }
  | { type: "error"; message: string };

function formatContext(results: SearchResult[]): string {
  return results
    .map(
      (result, index) =>
        `[${index + 1}] ${result.title}\n${result.url}\n${result.content}`,
    )
    .join("\n\n");
}

/**
 * Run multi-step research: decompose → parallel search → synthesize.
 * Yields progress events as an async generator so the gateway can relay them
 * over SSE.
 */
export async function* deepResearch(
  query: string,
  options: DeepResearchOptions,
  deps: DeepResearchDeps,
): AsyncGenerator<DeepResearchEvent> {
  try {
    const count = subQueryCount(options.depth);
    const subQueries =
      count === 1 ? [query] : await deps.decompose(query, count);
    yield { type: "queries", queries: subQueries };

    const settled = await Promise.all(
      subQueries.map(async (subQuery, index) => {
        try {
          const results = await deps.search(subQuery);
          return { index, results };
        } catch {
          return { index, results: [] as SearchResult[] };
        }
      }),
    );

    const allResults: SearchResult[] = [];
    const seenUrls = new Set<string>();
    for (const { index, results } of settled.sort((a, b) => a.index - b.index)) {
      yield { type: "search_complete", index, results };
      for (const result of results) {
        if (!seenUrls.has(result.url)) {
          seenUrls.add(result.url);
          allResults.push(result);
        }
      }
    }

    yield { type: "synthesizing", sourceCount: allResults.length };

    const context = formatContext(allResults);
    for await (const chunk of deps.synthesize(query, context)) {
      yield { type: "answer_chunk", text: chunk };
    }

    yield { type: "done", sources: allResults };
  } catch (error) {
    yield {
      type: "error",
      message: error instanceof Error ? error.message : "Research failed",
    };
  }
}
