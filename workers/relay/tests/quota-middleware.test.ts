import { describe, expect, test } from "bun:test";
import { enforceQuota, recordUsage, billingPeriod } from "../src/middleware/quota.js";
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

  test("paid tier under the monthly cap is allowed", async () => {
    const counter = fakeQuotaCounter();
    counter.totals.set(counterKey("u1"), 100_000);
    const { env } = fakeEnv(sub("starter"), counter);
    const r = await enforceQuota("u1", env);
    expect(r.tier).toBe("starter");
    expect(r.allowed).toBe(true); // 100k < 500k
    expect(r.limit).toBe(500_000);
    expect(r.used).toBe(100_000);
  });

  test("paid tier at/over the cap is blocked (429 path)", async () => {
    const counter = fakeQuotaCounter();
    counter.totals.set(counterKey("u1"), 500_000);
    const { env } = fakeEnv(sub("starter"), counter);
    const r = await enforceQuota("u1", env);
    expect(r.allowed).toBe(false); // 500k not < 500k
    expect(r.reset).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });
});

describe("recordUsage", () => {
  test("increments the counter by input+output tokens", async () => {
    const { env, counter } = fakeEnv(sub("starter"));
    await recordUsage("u1", "groq", "llama", 300, 200, env);
    expect(counter.totals.get(counterKey("u1"))).toBe(500);
  });

  test("concurrent recordUsage is now ATOMIC — no increments lost (DO counter)", async () => {
    // The previous KV read-modify-write lost concurrent increments. The Durable
    // Object counter serialises per-object writes, so 5 concurrent +100s sum to
    // exactly 500. This pins the B3 atomicity fix.
    const { env, counter } = fakeEnv(sub("growth"));
    await Promise.all(
      Array.from({ length: 5 }, () => recordUsage("u1", "groq", "llama", 100, 0, env)),
    );
    expect(counter.totals.get(counterKey("u1"))).toBe(500);
  });
});
