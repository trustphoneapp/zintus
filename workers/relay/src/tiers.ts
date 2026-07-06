// ── Managed-keys availability gate ────────────────────────────────────────
// Flipped to `true` on 2026-07-03: the managed backend now EXISTS — see
// src/managed.ts (`/v1/managed/*`): operator provider keys live as Cloudflare
// secrets, requests are served relay-side and metered via QuotaCounter. Actual
// purchasability is still (correctly) blocked by checkoutAvailability() until
// the [HUMAN] steps land: real STRIPE_PRICES + MANAGED_KEY_* secrets set.
export const MANAGED_KEYS_AVAILABLE = true;

// Tiers that require the managed-keys backend (i.e. everything except free/BYOK).
export const MANAGED_KEY_TIERS = ['starter', 'pro', 'max', 'ultra'] as const;

export const TIERS = {
  // `managed_keys` reflects whether the tier USES managed keys as its value prop;
  // whether that feature is currently purchasable is gated by
  // MANAGED_KEYS_AVAILABLE above (do not key purchasability off this field).
  //
  // tokens_per_month MUST equal the public pricing page (apps/web/app/pricing:
  // Starter 1M · Pro 10M · Max 50M · Ultra 200M). It is the USER-FACING plan
  // token allowance — the unit every receipt, dashboard and 429 body speaks.
  //
  // credits_per_month is INTERNAL ONLY (docs/economics/PRICING-FINAL.md).
  // Metering runs in millicredits (1 credit = 1,000 mc; debit = real tokens ×
  // CLASS_BURN, integer math). Conversion to user-facing plan tokens happens
  // ONLY at the display boundary:
  //   displayed = mc × tokens_per_month / (credits_per_month × 1000)
  // The word "credits" must never appear in any user-visible surface.
  free:    { tokens_per_month: null,         credits_per_month: null,    concurrent: 10,   rpm: 60,   managed_keys: false },
  starter: { tokens_per_month: 1_000_000,    credits_per_month: 15_000,  concurrent: 5,    rpm: 60,   managed_keys: true  },
  pro:  { tokens_per_month: 10_000_000,   credits_per_month: 35_000,  concurrent: 20,   rpm: 300,  managed_keys: true  },
  max:   { tokens_per_month: 50_000_000,   credits_per_month: 60_000,  concurrent: null, rpm: null, managed_keys: true  },
  ultra:     { tokens_per_month: 200_000_000,  credits_per_month: 120_000, concurrent: null, rpm: null, managed_keys: true  },
} as const;

export type Tier = keyof typeof TIERS;

// ── Model classes & burn rates (docs/economics/PRICING-FINAL.md Part 3) ────
// Burn = credits debited per 1K real tokens ⇒ ALSO millicredits per real
// token, which is why metering in millicredits needs no division anywhere.
// Owner-final values (2026-07-06): mid is 2 (not 3). Recorded consequence:
// a referred Starter member burning the whole grant on mid-class nets 27.1%
// (39.1% at the 40%-referred blend) — below the 40% worst-case target; all
// other tiers hold ≥42%. Accepted by owner. Typical Starter usage nets ~59%.
export type ModelClass = 'free' | 'cheap' | 'mid' | 'premium' | 'frontier' | 'ultra';

export const CLASS_BURN: Record<ModelClass, number> = {
  free: 0,      // GLM-flash gift models — no debit
  cheap: 1,     // ≤$0.20/M blended: Groq 8B, DeepSeek Flash, FlashX, Scout
  mid: 2,       // Gemini Flash, GPT-4o-mini, Mistral Small
  premium: 5,   // Haiku, Groq 70B, Mistral Large, MiniMax M3, Kimi
  frontier: 15, // Sonnet, GPT-5.4, GLM-5.2, Grok 4.3
  ultra: 46,    // Opus, GPT-5.5
};

// Which model classes each tier may use (Part 5). Free tier = gift models
// only; paid tiers stack one class per rung. Blocked models return the honest
// 403 upgrade error (code `model_requires_upgrade`), never a silent downgrade.
export const TIER_CLASS_ACCESS: Record<Tier, readonly ModelClass[]> = {
  free:    ['free'],
  starter: ['free', 'cheap', 'mid'],
  pro:     ['free', 'cheap', 'mid', 'premium'],
  max:     ['free', 'cheap', 'mid', 'premium', 'frontier'],
  ultra:   ['free', 'cheap', 'mid', 'premium', 'frontier', 'ultra'],
};

/** Cheapest tier whose class access includes `cls` (for upgrade messages). */
export function minTierForClass(cls: ModelClass): Tier {
  for (const tier of ['free', 'starter', 'pro', 'max', 'ultra'] as const) {
    if (TIER_CLASS_ACCESS[tier].includes(cls)) return tier;
  }
  return 'ultra';
}

/** User-facing plan tokens for a millicredit debit on `tier` (display ONLY). */
export function displayPlanTokens(mc: number, tier: Tier): number {
  const t = TIERS[tier];
  if (!t.tokens_per_month || !t.credits_per_month) return mc; // uncapped tiers: raw
  return Math.round((mc * t.tokens_per_month) / (t.credits_per_month * 1000));
}

/** Plan tokens debited per 1K REAL tokens of `cls`, for each paid tier —
 *  what model pickers show as "uses ~N plan tokens per 1K". Display only. */
export function planTokensPer1kByTier(cls: ModelClass): Record<string, number> {
  const out: Record<string, number> = {};
  for (const tier of ['starter', 'pro', 'max', 'ultra'] as const) {
    const t = TIERS[tier];
    out[tier] = Math.round((CLASS_BURN[cls] * 1000 * t.tokens_per_month) / (t.credits_per_month * 1000));
  }
  return out;
}

// ── Flat-fee services (Part 4) — priced in CREDITS, displayed via the same
// per-tier conversion as text usage. New meters wire through debitFlatFee().
export const FLAT_FEES_CREDITS = {
  image_flux: 12,      // FLUX-schnell generation
  image_premium: 72,   // gpt-image class generation
  deep_research: 150,  // Exa deep-reasoning session (model tokens billed separately)
  stt_10min: 3,        // Groq whisper-turbo per 10 minutes
} as const;

// ── Research sessions (Part 8) — separate monthly counter, not token burn.
// Sessions beyond the allotment fall back to a deep_research flat fee.
export const RESEARCH_SESSIONS_PER_MONTH: Record<Tier, number> = {
  free: 0, starter: 20, pro: 50, max: 100, ultra: 300,
};

// ── STRIPE TEST MODE (sandbox, livemode:false — no real money) ─────────────
// Set 2026-07-04 for the membership smoke. Tier keys were renamed 2026-07-04
// to match the Stripe products 1:1: starter(1M) / pro(10M) / max(50M) /
// ultra(200M). Before go-live, replace each id with the LIVE price id:
//   starter_monthly: 'price_FILL_FROM_STRIPE_LIVE'
//   pro_monthly:     'price_FILL_FROM_STRIPE_LIVE'
//   max_monthly:     'price_FILL_FROM_STRIPE_LIVE'
//   ultra_monthly:   'price_FILL_FROM_STRIPE_LIVE'
export const STRIPE_PRICES: Record<string, string> = {
  starter_monthly: 'price_1TpWqECHHqmpXopk9caifs35', // TEST · starter · 1M
  pro_monthly:  'price_1TpWqWCHHqmpXopklq1i3yaD', // TEST · pro · 10M
  max_monthly:   'price_1TpWqjCHHqmpXopkzifgFXRG', // TEST · max · 50M
  ultra_monthly:     'price_1TpWqsCHHqmpXopk6VRtHegV', // TEST · ultra · 200M
};

/** True when a real Stripe price (not a `price_FILL…` placeholder) is configured. */
export function isStripePriceConfigured(tier: string): boolean {
  const id = STRIPE_PRICES[`${tier}_monthly`];
  return !!id && !id.startsWith('price_FILL');
}

export interface CheckoutBlock {
  status: 503;
  code: 'managed_keys_unavailable' | 'billing_not_configured';
  message: string;
}

/**
 * Pre-flight gate for `/api/billing/checkout`. Returns a 503 descriptor when
 * checkout must NOT proceed, or null when it may. Two distinct failures:
 *   1. managed-key tiers are gated off (MANAGED_KEYS_AVAILABLE=false), or
 *   2. the flag is flipped on but STRIPE_PRICES are still placeholders — without
 *      this guard `createCheckoutSession` throws and the route surfaces a 500
 *      from the Stripe layer instead of a clear "not configured" signal.
 * `managedKeysAvailable` is injectable so the price-placeholder path is testable
 * without flipping the production constant.
 */
export function checkoutAvailability(
  tier: string,
  managedKeysAvailable: boolean = MANAGED_KEYS_AVAILABLE,
): CheckoutBlock | null {
  if (!managedKeysAvailable && (MANAGED_KEY_TIERS as readonly string[]).includes(tier)) {
    return {
      status: 503,
      code: 'managed_keys_unavailable',
      message: 'Managed-key tiers are coming soon and not yet available for purchase.',
    };
  }
  if (!isStripePriceConfigured(tier)) {
    return {
      status: 503,
      code: 'billing_not_configured',
      message: 'Billing is not configured yet. Please try again later.',
    };
  }
  return null;
}

// ── Referral commission (PRICING-FINAL Part 7) ─────────────────────────────
// 20% of GROSS subscription revenue (before Stripe fees), recurring 12 months,
// every tier. Simple enough for referrers to compute in their head:
// Starter $3.00 · Pro $9.80 · Max $19.80 · Ultra $39.80 per month.
export const REFERRAL_RATE = 0.20;
export const REFERRAL_MONTHS = 12;
// If more than 60% of new members in a month arrive referred, reduce
// REFERRAL_RATE to 0.15: commission is funded by the cheap-usage surplus of
// UNreferred members, and past ~60% penetration that surplus no longer covers
// the payout at 20% (margin floors bend — PRICING-FINAL Part 9). This is an
// operator dial, not automated; a monthly report should watch the ratio.
export const REFERRAL_PENETRATION_THRESHOLD = 0.60;

export const REFERRAL_RULES = {
  starter: { type: 'recurring' as const, cents: 0, pct: REFERRAL_RATE, months: REFERRAL_MONTHS },
  pro:  { type: 'recurring' as const, cents: 0,    pct: REFERRAL_RATE, months: REFERRAL_MONTHS },
  max:   { type: 'recurring' as const, cents: 0,   pct: REFERRAL_RATE, months: REFERRAL_MONTHS },
  ultra:     { type: 'recurring' as const, cents: 0, pct: REFERRAL_RATE, months: REFERRAL_MONTHS },
} as const;
