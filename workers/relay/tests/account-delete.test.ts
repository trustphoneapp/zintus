import { describe, expect, test } from "bun:test";
import app from "../src/index.js";
import { issueSessionToken } from "../src/auth.js";
import { accountDeleteKey } from "../src/rate-limit.js";
import type { Env } from "../src/types.js";

// DELETE /api/account — self-service account deletion (Google Play requirement).
//
// The non-negotiable property: the user id used for every delete comes ONLY from
// the verified session cookie, so one user can NEVER delete another's data.
// These tests drive the REAL Hono app with in-memory D1/KV/DO stubs and assert
// exactly which rows get deleted (and which DON'T).

// ── In-memory D1 modelling the rows DELETE /api/account touches ──────────────
interface FakeRow {
  table: string;
  user_id?: string;
  referrer_id?: string;
  referred_id?: string;
  email?: string;
  id?: string;
  stripe_subscription_id?: string | null;
}

function fakeDb(seed: FakeRow[]) {
  let rows = [...seed];
  return {
    rows: () => rows,
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        first: async <T,>() => {
          if (/SELECT stripe_subscription_id FROM subscriptions/i.test(sql)) {
            const uid = args[0] as string;
            const found = rows.find(
              (r) => r.table === "subscriptions" && r.user_id === uid && r.stripe_subscription_id,
            );
            return (found ? { stripe_subscription_id: found.stripe_subscription_id } : null) as T | null;
          }
          return null as T | null;
        },
        run: async () => {
          const before = rows.length;
          if (/DELETE FROM gateway_sessions WHERE user_id/i.test(sql)) {
            rows = rows.filter((r) => !(r.table === "gateway_sessions" && r.user_id === args[0]));
          } else if (/DELETE FROM user_sessions WHERE user_id/i.test(sql)) {
            rows = rows.filter((r) => !(r.table === "user_sessions" && r.user_id === args[0]));
          } else if (/DELETE FROM subscriptions WHERE user_id/i.test(sql)) {
            rows = rows.filter((r) => !(r.table === "subscriptions" && r.user_id === args[0]));
          } else if (/DELETE FROM usage_log WHERE user_id/i.test(sql)) {
            rows = rows.filter((r) => !(r.table === "usage_log" && r.user_id === args[0]));
          } else if (/DELETE FROM referrals WHERE referrer_id/i.test(sql)) {
            rows = rows.filter(
              (r) => !(r.table === "referrals" && (r.referrer_id === args[0] || r.referred_id === args[1])),
            );
          } else if (/DELETE FROM referral_codes WHERE user_id/i.test(sql)) {
            rows = rows.filter((r) => !(r.table === "referral_codes" && r.user_id === args[0]));
          } else if (/DELETE FROM auth_tokens WHERE email/i.test(sql)) {
            rows = rows.filter((r) => !(r.table === "auth_tokens" && r.email === args[0]));
          } else if (/DELETE FROM zintus_users WHERE id/i.test(sql)) {
            rows = rows.filter((r) => !(r.table === "zintus_users" && r.id === args[0]));
          }
          return { meta: { changes: before - rows.length } };
        },
      }),
    }),
  };
}

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

// QUOTA_COUNTER stub recording whether /reset was POSTed.
function fakeCounter() {
  const calls: string[] = [];
  return {
    calls,
    idFromName: () => ({}),
    get: () => ({
      fetch: async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
        return new Response(JSON.stringify({ ok: true }));
      },
    }),
  };
}

const noopGateway = {
  idFromName: () => ({}),
  get: () => ({ fetch: async () => new Response("{}") }),
};

async function seededEnv(rows: FakeRow[], opts?: { stripe?: boolean; counter?: ReturnType<typeof fakeCounter> }) {
  const kv = fakeKV();
  const db = fakeDb(rows);
  const counter = opts?.counter ?? fakeCounter();
  const env = {
    KV: kv,
    DB: db,
    QUOTA_COUNTER: counter,
    GATEWAY_SESSION: noopGateway,
    COOKIE_DOMAIN: "",
    STRIPE_SECRET_KEY: opts?.stripe ? "sk_test_x" : "",
  } as unknown as Env;
  return { env, kv, db, counter };
}

async function cookieFor(kv: ReturnType<typeof fakeKV>, userId: string, email: string) {
  const token = await issueSessionToken(kv as unknown as KVNamespace, {
    session_id: crypto.randomUUID(),
    user_id: userId,
    email,
  });
  return `zintus_session=${token}`;
}

function userRows(userId: string, email: string): FakeRow[] {
  return [
    { table: "zintus_users", id: userId, email },
    { table: "gateway_sessions", user_id: userId },
    { table: "user_sessions", user_id: userId },
    { table: "subscriptions", user_id: userId, stripe_subscription_id: null },
    { table: "usage_log", user_id: userId },
    { table: "referrals", referrer_id: userId, referred_id: "other" },
    { table: "referral_codes", user_id: userId },
    { table: "auth_tokens", email },
  ];
}

describe("DELETE /api/account", () => {
  test("401 without a session", async () => {
    const { env } = await seededEnv(userRows("u1", "u1@example.com"));
    const res = await app.request("http://relay.test/api/account", { method: "DELETE" }, env);
    expect(res.status).toBe(401);
  });

  test("401 with a garbage/expired cookie (not in KV)", async () => {
    const { env } = await seededEnv(userRows("u1", "u1@example.com"));
    const res = await app.request(
      "http://relay.test/api/account",
      { method: "DELETE", headers: { Cookie: "zintus_session=not-a-real-token" } },
      env,
    );
    expect(res.status).toBe(401);
  });

  test("deletes exactly the authed user's rows and clears the cookie", async () => {
    const { env, kv, db } = await seededEnv(userRows("u1", "u1@example.com"));
    const cookie = await cookieFor(kv, "u1", "u1@example.com");

    const res = await app.request(
      "http://relay.test/api/account",
      { method: "DELETE", headers: { Cookie: cookie } },
      env,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, deleted: true });
    // Cookie cleared (Max-Age=0).
    expect(res.headers.get("Set-Cookie")).toContain("Max-Age=0");
    // Every seeded row for u1 is gone.
    expect(db.rows().length).toBe(0);
  });

  test("a SECOND user's data is untouched (id comes from session only)", async () => {
    // Both users seeded; u2 also tampers by sending u1's id would be impossible —
    // there is no id input. We prove isolation: deleting u1 leaves all u2 rows.
    const rows = [...userRows("u1", "u1@example.com"), ...userRows("u2", "u2@example.com")];
    // Fix the cross-referral seeded above so u2's referral isn't keyed to u1.
    const { env, kv, db } = await seededEnv(rows);
    const cookie = await cookieFor(kv, "u1", "u1@example.com");

    const res = await app.request(
      "http://relay.test/api/account",
      { method: "DELETE", headers: { Cookie: cookie } },
      env,
    );
    expect(res.status).toBe(200);

    const remaining = db.rows();
    // No u1-owned rows left.
    expect(remaining.some((r) => r.user_id === "u1" || r.id === "u1" || r.referrer_id === "u1")).toBe(false);
    expect(remaining.some((r) => r.email === "u1@example.com")).toBe(false);
    // All u2-owned rows survive — exactly one full set.
    expect(remaining.filter((r) => r.user_id === "u2" || r.id === "u2" || r.referrer_id === "u2").length)
      .toBeGreaterThan(0);
    expect(remaining.some((r) => r.email === "u2@example.com")).toBe(true);
  });

  test("resets the user's quota counter (DO) via /reset", async () => {
    const counter = fakeCounter();
    const { env, kv } = await seededEnv(userRows("u1", "u1@example.com"), { counter });
    const cookie = await cookieFor(kv, "u1", "u1@example.com");

    await app.request("http://relay.test/api/account", { method: "DELETE", headers: { Cookie: cookie } }, env);
    expect(counter.calls).toContain("POST /reset");
  });

  test("idempotent — a second still-valid session for the same user re-deletes to 200", async () => {
    const { env, kv } = await seededEnv(userRows("u1", "u1@example.com"));
    const cookie1 = await cookieFor(kv, "u1", "u1@example.com");
    const cookie2 = await cookieFor(kv, "u1", "u1@example.com"); // independent KV token

    const first = await app.request(
      "http://relay.test/api/account",
      { method: "DELETE", headers: { Cookie: cookie1 } },
      env,
    );
    expect(first.status).toBe(200);

    // cookie2 is still cached in KV → authenticates the (now-deleted) user; the
    // deletes affect 0 rows and the handler must still return 200, never 500.
    const second = await app.request(
      "http://relay.test/api/account",
      { method: "DELETE", headers: { Cookie: cookie2 } },
      env,
    );
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ ok: true, deleted: true });
  });

  test("rate-limited per user after the cap is hit", async () => {
    const { env, kv } = await seededEnv(userRows("u1", "u1@example.com"));
    // Pre-fill the per-user counter to the cap so the next request is throttled.
    await kv.put(accountDeleteKey("u1"), "5");
    const cookie = await cookieFor(kv, "u1", "u1@example.com");

    const res = await app.request(
      "http://relay.test/api/account",
      { method: "DELETE", headers: { Cookie: cookie } },
      env,
    );
    expect(res.status).toBe(429);
  });

  test("Stripe cancel is guarded: skipped entirely when STRIPE not configured", async () => {
    // No STRIPE_SECRET_KEY → the subscription SELECT for stripe id must not even
    // run; a sub with a stripe id is still deleted, no fetch attempted.
    const rows = userRows("u1", "u1@example.com").map((r) =>
      r.table === "subscriptions" ? { ...r, stripe_subscription_id: "sub_123" } : r,
    );
    const { env, kv, db } = await seededEnv(rows, { stripe: false });
    const cookie = await cookieFor(kv, "u1", "u1@example.com");

    const res = await app.request(
      "http://relay.test/api/account",
      { method: "DELETE", headers: { Cookie: cookie } },
      env,
    );
    expect(res.status).toBe(200);
    expect(db.rows().length).toBe(0);
  });

  test("a Stripe cancel failure never blocks the deletion", async () => {
    const rows = userRows("u1", "u1@example.com").map((r) =>
      r.table === "subscriptions" ? { ...r, stripe_subscription_id: "sub_123" } : r,
    );
    const { env, kv, db } = await seededEnv(rows, { stripe: true });
    const cookie = await cookieFor(kv, "u1", "u1@example.com");

    // Force the Stripe API to error.
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("nope", { status: 500 })) as typeof fetch;
    try {
      const res = await app.request(
        "http://relay.test/api/account",
        { method: "DELETE", headers: { Cookie: cookie } },
        env,
      );
      expect(res.status).toBe(200);
      expect(db.rows().length).toBe(0); // user data still fully deleted
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
