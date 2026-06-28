// =============================================================================
// MCP bridge — pure-ish helpers that turn MCP server tools into the gateway's
// existing ToolDefinition surface and route a model's tool_call back to the
// owning MCP server for SERVER-SIDE execution.
//
// REUSE: MCP tools become @zintus/types `ToolDefinition`s (the SAME shape the
// providers already convert to OpenAI/Anthropic/Gemini formats) — there is NO
// parallel tool conversion. Execution results become `tool_result` content
// blocks (the SAME shape a client-side tool result rides on).
//
// NAMESPACING: a tool advertised by server `<id>` as `<tool>` is exposed to the
// model as `mcp__<id>__<tool>`. The `mcp__` prefix marks it for server-side
// execution; `<id>` (a hex hash from the registry — never contains `__`) routes
// the call back to the right server; `<tool>` is the server-local name. This is
// collision-safe across servers that advertise same-named tools.
//
// NO-CUSTODY / PRIVACY: tool args + results flow gateway <-> MCP server and
// gateway <-> LLM only — never the relay. This module NEVER logs args/results.
// =============================================================================

import type {
  MCPClient,
  MCPResult,
  MCPServerConfig,
  MCPTool,
} from "@zintus/mcp";
import type {
  JsonSchema,
  ToolCallContentBlock,
  ToolDefinition,
  ToolResultContentBlock,
} from "@zintus/types";

/** Marks a tool name as gateway-hosted MCP (vs a client-side tool). */
const MCP_PREFIX = "mcp__";
/** Segment separator inside a namespaced MCP tool name. */
const SEP = "__";

/** Build the model-visible, namespaced name for a server's tool. */
export function mcpToolName(serverId: string, tool: string): string {
  return `${MCP_PREFIX}${serverId}${SEP}${tool}`;
}

/**
 * Convert a server's advertised tools into ToolDefinitions, namespacing each
 * name as `mcp__<serverId>__<tool>` and passing the MCP `inputSchema` straight
 * through as the ToolDefinition `parameters` (both are an object JSON Schema —
 * no lossy remap). An MCP tool without a schema defaults to an empty object
 * schema so the provider still receives a valid parameter definition.
 */
export function mcpToolsToDefinitions(
  serverId: string,
  tools: MCPTool[],
): ToolDefinition[] {
  return tools.map((t) => ({
    name: mcpToolName(serverId, t.name),
    description: t.description ?? "",
    parameters: (t.inputSchema ?? { type: "object" }) as JsonSchema,
  }));
}

/**
 * Inverse of {@link mcpToolName}: split a model-emitted tool name back into its
 * `{ serverId, tool }`. Returns null when the name is not an MCP tool (a plain
 * client-side tool) so the caller can route it down the existing path. The
 * serverId is the hex segment up to the FIRST `__` after the prefix; everything
 * after is the tool name (which MAY itself contain `__`).
 */
export function parseMcpToolName(
  name: string,
): { serverId: string; tool: string } | null {
  if (!name.startsWith(MCP_PREFIX)) {
    return null;
  }
  const rest = name.slice(MCP_PREFIX.length);
  const sep = rest.indexOf(SEP);
  if (sep <= 0) {
    return null;
  }
  const serverId = rest.slice(0, sep);
  const tool = rest.slice(sep + SEP.length);
  if (!serverId || !tool) {
    return null;
  }
  return { serverId, tool };
}

/** True when a tool_call targets a gateway-hosted MCP tool. */
export function isMcpToolCall(call: { name: string }): boolean {
  return parseMcpToolName(call.name) !== null;
}

/**
 * Flatten an MCPResult's content blocks into a single tool_result string the LLM
 * can read. Text blocks pass through; non-text blocks (image/audio/resource)
 * become a compact descriptor rather than dumping raw base64 into the prompt.
 */
export function mcpResultToText(result: MCPResult): string {
  const parts = result.content.map((block) => {
    if (typeof block.text === "string" && block.text.length > 0) {
      return block.text;
    }
    switch (block.type) {
      case "image":
        return `[image ${block.mimeType ?? "image"}]`;
      case "audio":
        return `[audio ${block.mimeType ?? "audio"}]`;
      case "resource":
      case "resource_link": {
        const uri =
          typeof block.uri === "string"
            ? block.uri
            : typeof (block.resource as { uri?: unknown } | undefined)?.uri ===
                "string"
              ? (block.resource as { uri: string }).uri
              : undefined;
        return uri ? `[resource ${uri}]` : "[resource]";
      }
      default:
        return `[${block.type}]`;
    }
  });
  const text = parts.filter((p) => p.length > 0).join("\n").trim();
  if (text.length > 0) {
    return text;
  }
  // Honest non-empty fallback so the model never sees a blank tool_result.
  return result.isError
    ? "The tool reported an error with no message."
    : "(the tool returned no content)";
}

/** Minimal registry surface the executor needs (the real MCPRegistry satisfies
 *  it; tests inject a fake). */
export interface MCPClientResolver {
  getOrConnect(config: MCPServerConfig): Promise<MCPClient>;
}

/** Build an error tool_result the MODEL can see + recover from (never thrown). */
function errorResult(
  toolCallId: string,
  message: string,
): ToolResultContentBlock {
  return {
    type: "tool_result",
    toolCallId,
    content: message,
    isError: true,
  };
}

/**
 * Execute one MCP tool_call SERVER-SIDE and return a normalized tool_result
 * block. Resolves the owning server from the namespaced name + `configsById`,
 * connects (cached) via the registry, calls the tool, and maps the MCPResult to
 * a tool_result. HONEST + RESILIENT: a tool that reports `isError` becomes a
 * `tool_result` with `isError:true` (the model sees the failure and can
 * recover); a connection/resolution failure ALSO becomes an error tool_result
 * rather than throwing — so a bad server never tears down the whole request.
 *
 * `call.arguments` may contain secrets; it is passed straight to the server and
 * is NEVER logged here.
 */
export async function executeMcpToolCall(
  registry: MCPClientResolver,
  configsById: Map<string, MCPServerConfig>,
  call: ToolCallContentBlock,
): Promise<ToolResultContentBlock> {
  const parsed = parseMcpToolName(call.name);
  if (!parsed) {
    return errorResult(call.id, `Not an MCP tool: ${call.name}`);
  }
  const config = configsById.get(parsed.serverId);
  if (!config) {
    return errorResult(
      call.id,
      `No MCP server is configured for tool "${call.name}".`,
    );
  }
  try {
    const client = await registry.getOrConnect(config);
    const result = await client.callTool(parsed.tool, call.arguments);
    return {
      type: "tool_result",
      toolCallId: call.id,
      content: mcpResultToText(result),
      isError: result.isError,
    };
  } catch (err) {
    return errorResult(
      call.id,
      `MCP tool "${parsed.tool}" failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
