import type { Env } from './types.js';
import { STRIPE_PRICES, REFERRAL_RULES, TIERS, type Tier } from './tiers.js';

export async function createCheckoutSession(
  userId: string, userEmail: string,
  tier: 'starter' | 'growth' | 'scale' | 'pro',
  referralCode: string | null,
  env: Env,
): Promise<string> {
  const priceId = STRIPE_PRICES[`${tier}_monthly`];
  if (!priceId || priceId.startsWith('price_FILL')) {
    throw new Error(`Stripe price not configured for tier: ${tier}`);
  }

  const params = new URLSearchParams({
    mode: 'subscription',
    customer_email: userEmail,
    'line_items[0][price]': priceId,
    'line_items[0][quantity]': '1',
    success_url: `https://www.zintus.ai/dashboard/billing?upgraded=true&tier=${tier}`,
    cancel_url: 'https://www.zintus.ai/pricing',
    'metadata[user_id]': userId,
    'metadata[tier]': tier,
    'subscription_data[metadata][user_id]': userId,
  });
  if (referralCode) params.set('metadata[referral_code]', referralCode);

  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Stripe checkout error: ${err}`);
  }
  const session = await res.json() as { url: string };
  return session.url;
}

export async function createPortalSession(stripeCustomerId: string, env: Env): Promise<string> {
  const params = new URLSearchParams({
    customer: stripeCustomerId,
    return_url: 'https://www.zintus.ai/dashboard/billing',
  });
  const res = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params,
  });
  // Fail loud on the Stripe error path: a non-2xx response body has no `url`, so
  // reading it blindly would return `undefined` and hand the caller a broken
  // portal link (or throw deep in JSON parsing). Mirror createCheckoutSession.
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Stripe portal error: ${err}`);
  }
  const portal = await res.json() as { url: string };
  return portal.url;
}

/**
 * Cancel a Stripe subscription immediately (account deletion). Throws on a
 * non-2xx Stripe response so the caller can log it — the DELETE /api/account
 * handler wraps this in try/catch and NEVER lets a Stripe failure block the
 * account deletion (best-effort, see index.ts). Caller must guard that
 * STRIPE_SECRET_KEY is configured before calling.
 */
export async function cancelStripeSubscription(subscriptionId: string, env: Env): Promise<void> {
  const res = await fetch(`https://api.stripe.com/v1/subscriptions/${subscriptionId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Stripe cancel error: ${err}`);
  }
}

// Stripe's libraries reject events whose signed timestamp is more than 5 minutes
// (300s) from now, to bound replay of an intercepted (validly-signed) request.
// The `t` value is inside the signed payload, so it can't be moved without
// breaking the v1 HMAC — but a captured request replayed within seconds is still
// valid forever without this window. 300s matches Stripe's default tolerance.
//   https://docs.stripe.com/webhooks (Prevent replay attacks)
export const STRIPE_SIGNATURE_TOLERANCE_SECS = 300;

/**
 * True when the signed `t=` timestamp is within ±`toleranceSecs` of `nowSecs`.
 * Rejects (false) a missing/garbage timestamp. Separate from signature
 * verification so the HMAC check stays a pure function of (body, sig, secret).
 */
export function withinReplayWindow(
  sigHeader: string,
  nowSecs: number,
  toleranceSecs = STRIPE_SIGNATURE_TOLERANCE_SECS,
): boolean {
  const parts = Object.fromEntries(sigHeader.split(',').map(p => p.split('=')));
  const t = parseInt(parts['t'] ?? '', 10);
  if (!Number.isFinite(t)) return false;
  return Math.abs(nowSecs - t) <= toleranceSecs;
}

/**
 * Constant-time string equality. Used to compare the computed HMAC hex against
 * the attacker-supplied `v1` from the Stripe-Signature header. A plain `===`
 * short-circuits on the first differing byte, leaking — via response timing —
 * how many leading bytes of a forged signature were correct, which lets an
 * attacker recover a valid signature byte-by-byte.
 *
 * Cloudflare Workers expose WebCrypto but NOT Node's `crypto.timingSafeEqual`,
 * so we implement the compare directly: XOR-accumulate over every byte with no
 * early return, then check the accumulator once at the end. The leading length
 * comparison is safe to short-circuit — the expected HMAC length (64 hex chars
 * for SHA-256) is public, not secret, and only the equal-length case is where
 * content timing could leak anything.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

/** Verify Stripe webhook HMAC-SHA256 signature. */
export async function verifyStripeSignature(body: string, sigHeader: string, secret: string): Promise<boolean> {
  const parts = Object.fromEntries(sigHeader.split(',').map(p => p.split('=')));
  const timestamp = parts['t'];
  const v1 = parts['v1'];
  if (!timestamp || !v1) return false;

  const payload = `${timestamp}.${body}`;
  // The key is used with crypto.subtle.sign() below, so it must carry the
  // 'sign' usage. It was previously imported with ['verify'], which is a
  // WebCrypto spec violation (a verify-only key cannot sign) — strict runtimes
  // throw InvalidAccessError. Recomputing the HMAC and comparing is the correct
  // pattern here.
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const expected = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  const expectedHex = Array.from(new Uint8Array(expected)).map(b => b.toString(16).padStart(2, '0')).join('');
  // Constant-time compare (not `===`) so a forged signature can't be recovered
  // byte-by-byte from response-timing differences. See constantTimeEqual above.
  return constantTimeEqual(expectedHex, v1);
}

interface StripeEvent {
  /** Globally-unique event id (e.g. `evt_…`). Stable across redeliveries of the
   *  same event, so it is the dedup key for replay/at-least-once protection. */
  id?: string;
  type: string;
  data: { object: Record<string, unknown> };
}

// How long a processed event id is remembered in KV. Stripe redelivers a failed
// webhook with exponential backoff for up to ~3 days; a 7-day window comfortably
// covers that, so a retry of an already-SUCCESSFUL delivery is still deduped,
// while the entry self-expires (KV TTL) and never accumulates unbounded.
//   https://docs.stripe.com/webhooks#retries
export const STRIPE_EVENT_DEDUP_TTL_SECS = 60 * 60 * 24 * 7;

export async function handleStripeWebhook(request: Request, env: Env): Promise<Response> {
  const body = await request.text();
  const sig = request.headers.get('stripe-signature') ?? '';

  const valid = await verifyStripeSignature(body, sig, env.STRIPE_WEBHOOK_SECRET);
  if (!valid) return new Response('Invalid signature', { status: 400 });

  // Replay window: reject a (correctly-signed) event whose timestamp is stale or
  // future-dated beyond tolerance, BEFORE any DB write. Bounds replay of a
  // captured request. Must run after the signature check (a forged `t` fails the
  // HMAC) but before JSON.parse/persistence so a rejected event writes nothing.
  if (!withinReplayWindow(sig, Math.floor(Date.now() / 1000))) {
    return new Response('Timestamp outside tolerance', { status: 400 });
  }

  const event = JSON.parse(body) as StripeEvent;

  // ── Event-id idempotency / replay dedup ────────────────────────────────
  // Stripe delivers at-least-once: the same event can arrive more than once — a
  // network/processing retry, or a captured request replayed inside the 300s
  // signature window — each time carrying the SAME `id` (evt_…). Gate on it so the
  // side effects below run AT MOST once per event id.
  //   • already recorded → ACK 200 and do nothing (a 200 stops Stripe retrying)
  //   • first time       → record it, THEN process
  // We record BEFORE processing so a near-simultaneous redelivery is blocked while
  // this one is still in flight; if processing then throws we delete the marker
  // (see catch) so a genuinely-failed delivery is still retried. The side effects
  // are themselves idempotent (ON CONFLICT / INSERT OR IGNORE), so this is
  // defence-in-depth, not the sole guarantee. A signature-verified event is
  // expected to always carry an id; if one somehow does not we fail open and
  // process it (the idempotent writes are the backstop) rather than drop it.
  const dedupKey = event.id ? `stripe_evt:${event.id}` : null;
  if (dedupKey) {
    if (await env.KV.get(dedupKey)) return new Response('ok (duplicate)');
    await env.KV.put(dedupKey, '1', { expirationTtl: STRIPE_EVENT_DEDUP_TTL_SECS });
  }

  try {
    const obj = event.data.object;

    switch (event.type) {
      case 'checkout.session.completed': {
        const userId = obj['metadata'] && (obj['metadata'] as Record<string, string>)['user_id'];
        const tier = obj['metadata'] && (obj['metadata'] as Record<string, string>)['tier'];
        const referralCode = obj['metadata'] && (obj['metadata'] as Record<string, string>)['referral_code'];
        const customerId = obj['customer'] as string | null;
        const subscriptionId = obj['subscription'] as string | null;

        if (!userId || !tier) break;

        // tokens_limit is derived from the tier's monthly budget (TIERS) so the
        // dashboard's /api/usage/current + /api/billing/status report a real cap
        // immediately after checkout (the audit flagged it was never set).
        const tokensLimit = TIERS[tier as Tier]?.tokens_per_month ?? null;

        // Upsert subscription (idempotent via stripe_subscription_id unique
        // constraint). The `subscriptions` table is the single source of truth for
        // stripe_customer_id — the portal path reads it here, so we persist it on
        // this row only. (The previous `UPDATE zintus_users SET stripe_customer_id`
        // targeted a column that does not exist on zintus_users and silently
        // affected 0 rows; it has been removed — B4.)
        await env.DB.prepare(`
          INSERT INTO subscriptions (user_id, tier, stripe_customer_id, stripe_subscription_id, status, tokens_limit)
          VALUES (?, ?, ?, ?, 'active', ?)
          ON CONFLICT(stripe_subscription_id) DO UPDATE
            SET tier=excluded.tier, status='active',
                stripe_customer_id=COALESCE(excluded.stripe_customer_id, subscriptions.stripe_customer_id),
                tokens_limit=excluded.tokens_limit, updated_at=unixepoch()
        `).bind(userId, tier, customerId ?? null, subscriptionId ?? null, tokensLimit).run();

        // Record referral if code provided (self-referral guard)
        if (referralCode) {
          const referrerId = await env.KV.get(`referral_code:${referralCode}`);
          if (referrerId && referrerId !== userId) {
            const rule = REFERRAL_RULES[tier as keyof typeof REFERRAL_RULES];
            if (rule) {
              await env.DB.prepare(`
                INSERT OR IGNORE INTO referrals
                  (referrer_id, referred_id, referral_code, status, commission_tier, commission_type, commission_pct, commission_cents, months_remaining)
                VALUES (?,?,?,'pending',?,?,?,?,?)
              `).bind(
                referrerId, userId, referralCode, tier,
                rule.type, rule.pct, rule.cents,
                'months' in rule ? rule.months : 0,
              ).run();
            }
          }
        }
        break;
      }

      case 'invoice.paid': {
        const subscriptionId = obj['subscription'] as string | null;
        if (!subscriptionId) break;

        const sub = await env.DB.prepare(
          'SELECT user_id FROM subscriptions WHERE stripe_subscription_id = ?'
        ).bind(subscriptionId).first<{ user_id: string }>();
        if (!sub) break;

        // Reset the DENORMALISED D1 counter (reporting only). NOTE (quota period):
        // quota ENFORCEMENT does not read this column — it reads the QuotaCounter
        // DO, which is keyed on the calendar UTC month (`billingPeriod()` in
        // middleware/quota.ts). So the effective budget window is the calendar
        // month, by design: a new UTC month routes to a fresh DO instance (= a
        // clean reset) and `periodResetUnix()` reports that boundary. This D1 reset
        // on `invoice.paid` only realigns the cosmetic `tokens_used_this_period`
        // shown on the dashboard; it deliberately does NOT touch the DO. Aligning
        // the DO to the Stripe subscription anniversary would mean re-keying the DO
        // on the subscription period (a much larger change) and is moot while paid
        // tiers are disabled (MANAGED_KEYS_AVAILABLE=false). The calendar-month
        // contract is pinned by quota-middleware.test.ts (period-boundary test).
        await env.DB.prepare(
          'UPDATE subscriptions SET tokens_used_this_period=0, status=\'active\', updated_at=unixepoch() WHERE stripe_subscription_id=?'
        ).bind(subscriptionId).run();

        // Confirm pending referrals that are 30+ days old
        await env.DB.prepare(`
          UPDATE referrals SET status='confirmed', activated_at=unixepoch()
          WHERE referred_id=? AND status='pending'
            AND created_at <= unixepoch() - 60*60*24*30
        `).bind(sub.user_id).run();
        break;
      }

      case 'customer.subscription.updated': {
        const subscriptionId = obj['id'] as string;
        const status = obj['status'] as string;
        const items = obj['items'] as { data: Array<{ price: { id: string } }> } | undefined;
        const priceId = items?.data?.[0]?.price?.id;
        const newTier = priceId
          ? Object.entries(STRIPE_PRICES).find(([, id]) => id === priceId)?.[0]?.replace('_monthly', '')
          : null;

        // Stripe sends the renewed period window on this event; persist it so the
        // dashboard shows an accurate reset date and the token cap tracks the tier.
        const periodStart = (obj['current_period_start'] as number | undefined) ?? null;
        const periodEnd = (obj['current_period_end'] as number | undefined) ?? null;
        const tokensLimit = newTier ? (TIERS[newTier as Tier]?.tokens_per_month ?? null) : null;

        await env.DB.prepare(`
          UPDATE subscriptions
          SET status=?, tier=COALESCE(?,tier),
              current_period_start=COALESCE(?,current_period_start),
              current_period_end=COALESCE(?,current_period_end),
              tokens_limit=COALESCE(?,tokens_limit),
              updated_at=unixepoch()
          WHERE stripe_subscription_id=?
        `).bind(
          status === 'active' ? 'active' : status === 'past_due' ? 'past_due' : 'cancelled',
          newTier ?? null,
          periodStart,
          periodEnd,
          tokensLimit,
          subscriptionId,
        ).run();
        break;
      }

      case 'customer.subscription.deleted': {
        const subscriptionId = obj['id'] as string;
        await env.DB.prepare(
          'UPDATE subscriptions SET status=\'cancelled\', tier=\'free\', updated_at=unixepoch() WHERE stripe_subscription_id=?'
        ).bind(subscriptionId).run();
        break;
      }

      case 'invoice.payment_failed': {
        const subscriptionId = obj['subscription'] as string | null;
        if (subscriptionId) {
          await env.DB.prepare(
            'UPDATE subscriptions SET status=\'past_due\', updated_at=unixepoch() WHERE stripe_subscription_id=?'
          ).bind(subscriptionId).run();
        }
        break;
      }
    }
  } catch (err) {
    // Processing threw AFTER we marked the id seen. onError turns this into a 500,
    // so Stripe WILL redeliver the same id — release the marker so that redelivery
    // re-runs instead of being skipped as a duplicate. Best-effort: a cleanup
    // failure must never mask the original processing error.
    if (dedupKey) {
      try { await env.KV.delete(dedupKey); } catch { /* best-effort cleanup */ }
    }
    throw err;
  }

  return new Response('ok');
}
