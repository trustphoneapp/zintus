const RELAY_URL = process.env.NEXT_PUBLIC_RELAY_URL ?? 'https://relay.zintus.ai';

export interface BillingStatus {
  tier: 'free' | 'starter' | 'pro' | 'max' | 'ultra';
  status: 'active' | 'past_due' | 'cancelled';
  tokens_used: number;
  tokens_limit: number | null;
  period_end: number | null;
  referral_code: string;
}

export interface UsageCurrent {
  tokens_used: number;
  tokens_limit: number | null;
  period: string;
  percent_used: number | null;
  period_end: number | null;
}

export interface ReferralStats {
  total: number;
  confirmed: number;
  pending: number;
  earned_cents: number;
}

// One live managed model as the relay's public catalog reports it
// (GET /v1/managed/models). `class` is the pricing class and `min_tier` the
// cheapest tier that can reach it — both computed relay-side from tiers.ts, so
// they're the honest source for the Models page's per-row plan-token economics.
// Only models with a configured operator key appear here (never vaporware).
export interface ManagedModelDto {
  id: string;
  display_name: string;
  context_window: number;
  class: string;
  /** Plan tokens debited per 1K model tokens, keyed by tier id. */
  plan_tokens_per_1k: Record<string, number>;
  min_tier: string;
  capabilities: { tools: boolean; json: boolean; vision: boolean };
}

// Referral commissions accrue server-side (the relay tracks commission_cents via
// Stripe `invoice.paid`), but there is NO payout/disbursement path yet AND the
// managed-key paid tiers that generate those commissions are themselves gated
// (MANAGED_KEYS_AVAILABLE = false in app/pricing/page.tsx + the relay). Until a
// disbursement path ships, surfacing a non-zero "Earned $X" would imply real,
// withdrawable money the user cannot actually receive. Flip to true ONLY once
// referral payouts are genuinely live.
export const REFERRAL_PAYOUTS_LIVE = false;

/**
 * Honest label for the referral "Earned" stat. While payouts are gated we never
 * render a dollar figure (which would imply withdrawable earnings) — we render
 * "Coming soon". Once REFERRAL_PAYOUTS_LIVE flips, the accrued commission is
 * formatted as USD.
 */
export function formatReferralEarned(
  earnedCents: number,
  payoutsLive: boolean = REFERRAL_PAYOUTS_LIVE,
): string {
  if (!payoutsLive) return "Coming soon";
  return `$${(earnedCents / 100).toFixed(2)}`;
}

export async function fetchBillingStatus(): Promise<BillingStatus | null> {
  try {
    const res = await fetch(`${RELAY_URL}/api/billing/status`, { credentials: 'include' });
    if (!res.ok) return null;
    return res.json();
  } catch { return null; }
}

export async function fetchUsageCurrent(): Promise<UsageCurrent | null> {
  try {
    const res = await fetch(`${RELAY_URL}/api/usage/current`, { credentials: 'include' });
    if (!res.ok) return null;
    return res.json();
  } catch { return null; }
}

/** Live managed models from the relay. Returns [] on an offline/erroring relay. */
export async function fetchManagedModels(): Promise<ManagedModelDto[]> {
  try {
    const res = await fetch(`${RELAY_URL}/v1/managed/models`, { credentials: 'include' });
    if (!res.ok) return [];
    const body = await res.json() as { models?: ManagedModelDto[] };
    return body.models ?? [];
  } catch { return []; }
}

export async function fetchUsageHistory(): Promise<{ history: { day: string; tokens: number }[] } | null> {
  try {
    const res = await fetch(`${RELAY_URL}/api/usage/history`, { credentials: 'include' });
    if (!res.ok) return null;
    return res.json();
  } catch { return null; }
}

export async function fetchReferralStats(): Promise<ReferralStats | null> {
  try {
    const res = await fetch(`${RELAY_URL}/api/referral/stats`, { credentials: 'include' });
    if (!res.ok) return null;
    return res.json();
  } catch { return null; }
}

export async function createCheckout(tier: 'starter' | 'pro' | 'max' | 'ultra', ref?: string): Promise<string | null> {
  try {
    const res = await fetch(`${RELAY_URL}/api/billing/checkout`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier, ref }),
    });
    if (!res.ok) return null;
    const { url } = await res.json() as { url: string };
    return url;
  } catch { return null; }
}

export async function openBillingPortal(): Promise<string | null> {
  try {
    const res = await fetch(`${RELAY_URL}/api/billing/portal`, {
      method: 'POST',
      credentials: 'include',
    });
    if (!res.ok) return null;
    const { url } = await res.json() as { url: string };
    return url;
  } catch { return null; }
}
