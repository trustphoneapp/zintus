import { randomUUID } from "node:crypto";
import {
  listProviders,
  estimateCostUsd,
  createProvider,
  DATA_POLICIES,
  PROVIDER_METADATA,
  listCatalogModels,
  type CatalogModel,
} from "@zintus/providers";
import {
  supportsVision,
  supportsTools,
  structuredOutputLevel,
  installedLocalVisionModel,
} from "@zintus/providers";
import { redactSecrets, type ProviderStats } from "@zintus/router";
import { getKey as keychainGetKey } from "@zintus/keychain";
import type { Engine } from "@zintus/engine";
import {
  detectLocalRuntimes as defaultDetectLocalRuntimes,
  type LocalRuntimes,
} from "./local-runtimes.js";
import {
  activityRecordToEntry,
  ACTIVITY_RETENTION_DAYS,
  type ActivityStore,
} from "./activity-store.js";
import type {
  ChatMessage,
  ContextMode,
  ProviderId,
  RequestTrace,
  RouteUsage,
  RoutingStrategy,
} from "@zintus/types";
import {
  textOf,
  imageCount,
  isContentBlockArray,
  isProviderId,
  hasToolTurns,
  type ContentBlock,
  type ToolResultContentBlock,
  type ToolDefinition,
} from "@zintus/types";
import type { MCPServerConfig } from "@zintus/mcp";
import { MCPRegistry, configId } from "./mcp-registry.js";
import { computeRouteOptions } from "./route-options.js";
import {
  AgentTaskManager,
  type AgentEngine,
  type CreateAgentTaskBody,
} from "./agents.js";
import type { EngineerRunManager } from "./engineer.js";
import {
  mcpToolsToDefinitions,
  mcpToolName,
  executeMcpToolCall,
  isMcpToolCall,
} from "./mcp-bridge.js";
import type { ChatCompletionRequest, ProviderRouting } from "@zintus/schemas";
import {
  bearerAuthorized,
  resolveCorsOrigin,
  type GatewayConfig,
} from "./auth.js";
import { createMetrics, type Metrics } from "./metrics.js";
import type { RateLimiter } from "./rate-limit.js";
import {
  ChatCompletionRequestSchema,
  ResearchRequestSchema,
  MCPDiscoverRequestSchema,
  formatIssues,
} from "@zintus/schemas";
import { compress } from "tokzen";
import {
  getSearchStrategy,
  groqCompoundModel,
  runFallbackSearch,
  injectSearchResults,
  extractSearchQuery,
  deepResearch,
  type SearchDepth,
  type ResearchDepth,
  type DeepResearchDeps,
} from "@zintus/search";

// ─────────────────────────────────────────────────────────────────────────────
// Model / pricing catalog — the data behind the OpenRouter-grade `/v1/models`
// and `/v1/pricing` routes.
//
// The per-model catalog is owned by @zintus/providers (`listCatalogModels` /
// `CatalogModel`) — the single source of truth for the OpenRouter-grade
// `/v1/models` + `/v1/pricing` routes. Capability flags there are test-asserted to
// mirror the chat gates, and prices are null when unknown (no invention).
// ─────────────────────────────────────────────────────────────────────────────

/** Map a catalog model to the enriched, OpenAI-compatible `/v1/models` entry.
 *  The `{ id, object:"model", owned_by }` triple is preserved (OpenAI-compat
 *  contract); every other field is additive metadata.
 *
 *  `stats` carries the model PROVIDER's honest, MEASURED performance over a
 *  recent window (p95 latency, throughput, uptime/success-rate). It is `null`
 *  when no stats accessor is wired; each individual metric is `null` when the
 *  provider has too few samples to be truthful (never a fabricated 0 or guess).
 *  `samples` is the raw attempt count behind the metrics (0 when none, and the
 *  three metrics are null whenever it is below the accessor's min-sample floor). */
function toModelEntry(m: CatalogModel, stats?: ProviderStats | null) {
  return {
    // OpenAI-compatible triple — DO NOT drop (contracts.test.ts pins these).
    id: m.id,
    object: "model" as const,
    owned_by: PROVIDER_METADATA[m.provider]?.name ?? m.provider,
    // ── additive, OpenRouter-grade metadata ──
    display_name: m.displayName,
    context_window: m.contextWindow,
    capabilities: {
      vision: m.vision,
      tools: m.tools,
      structured_output: m.structuredOutput,
    },
    // USD per 1M tokens; null when unknown (honest — no invented prices).
    pricing: {
      input_per_1m: m.inputPer1M,
      output_per_1m: m.outputPer1M,
    },
    free: m.free,
    local: m.local,
    // The catalog carries a coarse tag (`m.dataPolicy`); the rich fields come from
    // the provider's DATA_POLICIES entry (gateway-local, authoritative).
    data_policy: ((dp) => ({
      tag: m.dataPolicy,
      trains_on_data: dp?.trainsOnData ?? "unknown",
      retention: dp?.dataRetention ?? "unknown",
      zdr: dp?.zdr ?? false,
      badge: dp?.badge ?? "unknown",
      policy_url: dp?.policyUrl ?? "",
    }))(DATA_POLICIES[m.provider]),
    // ── honest, MEASURED provider performance (null when insufficient data) ──
    // p95 latency (ms), throughput (output tokens/sec), and uptime (success
    // rate 0..1) over a recent window for THIS model's provider. Each is null
    // until the provider has enough recent samples to publish a truthful value;
    // `samples` is the raw attempt count behind them. Never invented.
    stats: {
      latency_p95_ms: stats?.latencyP95Ms ?? null,
      throughput_tps: stats?.throughputTps ?? null,
      uptime: stats?.successRate ?? null,
      samples: stats?.samples ?? 0,
    },
  };
}

/**
 * Optional usage/telemetry a RequestTrace MAY carry at runtime but that the
 * typed `RequestTrace` shape does not (yet) declare. The activity feed reads
 * these defensively: present → surface the REAL recorded value, absent →
 * an honest zero/false/omit. Nothing here is ever fabricated.
 */
interface TraceUsageExtras {
  tokens?: { input?: number; output?: number; total?: number };
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    promptTokens?: number;
    completionTokens?: number;
  };
  cacheHit?: boolean;
  routeReason?: string;
  costUsd?: number;
  savedVsBaselineUsd?: number;
}

/**
 * Normalize a routing trace into an OpenRouter-style `/activity` entry. Built
 * ONLY from data the gateway already records (the same `RequestTrace` exposed
 * by `/v1/traces`), plus any optional usage fields the trace happens to carry.
 * Honest by construction: cost is $0 on the free tier, token counts default to
 * 0 when not recorded, `cache_hit` defaults to false, and `route_reason` is
 * OMITTED entirely when the trace does not record one.
 */
function toActivityEntry(trace: RequestTrace) {
  const extras = trace as RequestTrace & TraceUsageExtras;
  // Winner is authoritative for provider/model; otherwise fall back to the last
  // successful attempt, then the last attempt recorded.
  const lastSuccess = [...trace.attempts]
    .reverse()
    .find((a) => a.status === "success");
  const lastAttempt = trace.attempts[trace.attempts.length - 1];
  const provider: ProviderId | null =
    trace.winner?.providerId ??
    lastSuccess?.providerId ??
    lastAttempt?.providerId ??
    null;
  const model: string | null =
    trace.winner?.model ?? lastSuccess?.model ?? lastAttempt?.model ?? null;

  const inputTokens =
    extras.tokens?.input ??
    extras.usage?.inputTokens ??
    extras.usage?.promptTokens ??
    0;
  const outputTokens =
    extras.tokens?.output ??
    extras.usage?.outputTokens ??
    extras.usage?.completionTokens ??
    0;
  const totalTokens =
    extras.tokens?.total ?? extras.usage?.totalTokens ?? inputTokens + outputTokens;

  const latencyMs =
    trace.totalLatencyMs ??
    (trace.winner
      ? lastSuccess?.latencyMs
      : lastAttempt?.latencyMs) ??
    null;

  return {
    id: trace.traceId,
    // Unix seconds (OpenAI/OpenRouter convention), plus the ISO timestamp for
    // callers that prefer it.
    created: Math.floor(trace.startedAt.getTime() / 1000),
    created_at: trace.startedAt.toISOString(),
    provider,
    model,
    tokens: { input: inputTokens, output: outputTokens, total: totalTokens },
    // Free-core: requests are served off free tiers, so the user's real cost is
    // $0. Never invent a non-zero number.
    cost_usd: extras.costUsd ?? 0,
    saved_vs_baseline_usd: extras.savedVsBaselineUsd ?? 0,
    latency_ms: latencyMs,
    cache_hit: extras.cacheHit ?? false,
    // route_reason only when the trace genuinely recorded one.
    ...(extras.routeReason ? { route_reason: extras.routeReason } : {}),
  };
}

/**
 * Resolve the chat body's provider-routing knobs into the values threaded to the
 * engine. Supports BOTH shapes:
 *   • Legacy Zintus: `provider` is a forced-provider STRING (pins one provider),
 *     with top-level `strategy` / `provider_weights`.
 *   • OpenRouter-style: `provider` is an OBJECT `{ order, sort, allow_fallbacks }`,
 *     mapped onto the SAME strategy / weight / forced-provider machinery:
 *       - `sort:"latency"` / `sort:"throughput"` → `fastest` (lowest measured p95;
 *         Zintus's speed signal is p95 latency, and throughput correlates with it —
 *         we never fabricate a tokens/sec ranking we don't measure per-candidate).
 *       - `sort:"price"` → `economy` (cheapest paid-equivalent wins).
 *       - `order` (no `sort`) → descending per-request provider WEIGHTS so the
 *         router prefers the listed providers in that order.
 *       - `allow_fallbacks:false` → pin to `order[0]` (a single forced provider →
 *         exactly one candidate → no failover to other providers).
 * Honest: an empty/unknown object resolves to plain auto-routing (no fabricated
 * preference). Explicit top-level `provider_weights` is always preserved.
 */
function resolveChatRouting(body: ChatCompletionRequest): {
  provider?: ProviderId;
  strategy?: RoutingStrategy | "weighted";
  providerWeights?: Record<string, number>;
} {
  const raw = body.provider;
  const legacyWeights = body.provider_weights ?? body.providerWeights;
  // Forced-provider string (or absent) → legacy behaviour, unchanged.
  if (raw == null || typeof raw === "string") {
    return {
      provider: raw ?? undefined,
      strategy: body.strategy,
      providerWeights: legacyWeights,
    };
  }
  // OpenRouter-style routing object.
  const SORT_TO_STRATEGY = {
    latency: "fastest",
    throughput: "fastest",
    price: "economy",
  } as const satisfies Record<
    NonNullable<ProviderRouting["sort"]>,
    RoutingStrategy
  >;
  const strategy = raw.sort ? SORT_TO_STRATEGY[raw.sort] : body.strategy;
  // allow_fallbacks:false pins the request to the top-preference provider so the
  // router yields a single candidate and never fails over to another provider.
  const provider =
    raw.allow_fallbacks === false ? (raw.order?.[0] ?? undefined) : undefined;
  // `order` without `sort` → descending per-request weights (first = highest).
  // Skipped when a provider is already pinned (allow_fallbacks:false → single
  // forced provider, weights moot), when `sort` is given (sort picks the
  // strategy; a weight map would otherwise force the weighted branch and ignore
  // the sort), or when the caller already supplied explicit weights.
  let providerWeights = legacyWeights;
  if (!provider && raw.order?.length && !raw.sort && !providerWeights) {
    const weights: Record<string, number> = {};
    raw.order.forEach((id, i) => {
      weights[id] = raw.order!.length - i;
    });
    providerWeights = weights;
  }
  return { provider, strategy, providerWeights };
}

/**
 * Paid-frontier reference pricing (Claude Sonnet 4.6, USD per million tokens),
 * used only to quantify what a request *would* have cost on a paid API — the
 * "saved vs Claude Sonnet" figure surfaced in the per-response transparency
 * strip. Zintus routes to free tiers, so the user's actual cost is $0.
 */
const CLAUDE_SONNET_INPUT_USD_PER_MTOK = 3;
const CLAUDE_SONNET_OUTPUT_USD_PER_MTOK = 15;

function savedVsClaudeSonnet(inputTokens: number, outputTokens: number): number {
  return (
    (inputTokens * CLAUDE_SONNET_INPUT_USD_PER_MTOK) / 1_000_000 +
    (outputTokens * CLAUDE_SONNET_OUTPUT_USD_PER_MTOK) / 1_000_000
  );
}

/** Per-response metadata event appended to the SSE stream (and JSON responses). */
function buildUsageMetadata(
  usage: RouteUsage,
  strategy: string | undefined,
  privacyHonored?: boolean,
  routeReason?: string,
  memoryUsed?: Array<{ id: string; content: string }>,
): Record<string, unknown> {
  return {
    type: "metadata",
    provider: usage.providerId,
    model: usage.model,
    tokens: { input: usage.inputTokens, output: usage.outputTokens },
    latency_ms: usage.latencyMs,
    cost_usd: 0,
    saved_vs_claude_sonnet: savedVsClaudeSonnet(
      usage.inputTokens,
      usage.outputTokens,
    ),
    routing_strategy: strategy ?? "auto",
    // Human "why this provider/model" — surfaced on every platform (consistency).
    ...(routeReason ? { route_reason: routeReason } : {}),
    // Which stored memory facts influenced this turn ("memory used this turn").
    // Facts are background data — this is transparency, not authority.
    ...(memoryUsed && memoryUsed.length ? { memory_used: memoryUsed } : {}),
    // Privacy-mode honesty signal — only present when private mode was requested
    // (block_training). false = the request could not avoid a may-train provider.
    ...(privacyHonored !== undefined
      ? { private_mode_honored: privacyHonored }
      : {}),
  };
}

// Returned when an image request can't reach a vision-capable provider/model.
// No upsell, no paid-route nudge — just honest, actionable provider suggestions.
const UNSUPPORTED_VISION_ERROR = {
  error: {
    type: "unsupported_capability",
    message:
      "Image input requires a vision-capable provider or local vision model.",
    required: ["vision"],
    suggestions: [
      { provider: "gemini", reason: "Add a Gemini API key for image understanding." },
      { provider: "openrouter", reason: "Choose a vision-capable OpenRouter model." },
      {
        provider: "ollama",
        reason:
          "Run a local vision model such as LLaVA, Qwen-VL, Moondream, or Gemma vision.",
      },
    ],
  },
} as const;

// Returned when a tools-bearing request can't reach a tool-capable provider/model.
// Mirrors UNSUPPORTED_VISION_ERROR: no upsell, just honest BYOK suggestions.
const UNSUPPORTED_TOOLS_ERROR = {
  error: {
    type: "unsupported_capability",
    message:
      "Tool/function calling requires a tool-capable provider or model.",
    required: ["tools"],
    suggestions: [
      { provider: "gemini", reason: "Gemini 2.5 supports function calling." },
      { provider: "groq", reason: "Llama-3.3-70B on Groq supports tool calls." },
      { provider: "openrouter", reason: "Pick a tool-capable OpenRouter model." },
    ],
  },
} as const;

// Returned when a STRICT schema-constrained request (`response_format.type ===
// "json_schema"` with `strict: true`) can't reach a provider/model that
// GUARANTEES conformance. Mirrors UNSUPPORTED_TOOLS_ERROR: no upsell, just
// honest BYOK suggestions for providers that DO constrain decoding to a schema.
const UNSUPPORTED_STRUCTURED_ERROR = {
  error: {
    type: "unsupported_capability",
    message:
      "Strict schema-constrained output requires a provider that guarantees it (e.g. Gemini).",
    required: ["json_schema"],
    suggestions: [
      {
        provider: "gemini",
        reason:
          "Gemini's responseSchema constrains decoding to your JSON Schema (guaranteed).",
      },
    ],
  },
} as const;

/**
 * Structured-output metadata the engine attaches to its stream result for a
 * structured request. Defined locally as a safe structural type so this file
 * typechecks independently of when the sibling engine change lands; read off the
 * result via a narrow cast (`asStructured`). `requested` is the caller's
 * `response_format.type`; `servedLevel` is what the chosen provider could
 * actually serve (`prompt` = emulated, never guaranteed). `guaranteed` is true
 * ONLY when `servedLevel === "json_schema"`.
 */
type StructuredOutputMeta = {
  requested: "json_object" | "json_schema";
  servedLevel: "json_schema" | "json_object" | "prompt";
  guaranteed: boolean;
  valid: boolean;
  repairAttempts: number;
  issues?: { path: string; message: string }[];
};

/** Read the engine result's optional structured-output fields without coupling to
 *  the (sibling-owned) EngineStreamResult declaration. */
function asStructured(result: unknown): {
  structuredOutput?: StructuredOutputMeta;
  parsed?: unknown;
} {
  return result as { structuredOutput?: StructuredOutputMeta; parsed?: unknown };
}

/** Snake-case the structured metadata for the JSON/SSE wire shape (§2.3). */
function structuredOutputBody(meta: StructuredOutputMeta): Record<string, unknown> {
  return {
    requested: meta.requested,
    served_level: meta.servedLevel,
    guaranteed: meta.guaranteed,
    valid: meta.valid,
    repair_attempts: meta.repairAttempts,
    ...(meta.issues ? { issues: meta.issues } : {}),
  };
}

export type LogFn = (
  level: "info" | "warn" | "error",
  message: string,
  fields?: Record<string, unknown>,
) => void;

export type ErrorHook = (
  error: unknown,
  context: { requestId: string; path: string },
) => void;

const noopLog: LogFn = () => {};

// Text-only requests are tiny, but a vision request carries base64 image bytes:
// up to 4 images × 4 MB raw ≈ 16 MB, which is ~21 MB once base64-encoded in JSON.
// 25 MB covers that plus accompanying text. Per-image size + the max-4-image
// count are still enforced after parsing (below), so this only bounds the raw
// transport size. Operators can override via GATEWAY_MAX_BODY_BYTES.
const DEFAULT_MAX_BODY_BYTES = 25_000_000;
const DEFAULT_MAX_MESSAGES = 200;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 60_000;

class RequestTimeoutError extends Error {
  constructor() {
    super("Request timed out while starting the upstream stream");
    this.name = "RequestTimeoutError";
  }
}

/** Raised by the mid-stream idle watchdog when the upstream goes silent. */
class StreamIdleTimeoutError extends Error {
  constructor(ms: number) {
    super(`Upstream stream stalled: no data received for ${ms}ms`);
    this.name = "StreamIdleTimeoutError";
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new RequestTimeoutError()), ms);
    if (typeof timer === "object" && timer && "unref" in timer) {
      (timer as { unref?: () => void }).unref?.();
    }
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Wrap an async iterable with the same mid-stream idle watchdog the chat
 * streaming path applies inline: every pull is raced against an idle deadline
 * that RESETS on each received item; when it fires we abort the upstream (via
 * `abort`, releasing the socket + any in-flight quota reservation) and throw
 * `StreamIdleTimeoutError`, which the caller surfaces as that endpoint's error
 * shape. An optional `startMs` (> 0) bounds the FIRST pull separately — the
 * connect/start window — mirroring the chat path's `withTimeout(routeAndStream)`
 * before per-chunk idle protection takes over. Timers are always cleared in a
 * `finally` (no leak), and the source generator's `return()` is nudged so it can
 * run cleanup. Set `idleMs <= 0` to disable the per-item watchdog.
 *
 * Reuses the same env-derived windows as chat (`requestTimeoutMs` /
 * `streamIdleTimeoutMs`) and the same `StreamIdleTimeoutError`; it invents no new
 * knobs. Used by the buffered non-streaming chat branch and `/v1/research`. The
 * chat *streaming* branch keeps its already-tested inline loop unchanged.
 */
async function* withIdleWatchdog<T>(
  source: AsyncIterable<T>,
  opts: { idleMs: number; startMs?: number; abort: AbortController },
): AsyncGenerator<T> {
  const iterator = source[Symbol.asyncIterator]();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const clear = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
  let first = true;
  try {
    for (;;) {
      const windowMs =
        first && opts.startMs != null ? opts.startMs : opts.idleMs;
      let step: IteratorResult<T>;
      if (windowMs > 0) {
        const guard = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            opts.abort.abort();
            reject(new StreamIdleTimeoutError(windowMs));
          }, windowMs);
          (timer as { unref?: () => void }).unref?.();
        });
        try {
          step = await Promise.race([iterator.next(), guard]);
        } finally {
          clear();
        }
      } else {
        step = await iterator.next();
      }
      first = false;
      if (step.done) {
        return;
      }
      yield step.value;
    }
  } finally {
    clear();
    // Best-effort: let a generator that honors return() close its upstream
    // reader. Fire-and-forget — awaiting could deadlock behind a pending next()
    // whose fetch we already aborted above.
    void iterator.return?.().catch(() => {});
  }
}

export interface GatewayHandlerDeps {
  engine: Engine;
  config: GatewayConfig;
  log?: LogFn;
  /** Optional sink for unexpected errors (e.g. Sentry). */
  onError?: ErrorHook;
  /** Inject a metrics collector (defaults to a fresh in-process one). */
  metrics?: Metrics;
  /** Optional quota-remaining getter for Tokzen dial (0.0–1.0). */
  getQuotaRemaining?: (provider: ProviderId) => number;
  /**
   * Optional per-provider MEASURED stats accessor for the public `/v1/models`
   * feed (p95 latency, throughput, uptime/success-rate). Mirrors the
   * `getQuotaRemaining` injection: production wires it to the router/ledger
   * (`engine`-side `getProviderStats`); when omitted, `/v1/models` honestly
   * emits `null` stat fields rather than fabricating numbers.
   */
  getProviderStats?: (provider: ProviderId) => ProviderStats | null;
  /**
   * Returns true once graceful shutdown has begun. While draining, /health
   * reports 503 so load balancers / clients stop routing new traffic here while
   * in-flight streams finish.
   */
  getDraining?: () => boolean;
  /**
   * Optional per-client rate limiter applied to the expensive POST endpoints
   * (/v1/chat/completions, /v1/research). When omitted, no limiting is applied
   * (preserves prior behaviour; enabled from index.ts via GATEWAY_RATELIMIT_RPM).
   */
  rateLimiter?: RateLimiter;
  /**
   * Local-runtime detector for GET /v1/route/options. Defaults to the gateway's
   * existing Ollama/LM-Studio probe (`detectLocalRuntimes`); injectable so tests
   * can assert `use_local` / `localAvailable` without a live runtime.
   */
  detectLocalRuntimes?: () => Promise<LocalRuntimes>;
  /**
   * Resolver for the first INSTALLED local (Ollama) vision model, used to
   * serve image requests explicitly routed to ollama. Defaults to the live
   * `/api/tags` probe in @zintus/providers; injectable so tests can assert the
   * vision gate without a running Ollama.
   */
  localVisionModel?: () => Promise<string | null>;
  /**
   * Provider-key reader for POST /v1/transcribe (Whisper on the caller's own
   * Groq key). Defaults to the OS keychain; injectable so tests can run
   * without one.
   */
  readProviderKey?: (provider: ProviderId) => Promise<string | null>;
  /**
   * Durable usage-history store (bun:sqlite, ~/.zintus/activity.db). When
   * provided, GET /v1/activity reads from it first (falling back to the
   * in-memory trace path when it is empty/unavailable) and each completed turn
   * is persisted to it best-effort. Omitted in unit tests → behaviour is exactly
   * the prior trace-derived path. Created in index.ts for production.
   */
  activityStore?: ActivityStore;
  /**
   * MCP connection registry — the gateway HOSTS the MCP clients (the browser
   * can't: no stdio). Injected from index.ts so its `disconnectAll()` can be
   * called on graceful shutdown; a fresh one is created here when omitted (unit
   * tests pass a fake-client-backed registry). Reused across requests so a
   * server connects once.
   */
  mcpRegistry?: MCPRegistry;
  /** Zintus Engineer run facade. Omitted when the local execution feature is disabled. */
  engineerRuns?: EngineerRunManager;
}

/** Hard cap on SERVER-SIDE MCP tool-loop rounds (model calls) per request. Each
 *  round may execute MCP tool calls and feed their results back; the cap bounds
 *  a pathological model that calls tools forever. */
const MAX_MCP_TOOL_ROUNDS = 8;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.max(0, Math.min(1, value));
}

/**
 * Build the gateway's request handler. Pure of any server/port concerns so it
 * can be unit-tested by calling it with `Request` objects and asserting on the
 * returned `Response` (see handler.test.ts).
 */
export function createGatewayHandler(
  deps: GatewayHandlerDeps,
): (request: Request) => Promise<Response> {
  const { engine, config } = deps;
  const log = deps.log ?? noopLog;
  const onError = deps.onError;
  const metrics = deps.metrics ?? createMetrics();
  const getQuotaRemaining = deps.getQuotaRemaining;
  const getProviderStats = deps.getProviderStats;
  const getDraining = deps.getDraining;
  const rateLimiter = deps.rateLimiter;
  const detectLocal = deps.detectLocalRuntimes ?? defaultDetectLocalRuntimes;
  const localVisionModel = deps.localVisionModel ?? installedLocalVisionModel;
  const readProviderKey =
    deps.readProviderKey ?? (async (provider: ProviderId) => (await keychainGetKey(provider)) ?? null);
  const activityStore = deps.activityStore;
  const mcpRegistry = deps.mcpRegistry ?? new MCPRegistry();
  const engineerRuns = deps.engineerRuns;
  // P2: gateway-hosted agent runtime (one manager per handler; tasks live for
  // the life of the process, finished runs persist to ~/.zintus/agents).
  const agents = new AgentTaskManager(engine as unknown as AgentEngine);

  /**
   * Persist a completed turn to the durable activity store (best-effort). A
   * write failure must NEVER break the chat response — it is logged and
   * swallowed. Honest: cost is $0 (free-core), tokens/latency/savings stay null
   * when the turn did not record them (no fabricated values).
   */
  function recordTurnActivity(
    result: {
      traceId?: string;
      providerId: string;
      model: string;
      cacheHit?: string;
      routeReason?: string;
    },
    usage: RouteUsage | undefined,
    persist: boolean,
  ): void {
    // `persist:false` (incognito/ephemeral) must leave no durable activity row —
    // this is a durable trail OUTSIDE memory_facts, so it needs the same gate as
    // the engine's writes.
    if (!persist || !activityStore || !result.traceId) {
      return;
    }
    try {
      const inputTokens = usage?.inputTokens ?? null;
      const outputTokens = usage?.outputTokens ?? null;
      activityStore.recordActivity({
        traceId: result.traceId,
        created: Math.floor(Date.now() / 1000),
        provider: usage?.providerId ?? result.providerId ?? null,
        model: usage?.model ?? result.model ?? null,
        inputTokens,
        outputTokens,
        // Free-core: served off free tiers, so the user's real cost is $0.
        costUsd: 0,
        savedVsBaselineUsd:
          inputTokens != null && outputTokens != null
            ? savedVsClaudeSonnet(inputTokens, outputTokens)
            : null,
        latencyMs: usage?.latencyMs ?? null,
        cacheHit: result.cacheHit != null && result.cacheHit !== "miss",
        routeReason: result.routeReason ?? null,
      });
    } catch (error) {
      log("warn", "activity.record_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const maxBodyBytes = config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const maxMessages = config.maxMessages ?? DEFAULT_MAX_MESSAGES;
  const requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const streamIdleTimeoutMs =
    config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;

  function corsHeaders(request: Request): Record<string, string> {
    const origin = resolveCorsOrigin(
      config.corsOrigins,
      request.headers.get("origin"),
    );
    const headers: Record<string, string> = {
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, Last-Event-ID",
      "Access-Control-Expose-Headers":
        "X-Provider-Used, X-Cache-Hit, X-Failover-Count, X-Compile-Tokens, X-Zintus-Route-Reason, " +
        "X-Zintus-Original-Tokens, X-Zintus-Compressed-Tokens, " +
        "X-Zintus-Tokens-Saved, X-Zintus-Compression-Ratio, " +
        "X-Zintus-Cost-Saved-Usd, X-Zintus-Private-Honored, " +
        "X-Zintus-Vision-Provider, X-Zintus-Images, X-Zintus-Image-Bytes, X-Zintus-Exif-Stripped, " +
        "X-Zintus-Engineer-Review-Approved-Terminal",
      Vary: "Origin",
    };
    if (origin) {
      headers["Access-Control-Allow-Origin"] = origin;
      // Private-Network-Access (Chrome): a public/HTTPS site (e.g. www.zintus.ai)
      // preflighting a request to the user's loopback gateway is blocked unless we
      // answer with Allow-Private-Network: true. Emit it ONLY on the OPTIONS
      // preflight that explicitly asks (Access-Control-Request-Private-Network:
      // true), and ONLY when `origin` already passed the CORS allow-list above
      // (resolveCorsOrigin returned non-null). Never for a non-allow-listed site,
      // and never on a normal (non-preflight) response.
      if (
        request.method === "OPTIONS" &&
        request.headers.get("Access-Control-Request-Private-Network") === "true"
      ) {
        headers["Access-Control-Allow-Private-Network"] = "true";
      }
    }
    return headers;
  }

  function json(
    request: Request,
    data: unknown,
    status = 200,
    extraHeaders: Record<string, string> = {},
  ): Response {
    return new Response(JSON.stringify(data), {
      status,
      headers: {
        "Content-Type": "application/json",
        ...corsHeaders(request),
        ...extraHeaders,
      },
    });
  }

  function isAuthorized(request: Request): boolean {
    return bearerAuthorized(request.headers.get("authorization"), config.token);
  }

  /**
   * Apply the optional rate limiter to a request. Returns a 429 Response when the
   * caller is over budget, or null to proceed. No-op when no limiter is injected.
   */
  function enforceRateLimit(
    request: Request,
    requestId: string,
    path: string,
  ): Response | null {
    if (!rateLimiter) {
      return null;
    }
    const verdict = rateLimiter.check(rateLimiter.keyFor(request));
    if (verdict.ok) {
      return null;
    }
    const retryAfterSec = Math.ceil(verdict.retryAfterMs / 1000);
    metrics.recordRateLimited();
    log("warn", "ratelimit.exceeded", { requestId, path });
    return json(
      request,
      { error: { message: "Rate limit exceeded", type: "rate_limit_error" } },
      429,
      { "Retry-After": String(retryAfterSec) },
    );
  }

  /**
   * GET /v1/route/options — a LOCAL, BYOK-only quota-exhaustion DECISION API.
   *
   * Given a provider (and an optional client `quota` hint), it derives — using
   * ONLY local provider/quota/runtime state — what the UI should do when that
   * provider's free-tier quota is low or exhausted. It never bills, holds funds,
   * manages keys, or offers a paid/credits/overflow path: the only actions it can
   * recommend are the BYOK options `compress_harder`, `switch_provider`,
   * `use_local`, and `wait`. The response carries only derived fields — no API
   * keys, prompt/chat content, or internal secrets ever leak through it.
   */
  async function handleRouteOptions(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const providerParam = url.searchParams.get("provider");

    // Validate `provider` against the REAL ProviderId set (400 on unknown).
    const known = listProviders();
    const match = known.find((p) => p.id === providerParam);
    if (!providerParam || !match) {
      return json(
        request,
        {
          error: {
            message: `Unknown provider: ${providerParam ?? "(missing)"}`,
          },
        },
        400,
      );
    }
    const provider = match.id;

    // Optional client quota hint (0..1). Ignored when malformed/out of range —
    // the server's ledger value is always preferred when available.
    let clientHint: number | null = null;
    const rawQuota = url.searchParams.get("quota");
    if (rawQuota != null && rawQuota.trim() !== "") {
      const n = Number(rawQuota);
      if (Number.isFinite(n) && n >= 0 && n <= 1) {
        clientHint = n;
      }
    }

    const statuses = await engine.getProviderStatus();
    const self = statuses.find((s) => s.id === provider);

    // localAvailable: reuse the gateway's existing Ollama/LM-Studio detection.
    // (The router's `available` flag is unreliable for local runtimes — they have
    // no key/limit so it reports them available even when the process is down.)
    const runtimes = await detectLocal();

    // The decision itself lives in route-options.ts (shared with the CLI, which
    // runs the engine in-process) — same inputs, same answer on every surface.
    const payload = computeRouteOptions({
      provider,
      statuses,
      // Ledger value only when this provider is keyed (the ledger genuinely
      // tracks its usage); computeRouteOptions falls back to the client hint.
      ledgerQuotaRemaining:
        self?.hasKey === true ? engine.getQuotaRemaining(provider) : null,
      clientHint,
      runtimes,
    });
    return json(request, payload);
  }

  /**
   * Connect the MCP servers a chat request lists, gather + filter their tools,
   * and return the merged ToolDefinitions plus a serverId→config map for routing
   * tool calls back. Throws on connect/list failure so the caller can surface an
   * honest error BEFORE opening the answer stream. Never logs tool args/results.
   */
  async function gatherMcpTools(mcp: NonNullable<ChatCompletionRequest["mcp"]>): Promise<{
    tools: ToolDefinition[];
    configsById: Map<string, MCPServerConfig>;
  }> {
    const configsById = new Map<string, MCPServerConfig>();
    const tools: ToolDefinition[] = [];
    const enabledSet = mcp.enabledTools ? new Set(mcp.enabledTools) : null;
    for (const config of mcp.servers as MCPServerConfig[]) {
      const serverId = configId(config);
      configsById.set(serverId, config);
      const client = await mcpRegistry.getOrConnect(config);
      const advertised = await client.listTools();
      // `enabledTools` may carry either the raw server-local name or the
      // namespaced `mcp__<id>__<tool>` (whatever the UI surfaced from discover).
      const filtered = enabledSet
        ? advertised.filter(
            (t) =>
              enabledSet.has(t.name) ||
              enabledSet.has(mcpToolName(serverId, t.name)),
          )
        : advertised;
      tools.push(...mcpToolsToDefinitions(serverId, filtered));
    }
    return { tools, configsById };
  }

  /**
   * SERVER-SIDE MCP chat path. Connects the listed MCP servers, merges their
   * tools with any client `tools`, and runs a BOUNDED tool loop (≤
   * MAX_MCP_TOOL_ROUNDS model calls): call the provider → if it returns
   * `mcp__*` tool calls, execute them against the owning server and feed the
   * results back, repeat → stream the final answer. Per-step tool-call /
   * tool-result EVENTS are emitted in the SSE stream so the client can show
   * "calling X / got result". A turn that calls NON-MCP (client) tools is handed
   * off to the client unchanged (OpenAI tool_calls + finish_reason).
   *
   * NO-CUSTODY: MCP config/args/results never touch the relay and are never
   * logged. stdio servers spawn the user's OWN local processes (their config) —
   * fine on the loopback gateway (see mcp-registry header).
   */
  async function handleMcpChat(
    request: Request,
    requestId: string,
    body: ChatCompletionRequest,
    messages: ChatMessage[],
  ): Promise<Response> {
    let merged: { tools: ToolDefinition[]; configsById: Map<string, MCPServerConfig> };
    try {
      merged = await gatherMcpTools(body.mcp!);
    } catch (error) {
      metrics.recordError();
      const message = error instanceof Error ? error.message : String(error);
      // No tool args/results here — only a connection-level message — but scrub
      // defensively (a server URL/header echo could carry a token).
      log("warn", "mcp.connect_failed", { requestId });
      return json(
        request,
        {
          error: {
            type: "mcp_connect_error",
            message: `Failed to connect to an MCP server: ${redactSecrets(message)}`,
          },
        },
        502,
      );
    }
    const mergedTools: ToolDefinition[] = [
      ...(body.tools ?? []),
      ...merged.tools,
    ];
    const configsById = merged.configsById;
    // Resolve forced-provider / OpenRouter-style `provider` object → strategy /
    // weights / forced provider (see resolveChatRouting).
    const routing = resolveChatRouting(body);

    // Per-request abort: client disconnect OR a connect/start timeout tears down
    // the in-flight upstream fetch (mirrors handleChatCompletions).
    const upstreamAbort = new AbortController();
    if (request.signal) {
      if (request.signal.aborted) {
        upstreamAbort.abort();
      } else {
        request.signal.addEventListener("abort", () => upstreamAbort.abort(), {
          once: true,
        });
      }
    }

    metrics.recordChat("mcp" as ProviderId);
    log("info", "mcp.chat", {
      requestId,
      servers: body.mcp!.servers.length,
      mcpTools: merged.tools.length,
      clientTools: body.tools?.length ?? 0,
    });

    const encoder = new TextEncoder();
    const chunkFrame = (data: Record<string, unknown>): Uint8Array =>
      encoder.encode(`data: ${JSON.stringify(data)}\n\n`);

    const stream = new ReadableStream({
      async start(controller) {
        const working: ChatMessage[] = [...messages];
        let capturedUsage: RouteUsage | undefined;
        let lastResult:
          | Awaited<ReturnType<Engine["routeAndStream"]>>
          | undefined;
        try {
          for (let round = 0; round < MAX_MCP_TOOL_ROUNDS; round++) {
            const result = await withTimeout(
              engine.routeAndStream({
                signal: upstreamAbort.signal,
                onUsage: (usage) => {
                  capturedUsage = usage;
                },
                messages: working,
                model: body.model,
                provider: routing.provider,
                mode: body.mode,
                tools: mergedTools,
                toolChoice: body.tool_choice,
                stream: true,
                virtualKey: body.virtual_key ?? body.virtualKey,
                providerWeights: routing.providerWeights,
                strategy: routing.strategy,
                blockTrainingProviders: body.block_training,
                allowTrainingProviders: body.allow_training,
                persist: body.persist,
                projectId: body.project_id ?? body.projectId,
                keys: body.keys,
                diffText: body.diff,
                temperature: body.temperature,
                maxTokens: body.max_tokens,
              }),
              requestTimeoutMs,
            );
            lastResult = result;

            // Stream this round's text as it arrives (idle-watchdog protected).
            let roundText = "";
            for await (const piece of withIdleWatchdog(result.stream, {
              idleMs: streamIdleTimeoutMs,
              abort: upstreamAbort,
            })) {
              roundText += piece;
              controller.enqueue(
                chunkFrame({
                  id: result.traceId,
                  object: "chat.completion.chunk",
                  model: result.model,
                  provider: result.providerId,
                  choices: [{ index: 0, delta: { content: piece } }],
                }),
              );
            }

            // Tool calls are fully populated only now that the text drained.
            const toolCalls = result.toolCalls ?? [];
            const mcpCalls = toolCalls.filter(isMcpToolCall);

            // Final turn when there are no tool calls, OR the turn mixes in
            // NON-MCP (client) tools we can't satisfy server-side → hand the
            // whole turn off to the client via the existing OpenAI channel.
            if (toolCalls.length === 0 || mcpCalls.length < toolCalls.length) {
              if (toolCalls.length > 0) {
                toolCalls.forEach((call, i) => {
                  controller.enqueue(
                    chunkFrame({
                      id: result.traceId,
                      object: "chat.completion.chunk",
                      model: result.model,
                      provider: result.providerId,
                      choices: [
                        {
                          index: 0,
                          delta: {
                            tool_calls: [
                              {
                                index: i,
                                id: call.id,
                                type: "function",
                                function: {
                                  name: call.name,
                                  arguments: JSON.stringify(call.arguments),
                                },
                              },
                            ],
                          },
                          finish_reason: null,
                        },
                      ],
                    }),
                  );
                });
                controller.enqueue(
                  chunkFrame({
                    id: result.traceId,
                    object: "chat.completion.chunk",
                    model: result.model,
                    provider: result.providerId,
                    choices: [
                      { index: 0, delta: {}, finish_reason: "tool_calls" },
                    ],
                  }),
                );
              }
              break;
            }

            // All tool calls are MCP → record the assistant turn, execute the
            // tools, feed results back, and loop.
            const assistantBlocks: ContentBlock[] = [];
            if (roundText.length > 0) {
              assistantBlocks.push({ type: "text", text: roundText });
            }
            for (const call of toolCalls) {
              assistantBlocks.push(call);
            }
            working.push({ role: "assistant", content: assistantBlocks });

            // Emit a "calling X" event per MCP tool call (mirrors the tool-call
            // channel; carries `type:"mcp_tool_call"` so clients can discriminate).
            mcpCalls.forEach((call, i) => {
              controller.enqueue(
                chunkFrame({
                  id: result.traceId,
                  object: "chat.completion.chunk",
                  type: "mcp_tool_call",
                  model: result.model,
                  provider: result.providerId,
                  choices: [
                    {
                      index: 0,
                      delta: {
                        tool_calls: [
                          {
                            index: i,
                            id: call.id,
                            type: "function",
                            function: {
                              name: call.name,
                              arguments: JSON.stringify(call.arguments),
                            },
                          },
                        ],
                      },
                      finish_reason: null,
                    },
                  ],
                }),
              );
            });

            // Execute server-side. executeMcpToolCall never throws — a failure
            // comes back as an isError tool_result the model can recover from.
            const results: ToolResultContentBlock[] = await Promise.all(
              mcpCalls.map((call) =>
                executeMcpToolCall(mcpRegistry, configsById, call),
              ),
            );

            // Emit a "got result" event per tool result.
            for (const res of results) {
              controller.enqueue(
                chunkFrame({
                  id: result.traceId,
                  object: "chat.completion.chunk",
                  type: "mcp_tool_result",
                  model: result.model,
                  provider: result.providerId,
                  choices: [],
                  tool_call_id: res.toolCallId,
                  is_error: res.isError ?? false,
                  content: res.content,
                }),
              );
            }

            working.push({ role: "user", content: results });
          }

          // Per-response transparency strip, once final token counts are known.
          if (capturedUsage && lastResult) {
            controller.enqueue(
              chunkFrame({
                ...buildUsageMetadata(
                  capturedUsage,
                  routing.strategy,
                  lastResult.privacyHonored,
                  lastResult.routeReason,
                  lastResult.memoryUsed,
                ),
                object: "chat.completion.chunk",
                model: lastResult.model,
                provider: lastResult.providerId,
                choices: [],
              }),
            );
          }
          if (lastResult) {
            recordTurnActivity(lastResult, capturedUsage, body.persist !== false);
          }
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Stream failed";
          metrics.recordError();
          onError?.(error, { requestId, path: "/v1/chat/completions" });
          log("error", "mcp.chat_failed", {
            requestId,
            error: redactSecrets(message),
          });
          controller.enqueue(
            chunkFrame({ error: { message: redactSecrets(message) } }),
          );
        } finally {
          controller.close();
        }
      },
      cancel() {
        upstreamAbort.abort();
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        ...corsHeaders(request),
      },
    });
  }

  async function handleChatCompletions(
    request: Request,
    requestId: string,
  ): Promise<Response> {
    // Enforce a body-size cap up front: trust Content-Length when present, then
    // re-check the actual bytes after reading (chunked requests omit the header).
    const declaredLength = Number(request.headers.get("content-length") ?? "");
    if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
      return json(request, { error: { message: "Request body too large" } }, 413);
    }
    const raw = await request.text();
    if (new TextEncoder().encode(raw).length > maxBodyBytes) {
      return json(request, { error: { message: "Request body too large" } }, 413);
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      return json(request, { error: { message: "Invalid JSON body" } }, 400);
    }
    // Schema-validate the body (zod) instead of trusting an inline cast. Unknown
    // keys are stripped; malformed types get a 400 with field-level issues
    // rather than partial/surprising downstream handling.
    const parsed = ChatCompletionRequestSchema.safeParse(parsedJson);
    if (!parsed.success) {
      return json(
        request,
        {
          error: {
            message: "Invalid request body",
            issues: formatIssues(parsed.error),
          },
        },
        400,
      );
    }
    const body = parsed.data;
    // Resolve the legacy forced-provider STRING vs. the OpenRouter-style
    // `provider: { order, sort, allow_fallbacks }` OBJECT into the forced
    // provider / strategy / weights threaded below (see resolveChatRouting). All
    // capability gates and the engine call use `routing.provider` (a real
    // ProviderId or undefined), never the raw union.
    const routing = resolveChatRouting(body);

    const messages = parseMessages(body);
    if (messages.length > maxMessages) {
      return json(
        request,
        { error: { message: `Too many messages (max ${maxMessages})` } },
        413,
      );
    }

    // ── Multimodal image input ─────────────────────────────────────────────
    // The schema already validated each image (mime/exif/size/base64). Here we
    // bound the COUNT and gate vision routing. Image bytes are never logged,
    // never sent to the relay, and never passed through Tokzen (see below).
    const imageTotal = imageCount(messages);
    if (imageTotal > 4) {
      return json(
        request,
        { error: { message: "Too many images (max 4 per request)" } },
        413,
      );
    }
    const hasImages = imageTotal > 0;
    const wantsTools = (body.tools?.length ?? 0) > 0;
    // MCP requested ⇒ the gateway will host the listed servers and add their
    // tools, so this turn is effectively a tools turn for capability gating.
    const mcpRequested = (body.mcp?.servers?.length ?? 0) > 0;
    // Explicit-provider gate: if the user PICKED a provider, never silently send
    // their image elsewhere — fail clearly if that provider/model can't see it.
    // Ollama is runtime-resolved: an image turn without a pinned vision model is
    // answered by the first INSTALLED multimodal model (llava/moondream/…) —
    // pinned into body.model so the router's static vision filter agrees — and
    // 422s honestly when none is installed (the error suggests what to pull).
    if (hasImages && routing.provider && !supportsVision(routing.provider, body.model)) {
      if (routing.provider === "ollama" && !body.model) {
        const vision = await localVisionModel();
        if (!vision) return json(request, UNSUPPORTED_VISION_ERROR, 422);
        body.model = vision;
      } else {
        return json(request, UNSUPPORTED_VISION_ERROR, 422);
      }
    }
    // Same explicit-provider gate for tools: a tools-bearing request against a
    // provider/model that can't call tools hard-errors rather than silently
    // dropping the tools and returning a text-only answer.
    if (
      (wantsTools || mcpRequested) &&
      routing.provider &&
      !supportsTools(routing.provider, body.model)
    ) {
      return json(request, UNSUPPORTED_TOOLS_ERROR, 422);
    }
    // ── MCP server-side tool loop ──────────────────────────────────────────
    // Additive: present ONLY when the request carries `mcp.servers`. Connects
    // each server (cached registry), merges their tools with any client `tools`,
    // and runs a bounded server-side tool loop. The existing flow below is left
    // byte-identical when `mcp` is absent.
    if (mcpRequested && !hasImages) {
      return handleMcpChat(request, requestId, body, messages);
    }
    // Same explicit-provider gate for STRICT structured output: a request that
    // DEMANDS schema-guaranteed JSON (json_schema + strict) against a picked
    // provider/model whose strongest structured level isn't `json_schema`
    // hard-errors rather than silently downgrading to best-effort json/prose.
    const wantsStrictSchema =
      body.response_format?.type === "json_schema" &&
      body.response_format.strict === true;
    if (
      wantsStrictSchema &&
      routing.provider &&
      structuredOutputLevel(routing.provider, body.model) !== "json_schema"
    ) {
      return json(request, UNSUPPORTED_STRUCTURED_ERROR, 422);
    }
    const imageBytes = messages.reduce(
      (sum, m) =>
        sum +
        (isContentBlockArray(m.content)
          ? m.content.reduce(
              (s, b) => s + (b.type === "image" ? b.bytes : 0),
              0,
            )
          : 0),
      0,
    );

    // Web search: apply the provider-appropriate strategy BEFORE Tokzen runs,
    // so any injected search context gets compressed like everything else.
    //   groq        → switch model to a compound model (native, free)
    //   gemini/openrouter → native tool flag threaded to the provider
    //   everyone else     → external Tavily/Serper results injected as context
    let searchMessages = messages;
    let nativeWebSearch = false;
    let effectiveModel = body.model;
    if (body.search?.enabled) {
      const searchProvider = routing.provider;
      const strategy = getSearchStrategy(searchProvider);
      const depth: SearchDepth = body.search.depth ?? "standard";
      if (strategy === "groq-compound") {
        effectiveModel = groqCompoundModel(depth);
      } else if (
        strategy === "gemini-grounding" ||
        strategy === "openrouter-tool"
      ) {
        nativeWebSearch = true;
      } else {
        const query = extractSearchQuery(messages);
        if (query) {
          try {
            const outcome = await runFallbackSearch(
              query,
              { enabled: true, depth, maxResults: body.search.maxResults },
              {
                tavilyApiKey: config.tavilyApiKey,
                serperApiKey: config.serperApiKey,
              },
            );
            searchMessages = injectSearchResults(messages, outcome.results);
            if (outcome.results.length === 0) {
              // Honest degradation: without this note the model improvises
              // ("I can't search") or worse, fabricates. servedBy === "none"
              // means no Tavily/Serper key is configured on this gateway.
              searchMessages = [
                ...searchMessages,
                {
                  role: "system" as const,
                  content:
                    outcome.servedBy === "none"
                      ? "The user enabled web search, but no search provider (TAVILY_API_KEY / SERPER_API_KEY) is configured on this gateway. Tell the user search is unavailable until a key is added in settings, then answer from your knowledge."
                      : "Web search was requested but returned no results this turn. Answer from your knowledge and say so honestly - do not fabricate search citations.",
                },
              ];
            }
            log("info", "search.fallback", {
              requestId,
              servedBy: outcome.servedBy,
              results: outcome.results.length,
            });
          } catch (error) {
            log("warn", "search.failed", {
              requestId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
      metrics.recordSearch(strategy);
    }

    // Tokzen: compress system + assistant TEXT before routing. SKIPPED entirely
    // for image requests — image base64 never passes through compression, and no
    // (fake) compression savings are reported for image bytes. The original
    // messages (with image blocks intact) flow to the router instead.
    const selectedProvider = routing.provider;
    let tokzenResult: Awaited<ReturnType<typeof compress>> | undefined;
    let compressedMessages: ChatMessage[] = [];
    // Tokzen flattens every message to text (textOf) and REPLACES the array —
    // which would destroy tool_call/tool_result blocks. Skip it for tool requests
    // (definitions this turn OR a continuation turn carrying tool blocks), exactly
    // as it is skipped for image requests. The original messages flow to the router.
    const hasTools = wantsTools || hasToolTurns(messages);
    if (!hasImages && !hasTools) {
      const quotaRemaining = selectedProvider ? (getQuotaRemaining?.(selectedProvider) ?? 1.0) : 1.0;
      const tokzenProvider =
        selectedProvider === "groq" ? "groq" as const
        : selectedProvider === "gemini" ? "gemini" as const
        : "openai" as const;
      tokzenResult = await compress(
        { messages: searchMessages.map((m) => ({ role: m.role as "system" | "user" | "assistant" | "tool", content: textOf(m.content) })) },
        {
          provider: tokzenProvider,
          model: body.model ?? "unknown",
          quotaRemaining,
          tokenBudget: 8000,
          sessionId: body.thread_id,
        },
      );
      compressedMessages = tokzenResult.messages
        .filter((m): m is { role: "system" | "user" | "assistant"; content: string } =>
          m.role === "system" || m.role === "user" || m.role === "assistant",
        );
      metrics.recordTokzenSavings(
        tokzenResult.totalResult.originalTokens,
        tokzenResult.totalResult.compressedTokens,
        tokzenResult.totalResult.ratio,
        selectedProvider,
      );
    }

    // Per-request abort controller. Aborting it tears down the upstream
    // provider fetch (signal is threaded RouteRequest -> router -> provider),
    // which both releases the in-flight quota reservation and closes the
    // socket. Two things trip it: (1) the client disconnecting, and (2) the
    // connect/start timeout below — previously withTimeout only rejected,
    // leaving the upstream connection to hang indefinitely.
    const upstreamAbort = new AbortController();
    if (request.signal) {
      if (request.signal.aborted) {
        upstreamAbort.abort();
      } else {
        request.signal.addEventListener("abort", () => upstreamAbort.abort(), {
          once: true,
        });
      }
    }

    // Captured when the winning provider's stream completes — drives the
    // per-response transparency strip (provider/model/tokens/latency/savings).
    let capturedUsage: RouteUsage | undefined;

    let result: Awaited<ReturnType<Engine["routeAndStream"]>>;
    // One routing attempt. `overrides` lets the local-vision fallback below
    // retry the SAME request pinned to an installed multimodal Ollama model.
    const routeOnce = (overrides?: { provider?: ProviderId; model?: string }) =>
      withTimeout(
        engine.routeAndStream({
          signal: upstreamAbort.signal,
          onUsage: (usage) => {
            capturedUsage = usage;
          },
          messages: compressedMessages.length > 0 ? compressedMessages : searchMessages,
          message:
            typeof body.message === "string"
              ? { role: "user", content: body.message }
              : body.message
                ? {
                    role: (body.message.role ?? "user") as ChatMessage["role"],
                    content: body.message.content,
                  }
                : undefined,
          model: overrides?.model ?? effectiveModel,
          provider: overrides?.provider ?? routing.provider,
          mode: body.mode,
          threadId: body.thread_id,
          webSearch: nativeWebSearch,
          tools: body.tools,
          toolChoice: body.tool_choice,
          responseFormat: body.response_format,
          stream: body.stream !== false,
          virtualKey: body.virtual_key ?? body.virtualKey,
          providerWeights: routing.providerWeights,
          strategy: routing.strategy,
          blockTrainingProviders: body.block_training,
          persist: body.persist,
          projectId: body.project_id ?? body.projectId,
          allowTrainingProviders: body.allow_training,
          keys: body.keys,
          diffText: body.diff,
          temperature: body.temperature,
          maxTokens: body.max_tokens,
          // Honor `Cache-Control: no-cache` (or no-store) to bypass the cache.
          bypassCache: /no-(cache|store)/i.test(
            request.headers.get("cache-control") ?? "",
          ),
        }),
        requestTimeoutMs,
      );
    const timeout408 = (error: RequestTimeoutError) => {
      // Abort the (still-pending) upstream connect so the socket and the
      // in-flight reservation are released rather than leaked.
      upstreamAbort.abort();
      log("warn", "chat.timeout", { requestId });
      return json(
        request,
        { error: { message: redactSecrets(error.message) } },
        408,
      );
    };
    try {
      result = await routeOnce();
    } catch (error) {
      if (error instanceof RequestTimeoutError) {
        return timeout408(error);
      }
      // The router rejected the request because no candidate had the required
      // capability (auto-routing case). The same "unsupported_capability" Error
      // is thrown for vision, tools, OR strict structured output, so disambiguate
      // by REQUEST SHAPE: a strict json_schema request with no image/tools maps to
      // the structured error; a tools-only request (tools present, no images) maps
      // to the tools error; anything involving an image maps to the vision error.
      if (error instanceof Error && error.message === "unsupported_capability") {
        // Auto-routed image request with no eligible vision candidate: before
        // giving up, resolve an INSTALLED local vision model (the same runtime
        // resolution the explicit-ollama gate uses) and retry once via ollama.
        // A machine with llava/moondream serves "Auto + image" locally with
        // zero vision API keys; without one, the honest 422 below stands.
        if (hasImages && !routing.provider) {
          const vision = await localVisionModel();
          if (vision) {
            try {
              result = await routeOnce({ provider: "ollama", model: vision });
            } catch (retryError) {
              if (retryError instanceof RequestTimeoutError) {
                return timeout408(retryError);
              }
              return json(request, UNSUPPORTED_VISION_ERROR, 422);
            }
          } else {
            return json(request, UNSUPPORTED_VISION_ERROR, 422);
          }
        } else {
          const body422 =
            wantsStrictSchema && !hasImages && !wantsTools
              ? UNSUPPORTED_STRUCTURED_ERROR
              : wantsTools && !hasImages
                ? UNSUPPORTED_TOOLS_ERROR
                : UNSUPPORTED_VISION_ERROR;
          return json(request, body422, 422);
        }
      } else {
        throw error;
      }
    }

    const metaHeaders: Record<string, string> = {
      "X-Provider-Used": result.providerId,
      "X-Cache-Hit": result.cacheHit ?? "miss",
      "X-Failover-Count": String(result.failoverCount ?? 0),
    };
    // Human route-reason (why this provider/model) — surfaced on every platform.
    // Header values must be Latin-1; strip any stray non-ASCII defensively (the
    // full unicode-safe reason still rides in the metadata SSE/JSON frame).
    if (result.routeReason) {
      metaHeaders["X-Zintus-Route-Reason"] = result.routeReason.replace(
        /[^\x20-\x7E]/g,
        " ",
      );
    }
    // Privacy-mode honesty: surface whether private mode was honored so clients
    // can warn "used <provider> — Private Mode not honored" instead of failing
    // silently. Present only when block_training was requested.
    if (result.privacyHonored !== undefined) {
      metaHeaders["X-Zintus-Private-Honored"] = String(result.privacyHonored);
    }
    // Multimodal: surface how an image request was actually served (which
    // vision provider, how many images, total processed bytes, EXIF stripped).
    if (hasImages) {
      metaHeaders["X-Zintus-Vision-Provider"] = result.providerId;
      metaHeaders["X-Zintus-Images"] = String(imageTotal);
      metaHeaders["X-Zintus-Image-Bytes"] = String(imageBytes);
      metaHeaders["X-Zintus-Exif-Stripped"] = "true";
    }

    // Surface Tokzen compression savings as derived-only response headers so
    // web/desktop can show "compressed N%, saved ~X tokens (~$Y)". Emit ONLY
    // when real compression happened (compressedTokens < originalTokens and
    // ratio < 1); otherwise omit every header rather than reporting zeros.
    // These carry purely derived integers/ratios — never keys, prompt content,
    // or secrets. They're known before the answer streams, so they ride along
    // as HTTP headers on both the streaming and non-streaming responses.
    if (tokzenResult) {
      const { originalTokens, compressedTokens, ratio } =
        tokzenResult.totalResult;
      if (compressedTokens < originalTokens && ratio < 1) {
        const tokensSaved = originalTokens - compressedTokens;
        metaHeaders["X-Zintus-Original-Tokens"] = String(originalTokens);
        metaHeaders["X-Zintus-Compressed-Tokens"] = String(compressedTokens);
        metaHeaders["X-Zintus-Tokens-Saved"] = String(tokensSaved);
        metaHeaders["X-Zintus-Compression-Ratio"] = ratio.toFixed(2);
        // Estimate-only USD on the SAVED input tokens, priced against the model
        // that actually served. pricing.ts is non-billing; this is illustrative.
        // Unknown (provider, model) → estimate 0 → omit just this one header.
        const costSaved = estimateCostUsd(
          result.providerId,
          result.model,
          tokensSaved,
          0,
        );
        if (costSaved > 0) {
          metaHeaders["X-Zintus-Cost-Saved-Usd"] = String(
            Number(costSaved.toFixed(6)),
          );
        }
      }
    }

    metrics.recordChat(result.providerId);
    log("info", "chat.route", {
      requestId,
      traceId: result.traceId,
      provider: result.providerId,
      model: result.model,
      streaming: body.stream !== false,
      cacheHit: result.cacheHit ?? "miss",
      failoverCount: result.failoverCount ?? 0,
      images: imageTotal,
    });

    if (body.stream === false) {
      // The start timeout above only bounds engine.routeAndStream() RESOLVING
      // (connect/TTFB) — it does NOT cover consuming the stream below. A provider
      // that opens the socket then stalls mid-aggregation would otherwise hang
      // this buffered read forever. Apply the same per-chunk idle watchdog the
      // streaming branch uses (same streamIdleTimeoutMs); on idle it aborts the
      // upstream and we return 408, consistent with the start-timeout response.
      let content = "";
      try {
        for await (const chunk of withIdleWatchdog(result.stream, {
          idleMs: streamIdleTimeoutMs,
          abort: upstreamAbort,
        })) {
          content += chunk;
        }
      } catch (error) {
        if (error instanceof StreamIdleTimeoutError) {
          metrics.recordError();
          log("warn", "chat.idle_timeout", { requestId });
          return json(
            request,
            { error: { message: redactSecrets(error.message) } },
            408,
          );
        }
        throw error;
      }
      // Tool calls are populated on result.toolCalls as the stream drains — read
      // them now (AFTER the loop above) when the live channel is complete. When
      // present, surface them OpenAI-shape on the assistant message with
      // finish_reason:"tool_calls"; content is null when the turn was tools-only.
      const toolCalls = result.toolCalls ?? [];
      const hasToolCalls = toolCalls.length > 0;
      const message = hasToolCalls
        ? {
            role: "assistant" as const,
            content: content.length > 0 ? content : null,
            tool_calls: toolCalls.map((call) => ({
              id: call.id,
              type: "function" as const,
              function: {
                name: call.name,
                arguments: JSON.stringify(call.arguments),
              },
            })),
          }
        : { role: "assistant" as const, content };
      // Structured output (§2.3): the engine buffered+validated the response and
      // attached `structuredOutput` metadata plus the `parsed` value. Surface both
      // on the JSON body. A STRICT request whose output did NOT validate (after the
      // engine exhausted repair) is an honest hard failure — return 422 with the
      // metadata rather than a 200 carrying non-conformant prose.
      const { structuredOutput, parsed } = asStructured(result);
      if (structuredOutput && body.response_format?.strict && !structuredOutput.valid) {
        return json(
          request,
          {
            error: {
              type: "structured_output_invalid",
              message:
                "The model's output did not conform to the requested schema after repair attempts.",
              structured_output: structuredOutputBody(structuredOutput),
            },
          },
          422,
          metaHeaders,
        );
      }
      // Durable usage history: this turn completed and its usage is known.
      recordTurnActivity(result, capturedUsage, body.persist !== false);
      return json(
        request,
        {
          id: result.traceId,
          object: "chat.completion",
          model: result.model,
          provider: result.providerId,
          thread_id: result.threadId,
          compile_trace_id: result.compileTraceId,
          choices: [
            {
              index: 0,
              message,
              finish_reason: hasToolCalls ? "tool_calls" : "stop",
            },
          ],
          ...(structuredOutput
            ? {
                parsed,
                structured_output: structuredOutputBody(structuredOutput),
              }
            : {}),
          ...(capturedUsage
            ? {
                metadata: buildUsageMetadata(
                  capturedUsage,
                  routing.strategy,
                  result.privacyHonored,
                  result.routeReason,
                  result.memoryUsed,
                ),
              }
            : {}),
        },
        200,
        metaHeaders,
      );
    }

    // Structured-output honesty on the DEFAULT (streaming) path. The engine
    // BUFFERS + validates the whole structured document before routeAndStream
    // resolves, so `structuredOutput.valid` is already known here — BEFORE the
    // SSE stream opens. A STRICT json_schema request whose output did NOT
    // validate (after the engine exhausted repair) is an honest hard failure:
    // return the same 422 the non-streaming branch returns, rather than opening
    // a 200 stream that emits a `valid:false` frame + non-conformant prose.
    // Non-strict (json_object / no-strict json_schema) behavior is unchanged.
    {
      const { structuredOutput } = asStructured(result);
      if (wantsStrictSchema && structuredOutput && !structuredOutput.valid) {
        return json(
          request,
          {
            error: {
              type: "structured_output_invalid",
              message:
                "The model's output did not conform to the requested schema after repair attempts.",
              structured_output: structuredOutputBody(structuredOutput),
            },
          },
          422,
          metaHeaders,
        );
      }
    }

    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        // Mid-stream idle watchdog. The start-timeout above only guards the
        // connect/first-token phase; once the stream is open a provider can
        // stall (socket alive, no chunks) and the client would hang until it
        // gave up. Race each chunk read against an idle deadline that RESETS on
        // every received chunk: when it fires we abort the upstream (releasing
        // the socket + in-flight quota reservation) and fall through to the
        // shared error path below. Disabled when streamIdleTimeoutMs <= 0.
        const iterator = result.stream[Symbol.asyncIterator]();
        let idleTimer: ReturnType<typeof setTimeout> | null = null;
        const clearIdle = () => {
          if (idleTimer) {
            clearTimeout(idleTimer);
            idleTimer = null;
          }
        };
        try {
          for (;;) {
            let step: IteratorResult<string>;
            if (streamIdleTimeoutMs > 0) {
              const idle = new Promise<never>((_resolve, reject) => {
                idleTimer = setTimeout(() => {
                  upstreamAbort.abort();
                  reject(new StreamIdleTimeoutError(streamIdleTimeoutMs));
                }, streamIdleTimeoutMs);
                (idleTimer as { unref?: () => void }).unref?.();
              });
              try {
                step = await Promise.race([iterator.next(), idle]);
              } finally {
                // Reset on each chunk (and clear on the idle-fire path).
                clearIdle();
              }
            } else {
              step = await iterator.next();
            }
            if (step.done) {
              break;
            }
            const payload = {
              id: result.traceId,
              object: "chat.completion.chunk",
              model: result.model,
              provider: result.providerId,
              thread_id: result.threadId,
              compile_trace_id: result.compileTraceId,
              choices: [{ index: 0, delta: { content: step.value } }],
            };
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(payload)}\n\n`),
            );
          }
          // Tool calls: result.toolCalls is the LIVE channel — fully populated
          // only now that the text stream has drained. Emit them OpenAI-shape so
          // a generic client accumulates `delta.tool_calls` then sees a
          // finish_reason:"tool_calls" terminating delta — matching how OpenAI
          // streams tool calls. Each call is its own chunk (index i), then a
          // final empty delta carries the finish_reason.
          if (result.toolCalls?.length) {
            result.toolCalls.forEach((call, i) => {
              const toolPayload = {
                id: result.traceId,
                object: "chat.completion.chunk",
                model: result.model,
                provider: result.providerId,
                thread_id: result.threadId,
                compile_trace_id: result.compileTraceId,
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [
                        {
                          index: i,
                          id: call.id,
                          type: "function",
                          function: {
                            name: call.name,
                            arguments: JSON.stringify(call.arguments),
                          },
                        },
                      ],
                    },
                    finish_reason: null,
                  },
                ],
              };
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify(toolPayload)}\n\n`),
              );
            });
            const finishPayload = {
              id: result.traceId,
              object: "chat.completion.chunk",
              model: result.model,
              provider: result.providerId,
              thread_id: result.threadId,
              compile_trace_id: result.compileTraceId,
              choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
            };
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(finishPayload)}\n\n`),
            );
          }
          // Emit per-response metadata (transparency strip) once the stream
          // completes, when final token counts are known. Wrapped in a valid
          // chat.completion.chunk envelope (object + empty choices) so generic
          // OpenAI clients — and the SSE contract — see only chat.completion.chunk
          // frames; the Zintus web client still discriminates it via type:"metadata".
          if (capturedUsage) {
            const usagePayload = {
              ...buildUsageMetadata(
                capturedUsage,
                routing.strategy,
                result.privacyHonored,
                result.routeReason,
                result.memoryUsed,
              ),
              object: "chat.completion.chunk",
              model: result.model,
              provider: result.providerId,
              thread_id: result.threadId,
              compile_trace_id: result.compileTraceId,
              choices: [],
            };
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(usagePayload)}\n\n`),
            );
          }
          // Structured output is BUFFERED, not token-streamed (the engine holds
          // the whole document to validate/repair it, §5.2). The text already
          // drained above as a single block; now emit ONE terminal frame carrying
          // the validated `parsed` value + `structured_output` metadata so the
          // streaming client gets the same honesty signal as the JSON path. Wrapped
          // in a chat.completion.chunk envelope to keep the SSE contract uniform.
          {
            const { structuredOutput, parsed } = asStructured(result);
            if (structuredOutput) {
              const structuredPayload = {
                object: "chat.completion.chunk",
                model: result.model,
                provider: result.providerId,
                thread_id: result.threadId,
                compile_trace_id: result.compileTraceId,
                choices: [],
                parsed,
                structured_output: structuredOutputBody(structuredOutput),
              };
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify(structuredPayload)}\n\n`),
              );
            }
          }
          // The stream drained without error → a real completed turn. Persist
          // it to the durable activity store (best-effort, never throws here).
          recordTurnActivity(result, capturedUsage, body.persist !== false);
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Stream failed";
          metrics.recordError();
          onError?.(error, { requestId, path: "/v1/chat/completions" });
          log("error", "chat.stream_failed", { requestId, error: message });
          // The structured log above is scrubbed by the log fn; the client copy
          // must be scrubbed here too — a mid-stream provider error can embed key
          // material, and this SSE error event is returned verbatim otherwise.
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ error: { message: redactSecrets(message) } })}\n\n`,
            ),
          );
        } finally {
          clearIdle();
          // Best-effort nudge so an upstream generator that honors return()
          // runs its cleanup (closing the provider fetch reader). Fire-and-
          // forget: a stalled generator already had its fetch aborted above,
          // and awaiting could deadlock behind a pending next().
          void iterator.return?.().catch(() => {});
          controller.close();
        }
      },
      // Client disconnected mid-stream: abort the upstream fetch so we stop
      // pulling (and paying quota for) tokens nobody is reading.
      cancel() {
        upstreamAbort.abort();
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        ...metaHeaders,
        ...(result.compileTokenEstimate == null
          ? {}
          : { "X-Compile-Tokens": String(result.compileTokenEstimate) }),
        ...corsHeaders(request),
      },
    });
  }

  /**
   * POST /v1/mcp/discover — connect (cached) to one MCP server and return its
   * advertised tools/resources/prompts for the UI's Test-connection / tool list.
   * Honest error (502) with a clear message on connect failure. Tool args/results
   * are not involved here, and nothing is logged about the server's contents.
   */
  async function handleMcpDiscover(
    request: Request,
    requestId: string,
  ): Promise<Response> {
    const parsed = MCPDiscoverRequestSchema.safeParse(
      await request.json().catch(() => null),
    );
    if (!parsed.success) {
      return json(
        request,
        {
          error: {
            message: "Invalid request body",
            issues: formatIssues(parsed.error),
          },
        },
        400,
      );
    }
    const config = parsed.data.config as MCPServerConfig;
    try {
      const client = await mcpRegistry.getOrConnect(config);
      const [tools, resources, prompts] = await Promise.all([
        client.listTools(),
        client.listResources(),
        client.listPrompts(),
      ]);
      const serverId = configId(config);
      return json(request, {
        serverId,
        // Tools are returned BOTH raw (for display) and namespaced (the name the
        // model/chat path will see) so the UI can drive `enabledTools`.
        tools: tools.map((t) => ({
          name: t.name,
          namespacedName: mcpToolName(serverId, t.name),
          description: t.description,
          inputSchema: t.inputSchema,
        })),
        resources,
        prompts,
        connectedAt: mcpRegistry.info(config)?.connectedAt ?? Date.now(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log("warn", "mcp.discover_failed", { requestId });
      return json(
        request,
        {
          error: {
            type: "mcp_connect_error",
            message: `Failed to connect to MCP server: ${redactSecrets(message)}`,
          },
        },
        502,
      );
    }
  }

  /**
   * DELETE /v1/mcp (body `{ config }`) — disconnect + evict a cached MCP server
   * connection (idempotent: succeeds even if it was never connected).
   */
  async function handleMcpDisconnect(request: Request): Promise<Response> {
    const parsed = MCPDiscoverRequestSchema.safeParse(
      await request.json().catch(() => null),
    );
    if (!parsed.success) {
      return json(
        request,
        {
          error: {
            message: "Invalid request body",
            issues: formatIssues(parsed.error),
          },
        },
        400,
      );
    }
    await mcpRegistry.disconnect(parsed.data.config as MCPServerConfig);
    return json(request, { ok: true });
  }

  /**
   * Deep research: decompose → parallel web search → synthesize, streamed as
   * SSE progress events. Requires an external search key (Tavily/Serper) since
   * it runs multiple provider-agnostic searches.
   */
  async function handleResearch(
    request: Request,
    requestId: string,
  ): Promise<Response> {
    const parsedBody = ResearchRequestSchema.safeParse(
      await request.json().catch(() => null),
    );
    if (!parsedBody.success) {
      return json(
        request,
        {
          error: {
            message: "Invalid request body",
            issues: formatIssues(parsedBody.error),
          },
        },
        400,
      );
    }
    const body = parsedBody.data;
    const query = body.query?.trim();
    if (!query) {
      return json(request, { error: { message: "query is required" } }, 400);
    }
    const depth: ResearchDepth = body.depth ?? "standard";

    const searchEnv = {
      tavilyApiKey: config.tavilyApiKey,
      serperApiKey: config.serperApiKey,
    };
    if (!searchEnv.tavilyApiKey && !searchEnv.serperApiKey) {
      return json(
        request,
        {
          error: {
            message:
              "Deep research requires TAVILY_API_KEY or SERPER_API_KEY to be configured on the gateway.",
          },
        },
        400,
      );
    }

    // Propagate a client disconnect to the (multiple) upstream calls research
    // makes, so abandoning a research request cancels the in-flight provider
    // fetches instead of running them to completion.
    const researchAbort = new AbortController();
    if (request.signal) {
      if (request.signal.aborted) {
        researchAbort.abort();
      } else {
        request.signal.addEventListener("abort", () => researchAbort.abort(), {
          once: true,
        });
      }
    }

    async function collectText(messages: ChatMessage[]): Promise<string> {
      const result = await engine.routeAndStream({
        messages,
        stream: true,
        signal: researchAbort.signal,
      });
      let text = "";
      for await (const chunk of result.stream) {
        text += chunk;
      }
      return text;
    }

    const deps: DeepResearchDeps = {
      decompose: async (q, count) => {
        const text = await collectText([
          {
            role: "user",
            content:
              `Break this research question into exactly ${count} focused, distinct web-search queries. ` +
              `Return ONLY a JSON array of strings, no prose.\n\nQuestion: ${q}`,
          },
        ]);
        try {
          const start = text.indexOf("[");
          const end = text.lastIndexOf("]");
          if (start !== -1 && end > start) {
            const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
            if (Array.isArray(parsed) && parsed.length > 0) {
              return parsed.slice(0, count).map((item) => String(item));
            }
          }
        } catch {
          // fall through to single-query fallback
        }
        return [q];
      },
      search: async (q) => {
        const outcome = await runFallbackSearch(
          q,
          { enabled: true, depth: "basic", maxResults: 5 },
          searchEnv,
        );
        return outcome.results;
      },
      synthesize: async function* (q, context) {
        const result = await engine.routeAndStream({
          messages: [
            {
              role: "system",
              content:
                "You are a research assistant. Synthesize a thorough, well-structured answer " +
                "from the provided sources. Cite sources inline as [1], [2], [3].",
            },
            { role: "user", content: `Sources:\n${context}\n\nQuestion: ${q}` },
          ],
          stream: true,
          // Thread the abort so an idle/disconnect tears down the synthesis
          // fetch (decompose's collectText already passes this signal; synthesis
          // is the longest-running upstream call, so it matters most here).
          signal: researchAbort.signal,
        });
        for await (const chunk of result.stream) {
          yield chunk;
        }
      },
      // Sharper, LLM-based claim extraction that drives the corroboration round
      // (mirrors decompose: one bounded model call via collectText, threaded
      // through researchAbort). Bounded to a handful of claims and fail-soft —
      // on parse/upstream failure it returns [], so deepResearch falls back to
      // its structural weakly-backed-claim path and research never crashes.
      extractClaims: async (answer) => {
        try {
          const text = await collectText([
            {
              role: "user",
              content:
                "Extract the check-worthy factual claims from the research answer below. " +
                "Return ONLY a JSON array of short, self-contained claim strings " +
                "(at most 6, the most important first), no prose.\n\n" +
                `Answer:\n${answer}`,
            },
          ]);
          const start = text.indexOf("[");
          const end = text.lastIndexOf("]");
          if (start !== -1 && end > start) {
            const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
            if (Array.isArray(parsed)) {
              return parsed
                .slice(0, 6)
                .map((item) => String(item))
                .filter((s) => s.trim().length > 0);
            }
          }
        } catch {
          // fail-soft: fall back to structural extraction inside deepResearch
        }
        return [];
      },
      // Conservative contradiction detector for the conflict-detection pass. One
      // bounded model call judges whether the corroborating sources AGREE; only
      // an explicit "CONTRADICT" verdict flags a conflict. Any error/uncertain
      // verdict → false, so a conflict is never fabricated.
      detectConflict: async (claim, sources) => {
        try {
          const evidence = sources
            .map(
              (source, index) =>
                `[${index + 1}] ${source.title}\n${source.content}`,
            )
            .join("\n\n");
          const text = await collectText([
            {
              role: "user",
              content:
                "Do the sources below CONTRADICT each other on this specific claim? " +
                'Reply with exactly one word: "CONTRADICT" only if they clearly ' +
                'disagree on a verifiable fact; otherwise "AGREE". When unsure, ' +
                'reply "AGREE".\n\n' +
                `Claim: ${claim}\n\nSources:\n${evidence}`,
            },
          ]);
          return /\bCONTRADICT\b/i.test(text);
        } catch {
          return false; // never fabricate a conflict
        }
      },
    };

    metrics.recordSearch("deep-research");

    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        try {
          // Same protection as the chat path, applied to the research event
          // generator: `startMs` bounds time-to-first-event (the connect/start
          // window, reusing requestTimeoutMs) and `idleMs` is the mid-stream
          // idle watchdog (streamIdleTimeoutMs) that RESETS on every event. On
          // either, withIdleWatchdog aborts researchAbort — tearing down the
          // in-flight decompose/synthesis fetches — and throws into the catch
          // below, which emits this endpoint's existing SSE error shape.
          for await (const event of withIdleWatchdog(
            deepResearch(query, { depth }, deps),
            {
              startMs: requestTimeoutMs,
              idleMs: streamIdleTimeoutMs,
              abort: researchAbort,
            },
          )) {
            // deepResearch catches its own upstream failures and yields a
            // { type: "error", message } event (rather than throwing), so that
            // raw provider message reaches the client through THIS relay — not
            // the catch below. Scrub just the message field of an error event;
            // all other event types (and the answer text) pass through intact.
            const safeEvent =
              event.type === "error"
                ? { ...event, message: redactSecrets(event.message) }
                : event;
            controller.enqueue(
              encoder.encode(
                `event: ${safeEvent.type}\ndata: ${JSON.stringify(safeEvent)}\n\n`,
              ),
            );
          }
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Research failed";
          metrics.recordError();
          onError?.(error, { requestId, path: "/v1/research" });
          log("error", "research.failed", { requestId, error: message });
          // Scrub the client-facing copy (the log fn already scrubs the log line):
          // research drives upstream provider calls whose error text can carry a key.
          controller.enqueue(
            encoder.encode(
              `event: error\ndata: ${JSON.stringify({ type: "error", message: redactSecrets(message) })}\n\n`,
            ),
          );
        } finally {
          controller.close();
        }
      },
      // Client disconnected (the ReadableStream consumer cancelled): abort the
      // upstream research work so we stop pulling tokens nobody is reading.
      // Mirrors the chat streaming branch's cancel(). Per WHATWG Streams, the
      // source cancel() callback runs on consumer cancellation; we use it to
      // propagate via AbortController to the in-flight engine fetches.
      cancel() {
        researchAbort.abort();
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        ...corsHeaders(request),
      },
    });
  }

  async function route(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const requestId = randomUUID();

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    // CSRF / denial-of-wallet guard. Omitting the ACAO header stops a malicious
    // site from READING responses, but a `no-cors` "simple" POST (text/plain,
    // no preflight) would still EXECUTE and burn the user's BYOK quota. So when
    // the gateway is origin-restricted (not "*"), REJECT any request carrying a
    // disallowed Origin. Requests with no Origin (CLI, server-to-server, same
    // origin) are unaffected; allowed browser origins pass.
    {
      const origin = request.headers.get("origin");
      if (
        origin &&
        config.corsOrigins !== "*" &&
        resolveCorsOrigin(config.corsOrigins, origin) === null
      ) {
        log("warn", "gateway.origin_rejected", {
          requestId,
          origin,
          path: url.pathname,
        });
        return json(
          request,
          { error: { message: "Origin not allowed", type: "forbidden" } },
          403,
        );
      }
    }

    // Metrics endpoint — auth-gated only when GATEWAY_TOKEN is set.
    if (url.pathname === "/metrics") {
      if (config.token && !isAuthorized(request)) {
        log("warn", "auth.rejected", { requestId, path: url.pathname });
        return json(request, { error: { message: "Unauthorized" } }, 401);
      }
      const wantsText = (request.headers.get("accept") ?? "").includes("text/plain");
      if (wantsText) {
        return new Response(metrics.toPrometheus(), {
          headers: { "Content-Type": "text/plain; version=0.0.4", ...corsHeaders(request) },
        });
      }
      return json(request, metrics.snapshot());
    }

    // Public liveness probe — intentionally minimal. It must NOT leak provider
    // inventory, key presence, live quota, or savings to unauthenticated
    // callers (that lets an attacker map the operator's setup and time quota
    // exhaustion). The full operational snapshot lives at the auth-gated
    // /v1/status below. Keep the response shape `{ ok: true }`-compatible so the
    // gateway-smoke probe (curl -sf /health) still passes.
    if (url.pathname === "/health") {
      const draining = getDraining?.() ?? false;
      const engineerReadiness = engineerRuns?.readiness() ?? { state: "DISABLED" as const, error: null };
      const engineerUnavailable = engineerReadiness.state !== "READY" && engineerReadiness.state !== "DISABLED";
      return json(
        request,
        {
          ok: !draining && !engineerUnavailable,
          auth: config.token ? "required" : "disabled",
          engineer: engineerReadiness.state,
          ...(draining ? { status: "draining" } : {}),
        },
        draining || engineerUnavailable ? 503 : 200,
      );
    }

    // Everything below requires authorization (when a token is configured).
    if (!isAuthorized(request)) {
      log("warn", "auth.rejected", { requestId, path: url.pathname });
      return json(request, { error: { message: "Unauthorized" } }, 401);
    }
    const engineerPrincipal = engineerRuns?.principal();

    // Authenticated operational snapshot: provider inventory, key presence, live
    // quota, cooldown state, and provable savings. Moved here (behind auth) from
    // the public /health to close the topology-disclosure leak.
    if (url.pathname === "/v1/status" && request.method === "GET") {
      const statuses = await engine.getProviderStatus();
      // Local runtimes have no key/limit, so the router's `available` says yes
      // even when the process is down — every client then shows "Connected"
      // for a dead Ollama/LM Studio. Gate on the live probe (the same cached
      // detection route-options already uses).
      const runtimes = await detectLocal();
      const liveAvailable = (status: { id: string; available: boolean }) =>
        status.id === "ollama"
          ? runtimes.ollama.detected
          : status.id === "lmstudio"
            ? runtimes.lmstudio.detected
            : status.available;
      const savings = engine.getSavings();
      return json(request, {
        ok: true,
        providers: statuses.map((status) => ({
          id: status.id,
          available: liveAvailable(status),
          hasKey: status.hasKey,
          inCooldown: status.inCooldown,
          quotaUsed: status.tokensToday,
          quotaLimit: status.tokensLimit ?? null,
        })),
        // Provable savings: estimated USD a paid API would have charged for the
        // free-tier tokens served so far. Labelled an estimate (see
        // PAID_EQUIVALENT_USD_PER_MTOK in @zintus/router).
        savings: {
          estimatedUsdSaved: Number(savings.total.toFixed(4)),
          byProvider: savings.byProvider,
          note: "estimate vs. paid-API list pricing",
        },
      });
    }

    // OpenRouter-style key/quota introspection for the authed gateway token.
    // Free-core: no managed custody — `managed_keys_available` is always false
    // and `is_free_tier` always true. Per-provider quota is sourced from the
    // SAME live provider status as `/v1/status`. Honest: `quota_limit` is null
    // when the provider does not report a denominator (never a fabricated cap),
    // and `quota_remaining_ratio` is null whenever the limit is unknown.
    if (url.pathname === "/v1/key" && request.method === "GET") {
      const statuses = await engine.getProviderStatus();
      // Same local-runtime liveness gating as /v1/status (see comment there).
      const keyRuntimes = await detectLocal();
      return json(request, {
        object: "key_status",
        label: "zintus-gateway",
        is_free_tier: true,
        providers: statuses.map((status) => {
          const quotaUsed = status.tokensToday;
          const quotaLimit = status.tokensLimit ?? null;
          const quotaRemainingRatio =
            quotaLimit !== null && quotaLimit > 0
              ? clamp01((quotaLimit - quotaUsed) / quotaLimit)
              : null;
          return {
            id: status.id,
            has_key: status.hasKey,
            available:
              status.id === "ollama"
                ? keyRuntimes.ollama.detected
                : status.id === "lmstudio"
                  ? keyRuntimes.lmstudio.detected
                  : status.available,
            in_cooldown: status.inCooldown,
            quota_used: quotaUsed,
            quota_limit: quotaLimit,
            quota_remaining_ratio: quotaRemainingRatio,
          };
        }),
        managed_keys_available: false,
      });
    }

    // Local, BYOK-only quota-exhaustion decision API. Auth-gated above like every
    // other /v1/* route (401 without the gateway token).
    if (url.pathname === "/v1/route/options" && request.method === "GET") {
      return handleRouteOptions(request);
    }

    // Explicit key test (matrix #20). The key travels ONLY from the caller to
    // this local gateway and then to the provider's own auth-check endpoint —
    // never logged, never stored, never to the relay. Lets GUI surfaces test a
    // key without embedding provider HTTP quirks (or fighting webview CORS).
    // Voice input (deferred voice plan, v1): transcribe a short audio clip with
    // Groq Whisper using the caller's own stored Groq key. Audio travels ONLY
    // caller → this local gateway → Groq; never logged, never stored, never to
    // the relay. Honest 422 when no Groq key exists — no fake dictation.
    if (url.pathname === "/v1/transcribe" && request.method === "POST") {
      const groqKey = await readProviderKey("groq");
      if (!groqKey) {
        return json(
          request,
          {
            error: {
              message:
                "Voice input needs a Groq key (Whisper runs on your own key). Add one on the Models page.",
              code: "no_transcription_key",
            },
          },
          422,
        );
      }
      let audio: Blob | null = null;
      try {
        const form = await request.formData();
        const file = form.get("file");
        if (file instanceof Blob && file.size > 0) audio = file;
      } catch {
        /* fall through to the 400 below */
      }
      if (!audio) {
        return json(request, { error: { message: "multipart 'file' audio field is required" } }, 400);
      }
      if (audio.size > 20 * 1024 * 1024) {
        return json(request, { error: { message: "audio too large (20MB max)" } }, 413);
      }
      try {
        const upstream = new FormData();
        upstream.append("file", audio, (audio as File).name || "audio.webm");
        upstream.append("model", "whisper-large-v3-turbo");
        upstream.append("response_format", "json");
        const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
          method: "POST",
          headers: { authorization: `Bearer ${groqKey}` },
          body: upstream,
          signal: AbortSignal.timeout(60_000),
        });
        if (!res.ok) {
          const detail = await res.text().catch(() => "");
          log("warn", "transcribe.upstream_error", { requestId, status: res.status });
          return json(
            request,
            { error: { message: `transcription failed (${res.status})`, detail: detail.slice(0, 200) } },
            502,
          );
        }
        const data = (await res.json()) as { text?: string };
        return json(request, { object: "transcription", text: data.text ?? "" });
      } catch {
        return json(request, { error: { message: "transcription request failed (Groq unreachable?)" } }, 502);
      }
    }

    if (url.pathname === "/v1/keys/validate" && request.method === "POST") {
      let body: { providerId?: string; key?: string };
      try {
        body = (await request.json()) as { providerId?: string; key?: string };
      } catch {
        return json(request, { error: { message: "invalid JSON body" } }, 400);
      }
      if (!body.providerId || !isProviderId(body.providerId)) {
        return json(
          request,
          { error: { message: `unknown provider: ${String(body.providerId)}` } },
          400,
        );
      }
      if (body.providerId === "ollama" || body.providerId === "lmstudio") {
        return json(
          request,
          { error: { message: `${body.providerId} is a local runtime — no key to test` } },
          400,
        );
      }
      if (!body.key || !body.key.trim()) {
        return json(request, { error: { message: "key is required" } }, 400);
      }
      try {
        const valid = await createProvider(body.providerId).validateKey(
          body.key.trim(),
        );
        return json(request, { object: "key_validation", provider: body.providerId, valid });
      } catch {
        // Provider endpoint unreachable ≠ invalid key; say so honestly.
        return json(
          request,
          { error: { message: "validation request failed (provider unreachable?)" } },
          502,
        );
      }
    }

    // Rich, OpenRouter-grade model catalog. OpenAI-compatible envelope
    // (`{ object:"list", data:[...] }`) with each entry carrying the OpenAI
    // `{ id, object:"model", owned_by }` triple PLUS per-model metadata
    // (display_name, context_window, capabilities, pricing, free, local,
    // data_policy). Optional catalog-UI filters narrow the list server-side:
    //   ?provider=<id> ?vision=true ?tools=true ?free=true ?local=true
    if (url.pathname === "/v1/models" && request.method === "GET") {
      const q = url.searchParams;
      const providerFilter = q.get("provider");
      const wantVision = q.get("vision") === "true";
      const wantTools = q.get("tools") === "true";
      const wantFree = q.get("free") === "true";
      const wantLocal = q.get("local") === "true";

      const models = listCatalogModels().filter((m) => {
        if (providerFilter && m.provider !== providerFilter) return false;
        if (wantVision && !m.vision) return false;
        if (wantTools && !m.tools) return false;
        if (wantFree && !m.free) return false;
        if (wantLocal && !m.local) return false;
        return true;
      });

      return json(request, {
        object: "list",
        // Enrich each entry with its provider's honest, MEASURED stats when an
        // accessor is wired (null fields otherwise — never fabricated).
        data: models.map((m) =>
          toModelEntry(m, getProviderStats?.(m.provider) ?? null),
        ),
      });
    }

    // Pricing transparency endpoint. Honest: only models with a KNOWN list price
    // are returned (unknown prices are omitted, never invented). USD per 1M tokens.
    if (url.pathname === "/v1/pricing" && request.method === "GET") {
      const data = listCatalogModels()
        .filter((m) => m.inputPer1M !== null && m.outputPer1M !== null)
        .map((m) => ({
          id: m.id,
          provider: m.provider,
          input_per_1m: m.inputPer1M,
          output_per_1m: m.outputPer1M,
          free: m.free,
        }));
      return json(request, { object: "list", data });
    }

    if (url.pathname === "/v1/traces" && request.method === "GET") {
      const limit = Number(url.searchParams.get("limit")) || 20;
      return json(request, { traces: engine.listTraces(limit) });
    }

    // OpenRouter-style `/activity`: paginated, persistent usage history. Reads
    // from the DURABLE activity store first (~/.zintus/activity.db, pruned to a
    // 30-day window), and falls back to the in-memory trace path when the store
    // is empty/unavailable — keeping the exact Phase-5 entry shape either way.
    // `?limit=` defaults to 50, capped at 200; `?provider=`/`?model=` narrow the
    // page; `?since=` (unix seconds) bounds the date window. Honest: only real
    // recorded usage is surfaced (empty list when none); cost is never fabricated.
    if (url.pathname === "/v1/activity" && request.method === "GET") {
      const rawLimit = Number(url.searchParams.get("limit"));
      const limit =
        Number.isFinite(rawLimit) && rawLimit > 0
          ? Math.min(200, Math.floor(rawLimit))
          : 50;
      const providerFilter = url.searchParams.get("provider");
      const modelFilter = url.searchParams.get("model");
      const rawSince = Number(url.searchParams.get("since"));
      const since =
        Number.isFinite(rawSince) && rawSince > 0 ? Math.floor(rawSince) : undefined;

      // ── Durable path ───────────────────────────────────────────────────────
      if (activityStore) {
        try {
          // Fetch one extra to honestly compute `has_more` without a total.
          const rows = activityStore.listActivity({
            limit: limit + 1,
            since,
            provider: providerFilter,
            model: modelFilter,
          });
          if (rows.length > 0) {
            const hasMore = rows.length > limit;
            const data = rows.slice(0, limit).map(activityRecordToEntry);
            return json(request, {
              object: "list",
              data,
              has_more: hasMore,
              retention_days: ACTIVITY_RETENTION_DAYS,
            });
          }
          // Empty store → fall through to the trace-derived path below.
        } catch (error) {
          log("warn", "activity.read_failed", {
            error: error instanceof Error ? error.message : String(error),
          });
          // Store unavailable → fall through to the trace-derived path below.
        }
      }

      // ── Fallback: in-memory trace ring ──────────────────────────────────────
      // Fetch one extra to honestly compute `has_more` without inventing a total.
      const fetched = engine.listTraces(limit + 1);
      const hasMore = fetched.length > limit;
      let data = fetched.slice(0, limit).map(toActivityEntry);
      if (providerFilter) {
        data = data.filter((entry) => entry.provider === providerFilter);
      }
      if (modelFilter) {
        data = data.filter((entry) => entry.model === modelFilter);
      }
      if (since !== undefined) {
        data = data.filter((entry) => entry.created >= since);
      }
      return json(request, { object: "list", data, has_more: hasMore });
    }

    if (url.pathname === "/v1/savings" && request.method === "GET") {
      const savings = engine.getSavings();
      return json(request, {
        estimatedUsdSaved: Number(savings.total.toFixed(4)),
        byProvider: savings.byProvider,
        note: "estimate vs. paid-API list pricing",
      });
    }

    if (url.pathname === "/v1/traces/last" && request.method === "GET") {
      return json(request, { trace: engine.getLastTrace() });
    }

    if (url.pathname.startsWith("/v1/traces/") && request.method === "GET") {
      const traceId = url.pathname.split("/").pop();
      if (!traceId) {
        return json(request, { error: "trace id required" }, 400);
      }
      const trace = engine.getTrace(traceId);
      if (!trace) {
        return json(request, { error: "trace not found" }, 404);
      }
      return json(request, { trace });
    }

    // ── P2: gateway-hosted agent runtime ─────────────────────────────────────
    if (url.pathname === "/v1/engineer/readiness" && request.method === "GET") {
      if (!engineerRuns) return json(request, { readiness: { state: "DISABLED", error: null } });
      const readiness = engineerRuns.readiness();
      return json(request, { readiness }, readiness.state === "READY" || readiness.state === "DISABLED" ? 200 : 503);
    }

    if (url.pathname === "/v1/engineer/readiness/retry" && request.method === "POST") {
      if (!engineerRuns) return json(request, { error: { message: "Engineer is not configured" } }, 503);
      try {
        await engineerRuns.ensureReady();
        return json(request, { readiness: engineerRuns.readiness() });
      } catch (error) {
        return json(request, { readiness: engineerRuns.readiness(), error: { message: redactSecrets(error instanceof Error ? error.message : String(error)) } }, 503);
      }
    }

    if (url.pathname.startsWith("/v1/engineer/") && engineerRuns?.readiness().state !== "READY") {
      return json(request, { error: { message: "Engineer capability preflight is not ready" }, readiness: engineerRuns?.readiness() }, 503);
    }

    if (url.pathname === "/v1/engineer/repository" && request.method === "GET") {
      if (!engineerRuns) return json(request, { error: { message: "Engineer is not configured" } }, 503);
      return json(request, { repository: engineerRuns.repository(engineerPrincipal!) });
    }

    if (url.pathname === "/v1/engineer/repositories" && request.method === "GET") {
      if (!engineerRuns) return json(request, { error: { message: "Engineer is not configured" } }, 503);
      return json(request, { repositories: engineerRuns.repositories(engineerPrincipal!) });
    }

    if (url.pathname === "/v1/engineer/observability" && request.method === "GET") {
      if (!engineerRuns) return json(request, { error: { message: "Engineer is not configured" } }, 503);
      return json(request, { snapshot: engineerRuns.observability() });
    }

    if (url.pathname === "/v1/engineer/runs" && request.method === "POST") {
      if (!engineerRuns) return json(request, { error: { message: "Engineer is not configured" } }, 503);
      const limited = enforceRateLimit(request, requestId, url.pathname);
      if (limited) return limited;
      try {
        const body = await request.json() as {
          runId?: string; userId?: string; actorId?: string; userEmail?: string; repository?: unknown; request?: string; budget?: unknown;
        };
        if (!body.repository || !body.request) throw new Error("repository and request are required");
        const run = await engineerRuns.create(engineerPrincipal!, {
          ...(body.runId ? { runId: body.runId } : {}),
          repository: body.repository as never,
          request: body.request,
          ...(body.budget ? { budget: body.budget as never } : {}),
        });
        return json(request, { run }, 201);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return json(request, { error: { message: redactSecrets(message) } }, /preflight/i.test(message) ? 503 : 400);
      }
    }

    if (url.pathname === "/v1/engineer/runs" && request.method === "GET") {
      if (!engineerRuns) return json(request, { error: { message: "Engineer is not configured" } }, 503);
      const requestedLimit = url.searchParams.get("limit");
      const cursor = url.searchParams.get("cursor");
      if (requestedLimit === null && cursor === null) {
        return json(request, { runs: engineerRuns.list(engineerPrincipal!), nextCursor: null });
      }
      const rawLimit = requestedLimit ?? "20";
      if (!/^\d+$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 100) return json(request, { error: { message: "run page limit must be between 1 and 100" } }, 400);
      let before: { createdAt: string; runId: string } | undefined;
      if (cursor) {
        try {
          const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
          if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== "string" || typeof parsed[1] !== "string" || !Number.isFinite(new Date(parsed[0]).getTime()) || !parsed[1]) throw new Error("invalid");
          before = { createdAt: parsed[0], runId: parsed[1] };
        } catch { return json(request, { error: { message: "invalid run page cursor" } }, 400); }
      }
      return json(request, engineerRuns.listPage(engineerPrincipal!, { limit: Number(rawLimit), ...(before ? { before } : {}) }));
    }

    if (url.pathname.startsWith("/v1/engineer/runs/") && engineerRuns) {
      const parts = url.pathname.split("/");
      const runId = parts[4] ?? "";
      const action = parts[5];
      const decisionId = parts[6];
      const decisionAction = parts[7];
      try {
        if (request.method === "POST") {
          const limited = enforceRateLimit(request, requestId, url.pathname);
          if (limited) return limited;
        }
        if (!action && request.method === "GET") return json(request, engineerRuns.get(runId));
        if (action === "budget" && request.method === "GET") {
          return json(request, { budget: engineerRuns.budget(engineerPrincipal!, runId) });
        }
        if (action === "budget" && parts[6] === "top-up" && request.method === "POST") {
          const body = await request.json() as {
            expectedRevision?: number; idempotencyKey?: string;
            addCostBudgetUsd?: number; addTokenBudget?: number; addTimeBudgetSeconds?: number;
          };
          if (typeof body.expectedRevision !== "number" || !body.idempotencyKey) throw new Error("expectedRevision and idempotencyKey are required");
          return json(request, { budget: engineerRuns.topUpBudget(engineerPrincipal!, runId, {
            expectedRevision: body.expectedRevision, idempotencyKey: body.idempotencyKey,
            topUp: { addCostBudgetUsd: body.addCostBudgetUsd ?? 0, addTokenBudget: body.addTokenBudget ?? 0, addTimeBudgetSeconds: body.addTimeBudgetSeconds ?? 0 },
          }) });
        }
        if (action === "resume-budget" && request.method === "POST") {
          const body = await request.json() as { expectedStateVersion?: number; expectedBudgetRevision?: number; idempotencyKey?: string };
          if (typeof body.expectedStateVersion !== "number" || typeof body.expectedBudgetRevision !== "number" || !body.idempotencyKey) {
            throw new Error("expectedStateVersion, expectedBudgetRevision, and idempotencyKey are required");
          }
          const run = engineerRuns.resumeBudget(engineerPrincipal!, runId, body as Required<typeof body>);
          return json(request, { run, budget: engineerRuns.budget(engineerPrincipal!, runId) });
        }
        if (action === "plan" && request.method === "POST") {
          return json(request, { plan: await engineerRuns.plan(engineerPrincipal!, runId) });
        }
        if (action === "plan" && request.method === "GET") {
          return json(request, { plan: engineerRuns.planProposal(runId) });
        }
        if (action === "freeze-plan" && request.method === "POST") {
          const body = await request.json() as {
            expectedStateVersion?: number; manifest?: unknown; actorId?: string; idempotencyKey?: string;
          };
          if (typeof body.expectedStateVersion !== "number" || !body.manifest || !body.idempotencyKey) {
            throw new Error("expectedStateVersion, manifest, and idempotencyKey are required");
          }
          return json(request, { run: await engineerRuns.freeze(engineerPrincipal!, runId, {
            expectedStateVersion: body.expectedStateVersion,
            manifest: body.manifest as never,
            idempotencyKey: body.idempotencyKey,
          }) });
        }
        if (action === "start" && request.method === "POST") {
          return json(request, { run: await engineerRuns.start(engineerPrincipal!, runId), accepted: true }, 202);
        }
        if (action === "recover-stale-base" && request.method === "POST") {
          return json(request, await engineerRuns.recoverStaleBase(engineerPrincipal!, runId), 202);
        }
        if (action === "corrected-run" && request.method === "POST") {
          return json(request, await engineerRuns.createCorrectedRun(engineerPrincipal!, runId), 201);
        }
        if (action === "approval" && request.method === "GET") {
          return json(request, { approval: engineerRuns.approval(runId) });
        }
        if (action === "snapshot" && request.method === "GET") {
          return json(request, engineerRuns.snapshot(engineerPrincipal!, runId));
        }
        if (action === "human-review" && request.method === "POST") {
          const body = await request.json() as { decision?: string; reason?: string };
          if (body.decision !== "approve" && body.decision !== "reject") throw new Error("decision must be approve or reject");
          if (typeof body.reason !== "string" || !body.reason.trim()) throw new Error("reason is required");
          return json(request, await engineerRuns.resolveHumanReview(engineerPrincipal!, runId, body.decision, body.reason));
        }
        if (["approve", "request-changes", "reject", "extend-approval", "cancel"].includes(action ?? "") && request.method === "POST") {
          const body = await request.json() as { actorId?: string; reason?: string; extensionSeconds?: number };
          if (typeof body.reason !== "string") throw new Error("reason is required");
          if (action === "approve") return json(request, { result: await engineerRuns.approve(engineerPrincipal!, runId, body.reason) });
          if (action === "request-changes") {
            await engineerRuns.requestChanges(engineerPrincipal!, runId, body.reason);
            return json(request, { run: engineerRuns.get(runId).run });
          }
          if (action === "reject") {
            await engineerRuns.reject(engineerPrincipal!, runId, body.reason);
            return json(request, { run: engineerRuns.get(runId).run });
          }
          if (action === "extend-approval") {
            if (typeof body.extensionSeconds !== "number") throw new Error("extensionSeconds is required");
            return json(request, { approval: await engineerRuns.extendApproval(engineerPrincipal!, runId, body.reason, body.extensionSeconds) });
          }
          await engineerRuns.cancel(engineerPrincipal!, runId, body.reason);
          return json(request, { run: engineerRuns.get(runId).run });
        }
        if (action === "events" && request.method === "GET") {
          const queryCursor = url.searchParams.get("afterSequence");
          const headerCursor = request.headers.get("Last-Event-ID");
          const rawCursor = queryCursor ?? headerCursor ?? "0";
          if (!/^\d+$/.test(rawCursor)) throw new Error("invalid Engineer event cursor");
          const afterSequence = Number(rawCursor);
          return new Response(engineerRuns.subscribe(runId, afterSequence), {
            headers: {
              "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive",
              "X-Zintus-Engineer-Review-Approved-Terminal": String(engineerRuns.reviewApprovedEndsStream()),
              ...corsHeaders(request),
            },
          });
        }
        if (action === "artifacts" && decisionId && request.method === "GET") {
          return json(request, engineerRuns.artifactPreview(engineerPrincipal!, runId, decodeURIComponent(decisionId)));
        }
        if (action === "artifacts" && !decisionId && request.method === "GET") {
          return json(request, { artifacts: engineerRuns.artifacts(runId) });
        }
        if (action === "claims" && request.method === "GET") {
          return json(request, { claims: engineerRuns.claims(runId) });
        }
        if (action === "evidence" && request.method === "GET") {
          return json(request, { evidenceBundles: engineerRuns.evidenceBundles(runId) });
        }
        if (action === "evidence-export" && request.method === "GET") {
          return new Response(JSON.stringify(engineerRuns.evidenceExport(engineerPrincipal!, runId), null, 2), {
            headers: {
              "Content-Type": "application/json; charset=utf-8",
              "Content-Disposition": `attachment; filename="zintus-engineer-${runId}-evidence.json"`,
              "Cache-Control": "no-store",
              ...corsHeaders(request),
            },
          });
        }
        if (action === "evidence-stream" && request.method === "GET") {
          return new Response(engineerRuns.evidenceExportStream(engineerPrincipal!, runId), {
            headers: {
              "Content-Type": "application/x-ndjson; charset=utf-8",
              "Content-Disposition": `attachment; filename="zintus-engineer-${runId}-evidence.ndjson"`,
              "Cache-Control": "no-store",
              ...corsHeaders(request),
            },
          });
        }
        if (action === "tests" && request.method === "GET") {
          return json(request, { tests: engineerRuns.tests(runId) });
        }
        if (action === "security" && request.method === "GET") {
          return json(request, { securityFindings: engineerRuns.security(runId) });
        }
        if (action === "failures" && request.method === "GET") {
          return json(request, { failures: engineerRuns.failures(runId) });
        }
        if (action === "git-operations" && request.method === "GET") {
          return json(request, { gitOperations: engineerRuns.gitOperations(runId) });
        }
        if (action === "decisions" && !decisionId && request.method === "GET") {
          return json(request, { decisions: engineerRuns.decisions(engineerPrincipal!, runId) });
        }
        if (action === "decisions" && decisionId && decisionAction === "resolve" && request.method === "POST") {
          const body = await request.json() as {
            expectedStateVersion?: number; selectedOptionId?: string; rationale?: string; idempotencyKey?: string;
          };
          if (typeof body.expectedStateVersion !== "number" || typeof body.selectedOptionId !== "string" ||
              typeof body.rationale !== "string" || typeof body.idempotencyKey !== "string") {
            throw new Error("expectedStateVersion, selectedOptionId, rationale, and idempotencyKey are required");
          }
          return json(request, await engineerRuns.resolveDecision(engineerPrincipal!, runId, decisionId, {
            expectedStateVersion: body.expectedStateVersion,
            selectedOptionId: body.selectedOptionId,
            rationale: body.rationale,
            idempotencyKey: body.idempotencyKey,
          }));
        }
        if (action === "diff" && request.method === "GET") {
          return json(request, { diff: engineerRuns.diff(runId) });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const status = /not found/i.test(message) ? 404 : /preflight/i.test(message) ? 503 : /not configured|PLAN_FROZEN|planning requires/i.test(message) ? 409 : 400;
        return json(request, { error: { message: redactSecrets(message) } }, status);
      }
    }

    if (url.pathname === "/v1/agents" && request.method === "POST") {
      const body = (await request.json().catch(() => null)) as
        | (CreateAgentTaskBody & { task?: unknown })
        | null;
      if (!body || typeof body.task !== "string" || !body.task.trim()) {
        return json(request, { error: { message: "task (string) is required" } }, 400);
      }
      try {
        const { id } = agents.create(body as CreateAgentTaskBody);
        return json(request, { id }, 201);
      } catch (error) {
        return json(
          request,
          { error: { message: error instanceof Error ? error.message : String(error) } },
          400,
        );
      }
    }

    if (url.pathname === "/v1/agents" && request.method === "GET") {
      return json(request, { agents: agents.list() });
    }

    if (url.pathname.startsWith("/v1/agents/") && request.method === "GET") {
      const parts = url.pathname.split("/");
      const agentId = parts[3] ?? "";
      if (parts[4] === "events") {
        const stream = agents.subscribe(agentId);
        if (!stream) return json(request, { error: { message: "agent not found" } }, 404);
        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            ...corsHeaders(request),
          },
        });
      }
      const summary = agents.get(agentId);
      if (!summary) return json(request, { error: { message: "agent not found" } }, 404);
      return json(request, summary);
    }

    if (url.pathname.startsWith("/v1/agents/") && request.method === "POST") {
      const parts = url.pathname.split("/");
      const agentId = parts[3] ?? "";
      if (parts[4] === "approvals") {
        const body = (await request.json().catch(() => null)) as {
          approval_id?: string;
          approved?: boolean;
        } | null;
        if (!body || typeof body.approval_id !== "string" || typeof body.approved !== "boolean") {
          return json(
            request,
            { error: { message: "approval_id (string) and approved (boolean) are required" } },
            400,
          );
        }
        const ok = agents.approve(agentId, body.approval_id, body.approved);
        return ok
          ? json(request, { resolved: true })
          : json(request, { error: { message: "no such pending approval" } }, 404);
      }
      if (parts[4] === "stop") {
        return agents.stop(agentId)
          ? json(request, { stopping: true })
          : json(request, { error: { message: "agent not found" } }, 404);
      }
      if (parts[4] === "resume") {
        const res = agents.resume(agentId);
        return res.ok
          ? json(request, { resuming: true })
          : json(request, { error: { message: res.reason } }, 409);
      }
      // P2 — conversational follow-up on a completed session (same sandbox
      // root, full prior context; the new exchange's events append to the same
      // backlog, stamped with the bumped `exchange` index).
      if (parts[4] === "messages") {
        const body = (await request.json().catch(() => null)) as {
          message?: unknown;
        } | null;
        if (!body || typeof body.message !== "string" || !body.message.trim()) {
          return json(request, { error: { message: "message (string) is required" } }, 400);
        }
        const res = agents.followUp(agentId, body.message);
        return res.ok
          ? json(request, { continued: true, exchange: res.exchange })
          : json(request, { error: { message: res.reason } }, res.status);
      }
      return json(request, { error: { message: "unknown agent action" } }, 404);
    }

    if (url.pathname === "/v1/threads" && request.method === "GET") {
      return json(request, { threads: engine.listThreads() });
    }

    if (
      url.pathname.startsWith("/v1/threads/") &&
      url.pathname.endsWith("/state") &&
      request.method === "GET"
    ) {
      const threadId = url.pathname.split("/")[3];
      if (!threadId) {
        return json(request, { error: "thread id required" }, 400);
      }
      return json(request, { state: engine.getThreadState(threadId) });
    }

    if (
      url.pathname.startsWith("/v1/threads/") &&
      url.pathname.endsWith("/compile") &&
      request.method === "POST"
    ) {
      const threadId = url.pathname.split("/")[3];
      if (!threadId) {
        return json(request, { error: "thread id required" }, 400);
      }
      const body = (await request.json().catch(() => ({}))) as {
        message?: { role?: string; content: string } | string;
        mode?: ContextMode;
        persist?: boolean;
      };
      const message =
        typeof body.message === "string"
          ? body.message
          : body.message
            ? {
                role: (body.message.role ?? "user") as ChatMessage["role"],
                content: body.message.content,
              }
            : undefined;
      const preview = await engine.compileThreadContext({
        threadId,
        message,
        mode: body.mode,
        persist: body.persist,
      });
      return json(request, {
        thread_id: threadId,
        compile_trace_id: preview.traceId,
        bundle: { messages: preview.messages },
      });
    }

    if (
      url.pathname.startsWith("/v1/threads/") &&
      url.pathname.endsWith("/messages") &&
      request.method === "GET"
    ) {
      const threadId = url.pathname.split("/")[3];
      if (!threadId) {
        return json(request, { error: "thread id required" }, 400);
      }
      return json(request, { messages: engine.getThreadMessages(threadId) });
    }

    // A thread's own governance facts.
    if (
      url.pathname.startsWith("/v1/threads/") &&
      url.pathname.endsWith("/memory") &&
      request.method === "GET"
    ) {
      const threadId = url.pathname.split("/")[3];
      if (!threadId) {
        return json(request, { error: "thread id required" }, 400);
      }
      return json(request, {
        memory: engine.listMemory({ scope: "thread", threadId }),
      });
    }

    // Memory governance CRUD (Memory Manager). Facts are user-owned: visible,
    // editable, deletable. Never treated as authority — they are background data.
    if (url.pathname === "/v1/memory" && request.method === "GET") {
      const scopeParam = url.searchParams.get("scope") ?? undefined;
      const scope =
        scopeParam === "thread" ||
        scopeParam === "project" ||
        scopeParam === "global"
          ? scopeParam
          : undefined;
      if (scopeParam && !scope) {
        return json(
          request,
          { error: "scope must be one of thread|project|global" },
          400,
        );
      }
      return json(request, {
        memory: engine.listMemory({
          scope,
          threadId: url.searchParams.get("thread_id") ?? undefined,
          projectId: url.searchParams.get("project_id") ?? undefined,
        }),
      });
    }

    if (url.pathname === "/v1/memory" && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      const key = typeof body.key === "string" ? body.key.trim() : "";
      const value = typeof body.value === "string" ? body.value.trim() : "";
      if (!key || !value) {
        return json(request, { error: "key and value are required" }, 400);
      }
      const scopeRaw = body.scope;
      if (
        scopeRaw !== undefined &&
        scopeRaw !== "thread" &&
        scopeRaw !== "project" &&
        scopeRaw !== "global"
      ) {
        return json(
          request,
          { error: "scope must be one of thread|project|global" },
          400,
        );
      }
      const scope = (scopeRaw ?? "thread") as "thread" | "project" | "global";
      const fact = engine.upsertMemory({
        scope,
        threadId: (body.thread_id ?? body.threadId) as string | undefined,
        projectId: (body.project_id ?? body.projectId) as string | undefined,
        key,
        value,
        source: typeof body.source === "string" ? body.source : undefined,
        sourceMessageId:
          typeof body.source_message_id === "string"
            ? body.source_message_id
            : undefined,
        pinned: typeof body.pinned === "boolean" ? body.pinned : undefined,
      });
      return json(request, { memory: fact }, 201);
    }

    if (
      url.pathname.startsWith("/v1/memory/") &&
      request.method === "PATCH"
    ) {
      const id = url.pathname.split("/")[3];
      if (!id) {
        return json(request, { error: "memory id required" }, 400);
      }
      const body = (await request.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      const patch: { key?: string; value?: string; pinned?: boolean } = {};
      if (typeof body.key === "string") patch.key = body.key;
      if (typeof body.value === "string") patch.value = body.value;
      if (typeof body.pinned === "boolean") patch.pinned = body.pinned;
      if (Object.keys(patch).length === 0) {
        return json(
          request,
          { error: "no editable fields provided (key|value|pinned)" },
          400,
        );
      }
      const updated = engine.updateMemory(id, patch);
      if (!updated) {
        return json(request, { error: "memory not found" }, 404);
      }
      return json(request, { memory: updated });
    }

    if (
      url.pathname.startsWith("/v1/memory/") &&
      request.method === "DELETE"
    ) {
      const id = url.pathname.split("/")[3];
      if (!id) {
        return json(request, { error: "memory id required" }, 400);
      }
      const deleted = engine.deleteMemory(id);
      if (!deleted) {
        return json(request, { error: "memory not found" }, 404);
      }
      return json(request, { deleted: true });
    }

    if (
      url.pathname.startsWith("/v1/compile/traces/") &&
      request.method === "GET"
    ) {
      const traceId = url.pathname.split("/").pop();
      if (!traceId) {
        return json(request, { error: "compile trace id required" }, 400);
      }
      const trace = engine.getCompileTrace(traceId);
      if (!trace) {
        return json(request, { error: "compile trace not found" }, 404);
      }
      return json(request, { trace });
    }

    if (url.pathname === "/v1/chat/completions" && request.method === "POST") {
      const limited = enforceRateLimit(request, requestId, url.pathname);
      if (limited) {
        return limited;
      }
      try {
        return await handleChatCompletions(request, requestId);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Request failed";
        metrics.recordError();
        onError?.(error, { requestId, path: url.pathname });
        log("error", "chat.failed", { requestId, error: message });
        // Scrub before echoing to the client: a re-thrown provider error (e.g. a
        // 401 body) can contain key material. The log line above is scrubbed by
        // the log fn; this is the matching scrub for the HTTP response body.
        return json(request, { error: { message: redactSecrets(message) } }, 400);
      }
    }

    // MCP: connect (cached) + list a server's tools/resources/prompts. Auth-gated
    // above like every other /v1/* route.
    if (url.pathname === "/v1/mcp/discover" && request.method === "POST") {
      try {
        return await handleMcpDiscover(request, requestId);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Request failed";
        metrics.recordError();
        onError?.(error, { requestId, path: url.pathname });
        log("error", "mcp.discover_error", { requestId });
        return json(request, { error: { message: redactSecrets(message) } }, 400);
      }
    }

    // MCP: disconnect + evict a cached server connection. Accept DELETE /v1/mcp
    // and POST /v1/mcp/disconnect (both carry `{ config }`).
    if (
      (url.pathname === "/v1/mcp" && request.method === "DELETE") ||
      (url.pathname === "/v1/mcp/disconnect" && request.method === "POST")
    ) {
      try {
        return await handleMcpDisconnect(request);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Request failed";
        metrics.recordError();
        onError?.(error, { requestId, path: url.pathname });
        log("error", "mcp.disconnect_error", { requestId });
        return json(request, { error: { message: redactSecrets(message) } }, 400);
      }
    }

    if (url.pathname === "/v1/research" && request.method === "POST") {
      const limited = enforceRateLimit(request, requestId, url.pathname);
      if (limited) {
        return limited;
      }
      try {
        return await handleResearch(request, requestId);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Request failed";
        metrics.recordError();
        onError?.(error, { requestId, path: url.pathname });
        log("error", "research.failed", { requestId, error: message });
        // Scrub before echoing to the client (see chat.failed above): research
        // makes upstream provider calls whose error text can carry a key.
        return json(request, { error: { message: redactSecrets(message) } }, 400);
      }
    }

    return json(request, { error: "Not found" }, 404);
  }

  return async function fetch(request: Request): Promise<Response> {
    const start = Date.now();
    const response = await route(request);
    metrics.recordRequest(response.status, Date.now() - start);
    return response;
  };
}

function parseMessages(body: {
  messages?: Array<{
    role: string;
    content?: string | ContentBlock[] | null;
    tool_call_id?: string;
    tool_calls?: Array<{
      id: string;
      type: "function";
      function: { name: string; arguments: string };
    }>;
  }>;
  message?: { role?: string; content: string | ContentBlock[] } | string;
  thread_id?: string;
}): ChatMessage[] {
  if (body.messages?.length) {
    return body.messages.map((message) => {
      // Normalize an OpenAI-native tool-result message (`{role:"tool",
      // tool_call_id, content}`) to the internal shape: a user turn carrying a
      // tool_result block. Without this the multi-turn tool loop is impossible
      // over HTTP. `content` is the result text; tool_call_id correlates it.
      if (message.role === "tool") {
        const resultText =
          typeof message.content === "string"
            ? message.content
            : textOf(message.content ?? []);
        return {
          role: "user" as const,
          content: [
            {
              type: "tool_result" as const,
              toolCallId: message.tool_call_id ?? "",
              content: resultText,
            },
          ],
        };
      }
      // Normalize an OpenAI-native assistant turn carrying top-level `tool_calls`
      // (the shape the gateway itself emits) into internal `tool_call` content
      // blocks. Without this a stock OpenAI client that echoes the assistant turn
      // back loses the call (the field is otherwise stripped and `content:null`
      // is rejected). `function.arguments` is a JSON STRING upstream; parse it,
      // guarding malformed/non-object payloads to `{}`. Any assistant text is
      // preserved as a leading text block.
      if (message.role === "assistant" && message.tool_calls?.length) {
        const toolCallBlocks: ContentBlock[] = message.tool_calls.map((call) => {
          let args: Record<string, unknown> = {};
          try {
            const parsed = JSON.parse(call.function.arguments) as unknown;
            if (
              parsed != null &&
              typeof parsed === "object" &&
              !Array.isArray(parsed)
            ) {
              args = parsed as Record<string, unknown>;
            }
          } catch {
            args = {};
          }
          return {
            type: "tool_call" as const,
            id: call.id,
            name: call.function.name,
            arguments: args,
          };
        });
        const textBlocks: ContentBlock[] =
          typeof message.content === "string"
            ? message.content.length > 0
              ? [{ type: "text" as const, text: message.content }]
              : []
            : Array.isArray(message.content)
              ? message.content.filter((b) => b.type === "text")
              : [];
        return {
          role: "assistant" as const,
          content: [...textBlocks, ...toolCallBlocks],
        };
      }
      if (
        message.role !== "system" &&
        message.role !== "user" &&
        message.role !== "assistant"
      ) {
        throw new Error(`Invalid role: ${message.role}`);
      }
      // Non-tool turns always carry content (schema refine guarantees it unless
      // tool_calls was present, handled above); coerce the now-nullable type.
      return { role: message.role, content: message.content ?? "" };
    });
  }
  if (body.message && body.thread_id) {
    if (typeof body.message === "string") {
      return [{ role: "user", content: body.message }];
    }
    const role = body.message.role ?? "user";
    if (role !== "system" && role !== "user" && role !== "assistant") {
      throw new Error(`Invalid role: ${role}`);
    }
    return [{ role: role as ChatMessage["role"], content: body.message.content }];
  }
  throw new Error(
    "messages array is required unless message + thread_id is provided",
  );
}
