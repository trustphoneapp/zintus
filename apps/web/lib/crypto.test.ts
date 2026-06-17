import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  decryptKeys,
  encryptKeys,
  hasEncryptedKeys,
  loadEncryptedKeys,
  saveEncryptedKeys,
} from "./crypto";

const store = new Map<string, string>();
const originalWindow = globalThis.window;
const originalLocalStorage = globalThis.localStorage;

beforeEach(() => {
  store.clear();
  // @ts-expect-error test-only global shim
  globalThis.window = {};
  // @ts-expect-error test-only global shim
  globalThis.localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
  };
});

afterEach(() => {
  // @ts-ignore test-only global restore
  globalThis.window = originalWindow;
  // @ts-ignore test-only global restore
  globalThis.localStorage = originalLocalStorage;
});

describe("Web Crypto vault", () => {
  it("round-trips encrypted provider keys", async () => {
    const payload = { groq: "gsk_test", cerebras: "csk_test" };
    const encrypted = await encryptKeys(payload, "vault-passphrase");
    const decrypted = await decryptKeys(encrypted, "vault-passphrase");
    expect(decrypted).toEqual(payload);
  });

  it("rejects wrong passphrase", async () => {
    const encrypted = await encryptKeys({ groq: "gsk_test" }, "correct");
    await expect(decryptKeys(encrypted, "wrong")).rejects.toThrow();
  });

  it("persists ciphertext in localStorage", async () => {
    const encrypted = await encryptKeys({ gemini: "AIza_test" }, "vault-passphrase");
    saveEncryptedKeys(encrypted);
    expect(hasEncryptedKeys()).toBe(true);
    expect(loadEncryptedKeys()).toBe(encrypted);
  });
});
