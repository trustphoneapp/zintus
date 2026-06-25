import { describe, expect, test } from "bun:test";
import { enforceQuota, recordUsage } from "../src/middleware/quota.js";
import type { Env, SubscriptionRow } from "../src/types.js";

// Quota enforcement + usage recording for the relay's managed tiers. Built on a
// fake KV (in-memory) + fake D1 so the branches run deterministically.

function fakeKV() {
  const store = new Map<string, string>();
  return {
    store,
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => {
      store.set(k, v);
    },
  };
}

function fakeEnv(sub: SubscriptionRow | null, kv = fakeKV()): { env: Env; kv: ReturnType<typeof fakeKV> } {
  const db = {
    prepare: () => ({
      bind: () => ({
        first: async () => sub,
        run: async () => ({}),
      }),
    }),
  };
  return { env: { DB: db, KV: kv } as unknown as Env, kv };
}

const sub = (tier: string, used = 0): SubscriptionRow =>
  ({ user_id: "u1", tier, status: "active", tokens_used_this_period: used } as unknown as SubscriptionRow);

describe("enforceQuota", () => {
  test("free tier has no token cap -> always allowed", async () => {
    const { env } = fakeEnv(null); // no subscription => free
    const r = await enforceQuota("u1", env);
    expect(r.tier).toBe("free");
    expect(r.allowed).toBe(true);
  });

  test("paid tier under the monthly cap is allowed", async () => {
    const { env } = fakeEnv(sub("starter"));
    const kv = fakeKV();
    kv.store.set(`quota:u1:${new Date().toISOString().slice(0, 7)}`, "100000");
    const { env: env2 } = fakeEnv(sub("starter"), kv);
    const r = await enforceQuota("u1", env2);
    expect(r.tier).toBe("starter");
    expect(r.allowed).toBe(true); // 100k < 500k
    void env;
  });

  test("paid tier at/over the cap is blocked", async () => {
    const kv = fakeKV();
    kv.store.set(`quota:u1:${new Date().toISOString().slice(0, 7)}`, "500000");
    const { env } = fakeEnv(sub("starter"), kv);
    const r = await enforceQuota("u1", env);
    expect(r.allowed).toBe(false); // 500k not < 500k
  });
});

describe("recordUsage", () => {
  test("increments the KV usage counter by input+output tokens", async () => {
    const { env, kv } = fakeEnv(sub("starter"));
    await recordUsage("u1", "groq", "llama", 300, 200, env);
    const key = `quota:u1:${new Date().toISOString().slice(0, 7)}`;
    expect(kv.store.get(key)).toBe("500");
  });

  test("DOCUMENTS the known non-atomic race: concurrent recordUsage loses increments", async () => {
    // The KV counter is a read-modify-write with no atomicity (acceptable for
    // the MVP per the code comment). Concurrent calls all read the same value,
    // so the final counter UNDER-counts. This test pins that behaviour so a
    // future "fix" to atomic increments is a conscious change, not a surprise.
    const { env, kv } = fakeEnv(sub("growth"));
    const key = `quota:u1:${new Date().toISOString().slice(0, 7)}`;
    await Promise.all(
      Array.from({ length: 5 }, () => recordUsage("u1", "groq", "llama", 100, 0, env)),
    );
    const final = parseInt(kv.store.get(key) ?? "0", 10);
    expect(final).toBeLessThan(5 * 100); // increments were lost to the race
    expect(final).toBeGreaterThan(0);
  });
});
