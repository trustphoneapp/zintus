import type { Env } from './types.js';
import { STRIPE_PRICES, REFERRAL_RULES, TIERS, type Tier } from './tiers.js';

export async function createCheckoutSession(
  userId: string, userEmail: string,
  tier: 'starter' | 'growth' | 'scale',
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
  const portal = await res.json() as { url: string };
  return portal.url;
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
  return expectedHex === v1;
}

interface StripeEvent {
  type: string;
  data: { object: Record<string, unknown> };
}

export async function handleStripeWebhook(request: Request, env: Env): Promise<Response> {
  const body = await request.text();
  const sig = request.headers.get('stripe-signature') ?? '';

  const valid = await verifyStripeSignature(body, sig, env.STRIPE_WEBHOOK_SECRET);
  if (!valid) return new Response('Invalid signature', { status: 400 });

  const event = JSON.parse(body) as StripeEvent;
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

      // Reset monthly token counter
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

  return new Response('ok');
}
