export function redactSecrets(input: string): string {
  return input
    .replace(/sk-[a-zA-Z0-9\-_]{8,}/g, "sk-****REDACTED****")
    .replace(/AIza[a-zA-Z0-9_\-]{35}/g, "AIza****REDACTED****")
    .replace(/gsk_[a-zA-Z0-9]{50,}/g, "gsk_****REDACTED****");
}
