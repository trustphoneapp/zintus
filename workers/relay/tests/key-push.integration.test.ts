import { describe, expect, test } from "bun:test";
import { x25519 } from "@noble/curves/ed25519.js";
import { encryptForGateway, decryptKeyPayload } from "@zintus/crypto-e2e";
import { validateControlPayload } from "../src/GatewaySession.js";

// THE END-TO-END BYOK CHAIN (closes the Q8 gap):
//   phone encrypts to the gateway's public key
//     -> relay validates SHAPE and forwards the OPAQUE ciphertext (never decrypts)
//       -> gateway decrypts with its private key
// crypto-e2e's encrypt/decrypt are the exact phone+gateway scheme (the gateway's
// own decryptKeyPayload wraps this). The relay node is validateControlPayload.

function gatewayKeypair(): { pubB64: string; priv: Uint8Array } {
  const priv = x25519.utils.randomSecretKey();
  return { pubB64: Buffer.from(x25519.getPublicKey(priv)).toString("base64"), priv };
}

describe("E2E key push: phone -> relay -> gateway", () => {
  const API_KEY = "gsk_live_1234567890abcdefABCDEF";

  test("a key encrypted on the phone decrypts to the same value on the gateway", () => {
    const gateway = gatewayKeypair();

    // 1. Phone encrypts to the gateway's advertised public key.
    const encryptedKey = encryptForGateway(API_KEY, gateway.pubB64);

    // 2. Relay validates the control payload SHAPE and would forward it.
    expect(validateControlPayload("set_key", { provider: "groq", encryptedKey })).toBeNull();

    // 3. Gateway decrypts with its private key → original plaintext.
    expect(decryptKeyPayload(encryptedKey, gateway.priv)).toBe(API_KEY);
  });

  test("the relay never sees plaintext — ciphertext is base64 and excludes the key", () => {
    const gateway = gatewayKeypair();
    const encryptedKey = encryptForGateway(API_KEY, gateway.pubB64);

    // The forwarded value is a base64 JSON envelope (not the raw key).
    expect(encryptedKey).not.toContain(API_KEY);
    expect(/^[A-Za-z0-9+/=]+$/.test(encryptedKey)).toBe(true);
    const envelope = JSON.parse(Buffer.from(encryptedKey, "base64").toString("utf8")) as Record<string, unknown>;
    // The plaintext appears nowhere in the envelope fields.
    expect(JSON.stringify(envelope)).not.toContain(API_KEY);
    expect(envelope.ct).toBeDefined(); // ciphertext present
    expect(envelope.v).toBe(1);

    // The relay accepts it WITHOUT being able to read it (validates shape only).
    expect(validateControlPayload("set_key", { provider: "groq", encryptedKey })).toBeNull();
  });

  test("a key encrypted for one gateway cannot be decrypted by another", () => {
    const realGateway = gatewayKeypair();
    const attacker = gatewayKeypair();
    const encryptedKey = encryptForGateway(API_KEY, realGateway.pubB64);

    // Even though the relay forwarded it, a different gateway's key cannot read it.
    expect(() => decryptKeyPayload(encryptedKey, attacker.priv)).toThrow();
  });

  test("the relay rejects a malformed set_key before any forward", () => {
    // Missing encryptedKey → the relay returns an error and does not forward.
    expect(validateControlPayload("set_key", { provider: "groq" })).toBe("Invalid or missing encryptedKey");
  });
});
