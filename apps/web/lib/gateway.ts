import type {
  ContentBlock,
  ContextMode,
  ProviderId,
  RoutingStrategy,
  ToolCallContentBlock,
  ToolChoice,
  ToolDefinition,
  ResponseFormat,
} from "@zintus/types";

export const GATEWAY_URL =
  process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:8788";

/**
 * Auth headers for the gateway — intentionally empty.
 *
 * Every consumer of this module is a `"use client"` component, so this code runs
 * in the BROWSER. A gateway bearer token therefore CANNOT be sourced from an
 * env var here: a `NEXT_PUBLIC_*` value would be inlined verbatim into the public
 * client JS bundle and exposed to every visitor (the 2026-06-26 web audit P2
 * "bundle-baked NEXT_PUBLIC_GATEWAY_TOKEN"), and a non-public env var is stripped
 * to empty on the client. The hosted web targets the user's own LOOPBACK gateway,
 * which is token-less. A network/shared gateway must front its own auth (a
 * server-side proxy or session cookie) — never a token baked into this bundle.
 *
 * GUARD: do NOT reintroduce `process.env.NEXT_PUBLIC_GATEWAY_TOKEN` (or any other
 * static secret) here — it would leak to anyone viewing the page source.
 */
export function gatewayAuthHeaders(): Record<string, string> {
  return {};
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
 * Compression savings for a single chat response, parsed from the
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

// ─────────────────────────────────────────────────────────────────────────────
// Rich models catalog — the OpenRouter-grade `/v1/models` + `/v1/pricing`.
//
// These mirror the gateway's enriched catalog entries (apps/gateway/src/handler.ts
// `toModelEntry`). They are SEPARATE from `fetchGatewayModels` above, which stays
// a thin `string[]` for the terminal. HONESTY: prices are `null` when unknown
// (render "price unknown", never $0); an offline/erroring gateway returns `[]`
// rather than fabricated rows.
// ─────────────────────────────────────────────────────────────────────────────

/** 3-state structured-output capability (matches @zintus/providers StructuredLevel). */
export type CatalogStructuredOutput = "none" | "json_object" | "json_schema";

/** Coarse data-policy tag from the catalog entry. */
export type CatalogDataPolicyTag =
  | "no_train"
  | "may_train"
  | "unknown"
  | "zero_retention";

/** Badge class shared with the providers page's `policy-badge` styling. */
export type CatalogDataPolicyBadge = "no-training" | "trains" | "zdr" | "unknown";

/** One enriched `/v1/models` entry. Field names mirror the gateway response
 *  verbatim (snake_case) so this DTO maps 1:1 onto the wire format. */
export interface CatalogModelDto {
  id: string;
  object: "model";
  owned_by: string;
  display_name: string;
  context_window: number;
  capabilities: {
    vision: boolean;
    tools: boolean;
    structured_output: CatalogStructuredOutput;
  };
  /** USD per 1M tokens; either side may be `null` when the price is unknown. */
  pricing: {
    input_per_1m: number | null;
    output_per_1m: number | null;
  };
  free: boolean;
  local: boolean;
  data_policy: {
    tag: CatalogDataPolicyTag;
    trains_on_data?: boolean | string;
    retention?: string;
    zdr?: boolean;
    badge: CatalogDataPolicyBadge;
    policy_url?: string;
  };
}

/** One priced `/v1/pricing` entry (only models with a concrete, non-null price). */
export interface CatalogPricingDto {
  id: string;
  provider: string;
  input_per_1m: number;
  output_per_1m: number;
  free: boolean;
}

/** Server-side filters supported by `GET /v1/models`. Omitted/false flags are
 *  not sent (so the gateway returns the full list). */
export interface CatalogModelFilters {
  provider?: string;
  vision?: boolean;
  tools?: boolean;
  free?: boolean;
  local?: boolean;
}

/** Build the `/v1/models` query string from filters. Exported (pure) so the
 *  filter→querystring mapping is unit-testable without mocking `fetch`. */
export function catalogModelsQuery(filters?: CatalogModelFilters): string {
  const params = new URLSearchParams();
  if (filters?.provider) params.set("provider", filters.provider);
  if (filters?.vision) params.set("vision", "true");
  if (filters?.tools) params.set("tools", "true");
  if (filters?.free) params.set("free", "true");
  if (filters?.local) params.set("local", "true");
  return params.toString();
}

/**
 * The rich models catalog from `GET /v1/models`. Returns `[]` (not null) when the
 * gateway is offline or errors — the catalog is FREE core, so the page renders an
 * honest "gateway offline" empty state rather than fabricated rows.
 */
export async function fetchCatalogModels(
  filters?: CatalogModelFilters,
): Promise<CatalogModelDto[]> {
  try {
    const qs = catalogModelsQuery(filters);
    const response = await fetch(
      `${GATEWAY_URL}/v1/models${qs ? `?${qs}` : ""}`,
      { cache: "no-store", headers: { ...gatewayAuthHeaders() } },
    );
    if (!response.ok) {
      return [];
    }
    const body = (await response.json()) as { data?: CatalogModelDto[] };
    return body.data ?? [];
  } catch {
    return [];
  }
}

/** Priced models from `GET /v1/pricing`. Returns `[]` on an offline/erroring gateway. */
export async function fetchCatalogPricing(): Promise<CatalogPricingDto[]> {
  try {
    const response = await fetch(`${GATEWAY_URL}/v1/pricing`, {
      cache: "no-store",
      headers: { ...gatewayAuthHeaders() },
    });
    if (!response.ok) {
      return [];
    }
    const body = (await response.json()) as { data?: CatalogPricingDto[] };
    return body.data ?? [];
  } catch {
    return [];
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
    finish_reason?: string | null;
  }>;
  error?: { message?: string };
  // metadata-event fields (type === "metadata")
  tokens?: { input?: number; output?: number };
  latency_ms?: number;
  cost_usd?: number;
  saved_vs_claude_sonnet?: number;
  routing_strategy?: string;
  route_reason?: string;
  private_mode_honored?: boolean;
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
  /**
   * Human "why this provider/model" line from the gateway's route trace (e.g.
   * "cheapest healthy provider", "failover after groq rate-limit"). `undefined`
   * when the trace recorded no reason. Surfaced as the headline at the top of the
   * assistant turn — the prominent "why this route" signal the audit flagged missing.
   */
  routeReason?: string;
  /**
   * Privacy-mode honesty: `undefined` when private mode was off, `true` when
   * honored, `false` when the gateway had to use a may-train/"unknown" provider
   * anyway. The UI shows a "Private Mode not honored" warning when `false`.
   */
  privacyHonored?: boolean;
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
 * body from apps/gateway/src/handler.ts.
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
 * chat stream. Pure + exported (unit-tested in `gateway.test.ts`).
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
  // Content is `string` (text-only) OR an ordered `ContentBlock[]` (multimodal:
  // a text block followed by image blocks). The gateway reads images from these
  // blocks — there is NO separate `images` field (it would be stripped).
  messages: Array<{
    role: "user" | "assistant" | "system";
    content: string | ContentBlock[];
  }>;
  providerId?: ProviderId;
  defaultProvider?: ProviderId;
  /** Specific model id (e.g. from the catalog's "Use this model"). When set the
   *  gateway routes to this exact model rather than the provider default. */
  model?: string;
  strategy?: RoutingStrategy;
  mode?: ContextMode;
  threadId?: string;
  webSearch?: boolean;
  searchDepth?: "basic" | "standard" | "deep";
  blockTraining?: boolean;
  allowTraining?: ProviderId[];
  keys?: Partial<Record<ProviderId, string>>;
  temperature?: number;
  /** Tool/function definitions for this turn. Requires a tool-capable provider —
   *  the gateway returns a 422 UnsupportedCapabilityError otherwise. */
  tools?: ToolDefinition[];
  toolChoice?: ToolChoice;
  /** Structured-output request (e.g. { type: "json_object" }). The gateway
   *  resolves the best level the chosen provider can serve. */
  responseFormat?: ResponseFormat;
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
  /** Tool calls the model made this turn (empty for a normal text turn). The
   *  caller runs the tools and sends results back as `tool_result` blocks. */
  toolCalls?: ToolCallContentBlock[];
}> {
  const response = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...gatewayAuthHeaders() },
    body: JSON.stringify({
      messages: params.messages,
      model: params.model,
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
      tools: params.tools,
      tool_choice: params.toolChoice,
      response_format: params.responseFormat,
      // BYOK keys are only ever sent to a LOCAL gateway — never across the
      // network (would leak keys in a plaintext body to a remote host).
      keys:
        isLoopbackGateway() &&
        params.keys &&
        Object.keys(params.keys).length > 0
          ? params.keys
          : undefined,
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
    // A vision request that can't reach a vision-capable route comes back as a
    // structured 422 — surface its message + suggestions instead of a crash.
    if (
      response.status === 422 &&
      body?.error?.type === "unsupported_capability"
    ) {
      throw new UnsupportedCapabilityError(
        body.error.message ??
          "Image input requires a vision-capable provider or local vision model.",
        body.error.required ?? ["vision"],
        body.error.suggestions ?? [],
      );
    }
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
  // Accumulate streamed tool-call fragments by their `index`. The gateway emits
  // each call's name once and its arguments as a (possibly fragmented) JSON
  // string; we concatenate then parse once the stream ends. Robust to both the
  // whole-object shape Zintus emits and OpenAI's fragmented shape. The fold +
  // finalize are pure helpers (accumulateToolCallDeltas / finalizeToolCalls) so
  // the fragile reassembly is unit-tested directly (see gateway.test.ts).
  const toolCallsByIndex: ToolCallAccumulator = new Map();

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
        routeReason: chunk.route_reason,
        privacyHonored: chunk.private_mode_honored,
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

    accumulateToolCallDeltas(
      toolCallsByIndex,
      chunk.choices?.[0]?.delta?.tool_calls,
    );
  });

  if (!provider) {
    throw new Error("Gateway stream ended without provider metadata");
  }

  const toolCalls = finalizeToolCalls(toolCallsByIndex);

  return {
    providerId: provider,
    model,
    threadId: resolvedThreadId,
    traceId,
    compileTokens,
    meta,
    compression,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
  };
}
