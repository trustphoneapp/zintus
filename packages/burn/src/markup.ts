import type { ModelClass } from "./rates.js";

/**
 * PUBLIC markup multipliers, by model class.
 *
 * DESIGN CONSTRAINT (do not weaken): the markup is public data, structured to
 * be shown — not a hidden constant. Zintus's position is "every AI service
 * marks up; we're the only one who shows you the number", so this table is
 * rendered verbatim on the public pricing page and in every burn receipt.
 * Anything that makes these numbers harder to display (per-model hand-tuning,
 * request-time overrides, env-var tweaks) breaks the product's core promise.
 *
 * The spread (higher multiple on cheaper models) is also public rationale:
 * a 1.5x markup on a $0.14/1M model costs the user fractions of a cent and
 * funds the platform; frontier models carry thinner multiples because their
 * raw cost is already dollars per session.
 */
export const PUBLIC_MARKUP: Readonly<Record<ModelClass, number>> = {
  free: 1,
  cheap: 1.5,
  mid: 1.4,
  frontier: 1.3,
  ultra: 1.25,
};

/** The multiplier applied to a model class. Public data — see PUBLIC_MARKUP. */
export function multiplierFor(cls: ModelClass): number {
  return PUBLIC_MARKUP[cls];
}

/**
 * Subscription tiers, matching the relay's tier ids (`workers/relay/src/tiers.ts`).
 * Kept as a plain union here so this package stays dependency-free of the relay.
 */
// NOTE: tier "ultra" (subscription) and model class "ultra" (price band) are
// distinct enums that happen to share a name after the 2026-07-04 tier rename
// (growth→pro, scale→max, + new top tier ultra).
export type BurnTier = "free" | "starter" | "pro" | "max" | "ultra";

/**
 * Which model classes each tier may burn managed credits on.
 *
 * Gating — not just pricing — is the margin protection: one output-heavy
 * frontier session can burn dollars, which goes instantly negative-margin on
 * a $15 plan. Frontier/ultra live on the higher tiers where their usage is
 * self-funding. (BYOK usage is unaffected: users routing on their own keys
 * pay their provider directly and this matrix never applies.)
 */
export const TIER_MODEL_ACCESS: Readonly<Record<BurnTier, readonly ModelClass[]>> = {
  free: ["free", "cheap"],
  starter: ["free", "cheap", "mid"],
  pro: ["free", "cheap", "mid", "frontier"],
  max: ["free", "cheap", "mid", "frontier", "ultra"],
  ultra: ["free", "cheap", "mid", "frontier", "ultra"],
};

/** Whether `tier` may burn managed credits on a model of class `cls`. */
export function isModelAllowed(tier: BurnTier, cls: ModelClass): boolean {
  return TIER_MODEL_ACCESS[tier].includes(cls);
}

/**
 * One row of the public "what we charge" table: raw provider rate, Zintus
 * rate, and the margin, per 1M tokens. This is the Everlane move as a data
 * structure — the pricing page renders these rows directly.
 */
export interface PublicRateRow {
  class: ModelClass;
  multiplier: number;
  rawInPer1M: number;
  rawOutPer1M: number;
  zintusInPer1M: number;
  zintusOutPer1M: number;
  /** Margin per 1M tokens, in/out — literally `zintus − raw`. */
  marginInPer1M: number;
  marginOutPer1M: number;
}

/** Build a displayable public rate row from raw per-1M provider rates. */
export function publicRateRow(
  cls: ModelClass,
  rawInPer1M: number,
  rawOutPer1M: number,
): PublicRateRow {
  const multiplier = multiplierFor(cls);
  const zintusIn = round6(rawInPer1M * multiplier);
  const zintusOut = round6(rawOutPer1M * multiplier);
  return {
    class: cls,
    multiplier,
    rawInPer1M,
    rawOutPer1M,
    zintusInPer1M: zintusIn,
    zintusOutPer1M: zintusOut,
    marginInPer1M: round6(zintusIn - rawInPer1M),
    marginOutPer1M: round6(zintusOut - rawOutPer1M),
  };
}

/** Round to 6 decimals — enough for $/1M display without float noise. */
function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
