import type { Database } from "bun:sqlite";
import { EngineerNotFoundError } from "./errors.js";
import type { ActorIdentity } from "./tenant-roles.js";

/**
 * P10 tenancy — tenant-scoped Data Access Layer (standalone, contract §5).
 *
 * Every method carries `org_id`; the constructor REQUIRES an org context, so
 * `new TenantScopedLedgerDal(db)` is a compile error. This is designed as a
 * wrapper the existing `EngineerLedger` can adopt incrementally: each method
 * mirrors a real ledger query pattern with the sole change of scoping on the
 * v34 `org_id` column instead of the single-tenant `user_id`.
 *
 * NOTE (not yet proven — integration): the real `EngineerLedger` is not wired
 * to this DAL, and gateway auth still derives a single `ownerId` from server
 * config (`apps/gateway/src/engineer-identity.ts`). Mapping that owner to an
 * org membership + role, and forbidding raw `db.query` on tenant tables via
 * lint, are integration steps outside this lane.
 */

/** Immutable org + actor context. Construction without it is a type error. */
export interface OrgContext {
  readonly orgId: string;
  readonly actor: ActorIdentity;
}

/**
 * Safe not-found: cross-tenant access and a genuinely nonexistent id must
 * produce the byte-identical response, so the DAL never becomes an existence
 * oracle. Both paths funnel through this single helper, which throws the exact
 * `EngineerNotFoundError(entity, id)` the ledger already returns for missing
 * ids — same class, same `.name`, same `.message`.
 */
export function tenantNotFound(entity: string, id: string): never {
  throw new EngineerNotFoundError(entity, id);
}

/**
 * A conflict the caller is entitled to observe because it concerns data in the
 * caller's OWN org (e.g. a duplicate id already owned by this tenant, or a
 * uniqueness collision inside a run this tenant owns). Cross-tenant collisions
 * are never surfaced as this — they map to `tenantNotFound` so foreign-tenant
 * state cannot be probed.
 */
export class TenantWriteConflictError extends Error {
  readonly code = "TENANT_WRITE_CONFLICT";
  constructor(readonly entity: string, readonly id: string) {
    super(`${entity} write conflict: ${id}`);
    this.name = "TenantWriteConflictError";
  }
}

/** True for any SQLite UNIQUE/PRIMARY KEY/constraint failure. */
function isSqliteConstraintError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && code.startsWith("SQLITE_CONSTRAINT")) return true;
  return /constraint failed|UNIQUE/i.test(error.message);
}

export interface TenantRunRow {
  id: string;
  org_id: string;
  user_id: string;
  repository_id: string;
  state: string;
  created_at: string;
  [column: string]: unknown;
}

export interface ListRunsOptions {
  limit: number;
  cursor?: { createdAt: string; id: string };
}

const RUN_SELECT = `
  SELECT r.*, rc.provider, rc.owner, rc.name AS repository_name, rc.url AS repository_url
  FROM engineer_runs r
  JOIN repository_connections rc ON rc.id = r.repository_id
`;

const REPOSITORY_ADMISSION_SELECT = `
  SELECT a.*, rc.provider, rc.owner, rc.name AS repository_name, rc.url AS repository_url
  FROM repository_admissions a
  JOIN repository_connections rc ON rc.id = a.repository_id
`;

export class TenantScopedLedgerDal {
  private readonly db: Database;
  private readonly context: OrgContext;

  constructor(db: Database, context: OrgContext) {
    this.db = db;
    this.context = context;
  }

  get orgId(): string {
    return this.context.orgId;
  }

  get actor(): ActorIdentity {
    return this.context.actor;
  }

  /**
   * Ownership guard — the org-scoped analogue of the ledger's ubiquitous
   * `SELECT 1 FROM engineer_runs WHERE id=? AND user_id=?`. Returns the run's
   * org on success; maps a foreign or absent run to the identical not-found.
   */
  assertRunInOrg(runId: string, entity = "run"): void {
    const row = this.db
      .query("SELECT 1 FROM engineer_runs WHERE id=? AND org_id=?")
      .get(runId, this.context.orgId);
    if (!row) tenantNotFound(entity, runId);
  }

  /** Org-scoped `RUN_SELECT WHERE r.id=? AND r.org_id=?`. */
  getRun(runId: string): TenantRunRow {
    const row = this.db
      .query(`${RUN_SELECT} WHERE r.id=? AND r.org_id=?`)
      .get(runId, this.context.orgId) as TenantRunRow | null;
    if (!row) tenantNotFound("run", runId);
    return row;
  }

  /** Org-scoped, keyset-paginated run list (newest first) — ledger `listRuns`. */
  listRuns(options: ListRunsOptions): TenantRunRow[] {
    if (options.cursor) {
      return this.db
        .query(
          `${RUN_SELECT} WHERE r.org_id=? AND (r.created_at < ? OR (r.created_at = ? AND r.id < ?))` +
            " ORDER BY r.created_at DESC, r.id DESC LIMIT ?",
        )
        .all(
          this.context.orgId,
          options.cursor.createdAt,
          options.cursor.createdAt,
          options.cursor.id,
          options.limit,
        ) as TenantRunRow[];
    }
    return this.db
      .query(`${RUN_SELECT} WHERE r.org_id=? ORDER BY r.created_at DESC, r.id DESC LIMIT ?`)
      .all(this.context.orgId, options.limit) as TenantRunRow[];
  }

  /** Org-scoped `run_budgets` fetch (budget rows are tenant-owned via v34 org_id). */
  getRunBudget(runId: string): Record<string, unknown> {
    const row = this.db
      .query("SELECT * FROM run_budgets WHERE run_id=? AND org_id=?")
      .get(runId, this.context.orgId) as Record<string, unknown> | null;
    if (!row) tenantNotFound("run budget", runId);
    return row;
  }

  /** Org-scoped artifact fetch — cross-tenant artifact id ⇒ identical not-found. */
  getArtifact(artifactId: string): Record<string, unknown> {
    const row = this.db
      .query("SELECT * FROM artifacts WHERE id=? AND org_id=?")
      .get(artifactId, this.context.orgId) as Record<string, unknown> | null;
    if (!row) tenantNotFound("artifact", artifactId);
    return row;
  }

  /** Org-scoped artifact listing for a run the caller owns. */
  listArtifacts(runId: string): Array<Record<string, unknown>> {
    this.assertRunInOrg(runId);
    return this.db
      .query("SELECT * FROM artifacts WHERE run_id=? AND org_id=? ORDER BY created_at, id")
      .all(runId, this.context.orgId) as Array<Record<string, unknown>>;
  }

  /** Org-scoped repository admissions — ledger `REPOSITORY_ADMISSION_SELECT`. */
  listRepositoryAdmissions(): Array<Record<string, unknown>> {
    return this.db
      .query(`${REPOSITORY_ADMISSION_SELECT} WHERE a.org_id=? ORDER BY a.created_at, a.repository_id`)
      .all(this.context.orgId) as Array<Record<string, unknown>>;
  }

  getRepositoryAdmission(repositoryId: string): Record<string, unknown> {
    const row = this.db
      .query(`${REPOSITORY_ADMISSION_SELECT} WHERE a.repository_id=? AND a.org_id=?`)
      .get(repositoryId, this.context.orgId) as Record<string, unknown> | null;
    if (!row) tenantNotFound("repository admission", repositoryId);
    return row;
  }

  /**
   * Write path — stamps the caller's org_id and refuses to attach to a run in
   * another org (mapped to the identical not-found). Demonstrates that writes,
   * not only reads, are tenant-fenced.
   */
  insertArtifact(input: {
    id: string;
    runId: string;
    type: string;
    sha256: string;
    producerType: string;
    producerId: string;
    storageReference: string;
    sizeBytes: number;
    trusted: boolean;
    createdAt: string;
  }): void {
    this.assertRunInOrg(input.runId, "run");
    try {
      this.db
        .query(
          "INSERT INTO artifacts(id, run_id, type, sha256, producer_type, producer_id, storage_reference," +
            " size_bytes, trusted, created_at, org_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          input.id,
          input.runId,
          input.type,
          input.sha256,
          input.producerType,
          input.producerId,
          input.storageReference,
          input.sizeBytes,
          input.trusted ? 1 : 0,
          input.createdAt,
          this.context.orgId,
        );
    } catch (error) {
      this.mapWriteConstraint("artifact", "artifacts", input.id, error);
    }
  }

  /**
   * Every tenant-scoped write must funnel its constraint failures through this
   * guard. `artifacts.id` is a GLOBAL primary key, so a caller-chosen id that
   * collides with a row in ANOTHER org would otherwise surface a raw
   * `SqliteError` (UNIQUE) — observably different from an absent id — leaking
   * foreign-tenant existence. Mapping:
   *  - id already present in ANOTHER org  → `tenantNotFound` (byte-identical to
   *    a read of an id this tenant cannot see; no existence oracle);
   *  - id/uniqueness collision within the caller's OWN org → a distinct typed
   *    `TenantWriteConflictError` the caller is entitled to see;
   *  - anything that is not a constraint failure → rethrown unchanged.
   */
  private mapWriteConstraint(entity: string, table: string, id: string, error: unknown): never {
    if (!isSqliteConstraintError(error)) throw error;
    const existing = this.db
      .query(`SELECT org_id FROM ${table} WHERE id=?`)
      .get(id) as { org_id: string } | null;
    if (existing && existing.org_id !== this.context.orgId) tenantNotFound(entity, id);
    throw new TenantWriteConflictError(entity, id);
  }
}
