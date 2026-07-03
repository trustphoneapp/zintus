import { describe, expect, test } from "bun:test";
import app from "../src/index.js";
import { isQuotaExemptControl } from "../src/index.js";
import { issueSessionToken } from "../src/auth.js";
import type { Env, SubscriptionRow } from "../src/types.js";

// B3 follow-up: the /control quota gate must NOT lock a paid user out of BYOK
// key management. set_key/remove_key consume no tokens (the home gateway
// dispatches on `action`), so they stay allowed even when the user is over cap;
// any token-consuming action is 429'd.

describe("isQuotaExemptControl — fail-closed allow-list", () => {
  test("exempts key-management actions only", () => {
    expect(isQuotaExemptControl(JSON.stringify({ action: "set_key" }))).toBe(true);
    expect(isQuotaExemptControl(JSON.stringify({ action: "remove_key" }))).toBe(true);
  });

  test("gates token-consuming / unknown / missing actions and malformed JSON", () => {
    expect(isQuotaExemptControl(JSON.stringify({ action: "chat" }))).toBe(false);
    expect(isQuotaExemptControl(JSON.stringify({ action: "run" }))).toBe(false);
    expect(isQuotaExemptControl(JSON.stringify({ value: {} }))).toBe(false); // no action
    expect(isQuotaExemptControl("{ not json")).toBe(false);
    expect(isQuotaExemptControl(JSON.stringify({ action: 123 }))).toBe(false); // non-string
  });
});

// ── Wired through the real Hono app ─────────────────────────────────────────

function fakeKV() {
  const store = new Map<string, string>();
  return {
    store,
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => {
      store.set(k, v);
    },
    delete: async (k: string) => {
      store.delete(k);
    },
  };
}

/** D1 stub: ownership row + an over-cap starter subscription. */
function fakeDb(sub: SubscriptionRow) {
  return {
    prepare: (sql: string) => ({
      bind: () => ({
        first: async () =>
          sql.includes("subscriptions")
            ? sub
            : sql.includes("gateway_sessions")
              ? { user_id: "u1" }
              : null,
        run: async () => ({}),
        all: async () => ({ results: [] }),
      }),
    }),
  };
}

/** QUOTA_COUNTER stub: enforceQuota only reads via /get → return a fixed total. */
function fakeCounter(total: number) {
  return {
    idFromName: () => ({}),
    get: () => ({
      fetch: async () => new Response(JSON.stringify({ total })),
    }),
  };
}

/** GATEWAY_SESSION stub: a forwarded (allowed) control returns this sentinel. */
const fakeGateway = {
  idFromName: () => ({}),
  get: () => ({
    fetch: async () => new Response(JSON.stringify({ forwarded: true }), { status: 200 }),
  }),
};

const starterSub: SubscriptionRow = {
  user_id: "u1",
  tier: "starter",
  status: "active",
  tokens_used_this_period: 1_100_000,
} as unknown as SubscriptionRow;

async function buildEnvWithCookie() {
  const kv = fakeKV();
  const token = await issueSessionToken(kv as unknown as KVNamespace, {
    session_id: "s1",
    user_id: "u1",
    email: "u1@example.com",
  });
  const env = {
    KV: kv,
    DB: fakeDb(starterSub),
    QUOTA_COUNTER: fakeCounter(1_100_000), // starter cap is 1M → over budget
    GATEWAY_SESSION: fakeGateway,
  } as unknown as Env;
  return { env, cookie: `zintus_session=${token}` };
}

function control(action: string, value: unknown = {}) {
  return JSON.stringify({ action, value });
}

describe("/control quota gate (over-budget starter user)", () => {
  test("429s a token-consuming control action", async () => {
    const { env, cookie } = await buildEnvWithCookie();
    const res = await app.request(
      "http://relay.test/api/sessions/sess1/control",
      {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: control("chat", { prompt: "hi" }),
      },
      env,
    );
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("quota_exceeded");
    expect(res.headers.get("Retry-After")).toBeTruthy();
  });

  test("ALLOWS set_key even while over budget (no key-management lockout)", async () => {
    const { env, cookie } = await buildEnvWithCookie();
    const res = await app.request(
      "http://relay.test/api/sessions/sess1/control",
      {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: control("set_key", { provider: "groq", encryptedKey: "opaque" }),
      },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ forwarded: true });
  });

  test("ALLOWS remove_key even while over budget", async () => {
    const { env, cookie } = await buildEnvWithCookie();
    const res = await app.request(
      "http://relay.test/api/sessions/sess1/control",
      {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: control("remove_key", { provider: "groq" }),
      },
      env,
    );
    expect(res.status).toBe(200);
  });
});
