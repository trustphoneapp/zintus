import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { AuthorizationError, TENANCY_AUTHORITY_TABLES_SQL } from "@zintus/engineer";
import { resolveOrgContext } from "./engineer-org-context.js";

/**
 * R8-5 (contract §3) — unit test for the single gateway org-resolution seam.
 */
const NOW = "2026-07-20T00:00:00.000Z";

function makeDb(): Database {
  const db = new Database(":memory:");
  db.exec(TENANCY_AUTHORITY_TABLES_SQL);
  return db;
}

function insertOrg(db: Database, id: string, status: "ACTIVE" | "SUSPENDED" = "ACTIVE"): void {
  db.query("INSERT INTO orgs(id, display_name, default_retention_class, status, created_at, updated_at) VALUES (?,?,?,?,?,?)")
    .run(id, `Org ${id}`, "STANDARD", status, NOW, NOW);
}

function insertMembership(
  db: Database,
  orgId: string,
  actorId: string,
  role: string,
  status: "ACTIVE" | "REVOKED" = "ACTIVE",
): void {
  db.query(
    "INSERT INTO org_memberships(membership_id, org_id, actor_id, actor_kind, role, human_sponsor_id," +
      " status, granted_by_actor_id, created_at, updated_at, revoked_at) VALUES (?,?,?,?,?,NULL,?, 'admin', ?, ?, ?)",
  ).run(
    `mem-${orgId}-${actorId}-${role}`, orgId, actorId, "HUMAN", role, status, NOW, NOW,
    status === "REVOKED" ? NOW : null,
  );
}

describe("resolveOrgContext (contract §3)", () => {
  test("resolves org + roles from an ACTIVE membership", () => {
    const db = makeDb();
    insertOrg(db, "org-a");
    insertMembership(db, "org-a", "actor-1", "APPROVER");
    insertMembership(db, "org-a", "actor-1", "REQUESTER");

    const ctx = resolveOrgContext(db, { actorId: "actor-1" });
    expect(ctx.orgId).toBe("org-a");
    expect(ctx.actor.actorId).toBe("actor-1");
    expect([...ctx.actor.roles].sort()).toEqual(["APPROVER", "REQUESTER"]);
  });

  test("no membership → AuthorizationError (NOT a not-found)", () => {
    const db = makeDb();
    insertOrg(db, "org-a");
    expect(() => resolveOrgContext(db, { actorId: "ghost" })).toThrow(AuthorizationError);
  });

  test("a REVOKED membership does not resolve → AuthorizationError", () => {
    const db = makeDb();
    insertOrg(db, "org-a");
    insertMembership(db, "org-a", "actor-1", "APPROVER", "REVOKED");
    expect(() => resolveOrgContext(db, { actorId: "actor-1" })).toThrow(AuthorizationError);
  });

  test("a membership in a SUSPENDED org does not resolve → AuthorizationError", () => {
    const db = makeDb();
    insertOrg(db, "org-suspended", "SUSPENDED");
    insertMembership(db, "org-suspended", "actor-1", "APPROVER");
    expect(() => resolveOrgContext(db, { actorId: "actor-1" })).toThrow(AuthorizationError);
  });

  test("memberships spanning multiple orgs are ambiguous without an explicit org → AuthorizationError", () => {
    const db = makeDb();
    insertOrg(db, "org-a");
    insertOrg(db, "org-b");
    insertMembership(db, "org-a", "actor-1", "APPROVER");
    insertMembership(db, "org-b", "actor-1", "REQUESTER");
    expect(() => resolveOrgContext(db, { actorId: "actor-1" })).toThrow(AuthorizationError);
  });

  test("an explicit org selects among multiple memberships", () => {
    const db = makeDb();
    insertOrg(db, "org-a");
    insertOrg(db, "org-b");
    insertMembership(db, "org-a", "actor-1", "APPROVER");
    insertMembership(db, "org-b", "actor-1", "REQUESTER");
    const ctx = resolveOrgContext(db, { actorId: "actor-1", orgId: "org-b" });
    expect(ctx.orgId).toBe("org-b");
    expect([...ctx.actor.roles]).toEqual(["REQUESTER"]);
  });

  test("an explicit org the actor is not a member of → AuthorizationError", () => {
    const db = makeDb();
    insertOrg(db, "org-a");
    insertOrg(db, "org-b");
    insertMembership(db, "org-a", "actor-1", "APPROVER");
    expect(() => resolveOrgContext(db, { actorId: "actor-1", orgId: "org-b" })).toThrow(AuthorizationError);
  });
});
