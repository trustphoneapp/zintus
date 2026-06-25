/**
 * Unit tests for the KV-counter rate limiter and the layered magic-link
 * limits (bug B6). Imports the REAL kvRateLimitOk + key/limit constants so the
 * email+IP throttle can't drift from production. Runs with `bun test`.
 */
import { describe, it, expect } from "bun:test";
import {
  kvRateLimitOk,
  magicLinkEmailKey,
  magicLinkIpKey,
  MAGIC_LINK_EMAIL_LIMIT,
  MAGIC_LINK_EMAIL_WINDOW_SECS,
  MAGIC_LINK_IP_LIMIT,
  MAGIC_LINK_IP_WINDOW_SECS,
} from "../src/rate-limit.js";

// Minimal in-memory KV implementing only the get/put surface the limiter uses.
// TTL is ignored — tests don't advance time; they only exercise counting.
function fakeKV(): KVNamespace {
  const store = new Map<string, string>();
  return {
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
  } as unknown as KVNamespace;
}

/** Simulate the production magic-link gate: BOTH email and IP must pass. */
async function magicLinkAllowed(
  kv: KVNamespace,
  email: string,
  ip: string,
): Promise<boolean> {
  const emailOk = await kvRateLimitOk(
    kv,
    magicLinkEmailKey(email),
    MAGIC_LINK_EMAIL_LIMIT,
    MAGIC_LINK_EMAIL_WINDOW_SECS,
  );
  if (!emailOk) return false;
  return kvRateLimitOk(
    kv,
    magicLinkIpKey(ip),
    MAGIC_LINK_IP_LIMIT,
    MAGIC_LINK_IP_WINDOW_SECS,
  );
}

describe("kvRateLimitOk", () => {
  it("allows exactly `limit` requests then blocks", async () => {
    const kv = fakeKV();
    expect(await kvRateLimitOk(kv, "k", 3, 60)).toBe(true);
    expect(await kvRateLimitOk(kv, "k", 3, 60)).toBe(true);
    expect(await kvRateLimitOk(kv, "k", 3, 60)).toBe(true);
    expect(await kvRateLimitOk(kv, "k", 3, 60)).toBe(false);
  });

  it("keeps separate counters per key", async () => {
    const kv = fakeKV();
    expect(await kvRateLimitOk(kv, "a", 1, 60)).toBe(true);
    expect(await kvRateLimitOk(kv, "a", 1, 60)).toBe(false);
    expect(await kvRateLimitOk(kv, "b", 1, 60)).toBe(true);
  });
});

describe("magic-link key builders", () => {
  it("lowercases the email so case variants share a counter", () => {
    expect(magicLinkEmailKey("User@Example.com")).toBe("rl:ml:user@example.com");
  });

  it("namespaces email vs IP keys distinctly", () => {
    expect(magicLinkEmailKey("1.2.3.4")).not.toBe(magicLinkIpKey("1.2.3.4"));
    expect(magicLinkIpKey("1.2.3.4")).toBe("rl:ml:ip:1.2.3.4");
  });

  it("uses sane limits (email tighter than IP)", () => {
    expect(MAGIC_LINK_EMAIL_LIMIT).toBe(3);
    expect(MAGIC_LINK_IP_LIMIT).toBe(10);
    expect(MAGIC_LINK_EMAIL_LIMIT).toBeLessThan(MAGIC_LINK_IP_LIMIT);
  });
});

describe("layered magic-link limit (B6)", () => {
  it("blocks repeated requests for the SAME email at the per-email cap", async () => {
    const kv = fakeKV();
    for (let i = 0; i < MAGIC_LINK_EMAIL_LIMIT; i++) {
      expect(await magicLinkAllowed(kv, "victim@example.com", "9.9.9.9")).toBe(true);
    }
    // 4th attempt to the same inbox is blocked by the email counter.
    expect(await magicLinkAllowed(kv, "victim@example.com", "9.9.9.9")).toBe(false);
  });

  it("throttles ROTATING emails from one IP independent of the email limit", async () => {
    const kv = fakeKV();
    const ip = "5.5.5.5";
    // Each request uses a brand-new email, so the per-email limit never trips.
    // The per-IP limit must still cut the attacker off after MAGIC_LINK_IP_LIMIT.
    for (let i = 0; i < MAGIC_LINK_IP_LIMIT; i++) {
      expect(await magicLinkAllowed(kv, `addr${i}@example.com`, ip)).toBe(true);
    }
    expect(await magicLinkAllowed(kv, `addr-overflow@example.com`, ip)).toBe(false);
  });

  it("does not let one IP's exhaustion block a different IP", async () => {
    const kv = fakeKV();
    for (let i = 0; i < MAGIC_LINK_IP_LIMIT; i++) {
      await magicLinkAllowed(kv, `a${i}@example.com`, "1.1.1.1");
    }
    expect(await magicLinkAllowed(kv, "a-overflow@example.com", "1.1.1.1")).toBe(false);
    // A fresh IP with a fresh email is unaffected.
    expect(await magicLinkAllowed(kv, "fresh@example.com", "2.2.2.2")).toBe(true);
  });
});
