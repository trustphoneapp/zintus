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
  /** Private Mode: refuse providers that train on user data. */
  blockTraining?: boolean;
  /** Explicit opt-in to training providers (overrides a block). */
  allowTraining?: boolean;
  onChunk: (text: string) => void;
  signal?: AbortSignal;
}

/**
 * Per-response transparency metadata derived ENTIRELY from gateway response
 * headers (set before the body streams, so available the moment the fetch
 * resolves). These carry only derived integers/ratios — never keys, prompt
 * content, or secrets — and are the data behind the in-chat "response
 * intelligence" footer that makes Zintus's compression moat visible.
 *
 * Compression fields are present ONLY when real compression happened; the
 * gateway omits the headers (rather than emitting zeros) otherwise.
 */
export interface ResponseMeta {
  /** "hit" | "miss" | "stale" … — gateway cache outcome. */
  cacheHit: string;
  /** How many providers the router fell through before one served. */
  failoverCount: number;
  originalTokens?: number;
  compressedTokens?: number;
  tokensSaved?: number;
  /** Compressed/original ratio in 0..1 (e.g. 0.85 = compressed to 85%). */
  compressionRatio?: number;
  /** Estimate-only USD saved on the compressed input tokens (from headers). */
  costSavedUsd?: number;
  // --- From the per-response `metadata` SSE frame (emitted before [DONE]). ---
  /** Post-compression input tokens the provider actually billed. */
  inputTokens?: number;
  outputTokens?: number;
  /** End-to-end provider latency for this turn. */
  latencyMs?: number;
  /** Estimate-only USD this turn cost (0 on free tiers). */
  costUsd?: number;
  /** Estimate-only USD this turn would have cost on a Claude Sonnet baseline. */
  savedVsBaselineUsd?: number;
  /** Routing strategy the gateway actually used (e.g. "fastest"). */
  routingStrategy?: string;
}

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

interface GatewayChunk {
  choices?: Array<{ delta?: { content?: string } }>;
  provider?: ProviderId;
  model?: string;
  thread_id?: string;
  error?: { message?: string };
  // Per-response metadata frame (type:"metadata", choices:[]). Carries the
  // transparency signals the moat footer surfaces.
  type?: string;
  tokens?: { input?: number; output?: number };
  latency_ms?: number;
  cost_usd?: number;
  saved_vs_claude_sonnet?: number;
  routing_strategy?: string;
}

export async function streamChat({
  providerId,
  strategy,
  mode,
  messages,
  threadId,
  blockTraining,
  allowTraining,
  onChunk,
  signal,
}: StreamChatParams): Promise<{
  providerId: ProviderId;
  model: string;
  threadId?: string;
  traceId?: string;
  meta: ResponseMeta;
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
      block_training: blockTraining,
      allow_training: allowTraining,
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

      // The per-response `metadata` frame rides the stream just before [DONE]
      // (it has choices:[], so the delta read below skips it). Capture its
      // transparency signals into the header-derived meta object.
      if (chunk.type === "metadata") {
        if (chunk.tokens?.input != null) meta.inputTokens = chunk.tokens.input;
        if (chunk.tokens?.output != null) meta.outputTokens = chunk.tokens.output;
        if (chunk.latency_ms != null) meta.latencyMs = chunk.latency_ms;
        if (chunk.cost_usd != null) meta.costUsd = chunk.cost_usd;
        if (chunk.saved_vs_claude_sonnet != null) {
          meta.savedVsBaselineUsd = chunk.saved_vs_claude_sonnet;
        }
        if (chunk.routing_strategy != null) {
          meta.routingStrategy = chunk.routing_strategy;
        }
        continue;
      }

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
    meta,
  };
}
