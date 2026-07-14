import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import {
  EngineerRunSchema,
  RunStateEventSchema,
  TaskManifestSchema,
  type ActorType,
  type EngineerRun,
  type RepositoryReference,
  type RetryKind,
  type RiskAssessment,
  type RunState,
  type RunStateEvent,
  type TaskManifest,
} from "./contracts.js";
import {
  ENGINEER_DATABASE_SCHEMA_SQL,
  ENGINEER_DATABASE_SCHEMA_VERSION,
} from "./database-schema.js";
import {
  EngineerNotFoundError,
  IdempotencyConflictError,
  StateVersionConflictError,
} from "./errors.js";
import { canonicalJson } from "./hash.js";

interface RunRow {
  id: string;
  user_id: string;
  repository_id: string;
  provider: "github" | "local";
  owner: string;
  repository_name: string;
  repository_url: string | null;
  base_branch: string;
  base_commit_sha: string;
  request_original: string;
  request_normalized: string;
  state: RunState;
  state_version: number;
  manifest_hash: string | null;
  risk_tier: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  human_gate_required: number;
  created_at: string;
  updated_at: string;
  terminal_at: string | null;
}

interface EventRow {
  event_id: string;
  run_id: string;
  sequence: number;
  previous_state: RunState;
  next_state: RunState;
  reason_code: string;
  actor_type: ActorType;
  actor_id: string;
  timestamp: string;
  evidence_ids_json: string;
  manifest_hash: string | null;
  state_version: number;
  idempotency_key: string;
}

export interface LedgerCreateRunInput {
  runId: string;
  userId: string;
  userEmail?: string;
  repository: RepositoryReference;
  requestOriginal: string;
  riskTier: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  humanGateRequired: boolean;
  now: string;
}

export interface LedgerTransitionCommand {
  runId: string;
  expectedStateVersion: number;
  previousState: RunState;
  nextState: RunState;
  reasonCode: string;
  actorType: ActorType;
  actorId: string;
  evidenceIds: string[];
  manifestHash: string | null;
  idempotencyKey: string;
  eventId: string;
  timestamp: string;
  terminalAt: string | null;
  normalizedRequest?: string;
}

export interface LedgerTransitionResult {
  applied: boolean;
  event: RunStateEvent;
  run: EngineerRun;
}

export interface StoredRetryAttempt {
  kind: RetryKind;
  failureFingerprint: string;
  patchHash: string | null;
  progressMetric: number | null;
  allowed: boolean;
}

const RUN_SELECT = `
  SELECT r.*, rc.provider, rc.owner, rc.name AS repository_name, rc.url AS repository_url
  FROM engineer_runs r
  JOIN repository_connections rc ON rc.id = r.repository_id
`;

function rowToRun(row: RunRow): EngineerRun {
  return EngineerRunSchema.parse({
    runId: row.id,
    userId: row.user_id,
    repository: {
      repositoryId: row.repository_id,
      provider: row.provider,
      owner: row.owner,
      name: row.repository_name,
      ...(row.repository_url ? { url: row.repository_url } : {}),
      baseBranch: row.base_branch,
      baseCommitSha: row.base_commit_sha,
    },
    requestOriginal: row.request_original,
    requestNormalized: row.request_normalized,
    state: row.state,
    stateVersion: row.state_version,
    manifestHash: row.manifest_hash,
    riskTier: row.risk_tier,
    humanGateRequired: row.human_gate_required === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    terminalAt: row.terminal_at,
  });
}

function rowToEvent(row: EventRow): RunStateEvent {
  return RunStateEventSchema.parse({
    eventId: row.event_id,
    runId: row.run_id,
    sequence: row.sequence,
    previousState: row.previous_state,
    nextState: row.next_state,
    reasonCode: row.reason_code,
    actorType: row.actor_type,
    actorId: row.actor_id,
    timestamp: row.timestamp,
    evidenceIds: JSON.parse(row.evidence_ids_json) as unknown,
    manifestHash: row.manifest_hash,
    stateVersion: row.state_version,
    idempotencyKey: row.idempotency_key,
  });
}

/** Internal durable ledger. It is deliberately not exported from package index.ts. */
export class EngineerLedger {
  private readonly db: Database;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath, { create: true });
    if (dbPath !== ":memory:") {
      try {
        chmodSync(dbPath, 0o600);
      } catch {
        // Best effort for an existing file; database operations still fail closed.
      }
    }
    this.db.exec("PRAGMA foreign_keys=ON");
    this.db.exec("PRAGMA busy_timeout=5000");
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec(ENGINEER_DATABASE_SCHEMA_SQL);
    this.db
      .query("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)")
      .run(ENGINEER_DATABASE_SCHEMA_VERSION, new Date().toISOString());
  }

  createRun(input: LedgerCreateRunInput): EngineerRun {
    const transact = this.db.transaction(() => {
      this.db
        .query(`INSERT INTO users(id, email, created_at, updated_at) VALUES (?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET email = COALESCE(users.email, excluded.email), updated_at = excluded.updated_at`)
        .run(input.userId, input.userEmail ?? null, input.now, input.now);
      this.db
        .query(`INSERT OR IGNORE INTO repository_connections
                (id, user_id, provider, owner, name, url, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          input.repository.repositoryId,
          input.userId,
          input.repository.provider,
          input.repository.owner,
          input.repository.name,
          input.repository.url ?? null,
          input.now,
          input.now,
        );
      const repositoryOwner = this.db
        .query("SELECT user_id FROM repository_connections WHERE id = ?")
        .get(input.repository.repositoryId) as { user_id: string } | null;
      if (!repositoryOwner || repositoryOwner.user_id !== input.userId) {
        throw new Error("repository connection is not owned by the run user");
      }
      this.db
        .query(`INSERT INTO engineer_runs
                (id, user_id, repository_id, base_branch, base_commit_sha,
                 request_original, request_normalized, state, state_version,
                 risk_tier, human_gate_required, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, '', 'REQUEST_RECEIVED', 0, ?, ?, ?, ?)`)
        .run(
          input.runId,
          input.userId,
          input.repository.repositoryId,
          input.repository.baseBranch,
          input.repository.baseCommitSha,
          input.requestOriginal,
          input.riskTier,
          input.humanGateRequired ? 1 : 0,
          input.now,
          input.now,
        );
      this.insertAudit(input.runId, "RUN_CREATED", "USER", input.userId, {
        repositoryId: input.repository.repositoryId,
        baseCommitSha: input.repository.baseCommitSha,
      }, input.now);
    });
    transact();
    return this.getRun(input.runId);
  }

  getRun(runId: string): EngineerRun {
    const row = this.db.query(`${RUN_SELECT} WHERE r.id = ?`).get(runId) as RunRow | null;
    if (!row) throw new EngineerNotFoundError("run", runId);
    return rowToRun(row);
  }

  listEvents(runId: string): RunStateEvent[] {
    this.getRun(runId);
    const rows = this.db
      .query("SELECT * FROM run_state_events WHERE run_id = ? ORDER BY sequence")
      .all(runId) as EventRow[];
    return rows.map(rowToEvent);
  }

  replayTransition(input: {
    runId: string;
    idempotencyKey: string;
    nextState: RunState;
    reasonCode: string;
    actorType: ActorType;
    actorId: string;
    evidenceIds: string[];
    manifestHash: string | null;
  }): LedgerTransitionResult | null {
    const row = this.db.query("SELECT * FROM run_state_events WHERE run_id = ? AND idempotency_key = ?")
      .get(input.runId, input.idempotencyKey) as EventRow | null;
    if (!row) return null;
    const event = rowToEvent(row);
    const same =
      event.nextState === input.nextState &&
      event.reasonCode === input.reasonCode &&
      event.actorType === input.actorType &&
      event.actorId === input.actorId &&
      event.manifestHash === input.manifestHash &&
      canonicalJson(event.evidenceIds) === canonicalJson(input.evidenceIds);
    if (!same) throw new IdempotencyConflictError(input.runId, input.idempotencyKey);
    return { applied: false, event, run: this.getRun(input.runId) };
  }

  getManifest(runId: string, version?: number): TaskManifest | null {
    const row = version === undefined
      ? this.db.query("SELECT manifest_json FROM task_manifest_versions WHERE run_id = ? ORDER BY version DESC LIMIT 1").get(runId)
      : this.db.query("SELECT manifest_json FROM task_manifest_versions WHERE run_id = ? AND version = ?").get(runId, version);
    if (!row) return null;
    return TaskManifestSchema.parse(JSON.parse((row as { manifest_json: string }).manifest_json));
  }

  listManifestVersions(runId: string): TaskManifest[] {
    this.getRun(runId);
    const rows = this.db
      .query("SELECT manifest_json FROM task_manifest_versions WHERE run_id = ? ORDER BY version")
      .all(runId) as Array<{ manifest_json: string }>;
    return rows.map((row) => TaskManifestSchema.parse(JSON.parse(row.manifest_json)));
  }

  appendTransition(command: LedgerTransitionCommand): LedgerTransitionResult {
    const transact = this.db.transaction(() => {
      const replay = this.findIdempotentEvent(command);
      if (replay) return { applied: false, event: replay, run: this.getRun(command.runId) };
      const run = this.getRun(command.runId);
      this.assertExpectedRun(run, command);
      const nextVersion = run.stateVersion + 1;
      const event = this.insertStateEvent(command, nextVersion);
      const result = command.normalizedRequest === undefined
        ? this.db.query(`UPDATE engineer_runs
                         SET state = ?, state_version = ?, updated_at = ?, terminal_at = ?
                         WHERE id = ? AND state_version = ? AND state = ?`)
            .run(command.nextState, nextVersion, command.timestamp, command.terminalAt,
              command.runId, command.expectedStateVersion, command.previousState)
        : this.db.query(`UPDATE engineer_runs
                         SET state = ?, state_version = ?, updated_at = ?, terminal_at = ?, request_normalized = ?
                         WHERE id = ? AND state_version = ? AND state = ?`)
            .run(command.nextState, nextVersion, command.timestamp, command.terminalAt,
              command.normalizedRequest, command.runId, command.expectedStateVersion, command.previousState);
      if (Number(result.changes) !== 1) {
        throw new StateVersionConflictError(command.runId, command.expectedStateVersion, this.getRun(command.runId).stateVersion);
      }
      this.insertAudit(command.runId, "STATE_TRANSITION", command.actorType, command.actorId, {
        eventId: event.eventId,
        previousState: event.previousState,
        nextState: event.nextState,
        reasonCode: event.reasonCode,
        evidenceIds: event.evidenceIds,
      }, command.timestamp);
      return { applied: true, event, run: this.getRun(command.runId) };
    });
    return transact();
  }

  freezeManifest(command: LedgerTransitionCommand, manifest: TaskManifest): LedgerTransitionResult {
    const transact = this.db.transaction(() => {
      const replay = this.findIdempotentEvent(command);
      if (replay) return { applied: false, event: replay, run: this.getRun(command.runId) };
      const run = this.getRun(command.runId);
      this.assertExpectedRun(run, command);
      this.db
        .query(`INSERT INTO task_manifest_versions
                (id, run_id, version, manifest_hash, manifest_json, created_at)
                VALUES (?, ?, ?, ?, ?, ?)`)
        .run(randomUUID(), manifest.runId, manifest.manifestVersion, manifest.manifestHash,
          canonicalJson(manifest), manifest.createdAt);
      const criterionStatement = this.db.query(`INSERT INTO acceptance_criteria
        (id, run_id, manifest_hash, criterion_id, statement, verification_method, priority, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const criterion of manifest.acceptanceCriteria) {
        criterionStatement.run(
          randomUUID(),
          manifest.runId,
          manifest.manifestHash,
          criterion.criterionId,
          criterion.statement,
          criterion.verificationMethod,
          criterion.priority,
          manifest.createdAt,
        );
      }
      const nextVersion = run.stateVersion + 1;
      const event = this.insertStateEvent(command, nextVersion);
      const result = this.db.query(`UPDATE engineer_runs
        SET state = ?, state_version = ?, manifest_hash = ?, risk_tier = ?,
            human_gate_required = ?, updated_at = ?
        WHERE id = ? AND state_version = ? AND state = ?`)
        .run(
          command.nextState,
          nextVersion,
          manifest.manifestHash,
          manifest.riskTier,
          manifest.humanGateRequired ? 1 : 0,
          command.timestamp,
          command.runId,
          command.expectedStateVersion,
          command.previousState,
        );
      if (Number(result.changes) !== 1) {
        throw new StateVersionConflictError(command.runId, command.expectedStateVersion, this.getRun(command.runId).stateVersion);
      }
      this.insertAudit(command.runId, "MANIFEST_FROZEN", command.actorType, command.actorId, {
        manifestVersion: manifest.manifestVersion,
        manifestHash: manifest.manifestHash,
        eventId: event.eventId,
      }, command.timestamp);
      return { applied: true, event, run: this.getRun(command.runId) };
    });
    return transact();
  }

  recordRisk(assessment: RiskAssessment, expectedStateVersion: number): void {
    const transact = this.db.transaction(() => {
      const run = this.getRun(assessment.runId);
      if (run.stateVersion !== expectedStateVersion) {
        throw new StateVersionConflictError(assessment.runId, expectedStateVersion, run.stateVersion);
      }
      this.db.query(`INSERT INTO risk_assessments
        (id, run_id, risk_tier, human_gate_required, rule_version,
         matched_rules_json, features_json, assessed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          assessment.assessmentId,
          assessment.runId,
          assessment.riskTier,
          assessment.humanGateRequired ? 1 : 0,
          assessment.ruleVersion,
          canonicalJson(assessment.matchedRules),
          canonicalJson(assessment.features),
          assessment.assessedAt,
        );
      this.db.query("UPDATE engineer_runs SET risk_tier = ?, human_gate_required = ?, updated_at = ? WHERE id = ? AND state_version = ?")
        .run(assessment.riskTier, assessment.humanGateRequired ? 1 : 0,
          assessment.assessedAt, assessment.runId, expectedStateVersion);
      this.insertAudit(assessment.runId, "RISK_ASSESSED", "SUPERVISOR", "risk-engine", {
        assessmentId: assessment.assessmentId,
        riskTier: assessment.riskTier,
        matchedRules: assessment.matchedRules,
      }, assessment.assessedAt);
    });
    transact();
  }

  listRetryHistory(runId: string): StoredRetryAttempt[] {
    this.getRun(runId);
    const rows = this.db.query(`SELECT kind, failure_fingerprint, patch_hash,
      progress_metric, allowed FROM retry_attempts WHERE run_id = ? ORDER BY created_at, rowid`)
      .all(runId) as Array<{
        kind: RetryKind;
        failure_fingerprint: string;
        patch_hash: string | null;
        progress_metric: number | null;
        allowed: number;
      }>;
    return rows.map((row) => ({
      kind: row.kind,
      failureFingerprint: row.failure_fingerprint,
      patchHash: row.patch_hash,
      progressMetric: row.progress_metric,
      allowed: row.allowed === 1,
    }));
  }

  recordRetry(input: {
    id: string;
    runId: string;
    kind: RetryKind;
    attemptNumber: number;
    failureFingerprint: string;
    patchHash?: string | null;
    progressMetric?: number | null;
    allowed: boolean;
    reasonCode: string;
    policyVersion: string;
    createdAt: string;
  }): void {
    this.getRun(input.runId);
    this.db.query(`INSERT INTO retry_attempts
      (id, run_id, kind, attempt_number, failure_fingerprint, patch_hash,
       progress_metric, allowed, reason_code, policy_version, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(input.id, input.runId, input.kind, input.attemptNumber,
        input.failureFingerprint, input.patchHash ?? null, input.progressMetric ?? null,
        input.allowed ? 1 : 0, input.reasonCode, input.policyVersion, input.createdAt);
  }

  close(): void {
    this.db.close();
  }

  private assertExpectedRun(run: EngineerRun, command: LedgerTransitionCommand): void {
    if (run.stateVersion !== command.expectedStateVersion) {
      throw new StateVersionConflictError(command.runId, command.expectedStateVersion, run.stateVersion);
    }
    if (run.state !== command.previousState) {
      throw new StateVersionConflictError(command.runId, command.expectedStateVersion, run.stateVersion);
    }
  }

  private findIdempotentEvent(command: LedgerTransitionCommand): RunStateEvent | null {
    const row = this.db.query("SELECT * FROM run_state_events WHERE run_id = ? AND idempotency_key = ?")
      .get(command.runId, command.idempotencyKey) as EventRow | null;
    if (!row) return null;
    const event = rowToEvent(row);
    const same =
      event.previousState === command.previousState &&
      event.nextState === command.nextState &&
      event.reasonCode === command.reasonCode &&
      event.actorType === command.actorType &&
      event.actorId === command.actorId &&
      event.manifestHash === command.manifestHash &&
      canonicalJson(event.evidenceIds) === canonicalJson(command.evidenceIds);
    if (!same) throw new IdempotencyConflictError(command.runId, command.idempotencyKey);
    return event;
  }

  private insertStateEvent(command: LedgerTransitionCommand, stateVersion: number): RunStateEvent {
    const event = RunStateEventSchema.parse({
      eventId: command.eventId,
      runId: command.runId,
      sequence: stateVersion,
      previousState: command.previousState,
      nextState: command.nextState,
      reasonCode: command.reasonCode,
      actorType: command.actorType,
      actorId: command.actorId,
      timestamp: command.timestamp,
      evidenceIds: command.evidenceIds,
      manifestHash: command.manifestHash,
      stateVersion,
      idempotencyKey: command.idempotencyKey,
    });
    this.db.query(`INSERT INTO run_state_events
      (event_id, run_id, sequence, previous_state, next_state, reason_code,
       actor_type, actor_id, timestamp, evidence_ids_json, manifest_hash,
       state_version, idempotency_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        event.eventId,
        event.runId,
        event.sequence,
        event.previousState,
        event.nextState,
        event.reasonCode,
        event.actorType,
        event.actorId,
        event.timestamp,
        canonicalJson(event.evidenceIds),
        event.manifestHash,
        event.stateVersion,
        event.idempotencyKey,
      );
    return event;
  }

  private insertAudit(
    runId: string | null,
    action: string,
    actorType: ActorType,
    actorId: string,
    details: unknown,
    createdAt: string,
  ): void {
    this.db.query(`INSERT INTO audit_events
      (id, run_id, action, actor_type, actor_id, details_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), runId, action, actorType, actorId, canonicalJson(details), createdAt);
  }
}
