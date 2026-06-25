import type { ContextMode, ProviderId, RoutingStrategy } from "@zintus/types";

const DEFAULT_GATEWAY_URL = "http://localhost:8788";
const ENV_GATEWAY_URL = process.env.NEXT_PUBLIC_GATEWAY_URL?.trim() || null;
const GATEWAY_TOKEN = process.env.NEXT_PUBLIC_GATEWAY_TOKEN?.trim() || "";

function gatewayAuthHeaders(): Record<string, string> {
  return GATEWAY_TOKEN ? { Authorization: `Bearer ${GATEWAY_TOKEN}` } : {};
}

export interface GatewayProviderStatus {
  id: ProviderId;
  available: boolean;
  hasKey: boolean;
  inCooldown?: boolean;
  quotaUsed?: number;
  quotaLimit?: number | null;
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

function candidateGatewayUrls(): string[] {
  const urls = [ENV_GATEWAY_URL, DEFAULT_GATEWAY_URL].filter(
    (value): value is string => Boolean(value),
  );
  return Array.from(new Set(urls));
}

/** Liveness probe on the public /health ({ ok, auth }), no auth required. */
async function isGatewayLive(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/health`, { cache: "no-store" });
    if (!response.ok) {
      return false;
    }
    const body = (await response.json()) as { ok?: boolean };
    return body.ok === true;
  } catch {
    return false;
  }
}

/**
 * Full snapshot from the auth-gated /v1/status (provider inventory + savings).
 * /health no longer carries this. Sends the bearer token when configured.
 */
async function fetchStatusFromUrl(url: string): Promise<GatewayHealth | null> {
  try {
    const response = await fetch(`${url}/v1/status`, {
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

export function getGatewayUrl(): string {
  return ENV_GATEWAY_URL ?? DEFAULT_GATEWAY_URL;
}

export async function resolveGatewayUrl(): Promise<string | null> {
  for (const url of candidateGatewayUrls()) {
    if (await isGatewayLive(url)) {
      return url;
    }
  }
  return null;
}

export async function fetchGatewayHealth(): Promise<{
  url: string;
  health: GatewayHealth;
} | null> {
  for (const url of candidateGatewayUrls()) {
    // Liveness first (unauthenticated, cheap), then the authed detail snapshot.
    if (!(await isGatewayLive(url))) {
      continue;
    }
    const status = await fetchStatusFromUrl(url);
    // Live but status unavailable (e.g. 401 from a token mismatch): surface as
    // not-ready rather than fabricating an "online, zero providers" snapshot —
    // matches the web/mobile clients, which return null on a non-OK /v1/status.
    if (!status) {
      return null;
    }
    return { url, health: status };
  }
  return null;
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
  signal?: AbortSignal;
  onChunk: (text: string) => void;
}): Promise<{
  providerId: ProviderId;
  model: string;
  threadId?: string;
  traceId?: string;
}> {
  const gatewayUrl = await resolveGatewayUrl();
  if (!gatewayUrl) {
    throw new Error(
      "Gateway is unavailable. Start it with `zintus serve` " +
        "(or set NEXT_PUBLIC_GATEWAY_URL to your gateway).",
    );
  }

  const response = await fetch(`${gatewayUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...gatewayAuthHeaders() },
    body: JSON.stringify({
      messages: params.messages,
      stream: true,
      // Per-request picker override wins; otherwise fall back to the
      // configured default provider from settings.
      provider: params.providerId ?? params.defaultProvider,
      strategy: params.strategy,
      mode: params.mode,
      thread_id: params.threadId,
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
  };
}
