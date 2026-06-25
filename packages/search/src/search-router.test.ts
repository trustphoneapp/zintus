import { afterEach, describe, expect, mock, test } from "bun:test";
import type { SearchEnv, SearchOptions } from "./types.js";

// runFallbackSearch fails over Tavily -> Serper ONLY on a quota error, and only
// when a Serper key exists; every other error surfaces. We mock the two provider
// modules to drive each branch deterministically (no network).

// Capture the REAL error class so `instanceof SearchQuotaExceededError` in
// router.ts still matches after we mock the module.
const { SearchQuotaExceededError } = await import("./providers/tavily.js");

const OPTS: SearchOptions = { enabled: true, depth: "basic", maxResults: 3 };

afterEach(() => mock.restore());

async function withProviders(opts: {
  tavily?: () => Promise<unknown[]>;
  serper?: () => Promise<unknown[]>;
}) {
  const tavilyCalls = { n: 0 };
  const serperCalls = { n: 0 };
  mock.module("./providers/tavily.js", () => ({
    SearchQuotaExceededError,
    tavilySearch: async () => {
      tavilyCalls.n++;
      return opts.tavily ? await opts.tavily() : [];
    },
  }));
  mock.module("./providers/serper.js", () => ({
    serperSearch: async () => {
      serperCalls.n++;
      return opts.serper ? await opts.serper() : [];
    },
  }));
  const { runFallbackSearch } = await import("./router.js");
  return { runFallbackSearch, tavilyCalls, serperCalls };
}

describe("runFallbackSearch", () => {
  test("no keys configured -> empty, servedBy 'none', no provider called", async () => {
    const { runFallbackSearch, tavilyCalls, serperCalls } = await withProviders({});
    const env: SearchEnv = {};
    const out = await runFallbackSearch("q", OPTS, env);
    expect(out).toEqual({ results: [], servedBy: "none" });
    expect(tavilyCalls.n).toBe(0);
    expect(serperCalls.n).toBe(0);
  });

  test("Tavily succeeds -> servedBy 'tavily', Serper not called", async () => {
    const { runFallbackSearch, serperCalls } = await withProviders({
      tavily: async () => [{ title: "t", url: "u", content: "c" }],
    });
    const env: SearchEnv = { tavilyApiKey: "tvly", serperApiKey: "serp" };
    const out = await runFallbackSearch("q", OPTS, env);
    expect(out.servedBy).toBe("tavily");
    expect(out.results.length).toBe(1);
    expect(serperCalls.n).toBe(0);
  });

  test("Tavily QUOTA error + Serper key -> fails over to Serper", async () => {
    const { runFallbackSearch, serperCalls } = await withProviders({
      tavily: async () => {
        throw new SearchQuotaExceededError("tavily");
      },
      serper: async () => [{ title: "s", url: "u", content: "c" }],
    });
    const env: SearchEnv = { tavilyApiKey: "tvly", serperApiKey: "serp" };
    const out = await runFallbackSearch("q", OPTS, env);
    expect(out.servedBy).toBe("serper");
    expect(serperCalls.n).toBe(1);
  });

  test("Tavily QUOTA error but NO Serper key -> rethrows (no silent empty)", async () => {
    const { runFallbackSearch } = await withProviders({
      tavily: async () => {
        throw new SearchQuotaExceededError("tavily");
      },
    });
    const env: SearchEnv = { tavilyApiKey: "tvly" };
    await expect(runFallbackSearch("q", OPTS, env)).rejects.toThrow(/quota/);
  });

  test("Tavily NON-quota error -> rethrows, does NOT fail over even with Serper", async () => {
    const { runFallbackSearch, serperCalls } = await withProviders({
      tavily: async () => {
        throw new Error("network down");
      },
    });
    const env: SearchEnv = { tavilyApiKey: "tvly", serperApiKey: "serp" };
    await expect(runFallbackSearch("q", OPTS, env)).rejects.toThrow(/network down/);
    expect(serperCalls.n).toBe(0);
  });

  test("only a Serper key -> servedBy 'serper'", async () => {
    const { runFallbackSearch, tavilyCalls, serperCalls } = await withProviders({
      serper: async () => [{ title: "s", url: "u", content: "c" }],
    });
    const env: SearchEnv = { serperApiKey: "serp" };
    const out = await runFallbackSearch("q", OPTS, env);
    expect(out.servedBy).toBe("serper");
    expect(tavilyCalls.n).toBe(0);
    expect(serperCalls.n).toBe(1);
  });
});
