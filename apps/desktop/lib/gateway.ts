import type {
  ContentBlock,
  ContextMode,
  ProviderId,
  RoutingStrategy,
  ToolCallContentBlock,
  ToolChoice,
  ToolDefinition,
} from "@zintus/types";

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
  const gatewayUrl = await resolveGatewayUrl();
  if (!gatewayUrl) {
    return null;
  }
  try {
    const params = new URLSearchParams({ provider });
    if (typeof quotaHint === "number" && quotaHint >= 0 && quotaHint <= 1) {
      params.set("quota", String(quotaHint));
    }
    const response = await fetch(
      `${gatewayUrl}/v1/route/options?${params.toString()}`,
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

/**
 * Per-response transparency signals from the gateway's `metadata` SSE frame
 * (emitted right before [DONE]). Derived integers/ratios only — never keys or
 * prompt content. Drives the response footer alongside CompressionStats.
 */
export interface ResponseMeta {
  inputTokens?: number;
  outputTokens?: number;
  /** End-to-end provider latency for this turn (ms). */
  latencyMs?: number;
  /** Estimate-only USD this turn cost (0 on free tiers). */
  costUsd?: number;
  /** Estimate-only USD this turn would have cost on a Claude Sonnet baseline. */
  savedVsBaselineUsd?: number;
  /** Routing strategy the gateway actually used (e.g. "fastest"). */
  routingStrategy?: string;
}

interface GatewayChunk {
  id?: string;
  provider?: ProviderId;
  model?: string;
  thread_id?: string;
  choices?: Array<{
    delta?: {
      content?: string;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
  error?: { message?: string };
  // Per-response metadata frame (type:"metadata", choices:[]).
  type?: string;
  tokens?: { input?: number; output?: number };
  latency_ms?: number;
  cost_usd?: number;
  saved_vs_claude_sonnet?: number;
  routing_strategy?: string;
}

/** One actionable provider suggestion from the gateway's capability error. */
export interface CapabilitySuggestion {
  provider: string;
  reason: string;
}

/**
 * Thrown when the gateway refuses a request because the chosen route can't serve
 * a required capability (today: vision). Carries the gateway's honest, no-upsell
 * `message` + `suggestions` so the UI can render them instead of crashing on a
 * generic error. Mirrors the 422 `{error:{type:"unsupported_capability",…}}`
 * body and the web client's `UnsupportedCapabilityError`.
 */
export class UnsupportedCapabilityError extends Error {
  readonly required: string[];
  readonly suggestions: CapabilitySuggestion[];
  constructor(
    message: string,
    required: string[],
    suggestions: CapabilitySuggestion[],
  ) {
    super(message);
    this.name = "UnsupportedCapabilityError";
    this.required = required;
    this.suggestions = suggestions;
  }
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
 * Pure + exported so the reassembly can be unit-tested without mocking `fetch`.
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
 * chat stream. Pure + exported.
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

export async function streamGatewayChat(params: {
  messages: Array<{
    role: "user" | "assistant" | "system";
    content: string | ContentBlock[];
  }>;
  providerId?: ProviderId;
  defaultProvider?: ProviderId;
  strategy?: RoutingStrategy;
  mode?: ContextMode;
  threadId?: string;
  /** Private Mode: refuse providers that train on user data. */
  blockTraining?: boolean;
  /** Tool/function definitions for this turn. Requires a tool-capable provider —
   *  the gateway returns a 422 UnsupportedCapabilityError otherwise. */
  tools?: ToolDefinition[];
  toolChoice?: ToolChoice;
  signal?: AbortSignal;
  onChunk: (text: string) => void;
}): Promise<{
  providerId: ProviderId;
  model: string;
  threadId?: string;
  traceId?: string;
  compression?: CompressionStats;
  meta?: ResponseMeta;
  /** Tool calls the model made this turn (empty for a normal text turn). The
   *  caller runs the tools and sends results back as `tool_result` blocks. */
  toolCalls?: ToolCallContentBlock[];
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
      block_training: params.blockTraining,
      tools: params.tools,
      tool_choice: params.toolChoice,
    }),
    signal: params.signal,
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: {
        message?: string;
        type?: string;
        required?: string[];
        suggestions?: CapabilitySuggestion[];
      };
    } | null;
    // A request that can't reach a capable route (e.g. vision) comes back as a
    // structured 422 — surface its message + suggestions instead of a crash.
    if (
      response.status === 422 &&
      body?.error?.type === "unsupported_capability"
    ) {
      throw new UnsupportedCapabilityError(
        body.error.message ??
          "This request needs a capability the chosen provider can't serve.",
        body.error.required ?? ["vision"],
        body.error.suggestions ?? [],
      );
    }
    throw new Error(body?.error?.message ?? `Gateway error ${response.status}`);
  }

  if (!response.body) {
    throw new Error("Gateway returned no response body");
  }

  // Compression savings ride along as response headers (known before streaming).
  const compression = readCompressionStats(response.headers) ?? undefined;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let provider: ProviderId | undefined;
  let model = "unknown";
  let resolvedThreadId = params.threadId;
  let traceId: string | undefined;
  let output = "";
  const meta: ResponseMeta = {};
  // Accumulate streamed tool-call fragments by their `index`. The gateway emits
  // each call's name once and its arguments as a (possibly fragmented) JSON
  // string; we concatenate then parse once the stream ends. The fold + finalize
  // are pure helpers (accumulateToolCallDeltas / finalizeToolCalls).
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

      traceId = chunk.id ?? traceId;
      provider = chunk.provider ?? provider;
      model = chunk.model ?? model;
      resolvedThreadId = chunk.thread_id ?? resolvedThreadId;

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
        params.onChunk(output);
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
    compression,
    meta: Object.keys(meta).length > 0 ? meta : undefined,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
  };
}
