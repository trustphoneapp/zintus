import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  ENGINEER_DATABASE_BASE_SCHEMA_VERSION,
  ENGINEER_DATABASE_SCHEMA_SQL,
  ENGINEER_DATABASE_SCHEMA_VERSION,
} from "./database-schema.js";
import { migrateEngineerDatabase } from "./database-migrations.js";
import { sha256 } from "./hash.js";

// R8-5 D5 tenancy-enforcement immutability regression (contract §5).
//
// v39 adds a DURABLE `requester_actor_id` column to approval_requests so the
// structural two-person check reads the requester from an at-rest column instead
// of reconstructing it. A genuinely-shipped v38 database has approval_requests
// rows that PREDATE that column; this fixture proves such an at-rest row upgrades
// clean to head and carries the documented '' sentinel afterwards.
//
// ORIGINAL_SHIPPED_APPROVAL_REQUESTS_SQL is a HARDCODED, byte-literal copy of the
// approval_requests CREATE TABLE as it GENUINELY SHIPPED at its v14 origin — the
// twelve-column form, WITHOUT requester_actor_id (and without any of the columns
// later ALTER-added by the v21/v22/v23/v34 migrations). It deliberately does NOT
// reference ENGINEER_DATABASE_SCHEMA_SQL: a real historical database created by
// the shipped v14 code has exactly this shape, and if a future edit ever splices
// requester_actor_id into the base CREATE (or an earlier migration) — which would
// silently turn v39 into a no-op and hide the fact that historical rows never had
// a durable requester — this frozen literal must stay honest so the regression
// reds. Do not "DRY" this against the live schema constant.
const ORIGINAL_SHIPPED_APPROVAL_REQUESTS_SQL = `
  CREATE TABLE approval_requests (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES engineer_runs(id) ON DELETE RESTRICT,
    risk_tier TEXT NOT NULL,
    assigned_reviewer_id TEXT,
    requested_at TEXT NOT NULL,
    deadline_at TEXT NOT NULL,
    reminder_schedule_json TEXT NOT NULL,
    timeout_action TEXT NOT NULL,
    manifest_hash TEXT NOT NULL,
    diff_hash TEXT NOT NULL,
    evidence_bundle_hash TEXT NOT NULL,
    status TEXT NOT NULL
  );
`;

/**
 * Build a genuinely-shipped legacy database whose approval_requests table is the
 * FROZEN v14-origin twelve-column shape (created from the literal above, not the
 * live schema). The base schema's own `CREATE TABLE IF NOT EXISTS approval_requests`
 * therefore no-ops, leaving the frozen table in place, and the real forward
 * migrations ALTER-add every later column on top of it — exactly as they would to a
 * real at-rest v14 database. One historical approval_requests row is seeded at the
 * v14 stage (before the v21/v22 checkpoint-binding triggers exist), with a NULL
 * verified checkpoint, proving the forward chain preserves a pre-durable-requester
 * row all the way to head.
 */
function seedGenuinelyShippedApprovalRequestsDatabase(at: string): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  // Frozen origin approval_requests FIRST; the live base's IF NOT EXISTS then no-ops.
  db.exec(ORIGINAL_SHIPPED_APPROVAL_REQUESTS_SQL);
  db.exec(ENGINEER_DATABASE_SCHEMA_SQL);
  db.query("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
    .run(ENGINEER_DATABASE_BASE_SCHEMA_VERSION, at);

  const manifestHash = sha256("hist-approval-manifest");
  db.query("INSERT INTO users(id, created_at, updated_at) VALUES ('hist-user', ?, ?)").run(at, at);
  db.query(`INSERT INTO repository_connections
    (id, user_id, provider, owner, name, created_at, updated_at)
    VALUES ('hist-repo', 'hist-user', 'local', 'local', 'hist', ?, ?)`).run(at, at);
  db.query(`INSERT INTO engineer_runs
    (id, user_id, repository_id, base_branch, base_commit_sha, request_original, request_normalized,
     state, state_version, manifest_hash, risk_tier, human_gate_required, created_at, updated_at)
    VALUES ('hist-run', 'hist-user', 'hist-repo', 'main', ?, 'request', 'request',
      'PLAN_FROZEN', 1, ?, 'LOW', 0, ?, ?)`).run("a".repeat(40), manifestHash, at, at);
  db.query(`INSERT INTO task_manifest_versions
    (id, run_id, version, manifest_hash, manifest_json, created_at)
    VALUES ('hist-manifest-id', 'hist-run', 1, ?, '{}', ?)`).run(manifestHash, at);
  // Historical approval request in the ORIGINAL 12-column shape (no durable
  // requester, no checkpoint columns). Seeded at v14 so the later BEFORE INSERT
  // checkpoint-authority triggers never had a chance to fire.
  db.query(`INSERT INTO approval_requests
    (id, run_id, risk_tier, assigned_reviewer_id, requested_at, deadline_at,
     reminder_schedule_json, timeout_action, manifest_hash, diff_hash, evidence_bundle_hash, status)
    VALUES ('hist-approval', 'hist-run', 'LOW', NULL, ?, ?, '[]', 'PAUSE', ?, ?, ?, 'PENDING')`)
    .run(at, at, manifestHash, sha256("hist-diff"), sha256("hist-bundle"));
  return db;
}

describe("migration 39 (durable requester) immutability", () => {
  test("original shipped approval_requests row (no requester_actor_id) upgrades cleanly to head", () => {
    const at = "2026-07-19T00:00:00.000Z";
    const db = seedGenuinelyShippedApprovalRequestsDatabase(at);

    // Sanity: the seeded historical table genuinely lacks the durable requester column.
    const seededColumns = new Set((db.query("PRAGMA table_info(approval_requests)").all() as Array<{ name: string }>)
      .map((row) => row.name));
    expect(seededColumns.has("requester_actor_id")).toBe(false);

    // The gateway open path: run every forward migration on the historical DB. On
    // pre-v39 code the durable requester column is never added; the assertions below
    // (column present + '' sentinel on the historical row) are what fail then.
    expect(() => migrateEngineerDatabase(db, at)).not.toThrow();

    expect(db.query("SELECT MAX(version) AS version FROM schema_migrations").get())
      .toEqual({ version: ENGINEER_DATABASE_SCHEMA_VERSION });

    const upgradedColumns = new Set((db.query("PRAGMA table_info(approval_requests)").all() as Array<{ name: string }>)
      .map((row) => row.name));
    expect(upgradedColumns.has("requester_actor_id")).toBe(true);

    // The historical row survives the forward migration.
    const row = db.query(`SELECT id, requester_actor_id, status
      FROM approval_requests WHERE id = 'hist-approval'`).get() as {
        id: string; requester_actor_id: string; status: string;
      } | null;
    expect(row).not.toBeNull();
    expect(row!.id).toBe("hist-approval");
    expect(row!.status).toBe("PENDING");
    // A pre-v39 row carries the documented empty sentinel for the added column.
    expect(row!.requester_actor_id).toBe("");
    // foreign_key_check is clean over the whole database after the upgrade.
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    db.close();
  });

  test("the durable requester column is NOT NULL with a '' default (rows written after v39 must supply it)", () => {
    const at = "2026-07-19T00:00:00.000Z";
    const db = seedGenuinelyShippedApprovalRequestsDatabase(at);
    migrateEngineerDatabase(db, at);
    const requester = (db.query("PRAGMA table_info(approval_requests)").all() as Array<{
      name: string; notnull: number; dflt_value: unknown;
    }>).find((c) => c.name === "requester_actor_id");
    expect(requester).toBeDefined();
    expect(requester!.notnull).toBe(1);
    expect(String(requester!.dflt_value)).toContain("''");
    db.close();
  });
});
