import { describe, expect, test } from "bun:test";
import type { Engine } from "@zintus/engine";
import type { GatewayConfig } from "./auth.js";
import { createGatewayHandler, type GatewayHandlerDeps } from "./handler.js";
import { createRateLimiter } from "./rate-limit.js";

function fakeEngine(overrides: Partial<Engine> = {}): Engine {
  const base: Engine = {
    async routeAndStream() {
      return {
        providerId: "groq",
        model: "test-model",
        traceId: "trace-1",
        threadId: "thread-1",
        compileTraceId: undefined,
        stream: (async function* () {
          yield "Hello";
          yield " world";
        })(),
      };
    },
    async getProviderStatus() {
      return [];
    },
    getSavings: () => ({ byProvider: {}, total: 0 }),
    getQuotaRemaining: () => 1,
    updatePolicy: () => {},
    probeProviders: async () => [],
    listThreads: () => [],
    getThreadMessages: () => [],
    createThread: () => ({ id: "t", title: "t", createdAt: new Date(), updatedAt: new Date() }),
    getTrace: () => null,
    getLastTrace: () => null,
    listTraces: () => [],
    getThreadState: () => null,
    getCompileTrace: () => null,
    async compileThreadContext() {
      return { traceId: "0", messages: [] };
    },
  };
  return { ...base, ...overrides };
}

function makeHandler(
  config: Partial<GatewayConfig> = {},
  engine = fakeEngine(),
  extraDeps: Partial<GatewayHandlerDeps> = {},
) {
  const full: GatewayConfig = {
    port: 8788,
    host: "127.0.0.1",
    token: "",
    corsOrigins: "*",
    ...config,
  };
  return createGatewayHandler({ engine, config: full, ...extraDeps });
}

describe("gateway handler", () => {
  test("GET /health is public and reports auth state", async () => {
    const handler = makeHandler({ token: "secret" });
    const res = await handler(new Request("http://x/health"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; auth: string };
    expect(body.ok).toBe(true);
    expect(body.auth).toBe("required");
  });

  test("GET /health reports 503 while draining", async () => {
    const handler = makeHandler({ token: "secret" }, fakeEngine(), {
      getDraining: () => true,
    });
    const res = await handler(new Request("http://x/health"));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { ok: boolean; status?: string };
    expect(body.ok).toBe(false);
    expect(body.status).toBe("draining");
  });

  test("GET /health no longer leaks provider topology", async () => {
    const handler = makeHandler({ token: "secret" });
    const res = await handler(new Request("http://x/health"));
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.providers).toBeUndefined();
    expect(body.savings).toBeUndefined();
  });

  test("GET /v1/status requires auth and returns provider topology", async () => {
    const handler = makeHandler({ token: "secret" });
    // Unauthenticated → 401
    const unauth = await handler(
      new Request("http://x/v1/status", { method: "GET" }),
    );
    expect(unauth.status).toBe(401);
    // Authenticated → topology + savings
    const res = await handler(
      new Request("http://x/v1/status", {
        method: "GET",
        headers: { authorization: "Bearer secret" },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { providers: unknown[]; savings: unknown };
    expect(Array.isArray(body.providers)).toBe(true);
    expect(body.savings).toBeDefined();
  });

  test("rejects a structurally invalid chat body with 400 + issues", async () => {
    const handler = makeHandler({ token: "secret" });
    const res = await handler(
      new Request("http://x/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: "Bearer secret",
          "content-type": "application/json",
        },
        // content must be a string; provider must be a known id.
        body: JSON.stringify({
          messages: [{ role: "user", content: 123 }],
          provider: "not-a-real-provider",
        }),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { message: string; issues?: unknown[] };
    };
    expect(body.error.message).toBe("Invalid request body");
    expect(Array.isArray(body.error.issues)).toBe(true);
  });

  test("rejects an invalid research body with 400 + issues (zod)", async () => {
    const handler = makeHandler({ token: "secret" });
    const res = await handler(
      new Request("http://x/v1/research", {
        method: "POST",
        headers: {
          authorization: "Bearer secret",
          "content-type": "application/json",
        },
        // depth must be one of quick|standard|deep.
        body: JSON.stringify({ query: "hi", depth: "ludicrous" }),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("Invalid request body");
  });

  test("rate limiter returns 429 with Retry-After once budget is exhausted", async () => {
    const handler = makeHandler({ token: "secret" }, fakeEngine(), {
      rateLimiter: createRateLimiter({ limit: 1, windowMs: 60_000 }),
    });
    const make = () =>
      handler(
        new Request("http://x/v1/chat/completions", {
          method: "POST",
          headers: {
            authorization: "Bearer secret",
            "x-forwarded-for": "1.2.3.4",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            messages: [{ role: "user", content: "hi" }],
            stream: false,
          }),
        }),
      );
    const first = await make();
    expect(first.status).toBe(200);
    const second = await make();
    expect(second.status).toBe(429);
    expect(second.headers.get("Retry-After")).toBeTruthy();
  });

  test("returns 401 on protected route without a token", async () => {
    const handler = makeHandler({ token: "secret" });
    const res = await handler(
      new Request("http://x/v1/models", { method: "GET" }),
    );
    expect(res.status).toBe(401);
  });

  test("allows protected route with a valid bearer token", async () => {
    const handler = makeHandler({ token: "secret" });
    const res = await handler(
      new Request("http://x/v1/models", {
        headers: { authorization: "Bearer secret" },
      }),
    );
    expect(res.status).toBe(200);
  });

  test("GET /v1/traces?limit= returns recent traces and is auth-gated", async () => {
    const startedAt = new Date();
    const engine = fakeEngine({
      listTraces: (limit: number) =>
        Array.from({ length: Math.min(limit, 2) }, (_unused, i) => ({
          traceId: `t-${i}`,
          startedAt,
          attempts: [],
        })),
    });

    // Auth-gated when a token is configured.
    const guarded = makeHandler({ token: "secret" }, engine);
    expect((await guarded(new Request("http://x/v1/traces?limit=5"))).status).toBe(
      401,
    );

    const handler = makeHandler({}, engine);
    const res = await handler(new Request("http://x/v1/traces?limit=5"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { traces: Array<{ traceId: string }> };
    expect(body.traces).toHaveLength(2);
    expect(body.traces[0]?.traceId).toBe("t-0");
  });

  test("streams chat completions as SSE", async () => {
    const handler = makeHandler();
    const res = await handler(
      new Request("http://x/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("chat.completion.chunk");
    expect(text).toContain("Hello");
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  test("emits a per-response metadata event with savings before [DONE]", async () => {
    const engine = fakeEngine({
      async routeAndStream(request) {
        return {
          providerId: "groq",
          model: "llama-3.3-70b-versatile",
          traceId: "trace-1",
          threadId: "thread-1",
          compileTraceId: undefined,
          stream: (async function* () {
            yield "Hi";
            // The winning provider's usage fires when its stream completes.
            request.onUsage?.({
              providerId: "groq",
              model: "llama-3.3-70b-versatile",
              inputTokens: 100,
              outputTokens: 200,
              latencyMs: 42,
            });
          })(),
        };
      },
    });
    const handler = makeHandler({}, engine);
    const res = await handler(
      new Request("http://x/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: "hi" }],
          strategy: "fastest",
        }),
      }),
    );
    const text = await res.text();
    const metaLine = text
      .split("\n")
      .find((line) => line.includes('"type":"metadata"'));
    expect(metaLine).toBeDefined();
    const meta = JSON.parse(metaLine!.replace("data: ", "")) as {
      provider: string;
      model: string;
      tokens: { input: number; output: number };
      cost_usd: number;
      saved_vs_claude_sonnet: number;
      routing_strategy: string;
    };
    expect(meta.provider).toBe("groq");
    expect(meta.tokens.output).toBe(200);
    expect(meta.cost_usd).toBe(0);
    expect(meta.routing_strategy).toBe("fastest");
    // 100 * $3/MTok + 200 * $15/MTok = 0.0003 + 0.003 = 0.0033
    expect(meta.saved_vs_claude_sonnet).toBeCloseTo(0.0033, 6);
    // Metadata must precede the stream terminator.
    expect(text.indexOf('"type":"metadata"')).toBeLessThan(
      text.indexOf("[DONE]"),
    );
  });

  test("returns a single JSON completion when stream:false", async () => {
    const handler = makeHandler();
    const res = await handler(
      new Request("http://x/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: "hi" }],
          stream: false,
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      object: string;
      choices: Array<{ message: { content: string } }>;
    };
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0]?.message.content).toBe("Hello world");
  });

  test("rejects malformed chat requests with 400", async () => {
    const handler = makeHandler();
    const res = await handler(
      new Request("http://x/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nonsense: true }),
      }),
    );
    expect(res.status).toBe(400);
  });

  test("exposes routing metadata headers on a streamed response", async () => {
    const engine = fakeEngine({
      async routeAndStream() {
        return {
          providerId: "groq",
          model: "test-model",
          traceId: "trace-2",
          cacheHit: "miss",
          failoverCount: 2,
          stream: (async function* () {
            yield "ok";
          })(),
        };
      },
    });
    const handler = makeHandler({}, engine);
    const res = await handler(
      new Request("http://x/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
      }),
    );
    expect(res.headers.get("X-Provider-Used")).toBe("groq");
    expect(res.headers.get("X-Cache-Hit")).toBe("miss");
    expect(res.headers.get("X-Failover-Count")).toBe("2");
    await res.text();
  });

  test("forwards virtual_key and provider_weights to the engine", async () => {
    let captured: { virtualKey?: string; providerWeights?: unknown } = {};
    const engine = fakeEngine({
      async routeAndStream(request) {
        captured = {
          virtualKey: request.virtualKey,
          providerWeights: request.providerWeights,
        };
        return {
          providerId: "groq",
          model: "m",
          traceId: "t",
          stream: (async function* () {
            yield "ok";
          })(),
        };
      },
    });
    const handler = makeHandler({}, engine);
    const res = await handler(
      new Request("http://x/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: "hi" }],
          virtual_key: "vk-123",
          provider_weights: { groq: 3, gemini: 1 },
        }),
      }),
    );
    await res.text();
    expect(captured.virtualKey).toBe("vk-123");
    expect(captured.providerWeights).toEqual({ groq: 3, gemini: 1 });
  });

  test("rejects an oversized body with 413", async () => {
    const handler = makeHandler({ maxBodyBytes: 50 });
    const big = "x".repeat(500);
    const res = await handler(
      new Request("http://x/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: big }] }),
      }),
    );
    expect(res.status).toBe(413);
  });

  test("rejects too many messages with 413", async () => {
    const handler = makeHandler({ maxMessages: 2 });
    const res = await handler(
      new Request("http://x/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: [
            { role: "user", content: "1" },
            { role: "assistant", content: "2" },
            { role: "user", content: "3" },
          ],
        }),
      }),
    );
    expect(res.status).toBe(413);
  });

  test("returns 408 when the engine exceeds the request timeout", async () => {
    const engine = fakeEngine({
      routeAndStream() {
        return new Promise(() => {
          // never resolves — forces the gateway timeout to fire
        });
      },
    });
    const handler = makeHandler({ requestTimeoutMs: 20 }, engine);
    const res = await handler(
      new Request("http://x/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
      }),
    );
    expect(res.status).toBe(408);
  });

  test("idle watchdog aborts a stalled stream and emits an error chunk", async () => {
    // A stream that yields once then stalls forever, and records whether the
    // upstream abort signal fired (the watchdog must tear the upstream down).
    let aborted = false;
    const engine = fakeEngine({
      async routeAndStream(request) {
        request.signal?.addEventListener("abort", () => {
          aborted = true;
        });
        return {
          providerId: "groq",
          model: "m",
          traceId: "t",
          stream: (async function* () {
            yield "first";
            // Stall: never yields again, ignores the abort (worst case).
            await new Promise<void>(() => {});
          })(),
        };
      },
    });
    const handler = makeHandler({ streamIdleTimeoutMs: 25 }, engine);
    const res = await handler(
      new Request("http://x/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
      }),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    // First chunk made it through, then the watchdog surfaced the shared error
    // shape and closed the stream cleanly.
    expect(text).toContain("first");
    expect(text).toContain('"error"');
    expect(text).toContain("stalled");
    expect(text).not.toContain("[DONE]");
    expect(aborted).toBe(true);
  });

  test("idle watchdog does NOT abort a stream that keeps sending in time", async () => {
    let aborted = false;
    const engine = fakeEngine({
      async routeAndStream(request) {
        request.signal?.addEventListener("abort", () => {
          aborted = true;
        });
        return {
          providerId: "groq",
          model: "m",
          traceId: "t",
          stream: (async function* () {
            for (let i = 0; i < 5; i += 1) {
              // 10ms between chunks, comfortably under the 50ms idle window.
              await new Promise<void>((r) => setTimeout(r, 10));
              yield `chunk-${i}`;
            }
          })(),
        };
      },
    });
    const handler = makeHandler({ streamIdleTimeoutMs: 50 }, engine);
    const res = await handler(
      new Request("http://x/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
      }),
    );
    const text = await res.text();
    expect(text).toContain("chunk-0");
    expect(text).toContain("chunk-4");
    expect(text).not.toContain('"error"');
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
    expect(aborted).toBe(false);
  });

  test("idle watchdog disabled (0) never fires and leaves no timer", async () => {
    // With the watchdog disabled, a slow-but-progressing stream completes and
    // no idle timer is created (so nothing to leak). We assert normal DONE.
    const engine = fakeEngine({
      async routeAndStream() {
        return {
          providerId: "groq",
          model: "m",
          traceId: "t",
          stream: (async function* () {
            await new Promise<void>((r) => setTimeout(r, 15));
            yield "slow";
          })(),
        };
      },
    });
    const handler = makeHandler({ streamIdleTimeoutMs: 0 }, engine);
    const res = await handler(
      new Request("http://x/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
      }),
    );
    const text = await res.text();
    expect(text).toContain("slow");
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  test("non-streaming chat is bounded by the idle watchdog (408 on mid-aggregation stall)", async () => {
    // The start timeout only guards routeAndStream() RESOLVING, not consuming
    // the buffered stream. A provider that connects then stalls mid-aggregation
    // would hang the `for await` forever — so the non-streaming branch now wraps
    // the read in the same idle watchdog. Prove it: a start that resolves fast
    // (under the large requestTimeoutMs) then a stream that never yields → 408,
    // and the upstream is aborted.
    let aborted = false;
    const engine = fakeEngine({
      async routeAndStream(request) {
        request.signal?.addEventListener("abort", () => {
          aborted = true;
        });
        return {
          providerId: "groq",
          model: "m",
          traceId: "t",
          // Connect succeeds, but the stream stalls forever (no chunks).
          stream: (async function* () {
            await new Promise<void>(() => {});
            yield "never";
          })(),
        };
      },
    });
    const handler = makeHandler(
      { streamIdleTimeoutMs: 25, requestTimeoutMs: 5000 },
      engine,
    );
    const res = await handler(
      new Request("http://x/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: "hi" }],
          stream: false,
        }),
      }),
    );
    expect(res.status).toBe(408);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("stalled");
    expect(aborted).toBe(true);
  });

  test("non-streaming chat completes 200 when chunks keep arriving in time", async () => {
    const engine = fakeEngine({
      async routeAndStream() {
        return {
          providerId: "groq",
          model: "m",
          traceId: "t",
          threadId: "thread-1",
          stream: (async function* () {
            for (let i = 0; i < 3; i += 1) {
              await new Promise<void>((r) => setTimeout(r, 10));
              yield `c${i}`;
            }
          })(),
        };
      },
    });
    const handler = makeHandler({ streamIdleTimeoutMs: 50 }, engine);
    const res = await handler(
      new Request("http://x/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: "hi" }],
          stream: false,
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      choices: { message: { content: string } }[];
    };
    expect(body.choices[0]?.message.content).toBe("c0c1c2");
  });

  test("unknown route returns 404", async () => {
    const handler = makeHandler();
    const res = await handler(new Request("http://x/nope"));
    expect(res.status).toBe(404);
  });

  test("GET /metrics is auth-gated when GATEWAY_TOKEN is set", async () => {
    const handler = makeHandler({ token: "secret" });
    await handler(new Request("http://x/health")); // one request recorded
    // Without auth → 401
    const unauthed = await handler(new Request("http://x/metrics"));
    expect(unauthed.status).toBe(401);
    // With auth → 200
    const authed = await handler(
      new Request("http://x/metrics", {
        headers: { authorization: "Bearer secret" },
      }),
    );
    expect(authed.status).toBe(200);
    const body = (await authed.json()) as { requestsTotal: number };
    expect(body.requestsTotal).toBeGreaterThanOrEqual(1);
  });

  test("GET /metrics serves Prometheus text when requested", async () => {
    const handler = makeHandler();
    const res = await handler(
      new Request("http://x/metrics", { headers: { accept: "text/plain" } }),
    );
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toContain("zintus_gateway_requests_total");
  });

  test("OPTIONS preflight returns 204 with CORS headers", async () => {
    const handler = makeHandler();
    const res = await handler(
      new Request("http://x/v1/chat/completions", { method: "OPTIONS" }),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
  });

  // --- Tokzen compression-savings headers (X-Zintus-*) ---------------------

  // A highly compressible assistant log message: ~60 near-identical timestamped
  // lines collapse under Drain template mining, so compressedTokens <<
  // originalTokens. User messages are never compressed, so the user turn stays
  // verbatim — keeping a real "prompt" present to assert it never leaks.
  const SECRET_PROMPT = "summarize-these-logs-SUPER-SECRET";
  function compressibleLogBody(): string {
    const lines: string[] = [];
    for (let i = 0; i < 60; i++) {
      lines.push(
        `2026-06-25T12:00:${String(i % 60).padStart(2, "0")}.000Z INFO ` +
          `request handled id=${i} user=u${i} latency=${i}ms ` +
          `path=/api/v1/resource/${i} status=200`,
      );
    }
    return lines.join("\n");
  }
  const ZINTUS_HEADERS = [
    "X-Zintus-Original-Tokens",
    "X-Zintus-Compressed-Tokens",
    "X-Zintus-Tokens-Saved",
    "X-Zintus-Compression-Ratio",
    "X-Zintus-Cost-Saved-Usd",
  ];

  test("emits X-Zintus compression headers on a streamed response when context is compressed", async () => {
    // Known pricing pair so the cost header is present.
    const engine = fakeEngine({
      async routeAndStream() {
        return {
          providerId: "groq",
          model: "llama-3.3-70b-versatile",
          traceId: "trace-z",
          stream: (async function* () {
            yield "ok";
          })(),
        };
      },
    });
    const handler = makeHandler({}, engine);
    const res = await handler(
      new Request("http://x/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://app" },
        body: JSON.stringify({
          provider: "groq",
          model: "llama-3.3-70b-versatile",
          messages: [
            { role: "user", content: SECRET_PROMPT },
            { role: "assistant", content: compressibleLogBody() },
          ],
        }),
      }),
    );

    const original = Number(res.headers.get("X-Zintus-Original-Tokens"));
    const compressed = Number(res.headers.get("X-Zintus-Compressed-Tokens"));
    const saved = Number(res.headers.get("X-Zintus-Tokens-Saved"));
    const ratio = res.headers.get("X-Zintus-Compression-Ratio");
    const cost = res.headers.get("X-Zintus-Cost-Saved-Usd");

    // Token headers present + internally consistent math.
    expect(original).toBeGreaterThan(0);
    expect(compressed).toBeGreaterThan(0);
    expect(compressed).toBeLessThan(original);
    expect(saved).toBe(original - compressed);
    // Ratio is compressed/original, formatted to 2 dp, and < 1.
    expect(ratio).not.toBeNull();
    expect(Number(ratio)).toBeLessThan(1);
    expect(ratio).toBe((compressed / original).toFixed(2));
    // Cost header present (known pricing) and a positive estimate.
    expect(cost).not.toBeNull();
    expect(Number(cost)).toBeGreaterThan(0);

    // Exposed for cross-origin reads.
    const expose = res.headers.get("Access-Control-Expose-Headers") ?? "";
    for (const h of ZINTUS_HEADERS) expect(expose).toContain(h);

    // Derived-only: no header carries the prompt/log content or any secret.
    res.headers.forEach((value) => {
      expect(value).not.toContain(SECRET_PROMPT);
      expect(value).not.toContain("request handled");
    });
    await res.text();
  });

  test("emits X-Zintus compression headers on a non-streaming response; omits cost when pricing unknown", async () => {
    // Unknown (provider, model) pricing → cost header omitted, tokens kept.
    const engine = fakeEngine({
      async routeAndStream() {
        return {
          providerId: "groq",
          model: "test-model",
          traceId: "trace-z2",
          stream: (async function* () {
            yield "ok";
          })(),
        };
      },
    });
    const handler = makeHandler({}, engine);
    const res = await handler(
      new Request("http://x/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          stream: false,
          messages: [
            { role: "user", content: SECRET_PROMPT },
            { role: "assistant", content: compressibleLogBody() },
          ],
        }),
      }),
    );
    expect(Number(res.headers.get("X-Zintus-Original-Tokens"))).toBeGreaterThan(
      0,
    );
    expect(Number(res.headers.get("X-Zintus-Tokens-Saved"))).toBeGreaterThan(0);
    // Pricing unknown for (groq, test-model) → cost header omitted only.
    expect(res.headers.get("X-Zintus-Cost-Saved-Usd")).toBeNull();
    await res.json();
  });

  test("omits ALL X-Zintus compression headers when no compression happens", async () => {
    const handler = makeHandler();
    const res = await handler(
      new Request("http://x/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // Short user message: nothing compressible → compressedTokens >= original.
        body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
      }),
    );
    for (const h of ZINTUS_HEADERS) {
      expect(res.headers.get(h)).toBeNull();
    }
    await res.text();
  });
});
