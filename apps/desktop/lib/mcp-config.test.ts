import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { MCPServerConfig, MCPTool } from "@zintus/mcp";
import {
  activeMcpServersForChat,
  addMcpServer,
  isToolEnabled,
  loadMcpServers,
  removeMcpServer,
  toggleEnabledTool,
  updateMcpServer,
  type StoredMcpServer,
} from "./mcp-config";

const KEY = "zintus:desktop-mcp-servers";

// Minimal in-memory localStorage so the pure CRUD can be exercised without a DOM.
function installLocalStorage(): void {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: Storage }).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  } as Storage;
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

beforeEach(() => {
  installLocalStorage();
});

afterEach(() => {
  localStorage.clear();
});

describe("CRUD round-trip", () => {
  test("add → load → update → remove persists through localStorage", () => {
    expect(loadMcpServers()).toEqual([]);

    const a = addMcpServer({
      name: "Files",
      config: stdioConfig,
      enabled: true,
      enabledTools: "all",
    });
    expect(a.id).toBeTruthy();

    const b = addMcpServer({
      name: "Remote",
      config: httpConfig,
      enabled: false,
      enabledTools: "all",
    });

    let loaded = loadMcpServers();
    expect(loaded).toHaveLength(2);
    expect(loaded.map((s) => s.name)).toEqual(["Files", "Remote"]);
    expect(a.id).not.toBe(b.id);

    updateMcpServer(a.id, { name: "Filesystem", lastConnectedAt: 123 });
    loaded = loadMcpServers();
    const updated = loaded.find((s) => s.id === a.id)!;
    expect(updated.name).toBe("Filesystem");
    expect(updated.lastConnectedAt).toBe(123);
    // The other server is untouched.
    expect(loaded.find((s) => s.id === b.id)!.name).toBe("Remote");

    const after = removeMcpServer(a.id);
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(b.id);
    expect(loadMcpServers()).toHaveLength(1);
  });
});

describe("bad-data safety", () => {
  test("malformed JSON yields [] instead of throwing", () => {
    localStorage.setItem(KEY, "{not json");
    expect(loadMcpServers()).toEqual([]);
  });

  test("non-array JSON yields []", () => {
    localStorage.setItem(KEY, JSON.stringify({ foo: 1 }));
    expect(loadMcpServers()).toEqual([]);
  });

  test("array with malformed entries keeps only well-formed servers", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify([
        { id: "ok", name: "Good", config: stdioConfig, enabled: true, enabledTools: "all" },
        { name: "missing id", config: stdioConfig },
        null,
        42,
      ]),
    );
    const loaded = loadMcpServers();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.id).toBe("ok");
  });

  test("no localStorage value returns []", () => {
    expect(loadMcpServers()).toEqual([]);
  });
});

describe("isToolEnabled / toggleEnabledTool", () => {
  const base: StoredMcpServer = {
    id: "s1",
    name: "S",
    config: stdioConfig,
    enabled: true,
    enabledTools: "all",
    tools: [tool("read"), tool("write"), tool("list")],
  };

  test('"all" means every tool is enabled', () => {
    expect(isToolEnabled(base, "read")).toBe(true);
    expect(isToolEnabled(base, "write")).toBe(true);
  });

  test("a disabled server never enables a tool", () => {
    expect(isToolEnabled({ ...base, enabled: false }, "read")).toBe(false);
  });

  test("deselecting one tool expands the sentinel into a concrete list", () => {
    const next = toggleEnabledTool(base, "write");
    expect(next).toEqual(["read", "list"]);
  });

  test("re-selecting the last missing tool collapses back to all", () => {
    const partial: StoredMcpServer = { ...base, enabledTools: ["read", "list"] };
    expect(toggleEnabledTool(partial, "write")).toBe("all");
  });

  test("explicit allow-list honors membership", () => {
    const partial: StoredMcpServer = { ...base, enabledTools: ["read"] };
    expect(isToolEnabled(partial, "read")).toBe(true);
    expect(isToolEnabled(partial, "write")).toBe(false);
  });
});

describe("activeMcpServersForChat — chat-body shape", () => {
  test("only enabled servers are included; disabled ones drop out", () => {
    const stored: StoredMcpServer[] = [
      { id: "a", name: "A", config: stdioConfig, enabled: true, enabledTools: "all", tools: [tool("read")] },
      { id: "b", name: "B", config: httpConfig, enabled: false, enabledTools: "all", tools: [tool("ping")] },
    ];
    const { servers } = activeMcpServersForChat(stored);
    expect(servers).toHaveLength(1);
    expect(servers[0]!.id).toBe("a");
  });

  test('resolves "all" to the concrete discovered tool names', () => {
    const stored: StoredMcpServer[] = [
      {
        id: "a",
        name: "A",
        config: stdioConfig,
        enabled: true,
        enabledTools: "all",
        tools: [tool("read"), tool("write")],
      },
    ];
    expect(activeMcpServersForChat(stored).servers[0]!.enabledTools).toEqual([
      "read",
      "write",
    ]);
  });

  test("an explicit allow-list is filtered to known tools only", () => {
    const stored: StoredMcpServer[] = [
      {
        id: "a",
        name: "A",
        config: stdioConfig,
        enabled: true,
        enabledTools: ["read", "ghost"],
        tools: [tool("read"), tool("write")],
      },
    ];
    // "ghost" isn't a discovered tool — it's dropped.
    expect(activeMcpServersForChat(stored).servers[0]!.enabledTools).toEqual(["read"]);
  });

  test("an enabled-but-untested server contributes an empty tool list", () => {
    const stored: StoredMcpServer[] = [
      { id: "a", name: "A", config: stdioConfig, enabled: true, enabledTools: "all" },
    ];
    const { servers } = activeMcpServersForChat(stored);
    expect(servers).toHaveLength(1);
    expect(servers[0]!.enabledTools).toEqual([]);
  });
});
