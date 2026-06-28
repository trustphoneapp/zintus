import { describe, expect, test } from "bun:test";
import type { Engine, EngineStreamResult } from "@zintus/engine";
import type {
  MCPClient,
  MCPResult,
  MCPServerConfig,
  MCPTool,
} from "@zintus/mcp";
import type { ToolCallContentBlock } from "@zintus/types";
import type { GatewayConfig } from "./auth.js";
import { createGatewayHandler, type GatewayHandlerDeps } from "./handler.js";
import { MCPRegistry, configId } from "./mcp-registry.js";
import { mcpToolName } from "./mcp-bridge.js";

const CONFIG: MCPServerConfig = { transport: "stdio", command: "echo" };
const SERVER_ID = configId(CONFIG);

// ── A fake MCPClient backing a real MCPRegistry (no real connection) ──────────
class FakeClient {
  private live = false;
  callArgs: unknown[] = [];
  constructor(
    private readonly tools: MCPTool[],
    private readonly result: MCPResult,
  ) {}
  get connected(): boolean {
    return this.live;
  }
  async connect(): Promise<void> {
    this.live = true;
  }
  async listTools(): Promise<MCPTool[]> {
    return this.tools;
  }
  async listResources() {
    return [];
  }
  async listPrompts() {
    return [];
  }
  async callTool(_name: string, args: unknown): Promise<MCPResult> {
    this.callArgs.push(args);
    return this.result;
  }
  async disconnect(): Promise<void> {
    this.live = false;
  }
}

const ECHO_TOOL: MCPTool = {
  name: "echo",
  description: "Echo input",
  inputSchema: { type: "object", properties: { msg: { type: "string" } } },
};

function fakeRegistry(client = makeClient()): MCPRegistry {
  return new MCPRegistry({
    sweepIntervalMs: 0,
    clientFactory: () => client as unknown as MCPClient,
  });
}

function makeClient(result?: MCPResult): FakeClient {
  return new FakeClient([ECHO_TOOL], result ?? { content: [{ type: "text", text: "echoed!" }], isError: false });
}

async function* gen(...chunks: string[]): AsyncGenerator<string> {
  for (const c of chunks) yield c;
}

/** Minimal Engine whose routeAndStream is driven by `script` per call index. */
function scriptedEngine(
  script: ((call: number) => Partial<EngineStreamResult>)[],
): { engine: Engine; calls: () => number } {
  const counted = { value: 0 };
  const engine = {
    async routeAndStream() {
      const i = counted.value;
      counted.value += 1;
      const fn = script[Math.min(i, script.length - 1)]!;
      const partial = fn(i);
      return {
        providerId: "groq",
        model: "test-model",
        traceId: `trace-${i}`,
        stream: gen(),
        ...partial,
      } as EngineStreamResult;
    },
    getQuotaRemaining: () => 1,
  } as unknown as Engine;
  return { engine, calls: () => counted.value };
}

function makeHandler(
  engine: Engine,
  extra: Partial<GatewayHandlerDeps> = {},
  config: Partial<GatewayConfig> = {},
) {
  const full: GatewayConfig = {
    port: 8788,
    host: "127.0.0.1",
    token: "",
    corsOrigins: "*",
    ...config,
  };
  return createGatewayHandler({ engine, config: full, ...extra });
}

function mcpCall(id: string): ToolCallContentBlock {
  return {
    type: "tool_call",
    id,
    name: mcpToolName(SERVER_ID, "echo"),
    arguments: { msg: "hi" },
  };
}

describe("/v1/mcp/discover", () => {
  test("returns the server's namespaced tools", async () => {
    const handler = makeHandler(scriptedEngine([() => ({})]).engine, {
      mcpRegistry: fakeRegistry(),
    });
    const res = await handler(
      new Request("http://localhost:8788/v1/mcp/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: CONFIG }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      serverId: string;
      tools: { name: string; namespacedName: string }[];
      connectedAt: number;
    };
    expect(body.serverId).toBe(SERVER_ID);
    expect(body.tools[0]?.name).toBe("echo");
    expect(body.tools[0]?.namespacedName).toBe(mcpToolName(SERVER_ID, "echo"));
    expect(typeof body.connectedAt).toBe("number");
  });

  test("is auth-gated when a token is configured", async () => {
    const handler = makeHandler(
      scriptedEngine([() => ({})]).engine,
      { mcpRegistry: fakeRegistry() },
      { token: "secret" },
    );
    const unauth = await handler(
      new Request("http://localhost:8788/v1/mcp/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: CONFIG }),
      }),
    );
    expect(unauth.status).toBe(401);
    const authed = await handler(
      new Request("http://localhost:8788/v1/mcp/discover", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer secret",
        },
        body: JSON.stringify({ config: CONFIG }),
      }),
    );
    expect(authed.status).toBe(200);
  });

  test("502 with an honest message when the server can't connect", async () => {
    const reg = new MCPRegistry({
      sweepIntervalMs: 0,
      clientFactory: () =>
        ({
          connected: false,
          connect: async () => {
            throw new Error("ECONNREFUSED");
          },
          disconnect: async () => {},
        }) as unknown as MCPClient,
    });
    const handler = makeHandler(scriptedEngine([() => ({})]).engine, {
      mcpRegistry: reg,
    });
    const res = await handler(
      new Request("http://localhost:8788/v1/mcp/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: CONFIG }),
      }),
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { type: string; message: string } };
    expect(body.error.type).toBe("mcp_connect_error");
  });
});

describe("DELETE /v1/mcp", () => {
  test("disconnects + evicts (idempotent)", async () => {
    const reg = fakeRegistry();
    await reg.getOrConnect(CONFIG);
    expect(reg.size).toBe(1);
    const handler = makeHandler(scriptedEngine([() => ({})]).engine, {
      mcpRegistry: reg,
    });
    const res = await handler(
      new Request("http://localhost:8788/v1/mcp", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: CONFIG }),
      }),
    );
    expect(res.status).toBe(200);
    expect(reg.size).toBe(0);
  });
});

describe("server-side MCP tool loop", () => {
  test("executes an MCP tool and feeds the result back, then streams the answer", async () => {
    const client = makeClient({ content: [{ type: "text", text: "echoed: hi" }], isError: false });
    const { engine, calls } = scriptedEngine([
      // Round 1: model calls the MCP tool.
      () => ({ stream: gen("thinking..."), toolCalls: [mcpCall("c1")] }),
      // Round 2: final answer, no tool calls.
      () => ({ stream: gen("Here is your answer."), toolCalls: [] }),
    ]);
    const handler = makeHandler(engine, {
      mcpRegistry: fakeRegistry(client),
    });
    const res = await handler(
      new Request("http://localhost:8788/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: "echo hi" }],
          mcp: { servers: [CONFIG] },
        }),
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    // Two model calls: the loop fed the tool result back.
    expect(calls()).toBe(2);
    expect(text).toContain("mcp_tool_call");
    expect(text).toContain("mcp_tool_result");
    expect(text).toContain("echoed: hi");
    expect(text).toContain("Here is your answer.");
    expect(text).toContain("[DONE]");
    // The tool actually received the model's arguments.
    expect(client.callArgs).toEqual([{ msg: "hi" }]);
  });

  test("is bounded — a model that loops forever stops at the round cap", async () => {
    // Every round returns a fresh MCP tool call (never a final answer).
    const { engine, calls } = scriptedEngine([
      (i) => ({ stream: gen("step"), toolCalls: [mcpCall(`c${i}`)] }),
    ]);
    const handler = makeHandler(engine, { mcpRegistry: fakeRegistry() });
    const res = await handler(
      new Request("http://localhost:8788/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: "loop" }],
          mcp: { servers: [CONFIG] },
        }),
      }),
    );
    const text = await res.text();
    // Hard cap = MAX_MCP_TOOL_ROUNDS (8). Never unbounded.
    expect(calls()).toBe(8);
    expect(text).toContain("[DONE]");
  });
});

describe("absence of `mcp` leaves the existing flow unchanged", () => {
  test("a normal chat request never touches the MCP registry", async () => {
    let touched = false;
    const reg = new MCPRegistry({
      sweepIntervalMs: 0,
      clientFactory: () => {
        touched = true;
        return makeClient() as unknown as MCPClient;
      },
    });
    const { engine } = scriptedEngine([() => ({ stream: gen("Hello", " world") })]);
    const handler = makeHandler(engine, { mcpRegistry: reg });
    const res = await handler(
      new Request("http://localhost:8788/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
      }),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("Hello");
    expect(text).toContain("world");
    // The existing path emits NO mcp frames and never opens an MCP connection.
    expect(text).not.toContain("mcp_tool");
    expect(touched).toBe(false);
  });
});
