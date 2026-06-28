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
  };
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
