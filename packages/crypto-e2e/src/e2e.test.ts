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
