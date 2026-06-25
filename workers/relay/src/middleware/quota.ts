import type { Env, SubscriptionRow } from '../types.js';
import { TIERS, type Tier } from '../tiers.js';

/** Current billing period key, `YYYY-MM` in UTC. Shared by all readers/writers. */
export function billingPeriod(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Unix-seconds timestamp of the next period reset (first of next month, UTC). */
export function periodResetUnix(): number {
  const d = new Date();
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000);
}

// ── Atomic quota counter (Durable Object) ──────────────────────────────────
// One QuotaCounter instance per `user:period`. The DO is the single source of
// truth for tokens used this period — strongly consistent and atomic, unlike the
// previous KV read-modify-write which lost concurrent increments (see
// QuotaCounter.ts for the full rationale + Cloudflare refs).

function counterStub(env: Env, userId: string, period: string) {
  const id = env.QUOTA_COUNTER.idFromName(`${userId}:${period}`);
  return env.QUOTA_COUNTER.get(id);
}

/** Read tokens used by `userId` in the current period (atomic counter). */
export async function getQuotaUsed(env: Env, userId: string): Promise<number> {
  const res = await counterStub(env, userId, billingPeriod()).fetch('https://quota/get');
  const { total } = (await res.json()) as { total: number };
  return total ?? 0;
}

/** Atomically add `tokens` to the current-period counter; returns the new total. */
async function addQuotaUsed(env: Env, userId: string, tokens: number): Promise<number> {
  const res = await counterStub(env, userId, billingPeriod()).fetch('https://quota/add', {
    method: 'POST',
    body: String(tokens),
  });
  const { total } = (await res.json()) as { total: number };
  return total;
}

export interface QuotaResult {
  allowed: boolean;
  tier: Tier;
  sub: SubscriptionRow | null;
  /** Tokens used this period (0 when the tier is uncapped). */
  used: number;
  /** Monthly token budget, or null for an uncapped tier (free/BYOK). */
  limit: number | null;
  /** Unix-seconds when the budget resets. */
  reset: number;
}

export async function enforceQuota(userId: string, env: Env): Promise<QuotaResult> {
  const sub = await env.DB.prepare(
    'SELECT * FROM subscriptions WHERE user_id = ? AND status IN (?, ?)'
  ).bind(userId, 'active', 'past_due').first<SubscriptionRow>();

  const tier = (sub?.tier ?? 'free') as Tier;
  const limit = TIERS[tier].tokens_per_month;
  const reset = periodResetUnix();

  // Uncapped tier (free/BYOK): no token budget to enforce.
  if (!limit) return { allowed: true, tier, sub: sub ?? null, used: 0, limit: null, reset };

  const used = await getQuotaUsed(env, userId);
  return { allowed: used < limit, tier, sub: sub ?? null, used, limit, reset };
}

export async function recordUsage(
  userId: string, provider: string, model: string,
  inputTokens: number, outputTokens: number, env: Env
): Promise<void> {
  const total = inputTokens + outputTokens;

  // Atomic increment via the Durable Object counter (no lost-update race).
  await addQuotaUsed(env, userId, total);

  // D1 analytics log (fire-and-forget — wrapped in ctx.waitUntil by caller).
  await env.DB.prepare(
    'INSERT INTO usage_log (user_id,provider,model,input_tokens,output_tokens,total_tokens) VALUES (?,?,?,?,?,?)'
  ).bind(userId, provider, model, inputTokens, outputTokens, total).run();

  // Subscription counter (denormalised, for invoice-period reset + reporting).
  await env.DB.prepare(
    'UPDATE subscriptions SET tokens_used_this_period=tokens_used_this_period+?, updated_at=unixepoch() WHERE user_id=?'
  ).bind(total, userId).run();
}
