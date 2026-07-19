import type { Database } from "bun:sqlite";
import { EngineerNotFoundError } from "./errors.js";
import type { ActorIdentity } from "./tenant-roles.js";
import { exportAuditChain, type AuditEntry, type AuditExport } from "./audit-export.js";

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
  JOIN repository_connections rc ON rc.id = r.repository_id AND rc.org_id = r.org_id
`;

const REPOSITORY_ADMISSION_SELECT = `
  SELECT a.*, rc.provider, rc.owner, rc.name AS repository_name, rc.url AS repository_url
  FROM repository_admissions a
  JOIN repository_connections rc ON rc.id = a.repository_id AND rc.org_id = a.org_id
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
   * P11 live audit export — reads a run's event + attestation chain ORG-SCOPED
   * and maps it into the redaction-and-checksum `AuditEntry` shape. Every query
   * carries `AND org_id=?`, so a row that was smuggled under this tenant's
   * `run_id` but stamped to a FOREIGN org is excluded (the `AND org_id=?`
   * clauses are the load-bearing tenant fence; without them a cross-org row
   * would leak into this tenant's export). The run itself is first fenced by
   * `assertRunInOrg`, so a foreign run id is the byte-identical not-found.
   */
  readRunAuditEntries(runId: string): AuditEntry[] {
    this.assertRunInOrg(runId);
    const entries: AuditEntry[] = [];
    const events = this.db
      .query(
        "SELECT event_id, sequence, timestamp, previous_state, next_state, reason_code, actor_type," +
          " actor_id, state_version FROM run_state_events WHERE run_id=? AND org_id=? ORDER BY sequence, event_id",
      )
      .all(runId, this.context.orgId) as Array<Record<string, unknown>>;
    for (const event of events) {
      entries.push({
        kind: "EVENT",
        id: String(event.event_id),
        sequence: Number(event.sequence),
        tenantId: this.context.orgId,
        runId,
        recordedAt: String(event.timestamp),
        payload: {
          previousState: event.previous_state,
          nextState: event.next_state,
          reasonCode: event.reason_code,
          actorType: event.actor_type,
          actorId: event.actor_id,
          stateVersion: event.state_version,
        },
      });
    }
    const checkpoints = this.db
      .query(
        "SELECT id, checkpoint_hash, created_at, statement_hash, signature_algorithm, signature_key_id" +
          " FROM verified_candidate_checkpoints WHERE run_id=? AND org_id=? ORDER BY created_at, id",
      )
      .all(runId, this.context.orgId) as Array<Record<string, unknown>>;
    let attestationSequence = 1_000_000;
    for (const checkpoint of checkpoints) {
      entries.push({
        kind: "ATTESTATION",
        id: String(checkpoint.id),
        sequence: attestationSequence,
        tenantId: this.context.orgId,
        runId,
        recordedAt: String(checkpoint.created_at),
        payload: {
          checkpointHash: checkpoint.checkpoint_hash,
          statementHash: checkpoint.statement_hash,
          algorithm: checkpoint.signature_algorithm,
          keyId: checkpoint.signature_key_id,
        },
      });
      attestationSequence += 1;
    }
    // v35 provenance attestations. The real durable store is `provenance_attestations`
    // (database-schema.ts:3294) — checkpoint-keyed with NO run_id column, so the run is
    // reached by JOINing its subject `verified_candidate_checkpoints` row on the bound
    // (id, checkpoint_hash) pair and filtering on that checkpoint's `run_id`. The
    // attestation's OWN `org_id` is the load-bearing tenant fence (a foreign-org
    // attestation smuggled under this run's checkpoint is excluded by `AND pa.org_id=?`).
    const provenance = this.tableExists("provenance_attestations")
      ? (this.db
          .query(
            "SELECT pa.statement_hash, pa.subject_checkpoint_id, pa.subject_checkpoint_hash," +
              " pa.approval_decision_id, pa.approver_actor_id, pa.signature_key_id, pa.signature_algorithm," +
              " pa.payload_type, pa.created_at FROM provenance_attestations pa" +
              " JOIN verified_candidate_checkpoints vcc" +
              " ON pa.subject_checkpoint_id = vcc.id AND pa.subject_checkpoint_hash = vcc.checkpoint_hash" +
              " WHERE vcc.run_id=? AND pa.org_id=? ORDER BY pa.created_at, pa.statement_hash",
          )
          .all(runId, this.context.orgId) as Array<Record<string, unknown>>)
      : [];
    let provenanceSequence = 2_000_000;
    for (const row of provenance) {
      entries.push({
        kind: "ATTESTATION",
        id: String(row.statement_hash),
        sequence: provenanceSequence,
        tenantId: this.context.orgId,
        runId,
        recordedAt: String(row.created_at),
        payload: {
          statementHash: row.statement_hash,
          subjectCheckpointId: row.subject_checkpoint_id,
          subjectCheckpointHash: row.subject_checkpoint_hash,
          approvalDecisionId: row.approval_decision_id,
          approverActorId: row.approver_actor_id,
          keyId: row.signature_key_id,
          algorithm: row.signature_algorithm,
          payloadType: row.payload_type,
        },
      });
      provenanceSequence += 1;
    }
    return entries;
  }

  /** Build the deterministic, redacted, org-scoped audit export for a run. */
  exportRunAuditChain(runId: string, pageSize = 100): AuditExport {
    return exportAuditChain({
      tenantId: this.context.orgId,
      runId,
      entries: this.readRunAuditEntries(runId),
      pageSize,
    });
  }

  private tableExists(name: string): boolean {
    return this.db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) !== null;
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
