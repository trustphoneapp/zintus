import { describe, expect, test } from "bun:test";
import { findOrCreateUser } from "../src/index.js";
import type { UserRow } from "../src/types.js";

// B-Lane fix 5: findOrCreateUser normalises the email (trim + lowercase) on BOTH
// the lookup and the insert, so case/whitespace variants of the same address
// resolve to ONE user row instead of silently creating duplicates. The
// rate-limit path already lowercases (magicLinkEmailKey); the persisted row now
// agrees. Without this, "User@Example.com" and "user@example.com" each create a
// distinct account for the same inbox.

/** In-memory D1 modelling the `zintus_users` table keyed by the stored email. */
function fakeUsersDb() {
  const rows: UserRow[] = [];
  return {
    rows,
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        first: async <T,>() => {
          if (/SELECT \* FROM zintus_users WHERE email/i.test(sql)) {
            const email = args[0] as string;
            return (rows.find((r) => r.email === email) ?? null) as T | null;
          }
          return null as T | null;
        },
        run: async () => {
          if (/INSERT INTO zintus_users/i.test(sql)) {
            const [id, email, created_at] = args as [string, string, number];
            rows.push({ id, email, created_at });
          }
          return {};
        },
      }),
    }),
  };
}

describe("findOrCreateUser — email normalisation (duplicate prevention)", () => {
  test("case + whitespace variants resolve to a single user row", async () => {
    const db = fakeUsersDb();
    const u1 = await findOrCreateUser(db as never, "User@Example.com");
    const u2 = await findOrCreateUser(db as never, "  user@example.com ");
    const u3 = await findOrCreateUser(db as never, "USER@EXAMPLE.COM");

    expect(db.rows.length).toBe(1); // only one row ever inserted
    expect(u1.id).toBe(u2.id);
    expect(u2.id).toBe(u3.id);
    expect(db.rows[0]!.email).toBe("user@example.com"); // stored normalised
  });

  test("genuinely different addresses still create distinct users", async () => {
    const db = fakeUsersDb();
    await findOrCreateUser(db as never, "a@example.com");
    await findOrCreateUser(db as never, "b@example.com");
    expect(db.rows.length).toBe(2);
  });

  test("is idempotent — a repeat lookup returns the original row, not a fresh insert", async () => {
    const db = fakeUsersDb();
    const first = await findOrCreateUser(db as never, "stable@example.com");
    const again = await findOrCreateUser(db as never, "STABLE@example.com");
    expect(again.id).toBe(first.id);
    expect(again.created_at).toBe(first.created_at); // original timestamp preserved
    expect(db.rows.length).toBe(1);
  });
});
