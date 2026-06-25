import { describe, expect, test } from "bun:test";
import { validateControlPayload, parseGatewayMsg } from "../src/GatewaySession.js";

// The relay's BYOK control gate. set_key/remove_key payloads are validated for
// SHAPE only — the relay must never decrypt or inspect `encryptedKey` (it is
// opaque ciphertext bound for the home gateway). Returns an error string on a
// bad payload, or null when it may be forwarded.

describe("validateControlPayload — set_key", () => {
  test("accepts a well-formed set_key (valid provider + non-empty ciphertext)", () => {
    expect(validateControlPayload("set_key", { provider: "groq", encryptedKey: "BASE64CIPHERTEXT==" })).toBeNull();
  });

  test("treats encryptedKey as OPAQUE — does not validate its format (BYOK zero-knowledge)", () => {
    // A non-base64, arbitrary string still passes: the relay never parses or
    // decrypts the ciphertext, it only checks it is a non-empty string.
    expect(validateControlPayload("set_key", { provider: "gemini", encryptedKey: "not-even-base64-!!!{}" })).toBeNull();
  });

  test("rejects missing provider", () => {
    expect(validateControlPayload("set_key", { encryptedKey: "abc" })).toBe("Invalid or missing provider");
  });

  test("rejects an unknown provider id", () => {
    expect(validateControlPayload("set_key", { provider: "anthropic", encryptedKey: "abc" })).toBe(
      "Invalid or missing provider",
    );
  });

  test("rejects missing or empty encryptedKey", () => {
    expect(validateControlPayload("set_key", { provider: "groq" })).toBe("Invalid or missing encryptedKey");
    expect(validateControlPayload("set_key", { provider: "groq", encryptedKey: "" })).toBe(
      "Invalid or missing encryptedKey",
    );
  });

  test("rejects a non-object value", () => {
    expect(validateControlPayload("set_key", null)).toBe("Invalid or missing provider");
    expect(validateControlPayload("set_key", undefined)).toBe("Invalid or missing provider");
  });
});

describe("validateControlPayload — remove_key", () => {
  test("accepts a valid remove_key", () => {
    expect(validateControlPayload("remove_key", { provider: "groq" })).toBeNull();
  });

  test("rejects an unknown provider", () => {
    expect(validateControlPayload("remove_key", { provider: "nope" })).toBe("Invalid or missing provider");
  });
});

describe("parseGatewayMsg", () => {
  test("parses valid JSON into an object", () => {
    expect(parseGatewayMsg(JSON.stringify({ type: "ping" }))).toEqual({ type: "ping" } as never);
  });

  test("returns null for malformed JSON (no throw)", () => {
    expect(parseGatewayMsg("{ not json")).toBeNull();
    expect(parseGatewayMsg("")).toBeNull();
  });
});
