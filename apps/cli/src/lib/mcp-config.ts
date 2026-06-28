import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { MCPServerConfig, MCPTool } from "@zintus/mcp";

/**
 * MCP (Model Context Protocol) servers for the CLI — persisted to
 * ~/.zintus/mcp.json (mirrors the config/projects stores). Keyed by `name`, the
 * CLI identifier the user passes to `zintus mcp <subcommand> <name>`.
 *
 * The CLI does NOT host MCP itself: `zintus chat` (with MCP active) and
 * `zintus mcp test` ask the user's LOCAL gateway (`zintus serve`) to connect to
 * each server, run the bounded tool loop SERVER-SIDE, and stream the resulting
 * `mcp_tool_call` / `mcp_tool_result` events back. This file only stores the
 * config and builds the request payload — it never spawns a process or speaks
 * MCP. A `stdio` server therefore launches a process via the gateway, on the
 * same machine, from the user's own config. No secret/arg ever leaves the box
 * beyond what the user typed into their server config.
 */

// Resolved lazily (not at import) so an override is respected per-call. Honours
// ZINTUS_HOME when set (a clean seam for tests / sandboxed homes); otherwise the
// real home dir, exactly like the other ~/.zintus stores.
function mcpDir(): string {
  return join(process.env.ZINTUS_HOME?.trim() || homedir(), ".zintus");
}
function mcpPath(): string {
  return join(mcpDir(), "mcp.json");
}

/** Where the CLI's chat/test commands reach the gateway. Defaults to the
 *  loopback gateway `zintus serve` binds; override with ZINTUS_GATEWAY_URL. */
export function gatewayUrl(): string {
  return process.env.ZINTUS_GATEWAY_URL?.trim() || "http://127.0.0.1:8788";
}

/** One MCP server as the user configured it. `tools` caches what the last
 *  successful `zintus mcp test` discovered, so the tool list + counts survive
 *  without a live connection. */
export interface StoredMcpServer {
  name: string;
  config: MCPServerConfig;
  /** Whether this server's tools are offered to the model at all. */
  enabled: boolean;
  /** Active tools: `"all"` (default) or an explicit allow-list of tool names. */
  enabledTools: string[] | "all";
  /** Tools discovered by the last successful `test` (display + filter). */
  tools?: MCPTool[];
  /** Epoch ms of the last successful connection. */
  lastConnectedAt?: number;
  /** Honest message from the last failed connection (cleared on success). */
  lastError?: string;
}

interface McpFile {
  servers: StoredMcpServer[];
}

/** True for a value shaped like a StoredMcpServer, so a corrupt write can't
 *  crash a command — malformed entries are dropped, not thrown on. */
function isStoredServer(entry: unknown): entry is StoredMcpServer {
  return (
    Boolean(entry) &&
    typeof entry === "object" &&
    typeof (entry as StoredMcpServer).name === "string" &&
    Boolean((entry as StoredMcpServer).config) &&
    typeof (entry as StoredMcpServer).config === "object"
  );
}

/** Load all stored servers. Never throws: a missing/corrupt file yields `[]`. */
export async function loadMcpServers(): Promise<StoredMcpServer[]> {
  try {
    const parsed = JSON.parse(await readFile(mcpPath(), "utf-8")) as Partial<McpFile>;
    if (!parsed || !Array.isArray(parsed.servers)) {
      return [];
    }
    return parsed.servers.filter(isStoredServer);
  } catch {
    return [];
  }
}

/** Persist the full list (0600, like the other ~/.zintus stores). */
export async function saveMcpServers(servers: StoredMcpServer[]): Promise<void> {
  await mkdir(mcpDir(), { recursive: true });
  await writeFile(mcpPath(), JSON.stringify({ servers }, null, 2), { mode: 0o600 });
}

/** Look up one server by name (case-sensitive, the CLI identifier). */
export async function getMcpServer(name: string): Promise<StoredMcpServer | null> {
  return (await loadMcpServers()).find((s) => s.name === name) ?? null;
}

/** Add (or replace, by name) a server and persist. The newest entry wins so a
 *  re-`add` of the same name updates the config rather than duplicating it. */
export async function addMcpServer(server: StoredMcpServer): Promise<void> {
  const without = (await loadMcpServers()).filter((s) => s.name !== server.name);
  await saveMcpServers([server, ...without]);
}

/** Merge `patch` into the named server and persist. Returns true when it existed. */
export async function updateMcpServer(
  name: string,
  patch: Partial<Omit<StoredMcpServer, "name">>,
): Promise<boolean> {
  const servers = await loadMcpServers();
  const found = servers.some((s) => s.name === name);
  if (!found) {
    return false;
  }
  await saveMcpServers(
    servers.map((s) => (s.name === name ? { ...s, ...patch } : s)),
  );
  return true;
}

/** Remove the named server and persist. Returns true when it existed. */
export async function removeMcpServer(name: string): Promise<boolean> {
  const servers = await loadMcpServers();
  const next = servers.filter((s) => s.name !== name);
  const existed = next.length !== servers.length;
  if (existed) {
    await saveMcpServers(next);
  }
  return existed;
}

/** The active-server payload entry for a chat: enabled servers only, with the
 *  `"all"` sentinel resolved against discovered tools into a concrete list. */
export interface ActiveMcpServer {
  name: string;
  config: MCPServerConfig;
  /** Concrete tool names allowed for this server (never the `"all"` sentinel). */
  enabledTools: string[];
}

/**
 * Build the active-server list from stored servers. Only `enabled` servers are
 * included; `enabledTools` is resolved against the server's discovered tools so
 * `"all"` becomes the concrete list (and an enabled server not yet tested
 * contributes an empty list — the gateway then offers everything it discovers).
 * Pure + exported so the chat command and tests share one source of truth.
 */
export function activeMcpServersForChat(stored: StoredMcpServer[]): {
  servers: ActiveMcpServer[];
} {
  const servers = stored
    .filter((server) => server.enabled)
    .map((server) => {
      const allNames = (server.tools ?? []).map((t) => t.name);
      const enabledTools =
        server.enabledTools === "all"
          ? allNames
          : server.enabledTools.filter((name) => allNames.includes(name));
      return { name: server.name, config: server.config, enabledTools };
    });
  return { servers };
}

/** The `mcp` block a chat request carries (mirrors @zintus/schemas MCPRequest):
 *  the gateway connects each server and runs the tool loop server-side. */
export interface ChatMcpConfig {
  servers: MCPServerConfig[];
  /** Allow-list of tool names. Omitted when no concrete names are known yet, so
   *  the gateway offers every tool it discovers rather than suppressing them. */
  enabledTools?: string[];
}

/**
 * Flatten stored servers into the chat-request `mcp` block, or `undefined` when
 * nothing is enabled (so the caller sends a normal, non-MCP request). Mirrors the
 * web's `activeMcpForChat`: concrete tool names are flattened across servers and
 * an empty allow-list is dropped. Pure + exported for tests.
 */
export function buildChatMcpConfig(
  stored: StoredMcpServer[],
): ChatMcpConfig | undefined {
  const { servers } = activeMcpServersForChat(stored);
  if (servers.length === 0) {
    return undefined;
  }
  const enabledTools = servers.flatMap((s) => s.enabledTools);
  return {
    servers: servers.map((s) => s.config),
    ...(enabledTools.length > 0 ? { enabledTools } : {}),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Server-side MCP tool-loop events — the gateway runs the tools and streams
// `mcp_tool_call` / `mcp_tool_result` SSE frames alongside the text. The CLI
// only DISPLAYS them. These pure helpers parse a frame into a calm, secret-safe
// event and format the inline line — unit-tested without any network.
// ─────────────────────────────────────────────────────────────────────────────

const MCP_TOOL_PREFIX = "mcp__";

/** One streamed SSE chunk, narrowed to the fields the MCP frames use. */
export interface GatewayMcpChunk {
  type?: string;
  choices?: Array<{
    delta?: {
      /** Answer text on a normal chat delta — ignored by the MCP parser, present
       *  so a full chat chunk is assignable to this narrowed shape. */
      content?: string;
      tool_calls?: Array<{
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
  tool_call_id?: string;
  is_error?: boolean;
  content?: string;
}

/** One ordered MCP tool-loop event surfaced to the terminal. */
export type McpToolEvent =
  | { kind: "call"; id: string; server: string; tool: string; argsSummary: string }
  | { kind: "result"; id: string; ok: boolean; summary: string };

/**
 * Split a gateway MCP tool name `mcp__<serverId>__<tool>` into its parts. The
 * serverId is the segment up to the FIRST `__` after the prefix; the rest is the
 * tool name (which may itself contain `__`). A non-MCP name yields the whole name
 * as `tool`. Mirrors the gateway's `parseMcpToolName`.
 */
export function splitMcpToolName(name: string): { server: string; tool: string } {
  if (!name.startsWith(MCP_TOOL_PREFIX)) {
    return { server: "", tool: name };
  }
  const rest = name.slice(MCP_TOOL_PREFIX.length);
  const sep = rest.indexOf("__");
  if (sep <= 0) {
    return { server: "", tool: rest };
  }
  return { server: rest.slice(0, sep), tool: rest.slice(sep + 2) };
}

/**
 * A secret-safe summary of tool arguments: the parameter NAMES only, never their
 * values (which may carry secrets/paths). Returns "" for empty / non-object args.
 */
export function summarizeToolArgs(raw: string | undefined): string {
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return Object.keys(parsed as Record<string, unknown>).join(", ");
    }
  } catch {
    // not JSON — show nothing rather than dumping a raw fragment
  }
  return "";
}

/**
 * A short result summary: the char count on success, or the (truncated) message
 * on error. Never dumps the full body — honesty without leaking large/secret
 * tool output into the transcript.
 */
export function summarizeToolResult(
  content: string | undefined,
  isError: boolean,
): string {
  const text = content ?? "";
  if (isError) {
    const msg = text.trim() || "the tool reported an error";
    return msg.length > 120 ? `${msg.slice(0, 117)}…` : msg;
  }
  const n = text.length;
  return `${n} char${n === 1 ? "" : "s"}`;
}

/**
 * Parse a streamed chunk into an `McpToolEvent`, or null when it isn't an MCP
 * frame. Matches the gateway frames: `mcp_tool_call` reuses the tool-call delta
 * shape; `mcp_tool_result` carries `tool_call_id` / `is_error` / `content` at the
 * top level. Pure + exported (unit-tested without a `fetch` mock).
 */
export function parseMcpToolEvent(chunk: GatewayMcpChunk): McpToolEvent | null {
  if (chunk.type === "mcp_tool_call") {
    const tc = chunk.choices?.[0]?.delta?.tool_calls?.[0];
    if (!tc) return null;
    const name = tc.function?.name ?? "";
    const { server, tool } = splitMcpToolName(name);
    return {
      kind: "call",
      id: tc.id ?? "",
      server,
      tool: tool || name,
      argsSummary: summarizeToolArgs(tc.function?.arguments),
    };
  }
  if (chunk.type === "mcp_tool_result") {
    const isError = chunk.is_error ?? false;
    return {
      kind: "result",
      id: chunk.tool_call_id ?? "",
      ok: !isError,
      summary: summarizeToolResult(chunk.content, isError),
    };
  }
  return null;
}

/**
 * Format one MCP tool-loop event into a calm, inline terminal line — summary
 * only, no secret/arg-value leakage. A `call` shows `<server>.<tool>(names…)`; a
 * `result` shows the char count (✓) or the truncated error (✗). Pure (no chalk)
 * so the wording is unit-testable; the command layer adds colour.
 */
export function formatMcpToolEvent(event: McpToolEvent): string {
  if (event.kind === "call") {
    const target = event.server ? `${event.server}.${event.tool}` : event.tool;
    return `🔧 calling ${target}(${event.argsSummary}) …`;
  }
  return event.ok ? `  ✓ result (${event.summary})` : `  ✗ error: ${event.summary}`;
}
