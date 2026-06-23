const RELAY_URL = process.env.NEXT_PUBLIC_RELAY_URL ?? 'https://relay.zintus.ai';

export interface BillingStatus {
  tier: 'free' | 'starter' | 'growth' | 'scale';
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

export async function createCheckout(tier: 'starter' | 'growth' | 'scale', ref?: string): Promise<string | null> {
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
