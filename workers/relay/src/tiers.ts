export const TIERS = {
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
