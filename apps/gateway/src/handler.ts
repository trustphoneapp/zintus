import { randomUUID } from "node:crypto";
import { listProviders } from "@zintus/providers";
import type { Engine } from "@zintus/engine";
import type { ChatMessage, ContextMode, ProviderId, RoutingStrategy } from "@zintus/types";
import {
  bearerAuthorized,
  resolveCorsOrigin,
  type GatewayConfig,
} from "./auth.js";
import { createMetrics, type Metrics } from "./metrics.js";
import { compress } from "tokzen";

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

class RequestTimeoutError extends Error {
  constructor() {
    super("Request timed out while starting the upstream stream");
    this.name = "RequestTimeoutError";
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
  const maxBodyBytes = config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const maxMessages = config.maxMessages ?? DEFAULT_MAX_MESSAGES;
  const requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

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

    let body: {
      messages?: Array<{ role: string; content: string }>;
      message?: { role?: string; content: string } | string;
      model?: string;
      stream?: boolean;
      provider?: ProviderId;
      thread_id?: string;
      mode?: ContextMode;
      virtual_key?: string;
      virtualKey?: string;
      provider_weights?: Record<string, number>;
      providerWeights?: Record<string, number>;
      strategy?: RoutingStrategy | "weighted";
      temperature?: number;
      max_tokens?: number;
      diff?: string;
    };
    try {
      body = JSON.parse(raw);
    } catch {
      return json(request, { error: { message: "Invalid JSON body" } }, 400);
    }

    const messages = parseMessages(body);
    if (messages.length > maxMessages) {
      return json(
        request,
        { error: { message: `Too many messages (max ${maxMessages})` } },
        413,
      );
    }

    // Tokzen: compress system + assistant messages before routing
    const selectedProvider = body.provider;
    const quotaRemaining = selectedProvider ? (getQuotaRemaining?.(selectedProvider) ?? 1.0) : 1.0;
    const tokzenProvider =
      selectedProvider === "groq" ? "groq" as const
      : selectedProvider === "gemini" ? "gemini" as const
      : "openai" as const;
    const tokzenResult = await compress(
      { messages: messages.map((m) => ({ ...m, role: m.role as "system" | "user" | "assistant" | "tool" })) },
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

    let result: Awaited<ReturnType<Engine["routeAndStream"]>>;
    try {
      result = await withTimeout(
        engine.routeAndStream({
          messages: compressedMessages.length > 0 ? compressedMessages : messages,
          message:
            typeof body.message === "string"
              ? { role: "user", content: body.message }
              : body.message
                ? {
                    role: (body.message.role ?? "user") as ChatMessage["role"],
                    content: body.message.content,
                  }
                : undefined,
          model: body.model,
          provider: body.provider,
          mode: body.mode,
          threadId: body.thread_id,
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
        try {
          for await (const chunk of result.stream) {
            const payload = {
              id: result.traceId,
              object: "chat.completion.chunk",
              model: result.model,
              provider: result.providerId,
              thread_id: result.threadId,
              compile_trace_id: result.compileTraceId,
              choices: [{ index: 0, delta: { content: chunk } }],
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
          controller.close();
        }
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

  async function route(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const requestId = randomUUID();

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    // Public, unauthenticated operational endpoints.
    if (url.pathname === "/metrics") {
      const wantsText = (request.headers.get("accept") ?? "").includes("text/plain");
      if (wantsText) {
        return new Response(metrics.toPrometheus(), {
          headers: { "Content-Type": "text/plain; version=0.0.4", ...corsHeaders(request) },
        });
      }
      return json(request, metrics.snapshot());
    }

    if (url.pathname === "/health") {
      const statuses = await engine.getProviderStatus();
      const savings = engine.getSavings();
      return json(request, {
        ok: true,
        auth: config.token ? "required" : "disabled",
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

    // Everything below requires authorization (when a token is configured).
    if (!isAuthorized(request)) {
      log("warn", "auth.rejected", { requestId, path: url.pathname });
      return json(request, { error: { message: "Unauthorized" } }, 401);
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
