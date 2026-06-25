// Managed-key encryption for the relay's Pro tier.
//
// NOTE ON TRUST MODEL: this is server-side (operator-decryptable) encryption,
// NOT zero-knowledge. The relay holds both the ciphertext (in KV) and the
// KEY_ENCRYPTION_SECRET (worker env), so it can decrypt managed keys to call
// providers on the user's behalf. The BYOK path (see GatewaySession.ts) is the
// zero-knowledge path — there the relay only forwards opaque ciphertext it can
// never read. High-value keys should use BYOK. See SECURITY.md.
//
// Keys are derived from KEY_ENCRYPTION_SECRET via HKDF-SHA256 (proper KDF) into
// a 256-bit AES-GCM key. This replaces the previous raw `secret.slice(0,32)
// .padEnd(32,'0')` truncation, which used low-entropy/short secrets directly as
// key bytes. Ciphertext is base64url("iv|ciphertext").

// Fixed, non-secret HKDF salt + info for domain separation. A static salt is
// fine for HKDF (the salt need not be secret); rotating KEY_ENCRYPTION_SECRET
// rotates the derived key.
const HKDF_SALT = new TextEncoder().encode("zintus-relay-managed-key-hkdf-v1");
const HKDF_INFO = new TextEncoder().encode("aes-256-gcm");

async function deriveAesKey(
  secret: string,
  usages: KeyUsage[],
): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: HKDF_SALT, info: HKDF_INFO },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    usages,
  );
}

// Legacy (pre-HKDF) key derivation. Retained ONLY so ciphertext written before
// the HKDF migration still decrypts; never used for new writes.
async function deriveLegacyAesKey(
  secret: string,
  usages: KeyUsage[],
): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret.slice(0, 32).padEnd(32, "0")),
    { name: "AES-GCM" },
    false,
    usages,
  );
}

/** AES-256-GCM encrypt. Returns base64url-encoded "iv|ciphertext". */
export async function encryptKey(plaintext: string, secret: string): Promise<string> {
  const key = await deriveAesKey(secret, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  const combined = new Uint8Array(iv.byteLength + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), 12);
  return uint8ToBase64Url(combined);
}

export async function decryptKey(encoded: string, secret: string): Promise<string> {
  const combined = base64UrlToUint8(encoded);
  const iv = combined.slice(0, 12);
  const data = combined.slice(12);
  // Try the current HKDF-derived key first. AES-GCM authenticates, so a wrong
  // key throws on the auth tag — fall back to the legacy derivation for
  // ciphertext written before the migration.
  try {
    const key = await deriveAesKey(secret, ["decrypt"]);
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data);
    return new TextDecoder().decode(plaintext);
  } catch {
    const legacy = await deriveLegacyAesKey(secret, ["decrypt"]);
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, legacy, data);
    return new TextDecoder().decode(plaintext);
  }
}

function uint8ToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function base64UrlToUint8(str: string): Uint8Array {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/').padEnd(str.length + (4 - str.length % 4) % 4, '=');
  const binary = atob(base64);
  return new Uint8Array(binary.length).map((_, i) => binary.charCodeAt(i));
}
