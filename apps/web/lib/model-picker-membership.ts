/**
 * Pure resolver for the MEMBERSHIP block inside the chat composer's model picker
 * (`ProviderPicker`). Extracted so the branching — hidden while loading, active
 * member gets the managed group, everyone else gets one quiet upsell row — is
 * unit-testable without mounting the picker (same pattern as chat-top-strip.ts).
 *
 * HONESTY BOUNDARY. The web chat send path routes ONLY through the local gateway
 * (`streamChat` → `GATEWAY_URL/v1/chat/completions`). It has no managed-membership
 * client — that lives solely in the desktop app (apps/desktop/lib/managed-chat.ts,
 * `POST /v1/managed/chat/completions` with relay session auth). So on web today we
 * surface managed models to an active member with their real plan-token cost, but
 * we do NOT let them pin one (no dead sends). `MANAGED_ROUTING_ON_WEB` is the one
 * switch: flip it true the day the web send path gains a managed-chat client and
 * the rows become pinnable automatically.
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
 * end-to-end today? NO — see the module header. Keep this `false` until a web
 * managed-chat client exists; the moment it does, flip this and the member rows
 * become selectable with zero other changes.
 */
export const MANAGED_ROUTING_ON_WEB = false;

/** The single quiet footer line shown while managed routing isn't web-routable. */
export const MANAGED_SOON_NOTE =
  "Managed routing arrives on web soon — available in the desktop app today";

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
    footer: routingOnWeb ? null : MANAGED_SOON_NOTE,
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
