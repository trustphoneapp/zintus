/**
 * @zintus/crypto-e2e — single source of truth for the BYOK key-push wire format.
 *
 * The phone/web client encrypts an API key to the gateway's PUBLIC key. The relay
 * forwards opaque ciphertext; only the gateway (holding the private key, which never
 * leaves the machine) can decrypt. Gateway, mobile AND web import THIS module so the
 * wire format can never drift.
 *
 * Primitive (IDENTICAL on every surface):
 *   - x25519 ECDH (@noble/curves)
 *   - HKDF-SHA256 with info "zintus-relay-e2e-v1" → 32-byte AES key (@noble/hashes)
 *   - AES-256-GCM (@noble/ciphers); the 16-byte tag stays appended inside `ct`.
 *
 * Wire payload (JSON, then base64): { v: 1, epk, iv, ct } — all fields base64.
 */

import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { gcm } from "@noble/ciphers/aes.js";

/** HKDF `info` — MUST be byte-identical across gateway, mobile, web. */
const HKDF_INFO = "zintus-relay-e2e-v1";
const PAYLOAD_VERSION = 1;

interface E2EPayload {
  v: number;
  /** ephemeral x25519 public key (raw 32B), base64 */
  epk: string;
  /** GCM nonce (12B), base64 */
  iv: string;
  /** ciphertext WITH the 16B GCM tag appended, base64 */
  ct: string;
}

// ── base64 helpers (work in Node, Bun, RN, and the browser) ────────────────

function toBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(b64, "base64"));
  }
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

const utf8Encode = (s: string): Uint8Array => new TextEncoder().encode(s);
const utf8Decode = (b: Uint8Array): string => new TextDecoder().decode(b);

/** ECDH → HKDF-SHA256 → 32-byte AES key. */
function deriveAesKey(shared: Uint8Array): Uint8Array {
  return hkdf(sha256, shared, undefined, utf8Encode(HKDF_INFO), 32);
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Encrypt `plaintext` (an API key) to the gateway's raw-32B x25519 public key.
 * Returns `base64(JSON.stringify({ v, epk, iv, ct }))` — the `encryptedKey` string
 * sent over the relay.
 */
export function encryptForGateway(
  plaintext: string,
  gatewayPubB64: string,
): string {
  const gatewayPub = fromBase64(gatewayPubB64);

  const ephSecret = x25519.utils.randomSecretKey();
  const ephPublic = x25519.getPublicKey(ephSecret);
  const shared = x25519.getSharedSecret(ephSecret, gatewayPub);
  const aesKey = deriveAesKey(shared);

  const iv = crypto.getRandomValues(new Uint8Array(12));
  // @noble/ciphers gcm appends the 16B tag to the end of the ciphertext.
  const ct = gcm(aesKey, iv).encrypt(utf8Encode(plaintext));

  const payload: E2EPayload = {
    v: PAYLOAD_VERSION,
    epk: toBase64(ephPublic),
    iv: toBase64(iv),
    ct: toBase64(ct),
  };

  return toBase64(utf8Encode(JSON.stringify(payload)));
}

/**
 * Decrypt an `encryptedKey` produced by {@link encryptForGateway} using the
 * gateway's raw-32B x25519 private key. Throws on any tamper/format error.
 */
export function decryptKeyPayload(
  encryptedKey: string,
  gatewayPrivRaw: Uint8Array,
): string {
  let payload: E2EPayload;
  try {
    payload = JSON.parse(utf8Decode(fromBase64(encryptedKey))) as E2EPayload;
  } catch {
    throw new Error("crypto-e2e: malformed encryptedKey envelope");
  }

  if (payload.v !== PAYLOAD_VERSION) {
    throw new Error(`crypto-e2e: unsupported payload version ${payload.v}`);
  }
  if (
    typeof payload.epk !== "string" ||
    typeof payload.iv !== "string" ||
    typeof payload.ct !== "string"
  ) {
    throw new Error("crypto-e2e: missing payload fields");
  }

  const epk = fromBase64(payload.epk);
  const iv = fromBase64(payload.iv);
  const ct = fromBase64(payload.ct);

  const shared = x25519.getSharedSecret(gatewayPrivRaw, epk);
  const aesKey = deriveAesKey(shared);

  // Throws if the GCM tag does not verify (tampered ct/iv/epk).
  const plaintextBytes = gcm(aesKey, iv).decrypt(ct);
  const plaintext = utf8Decode(plaintextBytes);

  if (plaintext.length < 8) {
    throw new Error("crypto-e2e: decrypted key implausibly short");
  }

  return plaintext;
}
