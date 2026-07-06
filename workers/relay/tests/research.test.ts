import { describe, expect, test } from "bun:test";
import { handleResearchSession, researchSessionsUsed } from "../src/research.js";
import { billingPeriod } from "../src/middleware/quota.js";
import { RESEARCH_SESSIONS_PER_MONTH, FLAT_FEES_CREDITS } from "../src/tiers.js";
import type { Env } from "../src/types.js";
import type { SessionPayload } from "../src/auth.js";
import type { Context } from "hono";

// Research session metering (PRICING-FINAL Part 8): per-tier monthly
// allotments on a calendar-month D1 counter; overflow sessions debit the
// deep_research flat fee (150 cr) from plan balance, displayed as plan tokens.

const SESSION: SessionPayload = { session_id: "s1", user_id: "u1", email: "u@x.dev" };

/** In-memory fake of the two D1 tables + the QuotaCounter DO this path touches. */
function fakeWorld(tier: string, opts: { sessionsUsed?: number; quotaMc?: number; status?: string } = {}) {
  const world = {
    sessions: new Map<string, number>(),
    quotaMc: opts.quotaMc ?? 0,
    usageLog: [] as string[],
    subDebits: [] as number[],
  };
  const key = `u1:${billingPeriod()}`;
  if (opts.sessionsUsed) world.sessions.set(key, opts.sessionsUsed);

  const prepare = (sql: string) => ({
    bind: (...args: unknown[]) => ({
      first: async () => {
        if (sql.includes("FROM subscriptions")) {
          return { user_id: "u1", tier, status: opts.status ?? "active", tokens_used_this_period: 0 };
        }
        if (sql.includes("FROM research_sessions")) {
          const used = world.sessions.get(`${args[0]}:${args[1]}`) ?? 0;
          return used ? { used } : null;
        }
        return null;
      },
      run: async () => {
        if (sql.includes("INSERT INTO research_sessions")) {
          const k = `${args[0]}:${args[1]}`;
          world.sessions.set(k, (world.sessions.get(k) ?? 0) + 1);
        }
        if (sql.includes("INSERT INTO usage_log")) world.usageLog.push(String(args[2]));
        if (sql.includes("UPDATE subscriptions SET tokens_used_this_period")) {
          world.subDebits.push(Number(args[0]));
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
  } as unknown as Env;

  const c = {
    env,
    json: (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } }),
  } as unknown as Context<{ Bindings: Env }>;

  return { env, c, world };
}

describe("handleResearchSession", () => {
  test("within allotment: free, counter increments, no plan debit", async () => {
    const { c, world } = fakeWorld("pro");
    const res = await handleResearchSession(c, SESSION);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json["allowed"]).toBe(true);
    expect(json["overflow"]).toBe(false);
    expect(json["used"]).toBe(1);
    expect(json["allotment"]).toBe(RESEARCH_SESSIONS_PER_MONTH.pro);
    expect(json["plan_tokens_debited"]).toBe(0);
    expect(world.quotaMc).toBe(0); // no token burn inside the allotment
  });

  test("beyond allotment: debits the deep_research flat fee as plan tokens", async () => {
    const { c, world } = fakeWorld("pro", { sessionsUsed: RESEARCH_SESSIONS_PER_MONTH.pro });
    const res = await handleResearchSession(c, SESSION);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json["overflow"]).toBe(true);
    // 150 cr = 150,000 mc hit the atomic counter…
    expect(world.quotaMc).toBe(FLAT_FEES_CREDITS.deep_research * 1000);
    // …and the receipt displays PRO plan tokens: 150,000 × 10M/35M ≈ 42,857.
    expect(json["plan_tokens_debited"]).toBe(42_857);
    expect(world.usageLog).toContain("service:deep_research");
  });

  test("allotment AND plan balance exhausted → 429 research_exhausted", async () => {
    const { c } = fakeWorld("starter", {
      sessionsUsed: RESEARCH_SESSIONS_PER_MONTH.starter,
      quotaMc: 15_000_000, // full starter grant already burned
    });
    const res = await handleResearchSession(c, SESSION);
    expect(res.status).toBe(429);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json["code"]).toBe("research_exhausted");
  });

  test("no active membership → 403", async () => {
    const { c } = fakeWorld("free", { status: "canceled" });
    const res = await handleResearchSession(c, SESSION);
    expect(res.status).toBe(403);
  });

  test("researchSessionsUsed returns 0 with no row", async () => {
    const { env } = fakeWorld("pro");
    expect(await researchSessionsUsed(env, "u1")).toBe(0);
  });
});
