import { describe, expect, test } from "bun:test";
import {
  assertAuthority,
  assertNotRevoked,
  assertDistinctApprovalActors,
  AuthorizationError,
  SelfApprovalError,
  type TenantRole,
} from "./tenant-roles.js";

/**
 * R8-5 (contract §4/§5/§6) — the callable, deny-by-default authority primitives
 * D2/D3/D4 + buckets will wire at method entries. Tested in ISOLATION here; they
 * are intentionally NOT yet wired at any call site.
 */
describe("assertAuthority — deny-by-default RBAC gate (contract §4)", () => {
  test("unknown action is denied (not in the frozen TENANT_ACTIONS)", () => {
    expect(() => assertAuthority("NOT_A_REAL_ACTION", { roles: ["ORG_ADMIN"] }))
      .toThrow(AuthorizationError);
  });

  test("a role that is NOT granted the action is denied", () => {
    // AUDITOR is read-only oversight: it holds NO mutating grant.
    expect(() => assertAuthority("ORG_MEMBER_GRANT", { roles: ["AUDITOR"] }))
      .toThrow(AuthorizationError);
    // REQUESTER cannot decide approvals.
    expect(() => assertAuthority("APPROVAL_DECIDE", { roles: ["REQUESTER"] }))
      .toThrow(AuthorizationError);
  });

  test("an actor with NO roles is denied every action (deny-by-default)", () => {
    const noRoles: readonly TenantRole[] = [];
    expect(() => assertAuthority("RUN_READ", { roles: noRoles })).toThrow(AuthorizationError);
  });

  test("a granted role passes (APPROVER may APPROVAL_DECIDE)", () => {
    expect(() => assertAuthority("APPROVAL_DECIDE", { roles: ["APPROVER"] })).not.toThrow();
  });

  test("a grant held by ANY of the actor's roles (union) passes", () => {
    expect(() => assertAuthority("ORG_MEMBER_GRANT", { roles: ["REQUESTER", "ORG_ADMIN"] })).not.toThrow();
  });
});

describe("assertDistinctApprovalActors — structural two-person (contract §5)", () => {
  test("same actor id (self-approval) throws — identity-based, not role-based", () => {
    expect(() => assertDistinctApprovalActors("human-1", "human-1")).toThrow(SelfApprovalError);
  });

  test("distinct actors pass", () => {
    expect(() => assertDistinctApprovalActors("requester-1", "approver-2")).not.toThrow();
  });
});

describe("assertNotRevoked — revocation re-check skeleton (contract §6)", () => {
  test("a missing authority is blocked", () => {
    expect(() => assertNotRevoked(null, "membership")).toThrow(AuthorizationError);
    expect(() => assertNotRevoked(undefined, "membership")).toThrow(AuthorizationError);
  });

  test("a REVOKED authority is blocked at the moment of use", () => {
    expect(() => assertNotRevoked({ status: "REVOKED", revokedAt: "2026-07-20T00:00:00.000Z" }, "approval"))
      .toThrow(AuthorizationError);
  });

  test("an ACTIVE authority with no revocation stamp passes", () => {
    expect(() => assertNotRevoked({ status: "ACTIVE", revokedAt: null }, "membership")).not.toThrow();
  });
});
