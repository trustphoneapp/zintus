import { textOf, type ChatMessage } from "@zintus/types";
import type {
  ContextMode,
  ProviderId,
  ResponseFormat,
  RoutingStrategy,
  ToolCallContentBlock,
  ToolChoice,
  ToolDefinition,
} from "@zintus/types";
// TYPE-ONLY: @zintus/mcp is a server-side package (it pulls in the MCP SDK +
// node:child_process). We import only the config type so the gateway-bound
// payload is shaped correctly — the SDK is NEVER bundled into the RN app.
import type { MCPServerConfig } from "@zintus/mcp";

/**
 * Per-response transparency metadata parsed from the gateway's `metadata` SSE
 * frame (emitted right before [DONE]). Derived integers/strings only — never
 * keys or prompt content. Mirrors web/desktop `ChatMeta` so the phone surfaces
 * the SAME truths ("one Zintus"): which provider/model ran, and WHY.
 */
export interface ChatMeta {
  provider: ProviderId;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  costUsd: number;
  savedUsd: number;
  routingStrategy: string;
  /**
   * Human "why this provider/model" line from the gateway's route trace (e.g.
   * "cheapest healthy provider", "failover after groq rate-limit"). `undefined`
   * when the trace recorded no reason. Surfaced as the assistant top line — the
   * prominent "why this route" signal the cross-platform re-score flagged.
   */
  routeReason?: string;
  /**
   * Privacy-mode honesty: `undefined` when private mode was off, `true` when
   * honored, `false` when the gateway had to use a may-train provider anyway.
   */
  privacyHonored?: boolean;
}

export interface UiMessage extends ChatMessage {
  id: string;
  streaming?: boolean;
  /** Routed provider for this assistant turn (set once the stream resolves). */
  providerId?: ProviderId;
  model?: string;
  /** Transparency metadata for this assistant turn (route reason, latency, …). */
  meta?: ChatMeta;
}

export function createUserMessage(content: string): UiMessage {
  return {
    id: `${Date.now()}-user`,
    role: "user",
    content: content.trim(),
  };
}

export function createAssistantPlaceholder(): UiMessage {
  return {
    id: `${Date.now()}-assistant`,
    role: "assistant",
    content: "",
    streaming: true,
  };
}

export function toChatMessages(messages: UiMessage[]): ChatMessage[] {
  return messages
    .filter((message) => textOf(message.content).trim().length > 0)
    .map(({ role, content }) => ({ role, content }));
}

export function providerLabel(providerId: ProviderId): string {
  return providerId;
}

/** Shape of a single gateway SSE frame we read on the chat stream. The metadata
 *  frame (type === "metadata") carries the route reason + per-response signals;
 *  content frames carry `choices[].delta.content`. */
export interface GatewayChunk {
  id?: string;
  choices?: Array<{
    delta?: {
      content?: string;
      /** Streamed tool-call fragments (OpenAI-compat shape); the gateway emits
       *  each call's name once and its arguments as a (possibly fragmented) JSON
       *  string, keyed/ordered by `index`. */
      tool_calls?: ToolCallDelta[];
    };
    finish_reason?: string | null;
  }>;
  provider?: ProviderId;
  model?: string;
  thread_id?: string;
  error?: { message?: string };
  type?: string;
  tokens?: { input?: number; output?: number };
  latency_ms?: number;
  cost_usd?: number;
  saved_vs_claude_sonnet?: number;
  routing_strategy?: string;
  route_reason?: string;
  private_mode_honored?: boolean;
  // Server-side MCP tool-loop event fields (type === "mcp_tool_call" |
  // "mcp_tool_result"). A result frame carries the call id + outcome at the top
  // level (its `choices` is empty); a call frame reuses the tool-call delta shape.
  tool_call_id?: string;
  is_error?: boolean;
  content?: string;
}

/**
 * Parse the gateway's `metadata` SSE frame into a `ChatMeta`. Returns
 * `undefined` for a non-metadata frame or one missing a provider. Pure +
 * exported (react-native-free) so the `route_reason` parse is unit-tested
 * directly. Mirrors web's `streamGatewayChat` metadata handling exactly.
 */
export function parseChatMeta(chunk: GatewayChunk): ChatMeta | undefined {
  if (chunk.type !== "metadata" || !chunk.provider) {
    return undefined;
  }
  return {
    provider: chunk.provider,
    model: chunk.model ?? "unknown",
    inputTokens: chunk.tokens?.input ?? 0,
    outputTokens: chunk.tokens?.output ?? 0,
    latencyMs: chunk.latency_ms ?? 0,
    costUsd: chunk.cost_usd ?? 0,
    savedUsd: chunk.saved_vs_claude_sonnet ?? 0,
    routingStrategy: chunk.routing_strategy ?? "auto",
    routeReason: chunk.route_reason,
    privacyHonored: chunk.private_mode_honored,
  };
}

/**
 * Build the `/v1/chat/completions` request body. Pure + exported so the
 * provider/strategy/response_format mapping is unit-testable without mocking
 * `fetch`. Mirrors the web/desktop body contract (snake_case `response_format`,
 * `tool_choice`).
 */
export function buildChatRequestBody(params: {
  messages: ChatMessage[];
  providerId?: ProviderId;
  strategy?: RoutingStrategy;
  mode?: ContextMode;
  threadId?: string;
  responseFormat?: ResponseFormat;
  /** Tool definitions sent when the Tools toggle is on. Requires a tool-capable
   *  provider — the gateway returns a structured 422 otherwise. */
  tools?: ToolDefinition[];
  toolChoice?: ToolChoice;
  /** Configured MCP servers for this turn. When present the gateway connects each
   *  server, runs a SERVER-SIDE tool loop, and streams `mcp_tool_call` /
   *  `mcp_tool_result` SSE frames alongside the text. The phone never hosts MCP. */
  mcp?: ChatMcpConfig;
}): Record<string, unknown> {
  return {
    messages: params.messages,
    stream: true,
    provider: params.providerId,
    strategy: params.strategy,
    mode: params.mode,
    thread_id: params.threadId,
    response_format: params.responseFormat,
    tools: params.tools,
    tool_choice: params.toolChoice,
    // Present ONLY when the user has MCP servers enabled. Omitted otherwise so a
    // normal turn carries no `mcp` field at all.
    mcp: params.mcp,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Server-side MCP tool loop — the gateway runs the MCP tools itself and streams
// progress as `mcp_tool_call` / `mcp_tool_result` SSE frames ALONGSIDE the text
// stream. The phone NEVER executes these tools — it only displays them. These
// pure helpers parse a frame into a calm, secret-safe UI event and are unit-
// tested directly. Mirrors apps/web/lib/gateway.ts exactly ("one Zintus").
// ─────────────────────────────────────────────────────────────────────────────

/** The `mcp` block the chat body carries: the gateway connects each server and
 *  runs the tool loop server-side. Shape mirrors @zintus/schemas MCPRequest. */
export interface ChatMcpConfig {
  servers: MCPServerConfig[];
  /** Allow-list of tool names (raw or namespaced). Omit to offer every tool the
   *  servers advertise. */
  enabledTools?: string[];
}

/** One ordered MCP tool-loop event surfaced to the UI. A `call` names the tool;
 *  the matching `result` (same `id`) reports success/char-count or an error. */
export type McpToolEvent =
  | {
      kind: "call";
      /** tool_call id — pairs a later `result` back to this call. */
      id: string;
      /** Server segment of the namespaced name (a stable hash, may be ""). */
      server: string;
      /** Server-local tool name (e.g. "read_file"). */
      tool: string;
      /** Parameter NAMES only — never values (no secret leakage). "" when none. */
      argsSummary: string;
    }
  | {
      kind: "result";
      id: string;
      ok: boolean;
      /** "234 chars" on success, or the (truncated) error message. */
      summary: string;
    };

const MCP_TOOL_PREFIX = "mcp__";

/**
 * Split a gateway MCP tool name `mcp__<serverId>__<tool>` into its parts. The
 * serverId is the hash up to the FIRST `__` after the prefix; the rest is the
 * tool name (which may itself contain `__`). A non-MCP name yields the whole name
 * as `tool`. Mirror of apps/gateway/src/mcp-bridge.ts `parseMcpToolName`.
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
 * A calm, secret-safe summary of tool arguments: the parameter NAMES only, never
 * their values (which may carry secrets). Returns "" for empty / non-object args.
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
 * frame. Matches the gateway frames precisely: `mcp_tool_call` reuses the
 * tool-call delta shape (`choices[0].delta.tool_calls[0]`); `mcp_tool_result`
 * carries `tool_call_id` / `is_error` / `content` at the top level. Pure +
 * exported so the parsing is unit-tested without mocking `fetch`.
 */
export function parseMcpToolEvent(chunk: GatewayChunk): McpToolEvent | null {
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

/** One streamed tool-call fragment from a chat delta (`choices[].delta.tool_calls[]`).
 *  The gateway emits the call's `name` once and its `arguments` as a (possibly
 *  fragmented) JSON string; fragments are keyed/ordered by `index`. */
export interface ToolCallDelta {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

/** Mutable per-`index` accumulator for streamed tool-call fragments. */
export type ToolCallAccumulator = Map<
  number,
  { id: string; name: string; args: string }
>;

/**
 * Fold one chunk's `delta.tool_calls` fragments into the index-keyed accumulator.
 * Concatenates argument fragments in arrival order; a later non-undefined `id`/
 * `name` wins over an earlier blank (the gateway sends name once, args in pieces).
 * Pure + exported so the reassembly is unit-tested without mocking `fetch`.
 * Mirrors web's `accumulateToolCallDeltas` exactly ("one Zintus").
 */
export function accumulateToolCallDeltas(
  acc: ToolCallAccumulator,
  deltas: ToolCallDelta[] | undefined,
): void {
  for (const tc of deltas ?? []) {
    const index = tc.index ?? 0;
    const existing = acc.get(index) ?? { id: "", name: "", args: "" };
    acc.set(index, {
      id: tc.id ?? existing.id,
      name: tc.function?.name ?? existing.name,
      args: existing.args + (tc.function?.arguments ?? ""),
    });
  }
}

/**
 * Finalize the accumulator into ordered `ToolCallContentBlock[]`. Sorted by
 * `index` for deterministic multi-call ordering; malformed/partial argument JSON
 * degrades to `{}` rather than throwing, so a garbled tool call never crashes the
 * chat stream. Pure + exported. Mirrors web's `finalizeToolCalls`.
 */
export function finalizeToolCalls(
  acc: ToolCallAccumulator,
): ToolCallContentBlock[] {
  return [...acc.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, call]) => {
      let parsedArgs: Record<string, unknown> = {};
      try {
        parsedArgs = call.args
          ? (JSON.parse(call.args) as Record<string, unknown>)
          : {};
      } catch {
        parsedArgs = {};
      }
      return {
        type: "tool_call" as const,
        id: call.id || `call_${call.name}_${index}`,
        name: call.name,
        arguments: parsedArgs,
      };
    });
}
