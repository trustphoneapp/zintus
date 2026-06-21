const MAX_INPUT_CHARS = 32_000;

export function sanitizeInput(input: string): string {
  return input.replace(/\0/g, "").slice(0, MAX_INPUT_CHARS);
}

export function wrapUntrustedContext(context: string): string {
  return `<untrusted_user_context>\n${context}\n</untrusted_user_context>`;
}
