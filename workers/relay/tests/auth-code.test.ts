import { afterEach, describe, expect, test } from "bun:test";
import app from "../src/index.js";
import type { Env } from "../src/types.js";

// End-to-end (app.request-level) coverage of the P0 auth upgrades:
//   • one email carries a magic link AND a 6-digit fallback code
//   • POST /api/auth/verify-code signs in from the code (wrong-device fix)
//   • latest-artifact-wins: a new email invalidates the previous link+code
//   • both artifacts are single-use and consumed as a family
//   • GET /api/auth/verify failures REDIRECT to the login page (no raw JSON)

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** In-memory KV + D1 fakes rich enough for the full magic-link/code flow. */
function fakeWorld() {
  const kv = new Map<string, string>();
  const users = new Map<string, { id: string; email: string; created_at: number }>();
  const emailsSent: string[] = []; // captured Resend HTML bodies

  const env = {
    RELAY_BASE_URL: "http://relay.test",
    RESEND_API_KEY: "re_test",
    COOKIE_DOMAIN: "",
    KV: {
      get: async (k: string) => kv.get(k) ?? null,
      put: async (k: string, v: string) => void kv.set(k, v),
      delete: async (k: string) => void kv.delete(k),
    } as unknown as Env["KV"],
    DB: {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => ({
          first: async () => {
            if (sql.includes("FROM zintus_users")) {
              return users.get(String(args[0]).toLowerCase()) ?? null;
            }
            return null;
          },
          run: async () => {
            if (sql.includes("INSERT INTO zintus_users")) {
              users.set(String(args[1]), {
                id: String(args[0]),
                email: String(args[1]),
                created_at: Number(args[2]),
              });
            }
            return {};
          },
          all: async () => ({ results: [] }),
        }),
      }),
    } as unknown as Env["DB"],
  } as unknown as Env;

  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).includes("api.resend.com")) {
      emailsSent.push(JSON.parse(String(init?.body)).html as string);
      return new Response("{}", { status: 200 });
    }
    return realFetch(url as never, init as never);
  }) as typeof fetch;

  return { env, kv, emailsSent };
}

async function requestMagicLink(env: Env, email = "dev@zintus.ai") {
  return app.request(
    "http://relay.test/api/auth/magic-link",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "cf-connecting-ip": "1.2.3.4" },
      body: JSON.stringify({ email }),
    },
    env,
  );
}

function extractCode(emailHtml: string): string {
  const m = /font-family:monospace;">(\d{6})</.exec(emailHtml);
  if (!m) throw new Error("no code in email html");
  return m[1]!;
}

function extractToken(emailHtml: string): string {
  const m = /verify\?token=([a-f0-9-]+)/.exec(emailHtml);
  if (!m) throw new Error("no token in email html");
  return m[1]!;
}

describe("magic-link email artifacts", () => {
  test("one email carries BOTH a link and a 6-digit code", async () => {
    const { env, emailsSent } = fakeWorld();
    const res = await requestMagicLink(env);
    expect(res.status).toBe(200);
    expect(emailsSent.length).toBe(1);
    expect(() => extractToken(emailsSent[0]!)).not.toThrow();
    expect(extractCode(emailsSent[0]!)).toMatch(/^\d{6}$/);
  });

  test("verify-code signs in with a session cookie (wrong-device recovery)", async () => {
    const { env, emailsSent } = fakeWorld();
    await requestMagicLink(env);
    const code = extractCode(emailsSent[0]!);

    const res = await app.request(
      "http://relay.test/api/auth/verify-code",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "dev@zintus.ai", code }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; redirect_to: string };
    expect(body.ok).toBe(true);
    expect(body.redirect_to).toContain("zintus.ai");
    expect(res.headers.get("Set-Cookie")).toContain("zintus_session=");
  });

  test("code is single-use and consumes the magic link too (family)", async () => {
    const { env, emailsSent } = fakeWorld();
    await requestMagicLink(env);
    const code = extractCode(emailsSent[0]!);
    const token = extractToken(emailsSent[0]!);

    const first = await app.request(
      "http://relay.test/api/auth/verify-code",
      { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "dev@zintus.ai", code }) },
      env,
    );
    expect(first.status).toBe(200);

    // Same code again → rejected.
    const replay = await app.request(
      "http://relay.test/api/auth/verify-code",
      { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "dev@zintus.ai", code }) },
      env,
    );
    expect(replay.status).toBe(400);

    // The sibling LINK is dead too — redirects to the expired page.
    const link = await app.request(
      `http://relay.test/api/auth/verify?token=${token}`,
      {},
      env,
    );
    expect(link.status).toBe(302);
    expect(link.headers.get("Location")).toContain("error=link_expired");
  });

  test("latest-artifact-wins: a second email invalidates the first pair", async () => {
    const { env, emailsSent } = fakeWorld();
    await requestMagicLink(env);
    await requestMagicLink(env);
    expect(emailsSent.length).toBe(2);

    const oldCode = extractCode(emailsSent[0]!);
    const newCode = extractCode(emailsSent[1]!);

    const oldRes = await app.request(
      "http://relay.test/api/auth/verify-code",
      { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "dev@zintus.ai", code: oldCode }) },
      env,
    );
    // Old artifact rejected UNLESS both emails minted the same code (1-in-10⁶
    // collision would make old==new valid) — guard the assertion accordingly.
    if (oldCode !== newCode) expect(oldRes.status).toBe(400);

    const newRes = await app.request(
      "http://relay.test/api/auth/verify-code",
      { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "dev@zintus.ai", code: newCode }) },
      env,
    );
    expect(newRes.status).toBe(200);
  });

  test("verify with a bad token redirects to login (no raw JSON dead-end)", async () => {
    const { env } = fakeWorld();
    const res = await app.request(
      "http://relay.test/api/auth/verify?token=nope",
      {},
      env,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://www.zintus.ai/login?error=link_expired");
  });

  test("code attempts are throttled (5 per window)", async () => {
    const { env } = fakeWorld();
    await requestMagicLink(env);
    let last: Response | null = null;
    for (let i = 0; i < 6; i++) {
      last = await app.request(
        "http://relay.test/api/auth/verify-code",
        { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "dev@zintus.ai", code: "000000" }) },
        env,
      );
    }
    expect(last!.status).toBe(429);
  });

  test("malformed code shapes are rejected by the zod gate", async () => {
    const { env } = fakeWorld();
    for (const code of ["12345", "1234567", "abcdef", ""]) {
      const res = await app.request(
        "http://relay.test/api/auth/verify-code",
        { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "dev@zintus.ai", code }) },
        env,
      );
      expect(res.status).toBe(400);
    }
  });
});
