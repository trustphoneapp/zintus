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

import {
  accumulateToolCallDeltas,
  buildChatRequestBody,
  finalizeToolCalls,
  parseChatMeta,
  type ChatMeta,
  type GatewayChunk,
  type ToolCallAccumulator,
} from "./messages";
import { getGatewayUrl } from "./gateway-url";

export type { ChatMeta } from "./messages";
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
  onChunk: (text: string) => void;
  signal?: AbortSignal;
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
  onChunk,
  signal,
}: StreamChatParams): Promise<{
  providerId: ProviderId;
  model: string;
  threadId?: string;
  traceId?: string;
  meta?: ChatMeta;
  /** Tool calls the model made this turn (undefined for a normal text turn). The
   *  caller runs the built-in tools and feeds the results back as tool_result
   *  blocks on the next request. */
  toolCalls?: ToolCallContentBlock[];
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

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let provider: ProviderId | undefined;
  let model = "unknown";
  let resolvedThreadId = threadId;
  let traceId: string | undefined;
  let meta: ChatMeta | undefined;
  let output = "";
  // Accumulate streamed tool-call fragments by their `index`; the pure
  // fold/finalize helpers live in ./messages and are unit-tested directly.
  const toolCallsByIndex: ToolCallAccumulator = new Map();

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

      // Metadata frame (route reason, latency, tokens) — parse and continue;
      // it carries no content delta and its `model` is the resolved winner.
      const frameMeta = parseChatMeta(chunk);
      if (frameMeta) {
        meta = frameMeta;
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
  };
}
