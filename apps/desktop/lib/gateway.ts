import type {
  ContentBlock,
  ContextMode,
  ProviderId,
  ResponseFormat,
  RoutingStrategy,
  ToolCallContentBlock,
  ToolChoice,
  ToolDefinition,
} from "@zintus/types";
// TYPE-ONLY import: @zintus/mcp is the gateway's server-side SDK surface. The
// desktop renderer never hosts MCP — it only describes server configs + shows
// discovery results, so we erase this at build time (never bundle the SDK).
import type {
  MCPPrompt,
  MCPResource,
  MCPServerConfig,
  MCPTool,
} from "@zintus/mcp";

const DEFAULT_GATEWAY_URL = "http://localhost:8788";
const ENV_GATEWAY_URL = process.env.NEXT_PUBLIC_GATEWAY_URL?.trim() || null;
const GATEWAY_TOKEN = process.env.NEXT_PUBLIC_GATEWAY_TOKEN?.trim() || "";

export function gatewayAuthHeaders(): Record<string, string> {
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
 * Read the gateway's `X-Zintus-Private-Honored` response header into a tri-state.
 * Returns `undefined` when the header is absent (Private Mode was off, so no claim
 * is made), `true`/`false` for an explicit `"true"`/`"false"`. Any other value is
 * treated as absent — we under-claim rather than guess. The metadata SSE frame
 * carries the same signal; this header is the fallback known before the stream.
 */
export function readPrivacyHonored(headers: Headers): boolean | undefined {
  const raw = headers.get("X-Zintus-Private-Honored");
  if (raw == null) return undefined;
  const value = raw.trim().toLowerCase();
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
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
 * Explicit key test (matrix #20) via the local gateway's POST /v1/keys/validate.
 * The key travels renderer → loopback gateway → provider auth endpoint only.
 * Three-state result: the caller must distinguish "invalid key" from "could
 * not test" (gateway down / provider unreachable) — never conflate them.
 */
export async function validateProviderKey(
  provider: ProviderId,
  key: string,
): Promise<{ ok: boolean; valid?: boolean; error?: string }> {
  const gatewayUrl = await resolveGatewayUrl();
  if (!gatewayUrl) {
    return { ok: false, error: "Gateway offline — run `zintus serve` to test keys." };
  }
  try {
    const response = await fetch(`${gatewayUrl}/v1/keys/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...gatewayAuthHeaders() },
      body: JSON.stringify({ providerId: provider, key }),
    });
    const payload = (await response.json()) as {
      valid?: boolean;
      error?: { message?: string };
    };
    if (!response.ok) {
      return { ok: false, error: payload.error?.message ?? `HTTP ${response.status}` };
    }
    return { ok: true, valid: Boolean(payload.valid) };
  } catch {
    return { ok: false, error: "Could not reach the gateway to test the key." };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MCP (Model Context Protocol) — the desktop renderer can't HOST MCP, so the
// settings UI asks the user's local gateway to connect and report a server's
// capabilities. `discoverMcpServer` drives the "Test connection" button;
// `disconnectMcpServer` is a best-effort cleanup when a server is removed.
// Neither throws. Mirrors apps/web/lib/gateway.ts.
// ─────────────────────────────────────────────────────────────────────────────

/** A successful discovery: the server's advertised tools/resources/prompts. */
export interface McpDiscoverResult {
  tools: MCPTool[];
  resources: MCPResource[];
  prompts: MCPPrompt[];
  /** Epoch ms the gateway connected to the server. */
  connectedAt: number;
}

/**
 * Connect (via the local gateway) to one MCP server and return its advertised
 * tools/resources/prompts. NEVER throws: a failed/refused connection or an
 * offline gateway resolves to `{ error }` with an honest, human-readable message
 * so the UI can show it inline instead of crashing.
 */
export async function discoverMcpServer(
  config: MCPServerConfig,
): Promise<McpDiscoverResult | { error: string }> {
  const gatewayUrl = await resolveGatewayUrl();
  if (!gatewayUrl) {
    return {
      error:
        "Couldn't reach the gateway. Start it with `zintus serve`, then try again.",
    };
  }
  try {
    const response = await fetch(`${gatewayUrl}/v1/mcp/discover`, {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json", ...gatewayAuthHeaders() },
      body: JSON.stringify({ config }),
    });
    const body = (await response.json().catch(() => null)) as
      | {
          tools?: MCPTool[];
          resources?: MCPResource[];
          prompts?: MCPPrompt[];
          connectedAt?: number;
          error?: { message?: string };
        }
      | null;
    if (!response.ok) {
      return {
        error:
          body?.error?.message ??
          `Couldn't reach the MCP server (gateway error ${response.status}).`,
      };
    }
    return {
      tools: body?.tools ?? [],
      resources: body?.resources ?? [],
      prompts: body?.prompts ?? [],
      connectedAt: body?.connectedAt ?? Date.now(),
    };
  } catch {
    return {
      error:
        "Couldn't reach the gateway. Start it with `zintus serve`, then try again.",
    };
  }
}

/**
 * Best-effort disconnect of a cached MCP server connection on the gateway.
 * Fire-and-forget: returns `true` on success, `false` on any failure (an offline
 * gateway is harmless here — there was nothing to disconnect). Never throws.
 */
export async function disconnectMcpServer(
  config: MCPServerConfig,
): Promise<boolean> {
  const gatewayUrl = await resolveGatewayUrl();
  if (!gatewayUrl) {
    return false;
  }
  try {
    const response = await fetch(`${gatewayUrl}/v1/mcp/disconnect`, {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json", ...gatewayAuthHeaders() },
      body: JSON.stringify({ config }),
    });
    return response.ok;
  } catch {
    return false;
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
  /**
   * Human "why this provider/model" line from the gateway's route trace (e.g.
   * "cheapest healthy provider", "failover after groq rate-limit"). `undefined`
   * when the trace recorded no reason. Surfaced as the headline at the top of the
   * assistant turn — the prominent "why this route" signal the audit flagged missing.
   */
  routeReason?: string;
  /**
   * Private-Mode honesty: `undefined` when Private Mode (block-training) was off,
   * `true` when the turn was served by a no-training provider, `false` when Private
   * Mode was on but every available provider may train (or has an undocumented
   * policy) so one was used anyway. Mirrors the web TransparencyStrip pill — never
   * shown as honored unless the gateway confirmed it. Read from the metadata SSE
   * frame's `private_mode_honored`, with the `X-Zintus-Private-Honored` response
   * header as a fallback (known before the stream even starts).
   */
  privacyHonored?: boolean;
  /**
   * Stored memory facts that INFLUENCED this turn (id + display label), read from
   * the metadata frame's `memory_used`. Empty/absent when no facts were included.
   * Surfaced as the "memory used this turn" footer — transparency, not authority.
   */
  memoryUsed?: Array<{ id: string; content: string }>;
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
  route_reason?: string;
  private_mode_honored?: boolean;
  memory_used?: Array<{ id: string; content: string }>;
  // server-side MCP tool-loop event fields (type === "mcp_tool_call" |
  // "mcp_tool_result"). A result frame carries the call id + outcome at the top
  // level (its `choices` is empty); a call frame reuses the tool-call delta shape.
  tool_call_id?: string;
  is_error?: boolean;
  content?: string;
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

// ─────────────────────────────────────────────────────────────────────────────
// Server-side MCP tool loop — the gateway runs the MCP tools itself and streams
// progress as `mcp_tool_call` / `mcp_tool_result` SSE frames ALONGSIDE the normal
// text stream. The desktop NEVER executes these tools — it only displays them.
// These pure helpers parse a frame into a calm, secret-safe UI event and are
// unit-tested directly (no `fetch` mock needed). Mirrors apps/web/lib/gateway.ts.
// ─────────────────────────────────────────────────────────────────────────────

/** The `mcp` block the chat body carries: the gateway connects each server and
 *  runs the tool loop server-side. Shape mirrors @zintus/schemas MCPRequest. */
export interface ChatMcpConfig {
  servers: MCPServerConfig[];
  /** Allow-list of tool names (raw or namespaced). Omit to offer every tool the
   *  servers advertise. */
  enabledTools?: string[];
}

/** One ordered MCP tool-loop event surfaced to the UI. A `call` names the tool;
 *  the matching `result` (same `id`) reports success/char-count or an error. */
export type McpToolEvent =
  | {
      kind: "call";
      /** tool_call id — pairs a later `result` back to this call. */
      id: string;
      /** Server segment of the namespaced name (a stable hash, may be ""). */
      server: string;
      /** Server-local tool name (e.g. "read_file"). */
      tool: string;
      /** Parameter NAMES only — never values (no secret leakage). "" when none. */
      argsSummary: string;
    }
  | {
      kind: "result";
      id: string;
      ok: boolean;
      /** "234 chars" on success, or the (truncated) error message. */
      summary: string;
    };

const MCP_TOOL_PREFIX = "mcp__";

/**
 * Split a gateway MCP tool name `mcp__<serverId>__<tool>` into its parts. The
 * serverId is the hex hash up to the FIRST `__` after the prefix; the rest is the
 * tool name (which may itself contain `__`). A non-MCP name yields the whole name
 * as `tool`. Local mirror of apps/gateway/src/mcp-bridge.ts `parseMcpToolName`.
 */
export function splitMcpToolName(name: string): { server: string; tool: string } {
  if (!name.startsWith(MCP_TOOL_PREFIX)) {
    return { server: "", tool: name };
  }
  const rest = name.slice(MCP_TOOL_PREFIX.length);
  const sep = rest.indexOf("__");
  if (sep <= 0) {
    return { server: "", tool: rest };
  }
  return { server: rest.slice(0, sep), tool: rest.slice(sep + 2) };
}

/**
 * A calm, secret-safe summary of tool arguments: the parameter NAMES only, never
 * their values (which may carry secrets). Returns "" for empty / non-object args.
 */
export function summarizeToolArgs(raw: string | undefined): string {
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return Object.keys(parsed as Record<string, unknown>).join(", ");
    }
  } catch {
    // not JSON — show nothing rather than dumping a raw fragment
  }
  return "";
}

/**
 * A short result summary: the char count on success, or the (truncated) message
 * on error. Never dumps the full body — honesty without leaking large/secret
 * tool output into the transcript.
 */
export function summarizeToolResult(
  content: string | undefined,
  isError: boolean,
): string {
  const text = content ?? "";
  if (isError) {
    const msg = text.trim() || "the tool reported an error";
    return msg.length > 120 ? `${msg.slice(0, 117)}…` : msg;
  }
  const n = text.length;
  return `${n} char${n === 1 ? "" : "s"}`;
}

/**
 * Parse a streamed chunk into an `McpToolEvent`, or null when it isn't an MCP
 * frame. Matches the gateway frames precisely: `mcp_tool_call` reuses the
 * tool-call delta shape (`choices[0].delta.tool_calls[0]`); `mcp_tool_result`
 * carries `tool_call_id` / `is_error` / `content` at the top level. Pure +
 * exported so the parsing is unit-tested without mocking `fetch`.
 */
export function parseMcpToolEvent(chunk: GatewayChunk): McpToolEvent | null {
  if (chunk.type === "mcp_tool_call") {
    const tc = chunk.choices?.[0]?.delta?.tool_calls?.[0];
    if (!tc) return null;
    const name = tc.function?.name ?? "";
    const { server, tool } = splitMcpToolName(name);
    return {
      kind: "call",
      id: tc.id ?? "",
      server,
      tool: tool || name,
      argsSummary: summarizeToolArgs(tc.function?.arguments),
    };
  }
  if (chunk.type === "mcp_tool_result") {
    const isError = chunk.is_error ?? false;
    return {
      kind: "result",
      id: chunk.tool_call_id ?? "",
      ok: !isError,
      summary: summarizeToolResult(chunk.content, isError),
    };
  }
  return null;
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
  /** Structured-output request. `{ type: "json_object" }` asks the provider for
   *  syntactically-valid JSON; the gateway resolves the best level the chosen
   *  provider can actually serve (never claims more than it returns). */
  responseFormat?: ResponseFormat;
  /** Configured MCP servers for this turn. When present the gateway runs a
   *  SERVER-SIDE tool loop and streams `mcp_tool_call`/`mcp_tool_result` events;
   *  the desktop only displays them (it never executes these tools). */
  mcp?: ChatMcpConfig;
  signal?: AbortSignal;
  onChunk: (text: string) => void;
  /** Live callback for each server-side MCP tool-loop event (call/result), in
   *  arrival order — lets the UI render activity as it streams. */
  onMcpToolEvent?: (event: McpToolEvent) => void;
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
  /** Ordered server-side MCP tool-loop events emitted this turn (empty when no
   *  MCP servers were configured). Display-only — the gateway already ran them. */
  toolEvents?: McpToolEvent[];
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
      response_format: params.responseFormat,
      // Present ONLY when the user has MCP servers enabled. The gateway connects
      // them and runs the tool loop server-side (the desktop never executes them).
      mcp: params.mcp,
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
  // Private-Mode honesty also rides a response header (known before the stream).
  // The metadata SSE frame may restate it; the frame wins when present, but this
  // gives the badge a value even if that frame never arrives.
  const headerPrivacyHonored = readPrivacyHonored(response.headers);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let provider: ProviderId | undefined;
  let model = "unknown";
  let resolvedThreadId = params.threadId;
  let traceId: string | undefined;
  let output = "";
  const meta: ResponseMeta = {};
  // Seed from the header so the badge is honest even if the metadata frame is
  // missing; the frame's `private_mode_honored` overrides it below when present.
  if (headerPrivacyHonored !== undefined) {
    meta.privacyHonored = headerPrivacyHonored;
  }
  // Accumulate streamed tool-call fragments by their `index`. The gateway emits
  // each call's name once and its arguments as a (possibly fragmented) JSON
  // string; we concatenate then parse once the stream ends. The fold + finalize
  // are pure helpers (accumulateToolCallDeltas / finalizeToolCalls).
  const toolCallsByIndex: ToolCallAccumulator = new Map();
  // Ordered server-side MCP tool-loop events (call/result). These ride the same
  // stream as the text but are a SEPARATE channel — display only.
  const toolEvents: McpToolEvent[] = [];

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

      // Server-side MCP frames first: they reuse the tool-call delta shape, so
      // they MUST be peeled off here, before accumulateToolCallDeltas would fold
      // them into the (client) tool-call channel.
      const mcpEvent = parseMcpToolEvent(chunk);
      if (mcpEvent) {
        toolEvents.push(mcpEvent);
        params.onMcpToolEvent?.(mcpEvent);
        continue;
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
        if (chunk.route_reason != null) {
          meta.routeReason = chunk.route_reason;
        }
        if (chunk.private_mode_honored != null) {
          meta.privacyHonored = chunk.private_mode_honored;
        }
        if (chunk.memory_used != null) {
          meta.memoryUsed = chunk.memory_used;
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
    toolEvents: toolEvents.length > 0 ? toolEvents : undefined,
  };
}
