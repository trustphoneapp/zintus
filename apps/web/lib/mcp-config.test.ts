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
  test("add → load → update → remove persists through localStorage", async () => {
    expect(await loadMcpServers()).toEqual([]);

    const a = await addMcpServer({
      name: "Files",
      config: stdioConfig,
      enabled: true,
      enabledTools: "all",
    });
    expect(a.id).toBeTruthy();

    const b = await addMcpServer({
      name: "Remote",
      config: httpConfig,
      enabled: false,
      enabledTools: "all",
    });

    let loaded = await loadMcpServers();
    expect(loaded).toHaveLength(2);
    expect(loaded.map((s) => s.name)).toEqual(["Files", "Remote"]);
    expect(a.id).not.toBe(b.id);

    await updateMcpServer(a.id, { name: "Filesystem", lastConnectedAt: 123 });
    loaded = await loadMcpServers();
    const updated = loaded.find((s) => s.id === a.id)!;
    expect(updated.name).toBe("Filesystem");
    expect(updated.lastConnectedAt).toBe(123);
    // The other server is untouched.
    expect(loaded.find((s) => s.id === b.id)!.name).toBe("Remote");

    const after = await removeMcpServer(a.id);
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(b.id);
    expect(await loadMcpServers()).toHaveLength(1);
  });
});

describe("bad-JSON safety", () => {
  test("malformed JSON yields [] instead of throwing", async () => {
    localStorage.setItem(KEY, "{not json");
    expect(await loadMcpServers()).toEqual([]);
  });

  test("non-array, non-envelope JSON yields []", async () => {
    localStorage.setItem(KEY, JSON.stringify({ foo: 1 }));
    expect(await loadMcpServers()).toEqual([]);
  });

  test("array with malformed entries keeps only well-formed servers", async () => {
    localStorage.setItem(
      KEY,
      JSON.stringify([
        { id: "ok", name: "Good", config: stdioConfig, enabled: true, enabledTools: "all" },
        { name: "missing id", config: stdioConfig },
        null,
        42,
      ]),
    );
    const loaded = await loadMcpServers();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.id).toBe("ok");
  });

  test("no localStorage value returns []", async () => {
    expect(await loadMcpServers()).toEqual([]);
  });
});

describe("encryption at rest", () => {
  // A secret-bearing config: a bearer header (remote) + an env secret (stdio).
  const secretHttp: MCPServerConfig = {
    transport: "http",
    url: "https://api.example.com/mcp",
    headers: { Authorization: "Bearer sk-super-secret-token-123" },
  };
  const secretStdio: MCPServerConfig = {
    transport: "stdio",
    command: "npx",
    args: ["-y", "server"],
    env: { API_KEY: "env-secret-value-456" },
  };

  test("saveMcpServers never writes credentials as plaintext", async () => {
    await saveMcpServers([
      { id: "h", name: "H", config: secretHttp, enabled: true, enabledTools: "all" },
      { id: "s", name: "S", config: secretStdio, enabled: true, enabledTools: "all" },
    ]);
    const raw = localStorage.getItem(KEY)!;
    // Stored blob is an AES-GCM envelope, not a readable server array.
    const envelope = JSON.parse(raw) as Record<string, unknown>;
    expect(typeof envelope.iv).toBe("string");
    expect(typeof envelope.data).toBe("string");
    // The secrets must not appear anywhere in the ciphertext at rest.
    expect(raw).not.toContain("sk-super-secret-token-123");
    expect(raw).not.toContain("env-secret-value-456");
    expect(raw).not.toContain("Authorization");
  });

  test("round-trips secret configs through encryption", async () => {
    const servers: StoredMcpServer[] = [
      { id: "h", name: "H", config: secretHttp, enabled: true, enabledTools: "all" },
    ];
    await saveMcpServers(servers);
    expect(await loadMcpServers()).toEqual(servers);
  });

  test("legacy plaintext is transparently migrated to an encrypted envelope", async () => {
    // Simulate a store written by an older build: a plaintext JSON array with a
    // live bearer credential.
    const legacy: StoredMcpServer[] = [
      { id: "h", name: "H", config: secretHttp, enabled: true, enabledTools: "all" },
    ];
    localStorage.setItem(KEY, JSON.stringify(legacy));
    // Sanity: the seeded value really is plaintext.
    expect(localStorage.getItem(KEY)).toContain("sk-super-secret-token-123");

    // First load returns the same data (no user-visible breakage / no loss)...
    const loaded = await loadMcpServers();
    expect(loaded).toEqual(legacy);

    // ...and has re-saved it encrypted in place: plaintext credential is gone.
    const raw = localStorage.getItem(KEY)!;
    expect(raw).not.toContain("sk-super-secret-token-123");
    const envelope = JSON.parse(raw) as Record<string, unknown>;
    expect(typeof envelope.iv).toBe("string");
    expect(typeof envelope.data).toBe("string");

    // A subsequent load still decrypts to the same servers.
    expect(await loadMcpServers()).toEqual(legacy);
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
  test("round-trips through the storage key", async () => {
    const servers: StoredMcpServer[] = [
      { id: "x", name: "X", config: httpConfig, enabled: true, enabledTools: "all" },
    ];
    await saveMcpServers(servers);
    // At rest the value is an encrypted envelope, not the raw array...
    expect(Array.isArray(JSON.parse(localStorage.getItem(KEY)!))).toBe(false);
    // ...but it decrypts back to exactly what we stored.
    expect(await loadMcpServers()).toEqual(servers);
  });
});
