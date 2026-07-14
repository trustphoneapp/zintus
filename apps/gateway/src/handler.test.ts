import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Engine } from "@zintus/engine";
import { ActivityStore } from "./activity-store.js";
import type { GatewayConfig } from "./auth.js";
import { createGatewayHandler, type GatewayHandlerDeps } from "./handler.js";
import { createRateLimiter } from "./rate-limit.js";
import { EngineerSupervisor, LocalArtifactStore } from "@zintus/engineer";
import { EngineerRunManager } from "./engineer.js";
import { deriveEngineerPrincipal } from "./engineer-identity.js";
import { EngineerCapabilityPreflight } from "./engineer-preflight.js";

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
    getProviderStats: () => null,
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
    listMemory: () => [],
    upsertMemory: (input) => ({
      id: "m1",
      threadId: input.threadId ?? null,
      key: input.key,
      value: input.value,
      source: input.source,
      scope: input.scope ?? "thread",
      projectId: input.projectId,
      pinned: input.pinned ?? false,
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
    updateMemory: () => null,
    deleteMemory: () => false,
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
  test("Engineer run intake and reads use the gateway bearer boundary", async () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-gateway-engineer-"));
    const supervisor = new EngineerSupervisor({ dbPath: join(root, "engineer.db") });
    const principal = deriveEngineerPrincipal({ gatewayIdentitySecret: "handler-test-install-secret" });
    const preflight = new EngineerCapabilityPreflight({
      models: ["test-model"], publicationEnabled: false,
      repository: { repositoryId: "repo-1", provider: "local", owner: "local", name: "fixture", baseBranch: "main", baseCommitSha: "1".repeat(40), originUrl: "file:///fixture" },
      probe: {
        model: async () => ({ available: true, responsesApi: true, strictStructuredOutputs: true }),
        docker: async () => ({ available: true }), image: async () => ({ exactDigest: true }),
        repository: async () => ({ readable: true, exactBaseCommit: true }),
        publication: async () => ({ available: true, pullRequestsWritable: true }),
      },
    });
    await preflight.assertStartup();
    const engineerRuns = new EngineerRunManager({ supervisor, principal, preflight, artifactStore: new LocalArtifactStore({ root: join(root, "artifacts") }), diffForRun: () => "diff --git a/a b/a" });
    const handler = makeHandler({ token: "secret" }, fakeEngine(), { engineerRuns });
    const body = JSON.stringify({
      runId: "gateway-run-1",
      userId: "user-1",
      repository: {
        repositoryId: "repo-1", provider: "local", owner: "local", name: "fixture",
        baseBranch: "main", baseCommitSha: "1".repeat(40),
      },
      request: "Add a bounded feature",
    });
    expect((await handler(new Request("http://x/v1/engineer/runs", { method: "POST", body }))).status).toBe(401);
    const created = await handler(new Request("http://x/v1/engineer/runs", {
      method: "POST", body, headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
    }));
    expect(created.status).toBe(201);
    expect(supervisor.getRun("gateway-run-1").userId).not.toBe("user-1");
    const read = await handler(new Request("http://x/v1/engineer/runs/gateway-run-1", {
      headers: { Authorization: "Bearer secret" },
    }));
    expect(read.status).toBe(200);
    expect(((await read.json()) as { run: { state: string } }).run.state).toBe("REQUEST_RECEIVED");
    const plan = await handler(new Request("http://x/v1/engineer/runs/gateway-run-1/plan", {
      headers: { Authorization: "Bearer secret" },
    }));
    expect(plan.status).toBe(200);
    expect((await plan.json()) as unknown).toEqual({ plan: null });
    const artifacts = await handler(new Request("http://x/v1/engineer/runs/gateway-run-1/artifacts", {
      headers: { Authorization: "Bearer secret" },
    }));
    expect(artifacts.status).toBe(200);
    expect((await artifacts.json()) as unknown).toEqual({ artifacts: [] });
    const claims = await handler(new Request("http://x/v1/engineer/runs/gateway-run-1/claims", {
      headers: { Authorization: "Bearer secret" },
    }));
    expect(claims.status).toBe(200);
    expect((await claims.json()) as unknown).toEqual({ claims: [] });
    const evidence = await handler(new Request("http://x/v1/engineer/runs/gateway-run-1/evidence", {
      headers: { Authorization: "Bearer secret" },
    }));
    expect(evidence.status).toBe(200);
    expect((await evidence.json()) as unknown).toEqual({ evidenceBundles: [] });
    const tests = await handler(new Request("http://x/v1/engineer/runs/gateway-run-1/tests", { headers: { Authorization: "Bearer secret" } }));
    expect((await tests.json()) as unknown).toEqual({ tests: [] });
    const security = await handler(new Request("http://x/v1/engineer/runs/gateway-run-1/security", { headers: { Authorization: "Bearer secret" } }));
    expect((await security.json()) as unknown).toEqual({ securityFindings: [] });
    const failures = await handler(new Request("http://x/v1/engineer/runs/gateway-run-1/failures", { headers: { Authorization: "Bearer secret" } }));
    expect((await failures.json()) as unknown).toEqual({ failures: [] });
    const diff = await handler(new Request("http://x/v1/engineer/runs/gateway-run-1/diff", { headers: { Authorization: "Bearer secret" } }));
    expect((await diff.json()) as unknown).toEqual({ diff: "diff --git a/a b/a" });
    const approval = await handler(new Request("http://x/v1/engineer/runs/gateway-run-1/approval", { headers: { Authorization: "Bearer secret" } }));
    expect((await approval.json()) as unknown).toEqual({ approval: null });
    const observability = await handler(new Request("http://x/v1/engineer/observability", { headers: { Authorization: "Bearer secret" } }));
    expect(observability.status).toBe(200);
    expect(((await observability.json()) as { snapshot: { totalRuns: number; runsByState: Record<string, number> } }).snapshot).toMatchObject({
      totalRuns: 1,
      runsByState: { REQUEST_RECEIVED: 1 },
    });
    const cancelled = await handler(new Request("http://x/v1/engineer/runs/gateway-run-1/cancel", {
      method: "POST", headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
      body: JSON.stringify({ actorId: "another-user", reason: "Attempt to cancel another user's run." }),
    }));
    expect(cancelled.status).toBe(200);
    expect(((await cancelled.json()) as { run: { state: string } }).run.state).toBe("CANCELLED");
    supervisor.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("Engineer startup readiness is fail-closed and recovers only through an explicit retry", async () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-gateway-engineer-readiness-"));
    const supervisor = new EngineerSupervisor({ dbPath: join(root, "engineer.db") });
    const principal = deriveEngineerPrincipal({ gatewayIdentitySecret: "readiness-test-install" });
    let ready = false;
    let repositoryReady = false;
    const preflight = new EngineerCapabilityPreflight({
      models: ["exact-model"], publicationEnabled: false,
      repository: { repositoryId: "repo-ready", provider: "local", owner: "local", name: "fixture", baseBranch: "main", baseCommitSha: "1".repeat(40), originUrl: "file:///fixture" },
      probe: {
        model: async () => ({ available: ready, responsesApi: ready, strictStructuredOutputs: ready }),
        docker: async () => ({ available: ready }), image: async () => ({ exactDigest: ready }),
        repository: async () => ({ readable: repositoryReady, exactBaseCommit: repositoryReady }),
        publication: async () => ({ available: ready, pullRequestsWritable: ready }),
      },
    });
    const manager = new EngineerRunManager({ supervisor, principal, preflight });
    const handler = makeHandler({ token: "secret" }, fakeEngine(), { engineerRuns: manager });
    expect((await handler(new Request("http://x/health"))).status).toBe(503);
    const failed = await handler(new Request("http://x/v1/engineer/readiness/retry", { method: "POST", headers: { Authorization: "Bearer secret" } }));
    expect(failed.status).toBe(503);
    expect(supervisor.listRuns()).toEqual([]);
    ready = true;
    repositoryReady = true;
    const recovered = await handler(new Request("http://x/v1/engineer/readiness/retry", { method: "POST", headers: { Authorization: "Bearer secret" } }));
    expect(recovered.status).toBe(200);
    expect((await handler(new Request("http://x/health"))).status).toBe(200);
    const created = await handler(new Request("http://x/v1/engineer/runs", {
      method: "POST", headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
      body: JSON.stringify({ runId: "ready-run", repository: { repositoryId: "repo-ready", provider: "local", owner: "local", name: "fixture", baseBranch: "main", baseCommitSha: "1".repeat(40) }, request: "work" }),
    }));
    expect(created.status).toBe(201);
    repositoryReady = false;
    const blockedCreate = await handler(new Request("http://x/v1/engineer/runs", {
      method: "POST", headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
      body: JSON.stringify({ runId: "must-not-exist", repository: { repositoryId: "repo-ready", provider: "local", owner: "local", name: "fixture", baseBranch: "main", baseCommitSha: "1".repeat(40) }, request: "work" }),
    }));
    expect(blockedCreate.status).toBe(503);
    expect(supervisor.listRuns().map((run) => run.runId)).toEqual(["ready-run"]);
    const blockedCancel = await handler(new Request("http://x/v1/engineer/runs/ready-run/cancel", {
      method: "POST", headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "must not mutate while repository capability is lost" }),
    }));
    expect(blockedCancel.status).toBe(503);
    expect(supervisor.getRun("ready-run").state).toBe("REQUEST_RECEIVED");
    expect((await handler(new Request("http://x/health"))).status).toBe(503);
    expect((await handler(new Request("http://x/v1/engineer/readiness/retry", { method: "POST", headers: { Authorization: "Bearer secret" } }))).status).toBe(503);
    repositoryReady = true;
    expect((await handler(new Request("http://x/v1/engineer/readiness/retry", { method: "POST", headers: { Authorization: "Bearer secret" } }))).status).toBe(200);
    supervisor.close();
    rmSync(root, { recursive: true, force: true });
  });

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

  test("GET /v1/models returns a RICH per-model catalog (OpenAI-compat triple + metadata)", async () => {
    const handler = makeHandler();
    const res = await handler(new Request("http://x/v1/models", { method: "GET" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      object: string;
      data: Array<Record<string, unknown>>;
    };
    expect(body.object).toBe("list");
    expect(body.data.length).toBeGreaterThan(0);

    // OpenAI-compat triple intact on every entry.
    for (const m of body.data) {
      expect(typeof m.id).toBe("string");
      expect(m.object).toBe("model");
      expect(typeof m.owned_by).toBe("string");
    }

    // A known model carries the additive metadata.
    const flash = body.data.find((m) => m.id === "gemini-2.5-flash") as
      | {
          context_window: number;
          capabilities: { vision: boolean; tools: boolean; structured_output: string };
          pricing: { input_per_1m: number | null; output_per_1m: number | null };
          free: boolean;
          local: boolean;
          data_policy: Record<string, unknown>;
        }
      | undefined;
    expect(flash).toBeDefined();
    expect(flash?.context_window).toBe(1_000_000);
    expect(flash?.capabilities.vision).toBe(true);
    expect(flash?.capabilities.tools).toBe(true);
    expect(flash?.capabilities.structured_output).toBe("json_schema");
    expect(flash?.pricing.input_per_1m).toBe(0.3);
    expect(flash?.pricing.output_per_1m).toBe(2.5);
    // `free` = a free tier/quota exists (the catalog's honest semantic); Gemini
    // 2.5 Flash has both paid list pricing AND a free tier, so free:true.
    expect(flash?.free).toBe(true);
    expect(flash?.local).toBe(false);
    expect(typeof flash?.data_policy).toBe("object");
    expect(flash?.data_policy.tag).toBeDefined();
  });

  test("GET /v1/models?vision=true narrows the catalog to vision-capable models", async () => {
    const handler = makeHandler();
    const all = (await (
      await handler(new Request("http://x/v1/models", { method: "GET" }))
    ).json()) as { data: unknown[] };
    const visionRes = await handler(
      new Request("http://x/v1/models?vision=true", { method: "GET" }),
    );
    expect(visionRes.status).toBe(200);
    const vision = (await visionRes.json()) as {
      data: Array<{ id: string; capabilities: { vision: boolean } }>;
    };
    expect(vision.data.length).toBeGreaterThan(0);
    expect(vision.data.length).toBeLessThan(all.data.length); // actually narrowed
    expect(vision.data.every((m) => m.capabilities.vision === true)).toBe(true);
    expect(vision.data.some((m) => m.id === "gemini-2.5-flash")).toBe(true);
  });

  test("GET /v1/models?provider= filters to a single provider", async () => {
    const handler = makeHandler();
    const res = await handler(
      new Request("http://x/v1/models?provider=groq", { method: "GET" }),
    );
    const body = (await res.json()) as {
      data: Array<{ owned_by: string; id: string }>;
    };
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data.every((m) => m.owned_by === "Groq")).toBe(true);
  });

  test("GET /v1/pricing returns priced models and is auth-gated", async () => {
    // Auth-gated when a token is configured.
    const guarded = makeHandler({ token: "secret" });
    expect(
      (await guarded(new Request("http://x/v1/pricing", { method: "GET" }))).status,
    ).toBe(401);

    const handler = makeHandler();
    const res = await handler(new Request("http://x/v1/pricing", { method: "GET" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      object: string;
      data: Array<{
        id: string;
        provider: string;
        input_per_1m: number;
        output_per_1m: number;
        free: boolean;
      }>;
    };
    expect(body.object).toBe("list");
    expect(body.data.length).toBeGreaterThan(0);
    // Every entry has a concrete (non-null) price.
    for (const p of body.data) {
      expect(typeof p.input_per_1m).toBe("number");
      expect(typeof p.output_per_1m).toBe("number");
      expect(typeof p.provider).toBe("string");
    }
    const flash = body.data.find((p) => p.id === "gemini-2.5-flash");
    expect(flash?.input_per_1m).toBe(0.3);
    expect(flash?.output_per_1m).toBe(2.5);
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

  test("GET /v1/activity returns normalized usage entries, respects ?limit, and is auth-gated", async () => {
    const startedAt = new Date("2026-06-28T00:00:00.000Z");
    const engine = fakeEngine({
      // The handler fetches limit+1 to compute has_more honestly.
      listTraces: (limit: number) =>
        Array.from({ length: Math.min(limit, 3) }, (_unused, i) => ({
          traceId: `act-${i}`,
          startedAt,
          attempts: [
            {
              providerId: "groq" as const,
              model: "test-model",
              status: "success" as const,
              latencyMs: 42,
            },
          ],
          winner: { providerId: "groq" as const, model: "test-model" },
          totalLatencyMs: 100,
        })),
    });

    // Auth-gated when a token is configured.
    const guarded = makeHandler({ token: "secret" }, engine);
    expect(
      (await guarded(new Request("http://x/v1/activity"))).status,
    ).toBe(401);

    const handler = makeHandler({}, engine);
    const res = await handler(new Request("http://x/v1/activity?limit=2"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      object: string;
      has_more: boolean;
      data: Array<Record<string, unknown>>;
    };
    expect(body.object).toBe("list");
    // Asked for 2 → page of 2, and a 3rd existed → has_more true.
    expect(body.data).toHaveLength(2);
    expect(body.has_more).toBe(true);

    const entry = body.data[0] as {
      id: string;
      created: number;
      provider: string;
      model: string;
      tokens: { input: number; output: number; total: number };
      cost_usd: number;
      saved_vs_baseline_usd: number;
      latency_ms: number;
      cache_hit: boolean;
      route_reason?: string;
    };
    expect(entry.id).toBe("act-0");
    expect(entry.created).toBe(Math.floor(startedAt.getTime() / 1000));
    expect(entry.provider).toBe("groq");
    expect(entry.model).toBe("test-model");
    // No token usage recorded on the trace → honest zeros, never fabricated.
    expect(entry.tokens).toEqual({ input: 0, output: 0, total: 0 });
    expect(entry.cost_usd).toBe(0);
    expect(entry.saved_vs_baseline_usd).toBe(0);
    expect(entry.latency_ms).toBe(100);
    expect(entry.cache_hit).toBe(false);
    // route_reason omitted when the trace did not record one.
    expect(entry.route_reason).toBeUndefined();
  });

  test("GET /v1/activity surfaces real recorded usage and is empty when none", async () => {
    // A trace carrying optional usage telemetry → flows through normalized.
    const richEngine = fakeEngine({
      listTraces: () => [
        {
          traceId: "act-rich",
          startedAt: new Date("2026-06-28T00:00:00.000Z"),
          attempts: [],
          winner: { providerId: "cerebras" as const, model: "llama" },
          // Extended fields a trace MAY carry; read defensively.
          tokens: { input: 10, output: 5, total: 15 },
          cacheHit: true,
          routeReason: "cheapest-healthy",
        } as never,
      ],
    });
    const handler = makeHandler({}, richEngine);
    const res = await handler(new Request("http://x/v1/activity"));
    const body = (await res.json()) as { data: Array<Record<string, unknown>> };
    const entry = body.data[0] as Record<string, unknown>;
    expect(entry.tokens).toEqual({ input: 10, output: 5, total: 15 });
    expect(entry.cache_hit).toBe(true);
    expect(entry.route_reason).toBe("cheapest-healthy");
    expect(entry.provider).toBe("cerebras");

    // Empty list when no usage has been recorded.
    const emptyHandler = makeHandler({}, fakeEngine({ listTraces: () => [] }));
    const emptyRes = await emptyHandler(new Request("http://x/v1/activity"));
    const emptyBody = (await emptyRes.json()) as {
      data: unknown[];
      has_more: boolean;
    };
    expect(emptyBody.data).toEqual([]);
    expect(emptyBody.has_more).toBe(false);
  });

  test("GET /v1/activity reads the DURABLE store first, honoring ?since/?limit/?provider + retention_days", async () => {
    const store = new ActivityStore(
      join(mkdtempSync(join(tmpdir(), "zintus-activity-h-")), "activity.db"),
    );
    const base = Math.floor(Date.UTC(2026, 5, 28, 0, 0, 0) / 1000);
    store.recordActivity({
      traceId: "d-old",
      created: base - 10_000,
      provider: "cerebras",
      model: "llama-3.1-8b",
      inputTokens: 5,
      outputTokens: 2,
      costUsd: 0,
      savedVsBaselineUsd: 0,
      latencyMs: 30,
      cacheHit: false,
      routeReason: null,
    });
    store.recordActivity({
      traceId: "d-new",
      created: base,
      provider: "groq",
      model: "llama-3.3-70b-versatile",
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0,
      savedVsBaselineUsd: 0.0009,
      latencyMs: 120,
      cacheHit: false,
      routeReason: "cheapest-healthy",
    });

    // Engine traces are non-empty; the durable store must take precedence.
    const engine = fakeEngine({
      listTraces: () => [
        { traceId: "trace-only", startedAt: new Date(), attempts: [] },
      ],
    });
    const handler = makeHandler({}, engine, { activityStore: store });

    const res = await handler(new Request("http://x/v1/activity"));
    const body = (await res.json()) as {
      data: Array<Record<string, unknown>>;
      has_more: boolean;
      retention_days: number;
    };
    // Durable rows (newest-first), not the trace ring.
    expect(body.data.map((e) => e.id)).toEqual(["d-new", "d-old"]);
    expect(body.retention_days).toBe(30);
    const top = body.data[0] as Record<string, unknown>;
    expect(top.tokens).toEqual({ input: 10, output: 5, total: 15 });
    expect(top.cost_usd).toBe(0);
    expect(top.route_reason).toBe("cheapest-healthy");

    // ?since drops the older row.
    const sinceRes = await handler(
      new Request(`http://x/v1/activity?since=${base - 100}`),
    );
    const sinceBody = (await sinceRes.json()) as { data: Array<{ id: string }> };
    expect(sinceBody.data.map((e) => e.id)).toEqual(["d-new"]);

    // ?provider filter.
    const provRes = await handler(
      new Request("http://x/v1/activity?provider=cerebras"),
    );
    const provBody = (await provRes.json()) as { data: Array<{ id: string }> };
    expect(provBody.data.map((e) => e.id)).toEqual(["d-old"]);

    // ?limit caps the page and drives has_more honestly.
    const limitRes = await handler(new Request("http://x/v1/activity?limit=1"));
    const limitBody = (await limitRes.json()) as {
      data: unknown[];
      has_more: boolean;
    };
    expect(limitBody.data).toHaveLength(1);
    expect(limitBody.has_more).toBe(true);

    store.close();
  });

  test("GET /v1/activity falls back to the trace path when the durable store is empty", async () => {
    const store = new ActivityStore(
      join(mkdtempSync(join(tmpdir(), "zintus-activity-e-")), "activity.db"),
    );
    const engine = fakeEngine({
      listTraces: () => [
        {
          traceId: "fallback-trace",
          startedAt: new Date("2026-06-28T00:00:00.000Z"),
          attempts: [],
          winner: { providerId: "groq" as const, model: "test-model" },
          totalLatencyMs: 50,
        },
      ],
    });
    const handler = makeHandler({}, engine, { activityStore: store });
    const res = await handler(new Request("http://x/v1/activity"));
    const body = (await res.json()) as {
      data: Array<{ id: string }>;
      retention_days?: number;
    };
    // Empty store → trace-derived entry, and no retention_days on the fallback.
    expect(body.data.map((e) => e.id)).toEqual(["fallback-trace"]);
    expect(body.retention_days).toBeUndefined();
    store.close();
  });

  test("POST /v1/keys/validate guards its contract (no network in these paths)", async () => {
    const handler = makeHandler({}, fakeEngine({}));
    const post = (body: unknown) =>
      handler(
        new Request("http://x/v1/keys/validate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      );

    // Unknown provider, local runtimes (no key concept), and a missing key are
    // all 400s with honest messages; auth applies like every /v1/* route.
    expect((await post({ providerId: "not-a-provider", key: "x" })).status).toBe(400);
    const local = await post({ providerId: "ollama", key: "x" });
    expect(local.status).toBe(400);
    expect(JSON.stringify(await local.json())).toContain("local runtime");
    expect((await post({ providerId: "groq" })).status).toBe(400);
    const badJson = await handler(
      new Request("http://x/v1/keys/validate", { method: "POST", body: "{nope" }),
    );
    expect(badJson.status).toBe(400);

    const guarded = makeHandler({ token: "secret" }, fakeEngine({}));
    const denied = await guarded(
      new Request("http://x/v1/keys/validate", {
        method: "POST",
        body: JSON.stringify({ providerId: "groq", key: "k" }),
      }),
    );
    expect(denied.status).toBe(401);
  });

  test("GET /v1/key returns per-provider quota status (null limit when unreported) and is auth-gated", async () => {
    const engine = fakeEngine({
      async getProviderStatus() {
        return [
          {
            id: "groq",
            name: "Groq",
            color: "#fff",
            priority: 1,
            available: true,
            hasKey: true,
            inCooldown: false,
            cooldownUntil: null,
            requestsToday: 3,
            tokensToday: 250,
            lastReset: null,
            tokensLimit: 1000,
          },
          {
            id: "ollama",
            name: "Ollama",
            color: "#000",
            priority: 2,
            available: true,
            hasKey: false,
            inCooldown: false,
            cooldownUntil: null,
            requestsToday: 0,
            tokensToday: 0,
            lastReset: null,
            // No tokensLimit → quota_limit must be null (never fabricated).
          },
        ];
      },
    });

    // Auth-gated.
    const guarded = makeHandler({ token: "secret" }, engine);
    expect((await guarded(new Request("http://x/v1/key"))).status).toBe(401);

    const handler = makeHandler({}, engine);
    const res = await handler(new Request("http://x/v1/key"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      object: string;
      label: string;
      is_free_tier: boolean;
      managed_keys_available: boolean;
      providers: Array<{
        id: string;
        has_key: boolean;
        quota_used: number;
        quota_limit: number | null;
        quota_remaining_ratio: number | null;
      }>;
    };
    expect(body.object).toBe("key_status");
    expect(body.label).toBe("zintus-gateway");
    expect(body.is_free_tier).toBe(true);
    expect(body.managed_keys_available).toBe(false);

    const groq = body.providers.find((p) => p.id === "groq");
    expect(groq?.quota_limit).toBe(1000);
    expect(groq?.quota_used).toBe(250);
    expect(groq?.quota_remaining_ratio).toBeCloseTo(0.75);

    const ollama = body.providers.find((p) => p.id === "ollama");
    expect(ollama?.has_key).toBe(false);
    // Honest: no reported denominator → null, not a fabricated cap.
    expect(ollama?.quota_limit).toBeNull();
    expect(ollama?.quota_remaining_ratio).toBeNull();
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

describe("/v1/models — honest measured provider stats", () => {
  type ModelEntry = {
    id: string;
    owned_by: string;
    stats: {
      latency_p95_ms: number | null;
      throughput_tps: number | null;
      uptime: number | null;
      samples: number;
    };
  };

  test("stats fields exist and are NULL when no accessor is wired", async () => {
    const handler = makeHandler();
    const res = await handler(
      new Request("http://x/v1/models", { method: "GET" }),
    );
    const body = (await res.json()) as { data: ModelEntry[] };
    expect(body.data.length).toBeGreaterThan(0);
    for (const m of body.data) {
      expect(m.stats).toBeDefined();
      expect(m.stats.latency_p95_ms).toBeNull();
      expect(m.stats.throughput_tps).toBeNull();
      expect(m.stats.uptime).toBeNull();
      expect(m.stats.samples).toBe(0);
    }
  });

  test("stats reflect the injected accessor; null-when-insufficient is preserved", async () => {
    const handler = makeHandler({}, fakeEngine(), {
      // groq has plenty of samples → measured numbers; everyone else has too few
      // → metrics stay null while `samples` is carried honestly.
      getProviderStats: (provider) =>
        provider === "groq"
          ? {
              latencyP95Ms: 123,
              throughputTps: 45.5,
              successRate: 0.99,
              samples: 50,
            }
          : {
              latencyP95Ms: null,
              throughputTps: null,
              successRate: null,
              samples: 1,
            },
    });
    const res = await handler(
      new Request("http://x/v1/models", { method: "GET" }),
    );
    const body = (await res.json()) as { data: ModelEntry[] };

    const measured = body.data.filter((m) => m.stats.samples === 50);
    const insufficient = body.data.filter((m) => m.stats.samples === 1);
    expect(measured.length).toBeGreaterThan(0);
    expect(insufficient.length).toBeGreaterThan(0);
    for (const m of measured) {
      expect(m.stats.latency_p95_ms).toBe(123);
      expect(m.stats.throughput_tps).toBe(45.5);
      expect(m.stats.uptime).toBe(0.99);
    }
    // Honesty: too few samples → metrics null (NOT 0), but the raw count rides along.
    for (const m of insufficient) {
      expect(m.stats.latency_p95_ms).toBeNull();
      expect(m.stats.throughput_tps).toBeNull();
      expect(m.stats.uptime).toBeNull();
      expect(m.stats.samples).toBe(1);
    }
  });
});

describe("chat provider routing (OpenRouter-style body → strategy/weights/forced)", () => {
  type Captured = {
    provider?: string;
    strategy?: string;
    providerWeights?: Record<string, number>;
  };

  function capturingHandler() {
    let captured: Captured | undefined;
    const engine = fakeEngine({
      async routeAndStream(request) {
        captured = {
          provider: request.provider,
          strategy: request.strategy,
          providerWeights: request.providerWeights,
        };
        return {
          providerId: "groq",
          model: "m",
          traceId: "t",
          threadId: "th",
          compileTraceId: undefined,
          stream: (async function* () {
            yield "ok";
          })(),
        };
      },
    });
    return { handler: makeHandler({}, engine), get: () => captured };
  }

  async function post(handler: ReturnType<typeof makeHandler>, body: unknown) {
    const res = await handler(
      new Request("http://x/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    await res.text(); // drain the SSE stream
    return res;
  }

  const messages = [{ role: "user", content: "hi" }];

  test('sort:"latency" selects the fastest-latency strategy (no forced provider)', async () => {
    const { handler, get } = capturingHandler();
    await post(handler, { messages, provider: { sort: "latency" } });
    expect(get()?.strategy).toBe("fastest");
    expect(get()?.provider).toBeUndefined();
  });

  test('sort:"throughput" also maps to fastest (Zintus speed signal is p95)', async () => {
    const { handler, get } = capturingHandler();
    await post(handler, { messages, provider: { sort: "throughput" } });
    expect(get()?.strategy).toBe("fastest");
  });

  test('sort:"price" maps to the economy strategy', async () => {
    const { handler, get } = capturingHandler();
    await post(handler, { messages, provider: { sort: "price" } });
    expect(get()?.strategy).toBe("economy");
  });

  test("allow_fallbacks:false pins to order[0] → single provider, no failover", async () => {
    const { handler, get } = capturingHandler();
    await post(handler, {
      messages,
      provider: { order: ["groq", "gemini"], allow_fallbacks: false },
    });
    // Forced to the single top-preference provider → the router yields exactly
    // one candidate and never fails over to gemini.
    expect(get()?.provider).toBe("groq");
    expect(get()?.providerWeights).toBeUndefined();
  });

  test("order (no sort) maps to descending per-request weights, no forced provider", async () => {
    const { handler, get } = capturingHandler();
    await post(handler, { messages, provider: { order: ["gemini", "groq"] } });
    expect(get()?.provider).toBeUndefined();
    expect(get()?.providerWeights).toEqual({ gemini: 2, groq: 1 });
  });

  test("legacy forced-provider STRING still forces that provider", async () => {
    const { handler, get } = capturingHandler();
    await post(handler, { messages, provider: "groq" });
    expect(get()?.provider).toBe("groq");
  });
});
