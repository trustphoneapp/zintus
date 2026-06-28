import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StoredMcpServer } from "./mcp-config.js";
import {
  activeMcpServersForChat,
  addMcpServer,
  buildChatMcpConfig,
  formatMcpToolEvent,
  getMcpServer,
  loadMcpServers,
  parseMcpToolEvent,
  removeMcpServer,
  saveMcpServers,
  splitMcpToolName,
  summarizeToolArgs,
  summarizeToolResult,
  updateMcpServer,
} from "./mcp-config.js";

// The store writes to <ZINTUS_HOME>/.zintus/mcp.json. Point it at a throwaway dir
// so the CRUD round-trip hits a real temp file without touching real config.
let home: string;
let prev: string | undefined;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "zintus-mcp-"));
  prev = process.env.ZINTUS_HOME;
  process.env.ZINTUS_HOME = home;
});

afterEach(async () => {
  if (prev === undefined) delete process.env.ZINTUS_HOME;
  else process.env.ZINTUS_HOME = prev;
  await rm(home, { recursive: true, force: true });
});

const stdioServer: StoredMcpServer = {
  name: "fs",
  config: { transport: "stdio", command: "npx", args: ["-y", "server-fs"] },
  enabled: true,
  enabledTools: "all",
};

describe("CRUD round-trip", () => {
  it("starts empty, then persists adds across loads", async () => {
    expect(await loadMcpServers()).toEqual([]);

    await addMcpServer(stdioServer);
    const loaded = await loadMcpServers();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.name).toBe("fs");
    expect(await getMcpServer("fs")).not.toBeNull();
  });

  it("re-adding the same name updates rather than duplicating", async () => {
    await addMcpServer(stdioServer);
    await addMcpServer({
      ...stdioServer,
      config: { transport: "http", url: "https://example.com/mcp" },
    });
    const loaded = await loadMcpServers();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.config.transport).toBe("http");
  });

  it("updateMcpServer merges a patch and reports existence", async () => {
    await addMcpServer(stdioServer);
    expect(await updateMcpServer("fs", { enabled: false })).toBe(true);
    expect((await getMcpServer("fs"))!.enabled).toBe(false);
    expect(await updateMcpServer("nope", { enabled: false })).toBe(false);
  });

  it("removeMcpServer reports whether it existed", async () => {
    await addMcpServer(stdioServer);
    expect(await removeMcpServer("fs")).toBe(true);
    expect(await removeMcpServer("fs")).toBe(false);
    expect(await loadMcpServers()).toEqual([]);
  });
});

describe("bad-data safety", () => {
  it("returns [] for missing, malformed, and wrong-shaped files", async () => {
    const path = join(home, ".zintus", "mcp.json");
    // Missing file
    expect(await loadMcpServers()).toEqual([]);

    await saveMcpServers([]); // creates the dir
    await writeFile(path, "{ not json");
    expect(await loadMcpServers()).toEqual([]);

    await writeFile(path, JSON.stringify({ servers: "nope" }));
    expect(await loadMcpServers()).toEqual([]);

    // Drops malformed entries but keeps the well-formed one
    await writeFile(
      path,
      JSON.stringify({ servers: [{ name: 123 }, stdioServer] }),
    );
    const loaded = await loadMcpServers();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.name).toBe("fs");
  });
});

describe("activeMcpServersForChat + buildChatMcpConfig", () => {
  const tools = [
    { name: "read", description: "", inputSchema: { type: "object" as const } },
    { name: "write", description: "", inputSchema: { type: "object" as const } },
  ];

  it("includes only enabled servers and resolves 'all' to concrete tools", () => {
    const stored: StoredMcpServer[] = [
      { name: "on", config: stdioServer.config, enabled: true, enabledTools: "all", tools },
      { name: "off", config: stdioServer.config, enabled: false, enabledTools: "all", tools },
    ];
    const { servers } = activeMcpServersForChat(stored);
    expect(servers).toHaveLength(1);
    expect(servers[0]!.name).toBe("on");
    expect(servers[0]!.enabledTools).toEqual(["read", "write"]);
  });

  it("filters an allow-list down to discovered tool names", () => {
    const stored: StoredMcpServer[] = [
      {
        name: "on",
        config: stdioServer.config,
        enabled: true,
        enabledTools: ["read", "ghost"],
        tools,
      },
    ];
    expect(activeMcpServersForChat(stored).servers[0]!.enabledTools).toEqual(["read"]);
  });

  it("buildChatMcpConfig returns undefined when nothing is enabled", () => {
    expect(buildChatMcpConfig([])).toBeUndefined();
    expect(
      buildChatMcpConfig([
        { name: "off", config: stdioServer.config, enabled: false, enabledTools: "all" },
      ]),
    ).toBeUndefined();
  });

  it("buildChatMcpConfig flattens configs + tool names, omitting an empty allow-list", () => {
    // Enabled but untested (no tools cached) → omit enabledTools so the gateway
    // offers everything it discovers.
    const untested = buildChatMcpConfig([
      { name: "on", config: stdioServer.config, enabled: true, enabledTools: "all" },
    ]);
    expect(untested).toEqual({ servers: [stdioServer.config] });

    const tested = buildChatMcpConfig([
      { name: "on", config: stdioServer.config, enabled: true, enabledTools: "all", tools },
    ]);
    expect(tested).toEqual({
      servers: [stdioServer.config],
      enabledTools: ["read", "write"],
    });
  });
});

describe("MCP tool-event parsing + formatting", () => {
  it("splits namespaced tool names and leaves plain names whole", () => {
    expect(splitMcpToolName("mcp__abc123__read_file")).toEqual({
      server: "abc123",
      tool: "read_file",
    });
    expect(splitMcpToolName("mcp__abc__a__b")).toEqual({ server: "abc", tool: "a__b" });
    expect(splitMcpToolName("plain")).toEqual({ server: "", tool: "plain" });
  });

  it("summarizes args as names only (never values) and results as counts/errors", () => {
    expect(summarizeToolArgs(JSON.stringify({ path: "/secret", limit: 5 }))).toBe(
      "path, limit",
    );
    expect(summarizeToolArgs(undefined)).toBe("");
    expect(summarizeToolArgs("not json")).toBe("");
    expect(summarizeToolResult("hello", false)).toBe("5 chars");
    expect(summarizeToolResult("", true)).toBe("the tool reported an error");
    expect(summarizeToolResult("boom", true)).toBe("boom");
  });

  it("parses call frames and formats them without leaking values", () => {
    const event = parseMcpToolEvent({
      type: "mcp_tool_call",
      choices: [
        {
          delta: {
            tool_calls: [
              {
                id: "c1",
                function: {
                  name: "mcp__srv__read_file",
                  arguments: JSON.stringify({ path: "/etc/passwd" }),
                },
              },
            ],
          },
        },
      ],
    });
    expect(event).toEqual({
      kind: "call",
      id: "c1",
      server: "srv",
      tool: "read_file",
      argsSummary: "path",
    });
    const line = formatMcpToolEvent(event!);
    expect(line).toBe("🔧 calling srv.read_file(path) …");
    expect(line).not.toContain("/etc/passwd");
  });

  it("parses result frames (ok + error) and formats them", () => {
    const ok = parseMcpToolEvent({
      type: "mcp_tool_result",
      tool_call_id: "c1",
      content: "abcd",
    });
    expect(ok).toEqual({ kind: "result", id: "c1", ok: true, summary: "4 chars" });
    expect(formatMcpToolEvent(ok!)).toBe("  ✓ result (4 chars)");

    const err = parseMcpToolEvent({
      type: "mcp_tool_result",
      tool_call_id: "c2",
      is_error: true,
      content: "nope",
    });
    expect(formatMcpToolEvent(err!)).toBe("  ✗ error: nope");
  });

  it("returns null for non-MCP chunks", () => {
    expect(parseMcpToolEvent({ type: "metadata" })).toBeNull();
    expect(parseMcpToolEvent({ choices: [{ delta: { content: "hi" } }] })).toBeNull();
  });
});
