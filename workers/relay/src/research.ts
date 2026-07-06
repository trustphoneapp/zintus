import type { Context } from 'hono';
import type { Env } from './types.js';
import type { SessionPayload } from './auth.js';
import { enforceQuota, debitFlatFee, billingPeriod } from './middleware/quota.js';
import {
  RESEARCH_SESSIONS_PER_MONTH,
  FLAT_FEES_CREDITS,
  displayPlanTokens,
  TIERS,
} from './tiers.js';

/**
 * Research session metering (PRICING-FINAL Part 8).
 *
 * Sessions are a SEPARATE monthly counter from token burn: each tier gets a
 * fixed allotment (Starter 20 / Pro 50 / Max 100 / Ultra 300). The gateway
 * calls POST /v1/managed/research-session BEFORE starting a deep-research
 * run; within the allotment the session is free (counter++ only), beyond it
 * the session falls back to a deep_research flat fee (150 credits) debited
 * from plan balance — surfaced to the user as plan tokens, never credits.
 *
 * The counter is keyed on the calendar-UTC-month period, the same contract
 * as the QuotaCounter DO: a new month is a fresh row, which IS the reset.
 * The D1 UPSERT increments in one atomic statement (no read-modify-write).
 */

interface SessionCountRow {
  used: number;
}

/** Sessions used by `userId` this period (0 when no row yet). */
export async function researchSessionsUsed(env: Env, userId: string): Promise<number> {
  const row = await env.DB.prepare(
    'SELECT used FROM research_sessions WHERE user_id = ? AND period = ?',
  ).bind(userId, billingPeriod()).first<SessionCountRow>();
  return row?.used ?? 0;
}

/** Atomically increment this period's session counter; returns the new count. */
async function incrementSessions(env: Env, userId: string): Promise<number> {
  await env.DB.prepare(`
    INSERT INTO research_sessions (user_id, period, used) VALUES (?, ?, 1)
    ON CONFLICT(user_id, period) DO UPDATE SET used = used + 1
  `).bind(userId, billingPeriod()).run();
  return researchSessionsUsed(env, userId);
}

/**
 * POST /v1/managed/research-session — reserve one research session.
 * Caller (index.ts) has already authenticated the session cookie.
 */
export async function handleResearchSession(
  c: Context<{ Bindings: Env }>,
  session: SessionPayload,
): Promise<Response> {
  const quota = await enforceQuota(session.user_id, c.env);
  if (quota.sub?.status !== 'active') {
    return c.json(
      { error: 'Zintus membership required for managed research', code: 'membership_required' },
      403,
    );
  }

  const allotment = RESEARCH_SESSIONS_PER_MONTH[quota.tier];
  const used = await researchSessionsUsed(c.env, session.user_id);

  if (used < allotment) {
    const now = await incrementSessions(c.env, session.user_id);
    return c.json({
      allowed: true,
      overflow: false,
      used: now,
      allotment,
      plan_tokens_debited: 0,
    });
  }

  // Allotment exhausted → the session costs a deep_research flat fee from
  // plan balance. Refuse (429) when the plan balance can't cover it either.
  const overflowMc = FLAT_FEES_CREDITS.deep_research * 1000;
  const t = TIERS[quota.tier];
  const limitMc = (t.credits_per_month ?? 0) * 1000;
  if (!quota.allowed || limitMc === 0) {
    return c.json(
      {
        error: 'Research sessions and plan tokens are both exhausted for this month',
        code: 'research_exhausted',
        used,
        allotment,
        reset: quota.reset,
      },
      429,
    );
  }

  await debitFlatFee(session.user_id, 'deep_research', FLAT_FEES_CREDITS.deep_research, c.env, quota.tier);
  const now = await incrementSessions(c.env, session.user_id);
  return c.json({
    allowed: true,
    overflow: true,
    used: now,
    allotment,
    // Receipt line: "Research session · plan −N tok" for THIS member's tier.
    plan_tokens_debited: displayPlanTokens(overflowMc, quota.tier),
  });
}
