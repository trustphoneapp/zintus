// ── Managed-keys availability gate ────────────────────────────────────────
// The managed-key (operator-decryptable Pro key custody) backend has been
// REMOVED from the relay — it was scaffold, wired into zero routes. Until a
// real backend ships, the paid tiers that depend on it must NOT be purchasable.
// This is the single re-enable toggle: flip to `true` once managed keys are
// actually implemented and the checkout flow can safely create Stripe sessions
// for starter/growth/scale again.
export const MANAGED_KEYS_AVAILABLE = false;

// Tiers that require the managed-keys backend (i.e. everything except free/BYOK).
export const MANAGED_KEY_TIERS = ['starter', 'growth', 'scale'] as const;

export const TIERS = {
  // `managed_keys` reflects whether the tier USES managed keys as its value prop;
  // whether that feature is currently purchasable is gated by
  // MANAGED_KEYS_AVAILABLE above (do not key purchasability off this field).
  free:    { tokens_per_month: null,        concurrent: 10,   rpm: 60,   managed_keys: false },
  starter: { tokens_per_month: 500_000,     concurrent: 5,    rpm: 60,   managed_keys: true  },
  growth:  { tokens_per_month: 5_000_000,   concurrent: 20,   rpm: 300,  managed_keys: true  },
  scale:   { tokens_per_month: 20_000_000,  concurrent: null, rpm: null, managed_keys: true  },
} as const;

export type Tier = keyof typeof TIERS;

// Fill these from Stripe dashboard after creating products
export const STRIPE_PRICES: Record<string, string> = {
  starter_monthly: 'price_FILL_FROM_STRIPE',
  growth_monthly:  'price_FILL_FROM_STRIPE',
  scale_monthly:   'price_FILL_FROM_STRIPE',
};

export const REFERRAL_RULES = {
  starter: { type: 'one_time'  as const, cents: 1500, pct: 0,    months: 0  },
  growth:  { type: 'recurring' as const, cents: 0,    pct: 0.20, months: 12 },
  scale:   { type: 'recurring' as const, cents: 0,    pct: 0.20, months: 12 },
} as const;
