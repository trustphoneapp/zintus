import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import { z } from "zod";
import { canonicalJson, sha256 } from "./hash.js";

export const WORKER_LEASE_MIN_TTL_MS = 1_000;
export const WORKER_LEASE_MAX_TTL_MS = 5 * 60_000;
export const WORKER_LEASE_MAX_RENEWALS = 1_000;
export const WORKER_LEASE_MAX_CONCURRENCY = 64;
export const WORKER_LEASE_MAX_WATCHDOG_BATCH = 64;

const IdentifierSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9._:/-]+$/);
const HashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const IsoTimestampSchema = z.string().datetime({ offset: true });

export const WorkerLeaseStatusSchema = z.enum(["ACTIVE", "RELEASED", "EXPIRED"]);
export const WorkerRecoveryStatusSchema = z.enum(["NONE", "PENDING", "IN_PROGRESS", "COMPLETED", "FAILED"]);

export const WorkerLeaseRecordSchema = z.object({
  leaseId: IdentifierSchema,
  resourceKey: IdentifierSchema,
  ownerId: IdentifierSchema,
  fencingToken: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  tokenHash: HashSchema,
  ttlMs: z.number().int().min(WORKER_LEASE_MIN_TTL_MS).max(WORKER_LEASE_MAX_TTL_MS),
  maxRenewals: z.number().int().min(0).max(WORKER_LEASE_MAX_RENEWALS),
  renewalCount: z.number().int().nonnegative().max(WORKER_LEASE_MAX_RENEWALS),
  acquiredAt: IsoTimestampSchema,
  heartbeatAt: IsoTimestampSchema,
  expiresAt: IsoTimestampSchema,
  status: WorkerLeaseStatusSchema,
  releasedAt: IsoTimestampSchema.nullable(),
  recoveryStatus: WorkerRecoveryStatusSchema,
  recoveryAttempts: z.number().int().nonnegative(),
  lastRecoveryError: z.string().max(2_000).nullable(),
}).strict().superRefine((lease, context) => {
  if (lease.renewalCount > lease.maxRenewals) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["renewalCount"], message: "renewal count exceeds the durable lease bound" });
  }
  if (lease.status === "ACTIVE" && lease.releasedAt !== null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["releasedAt"], message: "active leases cannot have a release timestamp" });
  }
});
export type WorkerLeaseRecord = z.infer<typeof WorkerLeaseRecordSchema>;

export const WorkerLeaseGrantSchema = z.object({
  lease: WorkerLeaseRecordSchema,
  leaseToken: z.string().min(43).max(128),
}).strict();
export type WorkerLeaseGrant = z.infer<typeof WorkerLeaseGrantSchema>;

export interface AcquireWorkerLeaseInput {
  resourceKey: string;
  ownerId: string;
  ttlMs: number;
  idempotencyKey: string;
}

export interface WorkerLeaseCommand {
  leaseId: string;
  ownerId: string;
  fencingToken: number;
  leaseToken: string;
  idempotencyKey: string;
}

export interface WorkerLeaseManagerOptions {
  dbPath: string;
  tokenSecret: string | Uint8Array;
  maxConcurrentLeases: number;
  maxRenewals?: number;
  maxRecoveryAttempts?: number;
  recoveryClaimTtlMs?: number;
  recoveryRetryDelayMs?: number;
  watchdogIntervalMs?: number;
  now?: () => Date;
  idFactory?: () => string;
  recoverExpiredLease: (lease: WorkerLeaseRecord) => void | Promise<void>;
}

export interface WorkerWatchdogResult {
  expiredLeaseIds: string[];
  recoveredLeaseIds: string[];
  failedLeaseIds: string[];
}

export class WorkerLeaseConflictError extends Error {
  constructor(message: string) { super(message); this.name = "WorkerLeaseConflictError"; }
}
export class WorkerLeaseCapacityError extends Error {
  constructor(limit: number) { super(`worker lease concurrency limit reached (${limit})`); this.name = "WorkerLeaseCapacityError"; }
}
export class StaleWorkerLeaseError extends Error {
  constructor(message = "worker lease is stale, expired, released, or fenced") { super(message); this.name = "StaleWorkerLeaseError"; }
}

/** Authority loss is control flow, never an operational/provider failure. */
export function isWorkerAuthorityLoss(error: unknown, signal?: AbortSignal): boolean {
  if (error instanceof StaleWorkerLeaseError || error instanceof WorkerLeaseConflictError) return true;
  if (!signal?.aborted) return false;
  const reason = signal.reason;
  return reason instanceof StaleWorkerLeaseError || reason instanceof WorkerLeaseConflictError;
}
export class WorkerLeaseRenewalLimitError extends Error {
  constructor(limit: number) { super(`worker lease renewal limit reached (${limit})`); this.name = "WorkerLeaseRenewalLimitError"; }
}
export class WorkerLeaseIdempotencyError extends Error {
  constructor(key: string) { super(`worker lease idempotency key was reused with different data: ${key}`); this.name = "WorkerLeaseIdempotencyError"; }
}

interface LeaseRow {
  id: string;
  resource_key: string;
  owner_id: string;
  fencing_token: number;
  token_hash: string;
  ttl_ms: number;
  max_renewals: number;
  renewal_count: number;
  acquired_at_ms: number;
  heartbeat_at_ms: number;
  expires_at_ms: number;
  status: "ACTIVE" | "RELEASED" | "EXPIRED";
  released_at_ms: number | null;
  recovery_status: "NONE" | "PENDING" | "IN_PROGRESS" | "COMPLETED" | "FAILED";
  recovery_attempts: number;
  recovery_claim_token: string | null;
  recovery_claim_expires_at_ms: number | null;
  last_recovery_error: string | null;
  acquire_idempotency_key: string;
  acquire_request_hash: string;
}

interface OperationRow { operation: "HEARTBEAT" | "RELEASE"; request_hash: string; result_json: string; }

const LEASE_SQL = `
  CREATE TABLE IF NOT EXISTS worker_lease_configuration (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    max_concurrent_leases INTEGER NOT NULL CHECK(max_concurrent_leases BETWEEN 1 AND ${WORKER_LEASE_MAX_CONCURRENCY}),
    token_secret_check TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS worker_lease_fences (
    resource_key TEXT PRIMARY KEY,
    last_fencing_token INTEGER NOT NULL CHECK(last_fencing_token > 0)
  );
  CREATE TABLE IF NOT EXISTS worker_leases (
    id TEXT PRIMARY KEY,
    resource_key TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    fencing_token INTEGER NOT NULL CHECK(fencing_token > 0),
    token_hash TEXT NOT NULL,
    ttl_ms INTEGER NOT NULL CHECK(ttl_ms BETWEEN ${WORKER_LEASE_MIN_TTL_MS} AND ${WORKER_LEASE_MAX_TTL_MS}),
    max_renewals INTEGER NOT NULL CHECK(max_renewals BETWEEN 0 AND ${WORKER_LEASE_MAX_RENEWALS}),
    renewal_count INTEGER NOT NULL DEFAULT 0 CHECK(renewal_count >= 0 AND renewal_count <= max_renewals),
    acquired_at_ms INTEGER NOT NULL,
    heartbeat_at_ms INTEGER NOT NULL,
    expires_at_ms INTEGER NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('ACTIVE', 'RELEASED', 'EXPIRED')),
    released_at_ms INTEGER,
    recovery_status TEXT NOT NULL CHECK(recovery_status IN ('NONE', 'PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED')),
    recovery_attempts INTEGER NOT NULL DEFAULT 0 CHECK(recovery_attempts >= 0),
    recovery_claim_token TEXT,
    recovery_claim_expires_at_ms INTEGER,
    last_recovery_error TEXT,
    acquire_idempotency_key TEXT NOT NULL,
    acquire_request_hash TEXT NOT NULL,
    UNIQUE(resource_key, fencing_token),
    UNIQUE(owner_id, acquire_idempotency_key)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS worker_leases_one_active_resource
    ON worker_leases(resource_key) WHERE status = 'ACTIVE';
  CREATE INDEX IF NOT EXISTS worker_leases_expiry
    ON worker_leases(status, expires_at_ms);
  CREATE INDEX IF NOT EXISTS worker_leases_recovery
    ON worker_leases(recovery_status, recovery_attempts, expires_at_ms);
  CREATE TABLE IF NOT EXISTS worker_lease_operations (
    lease_id TEXT NOT NULL REFERENCES worker_leases(id) ON DELETE RESTRICT,
    idempotency_key TEXT NOT NULL,
    operation TEXT NOT NULL CHECK(operation IN ('HEARTBEAT', 'RELEASE')),
    request_hash TEXT NOT NULL,
    result_json TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    PRIMARY KEY(lease_id, idempotency_key)
  );
`;

function timestamp(ms: number): string { return new Date(ms).toISOString(); }

function parseIdentifier(value: string, label: string): string {
  const parsed = IdentifierSchema.safeParse(value);
  if (!parsed.success) throw new TypeError(`${label} must be a portable identifier of at most 200 characters`);
  return parsed.data;
}

function rowToLease(row: LeaseRow): WorkerLeaseRecord {
  return WorkerLeaseRecordSchema.parse({
    leaseId: row.id,
    resourceKey: row.resource_key,
    ownerId: row.owner_id,
    fencingToken: row.fencing_token,
    tokenHash: row.token_hash,
    ttlMs: row.ttl_ms,
    maxRenewals: row.max_renewals,
    renewalCount: row.renewal_count,
    acquiredAt: timestamp(row.acquired_at_ms),
    heartbeatAt: timestamp(row.heartbeat_at_ms),
    expiresAt: timestamp(row.expires_at_ms),
    status: row.status,
    releasedAt: row.released_at_ms === null ? null : timestamp(row.released_at_ms),
    recoveryStatus: row.recovery_status,
    recoveryAttempts: row.recovery_attempts,
    lastRecoveryError: row.last_recovery_error,
  });
}

/** Durable, fenced worker coordination. Every mutating command is transactional and idempotent. */
export class EngineerWorkerLeaseManager {
  private readonly db: Database;
  private readonly secret: Buffer;
  private readonly maxConcurrentLeases: number;
  private readonly maxRenewals: number;
  private readonly maxRecoveryAttempts: number;
  private readonly recoveryClaimTtlMs: number;
  private readonly recoveryRetryDelayMs: number;
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly recoverExpiredLease: WorkerLeaseManagerOptions["recoverExpiredLease"];
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: WorkerLeaseManagerOptions) {
    this.secret = Buffer.from(options.tokenSecret);
    if (this.secret.byteLength < 32) throw new TypeError("worker lease token secret must contain at least 32 bytes");
    if (!Number.isInteger(options.maxConcurrentLeases) || options.maxConcurrentLeases < 1 || options.maxConcurrentLeases > WORKER_LEASE_MAX_CONCURRENCY) {
      throw new TypeError(`maxConcurrentLeases must be between 1 and ${WORKER_LEASE_MAX_CONCURRENCY}`);
    }
    this.maxConcurrentLeases = options.maxConcurrentLeases;
    this.maxRenewals = options.maxRenewals ?? WORKER_LEASE_MAX_RENEWALS;
    if (!Number.isInteger(this.maxRenewals) || this.maxRenewals < 0 || this.maxRenewals > WORKER_LEASE_MAX_RENEWALS) {
      throw new TypeError(`maxRenewals must be between 0 and ${WORKER_LEASE_MAX_RENEWALS}`);
    }
    this.maxRecoveryAttempts = options.maxRecoveryAttempts ?? 3;
    if (!Number.isInteger(this.maxRecoveryAttempts) || this.maxRecoveryAttempts < 1 || this.maxRecoveryAttempts > 20) {
      throw new TypeError("maxRecoveryAttempts must be between 1 and 20");
    }
    this.recoveryClaimTtlMs = options.recoveryClaimTtlMs ?? 30_000;
    if (!Number.isInteger(this.recoveryClaimTtlMs) || this.recoveryClaimTtlMs < 1_000 || this.recoveryClaimTtlMs > 5 * 60_000) {
      throw new TypeError("recoveryClaimTtlMs must be between 1000 and 300000");
    }
    this.recoveryRetryDelayMs = options.recoveryRetryDelayMs ?? 1_000;
    if (!Number.isInteger(this.recoveryRetryDelayMs) || this.recoveryRetryDelayMs < 1_000 || this.recoveryRetryDelayMs > 5 * 60_000) {
      throw new TypeError("recoveryRetryDelayMs must be between 1000 and 300000");
    }
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.recoverExpiredLease = options.recoverExpiredLease;
    if (options.dbPath !== ":memory:") mkdirSync(dirname(options.dbPath), { recursive: true, mode: 0o700 });
    this.db = new Database(options.dbPath, { create: true });
    if (options.dbPath !== ":memory:") {
      try { chmodSync(options.dbPath, 0o600); } catch { /* SQLite operations remain fail-closed. */ }
    }
    this.db.exec("PRAGMA foreign_keys=ON");
    this.db.exec("PRAGMA busy_timeout=5000");
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec(LEASE_SQL);
    try {
      this.configure();
    } catch (error) {
      this.db.close();
      throw error;
    }
    if (options.watchdogIntervalMs !== undefined) this.startWatchdog(options.watchdogIntervalMs);
  }

  acquire(raw: AcquireWorkerLeaseInput): WorkerLeaseGrant {
    const input = {
      resourceKey: parseIdentifier(raw.resourceKey, "resourceKey"),
      ownerId: parseIdentifier(raw.ownerId, "ownerId"),
      ttlMs: raw.ttlMs,
      idempotencyKey: parseIdentifier(raw.idempotencyKey, "idempotencyKey"),
    };
    if (!Number.isInteger(input.ttlMs) || input.ttlMs < WORKER_LEASE_MIN_TTL_MS || input.ttlMs > WORKER_LEASE_MAX_TTL_MS) {
      throw new TypeError(`ttlMs must be between ${WORKER_LEASE_MIN_TTL_MS} and ${WORKER_LEASE_MAX_TTL_MS}`);
    }
    const requestHash = sha256(input);
    return this.immediate(() => {
      const now = this.nowMs();
      this.expireDue(now);
      const replay = this.db.query("SELECT * FROM worker_leases WHERE owner_id = ? AND acquire_idempotency_key = ?")
        .get(input.ownerId, input.idempotencyKey) as LeaseRow | null;
      if (replay) {
        if (replay.acquire_request_hash !== requestHash) throw new WorkerLeaseIdempotencyError(input.idempotencyKey);
        return this.grant(replay);
      }
      const occupied = this.db.query("SELECT id FROM worker_leases WHERE resource_key = ? AND status = 'ACTIVE'").get(input.resourceKey);
      if (occupied) throw new WorkerLeaseConflictError(`resource already has an active worker lease: ${input.resourceKey}`);
      const active = Number((this.db.query("SELECT COUNT(*) AS count FROM worker_leases WHERE status = 'ACTIVE'").get() as { count: number }).count);
      if (active >= this.maxConcurrentLeases) throw new WorkerLeaseCapacityError(this.maxConcurrentLeases);
      const fenceRow = this.db.query("SELECT last_fencing_token FROM worker_lease_fences WHERE resource_key = ?")
        .get(input.resourceKey) as { last_fencing_token: number } | null;
      const fencingToken = (fenceRow?.last_fencing_token ?? 0) + 1;
      if (!Number.isSafeInteger(fencingToken)) throw new Error("worker lease fencing token exhausted");
      if (fenceRow) this.db.query("UPDATE worker_lease_fences SET last_fencing_token = ? WHERE resource_key = ?").run(fencingToken, input.resourceKey);
      else this.db.query("INSERT INTO worker_lease_fences(resource_key, last_fencing_token) VALUES (?, ?)").run(input.resourceKey, fencingToken);
      const leaseId = parseIdentifier(this.idFactory(), "leaseId");
      const token = this.deriveToken({ leaseId, resourceKey: input.resourceKey, ownerId: input.ownerId, fencingToken });
      const tokenHash = sha256(token);
      this.db.query(`INSERT INTO worker_leases
        (id, resource_key, owner_id, fencing_token, token_hash, ttl_ms, max_renewals, renewal_count,
         acquired_at_ms, heartbeat_at_ms, expires_at_ms, status, released_at_ms, recovery_status,
         recovery_attempts, recovery_claim_token, recovery_claim_expires_at_ms, last_recovery_error,
         acquire_idempotency_key, acquire_request_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 'ACTIVE', NULL, 'NONE', 0, NULL, NULL, NULL, ?, ?)`)
        .run(leaseId, input.resourceKey, input.ownerId, fencingToken, tokenHash, input.ttlMs, this.maxRenewals,
          now, now, now + input.ttlMs, input.idempotencyKey, requestHash);
      return this.grant(this.requireRow(leaseId));
    });
  }

  heartbeat(command: WorkerLeaseCommand): WorkerLeaseRecord {
    return this.command("HEARTBEAT", command, (row, now) => {
      if (row.renewal_count >= row.max_renewals) throw new WorkerLeaseRenewalLimitError(row.max_renewals);
      this.db.query(`UPDATE worker_leases SET renewal_count = renewal_count + 1,
        heartbeat_at_ms = ?, expires_at_ms = ? WHERE id = ? AND status = 'ACTIVE' AND fencing_token = ?`)
        .run(now, now + row.ttl_ms, row.id, row.fencing_token);
      return this.requireRow(row.id);
    });
  }

  release(command: WorkerLeaseCommand): WorkerLeaseRecord {
    return this.command("RELEASE", command, (row, now) => {
      this.db.query(`UPDATE worker_leases SET status = 'RELEASED', released_at_ms = ?,
        recovery_status = 'NONE', recovery_claim_token = NULL, recovery_claim_expires_at_ms = NULL
        WHERE id = ? AND status = 'ACTIVE' AND fencing_token = ?`).run(now, row.id, row.fencing_token);
      return this.requireRow(row.id);
    });
  }

  assertActive(input: Omit<WorkerLeaseCommand, "idempotencyKey">): WorkerLeaseRecord {
    return this.immediate(() => {
      const now = this.nowMs();
      this.expireDue(now);
      const row = this.requireRow(parseIdentifier(input.leaseId, "leaseId"));
      this.authenticate(row, input);
      if (row.status !== "ACTIVE") throw new StaleWorkerLeaseError();
      return rowToLease(row);
    });
  }

  /**
   * Executes one strictly synchronous local recovery while an authenticated
   * run lease is protected by BEGIN IMMEDIATE on the worker-lease database.
   *
   * Global recovery lock order is always worker-leases.db -> engineer.db. The
   * callback may enter the Engineer ledger once, but must never call back into
   * this WorkerLeaseManager or return a Promise/thenable. Holding the outer
   * lock prevents expiry, release, or replacement from committing in the
   * separate production lease database until the Engineer transaction commits.
   */
  withActiveLease<T>(
    raw: Omit<WorkerLeaseCommand, "idempotencyKey">,
    operation: (lease: WorkerLeaseRecord) => T,
  ): T {
    const input = {
      leaseId: parseIdentifier(raw.leaseId, "leaseId"),
      ownerId: parseIdentifier(raw.ownerId, "ownerId"),
      fencingToken: raw.fencingToken,
      leaseToken: raw.leaseToken,
    };
    if (!Number.isSafeInteger(input.fencingToken) || input.fencingToken < 1 ||
        typeof input.leaseToken !== "string" || input.leaseToken.length < 1 || input.leaseToken.length > 512) {
      throw new TypeError("worker lease proof is invalid");
    }
    if (typeof operation !== "function") throw new TypeError("worker lease operation must be a function");
    this.db.exec("BEGIN IMMEDIATE");
    let transactionOpen = true;
    try {
      const now = this.nowMs();
      this.expireDue(now);
      let row: LeaseRow;
      try {
        row = this.requireRow(input.leaseId);
        this.authenticate(row, input);
        if (row.status !== "ACTIVE") throw new StaleWorkerLeaseError();
      } catch (error) {
        // Expiry is durable authority loss. Commit the expiry mutation before
        // surfacing the stale proof; rolling it back would resurrect a lease.
        this.db.exec("COMMIT");
        transactionOpen = false;
        throw error;
      }
      const result = operation(rowToLease(row));
      if ((typeof result === "object" || typeof result === "function") && result !== null &&
          typeof (result as { then?: unknown }).then === "function") {
        throw new TypeError("worker lease operation must be strictly synchronous");
      }
      this.db.exec("COMMIT");
      transactionOpen = false;
      return result;
    } catch (error) {
      if (transactionOpen) {
        try { this.db.exec("ROLLBACK"); } catch { /* Preserve the original error. */ }
      }
      throw error;
    }
  }

  get(leaseId: string): WorkerLeaseRecord {
    return this.immediate(() => {
      this.expireDue(this.nowMs());
      return rowToLease(this.requireRow(parseIdentifier(leaseId, "leaseId")));
    });
  }

  listActive(): WorkerLeaseRecord[] {
    return this.immediate(() => {
      this.expireDue(this.nowMs());
      return (this.db.query("SELECT * FROM worker_leases WHERE status = 'ACTIVE' ORDER BY acquired_at_ms, id").all() as LeaseRow[]).map(rowToLease);
    });
  }

  async watchdogSweep(limit = WORKER_LEASE_MAX_WATCHDOG_BATCH): Promise<WorkerWatchdogResult> {
    if (!Number.isInteger(limit) || limit < 1 || limit > WORKER_LEASE_MAX_WATCHDOG_BATCH) {
      throw new TypeError(`watchdog limit must be between 1 and ${WORKER_LEASE_MAX_WATCHDOG_BATCH}`);
    }
    const now = this.nowMs();
    const expiredLeaseIds = this.immediate(() => this.expireDue(now));
    const claimed = this.immediate(() => {
      this.db.query(`UPDATE worker_leases SET recovery_status = CASE
          WHEN recovery_attempts >= ? THEN 'FAILED' ELSE 'PENDING' END,
          recovery_claim_token = NULL, recovery_claim_expires_at_ms = NULL,
          last_recovery_error = COALESCE(last_recovery_error, 'watchdog recovery claim expired')
        WHERE recovery_status = 'IN_PROGRESS' AND recovery_claim_expires_at_ms <= ?`).run(this.maxRecoveryAttempts, now);
      const rows = this.db.query(`SELECT * FROM worker_leases
        WHERE status = 'EXPIRED' AND recovery_status = 'PENDING' AND recovery_attempts < ?
          AND (recovery_claim_expires_at_ms IS NULL OR recovery_claim_expires_at_ms <= ?)
        ORDER BY expires_at_ms, id LIMIT ?`).all(this.maxRecoveryAttempts, now, limit) as LeaseRow[];
      return rows.map((row) => {
        const claimToken = randomBytes(24).toString("base64url");
        const changed = this.db.query(`UPDATE worker_leases SET recovery_status = 'IN_PROGRESS',
          recovery_attempts = recovery_attempts + 1, recovery_claim_token = ?, recovery_claim_expires_at_ms = ?
          WHERE id = ? AND recovery_status = 'PENDING'`).run(claimToken, now + this.recoveryClaimTtlMs, row.id);
        if (changed.changes !== 1) return null;
        return { lease: rowToLease(this.requireRow(row.id)), claimToken };
      }).filter((item): item is { lease: WorkerLeaseRecord; claimToken: string } => item !== null);
    });
    const recoveredLeaseIds: string[] = [];
    const failedLeaseIds: string[] = [];
    for (const item of claimed) {
      try {
        await this.recoverExpiredLease(item.lease);
        const completed = this.immediate(() => this.db.query(`UPDATE worker_leases SET recovery_status = 'COMPLETED',
          recovery_claim_token = NULL, recovery_claim_expires_at_ms = NULL, last_recovery_error = NULL
          WHERE id = ? AND recovery_status = 'IN_PROGRESS' AND recovery_claim_token = ?`).run(item.lease.leaseId, item.claimToken));
        if (completed.changes !== 1) throw new StaleWorkerLeaseError("watchdog recovery claim was fenced");
        recoveredLeaseIds.push(item.lease.leaseId);
      } catch (error) {
        const message = (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
        const failed = this.immediate(() => {
          const current = this.requireRow(item.lease.leaseId);
          const terminal = current.recovery_attempts >= this.maxRecoveryAttempts;
          this.db.query(`UPDATE worker_leases SET recovery_status = ?, recovery_claim_token = NULL,
            recovery_claim_expires_at_ms = ?, last_recovery_error = ?
            WHERE id = ? AND recovery_status = 'IN_PROGRESS' AND recovery_claim_token = ?`)
            .run(terminal ? "FAILED" : "PENDING", terminal ? null : this.nowMs() + this.recoveryRetryDelayMs,
              message, item.lease.leaseId, item.claimToken);
          return terminal;
        });
        if (failed) failedLeaseIds.push(item.lease.leaseId);
      }
    }
    return { expiredLeaseIds, recoveredLeaseIds, failedLeaseIds };
  }

  startWatchdog(intervalMs: number): void {
    if (!Number.isInteger(intervalMs) || intervalMs < 1_000 || intervalMs > 5 * 60_000) {
      throw new TypeError("watchdog interval must be between 1000 and 300000 milliseconds");
    }
    if (this.watchdogTimer) throw new Error("worker lease watchdog is already running");
    this.watchdogTimer = setInterval(() => { void this.watchdogSweep().catch(() => undefined); }, intervalMs);
    this.watchdogTimer.unref?.();
  }

  stopWatchdog(): void {
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.watchdogTimer = null;
  }

  close(): void {
    this.stopWatchdog();
    this.db.close();
  }

  private configure(): void {
    const secretCheck = createHmac("sha256", this.secret).update("zintus-engineer-worker-lease-secret-v1").digest("hex");
    const existing = this.db.query("SELECT max_concurrent_leases, token_secret_check FROM worker_lease_configuration WHERE singleton = 1")
      .get() as { max_concurrent_leases: number; token_secret_check: string } | null;
    if (!existing) {
      this.db.query("INSERT INTO worker_lease_configuration(singleton, max_concurrent_leases, token_secret_check) VALUES (1, ?, ?)")
        .run(this.maxConcurrentLeases, secretCheck);
      return;
    }
    if (existing.max_concurrent_leases !== this.maxConcurrentLeases) throw new Error("worker lease concurrency configuration disagrees with the durable store");
    if (!this.safeEqual(existing.token_secret_check, secretCheck)) throw new Error("worker lease token secret disagrees with the durable store");
  }

  private command(operation: "HEARTBEAT" | "RELEASE", raw: WorkerLeaseCommand, apply: (row: LeaseRow, now: number) => LeaseRow): WorkerLeaseRecord {
    const command = {
      leaseId: parseIdentifier(raw.leaseId, "leaseId"), ownerId: parseIdentifier(raw.ownerId, "ownerId"),
      fencingToken: raw.fencingToken, leaseToken: raw.leaseToken,
      idempotencyKey: parseIdentifier(raw.idempotencyKey, "idempotencyKey"),
    };
    if (!Number.isSafeInteger(command.fencingToken) || command.fencingToken < 1) throw new TypeError("fencingToken must be a positive safe integer");
    const requestHash = sha256({ operation, ...command });
    return this.immediate(() => {
      const now = this.nowMs();
      this.expireDue(now);
      const row = this.requireRow(command.leaseId);
      this.authenticate(row, command);
      const replay = this.db.query("SELECT operation, request_hash, result_json FROM worker_lease_operations WHERE lease_id = ? AND idempotency_key = ?")
        .get(command.leaseId, command.idempotencyKey) as OperationRow | null;
      if (replay) {
        if (replay.operation !== operation || replay.request_hash !== requestHash) throw new WorkerLeaseIdempotencyError(command.idempotencyKey);
        if (operation === "HEARTBEAT" && row.status !== "ACTIVE") throw new StaleWorkerLeaseError();
        return WorkerLeaseRecordSchema.parse(JSON.parse(replay.result_json));
      }
      if (row.status !== "ACTIVE") throw new StaleWorkerLeaseError();
      const updated = rowToLease(apply(row, now));
      this.db.query(`INSERT INTO worker_lease_operations
        (lease_id, idempotency_key, operation, request_hash, result_json, created_at_ms)
        VALUES (?, ?, ?, ?, ?, ?)`).run(command.leaseId, command.idempotencyKey, operation, requestHash, canonicalJson(updated), now);
      return updated;
    });
  }

  private authenticate(row: LeaseRow, input: { ownerId: string; fencingToken: number; leaseToken: string }): void {
    if (row.owner_id !== input.ownerId || row.fencing_token !== input.fencingToken || !this.safeEqual(row.token_hash, sha256(input.leaseToken))) {
      throw new StaleWorkerLeaseError("worker lease owner, token, or fencing token is stale");
    }
  }

  private deriveToken(input: { leaseId: string; resourceKey: string; ownerId: string; fencingToken: number }): string {
    return createHmac("sha256", this.secret).update(canonicalJson(input)).digest("base64url");
  }

  private grant(row: LeaseRow): WorkerLeaseGrant {
    const lease = rowToLease(row);
    return WorkerLeaseGrantSchema.parse({
      lease,
      leaseToken: this.deriveToken({ leaseId: lease.leaseId, resourceKey: lease.resourceKey, ownerId: lease.ownerId, fencingToken: lease.fencingToken }),
    });
  }

  private expireDue(now: number): string[] {
    const due = this.db.query("SELECT id FROM worker_leases WHERE status = 'ACTIVE' AND expires_at_ms <= ? ORDER BY expires_at_ms, id")
      .all(now) as Array<{ id: string }>;
    if (due.length > 0) {
      this.db.query(`UPDATE worker_leases SET status = 'EXPIRED', recovery_status = 'PENDING',
        recovery_claim_token = NULL, recovery_claim_expires_at_ms = NULL
        WHERE status = 'ACTIVE' AND expires_at_ms <= ?`).run(now);
    }
    return due.map((row) => row.id);
  }

  private requireRow(leaseId: string): LeaseRow {
    const row = this.db.query("SELECT * FROM worker_leases WHERE id = ?").get(leaseId) as LeaseRow | null;
    if (!row) throw new StaleWorkerLeaseError(`worker lease not found: ${leaseId}`);
    return row;
  }

  private nowMs(): number {
    const value = this.now().getTime();
    if (!Number.isSafeInteger(value)) throw new Error("worker lease clock returned an invalid timestamp");
    return value;
  }

  private safeEqual(left: string, right: string): boolean {
    const a = Buffer.from(left);
    const b = Buffer.from(right);
    return a.byteLength === b.byteLength && timingSafeEqual(a, b);
  }

  private immediate<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* Preserve the original error. */ }
      throw error;
    }
  }
}
