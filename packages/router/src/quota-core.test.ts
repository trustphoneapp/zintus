import { describe, expect, it } from "vitest";
import {
  applyUsage,
  cooldownUntil,
  emptyQuotaRow,
  isQuotaAvailable,
  remainingRatio,
  resetPatch,
  startOfUtcDay,
} from "./quota-core.js";

describe("quota-core", () => {
  it("resets daily counters at the UTC day boundary", () => {
    const limits = { requestsPerDay: 100 };
    const yesterday = startOfUtcDay(Date.UTC(2026, 5, 14, 12));
    const row = { ...emptyQuotaRow(), requestsToday: 50, lastReset: yesterday };
    const patch = resetPatch(row, limits, Date.UTC(2026, 5, 15, 1));
    expect(patch).toEqual({
      requestsToday: 0,
      tokensToday: 0,
      lastReset: startOfUtcDay(Date.UTC(2026, 5, 15, 1)),
    });
  });

  it("does not reset within the same UTC day", () => {
    const limits = { requestsPerDay: 100 };
    const today = startOfUtcDay(Date.UTC(2026, 5, 15, 0));
    const row = { ...emptyQuotaRow(), requestsToday: 50, lastReset: today };
    expect(resetPatch(row, limits, Date.UTC(2026, 5, 15, 23))).toBeNull();
  });

  it("clears a rolling window once its reset timestamp elapses", () => {
    const limits = { rollingWindow: true, requestsPerDay: 100 };
    const now = 1_000_000;
    const row = { ...emptyQuotaRow(), requestsToday: 100, lastReset: now - 1 };
    expect(resetPatch(row, limits, now)).toEqual({
      requestsToday: 0,
      tokensToday: 0,
      lastReset: null,
      cooldownUntil: null,
    });
  });

  it("reports availability against request and token limits and cooldown", () => {
    const limits = { requestsPerDay: 10, tokensPerDay: 1000 };
    const now = 1_000;
    expect(isQuotaAvailable(emptyQuotaRow(), limits, now)).toBe(true);
    expect(
      isQuotaAvailable({ ...emptyQuotaRow(), requestsToday: 10 }, limits, now),
    ).toBe(false);
    expect(
      isQuotaAvailable({ ...emptyQuotaRow(), tokensToday: 1000 }, limits, now),
    ).toBe(false);
    expect(
      isQuotaAvailable(
        { ...emptyQuotaRow(), cooldownUntil: now + 1 },
        limits,
        now,
      ),
    ).toBe(false);
  });

  it("computes remaining ratio from the tightest limit", () => {
    const row = { ...emptyQuotaRow(), requestsToday: 8, tokensToday: 100 };
    expect(
      remainingRatio(row, { requestsPerDay: 10, tokensPerDay: 1000 }),
    ).toBeCloseTo(0.2, 5);
  });

  it("accumulates usage and grows cooldown with retries", () => {
    const next = applyUsage({ ...emptyQuotaRow(), requestsToday: 2 }, 10, 5);
    expect(next.requestsToday).toBe(3);
    expect(next.tokensToday).toBe(15);

    const now = 0;
    expect(cooldownUntil(0, now)).toBeLessThan(cooldownUntil(2, now));
  });
});
