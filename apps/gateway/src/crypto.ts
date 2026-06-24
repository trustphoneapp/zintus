/**
 * Gateway E2E keypair — persisted raw 32-byte x25519 private key.
 *
 * The gateway is the ONLY surface that can decrypt BYOK key-push payloads.
 * Its x25519 private key is generated once and persisted in the OS keychain
 * under a reserved account id; the public key is advertised to clients via the
 * status payload so they can encrypt API keys to it (see @zintus/crypto-e2e).
 *
 * Security:
 *   - The private key never leaves this machine and is NEVER logged.
 *   - Decrypted plaintext keys are NEVER logged.
 */

import { Entry } from "@napi-rs/keyring";
import { x25519 } from "@noble/curves/ed25519.js";
import { decryptKeyPayload as decryptWithPriv } from "@zintus/crypto-e2e";

const KEYCHAIN_SERVICE = "zintus";
/** Reserved (non-provider) keychain account holding the raw priv key, base64. */
const E2E_PRIV_ACCOUNT = "__zintus_e2e_priv__";

export interface GatewayKeypair {
  /** Raw 32-byte x25519 public key, base64. Advertised to clients. */
  publicKeyBase64: string;
  /** Raw 32-byte x25519 private key. NEVER log or transmit. */
  privateKeyRaw: Uint8Array;
}

function privEntry(): Entry {
  return new Entry(KEYCHAIN_SERVICE, E2E_PRIV_ACCOUNT);
}

// In-process cache so we don't hit the keychain on every status push / control.
let cached: GatewayKeypair | null = null;

/**
 * Load the persisted gateway x25519 keypair, generating + storing one on first
 * run. The raw 32-byte private key is base64-encoded in the OS keychain.
 */
export function getOrCreateGatewayKeypair(): GatewayKeypair {
  if (cached) {
    return cached;
  }

  const entry = privEntry();

  let privRaw: Uint8Array | null = null;
  try {
    const stored = entry.getPassword();
    if (stored) {
      const decoded = new Uint8Array(Buffer.from(stored, "base64"));
      if (decoded.length === 32) {
        privRaw = decoded;
      }
    }
  } catch {
    // Absent or unreadable — fall through to generate a fresh key.
  }

  if (!privRaw) {
    privRaw = x25519.utils.randomSecretKey();
    // Best-effort persist; if the keychain is unavailable the key is still
    // usable for this process lifetime (clients re-fetch the pubkey from status).
    try {
      entry.setPassword(Buffer.from(privRaw).toString("base64"));
    } catch {
      // ignore — getOrCreateGatewayKeypair stays functional in-memory.
    }
  }

  const publicKeyRaw = x25519.getPublicKey(privRaw);
  cached = {
    publicKeyBase64: Buffer.from(publicKeyRaw).toString("base64"),
    privateKeyRaw: privRaw,
  };
  return cached;
}

/**
 * Decrypt a BYOK key-push payload (base64 JSON {v,epk,iv,ct}) with the gateway's
 * private key. Throws on tamper/format error. NEVER log the returned plaintext.
 */
export function decryptKeyPayload(encryptedKey: string): string {
  const { privateKeyRaw } = getOrCreateGatewayKeypair();
  return decryptWithPriv(encryptedKey, privateKeyRaw);
}
