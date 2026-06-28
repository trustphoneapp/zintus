import { describe, expect, it } from "bun:test";
import { deriveProviderStatus, statusNeedsAdvice } from "./status";

const base = {
  isLocal: false,
  gatewayConnected: true,
  hasKey: true,
  available: true,
  inCooldown: false,
} as const;

describe("deriveProviderStatus — cloud providers", () => {
  it("connected when keyed + available + no problem", () => {
    expect(deriveProviderStatus({ ...base }).key).toBe("connected");
  });

  it("needs-key beats every other signal when no key is present", () => {
    const s = deriveProviderStatus({
      ...base,
      hasKey: false,
      available: false,
      inCooldown: true,
      quotaUsed: 9,
      quotaLimit: 1,
    });
    expect(s.key).toBe("needs-key");
  });

  it("cooldown outranks a proven quota exhaustion", () => {
    const s = deriveProviderStatus({
      ...base,
      inCooldown: true,
      quotaUsed: 100,
      quotaLimit: 100,
    });
    expect(s.key).toBe("cooldown");
  });

  it("exhausted ONLY with a real denominator that has been reached", () => {
    expect(
      deriveProviderStatus({ ...base, quotaUsed: 100, quotaLimit: 100 }).key,
    ).toBe("exhausted");
  });

  it("never fabricates 'exhausted' without a denominator", () => {
    // No quotaLimit reported → must not read as exhausted even if available is false.
    expect(
      deriveProviderStatus({ ...base, available: false, quotaUsed: 5000 }).key,
    ).toBe("unavailable");
    // Zero/invalid denominator is not a real limit.
    expect(
      deriveProviderStatus({ ...base, quotaUsed: 5000, quotaLimit: 0 }).key,
    ).toBe("connected");
  });

  it("unavailable when keyed but the gateway reports it down (no quota claim)", () => {
    expect(deriveProviderStatus({ ...base, available: false }).key).toBe(
      "unavailable",
    );
  });
});

describe("deriveProviderStatus — local runtimes", () => {
  it("running only when the gateway actually detects it", () => {
    expect(
      deriveProviderStatus({ ...base, isLocal: true, available: true }).key,
    ).toBe("local-running");
  });

  it("not-running when the gateway is up but the runtime is down", () => {
    expect(
      deriveProviderStatus({ ...base, isLocal: true, available: false }).key,
    ).toBe("local-stopped");
  });

  it("unknown (never falsely 'running') when the gateway is offline", () => {
    expect(
      deriveProviderStatus({
        ...base,
        isLocal: true,
        gatewayConnected: false,
        available: true,
      }).key,
    ).toBe("local-unknown");
  });
});

describe("statusNeedsAdvice", () => {
  it("flags only the problem statuses for the route-options advisor", () => {
    expect(statusNeedsAdvice("cooldown")).toBe(true);
    expect(statusNeedsAdvice("exhausted")).toBe(true);
    expect(statusNeedsAdvice("unavailable")).toBe(true);
    expect(statusNeedsAdvice("connected")).toBe(false);
    expect(statusNeedsAdvice("needs-key")).toBe(false);
    expect(statusNeedsAdvice("local-running")).toBe(false);
  });
});
