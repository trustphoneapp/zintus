import { afterEach, describe, expect, test } from "bun:test";
import {
  type ToolCallAccumulator,
  accumulateToolCallDeltas,
  catalogModelsQuery,
  fetchCatalogModels,
  finalizeToolCalls,
  parseMcpToolEvent,
  splitMcpToolName,
  streamGatewayChat,
  summarizeToolArgs,
  summarizeToolResult,
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

// ─────────────────────────────────────────────────────────────────────────────
// Server-side MCP tool-loop — name split, arg/result summaries, frame parsing.
// ─────────────────────────────────────────────────────────────────────────────

describe("splitMcpToolName — namespaced name → { server, tool }", () => {
  test("splits mcp__<serverId>__<tool> on the FIRST separator", () => {
    expect(splitMcpToolName("mcp__abc123__read_file")).toEqual({
      server: "abc123",
      tool: "read_file",
    });
  });

  test("keeps a tool name that itself contains __", () => {
    expect(splitMcpToolName("mcp__abc123__list__all")).toEqual({
      server: "abc123",
      tool: "list__all",
    });
  });

  test("a non-MCP name yields the whole name as the tool, no server", () => {
    expect(splitMcpToolName("calculator")).toEqual({ server: "", tool: "calculator" });
  });
});

describe("summarizeToolArgs — secret-safe arg summary (names only)", () => {
  test("returns the parameter names, never their values", () => {
    expect(summarizeToolArgs('{"path":"/etc/secret","token":"abc"}')).toBe(
      "path, token",
    );
  });

  test("empty / non-object / malformed args summarize to an empty string", () => {
    expect(summarizeToolArgs("")).toBe("");
    expect(summarizeToolArgs("{}")).toBe("");
    expect(summarizeToolArgs("[1,2]")).toBe("");
    expect(summarizeToolArgs("{not json")).toBe("");
  });
});

describe("summarizeToolResult — short, non-leaking result summary", () => {
  test("success → a char count (never the body)", () => {
    expect(summarizeToolResult("hello world", false)).toBe("11 chars");
    expect(summarizeToolResult("x", false)).toBe("1 char");
    expect(summarizeToolResult("", false)).toBe("0 chars");
  });

  test("error → the (truncated) message", () => {
    expect(summarizeToolResult("file not found", true)).toBe("file not found");
    expect(summarizeToolResult("", true)).toBe("the tool reported an error");
    expect(summarizeToolResult("e".repeat(200), true)).toHaveLength(118); // 117 + …
  });
});

describe("parseMcpToolEvent — gateway frame → ordered UI event", () => {
  test("parses an mcp_tool_call frame into a call event", () => {
    const event = parseMcpToolEvent({
      type: "mcp_tool_call",
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                type: "function",
                function: {
                  name: "mcp__abc123__read_file",
                  arguments: '{"path":"/tmp/x"}',
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    } as never);
    expect(event).toEqual({
      kind: "call",
      id: "call_1",
      server: "abc123",
      tool: "read_file",
      argsSummary: "path",
    });
  });

  test("parses an mcp_tool_result frame (ok + error) into a result event", () => {
    expect(
      parseMcpToolEvent({
        type: "mcp_tool_result",
        choices: [],
        tool_call_id: "call_1",
        is_error: false,
        content: "hello world",
      } as never),
    ).toEqual({ kind: "result", id: "call_1", ok: true, summary: "11 chars" });

    expect(
      parseMcpToolEvent({
        type: "mcp_tool_result",
        choices: [],
        tool_call_id: "call_2",
        is_error: true,
        content: "boom",
      } as never),
    ).toEqual({ kind: "result", id: "call_2", ok: false, summary: "boom" });
  });

  test("a normal text/metadata chunk is not an MCP event", () => {
    expect(
      parseMcpToolEvent({
        choices: [{ delta: { content: "hi" } }],
      } as never),
    ).toBeNull();
    expect(parseMcpToolEvent({ type: "metadata", provider: "groq" } as never)).toBeNull();
  });
});

describe("streamGatewayChat — mcp body wiring + frame parsing (synthetic SSE)", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function sseResponse(frames: unknown[]): Response {
    const body =
      frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("") +
      "data: [DONE]\n\n";
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }

  test("includes `mcp` in the request body and parses tool-loop frames into toolEvents", async () => {
    let sentBody: Record<string, unknown> = {};
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return sseResponse([
        {
          type: "mcp_tool_call",
          id: "trace1",
          provider: "groq",
          model: "m",
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_1",
                    type: "function",
                    function: {
                      name: "mcp__abc123__read_file",
                      arguments: '{"path":"/tmp/x"}',
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        {
          type: "mcp_tool_result",
          id: "trace1",
          provider: "groq",
          model: "m",
          choices: [],
          tool_call_id: "call_1",
          is_error: false,
          content: "hello world",
        },
        {
          id: "trace1",
          provider: "groq",
          model: "m",
          choices: [{ delta: { content: "Done." }, finish_reason: null }],
        },
      ]);
    }) as unknown as typeof fetch;

    const live: unknown[] = [];
    const mcp = {
      servers: [{ transport: "stdio" as const, command: "srv" }],
      enabledTools: ["read_file"],
    };
    const result = await streamGatewayChat({
      messages: [{ role: "user", content: "read it" }],
      mcp,
      onChunk: () => {},
      onMcpToolEvent: (e) => live.push(e),
    });

    // Body carries the mcp block verbatim.
    expect(sentBody.mcp).toEqual(mcp);

    // The call+result frames parse into ordered toolEvents (and the live callback
    // fired in the same order) — NOT into the client tool-call channel.
    expect(result.toolCalls).toBeUndefined();
    expect(result.toolEvents).toEqual([
      {
        kind: "call",
        id: "call_1",
        server: "abc123",
        tool: "read_file",
        argsSummary: "path",
      },
      { kind: "result", id: "call_1", ok: true, summary: "11 chars" },
    ]);
    expect(live).toEqual(result.toolEvents!);
  });

  test("omits `mcp` from the body when not provided", async () => {
    let sentBody: Record<string, unknown> = {};
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return sseResponse([
        {
          id: "t",
          provider: "groq",
          model: "m",
          choices: [{ delta: { content: "hi" }, finish_reason: null }],
        },
      ]);
    }) as unknown as typeof fetch;

    const result = await streamGatewayChat({
      messages: [{ role: "user", content: "hi" }],
      onChunk: () => {},
    });
    expect("mcp" in sentBody).toBe(false);
    expect(result.toolEvents).toBeUndefined();
  });
});
