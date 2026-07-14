/**
 * Pure resolver for the MEMBERSHIP block inside the chat composer's model picker
 * (`ProviderPicker`). Extracted so the branching — hidden while loading, active
 * member gets the managed group, everyone else gets one quiet upsell row — is
 * unit-testable without mounting the picker (same pattern as chat-top-strip.ts).
 *
 * The web chat send path now has a managed-membership client (lib/managed-chat.ts,
 * `POST /v1/managed/chat/completions` with the relay session cookie), so an active
 * member can pin a managed model and it is served relay-side against plan tokens —
 * no local gateway, no BYOK key. `MANAGED_ROUTING_ON_WEB` reflects that: it is the
 * one switch that turns the member rows selectable and swaps the footer from the
 * old "arrives on web soon" note to the live plan-token quota line.
 */
import type { BillingStatus, ManagedModelDto } from "./billing";
import { isManagedMember, TIER_LABEL } from "./membership";
import {
  modelPlanEconomics,
  planCostLabel,
  type PlanTier,
} from "./economics";

/**
 * Can the web chat send path actually route a managed-membership model
 * end-to-end? YES — lib/managed-chat.ts streams `POST /v1/managed/chat/completions`
 * with the session cookie, so member rows are pinnable and billed against plan
 * tokens. (Left as a named seam so tests can force the pre-client behavior.)
 */
export const MANAGED_ROUTING_ON_WEB = true;

/** The quiet footer line shown when managed routing isn't web-routable (seam
 *  off). With the client live this is superseded by the plan-token quota line. */
export const MANAGED_SOON_NOTE =
  "Managed routing arrives on web soon — available in the desktop app today";

/** Live plan-token quota footer for a member, e.g. "Plan tokens: 12,345 / 10M".
 *  Falls back to a used-only line when the relay reports no limit. */
export function planTokensFooter(billing: BillingStatus): string {
  const used = billing.tokens_used.toLocaleString();
  if (billing.tokens_limit && billing.tokens_limit > 0) {
    return `Plan tokens: ${used} / ${billing.tokens_limit.toLocaleString()}`;
  }
  return `Plan tokens: ${used} used`;
}

/** The quiet upsell row for signed-out / free / cancelled visitors. Mirrors the
 *  providers-page upsell grammar ("no keys needed · from $15/mo" → /pricing). */
export const MEMBERSHIP_UPSELL_TEXT =
  "Membership — no keys needed · from $15/mo";
export const MEMBERSHIP_UPSELL_HREF = "/pricing";

export interface MembershipModelRow {
  id: string;
  displayName: string;
  /** "−1,429 / 1K" | "Free" | "Upgrade" — from economics.planCostLabel, or null
   *  when the class isn't one we can price honestly (blank, never a guess). */
  planCost: string | null;
  /** The member's tier can't reach this class → the chip reads "Upgrade". */
  locked: boolean;
  /** Pinnable right now? Only when routing is web-supported AND not locked. */
  selectable: boolean;
}

export type ModelPickerMembership =
  | { kind: "hidden" }
  | { kind: "upsell"; text: string; href: string }
  | {
      kind: "member";
      /** "Membership — Pro" section header. */
      title: string;
      rows: MembershipModelRow[];
      /** Quiet footer note, or null once rows are genuinely routable. */
      footer: string | null;
    };

/**
 * Derive the membership block from the relay's billing status + managed catalog.
 *
 * @param loaded  false until the first billing fetch resolves — render nothing
 *                rather than flash an upsell at a paying member (or vice versa).
 * @param billing null = signed out / free / relay unreachable.
 * @param managedModels the relay's live managed catalog (only operator-keyed
 *                models appear; [] when the relay is unreachable).
 * @param routingOnWeb  test seam; defaults to the honest MANAGED_ROUTING_ON_WEB.
 */
export function resolveModelPickerMembership(
  loaded: boolean,
  billing: BillingStatus | null,
  managedModels: ManagedModelDto[],
  routingOnWeb: boolean = MANAGED_ROUTING_ON_WEB,
): ModelPickerMembership {
  if (!loaded) return { kind: "hidden" };

  if (!isManagedMember(billing)) {
    return {
      kind: "upsell",
      text: MEMBERSHIP_UPSELL_TEXT,
      href: MEMBERSHIP_UPSELL_HREF,
    };
  }

  const tier = billing!.tier as PlanTier; // isManagedMember excludes "free"

  const rows: MembershipModelRow[] = managedModels.map((m) => {
    const econ = modelPlanEconomics(m.class, tier);
    const locked = econ?.locked ?? false;
    return {
      id: m.id,
      displayName: m.display_name || m.id,
      planCost: econ ? planCostLabel(econ) : null,
      locked,
      selectable: routingOnWeb && !locked,
    };
  });

  // Reachable models first (cheapest debit up top), locked "Upgrade" ones last.
  rows.sort((a, b) => {
    if (a.locked !== b.locked) return a.locked ? 1 : -1;
    return debitOf(managedModels, a, tier) - debitOf(managedModels, b, tier);
  });

  return {
    kind: "member",
    title: `Membership — ${TIER_LABEL[billing!.tier]}`,
    rows,
    // Routable now → the live plan-token quota line; seam off → the old note.
    footer: routingOnWeb ? planTokensFooter(billing!) : MANAGED_SOON_NOTE,
  };
}

/** Sort helper: the model's plan-token debit for this tier (unpriceable → 0). */
function debitOf(
  models: ManagedModelDto[],
  row: MembershipModelRow,
  tier: PlanTier,
): number {
  const m = models.find((x) => x.id === row.id);
  const econ = m ? modelPlanEconomics(m.class, tier) : null;
  return econ?.debitPer1k ?? 0;
}
