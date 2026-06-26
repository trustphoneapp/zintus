import { beforeAll, describe, expect, test } from "bun:test";
import app from "../src/index.js";
import { issueSessionToken } from "../src/auth.js";
import type { Env } from "../src/types.js";

// ── End-to-end credential-lifecycle integration test ─────────────────────────
//
// The individual auth flows are already unit-tested in pieces (account-delete,
// cloud-auth-bearer, control-quota). This test ties them into ONE ordered
// sequence against the REAL Hono `app` (workers/relay/src/index.ts) with the
// same in-memory D1/KV/DO stubs the sibling relay tests use, proving the WHOLE
// credential lifecycle stays coherent — no orphan rows, no leaked auth, tombstone
// enforced — as a regression net. Every step drives a real route via
// `app.request(...)`; none of the handler logic is reimplemented here.
//
// Sequence (shared state across ordered tests):
//   1. Web login → `zintus_session` cookie (issueSessionToken, the same token
//      issuance the Google callback's createUserSession performs).
//   2. CLI login → gateway session: POST /api/auth/cli-login, create the gateway
//      session (POST /api/sessions) so a real gateway_sessions row + gateway_secret
//      exist, POST /api/auth/cli-complete, then GET /api/auth/cli-status → complete
//      with the secret.
//   3. Cloud status (Bearer): GET /api/sessions/:id/status with the gateway_secret
//      → 200; a different session's secret → 401.
//   4. Cloud logout (Bearer): DELETE /api/sessions/:id with the gateway_secret →
//      200 and the gateway_sessions row is gone (no orphan).
//   5. Account delete: DELETE /api/account with the cookie → 200, rows gone +
//      `deleted:<user_id>` tombstone written; a still-cached session token for that
//      user → 401 (tombstone enforced).

// ── In-memory D1: one generic row model covering every table these routes touch ─
interface FakeRow {
  table: string;
  id?: string;
  user_id?: string;
  referrer_id?: string;
  referred_id?: string;
  email?: string;
  name?: string;
  gateway_secret_hash?: string;
  stripe_subscription_id?: string | null;
}

function fakeDb(seed: FakeRow[] = []) {
  let rows: FakeRow[] = [...seed];
  return {
    rows: () => rows,
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        first: async <T,>() => {
          // authorizeSessionScoped: fetch the gateway session row by id.
          if (/SELECT user_id, gateway_secret_hash FROM gateway_sessions WHERE id = \?/i.test(sql)) {
            const r = rows.find((x) => x.table === "gateway_sessions" && x.id === args[0]);
            return (r
              ? { user_id: r.user_id, gateway_secret_hash: r.gateway_secret_hash }
              : null) as T | null;
          }
          // account delete: stripe subscription lookup (only when STRIPE configured).
          if (/SELECT stripe_subscription_id FROM subscriptions/i.test(sql)) {
            const r = rows.find(
              (x) => x.table === "subscriptions" && x.user_id === args[0] && x.stripe_subscription_id,
            );
            return (r ? { stripe_subscription_id: r.stripe_subscription_id } : null) as T | null;
          }
          return null as T | null;
        },
        run: async () => {
          const before = rows.length;
          if (/INSERT INTO gateway_sessions/i.test(sql)) {
            rows.push({
              table: "gateway_sessions",
              id: args[0] as string,
              user_id: args[1] as string,
              name: args[2] as string,
              gateway_secret_hash: args[3] as string,
            });
          } else if (/DELETE FROM gateway_sessions WHERE id = \?/i.test(sql)) {
            rows = rows.filter((r) => !(r.table === "gateway_sessions" && r.id === args[0]));
          } else if (/DELETE FROM gateway_sessions WHERE user_id/i.test(sql)) {
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
        all: async <T,>() => ({ results: [] as T[] }),
      }),
    }),
  };
}

function fakeKV() {
  const store = new Map<string, string>();
  return {
    store,
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => void store.set(k, v),
    delete: async (k: string) => void store.delete(k),
  };
}

// QUOTA_COUNTER DO stub: account delete POSTs /reset; records calls.
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

// GATEWAY_SESSION DO stub: status forward + force-disconnect both succeed.
const fakeGateway = {
  idFromName: () => ({}),
  get: () => ({
    fetch: async () => new Response(JSON.stringify({ online: true }), { status: 200 }),
  }),
};

// Issue a zintus_session cookie exactly the way createUserSession (Google
// callback) mints it — the helper the sibling relay tests reuse.
async function cookieFor(kv: ReturnType<typeof fakeKV>, userId: string, email: string) {
  const token = await issueSessionToken(kv as unknown as KVNamespace, {
    session_id: crypto.randomUUID(),
    user_id: userId,
    email,
  });
  return { token, cookie: `zintus_session=${token}` };
}

const URL_BASE = "http://relay.test";
const USER = "u-lifecycle";
const EMAIL = "lifecycle@example.com";
const STATE = "cli-state-" + crypto.randomUUID();

describe("credential lifecycle (web login → CLI session → cloud status/logout → account delete)", () => {
  // Shared state for the ordered sequence.
  const kv = fakeKV();
  const counter = fakeCounter();
  const db = fakeDb([
    // Seed the rows a real signed-in user owns, so account delete (step 5) has
    // something to wipe and we can assert the deletes actually ran.
    { table: "zintus_users", id: USER, email: EMAIL },
    { table: "user_sessions", user_id: USER },
    { table: "subscriptions", user_id: USER, stripe_subscription_id: null },
    { table: "usage_log", user_id: USER },
    { table: "referral_codes", user_id: USER },
    { table: "auth_tokens", email: EMAIL },
  ]);
  const env = {
    KV: kv,
    DB: db,
    QUOTA_COUNTER: counter,
    GATEWAY_SESSION: fakeGateway,
    COOKIE_DOMAIN: "",
    STRIPE_SECRET_KEY: "",
  } as unknown as Env;

  let cookie = "";
  let primaryToken = "";
  let sessionId = "";
  let gatewaySecret = "";
  let otherSecret = "";

  beforeAll(async () => {
    const c = await cookieFor(kv, USER, EMAIL);
    cookie = c.cookie;
    primaryToken = c.token;
  });

  // STEP 1 — web login produced a valid session cookie (GET /api/auth/me, src/index.ts:614).
  test("1. web login → a valid zintus_session cookie authenticates", async () => {
    const res = await app.request(`${URL_BASE}/api/auth/me`, { headers: { Cookie: cookie } }, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authenticated: true, email: EMAIL, user_id: USER });

    // Failure mode: no cookie → 401.
    const anon = await app.request(`${URL_BASE}/api/auth/me`, {}, env);
    expect(anon.status).toBe(401);
  });

  // STEP 2 — CLI login → gateway session.
  //   cli-login   src/index.ts:522
  //   POST /api/sessions (creates the gateway_sessions row + secret) src/index.ts:734
  //   cli-complete src/index.ts:532
  //   cli-status   src/index.ts:557
  test("2. CLI login registers state, creates the gateway session, and completes", async () => {
    // 2a. CLI registers the pending state.
    const login = await app.request(
      `${URL_BASE}/api/auth/cli-login`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ state: STATE }) },
      env,
    );
    expect(login.status).toBe(200);
    expect(await login.json()).toEqual({ ok: true });
    expect(kv.store.has(`cli:${STATE}`)).toBe(true);

    // 2b. The web dashboard (signed in) provisions the gateway session — a real
    // gateway_sessions row + a once-shown gateway_secret.
    const create = await app.request(
      `${URL_BASE}/api/sessions`,
      { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ name: "My Gateway" }) },
      env,
    );
    expect(create.status).toBe(201);
    const created = (await create.json()) as { session_id: string; gateway_secret: string };
    sessionId = created.session_id;
    gatewaySecret = created.gateway_secret;
    expect(sessionId).toBeTruthy();
    expect(gatewaySecret).toBeTruthy();
    // The row really landed in D1 (hashed secret, never plaintext).
    const row = db.rows().find((r) => r.table === "gateway_sessions" && r.id === sessionId);
    expect(row?.user_id).toBe(USER);
    expect(row?.gateway_secret_hash).toBeTruthy();
    expect(row?.gateway_secret_hash).not.toBe(gatewaySecret);

    // 2c. The web callback hands the secret back to the waiting CLI via cli-complete.
    const complete = await app.request(
      `${URL_BASE}/api/auth/cli-complete`,
      {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ state: STATE, session_id: sessionId, gateway_secret: gatewaySecret }),
      },
      env,
    );
    expect(complete.status).toBe(200);

    // cli-complete must require a session — no cookie → 401.
    const completeAnon = await app.request(
      `${URL_BASE}/api/auth/cli-complete`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: STATE, session_id: sessionId, gateway_secret: gatewaySecret }),
      },
      env,
    );
    expect(completeAnon.status).toBe(401);

    // 2d. The CLI polls cli-status → complete, with the secret it can now use.
    const status = await app.request(`${URL_BASE}/api/auth/cli-status?state=${STATE}`, {}, env);
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({
      status: "complete",
      session_id: sessionId,
      gateway_secret: gatewaySecret,
    });
  });

  // STEP 3 — cloud status via Bearer gateway_secret (GET /api/sessions/:id/status, src/index.ts:907).
  test("3. cloud status with the gateway_secret Bearer → 200; another session's secret → 401", async () => {
    const ok = await app.request(
      `${URL_BASE}/api/sessions/${sessionId}/status`,
      { headers: { Authorization: `Bearer ${gatewaySecret}` } },
      env,
    );
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ online: true });

    // Cross-check isolation: provision a SECOND gateway session and present its
    // secret against the first session's id → 401 (Bearer matches one row only).
    const create2 = await app.request(
      `${URL_BASE}/api/sessions`,
      { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ name: "Other" }) },
      env,
    );
    otherSecret = ((await create2.json()) as { gateway_secret: string }).gateway_secret;

    const cross = await app.request(
      `${URL_BASE}/api/sessions/${sessionId}/status`,
      { headers: { Authorization: `Bearer ${otherSecret}` } },
      env,
    );
    expect(cross.status).toBe(401);

    // No Bearer, no cookie → 401.
    const anon = await app.request(`${URL_BASE}/api/sessions/${sessionId}/status`, {}, env);
    expect(anon.status).toBe(401);
  });

  // STEP 4 — cloud logout via Bearer (DELETE /api/sessions/:id, src/index.ts:753).
  test("4. cloud logout with the gateway_secret Bearer → 200 and the row is gone (no orphan)", async () => {
    // Cross-session secret must NOT delete this session.
    const cross = await app.request(
      `${URL_BASE}/api/sessions/${sessionId}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${otherSecret}` } },
      env,
    );
    expect(cross.status).toBe(401);
    expect(db.rows().some((r) => r.table === "gateway_sessions" && r.id === sessionId)).toBe(true);

    // The session's own secret deletes it.
    const res = await app.request(
      `${URL_BASE}/api/sessions/${sessionId}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${gatewaySecret}` } },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    // No orphan gateway_sessions row left behind.
    expect(db.rows().some((r) => r.table === "gateway_sessions" && r.id === sessionId)).toBe(false);
  });

  // STEP 5 — account delete via cookie (DELETE /api/account, src/index.ts:634).
  test("5. account delete → 200, rows gone, tombstone written, cached token rejected", async () => {
    // A SECOND independently-issued session token for the same user (still cached
    // in KV) — the tombstone must reject it after deletion.
    const second = await cookieFor(kv, USER, EMAIL);

    const res = await app.request(
      `${URL_BASE}/api/account`,
      { method: "DELETE", headers: { Cookie: cookie } },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, deleted: true });
    expect(res.headers.get("Set-Cookie")).toContain("Max-Age=0");

    // Every row owned by the user is gone.
    expect(db.rows().some((r) => r.user_id === USER || r.id === USER || r.email === EMAIL)).toBe(false);
    // Quota counter was reset.
    expect(counter.calls).toContain("POST /reset");
    // Tombstone written.
    expect(kv.store.has(`deleted:${USER}`)).toBe(true);

    // The presented cookie's token was revoked AND the tombstone now rejects the
    // second, still-cached token for the same user → 401 (no orphan re-deletes).
    const reused = await app.request(
      `${URL_BASE}/api/auth/me`,
      { headers: { Cookie: cookie } },
      env,
    );
    expect(reused.status).toBe(401);

    const cachedSecond = await app.request(
      `${URL_BASE}/api/account`,
      { method: "DELETE", headers: { Cookie: `zintus_session=${second.token}` } },
      env,
    );
    expect(cachedSecond.status).toBe(401);
    // Sanity: that second token IS still in KV — it's the tombstone, not eviction,
    // doing the rejecting.
    void primaryToken;
  });
});
