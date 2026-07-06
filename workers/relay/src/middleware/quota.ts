import type { Env, SubscriptionRow } from '../types.js';
import { TIERS, displayPlanTokens, type Tier } from '../tiers.js';

// Quota period is the CALENDAR UTC month, by design. The QuotaCounter DO is
// keyed on `${userId}:${billingPeriod()}` so a new UTC month routes to a fresh
// DO instance — that IS the budget reset (no explicit zeroing needed). Stripe's
// `invoice.paid` resets only the cosmetic D1 `tokens_used_this_period`, never the
// DO; aligning enforcement to the subscription anniversary would require re-keying
// the DO and is moot while paid tiers are disabled. See billing.ts invoice.paid.
// `now` is injectable so the month-boundary behaviour is unit-testable.

/** Current billing period key, `YYYY-MM` in UTC. Shared by all readers/writers. */
export function billingPeriod(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Unix-seconds timestamp of the next period reset (first of next month, UTC). */
export function periodResetUnix(now: Date = new Date()): number {
  return Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1) / 1000);
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

/**
 * Wipe the current-period quota counter for `userId` (account deletion).
 * Addresses the same DO instance enforceQuota reads (`${userId}:${period}`) and
 * clears its storage. Only the current period is meaningful — past-period
 * instances self-prune via their idle alarm (see QuotaCounter.ts).
 */
export async function resetQuota(env: Env, userId: string): Promise<void> {
  await counterStub(env, userId, billingPeriod()).fetch('https://quota/reset', {
    method: 'POST',
  });
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
  /** USER-FACING plan tokens used this period (0 when the tier is uncapped). */
  used: number;
  /** USER-FACING monthly plan-token allowance, or null for an uncapped tier. */
  limit: number | null;
  /** Unix-seconds when the budget resets. */
  reset: number;
}

// The QuotaCounter DO stores MILLICREDITS (PRICING-FINAL: 1 credit = 1,000 mc;
// debit = real tokens × CLASS_BURN, so mc stays integer with zero division).
// Everything that leaves this module toward a client (`used`/`limit` in the
// QuotaResult, hence 429 bodies and dashboards) is converted to user-facing
// plan tokens via displayPlanTokens() — internal units never escape.

export async function enforceQuota(userId: string, env: Env): Promise<QuotaResult> {
  const sub = await env.DB.prepare(
    'SELECT * FROM subscriptions WHERE user_id = ? AND status IN (?, ?)'
  ).bind(userId, 'active', 'past_due').first<SubscriptionRow>();

  const tier = (sub?.tier ?? 'free') as Tier;
  const t = TIERS[tier];
  const reset = periodResetUnix();

  // Uncapped tier (free/BYOK): no token budget to enforce.
  if (!t.tokens_per_month || !t.credits_per_month) {
    return { allowed: true, tier, sub: sub ?? null, used: 0, limit: null, reset };
  }

  const usedMc = await getQuotaUsed(env, userId);
  const limitMc = t.credits_per_month * 1000;
  return {
    allowed: usedMc < limitMc,
    tier,
    sub: sub ?? null,
    used: displayPlanTokens(usedMc, tier),
    limit: t.tokens_per_month,
    reset,
  };
}

/**
 * Meter one usage event.
 *
 * `burn` — CLASS_BURN of the served model's class (credits per 1K real tokens
 * = millicredits per real token). The BYOK self-report path passes burn 0:
 * the member pays their own provider there, so the event is LOGGED for the
 * usage dashboard but never debits plan balance (pre-economics this path
 * silently consumed paid members' plan tokens).
 *
 * `usage_log` keeps REAL tokens (honest analytics). The denormalised
 * subscriptions counter keeps user-facing plan tokens (what dashboards show).
 */
export async function recordUsage(
  userId: string, provider: string, model: string,
  inputTokens: number, outputTokens: number, env: Env,
  burn: number, tier: Tier,
): Promise<void> {
  const total = inputTokens + outputTokens;
  const debitMc = total * burn;

  // Atomic increment via the Durable Object counter (no lost-update race).
  if (debitMc > 0) await addQuotaUsed(env, userId, debitMc);

  // D1 analytics log (fire-and-forget — wrapped in ctx.waitUntil by caller).
  await env.DB.prepare(
    'INSERT INTO usage_log (user_id,provider,model,input_tokens,output_tokens,total_tokens) VALUES (?,?,?,?,?,?)'
  ).bind(userId, provider, model, inputTokens, outputTokens, total).run();

  // Subscription counter (denormalised, for invoice-period reset + reporting).
  const debitDisplay = displayPlanTokens(debitMc, tier);
  if (debitDisplay > 0) {
    await env.DB.prepare(
      'UPDATE subscriptions SET tokens_used_this_period=tokens_used_this_period+?, updated_at=unixepoch() WHERE user_id=?'
    ).bind(debitDisplay, userId).run();
  }
}

/**
 * Debit a flat-fee service (image / STT / deep research — PRICING-FINAL
 * Part 4). `credits` comes from FLAT_FEES_CREDITS. Logged to usage_log with
 * 0/0 real tokens under a `service:` pseudo-model so receipts can render
 * "FLUX image · plan −N tok" from the same history feed.
 */
export async function debitFlatFee(
  userId: string, service: string, credits: number, env: Env, tier: Tier,
): Promise<void> {
  const debitMc = credits * 1000;
  await addQuotaUsed(env, userId, debitMc);
  await env.DB.prepare(
    'INSERT INTO usage_log (user_id,provider,model,input_tokens,output_tokens,total_tokens) VALUES (?,?,?,?,?,?)'
  ).bind(userId, 'zintus:service', `service:${service}`, 0, 0, 0).run();
  const debitDisplay = displayPlanTokens(debitMc, tier);
  await env.DB.prepare(
    'UPDATE subscriptions SET tokens_used_this_period=tokens_used_this_period+?, updated_at=unixepoch() WHERE user_id=?'
  ).bind(debitDisplay, userId).run();
}
