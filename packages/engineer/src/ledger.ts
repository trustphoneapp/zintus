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
  ArtifactRecordSchema,
  AgentExecutionRecordSchema,
  CommandExecutionRecordSchema,
  ModelCallRecordSchema,
  SandboxRecordSchema,
  type ArtifactRecord,
  type AgentExecutionRecord,
  type CommandExecutionRecord,
  type ModelCallRecord,
  type SandboxRecord,
} from "./execution-contracts.js";
import {
  ClaimEvidenceRecordSchema,
  EvidenceBundleRecordSchema,
  ReviewFindingRecordSchema,
  ReviewerSessionRecordSchema,
  SecurityFindingRecordSchema,
  VerificationExecutionRecordSchema,
  type ClaimEvidenceRecord,
  type EvidenceBundleRecord,
  type ReviewFindingRecord,
  type ReviewerSessionRecord,
  type SecurityFindingRecord,
  type VerificationExecutionRecord,
} from "./verification-contracts.js";
import {
  ApprovalDecisionRecordSchema,
  ApprovalRequestRecordSchema,
  FailureRecordSchema,
  GitOperationRecordSchema,
  PublicationEvidenceSchema,
  TestExecutionViewSchema,
  type ApprovalDecisionRecord,
  type ApprovalRequestRecord,
  type FailureRecord,
  type GitOperationRecord,
  type PublicationEvidence,
  type TestExecutionView,
} from "./control-contracts.js";
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

  listRuns(states?: RunState[]): EngineerRun[] {
    const rows = states && states.length > 0
      ? this.db.query(`${RUN_SELECT} WHERE r.state IN (${states.map(() => "?").join(",")}) ORDER BY r.created_at`).all(...states)
      : this.db.query(`${RUN_SELECT} ORDER BY r.created_at`).all();
    return (rows as RunRow[]).map(rowToRun);
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

  recordSandbox(record: SandboxRecord): SandboxRecord {
    const parsed = SandboxRecordSchema.parse(record);
    this.getRun(parsed.runId);
    const existing = this.db.query("SELECT id, workspace_identity, image_digest FROM sandboxes WHERE run_id = ?")
      .get(parsed.runId) as { id: string; workspace_identity: string; image_digest: string } | null;
    if (existing) {
      if (existing.id !== parsed.sandboxId || existing.workspace_identity !== parsed.workspaceIdentity ||
          existing.image_digest !== parsed.imageDigest) {
        throw new IdempotencyConflictError(parsed.runId, `sandbox:${parsed.sandboxId}`);
      }
      this.db.query("UPDATE sandboxes SET status = ?, environment_digest = ?, destroyed_at = ? WHERE id = ?")
        .run(parsed.status, parsed.environmentDigest, parsed.destroyedAt, parsed.sandboxId);
      return parsed;
    }
    this.db.query(`INSERT INTO sandboxes
      (id, run_id, workspace_identity, image_digest, environment_digest, status, created_at, destroyed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      parsed.sandboxId, parsed.runId, parsed.workspaceIdentity, parsed.imageDigest,
      parsed.environmentDigest, parsed.status, parsed.createdAt, parsed.destroyedAt,
    );
    this.insertAudit(parsed.runId, "SANDBOX_RECORDED", "SYSTEM", "sandbox-manager", {
      sandboxId: parsed.sandboxId,
      workspaceIdentity: parsed.workspaceIdentity,
      imageDigest: parsed.imageDigest,
      environmentDigest: parsed.environmentDigest,
      source: parsed.source,
    }, parsed.createdAt);
    return parsed;
  }

  recordArtifact(record: ArtifactRecord): ArtifactRecord {
    const parsed = ArtifactRecordSchema.parse(record);
    this.getRun(parsed.runId);
    const existing = this.db.query("SELECT * FROM artifacts WHERE run_id = ? AND sha256 = ? AND type = ?")
      .get(parsed.runId, parsed.sha256, parsed.type) as Record<string, unknown> | null;
    if (existing) return this.artifactFromRow(existing);
    this.db.query(`INSERT INTO artifacts
      (id, run_id, type, sha256, producer_type, producer_id, storage_reference, size_bytes, trusted, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      parsed.artifactId, parsed.runId, parsed.type, parsed.sha256, parsed.producerType,
      parsed.producerId, parsed.storageReference, parsed.sizeBytes, parsed.trusted ? 1 : 0, parsed.createdAt,
    );
    return parsed;
  }

  listArtifacts(runId: string): ArtifactRecord[] {
    this.getRun(runId);
    const rows = this.db.query("SELECT * FROM artifacts WHERE run_id = ? ORDER BY created_at, rowid")
      .all(runId) as Array<Record<string, unknown>>;
    return rows.map((row) => this.artifactFromRow(row));
  }

  recordCommandExecution(record: CommandExecutionRecord): CommandExecutionRecord {
    const parsed = CommandExecutionRecordSchema.parse(record);
    const run = this.getRun(parsed.runId);
    const sandbox = this.db.query("SELECT run_id FROM sandboxes WHERE id = ?").get(parsed.sandboxId) as { run_id: string } | null;
    if (!sandbox || sandbox.run_id !== parsed.runId) throw new EngineerNotFoundError("sandbox", parsed.sandboxId);
    const replay = this.db.query("SELECT id, command FROM command_executions WHERE run_id = ? AND idempotency_key = ?")
      .get(parsed.runId, parsed.idempotencyKey) as { id: string; command: string } | null;
    if (replay) {
      if (replay.id !== parsed.commandExecutionId || replay.command !== parsed.command) {
        throw new IdempotencyConflictError(parsed.runId, parsed.idempotencyKey);
      }
      return parsed;
    }
    const transact = this.db.transaction(() => {
      const stdout = this.recordArtifact(parsed.stdoutArtifact);
      const stderr = this.recordArtifact(parsed.stderrArtifact);
      this.db.query(`INSERT INTO command_executions
        (id, run_id, sandbox_id, command, executor_id, exit_code, started_at, finished_at,
         stdout_artifact_id, stderr_artifact_id, environment_digest, commit_sha, status, idempotency_key)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        parsed.commandExecutionId, parsed.runId, parsed.sandboxId, parsed.command, parsed.executorId,
        parsed.exitCode, parsed.startedAt, parsed.finishedAt, stdout.artifactId, stderr.artifactId,
        parsed.environmentDigest, parsed.commitSha, parsed.status, parsed.idempotencyKey,
      );
      this.insertAudit(parsed.runId, "COMMAND_EXECUTED", "EXECUTOR", parsed.executorId, {
        commandExecutionId: parsed.commandExecutionId,
        command: parsed.command,
        exitCode: parsed.exitCode,
        status: parsed.status,
        stdoutArtifactId: stdout.artifactId,
        stderrArtifactId: stderr.artifactId,
        environmentDigest: parsed.environmentDigest,
        commitSha: parsed.commitSha,
        manifestHash: run.manifestHash,
      }, parsed.finishedAt);
      return CommandExecutionRecordSchema.parse({ ...parsed, stdoutArtifact: stdout, stderrArtifact: stderr });
    });
    return transact();
  }

  recordModelRouting(input: import("./contracts.js").ModelRoutingDecision): void {
    this.getRun(input.runId);
    this.db.query(`INSERT INTO model_routing_decisions
      (id, run_id, agent_role, logical_tier, resolved_model, routing_policy_version,
       fallback_used, fallback_reason, cache_key, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      input.routingDecisionId, input.runId, input.agentRole, input.logicalTier, input.resolvedModel,
      input.routingPolicyVersion, input.fallbackUsed ? 1 : 0, input.fallbackReason, input.cacheKey, input.timestamp,
    );
  }

  recordAgentExecution(record: AgentExecutionRecord): void {
    const parsed = AgentExecutionRecordSchema.parse(record);
    this.getRun(parsed.runId);
    const existing = this.db.query("SELECT run_id, role, model_tier FROM agent_executions WHERE id = ?")
      .get(parsed.agentExecutionId) as { run_id: string; role: string; model_tier: string } | null;
    if (existing) {
      if (existing.run_id !== parsed.runId || existing.role !== parsed.role || existing.model_tier !== parsed.modelTier) {
        throw new IdempotencyConflictError(parsed.runId, `agent:${parsed.agentExecutionId}`);
      }
      this.db.query("UPDATE agent_executions SET status = ?, output_artifact_id = ?, completed_at = ? WHERE id = ?")
        .run(parsed.status, parsed.outputArtifactId, parsed.completedAt, parsed.agentExecutionId);
      return;
    }
    this.db.query(`INSERT INTO agent_executions
      (id, run_id, role, model_tier, status, input_hash, output_artifact_id, started_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      parsed.agentExecutionId, parsed.runId, parsed.role, parsed.modelTier, parsed.status,
      parsed.inputHash, parsed.outputArtifactId, parsed.startedAt, parsed.completedAt,
    );
  }

  recordModelCall(record: ModelCallRecord): void {
    const parsed = ModelCallRecordSchema.parse(record);
    this.getRun(parsed.runId);
    this.db.query(`INSERT INTO model_calls
      (id, run_id, agent_execution_id, logical_tier, resolved_model, prompt_template_version,
       input_context_refs_json, output_schema_version, cache_key, cache_hit, latency_ms,
       input_tokens, output_tokens, retry_count, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      parsed.modelCallId, parsed.runId, parsed.agentExecutionId, parsed.logicalTier, parsed.resolvedModel,
      parsed.promptTemplateVersion, canonicalJson(parsed.inputContextRefs), parsed.outputSchemaVersion,
      parsed.cacheKey, parsed.cacheHit === null ? null : parsed.cacheHit ? 1 : 0, parsed.latencyMs,
      parsed.inputTokens, parsed.outputTokens, parsed.retryCount, parsed.status, parsed.createdAt,
    );
  }

  recordVerificationExecution(record: VerificationExecutionRecord): VerificationExecutionRecord {
    const parsed = VerificationExecutionRecordSchema.parse(record);
    this.getRun(parsed.runId);
    const command = this.db.query("SELECT run_id FROM command_executions WHERE id = ?")
      .get(parsed.commandExecutionId) as { run_id: string } | null;
    if (!command || command.run_id !== parsed.runId) {
      throw new EngineerNotFoundError("command execution", parsed.commandExecutionId);
    }
    const existing = this.db.query("SELECT run_id, command_execution_id FROM test_executions WHERE id = ?")
      .get(parsed.verificationExecutionId) as { run_id: string; command_execution_id: string } | null;
    if (existing) {
      if (existing.run_id !== parsed.runId || existing.command_execution_id !== parsed.commandExecutionId) {
        throw new IdempotencyConflictError(parsed.runId, `verification:${parsed.verificationExecutionId}`);
      }
      return parsed;
    }
    this.db.query(`INSERT INTO test_executions
      (id, run_id, command_execution_id, type, random_seed, status, started_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      parsed.verificationExecutionId, parsed.runId, parsed.commandExecutionId, parsed.type,
      parsed.randomSeed, parsed.status, parsed.startedAt, parsed.completedAt,
    );
    this.insertAudit(parsed.runId, "VERIFICATION_EXECUTED", "EXECUTOR", "trusted-verifier", {
      verificationExecutionId: parsed.verificationExecutionId,
      testId: parsed.testId,
      criterionIds: parsed.criterionIds,
      commandExecutionId: parsed.commandExecutionId,
      type: parsed.type,
      status: parsed.status,
    }, parsed.completedAt);
    return parsed;
  }

  recordSecurityFinding(record: SecurityFindingRecord): SecurityFindingRecord {
    const parsed = SecurityFindingRecordSchema.parse(record);
    this.getRun(parsed.runId);
    const existing = this.db.query("SELECT run_id FROM security_findings WHERE id = ?")
      .get(parsed.securityFindingId) as { run_id: string } | null;
    if (existing) {
      if (existing.run_id !== parsed.runId) throw new IdempotencyConflictError(parsed.runId, `security:${parsed.securityFindingId}`);
      return parsed;
    }
    this.db.query(`INSERT INTO security_findings
      (id, run_id, severity, category, description, file, line_start, line_end,
       evidence_ids_json, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      parsed.securityFindingId, parsed.runId, parsed.severity, parsed.category, parsed.description,
      parsed.file, parsed.lineStart, parsed.lineEnd, canonicalJson(parsed.evidenceIds), parsed.status, parsed.createdAt,
    );
    return parsed;
  }

  recordReviewerSession(
    record: ReviewerSessionRecord,
    findings: ReviewFindingRecord[],
  ): ReviewerSessionRecord {
    const parsed = ReviewerSessionRecordSchema.parse(record);
    const parsedFindings = findings.map((finding) => ReviewFindingRecordSchema.parse(finding));
    this.getRun(parsed.runId);
    if (parsedFindings.some((finding) => finding.reviewerSessionId !== parsed.reviewerSessionId)) {
      throw new IdempotencyConflictError(parsed.runId, `reviewer-findings:${parsed.reviewerSessionId}`);
    }
    const transact = this.db.transaction(() => {
      this.db.query(`INSERT INTO reviewer_sessions
        (id, run_id, attempt, model_tier, resolved_model, input_hash, manifest_hash, diff_hash,
         evidence_bundle_hash, policy_version, cache_key, cache_hit, started_at, completed_at,
         decision, isolation_verified)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        parsed.reviewerSessionId, parsed.runId, parsed.attempt, parsed.modelTier, parsed.resolvedModel,
        parsed.inputHash, parsed.manifestHash, parsed.diffHash, parsed.evidenceBundleHash,
        parsed.policyVersion, parsed.cacheKey, parsed.cacheHit ? 1 : 0, parsed.startedAt,
        parsed.completedAt, parsed.decision, parsed.isolationVerified ? 1 : 0,
      );
      const statement = this.db.query(`INSERT INTO review_findings
        (id, reviewer_session_id, fingerprint, severity, category, file, line_start, line_end,
         description, required_change, criterion_ids_json, evidence_ids_json, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const finding of parsedFindings) {
        statement.run(
          finding.findingId, finding.reviewerSessionId, finding.fingerprint, finding.severity,
          finding.category, finding.file, finding.lineStart, finding.lineEnd, finding.description,
          finding.requiredChange, canonicalJson(finding.criterionIds), canonicalJson(finding.evidenceIds), finding.status,
        );
      }
      this.insertAudit(parsed.runId, "REVIEWER_SESSION_COMPLETED", "AGENT", parsed.reviewerSessionId, {
        attempt: parsed.attempt,
        modelTier: parsed.modelTier,
        resolvedModel: parsed.resolvedModel,
        inputHash: parsed.inputHash,
        diffHash: parsed.diffHash,
        evidenceBundleHash: parsed.evidenceBundleHash,
        decision: parsed.decision,
        isolationVerified: parsed.isolationVerified,
        findingIds: parsedFindings.map((finding) => finding.findingId),
      }, parsed.completedAt);
      return parsed;
    });
    return transact();
  }

  nextReviewerAttempt(runId: string): number {
    this.getRun(runId);
    const row = this.db.query("SELECT COALESCE(MAX(attempt), 0) AS attempt FROM reviewer_sessions WHERE run_id = ?")
      .get(runId) as { attempt: number };
    return row.attempt + 1;
  }

  recordClaimEvidence(record: ClaimEvidenceRecord): ClaimEvidenceRecord {
    const parsed = ClaimEvidenceRecordSchema.parse(record);
    this.getRun(parsed.runId);
    this.db.query(`INSERT INTO claim_evidence
      (id, run_id, criterion_id, claim, status, evidence_ids_json, notes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      parsed.claimId, parsed.runId, parsed.criterionId, parsed.claim, parsed.status,
      canonicalJson(parsed.evidenceIds), parsed.notes, parsed.createdAt,
    );
    return parsed;
  }

  listClaimEvidence(runId: string): ClaimEvidenceRecord[] {
    this.getRun(runId);
    const rows = this.db.query(`SELECT id, run_id, criterion_id, claim, status,
      evidence_ids_json, notes, created_at FROM claim_evidence
      WHERE run_id = ? ORDER BY created_at ASC, id ASC`).all(runId) as Array<Record<string, unknown>>;
    return rows.map((row) => ClaimEvidenceRecordSchema.parse({
      claimId: row.id,
      runId: row.run_id,
      criterionId: row.criterion_id,
      claim: row.claim,
      status: row.status,
      evidenceIds: JSON.parse(String(row.evidence_ids_json)),
      notes: row.notes,
      createdAt: row.created_at,
    }));
  }

  recordEvidenceBundle(record: EvidenceBundleRecord): EvidenceBundleRecord {
    const parsed = EvidenceBundleRecordSchema.parse(record);
    this.getRun(parsed.bundle.runId);
    this.db.query(`INSERT INTO evidence_bundles
      (id, run_id, manifest_hash, bundle_hash, base_commit_sha, result_commit_sha,
       environment_digest, manifest_json, final_decision, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      parsed.evidenceBundleId, parsed.bundle.runId, parsed.bundle.manifestHash, parsed.bundleHash,
      parsed.bundle.baseCommitSha, parsed.bundle.resultCommitSha, parsed.bundle.environmentDigest,
      canonicalJson(parsed.bundle), parsed.bundle.finalDecision, parsed.bundle.createdAt,
    );
    return parsed;
  }

  listEvidenceBundles(runId: string): EvidenceBundleRecord[] {
    this.getRun(runId);
    const rows = this.db.query(`SELECT id, bundle_hash, manifest_json
      FROM evidence_bundles WHERE run_id = ? ORDER BY created_at ASC, id ASC`).all(runId) as Array<Record<string, unknown>>;
    return rows.map((row) => EvidenceBundleRecordSchema.parse({
      evidenceBundleId: row.id,
      bundleHash: row.bundle_hash,
      bundle: JSON.parse(String(row.manifest_json)),
    }));
  }

  listTestExecutions(runId: string): TestExecutionView[] {
    this.getRun(runId);
    const rows = this.db.query("SELECT * FROM test_executions WHERE run_id = ? ORDER BY started_at, rowid").all(runId) as Array<Record<string, unknown>>;
    return rows.map((row) => TestExecutionViewSchema.parse({
      testExecutionId: row.id, runId: row.run_id, commandExecutionId: row.command_execution_id,
      type: row.type, status: row.status, startedAt: row.started_at, completedAt: row.completed_at,
    }));
  }

  listSecurityFindings(runId: string): SecurityFindingRecord[] {
    this.getRun(runId);
    const rows = this.db.query("SELECT * FROM security_findings WHERE run_id = ? ORDER BY created_at, rowid").all(runId) as Array<Record<string, unknown>>;
    return rows.map((row) => SecurityFindingRecordSchema.parse({
      securityFindingId: row.id, runId: row.run_id, severity: row.severity, category: row.category,
      description: row.description, file: row.file, lineStart: row.line_start, lineEnd: row.line_end,
      evidenceIds: JSON.parse(String(row.evidence_ids_json)), status: row.status, createdAt: row.created_at,
    }));
  }

  recordApprovalRequest(record: ApprovalRequestRecord): ApprovalRequestRecord {
    const parsed = ApprovalRequestRecordSchema.parse(record);
    this.getRun(parsed.runId);
    const existing = this.db.query("SELECT * FROM approval_requests WHERE id = ?").get(parsed.approvalRequestId) as Record<string, unknown> | null;
    if (existing) return this.approvalRequestFromRow(existing);
    this.db.query(`INSERT INTO approval_requests
      (id, run_id, risk_tier, assigned_reviewer_id, requested_at, deadline_at,
       reminder_schedule_json, timeout_action, manifest_hash, diff_hash, evidence_bundle_hash, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      parsed.approvalRequestId, parsed.runId, parsed.riskTier, parsed.assignedReviewerId,
      parsed.requestedAt, parsed.deadlineAt, canonicalJson(parsed.reminderSchedule), parsed.timeoutAction,
      parsed.manifestHash, parsed.diffHash, parsed.evidenceBundleHash, parsed.status,
    );
    this.insertAudit(parsed.runId, "HUMAN_APPROVAL_REQUESTED", "SUPERVISOR", "engineer-supervisor", {
      approvalRequestId: parsed.approvalRequestId, riskTier: parsed.riskTier,
      deadlineAt: parsed.deadlineAt, manifestHash: parsed.manifestHash,
      diffHash: parsed.diffHash, evidenceBundleHash: parsed.evidenceBundleHash,
    }, parsed.requestedAt);
    return parsed;
  }

  latestApprovalRequest(runId: string): ApprovalRequestRecord | null {
    this.getRun(runId);
    const row = this.db.query("SELECT * FROM approval_requests WHERE run_id = ? ORDER BY requested_at DESC, rowid DESC LIMIT 1")
      .get(runId) as Record<string, unknown> | null;
    return row ? this.approvalRequestFromRow(row) : null;
  }

  decideApproval(record: ApprovalDecisionRecord, requestStatus: ApprovalRequestRecord["status"]): ApprovalDecisionRecord {
    const parsed = ApprovalDecisionRecordSchema.parse(record);
    const request = this.db.query("SELECT run_id, status FROM approval_requests WHERE id = ?")
      .get(parsed.approvalRequestId) as { run_id: string; status: string } | null;
    if (!request) throw new EngineerNotFoundError("approval request", parsed.approvalRequestId);
    const existing = this.db.query("SELECT * FROM approval_decisions WHERE id = ?").get(parsed.approvalDecisionId) as Record<string, unknown> | null;
    if (existing) return ApprovalDecisionRecordSchema.parse({
      approvalDecisionId: existing.id, approvalRequestId: existing.approval_request_id,
      actorId: existing.actor_id, decision: existing.decision, reason: existing.reason, decidedAt: existing.decided_at,
    });
    if (request.status !== "PENDING") throw new IdempotencyConflictError(request.run_id, `approval:${parsed.approvalRequestId}`);
    const transact = this.db.transaction(() => {
      this.db.query(`INSERT INTO approval_decisions
        (id, approval_request_id, actor_id, decision, reason, decided_at) VALUES (?, ?, ?, ?, ?, ?)`).run(
        parsed.approvalDecisionId, parsed.approvalRequestId, parsed.actorId, parsed.decision, parsed.reason, parsed.decidedAt,
      );
      this.db.query("UPDATE approval_requests SET status = ? WHERE id = ?").run(requestStatus, parsed.approvalRequestId);
      this.insertAudit(request.run_id, `HUMAN_${parsed.decision}`, "HUMAN", parsed.actorId, {
        approvalRequestId: parsed.approvalRequestId, approvalDecisionId: parsed.approvalDecisionId, reason: parsed.reason,
      }, parsed.decidedAt);
      return parsed;
    });
    return transact();
  }

  extendApproval(record: ApprovalDecisionRecord, deadlineAt: string, reminders: string[]): ApprovalRequestRecord {
    const parsed = ApprovalDecisionRecordSchema.parse(record);
    if (parsed.decision !== "EXTEND") throw new TypeError("approval extension requires EXTEND decision");
    const request = this.latestApprovalRequestById(parsed.approvalRequestId);
    if (request.status !== "PENDING") throw new IdempotencyConflictError(request.runId, `approval:${request.approvalRequestId}`);
    this.db.transaction(() => {
      this.db.query(`INSERT INTO approval_decisions
        (id, approval_request_id, actor_id, decision, reason, decided_at) VALUES (?, ?, ?, ?, ?, ?)`).run(
        parsed.approvalDecisionId, parsed.approvalRequestId, parsed.actorId, parsed.decision, parsed.reason, parsed.decidedAt,
      );
      this.db.query("UPDATE approval_requests SET deadline_at = ?, reminder_schedule_json = ? WHERE id = ?")
        .run(deadlineAt, canonicalJson(reminders), parsed.approvalRequestId);
    })();
    return { ...request, deadlineAt, reminderSchedule: reminders };
  }

  getPublicationEvidence(runId: string): PublicationEvidence {
    this.getRun(runId);
    const reviewer = this.db.query(`SELECT id, decision, diff_hash, evidence_bundle_hash, isolation_verified
      FROM reviewer_sessions WHERE run_id = ? ORDER BY attempt DESC LIMIT 1`).get(runId) as Record<string, unknown> | null;
    const bundle = this.db.query(`SELECT id, bundle_hash, manifest_json FROM evidence_bundles
      WHERE run_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(runId) as Record<string, unknown> | null;
    if (!reviewer || !bundle) throw new EngineerNotFoundError("publication evidence", runId);
    const bundleManifest = EvidenceBundleRecordSchema.parse({
      evidenceBundleId: bundle.id, bundleHash: bundle.bundle_hash, bundle: JSON.parse(String(bundle.manifest_json)),
    });
    const testCounts = this.db.query(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN status <> 'PASSED' THEN 1 ELSE 0 END) AS failed FROM test_executions WHERE run_id = ?`)
      .get(runId) as { total: number; failed: number | null };
    const critical = this.db.query(`SELECT COUNT(*) AS count FROM security_findings
      WHERE run_id = ? AND severity = 'CRITICAL' AND status = 'OPEN'`).get(runId) as { count: number };
    return PublicationEvidenceSchema.parse({
      runId, reviewerSessionId: reviewer.id, reviewerDecision: reviewer.decision,
      reviewerDiffHash: reviewer.diff_hash, reviewerEvidenceBundleHash: reviewer.evidence_bundle_hash,
      reviewerIsolationVerified: reviewer.isolation_verified === 1,
      evidenceBundleId: bundleManifest.evidenceBundleId, evidenceBundleHash: bundleManifest.bundleHash,
      resultCommitSha: bundleManifest.bundle.resultCommitSha,
      allRequiredChecksPassed: testCounts.total > 0 && (testCounts.failed ?? 0) === 0,
      openCriticalSecurityFindings: critical.count,
    });
  }

  recordGitOperation(record: GitOperationRecord): GitOperationRecord {
    const parsed = GitOperationRecordSchema.parse(record);
    this.getRun(parsed.runId);
    const existing = this.db.query("SELECT * FROM git_operations WHERE run_id = ? AND idempotency_key = ?")
      .get(parsed.runId, parsed.idempotencyKey) as Record<string, unknown> | null;
    if (existing) {
      const current = this.gitOperationFromRow(existing);
      if (current.gitOperationId !== parsed.gitOperationId || current.operationType !== parsed.operationType) {
        throw new IdempotencyConflictError(parsed.runId, parsed.idempotencyKey);
      }
      this.db.query(`UPDATE git_operations SET status = ?, remote_reference = ?, completed_at = ?, error_code = ?
        WHERE id = ?`).run(parsed.status, parsed.remoteReference, parsed.completedAt, parsed.errorCode, parsed.gitOperationId);
      return parsed;
    }
    this.db.query(`INSERT INTO git_operations
      (id, run_id, operation_type, requested_by, idempotency_key, expected_base_commit_sha,
       result_commit_sha, approval_id, evidence_bundle_hash, status, remote_reference,
       started_at, completed_at, error_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      parsed.gitOperationId, parsed.runId, parsed.operationType, parsed.requestedBy, parsed.idempotencyKey,
      parsed.expectedBaseCommitSha, parsed.resultCommitSha, parsed.approvalId, parsed.evidenceBundleHash,
      parsed.status, parsed.remoteReference, parsed.startedAt, parsed.completedAt, parsed.errorCode,
    );
    return parsed;
  }

  findGitOperation(runId: string, idempotencyKey: string): GitOperationRecord | null {
    this.getRun(runId);
    const row = this.db.query("SELECT * FROM git_operations WHERE run_id = ? AND idempotency_key = ?")
      .get(runId, idempotencyKey) as Record<string, unknown> | null;
    return row ? this.gitOperationFromRow(row) : null;
  }

  recordFailure(record: FailureRecord): FailureRecord {
    const parsed = FailureRecordSchema.parse(record);
    this.getRun(parsed.runId);
    this.db.query(`INSERT INTO failure_records
      (id, run_id, failure_class, reason_code, fingerprint, evidence_ids_json, retryable, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      parsed.failureId, parsed.runId, parsed.failureClass, parsed.reasonCode, parsed.fingerprint,
      canonicalJson(parsed.evidenceIds), parsed.retryable ? 1 : 0, parsed.createdAt,
    );
    return parsed;
  }

  listFailures(runId: string): FailureRecord[] {
    this.getRun(runId);
    const rows = this.db.query("SELECT * FROM failure_records WHERE run_id = ? ORDER BY created_at, rowid").all(runId) as Array<Record<string, unknown>>;
    return rows.map((row) => FailureRecordSchema.parse({
      failureId: row.id, runId: row.run_id, failureClass: row.failure_class, reasonCode: row.reason_code,
      fingerprint: row.fingerprint, evidenceIds: JSON.parse(String(row.evidence_ids_json)),
      retryable: row.retryable === 1, createdAt: row.created_at,
    }));
  }

  close(): void {
    this.db.close();
  }

  private artifactFromRow(row: Record<string, unknown>): ArtifactRecord {
    return ArtifactRecordSchema.parse({
      artifactId: row.id,
      runId: row.run_id,
      type: row.type,
      sha256: row.sha256,
      producerType: row.producer_type,
      producerId: row.producer_id,
      storageReference: row.storage_reference,
      sizeBytes: row.size_bytes,
      trusted: row.trusted === 1,
      createdAt: row.created_at,
    });
  }

  private latestApprovalRequestById(approvalRequestId: string): ApprovalRequestRecord {
    const row = this.db.query("SELECT * FROM approval_requests WHERE id = ?").get(approvalRequestId) as Record<string, unknown> | null;
    if (!row) throw new EngineerNotFoundError("approval request", approvalRequestId);
    return this.approvalRequestFromRow(row);
  }

  private approvalRequestFromRow(row: Record<string, unknown>): ApprovalRequestRecord {
    return ApprovalRequestRecordSchema.parse({
      approvalRequestId: row.id, runId: row.run_id, riskTier: row.risk_tier,
      assignedReviewerId: row.assigned_reviewer_id, requestedAt: row.requested_at,
      deadlineAt: row.deadline_at, reminderSchedule: JSON.parse(String(row.reminder_schedule_json)),
      timeoutAction: row.timeout_action, manifestHash: row.manifest_hash, diffHash: row.diff_hash,
      evidenceBundleHash: row.evidence_bundle_hash, status: row.status,
    });
  }

  private gitOperationFromRow(row: Record<string, unknown>): GitOperationRecord {
    return GitOperationRecordSchema.parse({
      gitOperationId: row.id, runId: row.run_id, operationType: row.operation_type,
      requestedBy: row.requested_by, idempotencyKey: row.idempotency_key,
      expectedBaseCommitSha: row.expected_base_commit_sha, resultCommitSha: row.result_commit_sha,
      approvalId: row.approval_id, evidenceBundleHash: row.evidence_bundle_hash,
      status: row.status, remoteReference: row.remote_reference, startedAt: row.started_at,
      completedAt: row.completed_at, errorCode: row.error_code,
    });
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
