import { describe, expect, test } from "bun:test";
import type { Engine } from "@zintus/engine";
import type { GatewayConfig } from "./auth.js";
import { createGatewayHandler } from "./handler.js";

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
) {
  const full: GatewayConfig = {
    port: 8788,
    host: "127.0.0.1",
    token: "",
    corsOrigins: "*",
    ...config,
  };
  return createGatewayHandler({ engine, config: full });
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
});
