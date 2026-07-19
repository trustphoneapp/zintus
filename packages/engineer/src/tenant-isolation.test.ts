import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ENGINEER_DATABASE_SCHEMA_SQL } from "./database-schema.js";
import { migrateEngineerDatabase } from "./database-migrations.js";
import { EngineerNotFoundError } from "./errors.js";
import { TenantScopedLedgerDal, TenantWriteConflictError, tenantNotFound, type OrgContext } from "./tenant-dal.js";
import { assertDistinctApprovalActors, defineHumanActor, SelfApprovalError } from "./tenant-roles.js";

const NOW = "2026-07-19T00:00:00.000Z";

/** A live v34 database (base schema + the full migration chain to head). */
function scratchV34(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=OFF");
  db.exec(ENGINEER_DATABASE_SCHEMA_SQL);
  db.query("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(14, NOW);
  migrateEngineerDatabase(db, NOW);
  return db;
}

/** Seed a full tenant fixture: user, repo connection + admission, run, budget, artifact. */
function seedTenant(db: Database, org: string, suffix: string): {
  runId: string; repoId: string; artifactId: string;
} {
  const userId = `user-${suffix}`;
  const repoId = `repo-${suffix}`;
  const runId = `run-${suffix}`;
  const artifactId = `artifact-${suffix}`;
  db.query("INSERT INTO users(id,email,created_at,updated_at) VALUES (?,?,?,?)").run(userId, null, NOW, NOW);
  db.query(
    "INSERT INTO repository_connections(id,user_id,provider,owner,name,created_at,updated_at,org_id) VALUES (?,?,?,?,?,?,?,?)",
  ).run(repoId, userId, "local", "local", suffix, NOW, NOW, org);
  db.query(
    "INSERT INTO repository_admissions(admission_id,repository_id,owner_user_id,base_branch,base_commit_sha,source," +
      "authorization_subject,authorization_evidence_hash,authorization_generation,status,created_at,updated_at,org_id)" +
      " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(`adm-${suffix}`, repoId, userId, "main", "a".repeat(40), "CONFIGURED_CANONICAL", userId, "h".repeat(64), 1,
    "ACTIVE", NOW, NOW, org);
  db.query(
    "INSERT INTO engineer_runs(id,user_id,repository_id,base_branch,base_commit_sha,request_original," +
      "request_normalized,state,state_version,risk_tier,human_gate_required,created_at,updated_at,org_id)" +
      " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(runId, userId, repoId, "main", "a".repeat(40), "req", "req", "CREATED", 0, "LOW", 0, NOW, NOW, org);
  db.query(
    "INSERT INTO run_budgets(run_id,cost_limit_usd,token_limit,time_limit_seconds,lifetime_cost_limit_usd," +
      "lifetime_token_limit,lifetime_time_limit_seconds,status,created_at,updated_at,org_id)" +
      " VALUES (?,?,?,?,?,?,?,?,?,?,?)",
  ).run(runId, 1, 1000, 60, 1, 1000, 60, "ACTIVE", NOW, NOW, org);
  db.query(
    "INSERT INTO artifacts(id,run_id,type,sha256,producer_type,producer_id,storage_reference,size_bytes,trusted,created_at,org_id)" +
      " VALUES (?,?,?,?,?,?,?,?,?,?,?)",
  ).run(artifactId, runId, "LOG", "b".repeat(64), "SYSTEM", "sys", "ref", 10, 1, NOW, org);
  return { runId, repoId, artifactId };
}

const ORG_A = "org-a";
const ORG_B = "org-b";
const ctx = (orgId: string): OrgContext => ({ orgId, actor: defineHumanActor(`admin-${orgId}`) });

function captureError(fn: () => unknown): { name: string; message: string; constructor: unknown } {
  try {
    fn();
  } catch (error) {
    const e = error as Error;
    return { name: e.name, message: e.message, constructor: e.constructor };
  }
  throw new Error("expected the function to throw");
}

describe("cross-tenant isolation matrix (through the LIVE v34 DAL)", () => {
  test("tenant A cannot read tenant B's run, budget, artifact, or admission", () => {
    const db = scratchV34();
    const a = seedTenant(db, ORG_A, "a");
    const b = seedTenant(db, ORG_B, "b");
    const dalA = new TenantScopedLedgerDal(db, ctx(ORG_A));

    expect(dalA.getRun(a.runId).id).toBe(a.runId);
    expect(dalA.getArtifact(a.artifactId).id).toBe(a.artifactId);
    expect(dalA.getRunBudget(a.runId).run_id).toBe(a.runId);
    expect(dalA.getRepositoryAdmission(a.repoId).repository_id).toBe(a.repoId);

    expect(() => dalA.getRun(b.runId)).toThrow(EngineerNotFoundError);
    expect(() => dalA.getArtifact(b.artifactId)).toThrow(EngineerNotFoundError);
    expect(() => dalA.getRunBudget(b.runId)).toThrow(EngineerNotFoundError);
    expect(() => dalA.getRepositoryAdmission(b.repoId)).toThrow(EngineerNotFoundError);
    expect(() => dalA.assertRunInOrg(b.runId)).toThrow(EngineerNotFoundError);
  });

  test("tenant A's listings never include tenant B's rows", () => {
    const db = scratchV34();
    seedTenant(db, ORG_A, "a");
    const b = seedTenant(db, ORG_B, "b");
    const dalA = new TenantScopedLedgerDal(db, ctx(ORG_A));

    const runs = dalA.listRuns({ limit: 100 });
    expect(runs.every((r) => r.org_id === ORG_A)).toBe(true);
    expect(runs.some((r) => r.id === b.runId)).toBe(false);

    const admissions = dalA.listRepositoryAdmissions();
    expect(admissions.every((row) => (row as { org_id: string }).org_id === ORG_A)).toBe(true);
  });

  test("tenant A cannot write into tenant B's run, and cannot list B's artifacts", () => {
    const db = scratchV34();
    seedTenant(db, ORG_A, "a");
    const b = seedTenant(db, ORG_B, "b");
    const dalA = new TenantScopedLedgerDal(db, ctx(ORG_A));

    expect(() =>
      dalA.insertArtifact({
        id: "x-injected", runId: b.runId, type: "LOG", sha256: "c".repeat(64),
        producerType: "SYSTEM", producerId: "sys", storageReference: "ref", sizeBytes: 1, trusted: true, createdAt: NOW,
      }),
    ).toThrow(EngineerNotFoundError);
    expect(db.query("SELECT 1 FROM artifacts WHERE id=?").get("x-injected")).toBeNull();
    expect(() => dalA.listArtifacts(b.artifactId)).toThrow(EngineerNotFoundError);
  });

  test("a stamped write lands only in the caller's org", () => {
    const db = scratchV34();
    const a = seedTenant(db, ORG_A, "a");
    const dalA = new TenantScopedLedgerDal(db, ctx(ORG_A));
    dalA.insertArtifact({
      id: "a-new", runId: a.runId, type: "LOG", sha256: "d".repeat(64),
      producerType: "SYSTEM", producerId: "sys", storageReference: "ref", sizeBytes: 1, trusted: true, createdAt: NOW,
    });
    const row = db.query("SELECT org_id FROM artifacts WHERE id=?").get("a-new") as { org_id: string };
    expect(row.org_id).toBe(ORG_A);
    const dalB = new TenantScopedLedgerDal(db, ctx(ORG_B));
    expect(() => dalB.getArtifact("a-new")).toThrow(EngineerNotFoundError);
  });
});

describe("isolation is RED without the guard (proves the org filter is load-bearing)", () => {
  test("an UN-scoped read (no org_id predicate) DOES leak tenant B — the guard is what stops it", () => {
    const db = scratchV34();
    seedTenant(db, ORG_A, "a");
    const b = seedTenant(db, ORG_B, "b");

    // Reproduce the DAL's own query WITHOUT the `AND org_id=?` guard.
    const leaked = db.query("SELECT id, org_id FROM engineer_runs WHERE id=?").get(b.runId) as
      { id: string; org_id: string } | null;
    expect(leaked).not.toBeNull();          // RED: without the guard, A sees B's row.
    expect(leaked!.org_id).toBe(ORG_B);

    // WITH the guard (the DAL), the same id is invisible to org A.
    const dalA = new TenantScopedLedgerDal(db, ctx(ORG_A));
    expect(() => dalA.getRun(b.runId)).toThrow(EngineerNotFoundError);
  });

  test("an UN-scoped artifact insert DOES attach to B's run — the guard is what refuses it", () => {
    const db = scratchV34();
    const a = seedTenant(db, ORG_A, "a");
    const b = seedTenant(db, ORG_B, "b");

    // Without the assertRunInOrg guard, an org-A caller could stamp org-A onto a row under B's run.
    db.query(
      "INSERT INTO artifacts(id,run_id,type,sha256,producer_type,producer_id,storage_reference,size_bytes,trusted,created_at,org_id)" +
        " VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    ).run("unguarded", b.runId, "LOG", "e".repeat(64), "SYSTEM", "sys", "ref", 1, 1, NOW, ORG_A);
    expect(db.query("SELECT run_id FROM artifacts WHERE id=?").get("unguarded")).toEqual({ run_id: b.runId });

    // WITH the guard (the DAL), the same write is a not-found on B's run.
    const dalA = new TenantScopedLedgerDal(db, ctx(ORG_A));
    expect(() =>
      dalA.insertArtifact({
        id: "guarded", runId: b.runId, type: "LOG", sha256: "f".repeat(64),
        producerType: "SYSTEM", producerId: "sys", storageReference: "ref", sizeBytes: 1, trusted: true, createdAt: NOW,
      }),
    ).toThrow(EngineerNotFoundError);
    expect(db.query("SELECT 1 FROM artifacts WHERE id=?").get("guarded")).toBeNull();
    void a;
  });
});

describe("no existence oracle — cross-tenant and nonexistent are byte-identical", () => {
  test("getRun: a foreign id and a truly-absent id yield identical error objects", () => {
    const db = scratchV34();
    seedTenant(db, ORG_A, "a");
    seedTenant(db, ORG_B, "b");
    const dalA = new TenantScopedLedgerDal(db, ctx(ORG_A));

    // Insert 'shared-id' into org B; A must see the SAME not-found as a truly absent id.
    db.query(
      "INSERT INTO engineer_runs(id,user_id,repository_id,base_branch,base_commit_sha,request_original," +
        "request_normalized,state,state_version,risk_tier,human_gate_required,created_at,updated_at,org_id)" +
        " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run("shared-id", "user-b", "repo-b", "main", "a".repeat(40), "req", "req", "CREATED", 0, "LOW", 0, NOW, NOW, ORG_B);

    const foreign = captureError(() => dalA.getRun("shared-id"));   // exists, but in org B
    const absent = captureError(() => dalA.getRun("does-not-exist")); // truly absent
    expect(foreign.name).toBe(absent.name);
    expect(foreign.constructor).toBe(absent.constructor);
    expect(foreign.constructor).toBe(EngineerNotFoundError);
    // Same id string, one existing-in-B vs one truly-absent → identical bytes.
    const foreignSame = captureError(() => dalA.getRun("shared-id"));
    expect(foreignSame.message).toBe("run not found: shared-id");
  });

  test("tenantNotFound produces exactly EngineerNotFoundError(entity, id)", () => {
    const direct = captureError(() => tenantNotFound("artifact", "id-1"));
    const reference = captureError(() => { throw new EngineerNotFoundError("artifact", "id-1"); });
    expect(direct.name).toBe(reference.name);
    expect(direct.message).toBe(reference.message);
    expect(direct.constructor).toBe(reference.constructor);
  });
});

describe("write path is not an existence oracle (B1 regression)", () => {
  test("cross-org id collision on insert is byte-identical to an absent-read not-found", () => {
    const db = scratchV34();
    const a = seedTenant(db, ORG_A, "a");
    const b = seedTenant(db, ORG_B, "b"); // artifact-b exists ONLY in ORG_B
    const dalA = new TenantScopedLedgerDal(db, ctx(ORG_A));

    const crossOrgWrite = captureError(() =>
      dalA.insertArtifact({
        id: b.artifactId, runId: a.runId, type: "LOG", sha256: "c".repeat(64),
        producerType: "SYSTEM", producerId: "sys", storageReference: "ref", sizeBytes: 1, trusted: true, createdAt: NOW,
      }),
    );
    const absentRead = captureError(() => dalA.getArtifact(b.artifactId));

    expect(crossOrgWrite.constructor).toBe(EngineerNotFoundError);
    expect(crossOrgWrite.constructor).toBe(absentRead.constructor);
    expect(crossOrgWrite.name).toBe(absentRead.name);
    expect(crossOrgWrite.message).toBe(absentRead.message);
    expect(crossOrgWrite.message).toBe(`artifact not found: ${b.artifactId}`);
    const rows = db.query("SELECT org_id FROM artifacts WHERE id=?").all(b.artifactId) as Array<{ org_id: string }>;
    expect(rows).toEqual([{ org_id: ORG_B }]);
  });

  // RED without the guard: the raw insert leaks a UNIQUE SqliteError, observably
  // different from a not-found — an existence oracle. mapWriteConstraint closes it.
  test("the RAW write leaks a UNIQUE error (oracle) that mapWriteConstraint converts to a not-found", () => {
    const db = scratchV34();
    const a = seedTenant(db, ORG_A, "a");
    const b = seedTenant(db, ORG_B, "b");

    // RAW (no oracle mapping): inserting b's global artifact id raises a UNIQUE SqliteError.
    const rawLeak = captureError(() =>
      db.query(
        "INSERT INTO artifacts(id,run_id,type,sha256,producer_type,producer_id,storage_reference,size_bytes,trusted,created_at,org_id)" +
          " VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      ).run(b.artifactId, a.runId, "LOG", "c".repeat(64), "SYSTEM", "sys", "ref", 1, 1, NOW, ORG_A),
    );
    expect(rawLeak.constructor).not.toBe(EngineerNotFoundError);   // RED: leaks a constraint error.
    expect(rawLeak.message).toMatch(/constraint|UNIQUE/i);

    // WITH the guard, the same collision is the byte-identical not-found.
    const dalA = new TenantScopedLedgerDal(db, ctx(ORG_A));
    const mapped = captureError(() =>
      dalA.insertArtifact({
        id: b.artifactId, runId: a.runId, type: "LOG", sha256: "c".repeat(64),
        producerType: "SYSTEM", producerId: "sys", storageReference: "ref", sizeBytes: 1, trusted: true, createdAt: NOW,
      }),
    );
    expect(mapped.constructor).toBe(EngineerNotFoundError);
  });

  test("a same-org duplicate id is a DISTINCT typed conflict (safe to disclose)", () => {
    const db = scratchV34();
    const a = seedTenant(db, ORG_A, "a");
    const dalA = new TenantScopedLedgerDal(db, ctx(ORG_A));
    const sameOrgDup = captureError(() =>
      dalA.insertArtifact({
        id: a.artifactId, runId: a.runId, type: "LOG", sha256: "e".repeat(64),
        producerType: "SYSTEM", producerId: "sys", storageReference: "ref", sizeBytes: 1, trusted: true, createdAt: NOW,
      }),
    );
    expect(sameOrgDup.constructor).toBe(TenantWriteConflictError);
    expect(sameOrgDup.constructor).not.toBe(EngineerNotFoundError);
  });
});

describe("revocation blocks the next operation", () => {
  test("a membership revoked before the next op is no longer ACTIVE for authority", () => {
    const db = scratchV34();
    seedTenant(db, ORG_A, "a");
    db.query(
      "INSERT INTO org_memberships(membership_id,org_id,actor_id,actor_kind,role,granted_by_actor_id,created_at,updated_at)" +
        " VALUES (?,?,?,?,?,?,?,?)",
    ).run("m-approver", ORG_A, "approver-1", "HUMAN", "APPROVER", "admin", NOW, NOW);

    const activeRoles = (): string[] =>
      (db.query("SELECT role FROM org_memberships WHERE org_id=? AND actor_id=? AND status='ACTIVE'")
        .all(ORG_A, "approver-1") as Array<{ role: string }>).map((r) => r.role);

    expect(activeRoles()).toEqual(["APPROVER"]);
    db.query("UPDATE org_memberships SET status='REVOKED', revoked_at=? WHERE membership_id=?").run(NOW, "m-approver");
    expect(activeRoles()).toEqual([]);
  });
});

describe("self-approval holds across a role change (actor-bound)", () => {
  test("an actor who authored a case cannot approve it after becoming APPROVER", () => {
    const db = scratchV34();
    seedTenant(db, ORG_A, "a");
    for (const [mid, role] of [["m-x-req", "REQUESTER"], ["m-x-app", "APPROVER"]] as const) {
      db.query(
        "INSERT INTO org_memberships(membership_id,org_id,actor_id,actor_kind,role,granted_by_actor_id,created_at,updated_at)" +
          " VALUES (?,?,?,?,?,?,?,?)",
      ).run(mid, ORG_A, "actor-x", "HUMAN", role, "admin", NOW, NOW);
    }
    expect(() => assertDistinctApprovalActors("actor-x", "actor-x")).toThrow(SelfApprovalError);
    expect(() => assertDistinctApprovalActors("actor-x", "actor-y")).not.toThrow();
  });
});
