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

describe("origin rejection (CSRF / denial-of-wallet guard)", () => {
  test("loopback gateway 403s a disallowed Origin; allows allowed + no-Origin", async () => {
    const handler = makeHandler({ corsOrigins: "loopback" });
    const url = "http://localhost:8788/health";
    const evil = await handler(
      new Request(url, { headers: { origin: "https://evil.com" } }),
    );
    expect(evil.status).toBe(403);
    const noOrigin = await handler(new Request(url));
    expect(noOrigin.status).not.toBe(403);
    const allowed = await handler(
      new Request(url, { headers: { origin: "http://localhost:3000" } }),
    );
    expect(allowed.status).not.toBe(403);
  });

  test("'*' gateway never origin-rejects", async () => {
    const handler = makeHandler({ corsOrigins: "*" });
    const res = await handler(
      new Request("http://localhost:8788/health", {
        headers: { origin: "https://evil.com" },
      }),
    );
    expect(res.status).not.toBe(403);
  });
});

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

describe("client-facing error redaction (secrets scrubbed from responses, not just logs)", () => {
  // Matches the router's redactor rule `sk-[a-zA-Z0-9\-_]{8,}` → `sk-****REDACTED****`.
  const FAKE_SECRET = "sk-TESTFAKE0123456789abcdefghijklmnopqrstuvwx";
  const REDACTED = "sk-****REDACTED****";

  test("non-streaming chat: a re-thrown provider error has its embedded key scrubbed from the 400 body", async () => {
    // Mirrors a provider 401 whose body echoes the offending key verbatim. The
    // engine rejection propagates to the handler's top-level catch.
    const engine = fakeEngine({
      async routeAndStream() {
        throw new Error(`upstream auth rejected (401): invalid api key ${FAKE_SECRET}`);
      },
    });
    const handler = makeHandler({}, engine);
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
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    // Key gone, redaction marker present, surrounding text preserved.
    expect(body.error.message).not.toContain(FAKE_SECRET);
    expect(body.error.message).toContain(REDACTED);
    expect(body.error.message).toContain("upstream auth rejected (401)");
  });

  test("streaming chat: a mid-stream provider error has its embedded key scrubbed from the SSE error event", async () => {
    // routeAndStream resolves, then the stream throws partway through — exercising
    // the streaming branch's error path that emits an SSE `error` event.
    const engine = fakeEngine({
      async routeAndStream() {
        return {
          providerId: "groq",
          model: "m",
          traceId: "t",
          stream: (async function* () {
            yield "partial answer";
            throw new Error(`stream aborted by provider: ${FAKE_SECRET}`);
          })(),
        };
      },
    });
    const handler = makeHandler({}, engine);
    const res = await handler(
      new Request("http://x/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // No `stream` field → defaults to streaming SSE.
        body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
      }),
    );
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("partial answer"); // earlier chunk survived
    expect(text).toContain('"error"'); // error event emitted
    expect(text).not.toContain(FAKE_SECRET); // raw key never reaches the client
    expect(text).toContain(REDACTED);
  });

  test("research SSE: a key in an upstream failure is scrubbed from the error event", async () => {
    // deepResearch calls routeAndStream during decompose; the throw surfaces as a
    // { type: "error", message } event relayed over SSE — which must be scrubbed.
    const engine = fakeEngine({
      async routeAndStream() {
        throw new Error(`search backend error: leaked ${FAKE_SECRET}`);
      },
    });
    const handler = makeHandler({ tavilyApiKey: "tvly-test" }, engine);
    const res = await handler(
      new Request("http://x/v1/research", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "what is zintus", depth: "standard" }),
      }),
    );
    const text = await res.text();
    expect(text).toContain('"error"');
    expect(text).not.toContain(FAKE_SECRET);
    expect(text).toContain(REDACTED);
  });

  test("an ordinary error message (no secret) passes through unchanged", async () => {
    const engine = fakeEngine({
      async routeAndStream() {
        throw new Error("model is overloaded, please retry");
      },
    });
    const handler = makeHandler({}, engine);
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
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    // redactSecrets is a no-op on a clean string — verbatim, including no marker.
    expect(body.error.message).toBe("model is overloaded, please retry");
    expect(body.error.message).not.toContain("REDACTED");
  });

  test("the structured UNSUPPORTED_VISION_ERROR is left intact (carries no secret)", async () => {
    // Auto-routing rejects an image request with no vision-capable candidate by
    // throwing "unsupported_capability"; the handler maps it to the structured
    // 422 error — which redaction must NOT touch.
    const engine = fakeEngine({
      async routeAndStream() {
        throw new Error("unsupported_capability");
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
            {
              role: "user",
              content: [
                { type: "text", text: "what is this?" },
                {
                  type: "image",
                  data: "iVBORw0KGgo=",
                  mimeType: "image/png",
                  bytes: 1024,
                  exifStripped: true,
                },
              ],
            },
          ],
        }),
      }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      error: { type: string; message: string; required: string[] };
    };
    expect(body.error.type).toBe("unsupported_capability");
    expect(body.error.required).toContain("vision");
    expect(body.error.message).toContain("vision-capable provider");
  });
});

describe("tool / function calling", () => {
  const weatherTool = {
    name: "get_weather",
    description: "Get the weather for a city",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  };
  const toolCall = {
    type: "tool_call" as const,
    id: "call_x",
    name: "get_weather",
    arguments: { city: "Paris" },
  };

  test("(a) streaming: tool calls are emitted as OpenAI delta.tool_calls + finish_reason:'tool_calls' before [DONE]", async () => {
    const engine = fakeEngine({
      async routeAndStream() {
        return {
          providerId: "groq",
          model: "llama-3.3-70b-versatile",
          traceId: "trace-tc",
          threadId: "thread-1",
          compileTraceId: undefined,
          stream: (async function* () {
            yield "Let me check.";
          })(),
          toolCalls: [toolCall],
        };
      },
    });
    const handler = makeHandler({}, engine);
    const res = await handler(
      new Request("http://x/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          stream: true,
          provider: "groq",
          tools: [weatherTool],
          messages: [{ role: "user", content: "weather in Paris?" }],
        }),
      }),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    const dataLines = text
      .split("\n\n")
      .map((b) => b.replace(/^data: /, "").trim())
      .filter((l) => l.length > 0 && l !== "[DONE]");
    const events = dataLines.map((l) => JSON.parse(l) as Record<string, any>);

    // The tool-call chunk carries the OpenAI delta.tool_calls shape.
    const toolChunk = events.find(
      (e) => e.choices?.[0]?.delta?.tool_calls,
    );
    expect(toolChunk).toBeDefined();
    const tc = toolChunk!.choices[0].delta.tool_calls[0];
    expect(tc.index).toBe(0);
    expect(tc.id).toBe("call_x");
    expect(tc.type).toBe("function");
    expect(tc.function.name).toBe("get_weather");
    expect(JSON.parse(tc.function.arguments)).toEqual({ city: "Paris" });

    // A terminating delta sets finish_reason: "tool_calls".
    const finish = events.find(
      (e) => e.choices?.[0]?.finish_reason === "tool_calls",
    );
    expect(finish).toBeDefined();
    expect(finish!.choices[0].delta).toEqual({});

    // …and the stream still terminates with [DONE] after the tool-call frames.
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  test("(b) explicit non-tool provider + tools → 422 UNSUPPORTED_TOOLS_ERROR (never reaches the engine)", async () => {
    let routed = false;
    const engine = fakeEngine({
      async routeAndStream() {
        routed = true;
        throw new Error("should not be called");
      },
    });
    const handler = makeHandler({}, engine);
    const res = await handler(
      new Request("http://x/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          stream: false,
          provider: "huggingface", // tools: false in MODEL_CAPABILITIES
          tools: [weatherTool],
          messages: [{ role: "user", content: "weather in Paris?" }],
        }),
      }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      error: { type: string; required: string[]; message: string };
    };
    expect(body.error.type).toBe("unsupported_capability");
    expect(body.error.required).toContain("tools");
    expect(body.error.message).toContain("Tool/function calling");
    expect(routed).toBe(false);
  });

  test("(c) router throws unsupported_capability with tools (no images) → tools error, not vision error", async () => {
    const engine = fakeEngine({
      async routeAndStream() {
        throw new Error("unsupported_capability");
      },
    });
    const handler = makeHandler({}, engine);
    const res = await handler(
      new Request("http://x/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          stream: false,
          // No explicit provider → the explicit-provider gate is skipped and the
          // router (auto-routing) throws unsupported_capability instead.
          tools: [weatherTool],
          messages: [{ role: "user", content: "weather in Paris?" }],
        }),
      }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      error: { type: string; required: string[] };
    };
    expect(body.error.type).toBe("unsupported_capability");
    expect(body.error.required).toContain("tools");
    expect(body.error.required).not.toContain("vision");
  });

  test("(d) non-streaming returns tool_calls on the assistant message + finish_reason:'tool_calls'", async () => {
    const engine = fakeEngine({
      async routeAndStream() {
        return {
          providerId: "groq",
          model: "llama-3.3-70b-versatile",
          traceId: "trace-tc",
          threadId: "thread-1",
          compileTraceId: undefined,
          stream: (async function* () {
            yield "";
          })(),
          toolCalls: [toolCall],
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
          provider: "groq",
          tools: [weatherTool],
          messages: [{ role: "user", content: "weather in Paris?" }],
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      choices: Array<{
        message: {
          role: string;
          content: string | null;
          tool_calls?: Array<{
            id: string;
            type: string;
            function: { name: string; arguments: string };
          }>;
        };
        finish_reason: string;
      }>;
    };
    const choice = body.choices[0]!;
    expect(choice.finish_reason).toBe("tool_calls");
    expect(choice.message.content).toBeNull();
    const calls = choice.message.tool_calls!;
    expect(calls).toHaveLength(1);
    expect(calls[0]!.id).toBe("call_x");
    expect(calls[0]!.type).toBe("function");
    expect(calls[0]!.function.name).toBe("get_weather");
    expect(JSON.parse(calls[0]!.function.arguments)).toEqual({ city: "Paris" });
  });

  test("(e) round-trip: an OpenAI-native assistant tool_calls turn normalizes to internal tool_call blocks", async () => {
    // The gateway EMITS `{role:"assistant", content:null, tool_calls:[...]}`. A
    // stock OpenAI client echoes that turn back as the next request's history.
    // parseMessages must convert the top-level tool_calls (with a JSON-STRING
    // arguments) into internal tool_call content blocks, or the call is lost.
    let received: Array<{ role: string; content: unknown }> | undefined;
    const engine = fakeEngine({
      async routeAndStream(request) {
        received = request.messages;
        return {
          providerId: "groq",
          model: "llama-3.3-70b-versatile",
          traceId: "trace-rt",
          threadId: "thread-1",
          compileTraceId: undefined,
          stream: (async function* () {
            yield "Paris is sunny.";
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
          provider: "groq",
          tools: [weatherTool],
          messages: [
            { role: "user", content: "weather in Paris?" },
            {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_x",
                  type: "function",
                  function: { name: "get_weather", arguments: '{"city":"Paris"}' },
                },
              ],
            },
            { role: "tool", tool_call_id: "call_x", content: '{"tempC":21}' },
          ],
        }),
      }),
    );
    expect(res.status).toBe(200);
    expect(received).toBeDefined();
    const assistantTurn = received!.find((m) => m.role === "assistant")!;
    expect(Array.isArray(assistantTurn.content)).toBe(true);
    const blocks = assistantTurn.content as Array<Record<string, unknown>>;
    const tcBlock = blocks.find((b) => b.type === "tool_call")!;
    expect(tcBlock.id).toBe("call_x");
    expect(tcBlock.name).toBe("get_weather");
    expect(tcBlock.arguments).toEqual({ city: "Paris" });
  });

  test("(f) malformed tool_call arguments JSON normalizes to an empty object, not a 400", async () => {
    let received: Array<{ role: string; content: unknown }> | undefined;
    const engine = fakeEngine({
      async routeAndStream(request) {
        received = request.messages;
        return {
          providerId: "groq",
          model: "llama-3.3-70b-versatile",
          traceId: "trace-rt2",
          threadId: "thread-1",
          compileTraceId: undefined,
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
          provider: "groq",
          tools: [weatherTool],
          messages: [
            { role: "user", content: "weather?" },
            {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_y",
                  type: "function",
                  function: { name: "get_weather", arguments: "{not json" },
                },
              ],
            },
            { role: "tool", tool_call_id: "call_y", content: "{}" },
          ],
        }),
      }),
    );
    expect(res.status).toBe(200);
    const assistantTurn = received!.find((m) => m.role === "assistant")!;
    const blocks = assistantTurn.content as Array<Record<string, unknown>>;
    const tcBlock = blocks.find((b) => b.type === "tool_call")!;
    expect(tcBlock.arguments).toEqual({});
  });
});

describe("structured / JSON output", () => {
  const personSchema = {
    type: "object",
    properties: { name: { type: "string" }, age: { type: "number" } },
    required: ["name", "age"],
  };

  test("(a) non-streaming structured request surfaces parsed + structured_output", async () => {
    const engine = fakeEngine({
      async routeAndStream() {
        return {
          providerId: "gemini",
          model: "gemini-2.5-flash",
          traceId: "trace-so",
          threadId: "thread-1",
          compileTraceId: undefined,
          stream: (async function* () {
            yield '{"name":"Ada","age":36}';
          })(),
          structuredOutput: {
            requested: "json_schema" as const,
            servedLevel: "json_schema" as const,
            guaranteed: true,
            valid: true,
            repairAttempts: 0,
          },
          parsed: { name: "Ada", age: 36 },
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
          messages: [{ role: "user", content: "describe Ada" }],
          response_format: { type: "json_schema", schema: personSchema },
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      choices: Array<{ message: { content: string } }>;
      parsed: unknown;
      structured_output: {
        requested: string;
        served_level: string;
        guaranteed: boolean;
        valid: boolean;
        repair_attempts: number;
      };
    };
    // Raw assistant text is preserved on the message.
    expect(body.choices[0]?.message.content).toBe('{"name":"Ada","age":36}');
    // Top-level parsed value + snake_cased metadata.
    expect(body.parsed).toEqual({ name: "Ada", age: 36 });
    expect(body.structured_output.requested).toBe("json_schema");
    expect(body.structured_output.served_level).toBe("json_schema");
    expect(body.structured_output.guaranteed).toBe(true);
    expect(body.structured_output.valid).toBe(true);
    expect(body.structured_output.repair_attempts).toBe(0);
  });

  test("(b) strict json_schema with an invalid result → 422 structured_output_invalid", async () => {
    const engine = fakeEngine({
      async routeAndStream() {
        return {
          providerId: "openrouter",
          model: "best-effort",
          traceId: "trace-bad",
          threadId: "thread-1",
          compileTraceId: undefined,
          stream: (async function* () {
            yield "sorry, here is some prose not JSON";
          })(),
          structuredOutput: {
            requested: "json_schema" as const,
            servedLevel: "json_object" as const,
            guaranteed: false,
            valid: false,
            repairAttempts: 2,
            issues: [{ path: "/name", message: "expected string" }],
          },
        };
      },
    });
    const handler = makeHandler({}, engine);
    const res = await handler(
      new Request("http://x/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          // No explicit provider, so the capability gate is skipped and the engine
          // result (valid:false) drives the 422 instead.
          stream: false,
          messages: [{ role: "user", content: "describe Ada" }],
          response_format: { type: "json_schema", strict: true, schema: personSchema },
        }),
      }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      error: {
        type: string;
        message: string;
        structured_output: { valid: boolean; repair_attempts: number };
      };
    };
    expect(body.error.type).toBe("structured_output_invalid");
    expect(body.error.structured_output.valid).toBe(false);
    expect(body.error.structured_output.repair_attempts).toBe(2);
  });

  test("(c) explicit non-json_schema provider + strict → 422 unsupported_capability required ['json_schema']", async () => {
    // groq's strongest structured level is json_object, not json_schema, so a
    // strict schema-constrained request against it must hard-error at the gate
    // (the engine is never reached).
    const engine = fakeEngine({
      async routeAndStream() {
        throw new Error("routeAndStream should not be called");
      },
    });
    const handler = makeHandler({}, engine);
    const res = await handler(
      new Request("http://x/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          stream: false,
          provider: "groq",
          messages: [{ role: "user", content: "describe Ada" }],
          response_format: { type: "json_schema", strict: true, schema: personSchema },
        }),
      }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      error: { type: string; required: string[]; message: string };
    };
    expect(body.error.type).toBe("unsupported_capability");
    expect(body.error.required).toContain("json_schema");
    expect(body.error.message).toContain("Gemini");
  });

  test("(d) streaming (default) strict json_schema with an invalid result → 422, NOT a 200 stream", async () => {
    // The DEFAULT path is streaming (stream omitted). The engine buffers +
    // validates the structured document before routeAndStream resolves, so a
    // strict request whose output did not validate must hard-fail 422 BEFORE the
    // SSE stream opens — never a 200 text/event-stream carrying a valid:false
    // frame + non-conformant prose.
    const engine = fakeEngine({
      async routeAndStream() {
        return {
          providerId: "openrouter",
          model: "best-effort",
          traceId: "trace-bad-stream",
          threadId: "thread-1",
          compileTraceId: undefined,
          stream: (async function* () {
            yield "sorry, here is some prose not JSON";
          })(),
          structuredOutput: {
            requested: "json_schema" as const,
            servedLevel: "json_object" as const,
            guaranteed: false,
            valid: false,
            repairAttempts: 2,
            issues: [{ path: "/name", message: "expected string" }],
          },
        };
      },
    });
    const handler = makeHandler({}, engine);
    const res = await handler(
      new Request("http://x/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          // stream omitted → defaults to streaming.
          messages: [{ role: "user", content: "describe Ada" }],
          response_format: { type: "json_schema", strict: true, schema: personSchema },
        }),
      }),
    );
    expect(res.status).toBe(422);
    expect(res.headers.get("content-type") ?? "").not.toContain(
      "text/event-stream",
    );
    const body = (await res.json()) as {
      error: {
        type: string;
        structured_output: { valid: boolean; repair_attempts: number };
      };
    };
    expect(body.error.type).toBe("structured_output_invalid");
    expect(body.error.structured_output.valid).toBe(false);
    expect(body.error.structured_output.repair_attempts).toBe(2);
  });

  test("(e) streaming strict json_schema with a VALID result still streams 200", async () => {
    // Guard the negative: a strict streaming request that DID validate must keep
    // its 200 SSE behavior (the pre-stream gate is valid:false-only).
    const engine = fakeEngine({
      async routeAndStream() {
        return {
          providerId: "gemini",
          model: "best",
          traceId: "trace-good-stream",
          threadId: "thread-1",
          compileTraceId: undefined,
          stream: (async function* () {
            yield '{"name":"Ada","age":36}';
          })(),
          structuredOutput: {
            requested: "json_schema" as const,
            servedLevel: "json_schema" as const,
            guaranteed: true,
            valid: true,
            repairAttempts: 0,
            issues: [],
            parsed: { name: "Ada", age: 36 },
          },
        };
      },
    });
    const handler = makeHandler({}, engine);
    const res = await handler(
      new Request("http://x/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: "describe Ada" }],
          response_format: { type: "json_schema", strict: true, schema: personSchema },
        }),
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/event-stream");
  });
});
