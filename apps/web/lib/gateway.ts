import type { ContextMode, ProviderId, RoutingStrategy } from "@zintus/types";

export const GATEWAY_URL =
  process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:8788";

const GATEWAY_TOKEN = process.env.NEXT_PUBLIC_GATEWAY_TOKEN?.trim() || "";

/** Bearer header for the gateway, when a token is configured (network deploys). */
export function gatewayAuthHeaders(): Record<string, string> {
  return GATEWAY_TOKEN ? { Authorization: `Bearer ${GATEWAY_TOKEN}` } : {};
}

/** True when the gateway runs on this machine (safe to pass BYOK keys to). */
function isLoopbackGateway(): boolean {
  try {
    const host = new URL(GATEWAY_URL).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

/**
 * Read a Server-Sent-Events response, invoking `onData` with each parsed
 * `data:` JSON payload. Hardened vs the SSE spec: handles CRLF/CR/LF line
 * terminators, skips unparseable/partial frames, and always releases the reader
 * lock so the socket is torn down promptly on completion, error, or abort.
 */
async function readSseData(
  response: Response,
  onData: (payload: unknown) => void,
): Promise<void> {
  if (!response.body) {
    throw new Error("Gateway returned no response body");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r\n|\r|\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(payload);
        } catch {
          continue; // skip malformed/partial frames
        }
        onData(parsed);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export interface GatewayProviderStatus {
  id: ProviderId;
  available: boolean;
  hasKey: boolean;
  inCooldown?: boolean;
  quotaUsed?: number;
  quotaLimit?: number;
}

export interface GatewaySavings {
  estimatedUsdSaved: number;
  byProvider: Record<string, number>;
  note?: string;
}

export interface GatewayHealth {
  ok: boolean;
  providers: GatewayProviderStatus[];
  savings?: GatewaySavings;
}

export function getGatewayUrl(): string {
  return GATEWAY_URL;
}

/**
 * Full gateway snapshot (provider inventory + savings). Sourced from the
 * auth-gated `/v1/status`: the public `/health` is intentionally minimal
 * (`{ ok, auth }`) and no longer exposes provider topology. Sends the bearer
 * token when one is configured; a 401/offline gateway returns null.
 */
export async function fetchGatewayHealth(): Promise<GatewayHealth | null> {
  try {
    const response = await fetch(`${GATEWAY_URL}/v1/status`, {
      cache: "no-store",
      headers: { ...gatewayAuthHeaders() },
    });
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as GatewayHealth;
  } catch {
    return null;
  }
}

export async function fetchLastTrace(): Promise<{
  trace?: {
    traceId: string;
    attempts: Array<{
      providerId: ProviderId;
      model: string;
      status: string;
      latencyMs: number;
      errorMessage?: string;
    }>;
    winner?: { providerId: ProviderId; model: string };
    totalLatencyMs?: number;
  };
} | null> {
  try {
    const response = await fetch(`${GATEWAY_URL}/v1/traces/last`, {
      cache: "no-store",
      headers: { ...gatewayAuthHeaders() },
    });
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as {
      trace?: {
        traceId: string;
        attempts: Array<{
          providerId: ProviderId;
          model: string;
          status: string;
          latencyMs: number;
          errorMessage?: string;
        }>;
        winner?: { providerId: ProviderId; model: string };
        totalLatencyMs?: number;
      };
    };
  } catch {
    return null;
  }
}

export interface GatewayTrace {
  traceId: string;
  attempts: Array<{
    providerId: ProviderId;
    model: string;
    status: string;
    latencyMs: number;
    errorMessage?: string;
  }>;
  winner?: { providerId: ProviderId; model: string };
  totalLatencyMs?: number;
}

/** Recent request traces (newest first) for the usage page's failover history. */
export async function fetchGatewayTraces(
  limit = 5,
): Promise<GatewayTrace[]> {
  try {
    const response = await fetch(`${GATEWAY_URL}/v1/traces?limit=${limit}`, {
      cache: "no-store",
      headers: { ...gatewayAuthHeaders() },
    });
    if (!response.ok) {
      return [];
    }
    const body = (await response.json()) as { traces?: GatewayTrace[] };
    return body.traces ?? [];
  } catch {
    return [];
  }
}

export async function fetchGatewayModels(): Promise<string[] | null> {
  try {
    const response = await fetch(`${GATEWAY_URL}/v1/models`, {
      cache: "no-store",
      headers: { ...gatewayAuthHeaders() },
    });
    if (!response.ok) {
      return null;
    }
    const body = (await response.json()) as {
      data?: Array<{ id: string; owned_by?: string }>;
    };
    return (body.data ?? []).map((model) =>
      model.owned_by ? `${model.id} (${model.owned_by})` : model.id,
    );
  } catch {
    return null;
  }
}

export async function fetchGatewayThreads(): Promise<
  Array<{ id: string; title: string }> | null
> {
  try {
    const response = await fetch(`${GATEWAY_URL}/v1/threads`, {
      cache: "no-store",
      headers: { ...gatewayAuthHeaders() },
    });
    if (!response.ok) {
      return null;
    }
    const body = (await response.json()) as {
      threads?: Array<{ id: string; title?: string }>;
    };
    return (body.threads ?? []).map((thread) => ({
      id: thread.id,
      title: thread.title ?? "(untitled)",
    }));
  } catch {
    return null;
  }
}

export interface ResearchSource {
  title: string;
  url: string;
  content: string;
  score?: number;
}

/** Mirrors @zintus/search DeepResearchEvent (parsed from the /v1/research SSE). */
export type ResearchEvent =
  | { type: "queries"; queries: string[] }
  | { type: "search_start"; index: number; query: string }
  | { type: "search_complete"; index: number; results: ResearchSource[] }
  | { type: "synthesizing"; sourceCount: number }
  | { type: "answer_chunk"; text: string }
  | { type: "done"; sources: ResearchSource[] }
  | { type: "error"; message: string };

export type ResearchDepth = "quick" | "standard" | "deep";

export async function streamResearch(params: {
  query: string;
  depth: ResearchDepth;
  signal?: AbortSignal;
  onEvent: (event: ResearchEvent) => void;
}): Promise<void> {
  const response = await fetch(`${GATEWAY_URL}/v1/research`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...gatewayAuthHeaders() },
    body: JSON.stringify({ query: params.query, depth: params.depth }),
    signal: params.signal,
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    throw new Error(body?.error?.message ?? `Research error ${response.status}`);
  }
  // The endpoint sends both `event: <type>` and `data: <json>`; the JSON
  // carries its own `type`, so we only consume the data lines.
  await readSseData(response, (payload) => {
    params.onEvent(payload as ResearchEvent);
  });
}

interface GatewayChunk {
  id?: string;
  type?: string;
  provider?: ProviderId;
  model?: string;
  thread_id?: string;
  choices?: Array<{ delta?: { content?: string } }>;
  error?: { message?: string };
  // metadata-event fields (type === "metadata")
  tokens?: { input?: number; output?: number };
  latency_ms?: number;
  cost_usd?: number;
  saved_vs_claude_sonnet?: number;
  routing_strategy?: string;
}

/** Per-response transparency metadata (parsed from the SSE metadata event). */
export interface ChatMeta {
  provider: ProviderId;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  costUsd: number;
  savedUsd: number;
  routingStrategy: string;
}

export async function streamGatewayChat(params: {
  messages: Array<{ role: "user" | "assistant" | "system"; content: string }>;
  providerId?: ProviderId;
  defaultProvider?: ProviderId;
  strategy?: RoutingStrategy;
  mode?: ContextMode;
  threadId?: string;
  webSearch?: boolean;
  searchDepth?: "basic" | "standard" | "deep";
  blockTraining?: boolean;
  allowTraining?: ProviderId[];
  keys?: Partial<Record<ProviderId, string>>;
  temperature?: number;
  images?: Array<{ data: string; mimeType: string; name: string }>;
  signal?: AbortSignal;
  onChunk: (text: string) => void;
}): Promise<{
  providerId: ProviderId;
  model: string;
  threadId?: string;
  traceId?: string;
  compileTokens?: number;
  meta?: ChatMeta;
}> {
  const response = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...gatewayAuthHeaders() },
    body: JSON.stringify({
      messages: params.messages,
      stream: true,
      provider: params.providerId ?? params.defaultProvider,
      strategy: params.strategy,
      mode: params.mode,
      thread_id: params.threadId,
      // Matches the gateway's body.search contract (@zintus/search strategies).
      search: params.webSearch
        ? { enabled: true, depth: params.searchDepth ?? "standard" }
        : undefined,
      block_training: params.blockTraining,
      allow_training: params.allowTraining,
      temperature: params.temperature,
      // BYOK keys are only ever sent to a LOCAL gateway — never across the
      // network (would leak keys in a plaintext body to a remote host).
      keys:
        isLoopbackGateway() &&
        params.keys &&
        Object.keys(params.keys).length > 0
          ? params.keys
          : undefined,
      images: params.images ?? [],
    }),
    signal: params.signal,
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    throw new Error(body?.error?.message ?? `Gateway error ${response.status}`);
  }

  let provider: ProviderId | undefined;
  let model = "unknown";
  let resolvedThreadId = params.threadId;
  let traceId: string | undefined;
  let meta: ChatMeta | undefined;
  const compileTokensHeader = response.headers.get("X-Compile-Tokens");
  const compileTokens =
    compileTokensHeader && Number.isFinite(Number(compileTokensHeader))
      ? Number(compileTokensHeader)
      : undefined;
  let output = "";

  await readSseData(response, (payload) => {
    const chunk = payload as GatewayChunk;
    if (chunk.error?.message) {
      throw new Error(chunk.error.message);
    }

    if (chunk.type === "metadata" && chunk.provider) {
      meta = {
        provider: chunk.provider,
        model: chunk.model ?? model,
        inputTokens: chunk.tokens?.input ?? 0,
        outputTokens: chunk.tokens?.output ?? 0,
        latencyMs: chunk.latency_ms ?? 0,
        costUsd: chunk.cost_usd ?? 0,
        savedUsd: chunk.saved_vs_claude_sonnet ?? 0,
        routingStrategy: chunk.routing_strategy ?? "auto",
      };
      return;
    }

    traceId = chunk.id ?? traceId;
    provider = chunk.provider ?? provider;
    model = chunk.model ?? model;
    resolvedThreadId = chunk.thread_id ?? resolvedThreadId;

    const delta = chunk.choices?.[0]?.delta?.content;
    if (delta) {
      output += delta;
      params.onChunk(output);
    }
  });

  if (!provider) {
    throw new Error("Gateway stream ended without provider metadata");
  }

  return {
    providerId: provider,
    model,
    threadId: resolvedThreadId,
    traceId,
    compileTokens,
    meta,
  };
}
