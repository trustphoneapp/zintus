import { afterEach, describe, expect, test } from "bun:test";
import {
  type ToolCallAccumulator,
  accumulateToolCallDeltas,
  catalogModelsQuery,
  fetchCatalogModels,
  finalizeToolCalls,
} from "./gateway.js";

// The web client reassembles streamed tool calls the same fragile way the
// provider side does: the gateway emits each call's `name` once and its
// `arguments` as a (possibly fragmented) JSON string, keyed by `index`. These
// tests exercise the pure fold + finalize helpers that `streamGatewayChat` uses
// internally, so the user-facing reassembly is covered without mocking `fetch`.

describe("accumulateToolCallDeltas + finalizeToolCalls — web SSE reassembly", () => {
  test("accumulates a single call whose arguments arrive in fragments", () => {
    const acc: ToolCallAccumulator = new Map();
    // name + id arrive on the first frame; arguments span three frames.
    accumulateToolCallDeltas(acc, [
      { index: 0, id: "call_1", function: { name: "get_weather", arguments: '{"ci' } },
    ]);
    accumulateToolCallDeltas(acc, [{ index: 0, function: { arguments: 'ty":"Par' } }]);
    accumulateToolCallDeltas(acc, [{ index: 0, function: { arguments: 'is"}' } }]);

    const calls = finalizeToolCalls(acc);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      type: "tool_call",
      id: "call_1",
      name: "get_weather",
      arguments: { city: "Paris" },
    });
  });

  test("keeps two parallel calls separate by index, ordered deterministically", () => {
    const acc: ToolCallAccumulator = new Map();
    // Interleaved fragments for index 1 then index 0 (out of order on the wire).
    accumulateToolCallDeltas(acc, [
      { index: 1, id: "b", function: { name: "f_b", arguments: '{"y":2}' } },
      { index: 0, id: "a", function: { name: "f_a", arguments: '{"x":' } },
    ]);
    accumulateToolCallDeltas(acc, [{ index: 0, function: { arguments: "1}" } }]);

    const calls = finalizeToolCalls(acc);
    expect(calls.map((c) => c.name)).toEqual(["f_a", "f_b"]); // sorted by index
    expect(calls[0]?.arguments).toEqual({ x: 1 });
    expect(calls[1]?.arguments).toEqual({ y: 2 });
  });

  test("malformed argument JSON degrades to {} instead of throwing", () => {
    const acc: ToolCallAccumulator = new Map();
    accumulateToolCallDeltas(acc, [
      { index: 0, id: "c", function: { name: "broken", arguments: "{not json" } },
    ]);
    const calls = finalizeToolCalls(acc);
    expect(calls[0]?.arguments).toEqual({});
    expect(calls[0]?.name).toBe("broken");
  });

  test("defaults a missing index to 0 and synthesizes an id when absent", () => {
    const acc: ToolCallAccumulator = new Map();
    accumulateToolCallDeltas(acc, [{ function: { name: "noid", arguments: "{}" } }]);
    const calls = finalizeToolCalls(acc);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.id).toBe("call_noid_0");
    expect(calls[0]?.arguments).toEqual({});
  });

  test("empty accumulator yields no tool calls", () => {
    expect(finalizeToolCalls(new Map())).toEqual([]);
  });
});

describe("catalogModelsQuery — filter → querystring mapping", () => {
  test("no filters → empty string (full catalog)", () => {
    expect(catalogModelsQuery()).toBe("");
    expect(catalogModelsQuery({})).toBe("");
  });

  test("only true boolean flags are emitted; false/omitted are dropped", () => {
    expect(catalogModelsQuery({ vision: true, tools: false })).toBe("vision=true");
    expect(catalogModelsQuery({ free: true, local: true })).toBe(
      "free=true&local=true",
    );
  });

  test("provider is passed through verbatim alongside flags", () => {
    expect(catalogModelsQuery({ provider: "gemini", vision: true })).toBe(
      "provider=gemini&vision=true",
    );
  });

  test("all filters set → all params present", () => {
    expect(
      catalogModelsQuery({
        provider: "groq",
        vision: true,
        tools: true,
        free: true,
        local: true,
      }),
    ).toBe("provider=groq&vision=true&tools=true&free=true&local=true");
  });
});

describe("fetchCatalogModels — fetch wiring + honesty", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("appends the mapped querystring to /v1/models and returns data", async () => {
    let calledUrl = "";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calledUrl = String(input);
      return new Response(JSON.stringify({ object: "list", data: [{ id: "m1" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const result = await fetchCatalogModels({ vision: true, provider: "gemini" });
    expect(calledUrl).toContain("/v1/models?provider=gemini&vision=true");
    expect(result).toEqual([{ id: "m1" } as never]);
  });

  test("no filters → bare /v1/models with no query string", async () => {
    let calledUrl = "";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calledUrl = String(input);
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as typeof fetch;

    await fetchCatalogModels();
    expect(calledUrl.endsWith("/v1/models")).toBe(true);
  });

  test("returns [] (never throws) when the gateway is offline", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await fetchCatalogModels({ free: true })).toEqual([]);
  });

  test("returns [] on a non-OK response (no fabricated rows)", async () => {
    globalThis.fetch = (async () =>
      new Response("nope", { status: 500 })) as unknown as typeof fetch;
    expect(await fetchCatalogModels()).toEqual([]);
  });
});
