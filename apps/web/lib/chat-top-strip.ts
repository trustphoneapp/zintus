/**
 * Pure resolver for the chat page's top strip (goal: a signed-in member sees
 * their membership without visiting the dashboard). Extracted out of
 * app/(app)/chat/page.tsx so the branching — incognito > offline-suppressed >
 * local-mode (signed out) > signed-in-with-plan > nothing — is unit-testable
 * without mounting the whole chat screen.
 *
 * Vocabulary matches the desktop app's account footer ("Plan: Pro · manage")
 * and the web Sidebar's plan chip, so all three surfaces read as one product.
 */
import { googleSignInUrl } from "@/lib/cloud";
import type { BillingStatus } from "@/lib/billing";

export const TIER_LABEL: Record<BillingStatus["tier"], string> = {
  free: "Free",
  starter: "Starter",
  pro: "Pro",
  max: "Max",
  ultra: "Ultra",
};

export type ChatTopStripState =
  | { kind: "none" }
  | { kind: "private" }
  | { kind: "local"; signInHref: string }
  | { kind: "signed-in"; email: string; tierLabel: string | null };

export interface ChatTopStripInput {
  /** Private/incognito thread — takes priority over everything else. */
  incognito: boolean;
  /** The offline-banner suppression gate: nothing renders while the gateway
   *  is unreachable, signed in or not. */
  gatewayConnected: boolean;
  /** getMe() resolved to `{authenticated: false}` (or hasn't resolved yet). */
  localMode: boolean;
  /** Real email from getMe(), null while loading or signed out. */
  signedInEmail: string | null;
  /** Real billing status from fetchBillingStatus(), null while loading,
   *  unset, or the relay was unreachable (fails silent to "no tier shown"). */
  billing: BillingStatus | null;
  /** Current path, so the Google OAuth round-trip lands the user back here. */
  pathname: string | null;
}

export function resolveChatTopStrip(input: ChatTopStripInput): ChatTopStripState {
  if (input.incognito) return { kind: "private" };
  if (!input.gatewayConnected) return { kind: "none" };
  if (input.localMode) {
    return { kind: "local", signInHref: googleSignInUrl(input.pathname || "/chat") };
  }
  if (input.signedInEmail) {
    const tierLabel =
      input.billing?.status === "active" ? TIER_LABEL[input.billing.tier] : null;
    return { kind: "signed-in", email: input.signedInEmail, tierLabel };
  }
  // getMe() hasn't resolved yet (localMode still at its default `false` and
  // no email yet) — say nothing rather than guess.
  return { kind: "none" };
}
