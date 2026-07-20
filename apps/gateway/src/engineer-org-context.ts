import type { Database } from "bun:sqlite";
import { AuthorizationError, type TenantRole } from "@zintus/engineer";

/**
 * R8-5 (contract §3) — `resolveOrgContext`, the SINGLE gateway seam that derives
 * an authenticated principal's org from `org_memberships` (actor_id → org_id,
 * status 'active'). NO caller derives org any other way; the composition root
 * builds the per-org `EngineerLedger` from this result (contract §1).
 *
 * A missing or inactive membership is an AUTHN/AUTHZ failure → `AuthorizationError`,
 * deliberately DISTINCT from `EngineerNotFoundError` (a data-absence result). The
 * membership row must be ACTIVE and its org must be ACTIVE.
 *
 * STRICTER READING (contract ambiguity → strict): if the actor holds ACTIVE
 * memberships spanning MORE THAN ONE org, the principal is ambiguous and is
 * denied rather than silently resolved to an arbitrary org. A caller that must
 * select among several orgs passes an explicit `orgId`.
 */
export interface OrgPrincipal {
  readonly actorId: string;
  /** Optional explicit org selection when the actor belongs to several orgs. */
  readonly orgId?: string;
}

export interface ResolvedOrgActor {
  readonly actorId: string;
  readonly orgId: string;
  readonly roles: readonly TenantRole[];
}

export interface ResolvedOrgContext {
  readonly orgId: string;
  readonly actor: ResolvedOrgActor;
}

export function resolveOrgContext(db: Database, principal: OrgPrincipal): ResolvedOrgContext {
  const actorId = principal.actorId?.trim();
  if (!actorId) throw new AuthorizationError("principal actor id is required");

  const rows = db
    .query(
      "SELECT m.org_id AS org_id, m.role AS role FROM org_memberships m" +
        " JOIN orgs o ON o.id = m.org_id" +
        " WHERE m.actor_id = ? AND m.status = 'ACTIVE' AND o.status = 'ACTIVE'",
    )
    .all(actorId) as Array<{ org_id: string; role: TenantRole }>;

  if (rows.length === 0) {
    throw new AuthorizationError("no active org membership for principal");
  }

  const distinctOrgIds = new Set(rows.map((row) => row.org_id));
  let orgId: string;
  if (principal.orgId !== undefined) {
    if (!distinctOrgIds.has(principal.orgId)) {
      throw new AuthorizationError("principal has no active membership in the requested org");
    }
    orgId = principal.orgId;
  } else {
    if (distinctOrgIds.size > 1) {
      throw new AuthorizationError("ambiguous org membership for principal; an explicit org is required");
    }
    orgId = rows[0]!.org_id;
  }

  const roles = [...new Set(rows.filter((row) => row.org_id === orgId).map((row) => row.role))];
  return { orgId, actor: { actorId, orgId, roles } };
}
