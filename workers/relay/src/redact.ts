/**
 * Relay-local secret redactor. The relay is a Cloudflare Worker and cannot
 * import @zintus/router (Node deps), so this mirrors that package's
 * redactSecrets — pure string regexes, no dependencies, Workers-safe.
 *
 * Covers every Zintus provider key prefix plus Stripe secrets (which the relay
 * actually holds: STRIPE_SECRET_KEY, whsec_ webhook secret). Generic prefix-less
 * keys (Cohere/Mistral/Fireworks) can't be pattern-matched without false
 * positives — callers must still avoid putting raw key material in error text.
 */
export function redactSecrets(input: string): string {
  if (typeof input !== "string") {
    return "";
  }
  return input
    .replace(/csk-[a-zA-Z0-9]{20,}/g, "csk-****REDACTED****")
    .replace(/sk_live_[a-zA-Z0-9]+/g, "sk_live_****REDACTED****")
    .replace(/rk_live_[a-zA-Z0-9]+/g, "rk_live_****REDACTED****")
    .replace(/whsec_[a-zA-Z0-9]+/g, "whsec_****REDACTED****")
    .replace(/sk-[a-zA-Z0-9\-_]{8,}/g, "sk-****REDACTED****")
    .replace(/AIza[a-zA-Z0-9_\-]{35}/g, "AIza****REDACTED****")
    .replace(/gsk_[a-zA-Z0-9]{50,}/g, "gsk_****REDACTED****")
    .replace(/xai-[a-zA-Z0-9_-]{16,}/g, "xai-****REDACTED****")
    .replace(/hf_[a-zA-Z0-9]{20,}/g, "hf_****REDACTED****")
    // JWTs (Google id_token / access tokens): three base64url segments.
    .replace(
      /eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g,
      "****REDACTED-JWT****",
    )
    // Session / relay / OAuth tokens by KEY NAME (key=value, key: value,
    // "key":"value", cookie). Context-aware on purpose: only well-known secret
    // keys with a value >= 8 chars, so user_id / thread_id and short values like
    // code=200 are NOT touched.
    .replace(
      /\b(access_token|refresh_token|id_token|relay_token|gateway_secret|session_token|auth_token|zintus_session)(["']?\s*[:=]\s*["']?)([A-Za-z0-9._-]{8,})/gi,
      "$1$2****REDACTED****",
    )
    // OAuth authorization code / state in a callback URL (long opaque values).
    .replace(/\b(code|state)=([A-Za-z0-9._%/-]{16,})/g, "$1=****REDACTED****");
}
