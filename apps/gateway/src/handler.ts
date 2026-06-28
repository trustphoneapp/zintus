import { randomUUID } from "node:crypto";
import {
  listProviders,
  getModelPricing,
  estimateCostUsd,
  DATA_POLICIES,
  PROVIDER_METADATA,
  listCatalogModels,
  type CatalogModel,
} from "@zintus/providers";
import { supportsVision, supportsTools, structuredOutputLevel } from "@zintus/providers";
import { redactSecrets } from "@zintus/router";
import type { Engine } from "@zintus/engine";
import {
  detectLocalRuntimes as defaultDetectLocalRuntimes,
  type LocalRuntimes,
} from "./local-runtimes.js";
import type {
  ChatMessage,
  ContextMode,
  ProviderId,
  RouteUsage,
} from "@zintus/types";
import {
  textOf,
  imageCount,
  isContentBlockArray,
  hasToolTurns,
  type ContentBlock,
} from "@zintus/types";
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
 *  contract); every other field is additive metadata. */
function toModelEntry(m: CatalogModel) {
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
  };
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
}

/** BYOK-only fallback actions when a provider's quota is low/exhausted. */
type RouteOption =
  | "compress_harder"
  | "switch_provider"
  | "use_local"
  | "wait";

/** Below this remaining ratio a provider is treated as quota-constrained. */
const LOW_QUOTA_THRESHOLD = 0.2;

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
  const getDraining = deps.getDraining;
  const rateLimiter = deps.rateLimiter;
  const detectLocal = deps.detectLocalRuntimes ?? defaultDetectLocalRuntimes;
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
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Expose-Headers":
        "X-Provider-Used, X-Cache-Hit, X-Failover-Count, X-Compile-Tokens, " +
        "X-Zintus-Original-Tokens, X-Zintus-Compressed-Tokens, " +
        "X-Zintus-Tokens-Saved, X-Zintus-Compression-Ratio, " +
        "X-Zintus-Cost-Saved-Usd, X-Zintus-Private-Honored, " +
        "X-Zintus-Vision-Provider, X-Zintus-Images, X-Zintus-Image-Bytes, X-Zintus-Exif-Stripped",
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

    const now = Date.now();
    const statuses = await engine.getProviderStatus();
    const self = statuses.find((s) => s.id === provider);

    // quotaRemaining: prefer the ledger value when this provider is keyed (so the
    // ledger genuinely tracks its usage); else fall back to the client hint; else
    // null. Never fabricated.
    const ledgerKnown = self?.hasKey === true;
    const serverQuota = ledgerKnown
      ? clamp01(engine.getQuotaRemaining(provider))
      : null;
    const quotaRemaining = serverQuota ?? clientHint;
    const effectiveQuota = quotaRemaining ?? 1;

    // resetIn: ONLY from the ledger's tracked `cooldownUntil`, which is set from a
    // real 429 / Groq reset header or the router's backoff cooldown. Daily-quota
    // providers reset lazily at the UTC boundary and the ledger stores NO
    // per-provider reset timestamp for them, so we report null + a reason rather
    // than fabricate a reset time (HARD rule #3).
    let resetIn: number | null = null;
    let resetReason: string | undefined;
    const cooldownUntilMs = self?.cooldownUntil
      ? self.cooldownUntil.getTime()
      : null;
    if (cooldownUntilMs != null && cooldownUntilMs > now) {
      resetIn = Math.ceil((cooldownUntilMs - now) / 1000);
    } else {
      resetReason = "Reset time unavailable";
    }

    // localAvailable: reuse the gateway's existing Ollama/LM-Studio detection.
    // (The router's `available` flag is unreliable for local runtimes — they have
    // no key/limit so it reports them available even when the process is down.)
    const runtimes = await detectLocal();
    const localAvailable =
      runtimes.ollama.detected || runtimes.lmstudio.detected;

    // alternatives: cheapest HEALTHY cloud BYOK providers, ESTIMATES ONLY (from
    // the static pricing catalog). Healthy = the router reports `available` (has
    // key, has quota, NOT in cooldown). Exclude the target itself and the local
    // runtimes (surfaced via use_local/localAvailable, and unpriced at $0).
    const defaultModelById = new Map(known.map((p) => [p.id, p.defaultModel]));
    const alternatives = statuses
      .filter(
        (s) =>
          s.id !== provider &&
          s.available &&
          s.id !== "ollama" &&
          s.id !== "lmstudio",
      )
      .map((s) => {
        const model = defaultModelById.get(s.id) ?? "";
        const pricing = getModelPricing(s.id, model);
        return pricing
          ? {
              provider: s.id,
              model,
              estInputPer1M: pricing.inputPer1M,
              estOutputPer1M: pricing.outputPer1M,
            }
          : null;
      })
      .filter((a): a is NonNullable<typeof a> => a !== null)
      .sort(
        (a, b) =>
          a.estInputPer1M +
          a.estOutputPer1M -
          (b.estInputPer1M + b.estOutputPer1M),
      );

    // Is the cheapest healthy alternative actually cheaper than staying put?
    const selfModel = defaultModelById.get(provider) ?? "";
    const selfPricing = getModelPricing(provider, selfModel);
    const selfCost = selfPricing
      ? selfPricing.inputPer1M + selfPricing.outputPer1M
      : Number.POSITIVE_INFINITY;
    const cheapest = alternatives[0];
    const cheaperAltExists =
      cheapest != null &&
      cheapest.estInputPer1M + cheapest.estOutputPer1M <= selfCost;

    // Options offered — BYOK ONLY. There is intentionally NO use_credits / paid /
    // overflow option: managed keys are gated off and Zintus never takes custody.
    const options: RouteOption[] = ["compress_harder"];
    if (alternatives.length > 0) {
      options.push("switch_provider");
    }
    if (localAvailable) {
      options.push("use_local");
    }
    options.push("wait");

    const name = self?.name ?? match.name;
    const low = effectiveQuota <= LOW_QUOTA_THRESHOLD;
    const exhausted = effectiveQuota <= 0 || self?.inCooldown === true;

    let best: RouteOption;
    let reason: string;
    if (!low) {
      best = "compress_harder";
      reason = `${name} quota is healthy; compress harder to conserve your free-tier budget`;
    } else if (alternatives.length > 0) {
      best = "switch_provider";
      reason = cheaperAltExists
        ? `${name} quota low; a cheaper healthy provider is available`
        : `${name} quota low; another healthy provider is available`;
    } else if (localAvailable) {
      best = "use_local";
      reason = `${name} quota low; a local runtime is available to take over at no API cost`;
    } else if (exhausted) {
      best = "wait";
      reason =
        resetIn != null
          ? `${name} is exhausted with no healthy alternatives; wait ~${resetIn}s for it to reset`
          : `${name} is exhausted and no healthy alternatives are available; wait for quota to recover`;
    } else {
      best = "compress_harder";
      reason = `${name} quota low; compress harder to stretch the remaining budget`;
    }

    return json(request, {
      provider,
      quotaRemaining,
      resetIn,
      ...(resetReason ? { resetReason } : {}),
      best,
      options,
      reason,
      alternatives,
      localAvailable,
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
    // Explicit-provider gate: if the user PICKED a provider, never silently send
    // their image elsewhere — fail clearly if that provider/model can't see it.
    if (hasImages && body.provider && !supportsVision(body.provider, body.model)) {
      return json(request, UNSUPPORTED_VISION_ERROR, 422);
    }
    // Same explicit-provider gate for tools: a tools-bearing request against a
    // provider/model that can't call tools hard-errors rather than silently
    // dropping the tools and returning a text-only answer.
    if (wantsTools && body.provider && !supportsTools(body.provider, body.model)) {
      return json(request, UNSUPPORTED_TOOLS_ERROR, 422);
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
      body.provider &&
      structuredOutputLevel(body.provider, body.model) !== "json_schema"
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
      const searchProvider = body.provider;
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
    const selectedProvider = body.provider;
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
    try {
      result = await withTimeout(
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
          model: effectiveModel,
          provider: body.provider,
          mode: body.mode,
          threadId: body.thread_id,
          webSearch: nativeWebSearch,
          tools: body.tools,
          toolChoice: body.tool_choice,
          responseFormat: body.response_format,
          stream: body.stream !== false,
          virtualKey: body.virtual_key ?? body.virtualKey,
          providerWeights: body.provider_weights ?? body.providerWeights,
          strategy: body.strategy,
          blockTrainingProviders: body.block_training,
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
    } catch (error) {
      if (error instanceof RequestTimeoutError) {
        // Abort the (still-pending) upstream connect so the socket and the
        // in-flight reservation are released rather than leaked.
        upstreamAbort.abort();
        log("warn", "chat.timeout", { requestId });
        return json(
          request,
          { error: { message: redactSecrets(error.message) } },
          408,
        );
      }
      // The router rejected the request because no candidate had the required
      // capability (auto-routing case). The same "unsupported_capability" Error
      // is thrown for vision, tools, OR strict structured output, so disambiguate
      // by REQUEST SHAPE: a strict json_schema request with no image/tools maps to
      // the structured error; a tools-only request (tools present, no images) maps
      // to the tools error; anything involving an image maps to the vision error.
      if (error instanceof Error && error.message === "unsupported_capability") {
        const body422 =
          wantsStrictSchema && !hasImages && !wantsTools
            ? UNSUPPORTED_STRUCTURED_ERROR
            : wantsTools && !hasImages
              ? UNSUPPORTED_TOOLS_ERROR
              : UNSUPPORTED_VISION_ERROR;
        return json(request, body422, 422);
      }
      throw error;
    }

    const metaHeaders: Record<string, string> = {
      "X-Provider-Used": result.providerId,
      "X-Cache-Hit": result.cacheHit ?? "miss",
      "X-Failover-Count": String(result.failoverCount ?? 0),
    };
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
                  body.strategy,
                  result.privacyHonored,
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
                body.strategy,
                result.privacyHonored,
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
      return json(
        request,
        {
          ok: !draining,
          auth: config.token ? "required" : "disabled",
          ...(draining ? { status: "draining" } : {}),
        },
        draining ? 503 : 200,
      );
    }

    // Everything below requires authorization (when a token is configured).
    if (!isAuthorized(request)) {
      log("warn", "auth.rejected", { requestId, path: url.pathname });
      return json(request, { error: { message: "Unauthorized" } }, 401);
    }

    // Authenticated operational snapshot: provider inventory, key presence, live
    // quota, cooldown state, and provable savings. Moved here (behind auth) from
    // the public /health to close the topology-disclosure leak.
    if (url.pathname === "/v1/status" && request.method === "GET") {
      const statuses = await engine.getProviderStatus();
      const savings = engine.getSavings();
      return json(request, {
        ok: true,
        providers: statuses.map((status) => ({
          id: status.id,
          available: status.available,
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

    // Local, BYOK-only quota-exhaustion decision API. Auth-gated above like every
    // other /v1/* route (401 without the gateway token).
    if (url.pathname === "/v1/route/options" && request.method === "GET") {
      return handleRouteOptions(request);
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
        data: models.map(toModelEntry),
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
