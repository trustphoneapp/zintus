/**
 * Zintus membership (managed tiers) client for the desktop app.
 * All calls ride lib/cloud.ts bearer auth. Plan constants mirror the PUBLIC
 * pricing page (apps/web/app/pricing) and the relay's TIERS — the relay is
 * the enforcement source of truth; these are display values only.
 */

import { relayFetch, RELAY_URL } from "./cloud";

export type ManagedTier = "starter" | "pro" | "max" | "ultra";

export interface PlanInfo {
  tier: ManagedTier;
  name: string;
  priceUsd: number;
  tokensPerMonth: number;
}

/** Display metadata for the purchasable plans (Free/BYOK is implicit). */
export const PLANS: PlanInfo[] = [
  { tier: "starter", name: "Starter", priceUsd: 15, tokensPerMonth: 1_000_000 },
  { tier: "pro", name: "Pro", priceUsd: 49, tokensPerMonth: 10_000_000 },
  { tier: "max", name: "Max", priceUsd: 99, tokensPerMonth: 50_000_000 },
  { tier: "ultra", name: "Ultra", priceUsd: 199, tokensPerMonth: 200_000_000 },
];

export interface BillingStatus {
  tier: ManagedTier | "free";
  status: "active" | "past_due" | "cancelled";
  tokens_used: number;
  tokens_limit: number | null;
  period_end: number | null;
  referral_code: string;
}

export async function fetchBillingStatus(): Promise<BillingStatus | null> {
  const res = await relayFetch("/api/billing/status").catch(() => null);
  if (!res?.ok) return null;
  return res.json();
}

export interface UsageCurrent {
  tokens_used: number;
  tokens_limit: number | null;
  period: string;
  percent_used: number | null;
  period_end: number | null;
}

export async function fetchUsageCurrent(): Promise<UsageCurrent | null> {
  const res = await relayFetch("/api/usage/current").catch(() => null);
  if (!res?.ok) return null;
  return res.json();
}

// ── Managed model catalog (public — honest: only key-configured models) ────

export interface ManagedModelInfo {
  id: string;
  display_name: string;
  context_window: number;
  multiplier: number;
  capabilities: { tools: boolean; json: boolean; vision: boolean };
}

export async function fetchManagedModels(): Promise<ManagedModelInfo[]> {
  // Public endpoint — no auth needed, so plans render before sign-in too.
  const res = await fetch(`${RELAY_URL}/v1/managed/models`).catch(() => null);
  if (!res?.ok) return [];
  const data = (await res.json()) as { models?: ManagedModelInfo[] };
  return data.models ?? [];
}

// ── Checkout / portal ───────────────────────────────────────────────────────

export type CheckoutResult =
  | { ok: true; url: string }
  | { ok: false; code: "billing_not_configured" | "managed_keys_unavailable" | "unauthorized" | "error"; message: string };

/**
 * Start a Stripe checkout for `tier`. Returns the URL to open in the browser,
 * or an HONEST structured failure — the relay 503s with a code while Stripe
 * prices/keys are not yet configured, and the UI must say so, not pretend.
 */
export async function createCheckout(tier: ManagedTier): Promise<CheckoutResult> {
  const res = await relayFetch("/api/billing/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tier }),
  }).catch(() => null);
  if (!res) return { ok: false, code: "error", message: "Could not reach the Zintus relay." };
  if (res.status === 401) {
    return { ok: false, code: "unauthorized", message: "Sign in to Zintus first." };
  }
  const data = (await res.json().catch(() => ({}))) as {
    url?: string;
    error?: { code?: string; message?: string } | string;
  };
  if (res.ok && data.url) return { ok: true, url: data.url };
  const err = typeof data.error === "object" ? data.error : { message: String(data.error ?? "") };
  const code =
    err?.code === "billing_not_configured" || err?.code === "managed_keys_unavailable"
      ? err.code
      : ("error" as const);
  return {
    ok: false,
    code,
    message:
      err?.message ??
      "Checkout is not available right now. Please try again later.",
  };
}

export async function createPortalUrl(): Promise<string | null> {
  const res = await relayFetch("/api/billing/portal", { method: "POST" }).catch(() => null);
  if (!res?.ok) return null;
  const data = (await res.json()) as { url?: string };
  return data.url ?? null;
}
