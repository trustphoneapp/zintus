/**
 * Scrub provider/secret tokens from a string before it reaches a log, trace, or
 * error message. Best-effort and pattern-based: it covers every Zintus provider
 * key format that has a recognizable prefix, plus Stripe secrets, JWTs
 * (Google id_token / OAuth access tokens), named session/OAuth tokens, OAuth
 * code/state, and UUID-shaped opaque tokens. Kept in lockstep with the relay
 * redactor (workers/relay/src/redact.ts) — the two had drifted (the relay gained
 * JWT/named-token rules in d4eb53b; this is the router catch-up, plus UUID).
 * Generic-format keys (Cohere/Mistral/Fireworks use a bare \S{8,} with no prefix)
 * cannot be matched without unacceptable false positives, so callers must still
 * avoid logging raw key material directly.
 *
 * Order matters: more specific prefixes (csk-, sk_live_) run before the broad
 * `sk-` rule so the full token — including any leading char — is redacted.
 */
export function redactSecrets(input: string): string {
  // Null guard: this runs inside error handlers, so it must never throw on a
  // non-string (a thrown redactor would crash the very logging path it protects).
  if (typeof input !== "string") {
    return "";
  }
  return input
    .replace(/csk-[a-zA-Z0-9]{20,}/g, "csk-****REDACTED****") // Cerebras
    .replace(/sk_live_[a-zA-Z0-9]+/g, "sk_live_****REDACTED****") // Stripe secret key
    .replace(/rk_live_[a-zA-Z0-9]+/g, "rk_live_****REDACTED****") // Stripe restricted key
    .replace(/whsec_[a-zA-Z0-9]+/g, "whsec_****REDACTED****") // Stripe webhook secret
    .replace(/sk-[a-zA-Z0-9\-_]{8,}/g, "sk-****REDACTED****") // OpenAI / DeepSeek / OpenRouter (sk-or-)
    .replace(/AIza[a-zA-Z0-9_\-]{35}/g, "AIza****REDACTED****") // Gemini
    .replace(/gsk_[a-zA-Z0-9]{50,}/g, "gsk_****REDACTED****") // Groq
    .replace(/xai-[a-zA-Z0-9_-]{16,}/g, "xai-****REDACTED****") // xAI
    .replace(/hf_[a-zA-Z0-9]{20,}/g, "hf_****REDACTED****") // HuggingFace
    // JWTs (Google id_token / OAuth access tokens): three base64url segments.
    // Mirrors the relay redactor (workers/relay/src/redact.ts) — a provider 401
    // body echoing a JWT must not survive into the persisted trace.
    .replace(
      /eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g,
      "****REDACTED-JWT****",
    )
    // Session / relay / OAuth tokens by KEY NAME (key=value, key: value,
    // "key":"value", cookie). Context-aware: only well-known secret keys with a
    // value >= 8 chars, so user_id / thread_id and short values are NOT touched.
    .replace(
      /\b(access_token|refresh_token|id_token|relay_token|gateway_secret|session_token|auth_token|zintus_session)(["']?\s*[:=]\s*["']?)([A-Za-z0-9._-]{8,})/gi,
      "$1$2****REDACTED****",
    )
    // OAuth authorization code / state in a callback URL (long opaque values).
    .replace(/\b(code|state)=([A-Za-z0-9._%/-]{16,})/g, "$1=****REDACTED****")
    // UUID-shaped opaque tokens (session/relay ids that double as bearer secrets).
    .replace(
      /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g,
      "****REDACTED-UUID****",
    );
}
