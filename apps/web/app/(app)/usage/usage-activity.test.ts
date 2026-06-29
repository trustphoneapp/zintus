import { afterEach, describe, expect, mock, test } from "bun:test";

// Stub the Next path-aliased "@/lib/gateway" so this runs under bun:test without
// resolving the whole web app — usage-activity only needs GATEWAY_URL + headers.
mock.module("@/lib/gateway", () => ({
  GATEWAY_URL: "http://gateway.test",
  gatewayAuthHeaders: () => ({}),
}));

const { parseActivityFeed, fetchGatewayActivity, DEFAULT_RETENTION_DAYS } =
  await import("./usage-activity");

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("parseActivityFeed", () => {
  test("honest empty defaults for a missing/empty body (no fabrication)", () => {
    expect(parseActivityFeed(undefined)).toEqual({
      data: [],
      retentionDays: null,
      hasMore: false,
    });
    expect(parseActivityFeed({})).toEqual({
      data: [],
      retentionDays: null,
      hasMore: false,
    });
  });

  test("maps the durable-store fields (retention_days / has_more / data)", () => {
    const feed = parseActivityFeed({
      object: "list",
      data: [
        {
          id: "t1",
          created: 1_700_000_000,
          created_at: "2023-11-14T22:13:20.000Z",
          provider: "groq",
          model: "llama-3.3-70b-versatile",
          tokens: { input: 10, output: 20, total: 30 },
          cost_usd: 0,
          saved_vs_baseline_usd: 0,
          latency_ms: 42,
          cache_hit: false,
        },
      ],
      retention_days: 30,
      has_more: true,
    });
    expect(feed.retentionDays).toBe(30);
    expect(feed.hasMore).toBe(true);
    expect(feed.data).toHaveLength(1);
    expect(feed.data[0]?.provider).toBe("groq");
  });

  test("tolerates the in-memory fallback shape (no retention_days/has_more)", () => {
    const feed = parseActivityFeed({ object: "list", data: [] });
    expect(feed.retentionDays).toBeNull();
    expect(feed.hasMore).toBe(false);
    expect(feed.data).toEqual([]);
  });

  test("non-array data is coerced to an empty list (never throws)", () => {
    expect(parseActivityFeed({ data: "nope" }).data).toEqual([]);
  });

  test("DEFAULT_RETENTION_DAYS is 30", () => {
    expect(DEFAULT_RETENTION_DAYS).toBe(30);
  });
});

describe("fetchGatewayActivity", () => {
  test("returns the parsed feed and hits /v1/activity with the limit", async () => {
    let calledUrl = "";
    globalThis.fetch = mock(async (url: string) => {
      calledUrl = url;
      return new Response(
        JSON.stringify({ data: [], retention_days: 30, has_more: false }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const feed = await fetchGatewayActivity(25);
    expect(calledUrl).toBe("http://gateway.test/v1/activity?limit=25");
    expect(feed).toEqual({ data: [], retentionDays: 30, hasMore: false });
  });

  test("returns null on a non-OK response (honest offline/empty state)", async () => {
    globalThis.fetch = mock(
      async () => new Response("nope", { status: 503 }),
    ) as unknown as typeof fetch;
    expect(await fetchGatewayActivity()).toBeNull();
  });

  test("returns null when fetch throws (gateway offline)", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;
    expect(await fetchGatewayActivity()).toBeNull();
  });
});
