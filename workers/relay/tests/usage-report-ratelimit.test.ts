import { describe, expect, test } from "bun:test";
import app from "../src/index.js";
import { issueSessionToken } from "../src/auth.js";
import { usageReportKey, USAGE_REPORT_LIMIT } from "../src/rate-limit.js";
import type { Env } from "../src/types.js";

// B-Lane fix 7: POST /api/usage/report (cookie auth, the BYOK self-report path)
// now carries a per-user KV rate limit. These drive the REAL Hono route so the
// wiring (not just the helper) is pinned: a fresh user reports fine; a user whose
// counter is already at the cap is 429'd before any usage is recorded.

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

/** D1 stub that records writes so we can assert "no usage recorded when 429". */
function fakeDb(writes: string[]) {
  return {
    prepare: (sql: string) => ({
      bind: () => ({
        first: async () => null,
        run: async () => {
          writes.push(sql);
          return {};
        },
        all: async () => ({ results: [] }),
      }),
    }),
  };
}

const fakeCounter = {
  idFromName: () => ({}),
  get: () => ({
    fetch: async () => new Response(JSON.stringify({ total: 0 })),
  }),
};

async function buildEnv() {
  const kv = fakeKV();
  const writes: string[] = [];
  const token = await issueSessionToken(kv as unknown as KVNamespace, {
    session_id: "s1",
    user_id: "u1",
    email: "u1@example.com",
  });
  const env = {
    KV: kv,
    DB: fakeDb(writes),
    QUOTA_COUNTER: fakeCounter,
  } as unknown as Env;
  return { env, kv, writes, cookie: `zintus_session=${token}` };
}

function report(env: Env, cookie: string) {
  return app.request(
    "http://relay.test/api/usage/report",
    {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "groq", model: "llama", input_tokens: 10, output_tokens: 5 }),
    },
    env,
  );
}

describe("/api/usage/report rate limit", () => {
  test("a fresh user can report (200)", async () => {
    const { env, cookie } = await buildEnv();
    const res = await report(env, cookie);
    expect(res.status).toBe(200);
  });

  test("a user already at the cap is 429'd and records NO usage", async () => {
    const { env, kv, writes, cookie } = await buildEnv();
    // Pre-seed the per-user counter at the limit (window not yet elapsed).
    kv.store.set(usageReportKey("u1"), String(USAGE_REPORT_LIMIT));
    const res = await report(env, cookie);
    expect(res.status).toBe(429);
    // The limiter short-circuits before recordUsage → no usage_log/subscription write.
    expect(writes.length).toBe(0);
  });

  test("still requires auth (401 without a cookie)", async () => {
    const { env } = await buildEnv();
    const res = await app.request(
      "http://relay.test/api/usage/report",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
      env,
    );
    expect(res.status).toBe(401);
  });
});
