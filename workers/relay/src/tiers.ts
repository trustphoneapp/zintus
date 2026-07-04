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
  // Starter 1M · Pro 10M · Max 50M · Ultra 200M). These were 500k/5M/20M —
  // i.e. the relay would have granted LESS than the page sells. Enforcement
  // follows the promise, never the other way around.
  free:    { tokens_per_month: null,         concurrent: 10,   rpm: 60,   managed_keys: false },
  starter: { tokens_per_month: 1_000_000,    concurrent: 5,    rpm: 60,   managed_keys: true  },
  pro:  { tokens_per_month: 10_000_000,   concurrent: 20,   rpm: 300,  managed_keys: true  },
  max:   { tokens_per_month: 50_000_000,   concurrent: null, rpm: null, managed_keys: true  },
  ultra:     { tokens_per_month: 200_000_000,  concurrent: null, rpm: null, managed_keys: true  },
} as const;

export type Tier = keyof typeof TIERS;

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

export const REFERRAL_RULES = {
  starter: { type: 'one_time'  as const, cents: 1500, pct: 0,    months: 0  },
  pro:  { type: 'recurring' as const, cents: 0,    pct: 0.20, months: 12 },
  max:   { type: 'recurring' as const, cents: 0,    pct: 0.20, months: 12 },
  ultra:     { type: 'recurring' as const, cents: 0,    pct: 0.20, months: 12 },
} as const;
