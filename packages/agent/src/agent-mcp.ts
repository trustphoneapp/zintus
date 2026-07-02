import type { ToolDefinition } from "@zintus/types";
import {
  MCPClient,
  type MCPResult,
  type MCPServerConfig,
  type MCPTool,
} from "@zintus/mcp";
import type { ToolExecutionResult } from "./builtin-tools.js";

/** The stored-server shape the agent consumes — structurally identical to the
 *  CLI's `StoredMcpServer` (apps/cli/src/lib/mcp-config.ts), declared here so
 *  the runtime package has no dependency on any one surface's config store. */
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
}

/**
 * MCP tools for the SANDBOXED coding agent (`zintus agent`).
 *
 * The CLI runs on Bun, so — unlike the browser clients — it can host the MCP
 * SDK DIRECTLY: it connects to each configured server IN-PROCESS, lists their
 * tools, and dispatches `mcp__*` tool calls client-side, in the SAME bounded
 * agent loop as the sandboxed file tools. No gateway is involved.
 *
 * SECURITY / HONESTY (same posture as the file-write gate):
 *  - A `stdio` server spawns one of the USER'S OWN local processes, from the
 *    user's own config — exactly as if they'd typed it into a shell. We do not
 *    sandbox it; that choice is theirs (mirrors @zintus/mcp's trust model).
 *  - We NEVER log tool arguments or results verbatim — only secret-safe
 *    summaries (parameter names / sizes).
 *  - Connect failures are surfaced honestly and that server is SKIPPED; the
 *    agent continues with the rest.
 *  - Every connected client is disconnected on exit (success/error/abort) so no
 *    spawned child process is leaked.
 *
 * The file-tool sandbox + write-confirm gate are UNCHANGED; MCP tools join the
 * loop alongside them and the loop stays bounded as before.
 */

/** Namespace prefix for every MCP-backed agent tool. Mirrors the gateway/web
 *  scheme `mcp__<serverId>__<tool>` so behaviour is consistent across surfaces. */
export const MCP_AGENT_PREFIX = "mcp__";

/** Provider tool-name rule (intersection of OpenAI/Gemini): a model-visible name
 *  may only contain these chars and must be 1..64 long. */
const MAX_TOOL_NAME = 64;

/** True for a namespaced MCP agent tool name. */
export function isMcpAgentTool(name: string): boolean {
  return name.startsWith(MCP_AGENT_PREFIX);
}

/** The minimal MCPClient surface the toolset needs — injectable so tests can
 *  supply a fake/in-memory client instead of spawning a real server. */
export interface McpClientLike {
  connect(config: MCPServerConfig): Promise<void>;
  listTools(): Promise<MCPTool[]>;
  callTool(name: string, args: unknown): Promise<MCPResult>;
  disconnect(): Promise<void>;
}

export type McpClientFactory = () => McpClientLike;

/** One server selected for this agent run, with its concrete tool allow-list. */
export interface AgentMcpServerInput {
  name: string;
  config: MCPServerConfig;
  /** Concrete tool names to offer (empty => offer every tool the server lists). */
  enabledTools: string[];
}

export interface AgentMcpConnectOptions {
  /** Build a client per server (default: a real, in-process MCPClient). */
  createClient?: McpClientFactory;
  /** Notified once per server that connected (for the spinner/log line). */
  onConnect?: (info: { server: string; toolCount: number }) => void;
  /** Notified once per server that FAILED to connect (honest, then skipped). */
  onConnectError?: (info: { server: string; message: string }) => void;
}

/** A live set of MCP tools wired into the agent loop. */
export interface AgentMcpToolset {
  /** Namespaced tool definitions to offer the model (alongside the file tools). */
  readonly definitions: ToolDefinition[];
  /** Number of MCP tools available. */
  readonly size: number;
  /** Connected server names (in selection order). */
  readonly connected: string[];
  /** Honest connection failures (server + message); those servers are skipped. */
  readonly errors: { server: string; message: string }[];
  /** True if `name` is one of THIS toolset's MCP tools. */
  has(name: string): boolean;
  /** Execute one `mcp__*` call. NEVER throws — a tool error or a dropped
   *  connection becomes an honest `isError` result the model can recover from. */
  execute(call: {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }): Promise<ToolExecutionResult>;
  /** Disconnect EVERY connected server. Idempotent; never throws. */
  disconnect(): Promise<void>;
}

/** Internal: a namespaced tool bound to its server's client + raw tool name. */
interface BoundMcpTool {
  client: McpClientLike;
  /** The tool name as the server knows it (un-namespaced). */
  toolName: string;
  serverName: string;
}

/** Sanitize one path segment to the provider-allowed charset. */
function sanitizeSegment(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** Build the namespaced, length-capped, collision-free tool name for a server's
 *  tool. The server segment never contains `__` (so the gateway/web
 *  `splitMcpToolName` parses it the same way); uniqueness is enforced by the
 *  caller-supplied `taken` set. */
function namespacedToolName(
  serverName: string,
  toolName: string,
  taken: Set<string>,
): string {
  // Collapse underscores in the server segment so the FIRST `__` after the
  // prefix is always the server/tool boundary.
  const server = sanitizeSegment(serverName).replace(/_+/g, "_") || "server";
  const tool = sanitizeSegment(toolName) || "tool";
  let base = `${MCP_AGENT_PREFIX}${server}__${tool}`;
  if (base.length > MAX_TOOL_NAME) base = base.slice(0, MAX_TOOL_NAME);
  if (!taken.has(base)) return base;
  // Collision: append a numeric suffix, trimming the base to keep room.
  for (let n = 2; ; n += 1) {
    const suffix = `_${n}`;
    const candidate = `${base.slice(0, MAX_TOOL_NAME - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Flatten an MCPResult's content blocks into a single text body, never throwing
 *  and never dumping binary/secret payloads verbatim. Non-text blocks (images,
 *  resources) are summarized as `[<type>]`. */
function mcpResultToText(result: MCPResult): string {
  const parts: string[] = [];
  for (const block of result.content) {
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    } else {
      parts.push(`[${block.type || "content"}]`);
    }
  }
  const text = parts.join("\n").trim();
  return text || "(the tool returned no content)";
}

/**
 * Connect to each selected MCP server in-process, list its tools, and assemble a
 * namespaced toolset for the agent loop. Connection failures are recorded in
 * `errors` and that server is skipped (the agent runs with the rest). Always
 * returns a toolset whose `disconnect()` tears down every client it opened.
 */
export async function connectAgentMcp(
  servers: AgentMcpServerInput[],
  options: AgentMcpConnectOptions = {},
): Promise<AgentMcpToolset> {
  const createClient: McpClientFactory =
    options.createClient ?? (() => new MCPClient({ clientName: "zintus-agent" }));

  const clients: McpClientLike[] = [];
  const definitions: ToolDefinition[] = [];
  const bound = new Map<string, BoundMcpTool>();
  const taken = new Set<string>();
  const connected: string[] = [];
  const errors: { server: string; message: string }[] = [];

  for (const server of servers) {
    const client = createClient();
    try {
      await client.connect(server.config);
      const allTools = await client.listTools();
      // Track the client only AFTER a successful connect so a failed connect
      // (which already cleaned up its own transport) isn't double-closed.
      clients.push(client);
      const allow =
        server.enabledTools.length > 0 ? new Set(server.enabledTools) : null;
      let count = 0;
      for (const tool of allTools) {
        if (allow && !allow.has(tool.name)) continue;
        const name = namespacedToolName(server.name, tool.name, taken);
        taken.add(name);
        bound.set(name, {
          client,
          toolName: tool.name,
          serverName: server.name,
        });
        definitions.push({
          name,
          description: tool.description
            ? `[MCP:${server.name}] ${tool.description}`
            : `[MCP:${server.name}] ${tool.name}`,
          parameters:
            tool.inputSchema && tool.inputSchema.type
              ? tool.inputSchema
              : { type: "object", properties: {} },
        });
        count += 1;
      }
      connected.push(server.name);
      options.onConnect?.({ server: server.name, toolCount: count });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ server: server.name, message });
      options.onConnectError?.({ server: server.name, message });
      // Best-effort cleanup of a half-open client so nothing leaks.
      try {
        await client.disconnect();
      } catch {
        /* best-effort */
      }
    }
  }

  return {
    definitions,
    size: bound.size,
    connected,
    errors,
    has: (name) => bound.has(name),
    execute: async (call) => {
      const target = bound.get(call.name);
      if (!target) {
        return {
          toolCallId: call.id,
          content: JSON.stringify({ error: `unknown MCP tool: ${call.name}` }),
          isError: true,
        };
      }
      try {
        const result = await target.client.callTool(
          target.toolName,
          call.arguments ?? {},
        );
        return {
          toolCallId: call.id,
          content: mcpResultToText(result),
          isError: result.isError === true,
        };
      } catch (error) {
        // A dropped connection (MCPConnectionError) lands here — surfaced as an
        // honest error result, NEVER thrown out of the loop.
        return {
          toolCallId: call.id,
          content: JSON.stringify({
            error: error instanceof Error ? error.message : "MCP tool call failed",
          }),
          isError: true,
        };
      }
    },
    disconnect: async () => {
      await Promise.all(
        clients.map(async (c) => {
          try {
            await c.disconnect();
          } catch {
            /* disconnect must stay clean even on an already-dead transport */
          }
        }),
      );
    },
  };
}

/**
 * Pick which configured MCP servers an agent run should use, resolving each
 * server's `enabledTools` (`"all"` => the concrete discovered list). Pure +
 * exported so the command and tests share one source of truth.
 *
 *  - `disabled` (--no-mcp): selects nothing (file-tool-only, the prior behaviour).
 *  - `only` (--mcp <name…>): selects exactly those configured servers BY NAME
 *    (regardless of their `enabled` flag); names with no match are reported in
 *    `missing`.
 *  - otherwise: selects every `enabled` server (the default).
 */
export function selectAgentMcpServers(
  stored: StoredMcpServer[],
  opts: { only?: string[]; disabled?: boolean } = {},
): { servers: AgentMcpServerInput[]; missing: string[] } {
  if (opts.disabled) return { servers: [], missing: [] };

  const resolve = (server: StoredMcpServer): AgentMcpServerInput => {
    const allNames = (server.tools ?? []).map((t) => t.name);
    const enabledTools =
      server.enabledTools === "all"
        ? allNames
        : server.enabledTools.filter((name) => allNames.includes(name));
    return { name: server.name, config: server.config, enabledTools };
  };

  if (opts.only && opts.only.length > 0) {
    const byName = new Map(stored.map((s) => [s.name, s]));
    const servers: AgentMcpServerInput[] = [];
    const missing: string[] = [];
    for (const name of opts.only) {
      const found = byName.get(name);
      if (found) servers.push(resolve(found));
      else missing.push(name);
    }
    return { servers, missing };
  }

  return { servers: stored.filter((s) => s.enabled).map(resolve), missing: [] };
}
