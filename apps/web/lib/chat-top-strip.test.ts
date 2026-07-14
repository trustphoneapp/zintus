import { describe, expect, test } from "bun:test";
import { resolveChatTopStrip, TIER_LABEL } from "./chat-top-strip";
import type { BillingStatus } from "./billing";

function billing(overrides: Partial<BillingStatus> = {}): BillingStatus {
  return {
    tier: "pro",
    status: "active",
    tokens_used: 0,
    tokens_limit: null,
    period_end: null,
    referral_code: "",
    ...overrides,
  };
}

describe("resolveChatTopStrip", () => {
  test("incognito wins over every other state", () => {
    expect(
      resolveChatTopStrip({
        incognito: true,
        gatewayConnected: true,
        localMode: false,
        signedInEmail: "a@b.com",
        billing: billing(),
        pathname: "/chat",
      }),
    ).toEqual({ kind: "private" });
  });

  test("offline suppresses the strip regardless of sign-in state", () => {
    expect(
      resolveChatTopStrip({
        incognito: false,
        gatewayConnected: false,
        localMode: true,
        signedInEmail: null,
        billing: null,
        pathname: "/chat",
      }),
    ).toEqual({ kind: "none" });

    expect(
      resolveChatTopStrip({
        incognito: false,
        gatewayConnected: false,
        localMode: false,
        signedInEmail: "a@b.com",
        billing: billing(),
        pathname: "/chat",
      }),
    ).toEqual({ kind: "none" });
  });

  test("signed-out + online → local-mode banner with a Google sign-in link back to the current path", () => {
    const state = resolveChatTopStrip({
      incognito: false,
      gatewayConnected: true,
      localMode: true,
      signedInEmail: null,
      billing: null,
      pathname: "/chat",
    });
    expect(state.kind).toBe("local");
    if (state.kind !== "local") throw new Error("expected local");
    expect(state.signInHref).toContain("/api/auth/google");
    expect(state.signInHref).toContain(encodeURIComponent("/chat"));
  });

  test("local-mode sign-in link falls back to /chat when pathname is unknown", () => {
    const state = resolveChatTopStrip({
      incognito: false,
      gatewayConnected: true,
      localMode: true,
      signedInEmail: null,
      billing: null,
      pathname: null,
    });
    if (state.kind !== "local") throw new Error("expected local");
    expect(state.signInHref).toContain(encodeURIComponent("/chat"));
  });

  test("signed-in with active billing shows the tier", () => {
    const state = resolveChatTopStrip({
      incognito: false,
      gatewayConnected: true,
      localMode: false,
      signedInEmail: "yashwanth@example.com",
      billing: billing({ tier: "pro", status: "active" }),
      pathname: "/chat",
    });
    expect(state).toEqual({
      kind: "signed-in",
      email: "yashwanth@example.com",
      tierLabel: TIER_LABEL.pro,
    });
  });

  test("signed-in but billing not active (past_due/cancelled) omits the tier segment", () => {
    const state = resolveChatTopStrip({
      incognito: false,
      gatewayConnected: true,
      localMode: false,
      signedInEmail: "yashwanth@example.com",
      billing: billing({ status: "past_due" }),
      pathname: "/chat",
    });
    expect(state).toEqual({
      kind: "signed-in",
      email: "yashwanth@example.com",
      tierLabel: null,
    });
  });

  test("signed-in but billing still loading (null) omits the tier segment rather than guessing", () => {
    const state = resolveChatTopStrip({
      incognito: false,
      gatewayConnected: true,
      localMode: false,
      signedInEmail: "yashwanth@example.com",
      billing: null,
      pathname: "/chat",
    });
    expect(state).toEqual({
      kind: "signed-in",
      email: "yashwanth@example.com",
      tierLabel: null,
    });
  });

  test("getMe() hasn't resolved yet (still loading) → render nothing (not a guess)", () => {
    const state = resolveChatTopStrip({
      incognito: false,
      gatewayConnected: true,
      localMode: false,
      signedInEmail: null,
      billing: null,
      pathname: "/chat",
    });
    expect(state).toEqual({ kind: "none" });
  });
});
