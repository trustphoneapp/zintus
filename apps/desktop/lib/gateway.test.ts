import { afterEach, describe, expect, test } from "bun:test";
import {
  parseMcpToolEvent,
  readPrivacyHonored,
  splitMcpToolName,
  streamGatewayChat,
  summarizeToolArgs,
  summarizeToolResult,
} from "./gateway";

// ─────────────────────────────────────────────────────────────────────────────
// Server-side MCP tool loop — name split, arg/result summaries, frame parsing,
// and the streamGatewayChat body-include + frame-peel behavior. These mirror the
// web client (apps/web/lib/gateway.test.ts) so the desktop surface stays honest:
// MCP frames are display-only and NEVER fold into the client tool-call channel.
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
  test("returns parameter NAMES only, never values", () => {
    expect(summarizeToolArgs('{"path":"/etc/secret","token":"abc"}')).toBe("path, token");
  });

  test("empty / non-object / malformed args summarize to empty string", () => {
    expect(summarizeToolArgs("")).toBe("");
    expect(summarizeToolArgs("{}")).toBe("");
    expect(summarizeToolArgs("[1,2]")).toBe("");
    expect(summarizeToolArgs("{not json")).toBe("");
  });
});

describe("summarizeToolResult — short, non-leaking result summary", () => {
  test("a success is a char count", () => {
    expect(summarizeToolResult("hello world", false)).toBe("11 chars");
    expect(summarizeToolResult("x", false)).toBe("1 char");
    expect(summarizeToolResult("", false)).toBe("0 chars");
  });

  test("an error is the (truncated) message", () => {
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
                function: { name: "mcp__abc123__read_file", arguments: '{"path":"/tmp/x"}' },
              },
            ],
          },
        },
      ],
    });
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
      }),
    ).toEqual({ kind: "result", id: "call_1", ok: true, summary: "11 chars" });

    expect(
      parseMcpToolEvent({
        type: "mcp_tool_result",
        choices: [],
        tool_call_id: "call_2",
        is_error: true,
        content: "boom",
      }),
    ).toEqual({ kind: "result", id: "call_2", ok: false, summary: "boom" });
  });

  test("a normal text/metadata chunk is not an MCP event", () => {
    expect(
      parseMcpToolEvent({ choices: [{ delta: { content: "hi" } }] }),
    ).toBeNull();
    expect(parseMcpToolEvent({ type: "metadata", provider: "groq" })).toBeNull();
  });
});

describe("streamGatewayChat — mcp body wiring + frame parsing (synthetic SSE)", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  // Desktop's stream first probes /health (resolveGatewayUrl), then POSTs the
  // chat. This mock answers both and captures the chat body for assertions.
  function installFetch(
    frames: unknown[],
    extraHeaders?: Record<string, string>,
  ): { sentBody: () => Record<string, unknown> } {
    let captured: Record<string, unknown> = {};
    const sse =
      frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("") + "data: [DONE]\n\n";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = String(input);
      if (u.endsWith("/health")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      captured = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(sse, {
        status: 200,
        headers: { "content-type": "text/event-stream", ...extraHeaders },
      });
    }) as unknown as typeof fetch;
    return { sentBody: () => captured };
  }

  test("includes `mcp` in the body and parses tool-loop frames into toolEvents", async () => {
    const { sentBody } = installFetch([
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
                  function: { name: "mcp__abc123__read_file", arguments: '{"path":"/tmp/x"}' },
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
    expect(sentBody().mcp).toEqual(mcp);

    // The call+result frames parse into ordered toolEvents (and the live callback
    // fired in the same order) — NOT into the client tool-call channel.
    expect(result.toolCalls).toBeUndefined();
    expect(result.toolEvents).toEqual([
      { kind: "call", id: "call_1", server: "abc123", tool: "read_file", argsSummary: "path" },
      { kind: "result", id: "call_1", ok: true, summary: "11 chars" },
    ]);
    expect(live).toEqual(result.toolEvents!);
  });

  test("omits `mcp` from the body when not provided", async () => {
    const { sentBody } = installFetch([
      {
        id: "t",
        provider: "groq",
        model: "m",
        choices: [{ delta: { content: "hi" }, finish_reason: null }],
      },
    ]);

    const result = await streamGatewayChat({
      messages: [{ role: "user", content: "hi" }],
      onChunk: () => {},
    });
    expect(sentBody().mcp).toBeUndefined();
    expect(result.toolEvents).toBeUndefined();
  });

  test("parses private_mode_honored from the metadata frame onto meta", async () => {
    installFetch([
      {
        id: "t",
        provider: "groq",
        model: "m",
        choices: [{ delta: { content: "hi" }, finish_reason: null }],
      },
      {
        type: "metadata",
        provider: "groq",
        model: "m",
        choices: [],
        private_mode_honored: true,
      },
    ]);
    const result = await streamGatewayChat({
      messages: [{ role: "user", content: "hi" }],
      blockTraining: true,
      onChunk: () => {},
    });
    expect(result.meta?.privacyHonored).toBe(true);
  });

  test("carries the NOT-honored signal honestly (false, not dropped)", async () => {
    installFetch([
      {
        id: "t",
        provider: "openai",
        model: "m",
        choices: [{ delta: { content: "hi" }, finish_reason: null }],
      },
      {
        type: "metadata",
        provider: "openai",
        model: "m",
        choices: [],
        private_mode_honored: false,
      },
    ]);
    const result = await streamGatewayChat({
      messages: [{ role: "user", content: "hi" }],
      blockTraining: true,
      onChunk: () => {},
    });
    expect(result.meta?.privacyHonored).toBe(false);
  });

  test("falls back to the X-Zintus-Private-Honored header when no meta frame", async () => {
    installFetch(
      [
        {
          id: "t",
          provider: "groq",
          model: "m",
          choices: [{ delta: { content: "hi" }, finish_reason: null }],
        },
      ],
      { "X-Zintus-Private-Honored": "true" },
    );
    const result = await streamGatewayChat({
      messages: [{ role: "user", content: "hi" }],
      blockTraining: true,
      onChunk: () => {},
    });
    expect(result.meta?.privacyHonored).toBe(true);
  });

  test("leaves privacyHonored undefined when Private Mode was off", async () => {
    installFetch([
      {
        id: "t",
        provider: "groq",
        model: "m",
        choices: [{ delta: { content: "hi" }, finish_reason: null }],
      },
      { type: "metadata", provider: "groq", model: "m", choices: [] },
    ]);
    const result = await streamGatewayChat({
      messages: [{ role: "user", content: "hi" }],
      onChunk: () => {},
    });
    expect(result.meta?.privacyHonored).toBeUndefined();
  });
});

describe("readPrivacyHonored — X-Zintus-Private-Honored header → tri-state", () => {
  test("'true' → true, 'false' → false", () => {
    expect(readPrivacyHonored(new Headers({ "X-Zintus-Private-Honored": "true" }))).toBe(
      true,
    );
    expect(
      readPrivacyHonored(new Headers({ "X-Zintus-Private-Honored": "false" })),
    ).toBe(false);
  });

  test("absent header → undefined (no claim made)", () => {
    expect(readPrivacyHonored(new Headers())).toBeUndefined();
  });

  test("garbage value → undefined (under-claim, never guess)", () => {
    expect(
      readPrivacyHonored(new Headers({ "X-Zintus-Private-Honored": "maybe" })),
    ).toBeUndefined();
  });
});
