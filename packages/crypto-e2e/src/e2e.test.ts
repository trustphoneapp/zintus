import { describe, expect, it } from "vitest";
import { x25519 } from "@noble/curves/ed25519.js";
import { encryptForGateway, decryptKeyPayload } from "./index.js";

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function gatewayKeypair(): { pubB64: string; priv: Uint8Array } {
  const priv = x25519.utils.randomSecretKey();
  const pub = x25519.getPublicKey(priv);
  return { pubB64: b64(pub), priv };
}

describe("crypto-e2e round-trip", () => {
  it("encrypts then decrypts back to the original key", () => {
    const { pubB64, priv } = gatewayKeypair();
    const apiKey = "gsk_" + "a".repeat(52);

    const encrypted = encryptForGateway(apiKey, pubB64);
    const decrypted = decryptKeyPayload(encrypted, priv);

    expect(decrypted).toBe(apiKey);
  });

  it("produces a base64 JSON envelope with v/epk/iv/ct fields", () => {
    const { pubB64 } = gatewayKeypair();
    const encrypted = encryptForGateway("sk-test-1234567890", pubB64);
    const payload = JSON.parse(
      Buffer.from(encrypted, "base64").toString("utf8"),
    ) as Record<string, unknown>;

    expect(payload.v).toBe(1);
    expect(typeof payload.epk).toBe("string");
    expect(typeof payload.iv).toBe("string");
    expect(typeof payload.ct).toBe("string");
  });

  it("rejects a tampered ciphertext (GCM tag mismatch)", () => {
    const { pubB64, priv } = gatewayKeypair();
    const encrypted = encryptForGateway("sk-some-real-key-1234", pubB64);

    const payload = JSON.parse(
      Buffer.from(encrypted, "base64").toString("utf8"),
    ) as { v: number; epk: string; iv: string; ct: string };

    // Flip a byte in the ciphertext.
    const ctBytes = Buffer.from(payload.ct, "base64");
    ctBytes[0] = ctBytes[0]! ^ 0xff;
    payload.ct = ctBytes.toString("base64");

    const tampered = Buffer.from(JSON.stringify(payload), "utf8").toString(
      "base64",
    );

    expect(() => decryptKeyPayload(tampered, priv)).toThrow();
  });

  it("fails to decrypt with the wrong private key", () => {
    const { pubB64 } = gatewayKeypair();
    const wrong = gatewayKeypair();
    const encrypted = encryptForGateway("sk-real-key-abcdef", pubB64);

    expect(() => decryptKeyPayload(encrypted, wrong.priv)).toThrow();
  });
});

describe("crypto-e2e key shapes", () => {
  it("round-trips a 2000-character key", () => {
    const { pubB64, priv } = gatewayKeypair();
    const apiKey = "k".repeat(2000);
    expect(decryptKeyPayload(encryptForGateway(apiKey, pubB64), priv)).toBe(apiKey);
  });

  it("round-trips a unicode key (multi-byte, >= 8 chars)", () => {
    const { pubB64, priv } = gatewayKeypair();
    const apiKey = "鍵こんにちは🔑key";
    expect(decryptKeyPayload(encryptForGateway(apiKey, pubB64), priv)).toBe(apiKey);
  });

  it("enforces the >=8-char floor on the DECRYPTED key (not on encrypt)", () => {
    const { pubB64, priv } = gatewayKeypair();
    // Encryption of a short key succeeds; decryption rejects it as implausible.
    const sevenChars = encryptForGateway("abc1234", pubB64);
    expect(() => decryptKeyPayload(sevenChars, priv)).toThrow(/short/);
    // The empty string therefore does NOT round-trip — it throws on decrypt.
    expect(() => decryptKeyPayload(encryptForGateway("", pubB64), priv)).toThrow(/short/);
    // Exactly 8 chars is the smallest key that survives the round-trip.
    expect(decryptKeyPayload(encryptForGateway("abc12345", pubB64), priv)).toBe("abc12345");
  });
});

describe("crypto-e2e tampering & malformed envelopes", () => {
  function envelope(plaintext: string): {
    pubB64: string;
    priv: Uint8Array;
    payload: { v: number; epk: string; iv: string; ct: string };
    reseal: (p: object) => string;
  } {
    const { pubB64, priv } = gatewayKeypair();
    const encrypted = encryptForGateway(plaintext, pubB64);
    const payload = JSON.parse(Buffer.from(encrypted, "base64").toString("utf8")) as {
      v: number;
      epk: string;
      iv: string;
      ct: string;
    };
    const reseal = (p: object) => Buffer.from(JSON.stringify(p), "utf8").toString("base64");
    return { pubB64, priv, payload, reseal };
  }

  it("rejects a tampered IV (GCM tag mismatch)", () => {
    const { priv, payload, reseal } = envelope("sk-real-key-abcdef");
    const iv = Buffer.from(payload.iv, "base64");
    iv[0] = iv[0]! ^ 0xff;
    expect(() => decryptKeyPayload(reseal({ ...payload, iv: iv.toString("base64") }), priv)).toThrow();
  });

  it("rejects a tampered ephemeral public key (wrong shared secret)", () => {
    const { priv, payload, reseal } = envelope("sk-real-key-abcdef");
    const epk = Buffer.from(payload.epk, "base64");
    epk[0] = epk[0]! ^ 0xff; // still 32 bytes → derives a different secret → GCM fails
    expect(() => decryptKeyPayload(reseal({ ...payload, epk: epk.toString("base64") }), priv)).toThrow();
  });

  it("rejects an unsupported payload version", () => {
    const { priv, payload, reseal } = envelope("sk-real-key-abcdef");
    expect(() => decryptKeyPayload(reseal({ ...payload, v: 999 }), priv)).toThrow(/version/);
  });

  it("rejects a malformed (non-JSON) envelope", () => {
    const { priv } = gatewayKeypair();
    const garbage = Buffer.from("this is not a json envelope", "utf8").toString("base64");
    expect(() => decryptKeyPayload(garbage, priv)).toThrow();
  });
});
