import { describe, expect, test } from "bun:test";
import {
  MANAGED_ROUTING_ON_WEB,
  MANAGED_SOON_NOTE,
  MEMBERSHIP_UPSELL_HREF,
  MEMBERSHIP_UPSELL_TEXT,
  planTokensFooter,
  resolveModelPickerMembership,
} from "./model-picker-membership";
import type { BillingStatus, ManagedModelDto } from "./billing";

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

function model(overrides: Partial<ManagedModelDto> = {}): ManagedModelDto {
  return {
    id: "m",
    display_name: "M",
    context_window: 128_000,
    class: "cheap",
    plan_tokens_per_1k: {},
    min_tier: "starter",
    capabilities: { tools: true, json: true, vision: false },
    ...overrides,
  };
}

describe("resolveModelPickerMembership", () => {
  test("managed routing is now web-supported (client shipped)", () => {
    // The web managed-chat client (lib/managed-chat.ts) is live, so member rows
    // are pinnable and billed against plan tokens. If this ever regresses to a
    // false seam, the selectable-rows + quota-footer tests below flag it.
    expect(MANAGED_ROUTING_ON_WEB).toBe(true);
  });

  test("hidden until billing has loaded (no flash of the wrong state)", () => {
    expect(
      resolveModelPickerMembership(false, billing(), [model()]),
    ).toEqual({ kind: "hidden" });
  });

  test("signed out (null billing) → quiet upsell to /pricing", () => {
    expect(resolveModelPickerMembership(true, null, [])).toEqual({
      kind: "upsell",
      text: MEMBERSHIP_UPSELL_TEXT,
      href: MEMBERSHIP_UPSELL_HREF,
    });
    expect(MEMBERSHIP_UPSELL_TEXT).toBe("Membership — no keys needed · from $15/mo");
    expect(MEMBERSHIP_UPSELL_HREF).toBe("/pricing");
  });

  test("free tier → the same upsell (BYOK account is not a managed member)", () => {
    expect(
      resolveModelPickerMembership(true, billing({ tier: "free" }), []),
    ).toMatchObject({ kind: "upsell", href: "/pricing" });
  });

  test("cancelled paid tier → upsell, never a managed group", () => {
    expect(
      resolveModelPickerMembership(true, billing({ status: "cancelled" }), [model()]),
    ).toMatchObject({ kind: "upsell" });
  });

  test("active Pro member → managed group titled with the tier, live plan-token footer", () => {
    const view = resolveModelPickerMembership(
      true,
      billing({ tier: "pro", tokens_used: 12_345, tokens_limit: 10_000_000 }),
      [model({ id: "gpt-x", display_name: "GPT-X", class: "premium" })],
    );
    if (view.kind !== "member") throw new Error("expected member");
    expect(view.title).toBe("Membership — Pro");
    // Footer is the live quota line, not the old "arrives soon" note.
    expect(view.footer).toBe("Plan tokens: 12,345 / 10,000,000");
  });

  test("planTokensFooter: with a limit → used / limit; without → used only", () => {
    expect(
      planTokensFooter(billing({ tokens_used: 500, tokens_limit: 1_000_000 })),
    ).toBe("Plan tokens: 500 / 1,000,000");
    expect(
      planTokensFooter(billing({ tokens_used: 42, tokens_limit: null })),
    ).toBe("Plan tokens: 42 used");
  });

  test("seam OFF (routingOnWeb=false) → old soon-note footer, nothing selectable", () => {
    const view = resolveModelPickerMembership(
      true,
      billing({ tier: "pro" }),
      [model({ id: "cheap-m", class: "cheap" })],
      false,
    );
    if (view.kind !== "member") throw new Error("expected member");
    expect(view.footer).toBe(MANAGED_SOON_NOTE);
    expect(MANAGED_SOON_NOTE).toBe(
      "Managed routing arrives on web soon — available in the desktop app today",
    );
    expect(view.rows.every((r) => r.selectable === false)).toBe(true);
  });

  test("row plan-cost chips mirror economics: reachable → −N/1K, gated → Upgrade, unpriceable → null; none selectable while not routable", () => {
    const view = resolveModelPickerMembership(
      true,
      billing({ tier: "pro" }),
      [
        model({ id: "cheap-m", class: "cheap" }),
        model({ id: "frontier-m", class: "frontier" }), // locked below Max
        model({ id: "gift-m", class: "free" }),
        model({ id: "weird-m", class: "banana" }), // unpriceable
      ],
    );
    if (view.kind !== "member") throw new Error("expected member");
    const byId = new Map(view.rows.map((r) => [r.id, r]));

    expect(byId.get("cheap-m")!.planCost).toBe("−286 / 1K");
    expect(byId.get("cheap-m")!.locked).toBe(false);

    expect(byId.get("frontier-m")!.planCost).toBe("Upgrade");
    expect(byId.get("frontier-m")!.locked).toBe(true);

    expect(byId.get("gift-m")!.planCost).toBe("Free");

    expect(byId.get("weird-m")!.planCost).toBeNull();

    // With the web client live, reachable rows are pinnable; locked ones never.
    expect(byId.get("cheap-m")!.selectable).toBe(true);
    expect(byId.get("gift-m")!.selectable).toBe(true);
    expect(byId.get("weird-m")!.selectable).toBe(true); // unpriceable but reachable
    expect(byId.get("frontier-m")!.selectable).toBe(false); // locked below Max
  });

  test("rows sort reachable-cheapest-first, locked Upgrade rows last", () => {
    const view = resolveModelPickerMembership(
      true,
      billing({ tier: "pro" }),
      [
        model({ id: "premium-m", class: "premium" }), // reachable, pricier
        model({ id: "frontier-m", class: "frontier" }), // locked
        model({ id: "cheap-m", class: "cheap" }), // reachable, cheapest
      ],
    );
    if (view.kind !== "member") throw new Error("expected member");
    expect(view.rows.map((r) => r.id)).toEqual([
      "cheap-m",
      "premium-m",
      "frontier-m",
    ]);
  });

  test("routingOnWeb seam ON: unlocked rows selectable, footer is the quota line", () => {
    const view = resolveModelPickerMembership(
      true,
      billing({ tier: "pro", tokens_used: 0, tokens_limit: null }),
      [
        model({ id: "cheap-m", class: "cheap" }),
        model({ id: "frontier-m", class: "frontier" }), // still locked
      ],
      true,
    );
    if (view.kind !== "member") throw new Error("expected member");
    expect(view.footer).toBe("Plan tokens: 0 used");
    const byId = new Map(view.rows.map((r) => [r.id, r]));
    expect(byId.get("cheap-m")!.selectable).toBe(true);
    expect(byId.get("frontier-m")!.selectable).toBe(false); // locked never routable
  });
});
