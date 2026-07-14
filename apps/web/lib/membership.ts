// Membership-row model — the pure decision that drives the MEMBERSHIP section on
// the Providers page (and any other surface that wants the same "Plan: {Tier}"
// grammar). Kept framework-free so it's unit-tested directly; the component just
// renders whatever this returns.
//
// Honesty: we only claim "managed routing" for a genuinely active paid member.
// A signed-out visitor, a free (BYOK) account, or a cancelled sub all get the
// quiet upsell row — never a managed-routing badge they don't actually have.

import type { BillingStatus, UsageCurrent } from "./billing";

/** Capitalized tier labels — mirrors the dashboard's TIER_LABEL vocabulary. */
export const TIER_LABEL: Record<BillingStatus["tier"], string> = {
  free: "Free",
  starter: "Starter",
  pro: "Pro",
  max: "Max",
  ultra: "Ultra",
};

export interface MemberView {
  kind: "member";
  /** "Plan: Pro · managed routing" — the vetted signed-in grammar. */
  title: string;
  /** "no key needed — routes via Zintus managed keys" */
  subtitle: string;
  /** "active" | "past due" — surfaced as a small status pill. */
  statusLabel: string;
  pastDue: boolean;
  usedTokens: number | null;
  limitTokens: number | null;
  /** Percent of the monthly allowance remaining (0..100), for the quota bar. */
  remainingPercent: number | null;
}

export interface UpsellView {
  kind: "upsell";
  /** The single quiet-row sentence. */
  text: string;
  /** Where the row links (sign-in for signed-out, pricing for upgrades). */
  href: string;
  /** Trailing call-to-action, e.g. "Sign in" / "Upgrade". */
  cta: string;
}

export type MembershipView = MemberView | UpsellView;

/** An active paid member = a managed-key tier that isn't cancelled. */
export function isManagedMember(status: BillingStatus | null): boolean {
  return (
    !!status && status.tier !== "free" && status.status !== "cancelled"
  );
}

/**
 * Derive the membership row from the relay's billing status (+ optional live
 * usage). `null` status = not signed in / relay unreachable → the sign-in
 * upsell. A signed-in free or cancelled account → the upgrade upsell.
 */
export function membershipView(
  status: BillingStatus | null,
  usage: UsageCurrent | null = null,
): MembershipView {
  if (isManagedMember(status)) {
    const s = status!;
    const pastDue = s.status === "past_due";
    const limit = usage?.tokens_limit ?? s.tokens_limit;
    const used = usage?.tokens_used ?? s.tokens_used;
    const percentUsed =
      usage?.percent_used ??
      (limit && limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : null);
    const remainingPercent =
      percentUsed == null ? null : Math.max(0, 100 - Math.round(percentUsed));
    return {
      kind: "member",
      title: `Plan: ${TIER_LABEL[s.tier]} · managed routing`,
      subtitle: "no key needed — routes via Zintus managed keys",
      statusLabel: pastDue ? "past due" : "active",
      pastDue,
      usedTokens: used ?? null,
      limitTokens: limit ?? null,
      remainingPercent,
    };
  }
  // Signed in but not a paid member (free / cancelled) → upgrade upsell.
  if (status) {
    return {
      kind: "upsell",
      text: "Membership — upgrade to route without keys · from $15/mo",
      href: "/pricing",
      cta: "Upgrade",
    };
  }
  // Signed out (or relay unreachable) → sign-in upsell.
  return {
    kind: "upsell",
    text: "Membership — sign in to route without keys · from $15/mo",
    href: "/login",
    cta: "Sign in",
  };
}
