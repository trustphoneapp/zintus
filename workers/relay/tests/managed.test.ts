import { afterEach, describe, expect, test } from "bun:test";
import {
  MANAGED_MODELS,
  availableManagedModels,
  estimateTokens,
  handleManagedChat,
  managedKey,
  SseUsageScanner,
  usageFromSseChunk,
} from "../src/managed.js";
import { MANAGED_KEYS_AVAILABLE, MANAGED_KEY_TIERS, TIERS, CLASS_BURN, checkoutAvailability } from "../src/tiers.js";
import type { Env } from "../src/types.js";
import type { SessionPayload } from "../src/auth.js";
import type { Context } from "hono";

// ── env / context fakes ───────────────────────────────────────────────────

function fakeEnv(overrides: Partial<Env> = {}): Env {
  const d1Calls: unknown[][] = [];
  const stmt = {
    bind: (...args: unknown[]) => {
      d1Calls.push(args);
      return stmt;
    },
    first: async () => null,
    run: async () => ({}),
    all: async () => ({ results: [] }),
  };
  const quotaStub = {
    fetch: async (url: string) =>
      new Response(JSON.stringify({ total: 0 }), { status: 200 }),
  };
  return {
    DB: { prepare: () => stmt } as unknown as Env["DB"],
    KV: {} as Env["KV"],
    QUOTA_COUNTER: {
      idFromName: () => "id",
      get: () => quotaStub,
    } as unknown as Env["QUOTA_COUNTER"],
    GATEWAY_SESSION: {} as Env["GATEWAY_SESSION"],
    RELAY_BASE_URL: "https://relay.test",
    COOKIE_DOMAIN: "test",
    GOOGLE_CLIENT_ID: "",
    GOOGLE_CLIENT_SECRET: "",
    RESEND_API_KEY: "",
    STRIPE_SECRET_KEY: "",
    STRIPE_WEBHOOK_SECRET: "",
    ...overrides,
  } as Env;
}

const SESSION: SessionPayload = {
  session_id: "s1",
  user_id: "u1",
  email: "member@test.dev",
};

/** Minimal Hono context stand-in for handleManagedChat. */
function fakeContext(env: Env, body: unknown) {
  const waited: Promise<unknown>[] = [];
  const c = {
    env,
    req: { json: async () => body },
    json: (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    executionCtx: {
      waitUntil: (p: Promise<unknown>) => {
        waited.push(p);
      },
    },
  } as unknown as Context<{ Bindings: Env }>;
  return { c, waited };
}

/** Env whose D1 reports an ACTIVE subscription of the given tier. */
function memberEnv(tier: string, keys: Partial<Env> = {}, quotaTotal = 0): Env {
  const stmt = {
    bind: () => stmt,
    first: async () => ({
      user_id: "u1",
      tier,
      status: "active",
      tokens_limit: TIERS[tier as keyof typeof TIERS]?.tokens_per_month ?? null,
    }),
    run: async () => ({}),
    all: async () => ({ results: [] }),
  };
  const quotaStub = {
    fetch: async () => new Response(JSON.stringify({ total: quotaTotal })),
  };
  return fakeEnv({
    DB: { prepare: () => stmt } as unknown as Env["DB"],
    QUOTA_COUNTER: {
      idFromName: () => "id",
      get: () => quotaStub,
    } as unknown as Env["QUOTA_COUNTER"],
    ...keys,
  });
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// ── tier honesty ──────────────────────────────────────────────────────────

describe("tiers match the public pricing page", () => {
  // apps/web/app/pricing/page.tsx sells: Starter 1M · Pro 10M · Max 50M ·
  // Pro 200M tokens/month. The relay must never grant less than the page sells.
  test("token budgets equal the sold amounts", () => {
    expect(TIERS.starter.tokens_per_month).toBe(1_000_000);
    expect(TIERS.pro.tokens_per_month).toBe(10_000_000);
    expect(TIERS.max.tokens_per_month).toBe(50_000_000);
    expect(TIERS.ultra.tokens_per_month).toBe(200_000_000);
  });

  test("managed backend flag is on and pro is a managed tier", () => {
    expect(MANAGED_KEYS_AVAILABLE).toBe(true);
    expect(MANAGED_KEY_TIERS).toContain("ultra");
  });

  test("checkout is open now that test-mode Stripe prices are configured", () => {
    expect(checkoutAvailability("starter")).toBeNull();
  });
});

// ── model registry honesty ────────────────────────────────────────────────

describe("availableManagedModels", () => {
  test("no keys configured → no models listed (never vaporware)", () => {
    expect(availableManagedModels(fakeEnv())).toEqual([]);
  });

  test("lists exactly the models whose upstream key exists", () => {
    const env = fakeEnv({ MANAGED_KEY_GROQ: "gsk_x" });
    const ids = availableManagedModels(env).map((m) => m.id);
    expect(ids).toContain("zintus/llama-3.3-70b");
    expect(ids).toContain("zintus/llama-3.1-8b");
    expect(ids).toContain("zintus/llama-4-scout");
    expect(ids).not.toContain("zintus/gpt-4o-mini");
    expect(ids).not.toContain("zintus/deepseek-chat");
  });

  test("scout serves via groq with the full catalog id (Together route was unservable)", () => {
    const m = MANAGED_MODELS.find((x) => x.id === "zintus/llama-4-scout")!;
    expect(m.upstreams).toEqual([
      { provider: "groq", model: "meta-llama/llama-4-scout-17b-16e-instruct" },
    ]);
    expect(m.contextWindow).toBe(131_072); // Groq catalog value, not Meta's 10M claim
    expect(m.capabilities.tools).toBe(true); // on Groq's official tool-use list
  });

  test("cerebras key alone still serves the 70B (second upstream)", () => {
    const env = fakeEnv({ MANAGED_KEY_CEREBRAS: "csk_x" });
    const ids = availableManagedModels(env).map((m) => m.id);
    expect(ids).toEqual(["zintus/llama-3.3-70b"]);
  });

  test("together key gates qwen3-235b and lists nothing else", () => {
    const env = fakeEnv({ MANAGED_KEY_TOGETHER: "tk_x" });
    const ids = availableManagedModels(env).map((m) => m.id);
    expect(ids).toEqual(["zintus/qwen3-235b"]);
    // Honest capabilities: Together's -tput catalog row lists no
    // function-calling / vision / structured outputs (verified 2026-07-06).
    const m = MANAGED_MODELS.find((x) => x.id === "zintus/qwen3-235b")!;
    expect(m.capabilities).toEqual({ tools: false, json: false, vision: false });
    expect(m.contextWindow).toBe(262_144);
    expect(m.upstreams).toEqual([
      { provider: "together", model: "Qwen/Qwen3-235B-A22B-Instruct-2507-tput" },
    ]);
  });

  test("every model has a pricing class with a defined burn rate", () => {
    for (const m of MANAGED_MODELS) {
      expect(m.class).toBeDefined();
      expect(CLASS_BURN[m.class]).toBeGreaterThanOrEqual(0);
    }
    // Spot-pin the PRICING-FINAL Part 3 assignments so a silent re-class
    // (which changes what members are charged) fails loudly.
    const byId = Object.fromEntries(MANAGED_MODELS.map((m) => [m.id, m.class]));
    expect(byId["zintus/llama-3.1-8b"]).toBe("cheap");
    expect(byId["zintus/deepseek-chat"]).toBe("cheap");
    expect(byId["zintus/gpt-4o-mini"]).toBe("mid");
    expect(byId["zintus/llama-3.3-70b"]).toBe("premium");
    expect(byId["zintus/kimi-k2"]).toBe("premium");
    // 2026-07-06 roster expansion (PRICING-FINAL Part 3 verified):
    expect(byId["zintus/claude-haiku-4-5"]).toBe("premium");
    expect(byId["zintus/gemini-2.5-flash"]).toBe("mid");
    expect(byId["zintus/glm-4.7-flash"]).toBe("free");
    expect(byId["zintus/glm-4.5-flash"]).toBe("free");
    expect(byId["zintus/mistral-small"]).toBe("mid");
    // 2026-07-07 xAI fix: 4.1-fast retired (console-confirmed); build =
    // premium ($1.30/M blended), 4.3 = frontier per PRICING-FINAL §2.
    expect(byId["zintus/grok-4.1-fast"]).toBeUndefined();
    expect(byId["zintus/grok-build"]).toBe("premium");
    expect(byId["zintus/grok-4.3"]).toBe("frontier");
    // 2026-07-06 Together expansion: $0.32/M blended ⇒ mid band.
    expect(byId["zintus/qwen3-235b"]).toBe("mid");
    // Scout on Groq: $0.179/M blended ⇒ cheap band (PRICING-FINAL §2 names it).
    expect(byId["zintus/llama-4-scout"]).toBe("cheap");
  });

  test("managedKey trims and defaults to empty", () => {
    expect(managedKey(fakeEnv(), "groq")).toBe("");
    expect(managedKey(fakeEnv({ MANAGED_KEY_GROQ: "  k  " }), "groq")).toBe("k");
  });
});

// ── usage scanning ────────────────────────────────────────────────────────

describe("SseUsageScanner", () => {
  test("prefers the provider-reported usage block", () => {
    const s = new SseUsageScanner();
    s.scan('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n');
    s.scan('data: {"usage":{"prompt_tokens":42,"completion_tokens":7},"choices":[]}\n\ndata: [DONE]\n\n');
    expect(s.totals(1000)).toEqual({ input: 42, output: 7, reported: true });
  });

  test("falls back to a flagged chars/4 estimate", () => {
    const s = new SseUsageScanner();
    s.scan('data: {"choices":[{"delta":{"content":"' + "abcd".repeat(10) + '"}}]}\n\n');
    const t = s.totals(400);
    expect(t.reported).toBe(false);
    expect(t.input).toBe(100); // 400 chars / 4
    expect(t.output).toBe(10); // 40 chars / 4
  });

  test("survives split SSE frames across chunks", () => {
    const s = new SseUsageScanner();
    const evt = 'data: {"usage":{"prompt_tokens":5,"completion_tokens":3},"choices":[]}\n\n';
    s.scan(evt.slice(0, 25));
    s.scan(evt.slice(25));
    expect(s.totals(1)).toEqual({ input: 5, output: 3, reported: true });
  });

  test("usageFromSseChunk rejects malformed shapes", () => {
    expect(usageFromSseChunk(null)).toBeNull();
    expect(usageFromSseChunk({})).toBeNull();
    expect(usageFromSseChunk({ usage: { completion_tokens: 3 } })).toBeNull();
  });

  test("estimateTokens floors at 1", () => {
    expect(estimateTokens("")).toBe(1);
    expect(estimateTokens("abcdefgh")).toBe(2);
  });
});

// ── chat handler gates ────────────────────────────────────────────────────

const VALID_BODY = {
  model: "zintus/llama-3.3-70b",
  messages: [{ role: "user", content: "hi" }],
  stream: false,
};

describe("handleManagedChat gating", () => {
  test("free tier asking a paid-class model → 403 model_requires_upgrade", async () => {
    // Class gate now fires BEFORE the membership gate, so a free user hears
    // "requires the Pro plan" instead of a generic membership error.
    const { c } = fakeContext(fakeEnv({ MANAGED_KEY_GROQ: "k" }), VALID_BODY);
    const res = await handleManagedChat(c, SESSION);
    expect(res.status).toBe(403);
    const json = (await res.json()) as { code: string; min_tier: string };
    expect(json.code).toBe("model_requires_upgrade");
    expect(json.min_tier).toBe("pro");
  });


  test("member with exhausted plan tokens → 429 plan_tokens_exhausted", async () => {
    // Counter stores millicredits: Starter grant = 15,000 cr = 15M mc.
    // Must use a model Starter's classes can reach (8B is cheap) — the class
    // gate fires before the balance check.
    const env = memberEnv("starter", { MANAGED_KEY_GROQ: "k" }, 15_000_000);
    const { c } = fakeContext(env, { ...VALID_BODY, model: "zintus/llama-3.1-8b" });
    const res = await handleManagedChat(c, SESSION);
    expect(res.status).toBe(429);
    const json = (await res.json()) as { code: string; limit: number };
    expect(json.code).toBe("plan_tokens_exhausted");
    expect(json.limit).toBe(1_000_000);
  });

  test("member asking for an unconfigured model → 404 model_unavailable", async () => {
    const env = memberEnv("starter", { MANAGED_KEY_GROQ: "k" });
    const { c } = fakeContext(env, { ...VALID_BODY, model: "zintus/gpt-4o-mini" });
    const res = await handleManagedChat(c, SESSION);
    expect(res.status).toBe(404);
  });

  test("invalid body → 400", async () => {
    const env = memberEnv("starter", { MANAGED_KEY_GROQ: "k" });
    const { c } = fakeContext(env, { model: "zintus/llama-3.3-70b", messages: [] });
    const res = await handleManagedChat(c, SESSION);
    expect(res.status).toBe(400);
  });

  test("member non-stream request is served and metered from provider usage", async () => {
    const env = memberEnv("pro", { MANAGED_KEY_GROQ: "gsk_live" });
    const { c, waited } = fakeContext(env, VALID_BODY);

    let upstreamAuth = "";
    let upstreamUrl = "";
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      upstreamUrl = String(url);
      upstreamAuth = (init?.headers as Record<string, string>)["Authorization"] ?? "";
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "hello" } }],
          usage: { prompt_tokens: 12, completion_tokens: 34 },
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const res = await handleManagedChat(c, SESSION);
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      zintus: { served_by: string; model: string; usage_reported: boolean };
    };
    expect(json.zintus.served_by).toBe("groq");
    expect(json.zintus.model).toBe("zintus/llama-3.3-70b");
    expect(json.zintus.usage_reported).toBe(true);
    expect(upstreamUrl).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(upstreamAuth).toBe("Bearer gsk_live");
    // Metering was scheduled.
    expect(waited.length).toBe(1);
    await Promise.all(waited);
  });

  test("failover: groq 500 → cerebras serves", async () => {
    // pro: llama-3.3-70b is premium class — starter would (correctly) 403.
    const env = memberEnv("pro", {
      MANAGED_KEY_GROQ: "gsk",
      MANAGED_KEY_CEREBRAS: "csk",
    });
    const { c } = fakeContext(env, VALID_BODY);

    const calls: string[] = [];
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      calls.push(String(url));
      if (String(url).includes("groq")) return new Response("boom", { status: 500 });
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
        { status: 200 },
      );
    }) as typeof fetch;

    const res = await handleManagedChat(c, SESSION);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { zintus: { served_by: string } };
    expect(json.zintus.served_by).toBe("cerebras");
    expect(calls.length).toBe(2);
  });

  test("streaming response passes SSE through and meters after flush", async () => {
    const env = memberEnv("pro", { MANAGED_KEY_GROQ: "gsk" });
    const { c, waited } = fakeContext(env, { ...VALID_BODY, stream: true });

    const sse = [
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
      'data: {"usage":{"prompt_tokens":9,"completion_tokens":2},"choices":[]}\n\n',
      "data: [DONE]\n\n",
    ];
    globalThis.fetch = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (const chunk of sse) controller.enqueue(new TextEncoder().encode(chunk));
            controller.close();
          },
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      )) as typeof fetch;

    const res = await handleManagedChat(c, SESSION);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Zintus-Served-By")).toBe("groq");
    const text = await res.text();
    expect(text).toBe(sse.join(""));
    expect(waited.length).toBe(1);
    await Promise.all(waited);
  });
});

// ── gift class (free models, PRICING-FINAL free tier) ──────────────────────

describe("gift-class models for non-members", () => {
  const GIFT_BODY = {
    model: "zintus/glm-4.7-flash",
    messages: [{ role: "user", content: "hi" }],
    stream: false,
  };

  /** Free-tier env (no sub) with a working KV for the daily-cap limiter. */
  function freeUserEnv(giftUsedToday = 0): Env {
    const kv = new Map<string, string>();
    if (giftUsedToday > 0) {
      // kvRateLimitOk stores a plain integer counter string.
      kv.set("rl:gift:u1", String(giftUsedToday));
    }
    const base = fakeEnv({ MANAGED_KEY_ZAI: "zk" });
    (base as { KV: unknown }).KV = {
      get: async (k: string) => kv.get(k) ?? null,
      put: async (k: string, v: string) => void kv.set(k, v),
      delete: async (k: string) => void kv.delete(k),
    };
    return base;
  }

  test("free-tier user chats a gift model with NO subscription", async () => {
    const { c, waited } = fakeContext(freeUserEnv(), GIFT_BODY);
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "hello" } }],
          usage: { prompt_tokens: 3, completion_tokens: 2 },
        }),
        { status: 200 },
      )) as typeof fetch;

    const res = await handleManagedChat(c, SESSION);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { zintus: { class: string; plan_tokens_debited: number } };
    expect(json.zintus.class).toBe("free");
    expect(json.zintus.plan_tokens_debited).toBe(0); // gift burn is 0
    await Promise.all(waited);
  });

  test("free-tier user over the daily cap → 429 gift_daily_cap", async () => {
    const { c } = fakeContext(freeUserEnv(200), GIFT_BODY);
    const res = await handleManagedChat(c, SESSION);
    expect(res.status).toBe(429);
    const json = (await res.json()) as { code: string };
    expect(json.code).toBe("gift_daily_cap");
  });

  test("free-tier user asking a MID model still gets the upgrade error", async () => {
    const { c } = fakeContext(freeUserEnv(), { ...GIFT_BODY, model: "zintus/gemini-2.5-flash" });
    const env = c.env as Env;
    (env as { MANAGED_KEY_GEMINI?: string }).MANAGED_KEY_GEMINI = "gk";
    const res = await handleManagedChat(c, SESSION);
    expect(res.status).toBe(403);
    const json = (await res.json()) as { code: string; min_tier: string };
    expect(json.code).toBe("model_requires_upgrade");
    expect(json.min_tier).toBe("starter");
  });
});

// ── managed web search (relay-side Tavily inject) ───────────────────────────

describe("managed chat web search", () => {
  const SEARCH_BODY = {
    model: "zintus/glm-4.7-flash",
    messages: [{ role: "user", content: "what is zintus.ai" }],
    stream: false,
    search: { enabled: true },
  };

  function searchWorld(withTavilyKey: boolean) {
    const kv = new Map<string, string>();
    const base = fakeEnv({
      MANAGED_KEY_ZAI: "zk",
      ...(withTavilyKey ? { TAVILY_API_KEY: "tvly_x" } : {}),
    } as Partial<Env>);
    (base as { KV: unknown }).KV = {
      get: async (k: string) => kv.get(k) ?? null,
      put: async (k: string, v: string) => void kv.set(k, v),
      delete: async (k: string) => void kv.delete(k),
    };
    return base;
  }

  test("search results are fetched and injected before the upstream call", async () => {
    const { c } = fakeContext(searchWorld(true), SEARCH_BODY);
    let upstreamMessages: Array<{ role: string; content: string }> = [];
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes("api.tavily.com")) {
        return new Response(
          JSON.stringify({
            results: [{ title: "Zintus", url: "https://zintus.ai", content: "AI router", score: 0.9 }],
          }),
          { status: 200 },
        );
      }
      upstreamMessages = (JSON.parse(String(init?.body)) as { messages: typeof upstreamMessages }).messages;
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
        { status: 200 },
      );
    }) as typeof fetch;

    const res = await handleManagedChat(c, SESSION);
    expect(res.status).toBe(200);
    const injected = upstreamMessages.find(
      (m) => m.role === "system" && String(m.content).includes("web_search_results"),
    );
    expect(injected).toBeDefined();
    expect(String(injected!.content)).toContain("zintus.ai");
  });

  test("no Tavily key → honest unavailable note instead of silent no-op", async () => {
    const { c } = fakeContext(searchWorld(false), SEARCH_BODY);
    let upstreamMessages: Array<{ role: string; content: string }> = [];
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      upstreamMessages = (JSON.parse(String(init?.body)) as { messages: typeof upstreamMessages }).messages;
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
        { status: 200 },
      );
    }) as typeof fetch;

    const res = await handleManagedChat(c, SESSION);
    expect(res.status).toBe(200);
    const note = upstreamMessages.find(
      (m) => m.role === "system" && String(m.content).includes("search is temporarily unavailable"),
    );
    expect(note).toBeDefined();
  });

  test("tavily outage → honest no-results note, chat still served", async () => {
    const { c } = fakeContext(searchWorld(true), SEARCH_BODY);
    let upstreamMessages: Array<{ role: string; content: string }> = [];
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes("api.tavily.com")) {
        return new Response("boom", { status: 500 });
      }
      upstreamMessages = (JSON.parse(String(init?.body)) as { messages: typeof upstreamMessages }).messages;
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
        { status: 200 },
      );
    }) as typeof fetch;

    const res = await handleManagedChat(c, SESSION);
    expect(res.status).toBe(200);
    const note = upstreamMessages.find(
      (m) => m.role === "system" && String(m.content).includes("returned no results"),
    );
    expect(note).toBeDefined();
  });
});
