import type {
  ChatMessage,
  ContextMode,
  ProviderId,
  RoutingStrategy,
} from "@zintus/types";

import { getGatewayUrl } from "./gateway-url";

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
  onChunk: (text: string) => void;
  signal?: AbortSignal;
}

interface GatewayChunk {
  choices?: Array<{ delta?: { content?: string } }>;
  provider?: ProviderId;
  model?: string;
  thread_id?: string;
  error?: { message?: string };
}

export async function streamChat({
  providerId,
  strategy,
  mode,
  messages,
  threadId,
  onChunk,
  signal,
}: StreamChatParams): Promise<{
  providerId: ProviderId;
  model: string;
  threadId?: string;
  traceId?: string;
}> {
  const response = await fetch(`${getGatewayUrl()}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...gatewayAuthHeaders() },
    body: JSON.stringify({
      messages,
      stream: true,
      provider: providerId,
      strategy,
      mode,
      thread_id: threadId,
    }),
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
  let output = "";

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

      traceId = (chunk as { id?: string }).id ?? traceId;
      provider = chunk.provider ?? provider;
      model = chunk.model ?? model;
      resolvedThreadId = chunk.thread_id ?? resolvedThreadId;

      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) {
        output += delta;
        onChunk(output);
      }
    }
  }

  if (!provider) {
    throw new Error("Gateway stream ended without provider metadata");
  }

  return {
    providerId: provider,
    model,
    threadId: resolvedThreadId,
    traceId,
  };
}
