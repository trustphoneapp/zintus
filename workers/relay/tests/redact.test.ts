import { describe, expect, test } from "bun:test";
import { redactSecrets } from "../src/redact.js";

// The relay's dependency-free redactor (used by app.onError before any error is
// logged). Most important for the relay: Stripe secrets, which it actually holds.

describe("relay redactSecrets", () => {
  test("redacts Stripe secret + webhook secret (the relay's own secrets)", () => {
    const sk = "sk_live_" + "a".repeat(24);
    const wh = "whsec_" + "b".repeat(32);
    const out = redactSecrets(`Stripe checkout error: {"key":"${sk}"} sig=${wh}`);
    expect(out).not.toContain(sk);
    expect(out).not.toContain(wh);
    expect(out).toContain("sk_live_****REDACTED****");
    expect(out).toContain("whsec_****REDACTED****");
  });

  test("redacts every covered provider prefix", () => {
    const cases: Array<[string, string]> = [
      ["gsk_" + "a".repeat(52), "gsk_"],
      ["AIza" + "b".repeat(35), "AIza"],
      ["sk-" + "c".repeat(32), "sk-"],
      ["xai-" + "d".repeat(40), "xai-"],
      ["hf_" + "e".repeat(34), "hf_"],
      ["csk-" + "f".repeat(40), "csk-"],
    ];
    for (const [key, prefix] of cases) {
      const out = redactSecrets(`key=${key}`);
      expect(out).not.toContain(key);
      expect(out).toContain(`${prefix}****REDACTED****`);
    }
  });

  test("redacts session / relay / OAuth tokens by key name (UUID-form) + JWTs", () => {
    const jwt = "eyJhbGciOiJSUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4";
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    const code = "4_0AyAbCdEfGhIjKlMnOpQrStUv";
    const sess = "abc123def456ghi789jkl";
    expect(redactSecrets(`id_token=${jwt}`)).not.toContain(jwt);
    expect(redactSecrets(`relay_token=${uuid}`)).toContain(
      "relay_token=****REDACTED****",
    );
    expect(redactSecrets(`Cookie: zintus_session=${sess}`)).toContain(
      "zintus_session=****REDACTED****",
    );
    expect(redactSecrets(`?code=${code}&state=${code}`)).not.toContain(code);
  });

  test("does NOT over-redact non-secret ids (user_id, thread_id, code=200)", () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    expect(redactSecrets(`user_id=${uuid}`)).toContain(uuid);
    expect(redactSecrets("thread_id=abc-123")).toContain("abc-123");
    expect(redactSecrets("http code=200 ok")).toContain("code=200");
  });

  test("leaves ordinary text untouched", () => {
    const input = "Internal server error while processing webhook for user u_123";
    expect(redactSecrets(input)).toBe(input);
  });

  test("returns '' on non-string (safe inside the error handler)", () => {
    expect(redactSecrets(null as unknown as string)).toBe("");
    expect(redactSecrets(undefined as unknown as string)).toBe("");
  });

  test("empty string returns empty", () => {
    expect(redactSecrets("")).toBe("");
  });
});
