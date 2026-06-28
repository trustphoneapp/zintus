import { beforeEach, describe, expect, test } from "bun:test";
import type { MCPServerConfig, MCPTool } from "@zintus/mcp";
import {
  MCP_STORAGE_KEY,
  activeMcpServersForChat,
  addMcpServer,
  isToolEnabled,
  loadMcpServers,
  removeMcpServer,
  saveMcpServers,
  toggleEnabledTool,
  updateMcpServer,
  type McpStorage,
  type StoredMcpServer,
} from "./mcp-config";
// Event-parse helpers live in ./messages (RN-free); ./chat re-exports them but
// pulls in MMKV via gateway-url, so import from ./messages directly under bun.
import {
  parseMcpToolEvent,
  splitMcpToolName,
  summarizeToolArgs,
  summarizeToolResult,
} from "./messages";

// Minimal in-memory MMKV stand-in so the pure CRUD runs without react-native.
function makeStorage(): McpStorage & { dump(): Map<string, string> } {
  const store = new Map<string, string>();
  return {
    getString: (k) => store.get(k),
    set: (k, v) => void store.set(k, v),
    dump: () => store,
  };
}

const stdioConfig: MCPServerConfig = {
  transport: "stdio",
  command: "npx",
  args: ["-y", "server-filesystem", "/tmp"],
};

const httpConfig: MCPServerConfig = {
  transport: "http",
  url: "https://example.com/mcp",
};

function tool(name: string): MCPTool {
  return { name, description: `${name} tool`, inputSchema: { type: "object" } };
}

let storage: ReturnType<typeof makeStorage>;
beforeEach(() => {
  storage = makeStorage();
});

describe("CRUD round-trip", () => {
  test("add → load → update → remove persists through storage", () => {
    expect(loadMcpServers(storage)).toEqual([]);

    const a = addMcpServer(storage, {
      name: "Files",
      config: stdioConfig,
      enabled: true,
      enabledTools: "all",
    });
    expect(a.id).toBeTruthy();

    const b = addMcpServer(storage, {
      name: "Remote",
      config: httpConfig,
      enabled: false,
      enabledTools: "all",
    });

    let loaded = loadMcpServers(storage);
    expect(loaded).toHaveLength(2);
    expect(loaded.map((s) => s.name)).toEqual(["Files", "Remote"]);
    expect(a.id).not.toBe(b.id);

    updateMcpServer(storage, a.id, { name: "Filesystem", lastConnectedAt: 123 });
    loaded = loadMcpServers(storage);
    const updated = loaded.find((s) => s.id === a.id)!;
    expect(updated.name).toBe("Filesystem");
    expect(updated.lastConnectedAt).toBe(123);
    expect(loaded.find((s) => s.id === b.id)!.name).toBe("Remote");

    const after = removeMcpServer(storage, a.id);
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(b.id);
    expect(loadMcpServers(storage)).toHaveLength(1);
  });
});

describe("bad-data safety", () => {
  test("malformed JSON yields [] instead of throwing", () => {
    storage.set(MCP_STORAGE_KEY, "{not json");
    expect(loadMcpServers(storage)).toEqual([]);
  });

  test("non-array JSON yields []", () => {
    storage.set(MCP_STORAGE_KEY, JSON.stringify({ foo: 1 }));
    expect(loadMcpServers(storage)).toEqual([]);
  });

  test("array with malformed entries keeps only well-formed servers", () => {
    storage.set(
      MCP_STORAGE_KEY,
      JSON.stringify([
        { id: "ok", name: "Good", config: stdioConfig, enabled: true, enabledTools: "all" },
        { name: "missing id", config: stdioConfig },
        null,
        42,
      ]),
    );
    const loaded = loadMcpServers(storage);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.id).toBe("ok");
  });

  test("absent value returns []", () => {
    expect(loadMcpServers(storage)).toEqual([]);
  });
});

describe("enable/disable + enabledTools logic", () => {
  const server: StoredMcpServer = {
    id: "s1",
    name: "Files",
    config: stdioConfig,
    enabled: true,
    enabledTools: "all",
    tools: [tool("read"), tool("write"), tool("list")],
  };

  test("isToolEnabled honors enabled flag and 'all'", () => {
    expect(isToolEnabled(server, "read")).toBe(true);
    expect(isToolEnabled({ ...server, enabled: false }, "read")).toBe(false);
  });

  test("isToolEnabled honors an explicit allow-list", () => {
    const s = { ...server, enabledTools: ["read"] };
    expect(isToolEnabled(s, "read")).toBe(true);
    expect(isToolEnabled(s, "write")).toBe(false);
  });

  test("toggleEnabledTool expands 'all' then removes one tool", () => {
    expect(toggleEnabledTool(server, "write")).toEqual(["read", "list"]);
  });

  test("toggleEnabledTool collapses back to 'all' when everything is reselected", () => {
    const partial = { ...server, enabledTools: ["read", "list"] };
    expect(toggleEnabledTool(partial, "write")).toBe("all");
  });

  test("toggleEnabledTool adds a tool back to a partial list", () => {
    const partial = { ...server, enabledTools: ["read"] };
    expect(toggleEnabledTool(partial, "list")).toEqual(["read", "list"]);
  });
});

describe("activeMcpServersForChat", () => {
  test("includes only enabled servers and resolves 'all' to concrete names", () => {
    const stored: StoredMcpServer[] = [
      {
        id: "a",
        name: "A",
        config: stdioConfig,
        enabled: true,
        enabledTools: "all",
        tools: [tool("read"), tool("write")],
      },
      {
        id: "b",
        name: "B",
        config: httpConfig,
        enabled: false,
        enabledTools: "all",
        tools: [tool("x")],
      },
      {
        id: "c",
        name: "C",
        config: httpConfig,
        enabled: true,
        enabledTools: ["query"],
        tools: [tool("query"), tool("admin")],
      },
    ];

    const { servers } = activeMcpServersForChat(stored);
    expect(servers).toHaveLength(2);

    const a = servers.find((s) => s.id === "a")!;
    expect(a.enabledTools).toEqual(["read", "write"]);
    expect(a.config).toBe(stdioConfig);

    expect(servers.find((s) => s.id === "c")!.enabledTools).toEqual(["query"]);
    expect(servers.find((s) => s.id === "b")).toBeUndefined();
  });

  test("filters out enabledTools names not present in discovered tools", () => {
    const stored: StoredMcpServer[] = [
      {
        id: "a",
        name: "A",
        config: httpConfig,
        enabled: true,
        enabledTools: ["read", "ghost"],
        tools: [tool("read")],
      },
    ];
    expect(activeMcpServersForChat(stored).servers[0]!.enabledTools).toEqual(["read"]);
  });

  test("an enabled server with no discovered tools contributes an empty list", () => {
    const stored: StoredMcpServer[] = [
      { id: "a", name: "A", config: httpConfig, enabled: true, enabledTools: "all" },
    ];
    expect(activeMcpServersForChat(stored).servers[0]!.enabledTools).toEqual([]);
  });
});

describe("saveMcpServers", () => {
  test("round-trips through the storage key", () => {
    const servers: StoredMcpServer[] = [
      { id: "x", name: "X", config: httpConfig, enabled: true, enabledTools: "all" },
    ];
    saveMcpServers(storage, servers);
    expect(JSON.parse(storage.getString(MCP_STORAGE_KEY)!)).toEqual(servers);
    expect(loadMcpServers(storage)).toEqual(servers);
  });
});

describe("MCP event parsing", () => {
  test("splitMcpToolName splits namespaced names and passes plain names through", () => {
    expect(splitMcpToolName("mcp__abc123__read_file")).toEqual({
      server: "abc123",
      tool: "read_file",
    });
    // Tool names may themselves contain `__` — only the first separator splits.
    expect(splitMcpToolName("mcp__srv__do__thing")).toEqual({
      server: "srv",
      tool: "do__thing",
    });
    expect(splitMcpToolName("calculator")).toEqual({ server: "", tool: "calculator" });
  });

  test("summarizeToolArgs returns parameter names only, never values", () => {
    expect(summarizeToolArgs(JSON.stringify({ path: "/secret", token: "xyz" }))).toBe(
      "path, token",
    );
    expect(summarizeToolArgs(undefined)).toBe("");
    expect(summarizeToolArgs("not json")).toBe("");
    expect(summarizeToolArgs(JSON.stringify([1, 2]))).toBe("");
  });

  test("summarizeToolResult reports char count on success, truncated error on failure", () => {
    expect(summarizeToolResult("hello", false)).toBe("5 chars");
    expect(summarizeToolResult("x", false)).toBe("1 char");
    expect(summarizeToolResult("boom", true)).toBe("boom");
    expect(summarizeToolResult("", true)).toBe("the tool reported an error");
    expect(summarizeToolResult("e".repeat(200), true).endsWith("…")).toBe(true);
  });

  test("parseMcpToolEvent parses a call frame (args summarized, no values)", () => {
    const event = parseMcpToolEvent({
      type: "mcp_tool_call",
      choices: [
        {
          delta: {
            tool_calls: [
              {
                id: "call_1",
                function: {
                  name: "mcp__fs__read_file",
                  arguments: JSON.stringify({ path: "/etc/hosts" }),
                },
              },
            ],
          },
        },
      ],
    });
    expect(event).toEqual({
      kind: "call",
      id: "call_1",
      server: "fs",
      tool: "read_file",
      argsSummary: "path",
    });
  });

  test("parseMcpToolEvent parses a result frame and a non-MCP frame is null", () => {
    expect(
      parseMcpToolEvent({
        type: "mcp_tool_result",
        tool_call_id: "call_1",
        is_error: false,
        content: "ok",
      }),
    ).toEqual({ kind: "result", id: "call_1", ok: true, summary: "2 chars" });

    expect(
      parseMcpToolEvent({ type: "mcp_tool_result", tool_call_id: "c2", is_error: true, content: "nope" }),
    ).toEqual({ kind: "result", id: "c2", ok: false, summary: "nope" });

    expect(
      parseMcpToolEvent({ provider: "groq", choices: [{ delta: { content: "hi" } }] }),
    ).toBeNull();
  });
});
