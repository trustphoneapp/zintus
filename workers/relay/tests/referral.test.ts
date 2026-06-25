import { describe, expect, test } from "bun:test";
import { getOrCreateReferralCode, resolveReferralCode } from "../src/referral.js";
import type { Env } from "../src/types.js";

// Referral codes: stable per user, `zin_`-prefixed, resolvable via KV (hot path)
// with a D1 fallback. Built on an in-memory fake of the referral_codes table.

function fakeEnv() {
  const codes = new Map<string, string>(); // code -> userId
  const kv = new Map<string, string>();
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>(): Promise<T | null> {
              if (sql.includes("WHERE user_id")) {
                const userId = args[0] as string;
                for (const [code, uid] of codes) if (uid === userId) return { code } as T;
                return null;
              }
              if (sql.includes("WHERE code")) {
                const code = args[0] as string;
                if (!codes.has(code)) return null;
                return (sql.includes("user_id") ? { user_id: codes.get(code) } : { code }) as T;
              }
              return null;
            },
            async run() {
              if (sql.startsWith("INSERT")) codes.set(args[0] as string, args[1] as string);
              return {};
            },
          };
        },
      };
    },
  };
  const env = {
    DB: db,
    KV: {
      get: async (k: string) => kv.get(k) ?? null,
      put: async (k: string, v: string) => {
        kv.set(k, v);
      },
    },
  } as unknown as Env;
  return { env, codes, kv };
}

describe("getOrCreateReferralCode", () => {
  test("creates a zin_-prefixed code and seeds KV when none exists", async () => {
    const { env, codes, kv } = fakeEnv();
    const code = await getOrCreateReferralCode("user1", env);
    expect(code.startsWith("zin_")).toBe(true);
    expect(codes.get(code)).toBe("user1");
    expect(kv.get(`referral_code:${code}`)).toBe("user1");
  });

  test("is stable: returns the SAME code on a second call", async () => {
    const { env } = fakeEnv();
    const first = await getOrCreateReferralCode("user1", env);
    const second = await getOrCreateReferralCode("user1", env);
    expect(second).toBe(first);
  });

  test("different users get different codes", async () => {
    const { env } = fakeEnv();
    const a = await getOrCreateReferralCode("user1", env);
    const b = await getOrCreateReferralCode("user2", env);
    expect(a).not.toBe(b);
  });
});

describe("resolveReferralCode", () => {
  test("rejects codes without the zin_ prefix (no lookup)", async () => {
    const { env } = fakeEnv();
    expect(await resolveReferralCode("hacker", env)).toBeNull();
  });

  test("resolves via KV on the hot path", async () => {
    const { env, kv } = fakeEnv();
    kv.set("referral_code:zin_abc12345", "owner-1");
    expect(await resolveReferralCode("zin_abc12345", env)).toBe("owner-1");
  });

  test("falls back to D1 when KV is not seeded", async () => {
    const { env, codes } = fakeEnv();
    codes.set("zin_def67890", "owner-2"); // only in D1, not KV
    expect(await resolveReferralCode("zin_def67890", env)).toBe("owner-2");
  });

  test("returns null when the code is unknown", async () => {
    const { env } = fakeEnv();
    expect(await resolveReferralCode("zin_unknown0", env)).toBeNull();
  });
});
