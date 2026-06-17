const STORAGE_KEY = "multipleai.web.keys";
const SALT_KEY = "multipleai.web.salt";

function bytesToBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function deriveKey(
  passphrase: string,
  salt: Uint8Array<ArrayBuffer>,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      // OWASP-recommended minimum for PBKDF2-HMAC-SHA256 (2023+).
      salt,
      iterations: 600_000,
      hash: "SHA-256",
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function getOrCreateSalt(): Promise<Uint8Array<ArrayBuffer>> {
  if (typeof window === "undefined") {
    throw new Error("Web Crypto vault is only available in the browser.");
  }
  const existing = localStorage.getItem(SALT_KEY);
  if (existing) {
    return base64ToBytes(existing);
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  localStorage.setItem(SALT_KEY, bytesToBase64(salt));
  return salt;
}

export async function encryptKeys(
  payload: Record<string, string>,
  passphrase: string,
): Promise<string> {
  const salt = await getOrCreateSalt();
  const key = await deriveKey(passphrase, salt);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(JSON.stringify(payload));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);

  return JSON.stringify({
    iv: bytesToBase64(iv),
    data: bytesToBase64(new Uint8Array(cipher)),
  });
}

export async function decryptKeys(
  encrypted: string,
  passphrase: string,
): Promise<Record<string, string>> {
  const parsed = JSON.parse(encrypted) as { iv: string; data: string };
  const salt = await getOrCreateSalt();
  const key = await deriveKey(passphrase, salt);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(parsed.iv) },
    key,
    base64ToBytes(parsed.data),
  );

  return JSON.parse(new TextDecoder().decode(plain)) as Record<string, string>;
}

export function loadEncryptedKeys(): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  return localStorage.getItem(STORAGE_KEY);
}

export function saveEncryptedKeys(value: string): void {
  if (typeof window === "undefined") {
    return;
  }
  localStorage.setItem(STORAGE_KEY, value);
}

export function hasEncryptedKeys(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  return localStorage.getItem(STORAGE_KEY) !== null;
}
