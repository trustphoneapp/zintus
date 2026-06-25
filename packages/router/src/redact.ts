/**
 * Scrub provider/secret tokens from a string before it reaches a log, trace, or
 * error message. Best-effort and pattern-based: it covers every Zintus provider
 * key format that has a recognizable prefix, plus Stripe secrets (used by the
 * relay). Generic-format keys (Cohere/Mistral/Fireworks use a bare \S{8,} with
 * no prefix) cannot be matched without unacceptable false positives, so callers
 * must still avoid logging raw key material directly.
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
    .replace(/hf_[a-zA-Z0-9]{20,}/g, "hf_****REDACTED****"); // HuggingFace
}
