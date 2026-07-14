// Plan-token economics — the single client-side mirror of the relay's pricing
// truth in workers/relay/src/tiers.ts (CLASS_BURN + TIERS + TIER_CLASS_ACCESS).
//
// This is the one place the web app encodes those numbers; the marketing
// pricing page (app/pricing/page.tsx) and the signed-in Models directory both
// import from here so a rate never drifts between two hand-copied tables. The
// relay's own tests pin the server side — if tiers.ts changes, update the three
// constants below (RATE_TIERS, CLASS_ECONOMICS) and economics.test.ts will fail
// until the mirror matches.
//
// Vocabulary rule: user-facing = "plan tokens". Internal "credits" is an
// implementation unit and never surfaces in any string this module produces.

/** Purchasable managed-key tiers (free is BYOK-only, never appears here). */
export type PlanTier = "starter" | "pro" | "max" | "ultra";

/** Model pricing classes — mirror of `ModelClass` in tiers.ts. */
export type ModelClass =
  | "free"
  | "cheap"
  | "mid"
  | "premium"
  | "frontier"
  | "ultra";

/**
 * Per-tier token allowance + internal credit budget — mirror of TIERS in
 * tiers.ts (tokens_per_month / credits_per_month). Only the paid, managed-key
 * tiers appear (the free tier carries no allowance).
 */
export const RATE_TIERS = [
  { id: "starter", label: "Starter", allowance: 1_000_000, credits: 15_000 },
  { id: "pro", label: "Pro", allowance: 10_000_000, credits: 35_000 },
  { id: "max", label: "Max", allowance: 50_000_000, credits: 60_000 },
  { id: "ultra", label: "Ultra", allowance: 200_000_000, credits: 120_000 },
] as const satisfies readonly {
  id: PlanTier;
  label: string;
  allowance: number;
  credits: number;
}[];

export type RateTier = (typeof RATE_TIERS)[number];

/** Cheapest-first tier order — mirror of the array in TIER_CLASS_ACCESS. */
export const TIER_ORDER = ["starter", "pro", "max", "ultra"] as const;

/**
 * Burn rate (credits per 1K model tokens, mirror of CLASS_BURN) + the cheapest
 * tier whose TIER_CLASS_ACCESS includes the class (mirror of minTierForClass).
 * `minTier: "free"` marks a gift class every paid tier can reach (never locked).
 */
export const CLASS_ECONOMICS: Record<
  ModelClass,
  { burn: number; minTier: PlanTier | "free" }
> = {
  free: { burn: 0, minTier: "free" },
  cheap: { burn: 1, minTier: "starter" },
  mid: { burn: 2, minTier: "starter" },
  premium: { burn: 5, minTier: "pro" },
  frontier: { burn: 15, minTier: "max" },
  ultra: { burn: 46, minTier: "ultra" },
};

/** True when `value` is a real managed pricing class we can price honestly. */
export function isModelClass(value: string): value is ModelClass {
  return Object.prototype.hasOwnProperty.call(CLASS_ECONOMICS, value);
}

/** Plan tokens debited per 1K model tokens for a burn rate on a tier. */
export function planPer1k(burn: number, tier: RateTier): number {
  return Math.round((burn * 1000 * tier.allowance) / (tier.credits * 1000));
}

export interface ModelPlanEconomics {
  /** Plan tokens debited per 1K model tokens on the member's tier (0 = gift). */
  debitPer1k: number;
  /** True when the member's tier cannot reach this class (needs an upgrade). */
  locked: boolean;
}

/**
 * The per-model plan-token economics for a signed-in member's own tier. Returns
 * `null` when the class isn't one we can price (honest blank, never a guess).
 */
export function modelPlanEconomics(
  cls: string,
  tierId: PlanTier,
): ModelPlanEconomics | null {
  if (!isModelClass(cls)) return null;
  const info = CLASS_ECONOMICS[cls];
  const tier = RATE_TIERS.find((t) => t.id === tierId);
  if (!tier) return null;
  // minTier "free" isn't in TIER_ORDER → indexOf -1 → never locked for a paid tier.
  const minIdx = TIER_ORDER.indexOf(info.minTier as PlanTier);
  const locked = TIER_ORDER.indexOf(tierId) < minIdx;
  const debitPer1k = info.burn === 0 ? 0 : planPer1k(info.burn, tier);
  return { debitPer1k, locked };
}

/**
 * Compact per-row label for the Models "Plan cost" cell. Mirrors the pricing
 * page's cell grammar: locked classes read "Upgrade", a gift class reads
 * "Free", everything else "−N / 1K".
 */
export function planCostLabel(e: ModelPlanEconomics): string {
  if (e.locked) return "Upgrade";
  if (e.debitPer1k === 0) return "Free";
  return `−${e.debitPer1k.toLocaleString()} / 1K`;
}
