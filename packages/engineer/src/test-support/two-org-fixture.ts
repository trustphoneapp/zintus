/**
 * R8-5 shared two-org test fixture (contract §5, §9).
 *
 * The reusable primitive EVERY converted bucket AND the central cross-tenant
 * negative-test matrix builds on. It creates two orgs (A = the ledger's default
 * org, B = a foreign org) on ONE shared SQLite file — the ledger-instance-per-org
 * architecture (contract §1) means orgA and orgB ledgers are two `EngineerLedger`
 * instances over the SAME database, which is the only way a cross-tenant read can
 * even be attempted. It seeds an actor + ACTIVE membership per org and hands back
 * a ledger bound to each, plus a raw seed handle for planting org-stamped rows.
 *
 * NOT a test file itself (no `bun:test` import) so it can be imported by any
 * bucket's `*.test.ts`. Deliberately generic: it makes NO assumptions about which
 * tables a bucket exercises.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { EngineerLedger } from "../ledger.js";
import { ENGINEER_DEFAULT_ORG_ID } from "../database-schema.js";
import type { TenantRole } from "../tenant-roles.js";

export interface TwoOrgFixtureOptions {
  /** Fixed clock value for both ledgers + seeded timestamps. */
  readonly now?: string;
  /** Override org B's id (default `"org-b-foreign"`). Org A is always the default org. */
  readonly orgBId?: string;
  /** Actor id granted an ACTIVE membership in org A (default `"actor-a"`). */
  readonly actorAId?: string;
  /** Actor id granted an ACTIVE membership in org B (default `"actor-b"`). */
  readonly actorBId?: string;
  /** Roles seeded for each actor in their own org (default `["REQUESTER", "APPROVER"]`). */
  readonly roles?: readonly TenantRole[];
}

export interface TwoOrgFixture {
  readonly root: string;
  readonly dbPath: string;
  /** Org A === the ledger default org (`ENGINEER_DEFAULT_ORG_ID`). */
  readonly orgAId: string;
  readonly orgBId: string;
  readonly actorAId: string;
  readonly actorBId: string;
  readonly now: string;
  /** The `EngineerLedger` bound to org A (constructed eagerly; cached). */
  ledgerA(): EngineerLedger;
  /** The `EngineerLedger` bound to org B (constructed lazily; cached). */
  ledgerB(): EngineerLedger;
  /** A fresh raw handle on the shared file with `foreign_keys=OFF` for planting rows. */
  seed(): Database;
  /** Grant an additional ACTIVE role to an actor in an org (idempotent per role). */
  grantRole(orgId: string, actorId: string, role: TenantRole, actorKind?: "HUMAN" | "NON_HUMAN", humanSponsorId?: string): void;
  /** Close every constructed ledger and remove the temp directory. */
  cleanup(): void;
}

const DEFAULT_NOW = "2026-07-20T00:00:00.000Z";
const DEFAULT_ROLES: readonly TenantRole[] = ["REQUESTER", "APPROVER"];

export function createTwoOrgFixture(options: TwoOrgFixtureOptions = {}): TwoOrgFixture {
  const now = options.now ?? DEFAULT_NOW;
  const orgAId = ENGINEER_DEFAULT_ORG_ID;
  const orgBId = options.orgBId ?? "org-b-foreign";
  const actorAId = options.actorAId ?? "actor-a";
  const actorBId = options.actorBId ?? "actor-b";
  const roles = options.roles ?? DEFAULT_ROLES;

  const root = mkdtempSync(join(tmpdir(), "zintus-engineer-two-org-"));
  const dbPath = join(root, "engineer.sqlite");

  // Construct org A first: this creates the schema + runs the tenancy migration,
  // which seeds the default (org A) row ACTIVE. Only then can org B be seeded.
  const ledgerAInstance = new EngineerLedger(dbPath, () => new Date(now));
  let ledgerBInstance: EngineerLedger | null = null;

  const membershipSql =
    "INSERT OR IGNORE INTO org_memberships(membership_id, org_id, actor_id, actor_kind, role," +
    " human_sponsor_id, status, granted_by_actor_id, created_at, updated_at, revoked_at)" +
    " VALUES (?,?,?,?,?,?, 'ACTIVE', 'system-bootstrap', ?, ?, NULL)";

  function grantRoleOn(
    db: Database,
    orgId: string,
    actorId: string,
    role: TenantRole,
    actorKind: "HUMAN" | "NON_HUMAN",
    humanSponsorId: string | null,
  ): void {
    db.query(membershipSql).run(
      `mem-${orgId}-${actorId}-${role}`,
      orgId,
      actorId,
      actorKind,
      role,
      humanSponsorId,
      now,
      now,
    );
  }

  // Seed org B ACTIVE + an ACTIVE membership per actor in their own org.
  const bootstrap = new Database(dbPath);
  bootstrap.exec("PRAGMA foreign_keys=OFF");
  bootstrap.query("INSERT OR IGNORE INTO orgs(id, display_name, default_retention_class, status, created_at, updated_at) VALUES (?,?,?,?,?,?)")
    .run(orgBId, "Foreign Org B", "STANDARD", "ACTIVE", now, now);
  for (const role of roles) {
    grantRoleOn(bootstrap, orgAId, actorAId, role, "HUMAN", null);
    grantRoleOn(bootstrap, orgBId, actorBId, role, "HUMAN", null);
  }
  bootstrap.close();

  return {
    root,
    dbPath,
    orgAId,
    orgBId,
    actorAId,
    actorBId,
    now,
    ledgerA() {
      return ledgerAInstance;
    },
    ledgerB() {
      if (!ledgerBInstance) {
        ledgerBInstance = new EngineerLedger(dbPath, () => new Date(now), undefined, orgBId);
      }
      return ledgerBInstance;
    },
    seed() {
      const db = new Database(dbPath);
      db.exec("PRAGMA foreign_keys=OFF");
      return db;
    },
    grantRole(orgId, actorId, role, actorKind = "HUMAN", humanSponsorId) {
      const db = new Database(dbPath);
      try {
        grantRoleOn(db, orgId, actorId, role, actorKind, humanSponsorId ?? null);
      } finally {
        db.close();
      }
    },
    cleanup() {
      try { ledgerAInstance.close(); } catch { /* already closed */ }
      if (ledgerBInstance) {
        try { ledgerBInstance.close(); } catch { /* already closed */ }
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}
