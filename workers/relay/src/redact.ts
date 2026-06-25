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
    .replace(/hf_[a-zA-Z0-9]{20,}/g, "hf_****REDACTED****");
}
