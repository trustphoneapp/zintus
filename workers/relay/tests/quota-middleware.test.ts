import { describe, expect, test } from "bun:test";
import { enforceQuota, recordUsage, billingPeriod, periodResetUnix } from "../src/middleware/quota.js";
import type { Env, SubscriptionRow } from "../src/types.js";

// Quota enforcement + usage recording for the relay's managed tiers. The token
// counter is now a strongly-consistent Durable Object (QuotaCounter), so this
// builds a fake DO namespace that models the runtime's per-object serialisation,
// plus a fake D1, to exercise the real enforceQuota/recordUsage branches.

/**
 * Fake QUOTA_COUNTER namespace. Each named object owns an in-memory total and a
 * per-name promise chain, so concurrent `/add` calls are serialised exactly like
 * the real Durable Object runtime (no lost-update race).
 */
function fakeQuotaCounter() {
  const totals = new Map<string, number>();
  const locks = new Map<string, Promise<unknown>>();
  return {
    totals,
    idFromName: (name: string) => ({ name }),
    get: (id: { name: string }) => ({
      fetch: (url: string, init?: { method?: string; body?: string }) => {
        const pathname = new URL(url).pathname;
        const prev = locks.get(id.name) ?? Promise.resolve();
        const next = prev.then(async () => {
          if (pathname === "/add") {
            const n = parseInt(init?.body ?? "0", 10);
            const delta = Number.isFinite(n) && n > 0 ? n : 0;
            const total = (totals.get(id.name) ?? 0) + delta;
            totals.set(id.name, total);
            return new Response(JSON.stringify({ total }));
          }
          return new Response(JSON.stringify({ total: totals.get(id.name) ?? 0 }));
        });
        locks.set(id.name, next.catch(() => undefined));
        return next;
      },
    }),
  };
}

function fakeEnv(
  sub: SubscriptionRow | null,
  counter = fakeQuotaCounter(),
): { env: Env; counter: ReturnType<typeof fakeQuotaCounter> } {
  const db = {
    prepare: () => ({
      bind: () => ({
        first: async () => sub,
        run: async () => ({}),
      }),
    }),
  };
  return { env: { DB: db, QUOTA_COUNTER: counter } as unknown as Env, counter };
}

const sub = (tier: string): SubscriptionRow =>
  ({ user_id: "u1", tier, status: "active", tokens_used_this_period: 0 } as unknown as SubscriptionRow);

const counterKey = (userId: string) => `${userId}:${billingPeriod()}`;

describe("enforceQuota", () => {
  test("free tier has no token cap -> always allowed", async () => {
    const { env } = fakeEnv(null); // no subscription => free
    const r = await enforceQuota("u1", env);
    expect(r.tier).toBe("free");
    expect(r.allowed).toBe(true);
    expect(r.limit).toBeNull();
  });

  // The counter stores MILLICREDITS (1 credit = 1,000 mc; debit = real tokens
  // × CLASS_BURN). Starter's internal cap is 15,000 credits = 15,000,000 mc;
  // `used`/`limit` in the result are converted to USER-FACING plan tokens
  // (Starter allowance 1M), so clients never see internal units.
  test("paid tier under the monthly cap is allowed", async () => {
    const counter = fakeQuotaCounter();
    counter.totals.set(counterKey("u1"), 1_500_000); // 1,500 cr of 15,000
    const { env } = fakeEnv(sub("starter"), counter);
    const r = await enforceQuota("u1", env);
    expect(r.tier).toBe("starter");
    expect(r.allowed).toBe(true); // 1.5M mc < 15M mc
    expect(r.limit).toBe(1_000_000); // displayed: the SOLD allowance
    expect(r.used).toBe(100_000); // 1.5M mc × 1M/15M = 10% of the allowance
  });

  test("paid tier at/over the cap is blocked (429 path)", async () => {
    const counter = fakeQuotaCounter();
    counter.totals.set(counterKey("u1"), 15_000_000); // full 15,000-cr grant
    const { env } = fakeEnv(sub("starter"), counter);
    const r = await enforceQuota("u1", env);
    expect(r.allowed).toBe(false); // 15M mc not < 15M mc
    expect(r.used).toBe(1_000_000); // displays as the full sold allowance
    expect(r.reset).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });
});

// ── Quota period is the CALENDAR UTC month (B-Lane fix 6) ───────────────────
// The QuotaCounter DO is keyed `${user}:${billingPeriod()}`, so the period key
// rolling at the UTC month boundary IS the budget reset: a new month routes to a
// fresh DO instance. Stripe `invoice.paid` resets only the cosmetic D1 column,
// never the DO — this pins the calendar-month contract that decision documents.
describe("billing period boundary (calendar UTC month)", () => {
  test("key holds through the last second of a month, flips at the next month's first second", () => {
    expect(billingPeriod(new Date("2026-01-31T23:59:59Z"))).toBe("2026-01");
    expect(billingPeriod(new Date("2026-02-01T00:00:00Z"))).toBe("2026-02");
    // Different period key => different DO instance => fresh counter (the reset).
    expect(billingPeriod(new Date("2026-01-31T23:59:59Z")))
      .not.toBe(billingPeriod(new Date("2026-02-01T00:00:00Z")));
  });

  test("reset timestamp is the first of next UTC month, incl. December→January rollover", () => {
    expect(periodResetUnix(new Date("2026-01-15T12:00:00Z")))
      .toBe(Math.floor(Date.UTC(2026, 1, 1) / 1000)); // Feb 1
    expect(periodResetUnix(new Date("2026-12-15T12:00:00Z")))
      .toBe(Math.floor(Date.UTC(2027, 0, 1) / 1000)); // Jan 1 next year
  });
});

describe("recordUsage", () => {
  test("debits (input+output) × burn millicredits for a managed model", async () => {
    const { env, counter } = fakeEnv(sub("starter"));
    // cheap class: burn 1 → 500 real tokens = 500 mc
    await recordUsage("u1", "zintus:groq", "zintus/llama-3.1-8b", 300, 200, env, 1, "starter");
    expect(counter.totals.get(counterKey("u1"))).toBe(500);
    // premium class: burn 5 → 500 real tokens = 2,500 mc more
    await recordUsage("u1", "zintus:groq", "zintus/llama-3.3-70b", 300, 200, env, 5, "starter");
    expect(counter.totals.get(counterKey("u1"))).toBe(3_000);
  });

  test("BYOK self-report (burn 0) logs but never debits plan balance", async () => {
    // Pre-economics this path consumed paid members' plan tokens at 1:1 —
    // wrong, the member pays their own provider for BYOK usage.
    const { env, counter } = fakeEnv(sub("pro"));
    await recordUsage("u1", "groq", "llama", 300, 200, env, 0, "free");
    expect(counter.totals.get(counterKey("u1"))).toBeUndefined();
  });

  test("concurrent recordUsage is now ATOMIC — no increments lost (DO counter)", async () => {
    // The previous KV read-modify-write lost concurrent increments. The Durable
    // Object counter serialises per-object writes, so 5 concurrent +100s sum to
    // exactly 500. This pins the B3 atomicity fix.
    const { env, counter } = fakeEnv(sub("pro"));
    await Promise.all(
      Array.from({ length: 5 }, () => recordUsage("u1", "groq", "llama", 100, 0, env, 1, "pro")),
    );
    expect(counter.totals.get(counterKey("u1"))).toBe(500);
  });
});
