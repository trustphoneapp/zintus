import { afterEach, describe, expect, test } from "bun:test";
import {
  availableImageServices,
  handleManagedServices,
  handleManagedImage,
  handleManagedTranscribe,
} from "../src/services.js";
import { billingPeriod } from "../src/middleware/quota.js";
import { FLAT_FEES_CREDITS } from "../src/tiers.js";
import type { Env } from "../src/types.js";
import type { SessionPayload } from "../src/auth.js";
import type { Context } from "hono";

// Flat-fee managed services (PRICING-FINAL Part 4): membership/balance gates,
// debit-on-success-only, per-tier plan-token receipts, honest availability.

const SESSION: SessionPayload = { session_id: "s1", user_id: "u1", email: "u@x.dev" };

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function fakeWorld(
  tier: string,
  keys: Partial<Env> = {},
  opts: { quotaMc?: number; status?: string; body?: unknown; form?: FormData } = {},
) {
  const world = { quotaMc: opts.quotaMc ?? 0, debits: [] as Array<{ service: string; mc: number }> };

  const prepare = (sql: string) => ({
    bind: (...args: unknown[]) => ({
      first: async () =>
        sql.includes("FROM subscriptions")
          ? { user_id: "u1", tier, status: opts.status ?? "active", tokens_used_this_period: 0 }
          : null,
      run: async () => {
        if (sql.includes("INSERT INTO usage_log")) {
          world.debits.push({ service: String(args[2]), mc: -1 });
        }
        return {};
      },
      all: async () => ({ results: [] }),
    }),
  });

  const env = {
    DB: { prepare } as unknown as Env["DB"],
    QUOTA_COUNTER: {
      idFromName: () => "id",
      get: () => ({
        fetch: async (url: string, init?: RequestInit) => {
          if (String(url).endsWith("/add") && init?.method === "POST") {
            world.quotaMc += Number(init.body);
          }
          return new Response(JSON.stringify({ total: world.quotaMc }));
        },
      }),
    } as unknown as Env["QUOTA_COUNTER"],
    ...keys,
  } as unknown as Env;

  const waited: Promise<unknown>[] = [];
  const c = {
    env,
    req: {
      json: async () => opts.body ?? {},
      formData: async () => {
        if (!opts.form) throw new Error("no form");
        return opts.form;
      },
    },
    json: (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } }),
    executionCtx: { waitUntil: (p: Promise<unknown>) => waited.push(p) },
  } as unknown as Context<{ Bindings: Env }>;

  return { env, c, world, waited };
}

describe("availableImageServices / services listing", () => {
  test("no keys → nothing listed (never vaporware)", () => {
    const { env, c } = fakeWorld("pro");
    expect(availableImageServices(env)).toEqual([]);
    // Services listing is public and reflects configured keys only.
    void c;
  });

  test("together key lists flux; groq key lists stt; fees in plan tokens per tier", async () => {
    const { c } = fakeWorld("pro", { MANAGED_KEY_TOGETHER: "tk", MANAGED_KEY_GROQ: "gk" });
    const res = handleManagedServices(c);
    const json = (await res.json()) as { services: Array<Record<string, unknown>> };
    const ids = json.services.map((s) => s["id"]);
    expect(ids).toContain("flux-schnell");
    expect(ids).toContain("whisper-turbo");
    expect(ids).not.toContain("gpt-image"); // no OpenAI key
    const flux = json.services.find((s) => s["id"] === "flux-schnell")!;
    // 12 cr → per-tier display: starter 800, pro 3,429, max 10,000, ultra 20,000.
    expect(flux["plan_tokens"]).toEqual({ starter: 800, pro: 3429, max: 10000, ultra: 20000 });
  });
});

describe("handleManagedImage", () => {
  test("success debits the flat fee and reports the tier debit", async () => {
    const { c, world, waited } = fakeWorld(
      "pro",
      { MANAGED_KEY_TOGETHER: "tk" },
      { body: { service: "flux-schnell", prompt: "a red fox" } },
    );
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [{ b64_json: "aGk=" }] }), { status: 200 })) as typeof fetch;

    const res = await handleManagedImage(c, SESSION);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { image: { b64?: string }; zintus: { plan_tokens_debited: number } };
    expect(json.image.b64).toBe("aGk=");
    // 12 cr on Pro → 12,000 mc × 10M/35M = 3,429 plan tokens.
    expect(json.zintus.plan_tokens_debited).toBe(3429);
    await Promise.all(waited);
    expect(world.quotaMc).toBe(FLAT_FEES_CREDITS.image_flux * 1000);
  });

  test("upstream failure → 502 and NO debit", async () => {
    const { c, world, waited } = fakeWorld(
      "pro",
      { MANAGED_KEY_TOGETHER: "tk" },
      { body: { prompt: "x" } },
    );
    globalThis.fetch = (async () => new Response("boom", { status: 500 })) as typeof fetch;

    const res = await handleManagedImage(c, SESSION);
    expect(res.status).toBe(502);
    await Promise.all(waited);
    expect(world.quotaMc).toBe(0);
  });

  test("no membership → 403; exhausted balance → 429; unknown service → 404", async () => {
    const noSub = fakeWorld("free", { MANAGED_KEY_TOGETHER: "tk" }, { status: "canceled", body: { prompt: "x" } });
    expect((await handleManagedImage(noSub.c, SESSION)).status).toBe(403);

    const broke = fakeWorld("starter", { MANAGED_KEY_TOGETHER: "tk" }, { quotaMc: 15_000_000, body: { prompt: "x" } });
    expect((await handleManagedImage(broke.c, SESSION)).status).toBe(429);

    const unknown = fakeWorld("pro", { MANAGED_KEY_TOGETHER: "tk" }, { body: { service: "dall-e-9", prompt: "x" } });
    expect((await handleManagedImage(unknown.c, SESSION)).status).toBe(404);
  });

  test("unconfigured service key → 404, prompt required → 400", async () => {
    const noKey = fakeWorld("pro", {}, { body: { prompt: "x" } });
    expect((await handleManagedImage(noKey.c, SESSION)).status).toBe(404);

    const noPrompt = fakeWorld("pro", { MANAGED_KEY_TOGETHER: "tk" }, { body: {} });
    expect((await handleManagedImage(noPrompt.c, SESSION)).status).toBe(400);
  });
});

describe("handleManagedTranscribe", () => {
  function audioForm(bytes = 1000): FormData {
    const f = new FormData();
    f.set("file", new File([new Uint8Array(bytes)], "a.m4a", { type: "audio/mp4" }));
    return f;
  }

  test("bills one window minimum, scales by duration, reports tier debit", async () => {
    const { c, world, waited } = fakeWorld("pro", { MANAGED_KEY_GROQ: "gk" }, { form: audioForm() });
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ text: "hello world", duration: 1230 }), { status: 200 })) as typeof fetch;

    const res = await handleManagedTranscribe(c, SESSION);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { text: string; zintus: { plan_tokens_debited: number } };
    expect(json.text).toBe("hello world");
    // 1,230s = 3 started 10-min windows → 9 cr → 9,000 mc × 10M/35M = 2,571.
    expect(json.zintus.plan_tokens_debited).toBe(2571);
    await Promise.all(waited);
    expect(world.quotaMc).toBe(9_000);
  });

  test("upstream failure → 502 and NO debit; oversize file → 413", async () => {
    const fail = fakeWorld("pro", { MANAGED_KEY_GROQ: "gk" }, { form: audioForm() });
    globalThis.fetch = (async () => new Response("no", { status: 500 })) as typeof fetch;
    expect((await handleManagedTranscribe(fail.c, SESSION)).status).toBe(502);
    await Promise.all(fail.waited);
    expect(fail.world.quotaMc).toBe(0);

    const big = fakeWorld("pro", { MANAGED_KEY_GROQ: "gk" }, { form: audioForm(26 * 1024 * 1024) });
    expect((await handleManagedTranscribe(big.c, SESSION)).status).toBe(413);
  });

  test("no groq key → 404 service_unavailable", async () => {
    const { c } = fakeWorld("pro", {}, { form: audioForm() });
    expect((await handleManagedTranscribe(c, SESSION)).status).toBe(404);
  });
});
