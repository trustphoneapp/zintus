import { describe, expect, it } from "bun:test";
import type { BillingStatus, UsageCurrent } from "./billing";
import { isManagedMember, membershipView } from "./membership";

function status(extra: Partial<BillingStatus> = {}): BillingStatus {
  return {
    tier: "pro",
    status: "active",
    tokens_used: 2_500_000,
    tokens_limit: 10_000_000,
    period_end: null,
    referral_code: "ref",
    ...extra,
  };
}

describe("isManagedMember", () => {
  it("true only for a non-free, non-cancelled subscription", () => {
    expect(isManagedMember(status())).toBe(true);
    expect(isManagedMember(status({ status: "past_due" }))).toBe(true);
    expect(isManagedMember(status({ status: "cancelled" }))).toBe(false);
    expect(isManagedMember(status({ tier: "free" }))).toBe(false);
    expect(isManagedMember(null)).toBe(false);
  });
});

describe("membershipView — signed out", () => {
  it("null status → the sign-in upsell with exact copy", () => {
    const v = membershipView(null, null);
    expect(v).toEqual({
      kind: "upsell",
      text: "Membership — sign in to route without keys · from $15/mo",
      href: "/login",
      cta: "Sign in",
    });
  });
});

describe("membershipView — signed in, not a paid member", () => {
  it("free tier → the upgrade upsell", () => {
    const v = membershipView(status({ tier: "free" }), null);
    expect(v).toEqual({
      kind: "upsell",
      text: "Membership — upgrade to route without keys · from $15/mo",
      href: "/pricing",
      cta: "Upgrade",
    });
  });
  it("cancelled sub → the upgrade upsell", () => {
    expect(membershipView(status({ status: "cancelled" }), null).kind).toBe(
      "upsell",
    );
  });
});

describe("membershipView — active paid member", () => {
  it("Pro active → the 'Plan: Pro · managed routing' card with exact copy", () => {
    const v = membershipView(status({ tier: "pro" }), null);
    expect(v.kind).toBe("member");
    if (v.kind !== "member") throw new Error("expected member");
    expect(v.title).toBe("Plan: Pro · managed routing");
    expect(v.subtitle).toBe("no key needed — routes via Zintus managed keys");
    expect(v.statusLabel).toBe("active");
    expect(v.pastDue).toBe(false);
    // 2.5M of 10M used → 25% used → 75% remaining.
    expect(v.remainingPercent).toBe(75);
    expect(v.usedTokens).toBe(2_500_000);
    expect(v.limitTokens).toBe(10_000_000);
  });

  it("past_due keeps access but flags the status", () => {
    const v = membershipView(status({ status: "past_due" }), null);
    if (v.kind !== "member") throw new Error("expected member");
    expect(v.statusLabel).toBe("past due");
    expect(v.pastDue).toBe(true);
  });

  it("live usage overrides the billing snapshot figures", () => {
    const usage: UsageCurrent = {
      tokens_used: 9_000_000,
      tokens_limit: 10_000_000,
      period: "2026-07",
      percent_used: 90,
      period_end: null,
    };
    const v = membershipView(status({ tier: "max" }), usage);
    if (v.kind !== "member") throw new Error("expected member");
    expect(v.title).toBe("Plan: Max · managed routing");
    expect(v.usedTokens).toBe(9_000_000);
    expect(v.remainingPercent).toBe(10);
  });

  it("uncapped/absent limit → no quota percent (never a fake 100%)", () => {
    const v = membershipView(
      status({ tier: "ultra", tokens_limit: null }),
      null,
    );
    if (v.kind !== "member") throw new Error("expected member");
    expect(v.remainingPercent).toBeNull();
  });
});
