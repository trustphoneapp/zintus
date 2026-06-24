import { describe, expect, test } from "bun:test";
import { InFlightReservations, type CommittedUsage } from "./inflight.js";
import type { ProviderLimits } from "./limits.js";

const ZERO: CommittedUsage = {
  dailyRequests: 0,
  dailyTokens: 0,
  minuteRequests: 0,
  minuteTokens: 0,
};

describe("InFlightReservations", () => {
  test("THE CRITICAL TEST: concurrent reservations cannot overshoot (LiteLLM #18730)", async () => {
    // 6000 token/min cap; each request reserves 1000 → at most 6 may be admitted
    // even when 20 fire concurrently. This is the race the whole design fixes.
    const r = new InFlightReservations();
    const limits: ProviderLimits = { tokensPerMinute: 6_000 };
    const EST = 1_000;

    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        // each "request" runs the synchronous gate on the shared tracker
        Promise.resolve().then(() => r.tryReserve("groq", EST, ZERO, limits)),
      ),
    );

    const granted = results.filter(Boolean).length;
    const totalReserved = granted * EST;

    expect(granted).toBeLessThanOrEqual(6);
    expect(totalReserved).toBeLessThanOrEqual(6_000);
    expect(r.current("groq").tokens).toBe(totalReserved);
  });

  test("rejects once the per-minute token budget is committed", () => {
    const r = new InFlightReservations();
    const limits: ProviderLimits = { tokensPerMinute: 1_000 };
    expect(r.tryReserve("groq", 800, ZERO, limits)).toBe(true);
    // 800 in-flight + 800 more = 1600 > 1000 → rejected
    expect(r.tryReserve("groq", 800, ZERO, limits)).toBe(false);
    // a smaller one that fits is admitted
    expect(r.tryReserve("groq", 200, ZERO, limits)).toBe(true);
  });

  test("accounts for already-committed (daily + minute) usage", () => {
    const r = new InFlightReservations();
    const limits: ProviderLimits = { requestsPerDay: 10 };
    const committed: CommittedUsage = { ...ZERO, dailyRequests: 9 };
    // 9 committed + 1 new = 10 == limit → admitted (does not exceed)
    expect(r.tryReserve("gemini", 100, committed, limits)).toBe(true);
    // now 9 committed + 1 in-flight + 1 new = 11 > 10 → rejected
    expect(r.tryReserve("gemini", 100, committed, limits)).toBe(false);
  });

  test("enforces RPM independently of token budget", () => {
    const r = new InFlightReservations();
    const limits: ProviderLimits = { requestsPerMinute: 3, tokensPerMinute: 10_000_000 };
    let granted = 0;
    for (let i = 0; i < 10; i++) {
      if (r.tryReserve("groq", 10, ZERO, limits)) granted++;
    }
    expect(granted).toBe(3);
  });

  test("release frees capacity for the next request", () => {
    const r = new InFlightReservations();
    const limits: ProviderLimits = { requestsPerMinute: 1 };
    expect(r.tryReserve("groq", 100, ZERO, limits)).toBe(true);
    expect(r.tryReserve("groq", 100, ZERO, limits)).toBe(false);
    r.release("groq", 100);
    expect(r.current("groq").requests).toBe(0);
    expect(r.tryReserve("groq", 100, ZERO, limits)).toBe(true);
  });

  test("release never goes negative and is provider-scoped", () => {
    const r = new InFlightReservations();
    r.release("groq", 500); // nothing reserved — no-op, no throw
    expect(r.current("groq")).toEqual({ requests: 0, tokens: 0 });
    const limits: ProviderLimits = { tokensPerMinute: 1_000 };
    r.tryReserve("groq", 400, ZERO, limits);
    expect(r.current("gemini")).toEqual({ requests: 0, tokens: 0 });
    expect(r.current("groq").tokens).toBe(400);
  });

  test("no limits configured → always admits (local providers)", () => {
    const r = new InFlightReservations();
    const limits: ProviderLimits = {};
    for (let i = 0; i < 100; i++) {
      expect(r.tryReserve("ollama", 9_999, ZERO, limits)).toBe(true);
    }
  });
});

describe("InFlightReservations — zero-quota boundaries", () => {
  test("requestsPerDay: 0 rejects the very first reservation (count is always +1)", () => {
    const r = new InFlightReservations();
    // reqDay = 0 committed + 0 in-flight + 1 = 1 > 0 → rejected even for a tiny request.
    expect(r.tryReserve("groq", 1, ZERO, { requestsPerDay: 0 })).toBe(false);
    expect(r.current("groq")).toEqual({ requests: 0, tokens: 0 });
  });

  test("requestsPerMinute: 0 rejects the first reservation", () => {
    const r = new InFlightReservations();
    expect(r.tryReserve("groq", 1, ZERO, { requestsPerMinute: 0 })).toBe(false);
  });

  test("tokensPerDay: 0 rejects any non-zero token estimate", () => {
    const r = new InFlightReservations();
    expect(r.tryReserve("groq", 1, ZERO, { tokensPerDay: 0 })).toBe(false);
    expect(r.tryReserve("groq", 5000, ZERO, { tokensPerDay: 0 })).toBe(false);
  });

  test("tokensPerMinute: 0 rejects any non-zero token estimate", () => {
    const r = new InFlightReservations();
    expect(r.tryReserve("groq", 1, ZERO, { tokensPerMinute: 0 })).toBe(false);
  });

  test("a fully-zeroed provider can never reserve", () => {
    const r = new InFlightReservations();
    const zeroLimits: ProviderLimits = {
      requestsPerDay: 0,
      tokensPerDay: 0,
      requestsPerMinute: 0,
      tokensPerMinute: 0,
    };
    expect(r.tryReserve("groq", 100, ZERO, zeroLimits)).toBe(false);
    expect(r.current("groq").tokens).toBe(0);
  });

  test("EDGE: a zero-token request slips past a token-only zero cap (no request cap set)", () => {
    // Documents the real semantics: tokDay = 0+0+0 = 0, `0 > 0` is false, and
    // with no request limit configured the reservation is admitted. A request
    // limit (even 0) is what actually blocks a zero-token request.
    const r = new InFlightReservations();
    expect(r.tryReserve("groq", 0, ZERO, { tokensPerDay: 0 })).toBe(true);
    expect(r.tryReserve("groq", 0, ZERO, { tokensPerDay: 0, requestsPerDay: 0 })).toBe(false);
  });
});
