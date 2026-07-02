import { describe, expect, it } from "bun:test";
import type { ToolCallContentBlock } from "@zintus/types";
import type {
  MCPResult,
  MCPServerConfig,
  MCPTool,
} from "@zintus/mcp";
import {
  AGENT_TOOL_DEFINITIONS,
  type AgentToolContext,
  type ConfirmWrite,
  createSandbox,
  executeAgentToolCall,
  runAgentToolLoop,
  type ToolLoopTurn,
} from "./agent-tools.js";
import {
  type McpClientLike,
  connectAgentMcp,
  isMcpAgentTool,
  selectAgentMcpServers,
} from "./agent-mcp.js";
import type { StoredMcpServer } from "./agent-mcp.js";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const STDIO: MCPServerConfig = { transport: "stdio", command: "noop" };

/** A fully in-memory fake MCPClient: records lifecycle calls, returns scripted
 *  tools/results, and can simulate a connect failure or a dropped connection. */
class FakeMcpClient implements McpClientLike {
  connected = false;
  disconnectCount = 0;
  readonly callLog: { name: string; args: unknown }[] = [];
  constructor(
    private readonly opts: {
      tools?: MCPTool[];
      /** Throw on connect (a server that fails to start). */
      failConnect?: string;
      /** Scripted results per tool name. */
      results?: Record<string, MCPResult>;
      /** Tool names whose callTool THROWS (simulates a dropped connection). */
      throwOn?: Record<string, string>;
    } = {},
  ) {}
  async connect(): Promise<void> {
    if (this.opts.failConnect) throw new Error(this.opts.failConnect);
    this.connected = true;
  }
  async listTools(): Promise<MCPTool[]> {
    return this.opts.tools ?? [];
  }
  async callTool(name: string, args: unknown): Promise<MCPResult> {
    this.callLog.push({ name, args });
    const boom = this.opts.throwOn?.[name];
    if (boom) throw new Error(boom); // dropped connection
    return (
      this.opts.results?.[name] ?? {
        content: [{ type: "text", text: `ran ${name}` }],
        isError: false,
      }
    );
  }
  async disconnect(): Promise<void> {
    this.disconnectCount += 1;
    this.connected = false;
  }
}

function tool(name: string, description = `the ${name} tool`): MCPTool {
  return { name, description, inputSchema: { type: "object", properties: {} } };
}

function tc(name: string, args: Record<string, unknown> = {}): ToolCallContentBlock {
  return { type: "tool_call", id: `c_${name}`, name, arguments: args };
}

describe("namespacing + tool surface", () => {
  it("adds namespaced MCP tools that never collide with the file tools", async () => {
    const client = new FakeMcpClient({ tools: [tool("query"), tool("write_file")] });
    const set = await connectAgentMcp(
      [{ name: "pg", config: STDIO, enabledTools: [] }],
      { createClient: () => client },
    );
    const names = set.definitions.map((d) => d.name);
    expect(names).toEqual(["mcp__pg__query", "mcp__pg__write_file"]);
    // Every MCP tool is prefixed and disjoint from the file tools.
    expect(names.every(isMcpAgentTool)).toBe(true);
    const fileNames = new Set(AGENT_TOOL_DEFINITIONS.map((d) => d.name));
    expect(names.some((n) => fileNames.has(n))).toBe(false);
    // Note: a server tool literally named "write_file" is namespaced away.
    expect(names).not.toContain("write_file");
    expect(set.size).toBe(2);
  });

  it("honours an enabledTools allow-list", async () => {
    const client = new FakeMcpClient({ tools: [tool("a"), tool("b"), tool("c")] });
    const set = await connectAgentMcp(
      [{ name: "srv", config: STDIO, enabledTools: ["a", "c"] }],
      { createClient: () => client },
    );
    expect(set.definitions.map((d) => d.name)).toEqual(["mcp__srv__a", "mcp__srv__c"]);
  });

  it("disambiguates colliding namespaced names across servers", async () => {
    // Two server names sanitize to the same segment AND expose the same tool.
    const c1 = new FakeMcpClient({ tools: [tool("run")] });
    const c2 = new FakeMcpClient({ tools: [tool("run")] });
    const clients = [c1, c2];
    let i = 0;
    const set = await connectAgentMcp(
      [
        { name: "a.b", config: STDIO, enabledTools: [] },
        { name: "a/b", config: STDIO, enabledTools: [] },
      ],
      { createClient: () => clients[i++]! },
    );
    const names = set.definitions.map((d) => d.name);
    expect(new Set(names).size).toBe(names.length); // all unique
    expect(names).toContain("mcp__a_b__run");
  });
});

describe("dispatch in the agent loop", () => {
  it("routes an mcp__* call to MCPClient.callTool and feeds the result back", async () => {
    const client = new FakeMcpClient({
      tools: [tool("search")],
      results: { search: { content: [{ type: "text", text: "hit!" }], isError: false } },
    });
    const set = await connectAgentMcp(
      [{ name: "gh", config: STDIO, enabledTools: [] }],
      { createClient: () => client },
    );

    const turns: ToolLoopTurn[] = [
      { stream: (async function* () {})(), toolCalls: [tc("mcp__gh__search", { q: "x" })] },
      { stream: (async function* () { yield "done"; })(), toolCalls: [] },
    ];
    const executed: { name: string; content: string; isError: boolean }[] = [];
    const { rounds } = await runAgentToolLoop([{ role: "user", content: "go" }], {
      route: async () => turns.shift()!,
      execute: async (call) => {
        const r = await set.execute({
          id: call.id,
          name: call.name,
          arguments: call.arguments,
        });
        executed.push({ name: call.name, content: r.content, isError: r.isError });
        return r;
      },
    });

    expect(rounds).toBe(2);
    expect(client.callLog).toEqual([{ name: "search", args: { q: "x" } }]);
    expect(executed).toHaveLength(1);
    expect(executed[0]).toEqual({
      name: "mcp__gh__search",
      content: "hit!",
      isError: false,
    });
  });

  it("an MCP tool error becomes an honest tool_result (never throws)", async () => {
    const client = new FakeMcpClient({
      tools: [tool("boom")],
      results: { boom: { content: [{ type: "text", text: "bad input" }], isError: true } },
    });
    const set = await connectAgentMcp(
      [{ name: "s", config: STDIO, enabledTools: [] }],
      { createClient: () => client },
    );
    const r = await set.execute(tc("mcp__s__boom"));
    expect(r.isError).toBe(true);
    expect(r.content).toBe("bad input");
  });

  it("a dropped connection (callTool throws) becomes an honest error, not a throw", async () => {
    const client = new FakeMcpClient({
      tools: [tool("flaky")],
      throwOn: { flaky: "connection closed" },
    });
    const set = await connectAgentMcp(
      [{ name: "s", config: STDIO, enabledTools: [] }],
      { createClient: () => client },
    );
    const r = await set.execute(tc("mcp__s__flaky"));
    expect(r.isError).toBe(true);
    expect(r.content).toContain("connection closed");
  });

  it("an unknown mcp__* tool is surfaced as an error, never executed", async () => {
    const set = await connectAgentMcp(
      [{ name: "s", config: STDIO, enabledTools: [] }],
      { createClient: () => new FakeMcpClient({ tools: [tool("real")] }) },
    );
    const r = await set.execute(tc("mcp__s__ghost"));
    expect(r.isError).toBe(true);
    expect(r.content).toContain("unknown MCP tool");
  });
});

describe("lifecycle + connection failures", () => {
  it("disconnects every connected server", async () => {
    const c1 = new FakeMcpClient({ tools: [tool("a")] });
    const c2 = new FakeMcpClient({ tools: [tool("b")] });
    const clients = [c1, c2];
    let i = 0;
    const set = await connectAgentMcp(
      [
        { name: "one", config: STDIO, enabledTools: [] },
        { name: "two", config: STDIO, enabledTools: [] },
      ],
      { createClient: () => clients[i++]! },
    );
    expect(set.connected).toEqual(["one", "two"]);
    await set.disconnect();
    expect(c1.disconnectCount).toBe(1);
    expect(c2.disconnectCount).toBe(1);
  });

  it("a failed connect is surfaced honestly and that server is skipped", async () => {
    const good = new FakeMcpClient({ tools: [tool("ok")] });
    const bad = new FakeMcpClient({ failConnect: "spawn failed: no such command" });
    const clients = [bad, good];
    let i = 0;
    const errs: { server: string; message: string }[] = [];
    const set = await connectAgentMcp(
      [
        { name: "broken", config: STDIO, enabledTools: [] },
        { name: "works", config: STDIO, enabledTools: [] },
      ],
      { createClient: () => clients[i++]!, onConnectError: (e) => errs.push(e) },
    );
    expect(set.connected).toEqual(["works"]);
    expect(set.errors).toHaveLength(1);
    expect(set.errors[0]!.server).toBe("broken");
    expect(errs).toHaveLength(1);
    // The good server still contributed its tool.
    expect(set.definitions.map((d) => d.name)).toEqual(["mcp__works__ok"]);
    // The failed client was cleaned up; disconnect doesn't double-close it.
    await set.disconnect();
    expect(good.disconnectCount).toBe(1);
  });
});

describe("selectAgentMcpServers", () => {
  const stored: StoredMcpServer[] = [
    {
      name: "enabled-one",
      config: STDIO,
      enabled: true,
      enabledTools: "all",
      tools: [tool("x"), tool("y")],
    },
    {
      name: "enabled-allowlist",
      config: STDIO,
      enabled: true,
      enabledTools: ["x"],
      tools: [tool("x"), tool("y")],
    },
    { name: "disabled-one", config: STDIO, enabled: false, enabledTools: "all" },
  ];

  it("default: selects every enabled server with resolved tool lists", () => {
    const { servers, missing } = selectAgentMcpServers(stored);
    expect(servers.map((s) => s.name)).toEqual(["enabled-one", "enabled-allowlist"]);
    expect(servers[0]!.enabledTools).toEqual(["x", "y"]); // "all" resolved
    expect(servers[1]!.enabledTools).toEqual(["x"]); // allow-list kept
    expect(missing).toEqual([]);
  });

  it("--mcp <name>: selects named servers regardless of enabled, reports missing", () => {
    const { servers, missing } = selectAgentMcpServers(stored, {
      only: ["disabled-one", "nope"],
    });
    expect(servers.map((s) => s.name)).toEqual(["disabled-one"]);
    expect(missing).toEqual(["nope"]);
  });

  it("--no-mcp (disabled): selects nothing", () => {
    expect(selectAgentMcpServers(stored, { disabled: true }).servers).toEqual([]);
  });
});

describe("regression: file-only behaviour is unchanged with --no-mcp", () => {
  it("an empty selection means the loop runs exactly the prior file tools", async () => {
    // --no-mcp resolves to no servers -> no MCP toolset is created in the command;
    // assert the selection is empty and the file tools still work standalone.
    expect(selectAgentMcpServers([], { disabled: true }).servers).toEqual([]);

    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "zintus-agent-mcp-")));
    const confirm: ConfirmWrite = () => true;
    const ctx: AgentToolContext = {
      sandbox: createSandbox(root),
      confirm,
      budget: { used: 0, max: 10 },
    };
    const turns: ToolLoopTurn[] = [
      { stream: (async function* () {})(), toolCalls: [tc("write_file", { path: "f.txt", content: "hi" })] },
      { stream: (async function* () { yield "ok"; })(), toolCalls: [] },
    ];
    const { rounds } = await runAgentToolLoop([{ role: "user", content: "go" }], {
      route: async () => turns.shift()!,
      execute: (call) =>
        executeAgentToolCall(
          { id: call.id, name: call.name, arguments: call.arguments },
          ctx,
        ),
    });
    expect(rounds).toBe(2);
    expect(ctx.budget.used).toBe(1);
  });

  it("connectAgentMcp([]) yields an empty, inert toolset", async () => {
    const set = await connectAgentMcp([]);
    expect(set.size).toBe(0);
    expect(set.definitions).toEqual([]);
    expect(set.has("mcp__x__y")).toBe(false);
    await set.disconnect(); // no-op, never throws
  });
});
