import { describe, expect, test, mock, afterEach } from "bun:test";
import type { ChatMessage } from "@zintus/types";
import {
  getSearchStrategy,
  isNativeStrategy,
  runFallbackSearch,
  extractSearchQuery,
  injectSearchResults,
  formatSearchContext,
  groqCompoundModel,
  parseGroqSearchResults,
  geminiSearchTool,
  parseGeminiGrounding,
  openrouterSearchTool,
  parseOpenRouterCitations,
  tavilySearch,
  serperSearch,
  SearchQuotaExceededError,
  deepResearch,
  subQueryCount,
  type SearchResult,
} from "./index.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function mockFetch(handler: (url: string, init?: RequestInit) => Response) {
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) =>
    handler(String(input), init),
  ) as unknown as typeof fetch;
}

// ── strategy routing ────────────────────────────────────────────────────────

describe("getSearchStrategy", () => {
  test("maps native providers", () => {
    expect(getSearchStrategy("groq")).toBe("groq-compound");
    expect(getSearchStrategy("gemini")).toBe("gemini-grounding");
    expect(getSearchStrategy("openrouter")).toBe("openrouter-tool");
  });

  test("non-native providers use the external fallback", () => {
    for (const p of ["cerebras", "mistral", "deepseek", "cohere", "ollama"] as const) {
      expect(getSearchStrategy(p)).toBe("tavily-fallback");
    }
  });

  test("undefined/auto falls back", () => {
    expect(getSearchStrategy(undefined)).toBe("tavily-fallback");
  });

  test("isNativeStrategy", () => {
    expect(isNativeStrategy("groq-compound")).toBe(true);
    expect(isNativeStrategy("gemini-grounding")).toBe(true);
    expect(isNativeStrategy("openrouter-tool")).toBe(true);
    expect(isNativeStrategy("tavily-fallback")).toBe(false);
    expect(isNativeStrategy("none")).toBe(false);
  });
});

// ── native provider helpers ─────────────────────────────────────────────────

describe("groq", () => {
  test("compound model by depth", () => {
    expect(groqCompoundModel("basic")).toBe("groq/compound-mini");
    expect(groqCompoundModel("standard")).toBe("groq/compound-mini");
    expect(groqCompoundModel("deep")).toBe("groq/compound");
  });

  test("parses executed_tools web_search results", () => {
    const results = parseGroqSearchResults({
      choices: [
        {
          message: {
            executed_tools: [
              {
                type: "web_search",
                results: [
                  { title: "A", url: "https://a.com", content: "ca" },
                  { title: "B", url: "", content: "no url dropped" },
                ],
              },
              { type: "code", results: [] },
            ],
          },
        },
      ],
    });
    expect(results).toEqual([{ title: "A", url: "https://a.com", content: "ca" }]);
  });

  test("returns empty for malformed", () => {
    expect(parseGroqSearchResults({})).toEqual([]);
    expect(parseGroqSearchResults(null)).toEqual([]);
  });
});

describe("gemini", () => {
  test("search tool shape", () => {
    expect(geminiSearchTool()).toEqual({ googleSearch: {} });
  });

  test("parses groundingMetadata", () => {
    const { sources, searchQueries } = parseGeminiGrounding({
      candidates: [
        {
          groundingMetadata: {
            webSearchQueries: ["q1"],
            groundingChunks: [
              { web: { title: "T", uri: "https://t.com", snippet: "s" } },
              { web: { title: "no uri", snippet: "x" } },
            ],
          },
        },
      ],
    });
    expect(searchQueries).toEqual(["q1"]);
    expect(sources).toEqual([{ title: "T", url: "https://t.com", content: "s" }]);
  });

  test("empty for missing metadata", () => {
    expect(parseGeminiGrounding({}).sources).toEqual([]);
  });
});

describe("openrouter", () => {
  test("tool shape with defaults and options", () => {
    expect(openrouterSearchTool()).toEqual({
      type: "openrouter:web_search",
      engine: "auto",
    });
    expect(openrouterSearchTool({ maxResults: 3, engine: "exa" })).toEqual({
      type: "openrouter:web_search",
      max_results: 3,
      engine: "exa",
    });
  });

  test("parses url_citation annotations", () => {
    const results = parseOpenRouterCitations({
      choices: [
        {
          message: {
            annotations: [
              {
                type: "url_citation",
                url_citation: { url: "https://c.com", title: "C", content: "cc" },
              },
              { type: "file", url_citation: { url: "x" } },
            ],
          },
        },
      ],
    });
    expect(results).toEqual([{ title: "C", url: "https://c.com", content: "cc" }]);
  });
});

// ── injection ───────────────────────────────────────────────────────────────

describe("inject", () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "first" },
    { role: "assistant", content: "reply" },
    { role: "user", content: "  latest question  " },
  ];

  test("extractSearchQuery picks the last non-empty user message", () => {
    expect(extractSearchQuery(messages)).toBe("latest question");
    expect(extractSearchQuery([])).toBe("");
  });

  test("formatSearchContext numbers results", () => {
    const out = formatSearchContext([
      { title: "T1", url: "u1", content: "c1" },
      { title: "T2", url: "u2", content: "c2" },
    ]);
    expect(out).toContain("[1] T1");
    expect(out).toContain("[2] T2");
  });

  test("injectSearchResults inserts before the last user message", () => {
    const results: SearchResult[] = [{ title: "T", url: "u", content: "c" }];
    const out = injectSearchResults(messages, results);
    expect(out.length).toBe(messages.length + 1);
    const injected = out[out.length - 2];
    expect(injected?.role).toBe("system");
    expect(injected?.content).toContain("web_search_results");
    expect(out[out.length - 1]?.content).toBe("  latest question  ");
  });

  test("no results returns messages unchanged", () => {
    expect(injectSearchResults(messages, [])).toBe(messages);
  });
});

// ── external fallback (mocked fetch) ─────────────────────────────────────────

describe("tavilySearch", () => {
  test("maps results", async () => {
    mockFetch(() =>
      Response.json({
        results: [
          { title: "T", url: "https://t.com", content: "c", score: 0.9 },
          { title: "no url", content: "x" },
        ],
      }),
    );
    const out = await tavilySearch("q", { depth: "basic" }, "tvly-key");
    expect(out).toEqual([
      { title: "T", url: "https://t.com", content: "c", score: 0.9 },
    ]);
  });

  test("throws quota error on 429", async () => {
    mockFetch(() => new Response(null, { status: 429 }));
    await expect(tavilySearch("q", {}, "k")).rejects.toBeInstanceOf(
      SearchQuotaExceededError,
    );
  });

  test("throws without key", async () => {
    await expect(tavilySearch("q", {}, "")).rejects.toThrow("TAVILY_API_KEY");
  });
});

describe("serperSearch", () => {
  test("maps organic results", async () => {
    mockFetch(() =>
      Response.json({
        organic: [{ title: "S", link: "https://s.com", snippet: "snip" }],
      }),
    );
    const out = await serperSearch("q", {}, "serper-key");
    expect(out).toEqual([{ title: "S", url: "https://s.com", content: "snip" }]);
  });
});

describe("runFallbackSearch", () => {
  test("returns empty with no keys", async () => {
    const out = await runFallbackSearch("q", { enabled: true, depth: "basic" }, {});
    expect(out).toEqual({ results: [], servedBy: "none" });
  });

  test("uses tavily when configured", async () => {
    mockFetch(() => Response.json({ results: [{ title: "T", url: "u", content: "c" }] }));
    const out = await runFallbackSearch(
      "q",
      { enabled: true, depth: "basic" },
      { tavilyApiKey: "k" },
    );
    expect(out.servedBy).toBe("tavily");
    expect(out.results.length).toBe(1);
  });

  test("falls back to serper on tavily quota", async () => {
    mockFetch((url) => {
      if (url.includes("tavily")) {
        return new Response(null, { status: 429 });
      }
      return Response.json({ organic: [{ title: "S", link: "u", snippet: "c" }] });
    });
    const out = await runFallbackSearch(
      "q",
      { enabled: true, depth: "basic" },
      { tavilyApiKey: "k", serperApiKey: "s" },
    );
    expect(out.servedBy).toBe("serper");
  });

  test("rethrows quota error when no serper fallback", async () => {
    mockFetch(() => new Response(null, { status: 429 }));
    await expect(
      runFallbackSearch("q", { enabled: true, depth: "basic" }, { tavilyApiKey: "k" }),
    ).rejects.toBeInstanceOf(SearchQuotaExceededError);
  });
});

// ── deep research orchestration ──────────────────────────────────────────────

describe("deepResearch", () => {
  test("subQueryCount by depth", () => {
    expect(subQueryCount("quick")).toBe(1);
    expect(subQueryCount("standard")).toBe(3);
    expect(subQueryCount("deep")).toBe(5);
  });

  test("quick depth skips decomposition and synthesizes", async () => {
    const decompose = mock(async () => ["should-not-run"]);
    const events: string[] = [];
    let sources: SearchResult[] = [];

    for await (const event of deepResearch(
      "what is x",
      { depth: "quick" },
      {
        decompose,
        search: async () => [{ title: "T", url: "u", content: "c" }],
        synthesize: async function* () {
          yield "part1 ";
          yield "part2";
        },
      },
    )) {
      events.push(event.type);
      if (event.type === "done") sources = event.sources;
    }

    expect(decompose).not.toHaveBeenCalled();
    expect(events).toContain("queries");
    expect(events).toContain("synthesizing");
    expect(events).toContain("answer_chunk");
    expect(events[events.length - 1]).toBe("done");
    expect(sources.length).toBe(1);
  });

  test("standard depth decomposes into 3 and dedupes sources", async () => {
    const collected: SearchResult[] = [];
    for await (const event of deepResearch(
      "topic",
      { depth: "standard" },
      {
        decompose: async (_q, count) =>
          Array.from({ length: count }, (_, i) => `sub${i}`),
        search: async () => [{ title: "dup", url: "same", content: "c" }],
        synthesize: async function* () {
          yield "answer";
        },
      },
    )) {
      if (event.type === "done") collected.push(...event.sources);
    }
    // Three sub-queries each return the same URL → deduped to one.
    expect(collected.length).toBe(1);
  });
});
