const MAX_INPUT_CHARS = 32_000;

const UNTRUSTED_OPEN = "<untrusted_user_context>";
const UNTRUSTED_CLOSE = "</untrusted_user_context>";

export function sanitizeInput(input: string): string {
  if (typeof input !== "string") {
    return "";
  }
  return input.replace(/\0/g, "").slice(0, MAX_INPUT_CHARS);
}

/**
 * Wrap untrusted content in delimiter tags so the model treats it as data, not
 * instructions. Delimiter defenses are bypassable if the content can emit the
 * closing tag and "break out" of the wrapper, so we first strip ANY occurrence
 * of our own delimiters from the content (case-insensitive). The model then
 * sees exactly one open/close pair that the attacker cannot terminate early.
 * (A complementary instruction-hierarchy / structured-input defense is the
 * stronger long-term fix; this closes the trivial breakout.)
 */
export function wrapUntrustedContext(context: string): string {
  const safe = (typeof context === "string" ? context : "").replace(
    /<\/?untrusted_user_context>/gi,
    "",
  );
  return `${UNTRUSTED_OPEN}\n${safe}\n${UNTRUSTED_CLOSE}`;
}
