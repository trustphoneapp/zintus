import type { ContextMode, ProviderId, RoutingStrategy } from "@zintus/types";

export const GATEWAY_URL =
  process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:8788";

const GATEWAY_TOKEN = process.env.NEXT_PUBLIC_GATEWAY_TOKEN?.trim() || "";

/** Bearer header for the gateway, when a token is configured (network deploys). */
export function gatewayAuthHeaders(): Record<string, string> {
  return GATEWAY_TOKEN ? { Authorization: `Bearer ${GATEWAY_TOKEN}` } : {};
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

export async function fetchGatewayHealth(): Promise<GatewayHealth | null> {
  try {
    const response = await fetch(`${GATEWAY_URL}/health`, {
      cache: "no-store",
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

interface GatewayChunk {
  id?: string;
  provider?: ProviderId;
  model?: string;
  thread_id?: string;
  choices?: Array<{ delta?: { content?: string } }>;
  error?: { message?: string };
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
  images?: Array<{ data: string; mimeType: string; name: string }>;
  signal?: AbortSignal;
  onChunk: (text: string) => void;
}): Promise<{
  providerId: ProviderId;
  model: string;
  threadId?: string;
  traceId?: string;
  compileTokens?: number;
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

  if (!response.body) {
    throw new Error("Gateway returned no response body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let provider: ProviderId | undefined;
  let model = "unknown";
  let resolvedThreadId = params.threadId;
  let traceId: string | undefined;
  const compileTokensHeader = response.headers.get("X-Compile-Tokens");
  const compileTokens =
    compileTokensHeader && Number.isFinite(Number(compileTokensHeader))
      ? Number(compileTokensHeader)
      : undefined;
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

      traceId = chunk.id ?? traceId;
      provider = chunk.provider ?? provider;
      model = chunk.model ?? model;
      resolvedThreadId = chunk.thread_id ?? resolvedThreadId;

      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) {
        output += delta;
        params.onChunk(output);
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
    compileTokens,
  };
}
