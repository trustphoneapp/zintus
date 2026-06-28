import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { MCPServerConfig, MCPTool } from "@zintus/mcp";
import {
  activeMcpServersForChat,
  addMcpServer,
  isToolEnabled,
  loadMcpServers,
  removeMcpServer,
  saveMcpServers,
  toggleEnabledTool,
  updateMcpServer,
  type StoredMcpServer,
} from "./mcp-config.js";

const KEY = "zintus:mcp-servers";

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

describe("bad-JSON safety", () => {
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
    const next = toggleEnabledTool(server, "write");
    expect(next).toEqual(["read", "list"]);
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

    const c = servers.find((s) => s.id === "c")!;
    expect(c.enabledTools).toEqual(["query"]);

    // The disabled server never appears.
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
    const { servers } = activeMcpServersForChat(stored);
    expect(servers[0]!.enabledTools).toEqual(["read"]);
  });

  test("an enabled server with no discovered tools contributes an empty list", () => {
    const stored: StoredMcpServer[] = [
      {
        id: "a",
        name: "A",
        config: httpConfig,
        enabled: true,
        enabledTools: "all",
      },
    ];
    const { servers } = activeMcpServersForChat(stored);
    expect(servers[0]!.enabledTools).toEqual([]);
  });
});

describe("saveMcpServers", () => {
  test("round-trips through the storage key", () => {
    const servers: StoredMcpServer[] = [
      { id: "x", name: "X", config: httpConfig, enabled: true, enabledTools: "all" },
    ];
    saveMcpServers(servers);
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(servers);
    expect(loadMcpServers()).toEqual(servers);
  });
});
