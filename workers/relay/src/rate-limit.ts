// KV-counter rate limiting for the relay, extracted from index.ts so the
// limiter and its key/limit constants are unit-testable with a fake KV (the
// real implementation, no copied duplicate).
//
// NOTE ON STORAGE CHOICE: Workers KV is eventually consistent, so these
// counters are a best-effort throttle, not a hard cap — concurrent requests at
// different PoPs can briefly over-count or under-count. That is acceptable for
// abuse-dampening (magic-link spam, control floods). Cloudflare's native
// RATE_LIMITER binding / a Durable Object would give stricter counting, but
// Cloudflare explicitly advises AGAINST using a raw IP as a RATE_LIMITER key,
// and a DO per IP is overkill here; the layered KV counters below are the
// pragmatic fit. See:
//   https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/

/**
 * Returns true if the request is under `limit` within `windowSecs`, and
 * increments the counter. Returns false (and does NOT increment further) once
 * the limit is reached.
 */
export async function kvRateLimitOk(
  kv: KVNamespace,
  key: string,
  limit: number,
  windowSecs: number,
): Promise<boolean> {
  const raw = await kv.get(key);
  const count = raw ? parseInt(raw, 10) : 0;
  if (count >= limit) return false;
  await kv.put(key, String(count + 1), { expirationTtl: windowSecs });
  return true;
}

// ── Magic-link limits ───────────────────────────────────────────────────────
// Two independent counters that must BOTH pass:
//   • per-email — caps how often one inbox is mailed (anti-spam to a victim)
//   • per-IP    — caps how many links one host can request across *any* emails
//
// The per-email limit alone is trivially bypassable: an attacker rotating the
// `email` field sends unlimited mail from a single host. The per-IP limit
// closes that. Chosen so a normal user (1 email, maybe a couple of retries) is
// never affected, while a script enumerating addresses is throttled fast.

export const MAGIC_LINK_EMAIL_LIMIT = 3;
export const MAGIC_LINK_EMAIL_WINDOW_SECS = 3600; // 1 hour
export const MAGIC_LINK_IP_LIMIT = 10;
export const MAGIC_LINK_IP_WINDOW_SECS = 3600; // 1 hour

export function magicLinkEmailKey(email: string): string {
  return `rl:ml:${email.toLowerCase()}`;
}

export function magicLinkIpKey(ip: string): string {
  return `rl:ml:ip:${ip}`;
}

// ── Fallback-code entry attempts ────────────────────────────────────────────
// A 6-digit code has 10^6 combinations and a 15-minute life; 5 attempts per
// email per window keeps brute-force success probability ~5×10⁻⁶ per artifact
// (NIST 800-63B requires effective throttling for low-entropy authenticators).

export const VERIFY_CODE_LIMIT = 5;
export const VERIFY_CODE_WINDOW_SECS = 900; // 15 min — matches the artifact TTL

export function verifyCodeKey(email: string): string {
  return `rl:vc:${email.toLowerCase()}`;
}

// ── Gift-model daily cap (PRICING-FINAL: "free tier: gift models with daily
// cap (abuse fence)"). Applies only to users WITHOUT an active paid
// subscription — members use gift models uncapped (they cost 0 to serve and
// 0 to debit). 200/day is generous for a human, hostile to a scraper.

export const GIFT_DAILY_LIMIT = 200;
export const GIFT_DAILY_WINDOW_SECS = 86_400;

export function giftDailyKey(userId: string): string {
  return `rl:gift:${userId}`;
}

// ── Self-reported usage limit ───────────────────────────────────────────────
// POST /api/usage/report is the gateway's self-reported token usage (cookie
// auth) — the documented BYOK trust boundary. It performs one write per LLM
// call, so legitimate traffic is bursty but bounded; an unbounded path lets a
// compromised/abusive cookie flood D1 + the QuotaCounter DO with writes. A
// per-user cap dampens that without hurting real bursts. 600/min (= 10/s) is far
// above any honest report rate yet caps a flood hard. KV is best-effort (see the
// storage-choice note above) — fine here, this is abuse-dampening not accounting.

export const USAGE_REPORT_LIMIT = 600;
export const USAGE_REPORT_WINDOW_SECS = 60; // 1 minute

export function usageReportKey(userId: string): string {
  return `rl:usage:${userId}`;
}

// ── Account-deletion limit ──────────────────────────────────────────────────
// DELETE /api/account is destructive and irreversible (drops the user's row,
// sessions, subscription, usage, quota). A small per-user cap stops a hijacked
// cookie or a buggy client from hammering the deletion path (which fans out to
// D1 + a Durable Object + best-effort Stripe). A legitimate user deletes once;
// 5/hour leaves ample room for a retry after a transient failure while capping
// abuse hard. Per-user (the id comes from the verified session, never the body).

export const ACCOUNT_DELETE_LIMIT = 5;
export const ACCOUNT_DELETE_WINDOW_SECS = 3600; // 1 hour

export function accountDeleteKey(userId: string): string {
  return `rl:acctdel:${userId}`;
}
