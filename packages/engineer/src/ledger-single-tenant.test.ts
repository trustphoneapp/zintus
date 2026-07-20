import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { EngineerLedger } from "./ledger.js";
import { ENGINEER_DEFAULT_ORG_ID } from "./database-schema.js";
import { EngineerOrgContextError } from "./errors.js";

/**
 * R8-5 (contract §1) SUPERSEDES the P12 Finding-C single-tenant hard-stop. The
 * constructor no longer blanket-rejects a non-default org; instead it binds
 * `tenantOrgId` as the SOLE org source and VALIDATES it against `orgs(id)` — the
 * row must exist AND be ACTIVE. The default org is seeded active by the tenancy
 * migration, so all existing default-org callers construct unchanged. A
 * non-existent or SUSPENDED org is rejected with a typed `EngineerOrgContextError`.
 */
const NOW = "2026-07-20T00:00:00.000Z";
const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function tempDbPath(): string {
  const root = mkdtempSync(join(tmpdir(), "zintus-engineer-org-ctor-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return join(root, "engineer.sqlite");
}

describe("EngineerLedger constructor org validation (contract §1)", () => {
  test("constructs for the default org (baseline — unchanged for all existing callers)", () => {
    const ledger = new EngineerLedger(":memory:");
    expect(ledger.orgId).toBe(ENGINEER_DEFAULT_ORG_ID);
    ledger.close();
    const explicitDefault = new EngineerLedger(":memory:", () => new Date(), undefined, ENGINEER_DEFAULT_ORG_ID);
    expect(explicitDefault.orgId).toBe(ENGINEER_DEFAULT_ORG_ID);
    explicitDefault.close();
  });

  test("rejects an org that is not a known active row in orgs(id)", () => {
    expect(() => new EngineerLedger(":memory:", () => new Date(), undefined, "org-that-was-never-created"))
      .toThrow(EngineerOrgContextError);
  });

  test("rejects a SUSPENDED org even though the row exists", () => {
    const dbPath = tempDbPath();
    // Bring the schema + default org into being, then seed a SUSPENDED org B.
    const seeder = new EngineerLedger(dbPath, () => new Date(NOW));
    seeder.close();
    const raw = new Database(dbPath);
    raw.query("INSERT INTO orgs(id, display_name, default_retention_class, status, created_at, updated_at) VALUES (?,?,?,?,?,?)")
      .run("org-suspended", "Suspended Org", "STANDARD", "SUSPENDED", NOW, NOW);
    raw.close();
    expect(() => new EngineerLedger(dbPath, () => new Date(NOW), undefined, "org-suspended"))
      .toThrow(EngineerOrgContextError);
  });

  test("accepts a non-default org once it exists ACTIVE in orgs(id)", () => {
    const dbPath = tempDbPath();
    const seeder = new EngineerLedger(dbPath, () => new Date(NOW));
    seeder.close();
    const raw = new Database(dbPath);
    raw.query("INSERT INTO orgs(id, display_name, default_retention_class, status, created_at, updated_at) VALUES (?,?,?,?,?,?)")
      .run("org-active-b", "Active Org B", "STANDARD", "ACTIVE", NOW, NOW);
    raw.close();
    const ledgerB = new EngineerLedger(dbPath, () => new Date(NOW), undefined, "org-active-b");
    expect(ledgerB.orgId).toBe("org-active-b");
    ledgerB.close();
  });
});
