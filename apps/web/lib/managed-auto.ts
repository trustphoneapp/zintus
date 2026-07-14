/**
 * Pure resolver for the Auto managed-membership FALLBACK — the route a member
 * gets on the composer's "Auto" setting (no pinned provider, no pinned managed
 * model) when the local BYOK path can't serve them (no gateway, no keys). The
 * relay can still serve their plan tokens, so rather than dead-end them on "No
 * gateway connected" we pick one honest managed model to route through.
 *
 * Kept framework-free (same pattern/tone as model-picker-membership.ts) so the
 * class-preference + cheapest-debit choice is unit-tested directly; the send
 * path just consumes the id this returns. Returning `null` means "no honest
 * fallback exists — keep the existing behavior" (empty catalog / all locked).
 */
import type { BillingStatus, ManagedModelDto } from "./billing";
import { isManagedMember } from "./membership";
import { modelPlanEconomics, type PlanTier } from "./economics";

/**
 * Auto's class preference — a balanced default that protects plan tokens: a
 * "mid" model first, then "cheap", then "premium", then a gift "free" class;
 * anything else (frontier/ultra) sorts last. Lower rank wins.
 */
function classRank(cls: string): number {
  switch (cls) {
    case "mid":
      return 0;
    case "cheap":
      return 1;
    case "premium":
      return 2;
    case "free":
      return 3;
    default:
      return 4;
  }
}

/**
 * Pick the managed model Auto should fall back to for a member on `tier`.
 * A model is a candidate only when its class prices honestly on this tier
 * (`econ` non-null) and the tier can actually reach it (`!econ.locked`). Among
 * candidates we take the most-preferred class (see `classRank`), then the
 * lowest plan-token debit within it, with a deterministic id tie-break.
 * Returns the model id, or `null` when nothing qualifies.
 */
export function pickAutoManagedModel(
  managedModels: ManagedModelDto[],
  tier: PlanTier,
): string | null {
  let best: { id: string; rank: number; debit: number } | null = null;
  for (const m of managedModels) {
    const econ = modelPlanEconomics(m.class, tier);
    if (!econ || econ.locked) continue; // unpriceable or above the member's tier
    const cand = { id: m.id, rank: classRank(m.class), debit: econ.debitPer1k };
    if (
      !best ||
      cand.rank < best.rank ||
      (cand.rank === best.rank && cand.debit < best.debit) ||
      (cand.rank === best.rank && cand.debit === best.debit && cand.id < best.id)
    ) {
      best = cand;
    }
  }
  return best?.id ?? null;
}

/**
 * Is the Auto managed fallback even eligible for this turn? True only when
 * routing is web-supported, the user is an active managed member, and NOTHING
 * is pinned (no provider, no managed model) — i.e. genuine Auto. The
 * gateway/keys "is the local route usable?" checks live at the call site (they
 * need live store state), not here.
 */
export function canAutoManagedFallback(params: {
  routingOnWeb: boolean;
  billing: BillingStatus | null;
  selectedProvider: string | null;
  managedModel: string | null;
}): boolean {
  return (
    params.routingOnWeb &&
    isManagedMember(params.billing) &&
    !params.selectedProvider &&
    !params.managedModel
  );
}
