/**
 * P10 tenancy — roles, deny-by-default permission matrix, and actor identity.
 *
 * Standalone module (contract §5). Wiring into gateway auth is integration
 * work; this file defines the frozen role set, the explicit-grant permission
 * matrix, the human/non-human actor identity types, and the actor-bound
 * self-approval rule that must hold across role changes.
 */

/** Frozen role set (contract §5). Order is not authority; presence is. */
export const TENANT_ROLES = [
  "REQUESTER",
  "RESOLVER",
  "APPROVER",
  "SECURITY_REVIEWER",
  "REPO_ADMIN",
  "ORG_ADMIN",
  "AUDITOR",
] as const;
export type TenantRole = (typeof TENANT_ROLES)[number];

/** Every authority action the matrix governs. Deny-by-default: unlisted ⇒ deny. */
export const TENANT_ACTIONS = [
  "RUN_CREATE",
  "RUN_READ",
  "RESOLUTION_CASE_CREATE",
  "RESOLUTION_CASE_READ",
  "RESOLUTION_DIRECTIVE_ISSUE",
  "RESOLUTION_DIRECTIVE_APPLY",
  "PUBLICATION_CANDIDATE_READ",
  "APPROVAL_DECIDE",
  "PUBLICATION_DISPATCH",
  "SECURITY_REVIEW_READ",
  "SECURITY_REVIEW_DECIDE",
  "REPO_ADMISSION_GRANT",
  "REPO_ADMISSION_REVOKE",
  "BUDGET_SET",
  "ORG_MEMBER_GRANT",
  "ORG_MEMBER_REVOKE",
  "AUDIT_READ",
] as const;
export type TenantAction = (typeof TENANT_ACTIONS)[number];

/**
 * Explicit grants only. A role's set contains exactly the actions it may take;
 * anything absent is denied. No role implicitly inherits another's grants.
 */
const ROLE_GRANTS: Readonly<Record<TenantRole, ReadonlySet<TenantAction>>> = Object.freeze({
  REQUESTER: new Set<TenantAction>([
    "RUN_CREATE",
    "RUN_READ",
    "RESOLUTION_CASE_CREATE",
    "RESOLUTION_CASE_READ",
    "PUBLICATION_CANDIDATE_READ",
  ]),
  RESOLVER: new Set<TenantAction>([
    "RUN_READ",
    "RESOLUTION_CASE_READ",
    "RESOLUTION_DIRECTIVE_ISSUE",
    "RESOLUTION_DIRECTIVE_APPLY",
  ]),
  APPROVER: new Set<TenantAction>([
    "RUN_READ",
    "PUBLICATION_CANDIDATE_READ",
    "APPROVAL_DECIDE",
    "PUBLICATION_DISPATCH",
  ]),
  SECURITY_REVIEWER: new Set<TenantAction>([
    "RUN_READ",
    "PUBLICATION_CANDIDATE_READ",
    "SECURITY_REVIEW_READ",
    "SECURITY_REVIEW_DECIDE",
  ]),
  REPO_ADMIN: new Set<TenantAction>([
    "RUN_READ",
    "REPO_ADMISSION_GRANT",
    "REPO_ADMISSION_REVOKE",
    "BUDGET_SET",
  ]),
  ORG_ADMIN: new Set<TenantAction>([
    "RUN_READ",
    "ORG_MEMBER_GRANT",
    "ORG_MEMBER_REVOKE",
    "BUDGET_SET",
    "REPO_ADMISSION_REVOKE",
  ]),
  // Read-only oversight. AUDITOR is deliberately granted no mutating action.
  AUDITOR: new Set<TenantAction>([
    "RUN_READ",
    "RESOLUTION_CASE_READ",
    "PUBLICATION_CANDIDATE_READ",
    "SECURITY_REVIEW_READ",
    "AUDIT_READ",
  ]),
});

/** Deny-by-default single-role check. */
export function roleCan(role: TenantRole, action: TenantAction): boolean {
  return ROLE_GRANTS[role]?.has(action) ?? false;
}

/** Deny-by-default check for an actor holding a set of ACTIVE roles (union). */
export function actorCan(roles: Iterable<TenantRole>, action: TenantAction): boolean {
  for (const role of roles) {
    if (roleCan(role, action)) return true;
  }
  return false;
}

/** Actor identity kinds. */
export type ActorKind = "HUMAN" | "NON_HUMAN";

export interface HumanActorIdentity {
  readonly actorId: string;
  readonly actorKind: "HUMAN";
}

/**
 * AI agents / automation carry a non-human identity with a MANDATORY human
 * sponsor. `humanSponsorId` is required by the type — omitting it is a compile
 * error — and `defineNonHumanActor` re-checks it at runtime.
 */
export interface NonHumanActorIdentity {
  readonly actorId: string;
  readonly actorKind: "NON_HUMAN";
  readonly humanSponsorId: string;
}

export type ActorIdentity = HumanActorIdentity | NonHumanActorIdentity;

export function defineHumanActor(actorId: string): HumanActorIdentity {
  if (!actorId.trim()) throw new Error("human actor id is required");
  return { actorId, actorKind: "HUMAN" };
}

export function defineNonHumanActor(input: { actorId: string; humanSponsorId: string }): NonHumanActorIdentity {
  if (!input.actorId.trim()) throw new Error("non-human actor id is required");
  if (!input.humanSponsorId.trim()) {
    throw new Error("non-human actor requires a human sponsor");
  }
  if (input.humanSponsorId === input.actorId) {
    throw new Error("a non-human actor cannot sponsor itself");
  }
  return { actorId: input.actorId, actorKind: "NON_HUMAN", humanSponsorId: input.humanSponsorId };
}

/**
 * Self-approval rejection binds ACTOR IDENTITY, not role (contract §5 / §3).
 * The same actor that authored the request may never approve it — even after a
 * role change that grants APPROVER — because the identity, not the current
 * role, is compared.
 */
export class SelfApprovalError extends Error {
  readonly code = "SELF_APPROVAL";
  constructor(readonly actorId: string) {
    super("The actor that authored this request cannot approve it.");
    this.name = "SelfApprovalError";
  }
}

/** Throws `SelfApprovalError` when requester and approver are the same actor. */
export function assertDistinctApprovalActors(requesterActorId: string, approverActorId: string): void {
  if (requesterActorId === approverActorId) throw new SelfApprovalError(approverActorId);
}
