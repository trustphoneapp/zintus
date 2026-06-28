import { describe, expect, test } from "bun:test";
import type {
  MCPClient,
  MCPResult,
  MCPServerConfig,
  MCPTool,
} from "@zintus/mcp";
import type { ToolCallContentBlock } from "@zintus/types";
import {
  mcpToolsToDefinitions,
  mcpToolName,
  parseMcpToolName,
  isMcpToolCall,
  mcpResultToText,
  executeMcpToolCall,
  type MCPClientResolver,
} from "./mcp-bridge.js";
import { MCPRegistry, configId } from "./mcp-registry.js";

const STDIO: MCPServerConfig = { transport: "stdio", command: "echo", args: ["a"] };

// ── A fake MCPClient for the registry / executor (no real connection) ─────────
class FakeClient {
  connectCalls = 0;
  callCalls = 0;
  disconnectCalls = 0;
  private live = false;
  constructor(
    private readonly opts: {
      result?: MCPResult;
      tools?: MCPTool[];
      failConnect?: boolean;
    } = {},
  ) {}
  get connected(): boolean {
    return this.live;
  }
  async connect(): Promise<void> {
    this.connectCalls += 1;
    if (this.opts.failConnect) {
      this.live = false;
      throw new Error("spawn failed");
    }
    this.live = true;
  }
  async listTools(): Promise<MCPTool[]> {
    return this.opts.tools ?? [];
  }
  async listResources() {
    return [];
  }
  async listPrompts() {
    return [];
  }
  async callTool(): Promise<MCPResult> {
    this.callCalls += 1;
    return (
      this.opts.result ?? { content: [{ type: "text", text: "ok" }], isError: false }
    );
  }
  async disconnect(): Promise<void> {
    this.disconnectCalls += 1;
    this.live = false;
  }
  /** Simulate a dropped transport. */
  kill(): void {
    this.live = false;
  }
}

const asClient = (c: FakeClient): MCPClient => c as unknown as MCPClient;

describe("mcpToolsToDefinitions", () => {
  test("namespaces names as mcp__<serverId>__<tool> and passes the schema through", () => {
    const tools: MCPTool[] = [
      {
        name: "read_file",
        description: "Read a file",
        inputSchema: { type: "object", properties: { path: { type: "string" } } },
      },
    ];
    const defs = mcpToolsToDefinitions("abc123", tools);
    expect(defs).toHaveLength(1);
    expect(defs[0]?.name).toBe("mcp__abc123__read_file");
    expect(defs[0]?.description).toBe("Read a file");
    // Schema is forwarded verbatim (no lossy remap).
    expect(defs[0]?.parameters).toEqual({
      type: "object",
      properties: { path: { type: "string" } },
    });
  });

  test("defaults a missing schema to an empty object schema", () => {
    const defs = mcpToolsToDefinitions("s", [
      { name: "t", description: "", inputSchema: undefined as never },
    ]);
    expect(defs[0]?.parameters).toEqual({ type: "object" });
  });
});

describe("parseMcpToolName", () => {
  test("round-trips a namespaced name", () => {
    const name = mcpToolName("deadbeef01", "search");
    expect(parseMcpToolName(name)).toEqual({ serverId: "deadbeef01", tool: "search" });
  });

  test("preserves a tool name that itself contains __", () => {
    const name = mcpToolName("srv", "do__a__thing");
    expect(parseMcpToolName(name)).toEqual({ serverId: "srv", tool: "do__a__thing" });
  });

  test("returns null for a non-MCP (client) tool name", () => {
    expect(parseMcpToolName("get_weather")).toBeNull();
    expect(parseMcpToolName("mcp__")).toBeNull();
    expect(parseMcpToolName("mcp__onlyserver")).toBeNull();
    expect(isMcpToolCall({ name: "get_weather" })).toBe(false);
    expect(isMcpToolCall({ name: "mcp__s__t" })).toBe(true);
  });
});

describe("mcpResultToText", () => {
  test("joins text blocks; describes non-text blocks", () => {
    expect(
      mcpResultToText({
        content: [
          { type: "text", text: "line1" },
          { type: "text", text: "line2" },
        ],
        isError: false,
      }),
    ).toBe("line1\nline2");
    expect(
      mcpResultToText({
        content: [{ type: "image", mimeType: "image/png", data: "AAAA" }],
        isError: false,
      }),
    ).toBe("[image image/png]");
  });

  test("honest non-empty fallback for an empty error result", () => {
    const text = mcpResultToText({ content: [], isError: true });
    expect(text.length).toBeGreaterThan(0);
  });
});

describe("executeMcpToolCall", () => {
  const configsById = new Map<string, MCPServerConfig>([["srv", STDIO]]);
  const call = (name: string): ToolCallContentBlock => ({
    type: "tool_call",
    id: "c1",
    name,
    arguments: { msg: "hi" },
  });

  test("maps a successful MCPResult to a tool_result (no throw)", async () => {
    const client = new FakeClient({
      result: { content: [{ type: "text", text: "pong" }], isError: false },
    });
    const resolver: MCPClientResolver = { getOrConnect: async () => asClient(client) };
    const res = await executeMcpToolCall(resolver, configsById, call("mcp__srv__ping"));
    expect(res).toEqual({
      type: "tool_result",
      toolCallId: "c1",
      content: "pong",
      isError: false,
    });
    expect(client.callCalls).toBe(1);
  });

  test("maps an isError MCPResult to an honest error tool_result (no throw)", async () => {
    const client = new FakeClient({
      result: { content: [{ type: "text", text: "no such path" }], isError: true },
    });
    const resolver: MCPClientResolver = { getOrConnect: async () => asClient(client) };
    const res = await executeMcpToolCall(resolver, configsById, call("mcp__srv__read"));
    expect(res.isError).toBe(true);
    expect(res.content).toBe("no such path");
  });

  test("connection failure becomes an error tool_result, never throws", async () => {
    const resolver: MCPClientResolver = {
      getOrConnect: async () => {
        throw new Error("server down");
      },
    };
    const res = await executeMcpToolCall(resolver, configsById, call("mcp__srv__x"));
    expect(res.isError).toBe(true);
    expect(res.content).toContain("server down");
  });

  test("unknown server id → error tool_result", async () => {
    const resolver: MCPClientResolver = {
      getOrConnect: async () => asClient(new FakeClient()),
    };
    const res = await executeMcpToolCall(resolver, configsById, call("mcp__nope__x"));
    expect(res.isError).toBe(true);
  });

  test("non-MCP tool name → error tool_result", async () => {
    const resolver: MCPClientResolver = {
      getOrConnect: async () => asClient(new FakeClient()),
    };
    const res = await executeMcpToolCall(resolver, configsById, call("get_weather"));
    expect(res.isError).toBe(true);
  });
});

describe("configId", () => {
  test("stable + order-insensitive over env/keys", () => {
    const a: MCPServerConfig = {
      transport: "stdio",
      command: "x",
      env: { A: "1", B: "2" },
    };
    const b: MCPServerConfig = {
      transport: "stdio",
      command: "x",
      env: { B: "2", A: "1" },
    };
    expect(configId(a)).toBe(configId(b));
    expect(configId(a)).toMatch(/^[0-9a-f]{12}$/);
    // Different config → different id.
    expect(configId({ transport: "stdio", command: "y" })).not.toBe(configId(a));
  });
});

describe("MCPRegistry", () => {
  test("connects once and reuses the live connection", async () => {
    const client = new FakeClient();
    const reg = new MCPRegistry({
      clientFactory: () => asClient(client),
      sweepIntervalMs: 0,
    });
    const c1 = await reg.getOrConnect(STDIO);
    const c2 = await reg.getOrConnect(STDIO);
    expect(c1).toBe(c2);
    expect(client.connectCalls).toBe(1);
    expect(reg.size).toBe(1);
    await reg.disconnectAll();
  });

  test("concurrent getOrConnect share a single connect", async () => {
    const client = new FakeClient();
    const reg = new MCPRegistry({
      clientFactory: () => asClient(client),
      sweepIntervalMs: 0,
    });
    const [a, b] = await Promise.all([
      reg.getOrConnect(STDIO),
      reg.getOrConnect(STDIO),
    ]);
    expect(a).toBe(b);
    expect(client.connectCalls).toBe(1);
    await reg.disconnectAll();
  });

  test("reconnects transparently when a cached connection has dropped", async () => {
    let made = 0;
    const clients: FakeClient[] = [];
    const reg = new MCPRegistry({
      clientFactory: () => {
        const c = new FakeClient();
        clients.push(c);
        made += 1;
        return asClient(c);
      },
      sweepIntervalMs: 0,
    });
    await reg.getOrConnect(STDIO);
    clients[0]!.kill(); // simulate the transport dropping
    await reg.getOrConnect(STDIO);
    expect(made).toBe(2);
    expect(clients[0]!.disconnectCalls).toBe(1);
    await reg.disconnectAll();
  });

  test("connect failure is surfaced and NOT cached", async () => {
    let attempt = 0;
    const reg = new MCPRegistry({
      clientFactory: () => {
        attempt += 1;
        // First factory fails to connect; second succeeds.
        return asClient(new FakeClient({ failConnect: attempt === 1 }));
      },
      sweepIntervalMs: 0,
    });
    await expect(reg.getOrConnect(STDIO)).rejects.toThrow("spawn failed");
    expect(reg.size).toBe(0);
    // A retry connects cleanly (failure was not cached).
    const ok = await reg.getOrConnect(STDIO);
    expect(ok.connected).toBe(true);
    await reg.disconnectAll();
  });

  test("bounded: evicts the LRU connection past maxServers", async () => {
    const made: FakeClient[] = [];
    const reg = new MCPRegistry({
      maxServers: 1,
      sweepIntervalMs: 0,
      clientFactory: () => {
        const c = new FakeClient();
        made.push(c);
        return asClient(c);
      },
    });
    await reg.getOrConnect({ transport: "stdio", command: "one" });
    await reg.getOrConnect({ transport: "stdio", command: "two" });
    expect(reg.size).toBe(1);
    // The first (LRU) connection was disconnected on eviction.
    expect(made[0]!.disconnectCalls).toBe(1);
    await reg.disconnectAll();
  });

  test("disconnect evicts a single server; disconnectAll drains everything", async () => {
    const made: FakeClient[] = [];
    const reg = new MCPRegistry({
      sweepIntervalMs: 0,
      clientFactory: () => {
        const c = new FakeClient();
        made.push(c);
        return asClient(c);
      },
    });
    await reg.getOrConnect({ transport: "stdio", command: "one" });
    await reg.getOrConnect({ transport: "stdio", command: "two" });
    await reg.disconnect({ transport: "stdio", command: "one" });
    expect(reg.size).toBe(1);
    expect(made[0]!.disconnectCalls).toBe(1);
    await reg.disconnectAll();
    expect(reg.size).toBe(0);
    expect(made[1]!.disconnectCalls).toBe(1);
  });
});
