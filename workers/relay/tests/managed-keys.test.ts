import { describe, expect, test } from "bun:test";
import { setManagedKey, getManagedKey, getZintusKey } from "../src/managed-keys.js";
import type { Env } from "../src/types.js";

// Managed (Pro-tier) key custody: keys are encrypted (HKDF/AES-GCM) and stored
// in KV, decrypted server-side on read. This is operator-decryptable by design
// (NOT zero-knowledge — see SECURITY.md); the test pins the round-trip and that
// what lands in KV is ciphertext, never plaintext.

function fakeEnv(extra: Partial<Env> = {}): { env: Env; kv: Map<string, string> } {
  const kv = new Map<string, string>();
  const env = {
    KEY_ENCRYPTION_SECRET: "a-test-key-encryption-secret-value",
    KV: {
      get: async (k: string) => kv.get(k) ?? null,
      put: async (k: string, v: string) => {
        kv.set(k, v);
      },
    },
    ...extra,
  } as unknown as Env;
  return { env, kv };
}

describe("managed key custody", () => {
  test("set then get round-trips the plaintext key", async () => {
    const { env } = fakeEnv();
    await setManagedKey("user1", "groq", "gsk_live_secret_value", env);
    expect(await getManagedKey("user1", "groq", env)).toBe("gsk_live_secret_value");
  });

  test("what is stored in KV is ciphertext, not the plaintext", async () => {
    const { env, kv } = fakeEnv();
    await setManagedKey("user1", "groq", "gsk_live_secret_value", env);
    const stored = kv.get("managed_key:user1:groq")!;
    expect(stored).toBeDefined();
    expect(stored).not.toContain("gsk_live_secret_value");
  });

  test("getManagedKey returns null when absent", async () => {
    const { env } = fakeEnv();
    expect(await getManagedKey("user1", "nope", env)).toBeNull();
  });

  test("keys are scoped per user + provider", async () => {
    const { env } = fakeEnv();
    await setManagedKey("user1", "groq", "key-A", env);
    await setManagedKey("user2", "groq", "key-B", env);
    expect(await getManagedKey("user1", "groq", env)).toBe("key-A");
    expect(await getManagedKey("user2", "groq", env)).toBe("key-B");
    expect(await getManagedKey("user1", "gemini", env)).toBeNull();
  });
});

describe("getZintusKey (Pro master keys)", () => {
  test("returns the configured env key for a mapped provider", () => {
    const { env } = fakeEnv({ ZINTUS_GROQ_KEY: "gsk_master" } as Partial<Env>);
    expect(getZintusKey("groq", env)).toBe("gsk_master");
  });

  test("returns null for an unmapped provider (e.g. anthropic, xai)", () => {
    const { env } = fakeEnv({ ZINTUS_GROQ_KEY: "gsk_master" } as Partial<Env>);
    expect(getZintusKey("anthropic", env)).toBeNull();
    expect(getZintusKey("xai", env)).toBeNull();
  });

  test("returns null when the mapped provider's env key is unset", () => {
    const { env } = fakeEnv();
    expect(getZintusKey("gemini", env)).toBeNull();
  });
});
