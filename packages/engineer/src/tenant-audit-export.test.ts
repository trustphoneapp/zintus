import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ENGINEER_DATABASE_SCHEMA_SQL } from "./database-schema.js";
import { migrateEngineerDatabase } from "./database-migrations.js";
import { EngineerNotFoundError } from "./errors.js";
import { TenantScopedLedgerDal, type OrgContext } from "./tenant-dal.js";
import { defineHumanActor } from "./tenant-roles.js";
import { REDACTED_PATH, REDACTED_SECRET } from "./audit-export.js";

const NOW = "2026-07-19T00:00:00.000Z";
const ORG_A = "org-a";
const ORG_B = "org-b";
const ctx = (orgId: string): OrgContext => ({ orgId, actor: defineHumanActor(`admin-${orgId}`) });

function scratchV34(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=OFF");
  db.exec(ENGINEER_DATABASE_SCHEMA_SQL);
  db.query("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(14, NOW);
  migrateEngineerDatabase(db, NOW);
  return db;
}

/** Seed a run and a couple of state events for it, all stamped to `org`. */
function seedRun(db: Database, org: string, suffix: string): string {
  const userId = `user-${suffix}`;
  const repoId = `repo-${suffix}`;
  const runId = `run-${suffix}`;
  db.query("INSERT INTO users(id,email,created_at,updated_at) VALUES (?,?,?,?)").run(userId, null, NOW, NOW);
  db.query(
    "INSERT INTO repository_connections(id,user_id,provider,owner,name,created_at,updated_at,org_id) VALUES (?,?,?,?,?,?,?,?)",
  ).run(repoId, userId, "local", "local", suffix, NOW, NOW, org);
  db.query(
    "INSERT INTO engineer_runs(id,user_id,repository_id,base_branch,base_commit_sha,request_original," +
      "request_normalized,state,state_version,risk_tier,human_gate_required,created_at,updated_at,org_id)" +
      " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(runId, userId, repoId, "main", "a".repeat(40), "req", "req", "CREATED", 0, "LOW", 0, NOW, NOW, org);
  insertEvent(db, org, runId, `evt-${suffix}-1`, 1, "CREATED", "PLANNING", { note: "benign" });
  insertEvent(db, org, runId, `evt-${suffix}-2`, 2, "PLANNING", "EXECUTING", { note: "benign" });
  return runId;
}

function insertEvent(
  db: Database,
  org: string,
  runId: string,
  eventId: string,
  sequence: number,
  previous: string,
  next: string,
  payload: Record<string, unknown>,
): void {
  db.query(
    "INSERT INTO run_state_events(event_id,run_id,sequence,previous_state,next_state,reason_code,actor_type," +
      "actor_id,timestamp,evidence_ids_json,manifest_hash,state_version,idempotency_key,org_id)" +
      " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    eventId, runId, sequence, previous, next, "TRANSITION", "SUPERVISOR",
    JSON.stringify(payload.actorId ?? "engineer-supervisor"), NOW, "[]", null, sequence,
    `idem-${eventId}`, org,
  );
}

describe("P11 live org-scoped audit export (through the v34 DAL)", () => {
  test("export contains only the caller-org's rows; foreign run is not-found", () => {
    const db = scratchV34();
    const runA = seedRun(db, ORG_A, "a");
    const runB = seedRun(db, ORG_B, "b");
    const dalA = new TenantScopedLedgerDal(db, ctx(ORG_A));

    const exportA = dalA.exportRunAuditChain(runA, 100);
    expect(exportA.tenantId).toBe(ORG_A);
    expect(exportA.runId).toBe(runA);
    const ids = exportA.pages.flatMap((page) => page.entries).map((entry) => entry.id);
    expect(ids).toEqual(["evt-a-1", "evt-a-2"]);
    for (const entry of exportA.pages.flatMap((page) => page.entries)) {
      expect(entry.tenantId).toBe(ORG_A);
    }

    // A foreign run id is the byte-identical not-found — no existence oracle.
    expect(() => dalA.exportRunAuditChain(runB)).toThrow(EngineerNotFoundError);
  });

  test("RED-WITHOUT-FILTER: a foreign-org row smuggled under this run's id is excluded", () => {
    const db = scratchV34();
    const runA = seedRun(db, ORG_A, "a");
    // A corrupt/foreign row that carries runA's run_id but ORG_B's org_id. The
    // reader's `AND org_id=?` clause is the ONLY thing that keeps it out of A's
    // export; drop that clause and this row leaks (the RED-without-wiring proof).
    insertEvent(db, ORG_B, runA, "evt-smuggled", 99, "EXECUTING", "REVIEWING", { note: "cross-org" });
    const dalA = new TenantScopedLedgerDal(db, ctx(ORG_A));

    const ids = dalA.exportRunAuditChain(runA).pages.flatMap((page) => page.entries).map((entry) => entry.id);
    expect(ids).toEqual(["evt-a-1", "evt-a-2"]);
    expect(ids).not.toContain("evt-smuggled");
  });

  test("redaction: a smuggled secret / path in an event payload never survives export", () => {
    const db = scratchV34();
    const runA = seedRun(db, ORG_A, "a");
    // The reader emits actor_id verbatim into the payload; prove the redactor in
    // the export pipeline scrubs a path/token even from a live DB row.
    insertEvent(db, ORG_A, runA, "evt-a-3", 3, "EXECUTING", "REVIEWING", {
      actorId: "wrote /Users/yash/secret/key.pem with token ghp_verysecrettoken0000000000",
    });
    const dalA = new TenantScopedLedgerDal(db, ctx(ORG_A));
    const serialized = JSON.stringify(dalA.exportRunAuditChain(runA));
    expect(serialized).not.toContain("/Users/yash/secret/key.pem");
    expect(serialized).not.toContain("ghp_verysecrettoken0000000000");
    expect(serialized.includes(REDACTED_PATH) || serialized.includes(REDACTED_SECRET)).toBe(true);
  });
});
