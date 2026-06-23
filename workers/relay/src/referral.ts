import type { Env } from './types.js';

const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // base-32 Crockford-like, no ambiguous chars

/** Generate a cryptographically random 8-char referral code. */
function randomCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes).map(b => ALPHABET[b % ALPHABET.length]).join('');
}

/** Get or create a stable referral code for a user. */
export async function getOrCreateReferralCode(userId: string, env: Env): Promise<string> {
  // Check D1 first
  const existing = await env.DB.prepare(
    'SELECT code FROM referral_codes WHERE user_id = ?'
  ).bind(userId).first<{ code: string }>();
  if (existing) return existing.code;

  // Generate a collision-free code
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = 'zin_' + randomCode();
    const conflict = await env.DB.prepare(
      'SELECT code FROM referral_codes WHERE code = ?'
    ).bind(code).first();
    if (!conflict) {
      await env.DB.prepare(
        'INSERT INTO referral_codes (code, user_id) VALUES (?, ?)'
      ).bind(code, userId).run();
      await env.KV.put(`referral_code:${code}`, userId);
      return code;
    }
  }
  throw new Error('Failed to generate unique referral code');
}

export async function resolveReferralCode(code: string, env: Env): Promise<string | null> {
  if (!code.startsWith('zin_')) return null;
  // KV is faster for lookups on hot path
  const userId = await env.KV.get(`referral_code:${code}`);
  if (userId) return userId;
  // Fallback to D1 (in case KV was not seeded)
  const row = await env.DB.prepare(
    'SELECT user_id FROM referral_codes WHERE code = ?'
  ).bind(code).first<{ user_id: string }>();
  return row?.user_id ?? null;
}
