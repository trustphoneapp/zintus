import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  AUTHORITY_ACTOR_TABLES,
  CONNECTOR_IDENTITY_TABLES,
  ENGINEER_DATABASE_SCHEMA_SQL,
  ENGINEER_DEFAULT_ORG_ID,
  RETENTION_CLASS_TABLES,
  TENANT_OWNED_TABLES,
} from "./database-schema.js";
import { migrateEngineerDatabase } from "./database-migrations.js";

const NOW = "2026-07-19T00:00:00.000Z";

/** A real database migrated through the LIVE chain to the current head (v34). */
function scratchLive(now = NOW): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=OFF");
  db.exec(ENGINEER_DATABASE_SCHEMA_SQL);
  db.query("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(14, now);
  migrateEngineerDatabase(db, now);
  return db;
}

/** A real database migrated to v33 ONLY — the pre-v34 forward-install fixture. */
function scratchV33(now = NOW): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=OFF");
  db.exec(ENGINEER_DATABASE_SCHEMA_SQL);
  db.query("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(14, now);
  migrateEngineerDatabase(db, now, 33);
  return db;
}

function columnNames(db: Database, table: string): Set<string> {
  return new Set((db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name));
}

function seedPreV34Run(db: Database, runId: string): void {
  db.query("INSERT INTO users(id,email,created_at,updated_at) VALUES (?,?,?,?)")
    .run("user-legacy", null, NOW, NOW);
  db.query("INSERT INTO repository_connections(id,user_id,provider,owner,name,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
    .run("repo-legacy", "user-legacy", "local", "local", "repo", NOW, NOW);
  db.query(
    "INSERT INTO engineer_runs(id,user_id,repository_id,base_branch,base_commit_sha,request_original," +
      "request_normalized,state,state_version,risk_tier,human_gate_required,created_at,updated_at)" +
      " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(runId, "user-legacy", "repo-legacy", "main", "a".repeat(40), "req", "req", "CREATED", 0, "LOW", 0, NOW, NOW);
}

describe("v34 forward-install on a populated v33 database", () => {
  test("every pre-v34 row is backfilled into the single-tenant DEFAULT org, readable, FK-clean", () => {
    const db = scratchV33();
    expect((db.query("SELECT MAX(version) v FROM schema_migrations").get() as { v: number }).v).toBe(33);
    seedPreV34Run(db, "run-legacy");

    // Forward-install v34 onto the populated v33 DB.
    migrateEngineerDatabase(db, NOW);
    expect((db.query("SELECT MAX(version) v FROM schema_migrations").get() as { v: number }).v).toBe(34);

    const run = db.query("SELECT org_id, retention_class, user_id FROM engineer_runs WHERE id=?").get("run-legacy") as {
      org_id: string; retention_class: string; user_id: string;
    };
    expect(run.org_id).toBe(ENGINEER_DEFAULT_ORG_ID);
    expect(run.retention_class).toBe("STANDARD");
    // Additive only: the legacy identity column is untouched.
    expect(run.user_id).toBe("user-legacy");

    const repo = db.query("SELECT org_id, connector_actor_id, connector_actor_kind FROM repository_connections WHERE id=?")
      .get("repo-legacy") as { org_id: string; connector_actor_id: string; connector_actor_kind: string };
    expect(repo.org_id).toBe(ENGINEER_DEFAULT_ORG_ID);
    expect(repo.connector_actor_id).toBe("connector:legacy-unattributed");
    expect(repo.connector_actor_kind).toBe("HUMAN");

    // foreign_key_check is clean over the whole database after the install.
    expect(db.query("PRAGMA foreign_key_check").all().length).toBe(0);
    // The default org row exists exactly once.
    expect((db.query("SELECT COUNT(*) n FROM orgs WHERE id=?").get(ENGINEER_DEFAULT_ORG_ID) as { n: number }).n).toBe(1);
  });

  test("every tenant-owned table gains a NOT NULL org_id (incl. the v31/v33 tables)", () => {
    const db = scratchLive();
    for (const table of TENANT_OWNED_TABLES) {
      const org = (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string; notnull: number }>)
        .find((c) => c.name === "org_id");
      expect(org, `${table} must have org_id`).toBeDefined();
      expect(org!.notnull, `${table}.org_id must be NOT NULL`).toBe(1);
    }
    // The P7/P8 tables that did not exist at the draft's v30 base are covered.
    for (const table of [
      "resolution_cases", "resolution_directives", "resolution_events", "resolution_replacements",
      "publication_candidate_selections_v33", "publication_approvals_v33", "publication_git_operations_v33",
      "publication_remote_receipts_v33", "publication_reconciliations_v33",
    ]) {
      expect(columnNames(db, table).has("org_id"), `${table} must be org-scoped`).toBe(true);
    }
  });

  test("retention, connector, and authority-actor columns are present where required", () => {
    const db = scratchLive();
    for (const t of RETENTION_CLASS_TABLES) expect(columnNames(db, t).has("retention_class")).toBe(true);
    for (const t of CONNECTOR_IDENTITY_TABLES) {
      expect(columnNames(db, t).has("connector_actor_id")).toBe(true);
      expect(columnNames(db, t).has("connector_actor_kind")).toBe(true);
    }
    for (const t of AUTHORITY_ACTOR_TABLES) {
      expect(columnNames(db, t).has("authority_actor_id")).toBe(true);
      expect(columnNames(db, t).has("authority_actor_kind")).toBe(true);
    }
  });
});

describe("v34 preserves every prior schema object (additive only)", () => {
  test("v14-v33 objects survive: the v31/v33 exact-shape validators still pass at v34", () => {
    // scratchLive() runs the full chain including the end-of-migration
    // assertResolutionDeskShape / assertPublicationAuthorityShape / assertTenancyShape;
    // reaching v34 without throwing IS the proof the prior bytes are intact modulo org_id.
    const db = scratchLive();
    expect((db.query("SELECT MAX(version) v FROM schema_migrations").get() as { v: number }).v).toBe(34);
  });
});

describe("v34 immutability / fence triggers (v29/v30 style)", () => {
  test("orgs cannot be deleted and their identity is immutable", () => {
    const db = scratchLive();
    expect(() => db.query("DELETE FROM orgs WHERE id=?").run(ENGINEER_DEFAULT_ORG_ID)).toThrow(/durable/);
    expect(() => db.query("UPDATE orgs SET id=? WHERE id=?").run("x", ENGINEER_DEFAULT_ORG_ID)).toThrow(/immutable/);
  });

  test("org membership status is monotonic ACTIVE -> REVOKED and never deleted", () => {
    const db = scratchLive();
    db.query(
      "INSERT INTO org_memberships(membership_id,org_id,actor_id,actor_kind,role,granted_by_actor_id,created_at,updated_at)" +
        " VALUES (?,?,?,?,?,?,?,?)",
    ).run("m1", ENGINEER_DEFAULT_ORG_ID, "human-1", "HUMAN", "APPROVER", "admin", NOW, NOW);
    db.query("UPDATE org_memberships SET status='REVOKED', revoked_at=? WHERE membership_id=?").run(NOW, "m1");
    expect(() =>
      db.query("UPDATE org_memberships SET status='ACTIVE', revoked_at=NULL WHERE membership_id=?").run("m1"),
    ).toThrow(/monotonic/);
    expect(() => db.query("DELETE FROM org_memberships WHERE membership_id=?").run("m1")).toThrow(/durable/);
  });
});

describe("v34 sponsor CHECKs match the code guard (B2 regression)", () => {
  const insertMembership = (db: Database, actorId: string, sponsor: string | null) =>
    db.query(
      "INSERT INTO org_memberships(membership_id,org_id,actor_id,actor_kind,role,human_sponsor_id,granted_by_actor_id,created_at,updated_at)" +
        " VALUES (?,?,?,?,?,?,?,?,?)",
    ).run(`m-${actorId}`, ENGINEER_DEFAULT_ORG_ID, actorId, "NON_HUMAN", "REQUESTER", sponsor, "admin", NOW, NOW);
  const insertActor = (db: Database, actorId: string, sponsor: string) =>
    db.query(
      "INSERT INTO non_human_actors(actor_id,org_id,human_sponsor_id,display_name,status,created_at,updated_at)" +
        " VALUES (?,?,?,?,?,?,?)",
    ).run(actorId, ENGINEER_DEFAULT_ORG_ID, sponsor, "bot", "ACTIVE", NOW, NOW);

  test("org_memberships rejects an EMPTY-STRING sponsor for a NON_HUMAN actor", () => {
    expect(() => insertMembership(scratchLive(), "bot-1", "")).toThrow();
  });
  test("org_memberships rejects a self-sponsoring NON_HUMAN actor", () => {
    expect(() => insertMembership(scratchLive(), "bot-self", "bot-self")).toThrow();
  });
  test("non_human_actors rejects a WHITESPACE-ONLY sponsor", () => {
    expect(() => insertActor(scratchLive(), "bot-2", "   ")).toThrow();
  });
  test("non_human_actors rejects a self-sponsoring actor", () => {
    expect(() => insertActor(scratchLive(), "bot-3", "bot-3")).toThrow();
  });
  test("a well-formed non-human actor + membership still inserts", () => {
    const db = scratchLive();
    expect(() => insertActor(db, "bot-ok", "human-sponsor")).not.toThrow();
    expect(() => insertMembership(db, "bot-ok-m", "human-sponsor")).not.toThrow();
  });
});

describe("completeness tripwire — every ownership-shaped table is org-scoped", () => {
  const OWNERSHIP_COLUMNS = new Set(["user_id", "run_id", "owner_user_id", "requester_user_id"]);
  const unlistedOwnershipTables = (db: Database): string[] => {
    const owned = new Set<string>(TENANT_OWNED_TABLES);
    const tables = (db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
      .map((r) => r.name);
    const missing: string[] = [];
    for (const table of tables) {
      const cols = (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
      if (cols.some((c) => OWNERSHIP_COLUMNS.has(c)) && !owned.has(table)) missing.push(table);
    }
    return missing;
  };

  test("the live v34 schema has NO unlisted ownership-shaped table", () => {
    expect(unlistedOwnershipTables(scratchLive())).toEqual([]);
    expect(TENANT_OWNED_TABLES.length).toBeGreaterThan(50);
    expect(new Set(TENANT_OWNED_TABLES).size).toBe(TENANT_OWNED_TABLES.length);
    expect([...TENANT_OWNED_TABLES]).not.toContain("users");
    expect([...TENANT_OWNED_TABLES]).not.toContain("schema_migrations");
  });

  // Proves the tripwire has teeth: an ownership-shaped table absent from
  // TENANT_OWNED_TABLES is caught. RED without the guard = the tripwire fires.
  test("the tripwire FIRES when an ownership-shaped table is left unlisted", () => {
    const db = scratchLive();
    expect(unlistedOwnershipTables(db)).toEqual([]);
    db.exec("CREATE TABLE rogue_untenanted_records (id TEXT PRIMARY KEY, run_id TEXT NOT NULL)");
    expect(unlistedOwnershipTables(db)).toEqual(["rogue_untenanted_records"]);
  });
});
