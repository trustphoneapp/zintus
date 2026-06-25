import { describe, expect, test } from "bun:test";
import { createRateLimiter } from "./rate-limit.js";

describe("createRateLimiter", () => {
  test("disabled when limit <= 0", () => {
    const rl = createRateLimiter({ limit: 0, windowMs: 1000 });
    for (let i = 0; i < 100; i++) {
      expect(rl.check("k").ok).toBe(true);
    }
  });

  test("allows up to the limit then rejects with retryAfter", () => {
    const rl = createRateLimiter({ limit: 3, windowMs: 60_000 });
    expect(rl.check("a").ok).toBe(true);
    expect(rl.check("a").ok).toBe(true);
    expect(rl.check("a").ok).toBe(true);
    const denied = rl.check("a");
    expect(denied.ok).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
  });

  test("buckets are isolated per key", () => {
    const rl = createRateLimiter({ limit: 1, windowMs: 60_000 });
    expect(rl.check("a").ok).toBe(true);
    expect(rl.check("a").ok).toBe(false);
    // A different key has its own budget.
    expect(rl.check("b").ok).toBe(true);
  });

  test("window slides: budget frees up after windowMs", async () => {
    const rl = createRateLimiter({ limit: 1, windowMs: 30 });
    expect(rl.check("a").ok).toBe(true);
    expect(rl.check("a").ok).toBe(false);
    await new Promise((r) => setTimeout(r, 45));
    expect(rl.check("a").ok).toBe(true);
  });

  test("keyFor ignores spoofable XFF by default, keying by bearer token", () => {
    const rl = createRateLimiter({ limit: 1, windowMs: 1000 });
    // Without trustProxy, a forged X-Forwarded-For must NOT create a fresh key —
    // it falls through to the bearer token.
    const key = rl.keyFor(
      new Request("http://x", {
        headers: {
          "x-forwarded-for": "1.2.3.4",
          authorization: "Bearer secret",
        },
      }),
    );
    expect(key.startsWith("tok:")).toBe(true);
    expect(rl.keyFor(new Request("http://x"))).toBe("anon");
  });

  test("keyFor uses X-Forwarded-For / X-Real-IP when trustProxy is set", () => {
    const rl = createRateLimiter({ limit: 1, windowMs: 1000, trustProxy: true });
    expect(
      rl.keyFor(
        new Request("http://x", { headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" } }),
      ),
    ).toBe("ip:1.2.3.4");
    expect(
      rl.keyFor(new Request("http://x", { headers: { "x-real-ip": "9.9.9.9" } })),
    ).toBe("ip:9.9.9.9");
  });
});
