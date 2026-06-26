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

/**
 * Tokzen compression savings for a single chat response, parsed from the
 * gateway's derived-only `X-Zintus-*` headers. The gateway emits these ONLY
 * when real compression happened (compressedTokens < originalTokens); the USD
 * figure is an ESTIMATE off a non-billing pricing table.
 */
export interface CompressionStats {
  originalTokens: number;
  compressedTokens: number;
  tokensSaved: number;
  /** compressed/original ratio in 0..1 (e.g. 0.36 = compressed to 36%). */
  ratio: number;
  /** Estimate only — omitted when the gateway can't price the saved tokens. */
  costSavedUsd?: number;
}

function parseHeaderNumber(value: string | null): number | null {
  if (value == null || value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Read the compression headers off a chat response. Returns null unless a real
 * saving is present — matching the gateway, which omits the headers entirely
 * when no compression happened (so the badge shows nothing).
 */
export function readCompressionStats(headers: Headers): CompressionStats | null {
  const originalTokens = parseHeaderNumber(headers.get("X-Zintus-Original-Tokens"));
  const compressedTokens = parseHeaderNumber(
    headers.get("X-Zintus-Compressed-Tokens"),
  );
  const tokensSaved = parseHeaderNumber(headers.get("X-Zintus-Tokens-Saved"));
  const ratio = parseHeaderNumber(headers.get("X-Zintus-Compression-Ratio"));
  if (
    originalTokens == null ||
    compressedTokens == null ||
    tokensSaved == null ||
    ratio == null ||
    tokensSaved <= 0 ||
    compressedTokens >= originalTokens
  ) {
    return null;
  }
  const costSavedUsd = parseHeaderNumber(headers.get("X-Zintus-Cost-Saved-Usd"));
  return {
    originalTokens,
    compressedTokens,
    tokensSaved,
    ratio,
    ...(costSavedUsd != null && costSavedUsd > 0 ? { costSavedUsd } : {}),
  };
}

/** BYOK-only quota-exhaustion actions the gateway may recommend. */
export type RouteOptionId =
  | "compress_harder"
  | "switch_provider"
  | "use_local"
  | "wait";

export interface RouteOptionAlternative {
  provider: ProviderId;
  model: string;
  estInputPer1M: number;
  estOutputPer1M: number;
}

/** Mirrors the GET /v1/route/options response (derived-only, no secrets). */
export interface RouteOptions {
  provider: ProviderId;
  quotaRemaining: number | null;
  resetIn: number | null;
  resetReason?: string;
  best: RouteOptionId;
  options: RouteOptionId[];
  reason: string;
  alternatives: RouteOptionAlternative[];
  localAvailable: boolean;
}

/**
 * Quota-exhaustion decision for one provider from the gateway's BYOK-only
 * `GET /v1/route/options`. The endpoint never returns a paid/credits option;
 * we render exactly what it sends. Returns null when the gateway is offline or
 * rejects the provider.
 */
export async function fetchRouteOptions(
  provider: ProviderId,
  quotaHint?: number,
): Promise<RouteOptions | null> {
  try {
    const params = new URLSearchParams({ provider });
    if (typeof quotaHint === "number" && quotaHint >= 0 && quotaHint <= 1) {
      params.set("quota", String(quotaHint));
    }
    const response = await fetch(
      `${GATEWAY_URL}/v1/route/options?${params.toString()}`,
      { cache: "no-store", headers: { ...gatewayAuthHeaders() } },
    );
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as RouteOptions;
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
  compression?: CompressionStats;
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
  // Compression savings ride along as response headers (known before streaming).
  const compression = readCompressionStats(response.headers) ?? undefined;
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
    compression,
  };
}
