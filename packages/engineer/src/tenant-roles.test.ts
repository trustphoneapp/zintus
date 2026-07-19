import { describe, expect, test } from "bun:test";
import {
  SelfApprovalError,
  TENANT_ACTIONS,
  TENANT_ROLES,
  actorCan,
  assertDistinctApprovalActors,
  defineHumanActor,
  defineNonHumanActor,
  roleCan,
  type TenantAction,
  type TenantRole,
} from "./tenant-roles.js";

describe("frozen role set", () => {
  test("matches the contract exactly, in order", () => {
    expect([...TENANT_ROLES]).toEqual([
      "REQUESTER", "RESOLVER", "APPROVER", "SECURITY_REVIEWER", "REPO_ADMIN", "ORG_ADMIN", "AUDITOR",
    ]);
  });
});

describe("deny-by-default permission matrix", () => {
  test("only explicitly granted (role, action) pairs are allowed; all others deny", () => {
    // Explicit grants (the only trues in the whole matrix).
    const grants: Array<[TenantRole, TenantAction]> = [
      ["REQUESTER", "RUN_CREATE"], ["REQUESTER", "RUN_READ"], ["REQUESTER", "RESOLUTION_CASE_CREATE"],
      ["REQUESTER", "RESOLUTION_CASE_READ"], ["REQUESTER", "PUBLICATION_CANDIDATE_READ"],
      ["RESOLVER", "RUN_READ"], ["RESOLVER", "RESOLUTION_CASE_READ"], ["RESOLVER", "RESOLUTION_DIRECTIVE_ISSUE"],
      ["RESOLVER", "RESOLUTION_DIRECTIVE_APPLY"],
      ["APPROVER", "RUN_READ"], ["APPROVER", "PUBLICATION_CANDIDATE_READ"], ["APPROVER", "APPROVAL_DECIDE"],
      ["APPROVER", "PUBLICATION_DISPATCH"],
      ["SECURITY_REVIEWER", "RUN_READ"], ["SECURITY_REVIEWER", "PUBLICATION_CANDIDATE_READ"],
      ["SECURITY_REVIEWER", "SECURITY_REVIEW_READ"], ["SECURITY_REVIEWER", "SECURITY_REVIEW_DECIDE"],
      ["REPO_ADMIN", "RUN_READ"], ["REPO_ADMIN", "REPO_ADMISSION_GRANT"], ["REPO_ADMIN", "REPO_ADMISSION_REVOKE"],
      ["REPO_ADMIN", "BUDGET_SET"],
      ["ORG_ADMIN", "RUN_READ"], ["ORG_ADMIN", "ORG_MEMBER_GRANT"], ["ORG_ADMIN", "ORG_MEMBER_REVOKE"],
      ["ORG_ADMIN", "BUDGET_SET"], ["ORG_ADMIN", "REPO_ADMISSION_REVOKE"],
      ["AUDITOR", "RUN_READ"], ["AUDITOR", "RESOLUTION_CASE_READ"], ["AUDITOR", "PUBLICATION_CANDIDATE_READ"],
      ["AUDITOR", "SECURITY_REVIEW_READ"], ["AUDITOR", "AUDIT_READ"],
    ];
    const granted = new Set(grants.map(([r, a]) => `${r}:${a}`));
    for (const role of TENANT_ROLES) {
      for (const action of TENANT_ACTIONS) {
        expect(roleCan(role, action)).toBe(granted.has(`${role}:${action}`));
      }
    }
  });

  test("AUDITOR holds no mutating grant", () => {
    const mutating: TenantAction[] = [
      "RUN_CREATE", "RESOLUTION_CASE_CREATE", "RESOLUTION_DIRECTIVE_ISSUE", "RESOLUTION_DIRECTIVE_APPLY",
      "APPROVAL_DECIDE", "PUBLICATION_DISPATCH", "SECURITY_REVIEW_DECIDE", "REPO_ADMISSION_GRANT",
      "REPO_ADMISSION_REVOKE", "BUDGET_SET", "ORG_MEMBER_GRANT", "ORG_MEMBER_REVOKE",
    ];
    for (const action of mutating) expect(roleCan("AUDITOR", action)).toBe(false);
  });

  test("no single role can both create a run and approve a publication (separation of duties)", () => {
    for (const role of TENANT_ROLES) {
      expect(roleCan(role, "RUN_CREATE") && roleCan(role, "APPROVAL_DECIDE")).toBe(false);
    }
  });

  test("actorCan is the union over an actor's active roles", () => {
    expect(actorCan(["REQUESTER"], "APPROVAL_DECIDE")).toBe(false);
    expect(actorCan(["REQUESTER", "APPROVER"], "APPROVAL_DECIDE")).toBe(true);
    expect(actorCan([], "RUN_READ")).toBe(false);
  });
});

describe("non-human actor identity requires a human sponsor", () => {
  test("defineNonHumanActor rejects a missing or blank sponsor", () => {
    expect(() => defineNonHumanActor({ actorId: "agent-1", humanSponsorId: "" })).toThrow(/sponsor/);
    expect(() => defineNonHumanActor({ actorId: "agent-1", humanSponsorId: "   " })).toThrow(/sponsor/);
  });

  test("a non-human actor cannot sponsor itself", () => {
    expect(() => defineNonHumanActor({ actorId: "agent-1", humanSponsorId: "agent-1" })).toThrow(/itself/);
  });

  test("valid identities carry their kind", () => {
    expect(defineHumanActor("human-1")).toEqual({ actorId: "human-1", actorKind: "HUMAN" });
    expect(defineNonHumanActor({ actorId: "agent-1", humanSponsorId: "human-1" })).toEqual({
      actorId: "agent-1", actorKind: "NON_HUMAN", humanSponsorId: "human-1",
    });
  });
});

describe("self-approval is actor-bound, not role-bound (property)", () => {
  test("the authoring actor can never approve its own request, even after gaining APPROVER", () => {
    // Simulate a role change: actor X starts as REQUESTER, later holds APPROVER.
    for (let i = 0; i < 200; i++) {
      const actorX = `actor-${i}`;
      // As REQUESTER, X authors the request.
      expect(actorCan(["REQUESTER"], "RESOLUTION_CASE_CREATE")).toBe(true);
      // X's role changes to include APPROVER — the role check now passes...
      expect(actorCan(["REQUESTER", "APPROVER"], "APPROVAL_DECIDE")).toBe(true);
      // ...but the actor-bound self-approval check still rejects X approving X.
      expect(() => assertDistinctApprovalActors(actorX, actorX)).toThrow(SelfApprovalError);
    }
  });

  test("a distinct approver is permitted", () => {
    expect(() => assertDistinctApprovalActors("requester-1", "approver-2")).not.toThrow();
  });

  test("SelfApprovalError carries the SELF_APPROVAL code and the actor", () => {
    try {
      assertDistinctApprovalActors("x", "x");
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(SelfApprovalError);
      expect((error as SelfApprovalError).code).toBe("SELF_APPROVAL");
      expect((error as SelfApprovalError).actorId).toBe("x");
    }
  });
});
