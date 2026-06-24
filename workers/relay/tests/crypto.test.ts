import { describe, expect, test } from "bun:test";
import { encryptKey, decryptKey } from "../src/crypto.js";

const SECRET = "a-test-key-encryption-secret-value";

describe("relay managed-key crypto (HKDF)", () => {
  test("round-trips a key", async () => {
    const plaintext = "sk-test-1234567890abcdef";
    const encrypted = await encryptKey(plaintext, SECRET);
    expect(encrypted).not.toContain(plaintext);
    expect(await decryptKey(encrypted, SECRET)).toBe(plaintext);
  });

  test("produces distinct ciphertext per call (random IV)", async () => {
    const a = await encryptKey("same", SECRET);
    const b = await encryptKey("same", SECRET);
    expect(a).not.toBe(b);
    expect(await decryptKey(a, SECRET)).toBe("same");
    expect(await decryptKey(b, SECRET)).toBe("same");
  });

  test("wrong secret fails to decrypt", async () => {
    const encrypted = await encryptKey("secret-value", SECRET);
    await expect(decryptKey(encrypted, "a-completely-different-secret")).rejects.toBeDefined();
  });

  test("decrypts legacy (pre-HKDF) ciphertext via fallback", async () => {
    // Reproduce the old raw-truncation scheme to simulate ciphertext written
    // before the HKDF migration, then prove decryptKey still reads it.
    const plaintext = "legacy-key-value";
    const legacyKey = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(SECRET.slice(0, 32).padEnd(32, "0")),
      { name: "AES-GCM" },
      false,
      ["encrypt"],
    );
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      legacyKey,
      new TextEncoder().encode(plaintext),
    );
    const combined = new Uint8Array(iv.byteLength + ct.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(ct), 12);
    let binary = "";
    for (const byte of combined) binary += String.fromCharCode(byte);
    const encoded = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");

    expect(await decryptKey(encoded, SECRET)).toBe(plaintext);
  });
});
