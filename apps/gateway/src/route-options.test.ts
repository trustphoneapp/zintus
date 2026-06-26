import { describe, expect, test } from "bun:test";
import type { Engine } from "@zintus/engine";
import type { ProviderId, ProviderStatus } from "@zintus/types";
import type { GatewayConfig } from "./auth.js";
import {
  createGatewayHandler,
  type GatewayHandlerDeps,
} from "./handler.js";
import type { LocalRuntimes } from "./local-runtimes.js";

/**
 * Tests for GET /v1/route/options — the local, BYOK-only quota-exhaustion
 * decision API. Everything is derived from local provider/quota/runtime state;
 * these tests assert the contract AND the hard rules (no paid/credits option,
 * no key/prompt leakage, never-fabricated reset times).
 */

function status(
  id: ProviderId,
  over: Partial<ProviderStatus> = {},
): ProviderStatus {
  return {
    id,
    name: id,
    color: "#000000",
    priority: 1,
    available: true,
    hasKey: true,
    inCooldown: false,
    cooldownUntil: null,
    requestsToday: 0,
    tokensToday: 0,
    lastReset: null,
    ...over,
  };
}

function fakeEngine(over: Partial<Engine> = {}): Engine {
  const base: Engine = {
    async routeAndStream() {
      return {
        providerId: "groq",
        model: "test-model",
        traceId: "trace-1",
        threadId: "thread-1",
        compileTraceId: undefined,
        stream: (async function* () {
          yield "hi";
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
    createThread: () => ({
      id: "t",
      title: "t",
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
    getTrace: () => null,
    getLastTrace: () => null,
    listTraces: () => [],
    getThreadState: () => null,
    getCompileTrace: () => null,
    async compileThreadContext() {
      return { traceId: "0", messages: [] };
    },
  };
  return { ...base, ...over };
}

const noLocal = async (): Promise<LocalRuntimes> => ({
  ollama: { detected: false },
  lmstudio: { detected: false },
});

function makeHandler(
  config: Partial<GatewayConfig> = {},
  engine = fakeEngine(),
  extra: Partial<GatewayHandlerDeps> = {},
) {
  const full: GatewayConfig = {
    port: 8788,
    host: "127.0.0.1",
    token: "",
    corsOrigins: "*",
    ...config,
  };
  return createGatewayHandler({
    engine,
    config: full,
    detectLocalRuntimes: noLocal,
    ...extra,
  });
}

const URLBASE = "http://x/v1/route/options";

describe("GET /v1/route/options", () => {
  test("401 without the gateway token when auth is configured", async () => {
    const handler = makeHandler({ token: "secret" });
    const res = await handler(new Request(`${URLBASE}?provider=gemini`));
    expect(res.status).toBe(401);
  });

  test("authorized with the bearer token", async () => {
    const handler = makeHandler({ token: "secret" });
    const res = await handler(
      new Request(`${URLBASE}?provider=gemini`, {
        headers: { authorization: "Bearer secret" },
      }),
    );
    expect(res.status).toBe(200);
  });

  test("400 on unknown provider", async () => {
    const handler = makeHandler();
    const res = await handler(new Request(`${URLBASE}?provider=anthropic`));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("Unknown provider");
  });

  test("400 when provider param is missing", async () => {
    const handler = makeHandler();
    const res = await handler(new Request(URLBASE));
    expect(res.status).toBe(400);
  });

  test("low quota + a cheaper healthy alt → best=switch_provider, alt listed, no use_credits", async () => {
    const engine = fakeEngine({
      async getProviderStatus() {
        return [
          status("gemini", { available: false }),
          status("groq", { available: true }),
        ];
      },
      // Server ledger says gemini is nearly exhausted.
      getQuotaRemaining: () => 0.05,
    });
    const handler = makeHandler({}, engine, { detectLocalRuntimes: noLocal });
    const res = await handler(new Request(`${URLBASE}?provider=gemini`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      best: string;
      quotaRemaining: number | null;
      options: string[];
      alternatives: Array<{ provider: string; estInputPer1M: number }>;
    };
    expect(body.best).toBe("switch_provider");
    expect(body.quotaRemaining).toBeCloseTo(0.05);
    expect(body.options).toContain("switch_provider");
    // groq (cheaper than gemini) is listed as the cheapest alternative.
    expect(body.alternatives[0]?.provider).toBe("groq");
    expect(typeof body.alternatives[0]?.estInputPer1M).toBe("number");
    // HARD: never a paid/credits/overflow option.
    expect(body.options).not.toContain("use_credits");
    expect(JSON.stringify(body)).not.toContain("use_credits");
  });

  test("local runtime detected → use_local in options + localAvailable:true", async () => {
    const engine = fakeEngine({
      async getProviderStatus() {
        // gemini keyed but exhausted; no cloud alternative available.
        return [status("gemini", { available: false })];
      },
      getQuotaRemaining: () => 0.0,
    });
    const localUp = async (): Promise<LocalRuntimes> => ({
      ollama: { detected: true, models: ["llama3.3"] },
      lmstudio: { detected: false },
    });
    const handler = makeHandler({}, engine, { detectLocalRuntimes: localUp });
    const res = await handler(new Request(`${URLBASE}?provider=gemini`));
    const body = (await res.json()) as {
      localAvailable: boolean;
      options: string[];
      best: string;
    };
    expect(body.localAvailable).toBe(true);
    expect(body.options).toContain("use_local");
    expect(body.best).toBe("use_local");
  });

  test("reset unknown → resetIn:null + resetReason; in-cooldown → resetIn is a number", async () => {
    // No cooldown timestamp tracked → reset time genuinely unavailable.
    const unknown = fakeEngine({
      async getProviderStatus() {
        return [status("gemini", { available: false, cooldownUntil: null })];
      },
      getQuotaRemaining: () => 0.05,
    });
    const r1 = await makeHandler({}, unknown)(
      new Request(`${URLBASE}?provider=gemini`),
    );
    const b1 = (await r1.json()) as {
      resetIn: number | null;
      resetReason?: string;
    };
    expect(b1.resetIn).toBeNull();
    expect(b1.resetReason).toBe("Reset time unavailable");

    // Ledger tracks a real cooldownUntil → resetIn is derived, no reason.
    const future = new Date(Date.now() + 90_000);
    const tracked = fakeEngine({
      async getProviderStatus() {
        return [
          status("groq", {
            available: false,
            inCooldown: true,
            cooldownUntil: future,
          }),
        ];
      },
      getQuotaRemaining: () => 0,
    });
    const r2 = await makeHandler({}, tracked)(
      new Request(`${URLBASE}?provider=groq`),
    );
    const b2 = (await r2.json()) as {
      resetIn: number | null;
      resetReason?: string;
    };
    expect(b2.resetIn).not.toBeNull();
    expect(b2.resetIn).toBeGreaterThan(0);
    expect(b2.resetIn).toBeLessThanOrEqual(90);
    expect(b2.resetReason).toBeUndefined();
  });

  test("quotaRemaining is null when the provider has no key (ledger not tracking) and no client hint", async () => {
    const engine = fakeEngine({
      async getProviderStatus() {
        return [status("gemini", { hasKey: false, available: false })];
      },
    });
    const res = await makeHandler({}, engine)(
      new Request(`${URLBASE}?provider=gemini`),
    );
    const body = (await res.json()) as { quotaRemaining: number | null };
    expect(body.quotaRemaining).toBeNull();
  });

  test("client quota hint is used only when the ledger has no value", async () => {
    const engine = fakeEngine({
      async getProviderStatus() {
        return [status("gemini", { hasKey: false })];
      },
    });
    const res = await makeHandler({}, engine)(
      new Request(`${URLBASE}?provider=gemini&quota=0.1`),
    );
    const body = (await res.json()) as { quotaRemaining: number | null };
    expect(body.quotaRemaining).toBeCloseTo(0.1);
  });

  test("response leaks no API keys, prompt content, or internal secrets", async () => {
    const engine = fakeEngine({
      async getProviderStatus() {
        return [
          status("gemini", { available: false }),
          status("groq", { available: true }),
        ];
      },
      getQuotaRemaining: () => 0.05,
    });
    const res = await makeHandler({}, engine)(
      new Request(`${URLBASE}?provider=gemini`),
    );
    const raw = await res.text();
    const lowered = raw.toLowerCase();
    for (const forbidden of [
      "apikey",
      "api_key",
      "bearer",
      "authorization",
      "secret",
      "sk-",
      "gsk_",
      "csk-",
      "messages",
      "prompt",
      "content",
    ]) {
      expect(lowered).not.toContain(forbidden);
    }
    // Exact allowed key set — nothing extra rides along.
    const body = JSON.parse(raw) as Record<string, unknown>;
    expect(new Set(Object.keys(body))).toEqual(
      new Set([
        "provider",
        "quotaRemaining",
        "resetIn",
        "resetReason",
        "best",
        "options",
        "reason",
        "alternatives",
        "localAvailable",
      ]),
    );
  });

  test("healthy quota → compress_harder (no needless switch)", async () => {
    const engine = fakeEngine({
      async getProviderStatus() {
        return [
          status("gemini", { available: true }),
          status("groq", { available: true }),
        ];
      },
      getQuotaRemaining: () => 0.9,
    });
    const res = await makeHandler({}, engine)(
      new Request(`${URLBASE}?provider=gemini`),
    );
    const body = (await res.json()) as { best: string };
    expect(body.best).toBe("compress_harder");
  });
});
