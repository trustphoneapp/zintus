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
