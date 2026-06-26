import { describe, expect, test } from "bun:test";
import app from "../src/index.js";
import { issueSessionToken, sha256Hex } from "../src/auth.js";
import type { Env } from "../src/types.js";

// The CLI authenticates `zintus cloud status` / `logout` with
//   Authorization: Bearer <gateway_secret>
// (it holds the secret but has no browser cookie). GET /api/sessions/:id/status
// and DELETE /api/sessions/:id must accept that Bearer — but ONLY when it matches
// the gateway_secret of THAT specific session id. A secret for session B must
// never authorize session A. Cookie auth must keep working unchanged.

interface GwRow {
  user_id: string;
  gateway_secret_hash: string;
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

/** D1 stub backed by a Map of gateway_sessions keyed by id; records deletes. */
function fakeDb(sessions: Map<string, GwRow>) {
  const deleted: string[] = [];
  return {
    deleted,
    sessions,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            first: async () =>
              sql.includes("FROM gateway_sessions")
                ? (sessions.get(args[0] as string) ?? null)
                : null,
            run: async () => {
              if (sql.startsWith("DELETE FROM gateway_sessions")) {
                const id = args[0] as string;
                sessions.delete(id);
                deleted.push(id);
              }
              return {};
            },
            all: async () => ({ results: [] }),
          };
        },
      };
    },
  };
}

/** GATEWAY_SESSION DO stub: status forward + force-disconnect both succeed. */
const fakeGateway = {
  idFromName: () => ({}),
  get: () => ({
    fetch: async () =>
      new Response(JSON.stringify({ online: true }), { status: 200 }),
  }),
};

const SECRET_A = "secretA-" + crypto.randomUUID();
const SECRET_B = "secretB-" + crypto.randomUUID();

/** Build an env whose DB knows session "A" (owner u1) and "B" (owner u2). */
async function buildEnv() {
  const sessions = new Map<string, GwRow>();
  sessions.set("A", { user_id: "u1", gateway_secret_hash: await sha256Hex(SECRET_A) });
  sessions.set("B", { user_id: "u2", gateway_secret_hash: await sha256Hex(SECRET_B) });
  const db = fakeDb(sessions);
  const kv = fakeKV();
  const env = {
    KV: kv,
    DB: db,
    GATEWAY_SESSION: fakeGateway,
  } as unknown as Env;
  return { env, db, kv };
}

async function cookieFor(kv: ReturnType<typeof fakeKV>, user_id: string) {
  const token = await issueSessionToken(kv as unknown as KVNamespace, {
    session_id: "us-" + user_id,
    user_id,
    email: `${user_id}@example.com`,
  });
  return `zintus_session=${token}`;
}

describe("GET /api/sessions/:id/status — Bearer gateway_secret", () => {
  test("correct secret for the session → 200", async () => {
    const { env } = await buildEnv();
    const res = await app.request(
      "http://relay.test/api/sessions/A/status",
      { headers: { Authorization: `Bearer ${SECRET_A}` } },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ online: true });
  });

  test("ISOLATION: session B's secret against session A's id → 401", async () => {
    const { env } = await buildEnv();
    const res = await app.request(
      "http://relay.test/api/sessions/A/status",
      { headers: { Authorization: `Bearer ${SECRET_B}` } },
      env,
    );
    expect(res.status).toBe(401);
  });

  test("garbage / blank / missing Bearer and no cookie → 401", async () => {
    const { env } = await buildEnv();
    for (const headers of [
      { Authorization: "Bearer total-garbage" },
      { Authorization: "Bearer " },
      {},
    ] as Record<string, string>[]) {
      const res = await app.request(
        "http://relay.test/api/sessions/A/status",
        { headers },
        env,
      );
      expect(res.status).toBe(401);
    }
  });

  test("cookie owner (no Bearer) still works → 200", async () => {
    const { env, kv } = await buildEnv();
    const res = await app.request(
      "http://relay.test/api/sessions/A/status",
      { headers: { Cookie: await cookieFor(kv, "u1") } },
      env,
    );
    expect(res.status).toBe(200);
  });

  test("cookie of a NON-owner → 404 (unchanged)", async () => {
    const { env, kv } = await buildEnv();
    const res = await app.request(
      "http://relay.test/api/sessions/A/status",
      { headers: { Cookie: await cookieFor(kv, "u2") } },
      env,
    );
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/sessions/:id — Bearer gateway_secret", () => {
  test("correct secret → 200 and actually removes the row", async () => {
    const { env, db } = await buildEnv();
    const res = await app.request(
      "http://relay.test/api/sessions/A",
      { method: "DELETE", headers: { Authorization: `Bearer ${SECRET_A}` } },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(db.deleted).toContain("A");
    expect(db.sessions.has("A")).toBe(false);
  });

  test("ISOLATION: session B's secret against session A's id → 401, row kept", async () => {
    const { env, db } = await buildEnv();
    const res = await app.request(
      "http://relay.test/api/sessions/A",
      { method: "DELETE", headers: { Authorization: `Bearer ${SECRET_B}` } },
      env,
    );
    expect(res.status).toBe(401);
    expect(db.deleted).not.toContain("A");
    expect(db.sessions.has("A")).toBe(true);
  });

  test("no cookie, no Bearer → 401", async () => {
    const { env } = await buildEnv();
    const res = await app.request(
      "http://relay.test/api/sessions/A",
      { method: "DELETE" },
      env,
    );
    expect(res.status).toBe(401);
  });

  test("cookie owner (no Bearer) still deletes → 200", async () => {
    const { env, db, kv } = await buildEnv();
    const res = await app.request(
      "http://relay.test/api/sessions/A",
      { method: "DELETE", headers: { Cookie: await cookieFor(kv, "u1") } },
      env,
    );
    expect(res.status).toBe(200);
    expect(db.sessions.has("A")).toBe(false);
  });
});

describe("control/stream stay cookie-only (Bearer NOT honored)", () => {
  test("correct secret to /control → 401 (no Bearer alternative)", async () => {
    const { env } = await buildEnv();
    const res = await app.request(
      "http://relay.test/api/sessions/A/control",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${SECRET_A}`, "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set_key" }),
      },
      env,
    );
    expect(res.status).toBe(401);
  });

  test("correct secret to /stream → 401 (no Bearer alternative)", async () => {
    const { env } = await buildEnv();
    const res = await app.request(
      "http://relay.test/api/sessions/A/stream",
      { headers: { Authorization: `Bearer ${SECRET_A}` } },
      env,
    );
    expect(res.status).toBe(401);
  });
});
