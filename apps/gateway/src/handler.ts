import { randomUUID } from "node:crypto";
import { listProviders } from "@zintus/providers";
import type { Engine } from "@zintus/engine";
import type { ChatMessage, ContextMode, ProviderId } from "@zintus/types";
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

const DEFAULT_MAX_BODY_BYTES = 1_000_000;
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
        "X-Provider-Used, X-Cache-Hit, X-Failover-Count, X-Compile-Tokens",
      Vary: "Origin",
    };
    if (origin) {
      headers["Access-Control-Allow-Origin"] = origin;
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

    // Tokzen: compress system + assistant messages before routing
    const selectedProvider = body.provider;
    const quotaRemaining = selectedProvider ? (getQuotaRemaining?.(selectedProvider) ?? 1.0) : 1.0;
    const tokzenProvider =
      selectedProvider === "groq" ? "groq" as const
      : selectedProvider === "gemini" ? "gemini" as const
      : "openai" as const;
    const tokzenResult = await compress(
      { messages: searchMessages.map((m) => ({ ...m, role: m.role as "system" | "user" | "assistant" | "tool" })) },
      {
        provider: tokzenProvider,
        model: body.model ?? "unknown",
        quotaRemaining,
        tokenBudget: 8000,
        sessionId: body.thread_id,
      },
    );
    const compressedMessages: ChatMessage[] = tokzenResult.messages
      .filter((m): m is { role: "system" | "user" | "assistant"; content: string } =>
        m.role === "system" || m.role === "user" || m.role === "assistant",
      );
    metrics.recordTokzenSavings(
      tokzenResult.totalResult.originalTokens,
      tokzenResult.totalResult.compressedTokens,
      tokzenResult.totalResult.ratio,
      selectedProvider,
    );

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

    let result: Awaited<ReturnType<Engine["routeAndStream"]>>;
    try {
      result = await withTimeout(
        engine.routeAndStream({
          signal: upstreamAbort.signal,
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
          stream: body.stream !== false,
          virtualKey: body.virtual_key ?? body.virtualKey,
          providerWeights: body.provider_weights ?? body.providerWeights,
          strategy: body.strategy,
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
        return json(request, { error: { message: error.message } }, 408);
      }
      throw error;
    }

    const metaHeaders: Record<string, string> = {
      "X-Provider-Used": result.providerId,
      "X-Cache-Hit": result.cacheHit ?? "miss",
      "X-Failover-Count": String(result.failoverCount ?? 0),
    };

    metrics.recordChat(result.providerId);
    log("info", "chat.route", {
      requestId,
      traceId: result.traceId,
      provider: result.providerId,
      model: result.model,
      streaming: body.stream !== false,
      cacheHit: result.cacheHit ?? "miss",
      failoverCount: result.failoverCount ?? 0,
    });

    if (body.stream === false) {
      let content = "";
      for await (const chunk of result.stream) {
        content += chunk;
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
              message: { role: "assistant", content },
              finish_reason: "stop",
            },
          ],
        },
        200,
        metaHeaders,
      );
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
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Stream failed";
          metrics.recordError();
          onError?.(error, { requestId, path: "/v1/chat/completions" });
          log("error", "chat.stream_failed", { requestId, error: message });
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ error: { message } })}\n\n`),
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
          for await (const event of deepResearch(query, { depth }, deps)) {
            controller.enqueue(
              encoder.encode(
                `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
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
          controller.enqueue(
            encoder.encode(
              `event: error\ndata: ${JSON.stringify({ type: "error", message })}\n\n`,
            ),
          );
        } finally {
          controller.close();
        }
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

    if (url.pathname === "/v1/models" && request.method === "GET") {
      return json(request, {
        object: "list",
        data: listProviders().map((provider) => ({
          id: provider.id,
          object: "model",
          owned_by: provider.name,
        })),
      });
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
        return json(request, { error: { message } }, 400);
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
        return json(request, { error: { message } }, 400);
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
  messages?: Array<{ role: string; content: string }>;
  message?: { role?: string; content: string } | string;
  thread_id?: string;
}): ChatMessage[] {
  if (body.messages?.length) {
    return body.messages.map((message) => {
      if (
        message.role !== "system" &&
        message.role !== "user" &&
        message.role !== "assistant"
      ) {
        throw new Error(`Invalid role: ${message.role}`);
      }
      return { role: message.role, content: message.content };
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
