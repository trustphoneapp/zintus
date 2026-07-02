import type {
  ChatMessage,
  ContextMode,
  ProviderId,
  ResponseFormat,
  RoutingStrategy,
  ToolCallContentBlock,
  ToolChoice,
  ToolDefinition,
} from "@zintus/types";

import type { MCPServerConfig } from "@zintus/mcp";

import {
  accumulateToolCallDeltas,
  buildChatRequestBody,
  finalizeToolCalls,
  parseChatMeta,
  parseMcpToolEvent,
  type ChatMcpConfig,
  type GatewayChunk,
  type McpToolEvent,
  type ResponseMeta,
  type ToolCallAccumulator,
} from "./messages";
import { getGatewayUrl } from "./gateway-url";

export type {
  ChatMeta,
  ChatMcpConfig,
  McpToolEvent,
  ResponseMeta,
} from "./messages";
export { buildChatRequestBody, parseChatMeta } from "./messages";

// Re-exported so existing importers (`@/lib/chat`) keep working; resolution
// (user-saved → env → dev host → localhost) lives in lib/gateway-url.
export { getGatewayUrl } from "./gateway-url";

const GATEWAY_TOKEN = process.env.EXPO_PUBLIC_GATEWAY_TOKEN?.trim() || "";

function gatewayAuthHeaders(): Record<string, string> {
  return GATEWAY_TOKEN ? { Authorization: `Bearer ${GATEWAY_TOKEN}` } : {};
}

export interface StreamChatParams {
  providerId?: ProviderId;
  /** Routing strategy override; only meaningful when no provider is sent. */
  strategy?: RoutingStrategy;
  mode?: ContextMode;
  messages: ChatMessage[];
  threadId?: string;
  /** Structured-output request. `{ type: "json_object" }` asks the provider for
   *  syntactically-valid JSON; the gateway resolves the best level the chosen
   *  provider can actually serve (never claims more than it returns). */
  responseFormat?: ResponseFormat;
  /** Tool definitions sent when the Tools toggle is on. Requires a tool-capable
   *  provider — the gateway returns a structured 422 otherwise. The caller runs
   *  the returned `toolCalls` locally and feeds `tool_result` blocks back. */
  tools?: ToolDefinition[];
  toolChoice?: ToolChoice;
  /** Configured MCP servers for this turn. When present the gateway runs a
   *  SERVER-SIDE tool loop and streams `mcp_tool_call`/`mcp_tool_result` events;
   *  the phone displays them but never executes MCP tools. */
  mcp?: ChatMcpConfig;
  /** Private Mode: refuse providers that train on user data. */
  blockTraining?: boolean;
  /** Explicit opt-in to training providers (overrides a block). */
  allowTraining?: boolean;
  onChunk: (text: string) => void;
  /** Live callback for each server-side MCP tool-loop event (call/result), in
   *  arrival order. The final ordered list is also returned as `toolEvents`. */
  onMcpToolEvent?: (event: McpToolEvent) => void;
  signal?: AbortSignal;
}

// ─────────────────────────────────────────────────────────────────────────────
// MCP (Model Context Protocol) — the phone can't HOST MCP, so the settings screen
// asks the user's local gateway to connect and report a server's capabilities.
// `discoverMcpServer` drives the "Test connection" button. Never throws.
// ─────────────────────────────────────────────────────────────────────────────

/** A successful discovery: the server's advertised tool list + connect time. */
export interface McpDiscoverResult {
  tools: import("@zintus/mcp").MCPTool[];
  /** Epoch ms the gateway connected to the server. */
  connectedAt: number;
}

/**
 * Connect (via the local gateway) to one MCP server and return its advertised
 * tools. NEVER throws: a failed/refused connection or an offline gateway resolves
 * to `{ error }` with an honest, human-readable message so the UI can show it
 * inline instead of crashing. Mirrors web's `discoverMcpServer`.
 */
export async function discoverMcpServer(
  config: MCPServerConfig,
): Promise<McpDiscoverResult | { error: string }> {
  try {
    const response = await fetch(`${getGatewayUrl()}/v1/mcp/discover`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...gatewayAuthHeaders() },
      body: JSON.stringify({ config }),
    });
    const body = (await response.json().catch(() => null)) as {
      tools?: import("@zintus/mcp").MCPTool[];
      connectedAt?: number;
      error?: { message?: string };
    } | null;
    if (!response.ok) {
      return {
        error:
          body?.error?.message ??
          `Couldn't reach the MCP server (gateway error ${response.status}).`,
      };
    }
    return {
      tools: body?.tools ?? [],
      connectedAt: body?.connectedAt ?? Date.now(),
    };
  } catch {
    return {
      error:
        "Couldn't reach the gateway. Start it with `zintus serve` on your computer, then try again.",
    };
  }
}

/**
 * Parse the header-derived half of `ResponseMeta` (see lib/messages): cache
 * outcome, failover count, and the Tokzen compression signals. Headers are set
 * before the body streams, so this base is available the moment the fetch
 * resolves; the SSE `metadata` frame's `ChatMeta` fields are overlaid onto it
 * as the stream ends. Derived integers/ratios only — never keys or content.
 *
 * Compression fields are present ONLY when real compression happened; the
 * gateway omits the headers (rather than emitting zeros) otherwise.
 */
function parseResponseMeta(headers: Headers): ResponseMeta {
  const num = (key: string): number | undefined => {
    const raw = headers.get(key);
    if (raw == null || raw.trim() === "") {
      return undefined;
    }
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
  };
  return {
    cacheHit: headers.get("X-Cache-Hit") ?? "miss",
    failoverCount: num("X-Failover-Count") ?? 0,
    originalTokens: num("X-Zintus-Original-Tokens"),
    compressedTokens: num("X-Zintus-Compressed-Tokens"),
    tokensSaved: num("X-Zintus-Tokens-Saved"),
    compressionRatio: num("X-Zintus-Compression-Ratio"),
    costSavedUsd: num("X-Zintus-Cost-Saved-Usd"),
  };
}

export async function streamChat({
  providerId,
  strategy,
  mode,
  messages,
  threadId,
  responseFormat,
  tools,
  toolChoice,
  mcp,
  blockTraining,
  allowTraining,
  onChunk,
  onMcpToolEvent,
  signal,
}: StreamChatParams): Promise<{
  providerId: ProviderId;
  model: string;
  threadId?: string;
  traceId?: string;
  /** Header-derived base (cache/failover/compression) + the SSE metadata
   *  frame's fields once it arrives. Always present. */
  meta: ResponseMeta;
  /** Tool calls the model made this turn (undefined for a normal text turn). The
   *  caller runs the built-in tools and feeds the results back as tool_result
   *  blocks on the next request. */
  toolCalls?: ToolCallContentBlock[];
  /** Ordered server-side MCP tool-loop events emitted this turn (empty when no
   *  MCP servers were configured). Display-only — the gateway already ran them. */
  toolEvents?: McpToolEvent[];
}> {
  const response = await fetch(`${getGatewayUrl()}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...gatewayAuthHeaders() },
    body: JSON.stringify(
      buildChatRequestBody({
        messages,
        providerId,
        strategy,
        mode,
        threadId,
        responseFormat,
        tools,
        toolChoice,
        mcp,
        blockTraining,
        allowTraining,
      }),
    ),
    signal,
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    throw new Error(body?.error?.message ?? `Gateway error ${response.status}`);
  }

  if (!response.body) {
    throw new Error("Gateway returned no response body");
  }

  // Compression/route metadata rides on the response headers, available now —
  // before a single token of the body has streamed.
  const meta = parseResponseMeta(response.headers);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let provider: ProviderId | undefined;
  let model = "unknown";
  let resolvedThreadId = threadId;
  let traceId: string | undefined;
  let output = "";
  // Accumulate streamed tool-call fragments by their `index`; the pure
  // fold/finalize helpers live in ./messages and are unit-tested directly.
  const toolCallsByIndex: ToolCallAccumulator = new Map();
  // Ordered server-side MCP tool-loop events (call/result). These ride the same
  // stream but are peeled off BEFORE the client tool-call accumulator so an MCP
  // call frame never pollutes the local built-in tool reassembly.
  const toolEvents: McpToolEvent[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) {
        continue;
      }
      const payload = line.slice(6).trim();
      if (payload === "[DONE]") {
        continue;
      }

      const chunk = JSON.parse(payload) as GatewayChunk;
      if (chunk.error?.message) {
        throw new Error(chunk.error.message);
      }

      // Server-side MCP frames first: they reuse the tool-call delta shape, so
      // they must be peeled off BEFORE the client tool-call accumulator below.
      const mcpEvent = parseMcpToolEvent(chunk);
      if (mcpEvent) {
        toolEvents.push(mcpEvent);
        onMcpToolEvent?.(mcpEvent);
        continue;
      }

      // Metadata frame (route reason, latency, tokens) — overlay its ChatMeta
      // fields onto the header-derived base and continue; it carries no content
      // delta and its `model` is the resolved winner. `savedVsBaselineUsd`
      // aliases `savedUsd` for the history/footer contract.
      const frameMeta = parseChatMeta(chunk);
      if (frameMeta) {
        Object.assign(meta, frameMeta);
        meta.savedVsBaselineUsd = frameMeta.savedUsd;
        provider = frameMeta.provider;
        model = frameMeta.model;
        continue;
      }

      traceId = chunk.id ?? traceId;
      provider = chunk.provider ?? provider;
      model = chunk.model ?? model;
      resolvedThreadId = chunk.thread_id ?? resolvedThreadId;

      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) {
        output += delta;
        onChunk(output);
      }

      accumulateToolCallDeltas(
        toolCallsByIndex,
        chunk.choices?.[0]?.delta?.tool_calls,
      );
    }
  }

  if (!provider) {
    throw new Error("Gateway stream ended without provider metadata");
  }

  const toolCalls = finalizeToolCalls(toolCallsByIndex);

  return {
    providerId: provider,
    model,
    threadId: resolvedThreadId,
    traceId,
    meta,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    toolEvents: toolEvents.length > 0 ? toolEvents : undefined,
  };
}
