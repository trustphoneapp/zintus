import { describe, expect, test } from "bun:test";
import { redactSecrets } from "./redact.js";

// redactSecrets() scrubs provider API keys from strings before they reach a log
// or error message (used at apps/cli/src/index.ts on error output). It applies
// THREE unanchored regexes, replacing the match with a "...****REDACTED****"
// marker:
//   sk-[a-zA-Z0-9\-_]{8,}   AIza[a-zA-Z0-9_\-]{35}   gsk_[a-zA-Z0-9]{50,}
// Tests assert the REAL behavior + pin the coverage gaps (a security finding).

describe("redactSecrets — covered formats", () => {
  test("redacts a Groq key (gsk_ + 50+ chars)", () => {
    const key = "gsk_" + "a".repeat(52);
    const out = redactSecrets(`Authorization: Bearer ${key}`);
    expect(out).not.toContain(key);
    expect(out).toContain("REDACTED");
  });

  test("redacts a Gemini key (AIza + 35 chars)", () => {
    const key = "AIza" + "B".repeat(35);
    const out = redactSecrets(`key=${key}`);
    expect(out).not.toContain(key);
    expect(out).toContain("REDACTED");
  });

  test("redacts an OpenAI-style key (sk- + 8+ chars)", () => {
    const key = "sk-proj-abc123def456ghi789";
    const out = redactSecrets(key);
    expect(out).not.toContain(key);
    expect(out).toContain("REDACTED");
  });

  test("redacts multiple keys in one string", () => {
    const groq = "gsk_" + "z".repeat(52);
    const openai = "sk-" + "y".repeat(32);
    const gemini = "AIza" + "x".repeat(35);
    const out = redactSecrets(`groq=${groq} openai=${openai} gemini=${gemini}`);
    expect(out).not.toContain(groq);
    expect(out).not.toContain(openai);
    expect(out).not.toContain(gemini);
  });

  test("catches OpenRouter/Cerebras incidentally via the unanchored sk- pattern", () => {
    // The sk- regex has no `^` anchor, so the "sk-" inside "csk-"/"sk-or-" matches
    // and the secret tail is still redacted.
    expect(redactSecrets("csk-" + "a".repeat(40))).toContain("REDACTED");
    expect(redactSecrets("sk-or-v1-" + "a".repeat(40))).toContain("REDACTED");
  });
});

describe("redactSecrets — leaves non-secrets alone", () => {
  test("normal prose is untouched", () => {
    const input = "User asked about the weather today";
    expect(redactSecrets(input)).toBe(input);
  });

  test("short key-shaped text is untouched (no over-redaction)", () => {
    expect(redactSecrets("the prefix sk is short for 'skip'")).toBe("the prefix sk is short for 'skip'");
    // gsk_ shorter than 50 chars does not match (and 'sk_' is not 'sk-')
    expect(redactSecrets("gsk_abc")).toBe("gsk_abc");
  });

  test("empty string returns empty", () => {
    expect(redactSecrets("")).toBe("");
  });
});

describe("redactSecrets — formats fixed in this change", () => {
  test("now redacts xAI keys (xai-)", () => {
    const key = "xai-" + "a".repeat(40);
    const out = redactSecrets(`key=${key}`);
    expect(out).not.toContain(key);
    expect(out).toContain("REDACTED");
  });

  test("now redacts HuggingFace keys (hf_)", () => {
    const key = "hf_" + "a".repeat(34);
    const out = redactSecrets(`key=${key}`);
    expect(out).not.toContain(key);
    expect(out).toContain("REDACTED");
  });

  test("now redacts Cerebras keys fully (csk-, leading c included)", () => {
    const key = "csk-" + "a".repeat(40);
    const out = redactSecrets(`key=${key}`);
    expect(out).not.toContain(key);
    expect(out).toContain("csk-****REDACTED****");
  });

  test("now redacts Stripe secrets (sk_live_ / rk_live_ / whsec_)", () => {
    const sk = "sk_live_" + "a".repeat(24);
    const wh = "whsec_" + "b".repeat(32);
    const out = redactSecrets(`stripe=${sk} hook=${wh}`);
    expect(out).not.toContain(sk);
    expect(out).not.toContain(wh);
    expect(out).toContain("sk_live_****REDACTED****");
    expect(out).toContain("whsec_****REDACTED****");
  });

  test("returns '' on null/undefined instead of throwing (safe inside loggers)", () => {
    expect(redactSecrets(null as unknown as string)).toBe("");
    expect(redactSecrets(undefined as unknown as string)).toBe("");
  });
});

describe("redactSecrets — accepted limitation", () => {
  test("generic-format keys (Cohere/Mistral/Fireworks) still cannot be matched", () => {
    // These providers use GENERIC_KEY (\\S{8,}) with no distinguishing prefix,
    // so a pattern-based redactor cannot catch them without false positives.
    // Documented limitation: callers must not log raw key material directly.
    const key = "Xy7Qp2LmZkVa90bRtNopArs";
    expect(redactSecrets(`key=${key}`)).toContain(key);
  });
});
