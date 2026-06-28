import type {
  AppConfig,
  ContentBlock,
  ContextMode,
  ProviderId,
  ResponseFormat,
  ToolCallContentBlock,
  ToolChoice,
  ToolDefinition,
} from "@zintus/types";
import {
  streamGatewayChat,
  resolveGatewayUrl,
  type ChatMcpConfig,
  type CompressionStats,
  type McpToolEvent,
  type ResponseMeta,
} from "./gateway";

export { UnsupportedCapabilityError } from "./gateway";
export type { ChatMcpConfig, McpToolEvent } from "./gateway";

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  /** Plain text, OR an ordered content-block array (text + tool_call/tool_result
   *  blocks for the multi-turn tool loop; images where supported). */
  content: string | ContentBlock[];
}

function isEmptyContent(content: string | ContentBlock[]): boolean {
  if (typeof content === "string") return content.trim() === "";
  return content.length === 0;
}

/**
 * Clean a store-derived conversation before it is sent to the gateway. The
 * tool-execution loop can leave the message store with empty-content assistant
 * bubbles (a tool round with no preamble text) and/or two adjacent assistant
 * turns (one per round). Desktop is always stateless (no threadId), so the store
 * is the only history — replaying it verbatim produces a malformed multi-turn
 * conversation (empty assistant content + adjacent same-role turns) that strict
 * role-alternation providers (e.g. Gemini) reject. This returns a cleaned COPY:
 *   (a) drops any assistant turn whose content is empty (blank string or empty
 *       block array);
 *   (b) merges adjacent same-role turns whose content are both strings (joined
 *       with a newline); non-string (ContentBlock[]) turns are pushed un-merged.
 * Order is preserved and the input is never mutated.
 */
export function sanitizeSendHistory(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    if (m.role === "assistant" && isEmptyContent(m.content)) continue;
    const last = out[out.length - 1];
    if (
      last &&
      last.role === m.role &&
      typeof last.content === "string" &&
      typeof m.content === "string"
    ) {
      last.content = `${last.content}\n${m.content}`;
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  return out;
}

export interface StreamChatResult {
  providerId: ProviderId;
  model: string;
  source: "gateway";
  /** Tokzen savings for this response, when the gateway reported real compression. */
  compression?: CompressionStats;
  /** Per-response transparency signals (latency, saved-vs-baseline, strategy). */
  meta?: ResponseMeta;
  /** Tool calls the model made this turn (empty for a normal text turn). The
   *  caller runs the tools and sends results back as tool_result blocks. */
  toolCalls?: ToolCallContentBlock[];
  /** Ordered server-side MCP tool-loop events this turn (display only — the
   *  gateway already ran the tools). Empty when no MCP servers were configured. */
  toolEvents?: McpToolEvent[];
}

export async function isGatewayAvailable(): Promise<boolean> {
  return (await resolveGatewayUrl()) != null;
}

/**
 * Desktop chat is gateway-only. All routing, failover, quota, cooldown and token
 * accounting live in the gateway/engine (the single source of truth shared with
 * the CLI). The desktop never runs its own router, so there is no second routing
 * implementation that can drift from the gateway's behavior.
 */
export async function streamChat(params: {
  messages: ChatMessage[];
  providerId?: ProviderId;
  mode?: ContextMode;
  settings: AppConfig;
  /** Tool/function definitions for this turn. Requires a tool-capable provider —
   *  the gateway returns a structured 422 otherwise. */
  tools?: ToolDefinition[];
  toolChoice?: ToolChoice;
  /** Structured-output request (e.g. `{ type: "json_object" }`). The gateway
   *  resolves the best level the routed provider can serve; we only render what
   *  it actually returns. */
  responseFormat?: ResponseFormat;
  /** Configured MCP servers for this turn. When present the gateway runs the
   *  tool loop SERVER-SIDE; the desktop only displays the streamed activity. */
  mcp?: ChatMcpConfig;
  signal?: AbortSignal;
  onChunk: (text: string) => void;
  /** Live callback for each server-side MCP tool-loop event (call/result). */
  onMcpToolEvent?: (event: McpToolEvent) => void;
}): Promise<StreamChatResult> {
  const result = await streamGatewayChat({
    messages: params.messages,
    providerId: params.providerId,
    defaultProvider: params.settings.defaultProvider,
    strategy: params.settings.routingStrategy,
    mode: params.mode ?? params.settings.contextMode,
    blockTraining: params.settings.blockTrainingProviders,
    tools: params.tools,
    toolChoice: params.toolChoice,
    responseFormat: params.responseFormat,
    mcp: params.mcp,
    signal: params.signal,
    onChunk: params.onChunk,
    onMcpToolEvent: params.onMcpToolEvent,
  });
  return {
    providerId: result.providerId,
    model: result.model,
    source: "gateway",
    compression: result.compression,
    meta: result.meta,
    toolCalls: result.toolCalls,
    toolEvents: result.toolEvents,
  };
}
