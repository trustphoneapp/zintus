import type { Env, SubscriptionRow } from '../types.js';
import { TIERS, type Tier } from '../tiers.js';

function billingPeriod(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export async function enforceQuota(
  userId: string, env: Env
): Promise<{ allowed: boolean; tier: Tier; sub: SubscriptionRow | null }> {
  const sub = await env.DB.prepare(
    'SELECT * FROM subscriptions WHERE user_id = ? AND status IN (?, ?)'
  ).bind(userId, 'active', 'past_due').first<SubscriptionRow>();

  const tier = (sub?.tier ?? 'free') as Tier;
  const limits = TIERS[tier];

  if (!limits.tokens_per_month) return { allowed: true, tier, sub: sub ?? null };

  const period = billingPeriod();
  const used = parseInt(await env.KV.get(`quota:${userId}:${period}`) ?? '0', 10);
  return { allowed: used < limits.tokens_per_month, tier, sub: sub ?? null };
}

export async function recordUsage(
  userId: string, provider: string, model: string,
  inputTokens: number, outputTokens: number, env: Env
): Promise<void> {
  const total = inputTokens + outputTokens;
  const period = billingPeriod();

  // Fast KV increment (note: non-atomic; acceptable for MVP quota approximation)
  const current = parseInt(await env.KV.get(`quota:${userId}:${period}`) ?? '0', 10);
  await env.KV.put(`quota:${userId}:${period}`, String(current + total), {
    expirationTtl: 60 * 60 * 24 * 35,
  });

  // D1 analytics log (fire-and-forget — wrapped in ctx.waitUntil by caller)
  await env.DB.prepare(
    'INSERT INTO usage_log (user_id,provider,model,input_tokens,output_tokens,total_tokens) VALUES (?,?,?,?,?,?)'
  ).bind(userId, provider, model, inputTokens, outputTokens, total).run();

  // Subscription counter
  await env.DB.prepare(
    'UPDATE subscriptions SET tokens_used_this_period=tokens_used_this_period+?, updated_at=unixepoch() WHERE user_id=?'
  ).bind(total, userId).run();
}
