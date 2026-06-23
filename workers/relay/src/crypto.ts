/** AES-256-GCM encrypt. Returns base64url-encoded "iv|ciphertext". */
export async function encryptKey(plaintext: string, secret: string): Promise<string> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret.slice(0, 32).padEnd(32, '0')),
    { name: 'AES-GCM' },
    false,
    ['encrypt'],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    keyMaterial,
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
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret.slice(0, 32).padEnd(32, '0')),
    { name: 'AES-GCM' },
    false,
    ['decrypt'],
  );
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, keyMaterial, data);
  return new TextDecoder().decode(plaintext);
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
