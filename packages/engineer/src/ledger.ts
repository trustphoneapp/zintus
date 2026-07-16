import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import {
  EngineerRunSchema,
  RiskAssessmentSchema,
  RunStateEventSchema,
  TaskManifestContentSchema,
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
  canTransitionGitOperationStatus,
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
import { canonicalJson, matchesSha256Bytes, sha256 } from "./hash.js";
import { PlanProposalSchema, type PlanProposal } from "./planning.js";
import { estimateGpt56CostUsd, OPENAI_GPT56_PRICING_2026_07_14, RunBudgetUsageSchema, type RunBudgetUsage } from "./runtime-budget.js";
import { ContextManifestSchema, StoredContextSnapshotSchema, type StoredContextSnapshot } from "./context-contracts.js";
import {
  DecisionRecordSchema,
  DecisionResolutionSchema,
  type DecisionRecord,
  type DecisionResolution,
} from "./decision-contracts.js";
import { DECISION_POLICY_VERSION } from "./decision-policy.js";
import {
  EngineerBudgetSelectionSchema,
  EngineerBudgetSnapshotSchema,
  type BudgetPauseReason,
  type BudgetTopUp,
  type EngineerBudgetSelection,
  type EngineerBudgetSnapshot,
} from "./budget-contracts.js";
import {
  RepositoryAdmissionSchema,
  type RegisterRepositoryAdmissionInput,
  type RepositoryAdmission,
} from "./repository-admission.js";

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
  last_error: string | null;
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
  budget: EngineerBudgetSelection;
}

interface BudgetRow {
  run_id: string; cost_limit_usd: number; token_limit: number; time_limit_seconds: number;
  lifetime_cost_limit_usd: number; lifetime_token_limit: number; lifetime_time_limit_seconds: number;
  used_cost_usd: number; used_tokens: number; used_time_seconds: number;
  reserved_cost_usd: number; reserved_tokens: number; status: "ACTIVE" | "WARNING" | "PAUSED";
  pause_reason: BudgetPauseReason | null; resume_state: RunState | null; warning_threshold: number;
  revision: number; active_since: string | null; updated_at: string;
}

interface RepositoryAdmissionRow {
  admission_id: string; repository_id: string; owner_user_id: string;
  provider: "github" | "local"; owner: string; repository_name: string; repository_url: string | null;
  base_branch: string; base_commit_sha: string;
  source: "CONFIGURED_CANONICAL" | "CONNECTOR_AUTHORIZED";
  authorization_subject: string; authorization_evidence_hash: string;
  authorization_expires_at: string | null; authorization_generation: number;
  status: "ACTIVE" | "REVOKED"; created_at: string; updated_at: string;
}

function rowToRepositoryAdmission(row: RepositoryAdmissionRow): RepositoryAdmission {
  return RepositoryAdmissionSchema.parse({
    admissionId: row.admission_id,
    ownerUserId: row.owner_user_id,
    repository: {
      repositoryId: row.repository_id,
      provider: row.provider,
      owner: row.owner,
      name: row.repository_name,
      ...(row.repository_url ? { url: row.repository_url } : {}),
      baseBranch: row.base_branch,
      baseCommitSha: row.base_commit_sha,
    },
    source: row.source,
    authorizationSubject: row.authorization_subject,
    authorizationEvidenceHash: row.authorization_evidence_hash,
    authorizationExpiresAt: row.authorization_expires_at,
    authorizationGeneration: row.authorization_generation,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

const REPOSITORY_ADMISSION_SELECT = `
  SELECT a.*, rc.provider, rc.owner, rc.name AS repository_name, rc.url AS repository_url
  FROM repository_admissions a
  JOIN repository_connections rc ON rc.id = a.repository_id
`;

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

export interface RunObservabilityProjection {
  run: EngineerRun;
  pendingApprovals: number;
  retryAttempts: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  estimatedCostUsd: number;
  approvalLatencySecondsTotal: number;
  approvalLatencyCount: number;
  evidenceComplete: boolean;
  failureCount: number;
}

export interface FailureClassProjection {
  failureClass: string;
  count: number;
}

const RUN_SELECT = `
  SELECT r.*, rc.provider, rc.owner, rc.name AS repository_name, rc.url AS repository_url
  FROM engineer_runs r
  JOIN repository_connections rc ON rc.id = r.repository_id
`;

const DIRECT_RUN_EXPORT_TABLES = [
  "task_manifest_versions", "plan_proposals", "context_manifests", "context_sources",
  "context_warnings", "decisions", "decision_evidence", "decision_resolutions",
  "run_state_events", "acceptance_criteria", "agent_executions", "model_calls",
  "sandboxes", "command_executions", "artifacts", "evidence_bundles",
  "claim_evidence", "test_executions", "security_findings", "reviewer_sessions",
  "risk_assessments", "approval_requests", "retry_attempts", "failure_records",
  "cost_records", "audit_events", "git_operations", "model_routing_decisions",
] as const;
const JOINED_RUN_EXPORT_TABLES = ["sandbox_heartbeats", "test_results", "review_findings", "approval_decisions"] as const;
export type RunExportTable = typeof DIRECT_RUN_EXPORT_TABLES[number] | typeof JOINED_RUN_EXPORT_TABLES[number];
const RUN_EXPORT_TABLES = [...DIRECT_RUN_EXPORT_TABLES, ...JOINED_RUN_EXPORT_TABLES] as const;

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
      const directory = dirname(dbPath);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const directoryStat = lstatSync(directory);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || (process.getuid && directoryStat.uid !== process.getuid())) {
        throw new Error("Engineer database directory must be owner-controlled and cannot be a symlink");
      }
      chmodSync(directory, 0o700);
      if (existsSync(dbPath)) {
        const databaseStat = lstatSync(dbPath);
        if (!databaseStat.isFile() || databaseStat.isSymbolicLink() || (process.getuid && databaseStat.uid !== process.getuid())) {
          throw new Error("Engineer database must be an owner-controlled regular file");
        }
      }
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
    const reviewerColumns = this.db.query("PRAGMA table_info(reviewer_sessions)").all() as Array<{ name: string }>;
    if (!reviewerColumns.some((column) => column.name === "cache_observed")) {
      this.db.exec("ALTER TABLE reviewer_sessions ADD COLUMN cache_observed INTEGER NOT NULL DEFAULT 0 CHECK(cache_observed IN (0, 1))");
    }
    const costColumns = new Set((this.db.query("PRAGMA table_info(cost_records)").all() as Array<{ name: string }>).map((column) => column.name));
    for (const [name, type] of [
      ["agent_execution_id", "TEXT"], ["resolved_model", "TEXT"], ["routing_decision_id", "TEXT"],
      ["pricing_version", "TEXT"], ["currency", "TEXT"], ["cached_input_tokens", "INTEGER NOT NULL DEFAULT 0"],
      ["cache_write_input_tokens", "INTEGER NOT NULL DEFAULT 0"],
    ] as const) {
      if (!costColumns.has(name)) this.db.exec(`ALTER TABLE cost_records ADD COLUMN ${name} ${type}`);
    }
    const routingColumns = new Set((this.db.query("PRAGMA table_info(model_routing_decisions)").all() as Array<{ name: string }>).map((column) => column.name));
    if (!routingColumns.has("agent_execution_id")) this.db.exec("ALTER TABLE model_routing_decisions ADD COLUMN agent_execution_id TEXT");
    const modelCallColumns = new Set((this.db.query("PRAGMA table_info(model_calls)").all() as Array<{ name: string }>).map((column) => column.name));
    if (!modelCallColumns.has("budget_reservation_id")) this.db.exec("ALTER TABLE model_calls ADD COLUMN budget_reservation_id TEXT");
    if (!modelCallColumns.has("cached_input_tokens")) this.db.exec("ALTER TABLE model_calls ADD COLUMN cached_input_tokens INTEGER");
    if (!modelCallColumns.has("cache_write_input_tokens")) this.db.exec("ALTER TABLE model_calls ADD COLUMN cache_write_input_tokens INTEGER");
    const testExecutionColumns = new Set((this.db.query("PRAGMA table_info(test_executions)").all() as Array<{ name: string }>).map((column) => column.name));
    if (!testExecutionColumns.has("verification_pass")) this.db.exec("ALTER TABLE test_executions ADD COLUMN verification_pass INTEGER NOT NULL DEFAULT 1");
    const proposalColumns = this.db.query("PRAGMA table_info(plan_proposals)").all() as Array<{ name: string }>;
    if (!proposalColumns.some((column) => column.name === "context_manifest_hash")) {
      this.db.exec("ALTER TABLE plan_proposals ADD COLUMN context_manifest_hash TEXT");
    }
    if (!proposalColumns.some((column) => column.name === "planning_analysis_json")) {
      this.db.exec("ALTER TABLE plan_proposals ADD COLUMN planning_analysis_json TEXT");
    }
    const runColumns = new Set((this.db.query("PRAGMA table_info(engineer_runs)").all() as Array<{ name: string }>).map((column) => column.name));
    if (!runColumns.has("last_error")) this.db.exec("ALTER TABLE engineer_runs ADD COLUMN last_error TEXT");
    const admissionColumns = new Set((this.db.query("PRAGMA table_info(repository_admissions)").all() as Array<{ name: string }>).map((column) => column.name));
    if (!admissionColumns.has("authorization_expires_at")) this.db.exec("ALTER TABLE repository_admissions ADD COLUMN authorization_expires_at TEXT");
    if (!admissionColumns.has("authorization_generation")) this.db.exec("ALTER TABLE repository_admissions ADD COLUMN authorization_generation INTEGER NOT NULL DEFAULT 1 CHECK(authorization_generation > 0)");
    this.db
      .query("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)")
      .run(ENGINEER_DATABASE_SCHEMA_VERSION, new Date().toISOString());
  }

  atomic<T>(operation: () => T): T {
    return this.db.transaction(operation)();
  }

  registerRepositoryAdmission(input: RegisterRepositoryAdmissionInput): RepositoryAdmission {
    const parsed = RepositoryAdmissionSchema.pick({
      admissionId: true, ownerUserId: true, repository: true, source: true,
      authorizationSubject: true, authorizationEvidenceHash: true,
      authorizationExpiresAt: true, authorizationGeneration: true,
    }).parse({
      ...input,
      authorizationExpiresAt: input.authorizationExpiresAt ?? null,
      authorizationGeneration: input.authorizationGeneration ?? 1,
    });
    if (parsed.source === "CONNECTOR_AUTHORIZED" && (!parsed.authorizationExpiresAt || new Date(parsed.authorizationExpiresAt).getTime() <= new Date(input.now).getTime())) {
      throw new Error("connector repository admission requires a future authorization expiry");
    }
    if (parsed.source === "CONFIGURED_CANONICAL" && (parsed.authorizationExpiresAt !== null || parsed.authorizationGeneration !== 1)) {
      throw new Error("configured repository admission cannot carry connector expiry or generation");
    }
    this.db.transaction(() => {
      this.db.query(`INSERT INTO users(id, created_at, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`)
        .run(parsed.ownerUserId, input.now, input.now);
      const existingConnection = this.db.query(`SELECT user_id, provider, owner, name, url
        FROM repository_connections WHERE id = ?`).get(parsed.repository.repositoryId) as {
          user_id: string; provider: string; owner: string; name: string; url: string | null;
        } | null;
      if (existingConnection) {
        if (existingConnection.user_id !== parsed.ownerUserId || existingConnection.provider !== parsed.repository.provider ||
            existingConnection.owner !== parsed.repository.owner || existingConnection.name !== parsed.repository.name ||
            (existingConnection.url ?? null) !== (parsed.repository.url ?? null)) {
          throw new Error("repository connection identity conflicts with trusted admission");
        }
      } else {
        this.db.query(`INSERT INTO repository_connections
          (id, user_id, provider, owner, name, url, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
            parsed.repository.repositoryId, parsed.ownerUserId, parsed.repository.provider,
            parsed.repository.owner, parsed.repository.name, parsed.repository.url ?? null,
            input.now, input.now,
          );
      }
      const existing = this.db.query(`${REPOSITORY_ADMISSION_SELECT} WHERE a.owner_user_id = ? AND a.repository_id = ?`)
        .get(parsed.ownerUserId, parsed.repository.repositoryId) as RepositoryAdmissionRow | null;
      if (existing) {
        const record = rowToRepositoryAdmission(existing);
        if (record.status !== "ACTIVE") throw new Error("revoked repository admission cannot be reactivated implicitly");
        if (record.admissionId !== parsed.admissionId || record.source !== parsed.source ||
            record.authorizationSubject !== parsed.authorizationSubject ||
            record.authorizationEvidenceHash.toLowerCase() !== parsed.authorizationEvidenceHash.toLowerCase() ||
            record.authorizationExpiresAt !== parsed.authorizationExpiresAt ||
            record.authorizationGeneration !== parsed.authorizationGeneration ||
            record.repository.baseBranch !== parsed.repository.baseBranch ||
            ((input.existingBasePolicy ?? "REQUIRE_EXACT") === "REQUIRE_EXACT" &&
              record.repository.baseCommitSha.toLowerCase() !== parsed.repository.baseCommitSha.toLowerCase())) {
          throw new Error("repository admission conflicts with existing trusted record");
        }
        return;
      }
      this.db.query(`INSERT INTO repository_admissions
        (admission_id, repository_id, owner_user_id, base_branch, base_commit_sha, source,
         authorization_subject, authorization_evidence_hash, authorization_expires_at,
         authorization_generation, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`).run(
          parsed.admissionId, parsed.repository.repositoryId, parsed.ownerUserId,
          parsed.repository.baseBranch, parsed.repository.baseCommitSha, parsed.source,
          parsed.authorizationSubject, parsed.authorizationEvidenceHash.toLowerCase(), parsed.authorizationExpiresAt,
          parsed.authorizationGeneration, input.now, input.now,
        );
    })();
    return this.getRepositoryAdmission(parsed.ownerUserId, parsed.repository.repositoryId)!;
  }

  getRepositoryAdmission(ownerUserId: string, repositoryId: string): RepositoryAdmission | null {
    const row = this.db.query(`${REPOSITORY_ADMISSION_SELECT} WHERE a.owner_user_id = ? AND a.repository_id = ?`)
      .get(ownerUserId, repositoryId) as RepositoryAdmissionRow | null;
    return row ? rowToRepositoryAdmission(row) : null;
  }

  migrateLegacyConfiguredRepositoryAdmissionEvidence(ownerUserId: string, repositoryId: string, nextHash: string, now: string): RepositoryAdmission {
    const admission = this.getRepositoryAdmission(ownerUserId, repositoryId);
    if (!admission || admission.source !== "CONFIGURED_CANONICAL" || admission.status !== "ACTIVE") {
      throw new Error("active configured repository admission not found");
    }
    const exactLegacyHash = sha256({ source: "gateway-environment", repository: admission.repository });
    const result = this.db.query(`UPDATE repository_admissions SET authorization_evidence_hash = lower(?), updated_at = ?
      WHERE owner_user_id = ? AND repository_id = ? AND source = 'CONFIGURED_CANONICAL' AND status = 'ACTIVE'
        AND lower(authorization_evidence_hash) = lower(?)`)
      .run(nextHash, now, ownerUserId, repositoryId, exactLegacyHash);
    if (result.changes !== 1) throw new Error("configured repository admission evidence changed concurrently or is inactive");
    return this.getRepositoryAdmission(ownerUserId, repositoryId)!;
  }

  reauthorizeConnectorRepositoryAdmission(input: {
    ownerUserId: string; repositoryId: string; previousGeneration: number; nextGeneration: number;
    authorizationSubject: string; authorizationEvidenceHash: string; authorizationExpiresAt: string; now: string;
  }): RepositoryAdmission {
    const result = this.db.query(`UPDATE repository_admissions SET authorization_subject = ?,
      authorization_evidence_hash = lower(?), authorization_expires_at = ?, authorization_generation = ?,
      status = 'ACTIVE', updated_at = ?
      WHERE owner_user_id = ? AND repository_id = ? AND source = 'CONNECTOR_AUTHORIZED'
        AND authorization_generation = ? AND ? > authorization_generation`).run(
          input.authorizationSubject, input.authorizationEvidenceHash, input.authorizationExpiresAt,
          input.nextGeneration, input.now, input.ownerUserId, input.repositoryId,
          input.previousGeneration, input.nextGeneration,
        );
    if (result.changes !== 1) throw new Error("connector repository reauthorization generation is stale or admission is unavailable");
    return this.getRepositoryAdmission(input.ownerUserId, input.repositoryId)!;
  }

  listRepositoryAdmissions(ownerUserId: string): RepositoryAdmission[] {
    return (this.db.query(`${REPOSITORY_ADMISSION_SELECT} WHERE a.owner_user_id = ? ORDER BY a.created_at, a.repository_id`)
      .all(ownerUserId) as RepositoryAdmissionRow[]).map(rowToRepositoryAdmission);
  }

  advanceRepositoryAdmissionBase(ownerUserId: string, repositoryId: string, previousSha: string, nextSha: string, now: string): RepositoryAdmission {
    const result = this.db.query(`UPDATE repository_admissions SET base_commit_sha = ?, updated_at = ?
      WHERE owner_user_id = ? AND repository_id = ? AND status = 'ACTIVE' AND lower(base_commit_sha) = lower(?)`)
      .run(nextSha, now, ownerUserId, repositoryId, previousSha);
    if (result.changes !== 1) throw new Error("repository admission base advanced concurrently or is inactive");
    return this.getRepositoryAdmission(ownerUserId, repositoryId)!;
  }

  revokeRepositoryAdmission(ownerUserId: string, repositoryId: string, now: string): RepositoryAdmission {
    const result = this.db.query(`UPDATE repository_admissions SET status = 'REVOKED', updated_at = ?
      WHERE owner_user_id = ? AND repository_id = ? AND status = 'ACTIVE'`).run(now, ownerUserId, repositoryId);
    if (result.changes !== 1) throw new Error("active repository admission not found");
    return this.getRepositoryAdmission(ownerUserId, repositoryId)!;
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
      const repositoryConnection = this.db
        .query("SELECT user_id, provider, owner, name, url FROM repository_connections WHERE id = ?")
        .get(input.repository.repositoryId) as { user_id: string; provider: string; owner: string; name: string; url: string | null } | null;
      if (!repositoryConnection || repositoryConnection.user_id !== input.userId) {
        throw new Error("repository connection is not owned by the run user");
      }
      if (repositoryConnection.provider !== input.repository.provider || repositoryConnection.owner !== input.repository.owner ||
          repositoryConnection.name !== input.repository.name ||
          (repositoryConnection.url ?? null) !== (input.repository.url ?? null)) {
        throw new Error("repository connection identity does not match the run repository");
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
      const budget = EngineerBudgetSelectionSchema.parse(input.budget);
      this.db.query(`INSERT INTO run_budgets
        (run_id, cost_limit_usd, token_limit, time_limit_seconds, lifetime_cost_limit_usd,
         lifetime_token_limit, lifetime_time_limit_seconds, status, active_since, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?)`)
        .run(input.runId, budget.costBudgetUsd, budget.tokenBudget, budget.timeBudgetSeconds,
          budget.lifetimeCostBudgetUsd, budget.lifetimeTokenBudget, budget.lifetimeTimeBudgetSeconds,
          input.now, input.now, input.now);
      this.insertAudit(input.runId, "RUN_CREATED", "USER", input.userId, {
        repositoryId: input.repository.repositoryId,
        baseCommitSha: input.repository.baseCommitSha,
        budget,
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

  getLastError(runId: string): string | null {
    const row = this.db.query("SELECT last_error FROM engineer_runs WHERE id = ?").get(runId) as { last_error: string | null } | null;
    if (!row) throw new EngineerNotFoundError("run", runId);
    return row.last_error;
  }

  setLastError(runId: string, message: string | null, now: string): void {
    const result = this.db.query("UPDATE engineer_runs SET last_error = ?, updated_at = ? WHERE id = ?").run(message, now, runId);
    if (Number(result.changes) !== 1) throw new EngineerNotFoundError("run", runId);
  }

  getBudget(runId: string, now: string): EngineerBudgetSnapshot {
    const usage = this.runtimeBudgetUsage(runId, new Date(now));
    this.db.query(`UPDATE run_budgets SET used_cost_usd = ?, used_tokens = ?, used_time_seconds = ?, updated_at = ? WHERE run_id = ?`)
      .run(usage.estimatedCostUsd, usage.inputTokens + usage.outputTokens, Math.floor(usage.elapsedSeconds), now, runId);
    const row = this.db.query("SELECT * FROM run_budgets WHERE run_id = ?").get(runId) as BudgetRow | null;
    if (!row) throw new EngineerNotFoundError("run budget", runId);
    return this.budgetSnapshot(row);
  }

  constrainBudget(runId: string, limits: { costUsd: number; tokens: number; timeSeconds: number }, now: string): EngineerBudgetSnapshot {
    this.db.query(`UPDATE run_budgets SET cost_limit_usd = MIN(cost_limit_usd, ?), token_limit = MIN(token_limit, ?),
      time_limit_seconds = MIN(time_limit_seconds, ?), revision = revision + 1, updated_at = ? WHERE run_id = ?`)
      .run(limits.costUsd, limits.tokens, limits.timeSeconds, now, runId);
    return this.getBudget(runId, now);
  }

  topUpBudget(input: { runId: string; expectedRevision: number; topUp: BudgetTopUp; actorId: string; idempotencyKey: string; createdAt: string }): EngineerBudgetSnapshot {
    return this.atomic(() => {
      const replay = this.db.query("SELECT id FROM budget_events WHERE run_id = ? AND idempotency_key = ?")
        .get(input.runId, input.idempotencyKey);
      if (replay) return this.getBudget(input.runId, input.createdAt);
      const row = this.db.query("SELECT * FROM run_budgets WHERE run_id = ?").get(input.runId) as BudgetRow | null;
      if (!row) throw new EngineerNotFoundError("run budget", input.runId);
      if (row.revision !== input.expectedRevision) throw new StateVersionConflictError(input.runId, input.expectedRevision, row.revision);
      const nextCost = row.cost_limit_usd + input.topUp.addCostBudgetUsd;
      const nextTokens = row.token_limit + input.topUp.addTokenBudget;
      const nextTime = row.time_limit_seconds + input.topUp.addTimeBudgetSeconds;
      if (nextCost > row.lifetime_cost_limit_usd + Number.EPSILON || nextTokens > row.lifetime_token_limit || nextTime > row.lifetime_time_limit_seconds) {
        throw new Error("top-up exceeds the run lifetime budget cap");
      }
      this.db.query(`UPDATE run_budgets SET cost_limit_usd = ?, token_limit = ?, time_limit_seconds = ?, revision = revision + 1, updated_at = ? WHERE run_id = ? AND revision = ?`)
        .run(nextCost, nextTokens, nextTime, input.createdAt, input.runId, input.expectedRevision);
      this.insertBudgetEvent(input.runId, "BUDGET_TOPPED_UP", input.actorId, input.idempotencyKey, input.topUp, input.createdAt);
      this.insertAudit(input.runId, "BUDGET_TOPPED_UP", "HUMAN", input.actorId, { topUp: input.topUp }, input.createdAt);
      return this.getBudget(input.runId, input.createdAt);
    });
  }

  pauseForBudget(command: LedgerTransitionCommand, reason: BudgetPauseReason): LedgerTransitionResult {
    return this.atomic(() => {
      const current = this.getRun(command.runId);
      if (current.state === "PAUSED_BUDGET") {
        const event = this.listEvents(command.runId).at(-1);
        if (!event) throw new EngineerNotFoundError("budget pause event", command.runId);
        return { applied: false, event, run: current };
      }
      const result = this.appendTransition(command);
      this.db.query(`UPDATE run_budgets SET status = 'PAUSED', pause_reason = ?, resume_state = ?, active_since = NULL,
        revision = revision + 1, updated_at = ? WHERE run_id = ?`).run(reason, command.previousState, command.timestamp, command.runId);
      this.insertBudgetEvent(command.runId, "BUDGET_PAUSED", command.actorId, `budget:${command.idempotencyKey}`,
        { reason, resumeState: command.previousState }, command.timestamp);
      return result;
    });
  }

  resumeFromBudget(command: LedgerTransitionCommand): LedgerTransitionResult {
    return this.atomic(() => {
      const row = this.db.query("SELECT * FROM run_budgets WHERE run_id = ?").get(command.runId) as BudgetRow | null;
      if (!row || row.status !== "PAUSED" || row.resume_state !== command.nextState) throw new IdempotencyConflictError(command.runId, command.idempotencyKey);
      const snapshot = this.budgetSnapshot(row);
      if (snapshot.remaining.costUsd === 0 || snapshot.remaining.tokens === 0 || snapshot.remaining.timeSeconds === 0) {
        throw new Error("budget is still exhausted; top up before resuming");
      }
      const result = this.appendTransition(command);
      this.db.query(`UPDATE run_budgets SET status = 'ACTIVE', pause_reason = NULL, resume_state = NULL,
        active_since = ?, revision = revision + 1, updated_at = ? WHERE run_id = ?`).run(command.timestamp, command.timestamp, command.runId);
      this.insertBudgetEvent(command.runId, "BUDGET_RESUMED", command.actorId, `budget:${command.idempotencyKey}`,
        { resumedState: command.nextState }, command.timestamp);
      return result;
    });
  }

  listRuns(states?: RunState[]): EngineerRun[] {
    const rows = states && states.length > 0
      ? this.db.query(`${RUN_SELECT} WHERE r.state IN (${states.map(() => "?").join(",")}) ORDER BY r.created_at`).all(...states)
      : this.db.query(`${RUN_SELECT} ORDER BY r.created_at`).all();
    return (rows as RunRow[]).map(rowToRun);
  }

  listRunsForUser(userId: string, limit = 50, before?: { createdAt: string; runId: string }): EngineerRun[] {
    if (!userId.trim()) throw new TypeError("run owner is required");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError("run page limit must be between 1 and 100");
    const rows = before
      ? this.db.query(`${RUN_SELECT} WHERE r.user_id = ? AND (r.created_at < ? OR (r.created_at = ? AND r.id < ?)) ORDER BY r.created_at DESC, r.id DESC LIMIT ?`)
        .all(userId, before.createdAt, before.createdAt, before.runId, limit)
      : this.db.query(`${RUN_SELECT} WHERE r.user_id = ? ORDER BY r.created_at DESC, r.id DESC LIMIT ?`).all(userId, limit);
    return (rows as RunRow[]).map(rowToRun);
  }

  /**
   * Reads dashboard metrics with one pre-aggregated SQL statement instead of
   * exporting every durable record once per run.
   */
  listRunObservability(ownerId?: string): RunObservabilityProjection[] {
    const sql = `
      WITH
      selected_runs AS (
        SELECT id FROM engineer_runs ${ownerId === undefined ? "" : "WHERE user_id = ?"}
      ),
      pending AS (
        SELECT run_id, 1 AS pending_approvals
        FROM (
          SELECT request.run_id, request.status,
            ROW_NUMBER() OVER (PARTITION BY request.run_id ORDER BY request.requested_at DESC, request.rowid DESC) AS position
          FROM approval_requests request
          JOIN selected_runs selected ON selected.id = request.run_id
        ) WHERE position = 1 AND status = 'PENDING'
      ),
      failures AS (
        SELECT failure.run_id, COUNT(*) AS failure_count
        FROM failure_records failure JOIN selected_runs selected ON selected.id = failure.run_id
        GROUP BY failure.run_id
      ),
      retries AS (
        SELECT retry.run_id, COUNT(*) AS retry_attempts
        FROM retry_attempts retry JOIN selected_runs selected ON selected.id = retry.run_id
        GROUP BY retry.run_id
      ),
      tokens AS (
        SELECT call.run_id,
          COALESCE(SUM(call.input_tokens), 0) AS total_input_tokens,
          COALESCE(SUM(call.output_tokens), 0) AS total_output_tokens,
          COALESCE(SUM(call.cached_input_tokens), 0) AS cached_input_tokens,
          COALESCE(SUM(call.cache_write_input_tokens), 0) AS cache_write_input_tokens
        FROM model_calls call JOIN selected_runs selected ON selected.id = call.run_id
        GROUP BY call.run_id
      ),
      costs AS (
        SELECT cost.run_id, COALESCE(SUM(cost.estimated_cost_usd), 0) AS estimated_cost_usd
        FROM cost_records cost JOIN selected_runs selected ON selected.id = cost.run_id
        WHERE cost.source_type = 'MODEL_CALL' GROUP BY cost.run_id
      ),
      approval_latency AS (
        SELECT request.run_id,
          COALESCE(SUM(ROUND((julianday(decision.decided_at) - julianday(request.requested_at)) * 86400000.0) / 1000.0), 0) AS latency_total,
          COUNT(*) AS latency_count
        FROM approval_decisions decision
        JOIN approval_requests request ON request.id = decision.approval_request_id
        JOIN selected_runs selected ON selected.id = request.run_id
        WHERE decision.decided_at >= request.requested_at
        GROUP BY request.run_id
      ),
      evidence AS (
        SELECT bundle.run_id, 1 AS evidence_complete
        FROM evidence_bundles bundle JOIN selected_runs selected ON selected.id = bundle.run_id
        GROUP BY bundle.run_id
      )
      SELECT r.*, rc.provider, rc.owner, rc.name AS repository_name, rc.url AS repository_url,
        COALESCE(pending.pending_approvals, 0) AS pending_approvals,
        COALESCE(failures.failure_count, 0) AS failure_count,
        COALESCE(retries.retry_attempts, 0) AS retry_attempts,
        COALESCE(tokens.total_input_tokens, 0) AS total_input_tokens,
        COALESCE(tokens.total_output_tokens, 0) AS total_output_tokens,
        COALESCE(tokens.cached_input_tokens, 0) AS cached_input_tokens,
        COALESCE(tokens.cache_write_input_tokens, 0) AS cache_write_input_tokens,
        COALESCE(costs.estimated_cost_usd, 0) AS estimated_cost_usd,
        COALESCE(approval_latency.latency_total, 0) AS approval_latency_total,
        COALESCE(approval_latency.latency_count, 0) AS approval_latency_count,
        COALESCE(evidence.evidence_complete, 0) AS evidence_complete
      FROM engineer_runs r
      JOIN selected_runs selected ON selected.id = r.id
      JOIN repository_connections rc ON rc.id = r.repository_id
      LEFT JOIN pending ON pending.run_id = r.id
      LEFT JOIN failures ON failures.run_id = r.id
      LEFT JOIN retries ON retries.run_id = r.id
      LEFT JOIN tokens ON tokens.run_id = r.id
      LEFT JOIN costs ON costs.run_id = r.id
      LEFT JOIN approval_latency ON approval_latency.run_id = r.id
      LEFT JOIN evidence ON evidence.run_id = r.id
      ORDER BY r.created_at, r.id`;
    type ProjectionRow = RunRow & {
      pending_approvals: number; failure_count: number; retry_attempts: number;
      total_input_tokens: number; total_output_tokens: number; cached_input_tokens: number;
      cache_write_input_tokens: number; estimated_cost_usd: number;
      approval_latency_total: number; approval_latency_count: number; evidence_complete: number;
    };
    const rows = (ownerId === undefined ? this.db.query(sql).all() : this.db.query(sql).all(ownerId)) as ProjectionRow[];
    return rows.map((row) => ({
      run: rowToRun(row),
      pendingApprovals: Number(row.pending_approvals),
      retryAttempts: Number(row.retry_attempts),
      totalInputTokens: Number(row.total_input_tokens),
      totalOutputTokens: Number(row.total_output_tokens),
      cachedInputTokens: Number(row.cached_input_tokens),
      cacheWriteInputTokens: Number(row.cache_write_input_tokens),
      estimatedCostUsd: Number(row.estimated_cost_usd),
      approvalLatencySecondsTotal: Number(row.approval_latency_total),
      approvalLatencyCount: Number(row.approval_latency_count),
      evidenceComplete: Number(row.evidence_complete) === 1,
      failureCount: Number(row.failure_count),
    }));
  }

  listFailureClassObservability(ownerId?: string): FailureClassProjection[] {
    const sql = `SELECT failure.failure_class, COUNT(*) AS count
      FROM failure_records failure
      JOIN engineer_runs run ON run.id = failure.run_id
      ${ownerId === undefined ? "" : "WHERE run.user_id = ?"}
      GROUP BY failure.failure_class ORDER BY failure.failure_class`;
    const rows = (ownerId === undefined ? this.db.query(sql).all() : this.db.query(sql).all(ownerId)) as Array<{ failure_class: string; count: number }>;
    return rows.map((row) => ({ failureClass: row.failure_class, count: Number(row.count) }));
  }

  listEvents(runId: string, afterSequence = 0, limit = 1_000): RunStateEvent[] {
    this.getRun(runId);
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new TypeError("event cursor must be a non-negative safe integer");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw new TypeError("event page limit must be between 1 and 10000");
    const rows = this.db
      .query("SELECT * FROM run_state_events WHERE run_id = ? AND sequence > ? ORDER BY sequence LIMIT ?")
      .all(runId, afterSequence, limit) as EventRow[];
    return rows.map(rowToEvent);
  }

  exportRunRecords(runId: string): Record<string, Array<Record<string, unknown>>> {
    this.getRun(runId);
    const records: Record<string, Array<Record<string, unknown>>> = {};
    for (const table of RUN_EXPORT_TABLES) {
      const rows: Array<Record<string, unknown>> = [];
      for (let offset = 0; ; offset += 1_000) {
        const page = this.exportRunRecordPage(runId, table, offset, 1_000);
        rows.push(...page);
        if (page.length < 1_000) break;
      }
      records[table] = rows;
    }
    return records;
  }

  exportRunRecordTables(runId: string): RunExportTable[] {
    this.getRun(runId);
    return [...RUN_EXPORT_TABLES];
  }

  exportRunRecordPage(runId: string, table: RunExportTable, offset: number, limit = 500): Array<Record<string, unknown>> {
    this.getRun(runId);
    if (!RUN_EXPORT_TABLES.includes(table)) throw new TypeError("unknown run export table");
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("run export offset must be a non-negative safe integer");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new TypeError("run export page limit must be between 1 and 1000");
    if ((DIRECT_RUN_EXPORT_TABLES as readonly string[]).includes(table)) {
      return this.db.query(`SELECT * FROM ${table} WHERE run_id = ? ORDER BY rowid LIMIT ? OFFSET ?`)
        .all(runId, limit, offset) as Array<Record<string, unknown>>;
    }
    if (table === "sandbox_heartbeats") {
      return this.db.query(`SELECT h.* FROM sandbox_heartbeats h JOIN sandboxes s ON s.id = h.sandbox_id WHERE s.run_id = ? ORDER BY h.rowid LIMIT ? OFFSET ?`)
        .all(runId, limit, offset) as Array<Record<string, unknown>>;
    }
    if (table === "test_results") {
      return this.db.query(`SELECT r.* FROM test_results r JOIN test_executions e ON e.id = r.test_execution_id WHERE e.run_id = ? ORDER BY r.rowid LIMIT ? OFFSET ?`)
        .all(runId, limit, offset) as Array<Record<string, unknown>>;
    }
    if (table === "review_findings") {
      return this.db.query(`SELECT f.* FROM review_findings f JOIN reviewer_sessions s ON s.id = f.reviewer_session_id WHERE s.run_id = ? ORDER BY f.rowid LIMIT ? OFFSET ?`)
        .all(runId, limit, offset) as Array<Record<string, unknown>>;
    }
    return this.db.query(`SELECT d.* FROM approval_decisions d JOIN approval_requests r ON r.id = d.approval_request_id WHERE r.run_id = ? ORDER BY d.rowid LIMIT ? OFFSET ?`)
      .all(runId, limit, offset) as Array<Record<string, unknown>>;
  }

  latestEventSequence(runId: string): number {
    this.getRun(runId);
    const row = this.db.query("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM run_state_events WHERE run_id = ?")
      .get(runId) as { sequence: number };
    return Number(row.sequence);
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

  recordPlanProposal(proposal: PlanProposal): PlanProposal {
    this.getRun(proposal.runId);
    const artifact = this.db.query("SELECT run_id, type, sha256, storage_reference, size_bytes FROM artifacts WHERE id = ?")
      .get(proposal.artifactId) as { run_id: string; type: string; sha256: string; storage_reference: string; size_bytes: number } | null;
    if (!artifact || artifact.run_id !== proposal.runId) throw new EngineerNotFoundError("plan artifact", proposal.artifactId);
    if (artifact.type !== "PLAN_PROPOSAL") throw new TypeError("plan proposal must reference a PLAN_PROPOSAL artifact");
    const artifactBytes = readFileSync(artifact.storage_reference);
    if (artifactBytes.byteLength !== artifact.size_bytes || !matchesSha256Bytes(artifactBytes, artifact.sha256)) {
      throw new TypeError("plan proposal artifact failed its content-addressed integrity check");
    }
    const artifactContent = JSON.parse(artifactBytes.toString("utf8")) as unknown;
    const expectedArtifactContent = {
      proposalSchemaVersion: proposal.proposalSchemaVersion,
      plannerPolicyVersion: proposal.plannerPolicyVersion,
      manifest: proposal.manifest,
      planningAnalysis: proposal.planningAnalysis,
      contextManifestHash: proposal.contextManifestHash,
    };
    if (canonicalJson(artifactContent) !== canonicalJson(expectedArtifactContent)) {
      throw new TypeError("plan proposal artifact does not match its hash-bound proposal content");
    }
    const existing = this.db.query("SELECT * FROM plan_proposals WHERE run_id = ? AND proposal_hash = ?")
      .get(proposal.runId, proposal.proposalHash) as Record<string, unknown> | null;
    if (existing) return this.planProposalFromRow(existing);
    this.db.query(`INSERT INTO plan_proposals (id, run_id, proposal_json, planning_analysis_json, proposal_hash, context_manifest_hash, artifact_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        proposal.planProposalId, proposal.runId, canonicalJson(proposal.manifest),
        canonicalJson(proposal.planningAnalysis), proposal.proposalHash,
        proposal.contextManifestHash, proposal.artifactId, proposal.createdAt,
      );
    return proposal;
  }

  latestPlanProposal(runId: string): PlanProposal | null {
    this.getRun(runId);
    const row = this.db.query("SELECT * FROM plan_proposals WHERE run_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get(runId) as Record<string, unknown> | null;
    return row ? this.planProposalFromRow(row) : null;
  }

  recordContextSnapshot(snapshot: StoredContextSnapshot): StoredContextSnapshot {
    const parsed = StoredContextSnapshotSchema.parse(snapshot);
    this.getRun(parsed.manifest.runId);
    const artifact = this.db.query("SELECT run_id, type, sha256, storage_reference FROM artifacts WHERE id = ?").get(parsed.artifactId) as
      { run_id: string; type: string; sha256: string; storage_reference: string } | null;
    if (!artifact || artifact.run_id !== parsed.manifest.runId || artifact.type !== "CONTEXT_MANIFEST") {
      throw new EngineerNotFoundError("context artifact", parsed.artifactId);
    }
    const artifactStat = lstatSync(artifact.storage_reference);
    if (!artifactStat.isFile() || artifactStat.isSymbolicLink()) throw new Error("context artifact storage is not a regular file");
    const artifactBytes = readFileSync(artifact.storage_reference);
    if (!matchesSha256Bytes(artifactBytes, artifact.sha256)) throw new Error("context artifact content hash mismatch");
    const artifactManifest = ContextManifestSchema.parse(JSON.parse(artifactBytes.toString("utf8")));
    if (canonicalJson(artifactManifest) !== canonicalJson(parsed.manifest)) throw new Error("context artifact bytes do not match the persisted manifest");
    const existing = this.db.query("SELECT manifest_json, artifact_id, created_at FROM context_manifests WHERE manifest_hash = ?")
      .get(parsed.manifest.manifestHash) as { manifest_json: string; artifact_id: string; created_at: string } | null;
    if (existing) {
      const replay = StoredContextSnapshotSchema.parse({ manifest: JSON.parse(existing.manifest_json), artifactId: existing.artifact_id, createdAt: existing.created_at });
      if (canonicalJson(replay) !== canonicalJson(parsed)) throw new IdempotencyConflictError(parsed.manifest.runId, parsed.manifest.manifestHash);
      return replay;
    }
    const runExisting = this.db.query("SELECT manifest_hash FROM context_manifests WHERE run_id = ?").get(parsed.manifest.runId) as { manifest_hash: string } | null;
    if (runExisting) throw new IdempotencyConflictError(parsed.manifest.runId, "context-manifest-already-frozen");
    const transaction = this.db.transaction(() => {
      this.db.query(`INSERT INTO context_manifests
        (manifest_hash, run_id, repository_id, base_commit_sha, request_hash, manifest_json, artifact_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        parsed.manifest.manifestHash, parsed.manifest.runId, parsed.manifest.repositoryId,
        parsed.manifest.baseCommitSha, parsed.manifest.requestHash, canonicalJson(parsed.manifest),
        parsed.artifactId, parsed.createdAt,
      );
      const sourceInsert = this.db.query(`INSERT INTO context_sources
        (source_id, manifest_hash, run_id, path, kind, trust, object_id, content_hash, byte_size, excerpt_truncated, source_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const source of parsed.manifest.sources) {
        sourceInsert.run(source.sourceId, parsed.manifest.manifestHash, parsed.manifest.runId, source.path,
          source.kind, source.trust, source.objectId, source.contentHash, source.byteSize,
          source.excerptTruncated ? 1 : 0, canonicalJson(source));
      }
      const warningInsert = this.db.query(`INSERT INTO context_warnings
        (warning_id, manifest_hash, run_id, code, path, source_id, trust, warning_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const warning of parsed.manifest.warnings) {
        warningInsert.run(warning.warningId, parsed.manifest.manifestHash, parsed.manifest.runId,
          warning.code, warning.path, warning.sourceId, warning.trust, canonicalJson(warning));
      }
    });
    try {
      transaction();
      return parsed;
    } catch (error) {
      // A separate Supervisor/process may have committed the same immutable
      // snapshot after our pre-check. Converge only on byte-identical identity.
      const winner = this.db.query("SELECT manifest_json, artifact_id, created_at FROM context_manifests WHERE run_id = ?")
        .get(parsed.manifest.runId) as { manifest_json: string; artifact_id: string; created_at: string } | null;
      if (winner) {
        const replay = StoredContextSnapshotSchema.parse({
          manifest: JSON.parse(winner.manifest_json), artifactId: winner.artifact_id, createdAt: winner.created_at,
        });
        if (replay.manifest.manifestHash === parsed.manifest.manifestHash && replay.artifactId === parsed.artifactId) return replay;
        throw new IdempotencyConflictError(parsed.manifest.runId, "context-manifest-already-frozen");
      }
      throw error;
    }
  }

  latestContextSnapshot(runId: string): StoredContextSnapshot | null {
    this.getRun(runId);
    const row = this.db.query(`SELECT manifest_json, artifact_id, created_at FROM context_manifests
      WHERE run_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(runId) as
      { manifest_json: string; artifact_id: string; created_at: string } | null;
    if (!row) return null;
    return StoredContextSnapshotSchema.parse({
      manifest: ContextManifestSchema.parse(JSON.parse(row.manifest_json)),
      artifactId: row.artifact_id,
      createdAt: row.created_at,
    });
  }

  recordDecision(record: DecisionRecord): DecisionRecord {
    const parsed = DecisionRecordSchema.parse(record);
    for (const evidence of parsed.sourceEvidence) this.assertDecisionEvidence(parsed.runId, evidence);
    const keyed = this.db.query("SELECT decision_json FROM decisions WHERE run_id = ? AND idempotency_key = ?")
      .get(parsed.runId, parsed.idempotencyKey) as { decision_json: string } | null;
    if (keyed) {
      const existing = DecisionRecordSchema.parse(JSON.parse(keyed.decision_json));
      if (canonicalJson(existing) !== canonicalJson(parsed)) throw new IdempotencyConflictError(parsed.runId, parsed.idempotencyKey);
      return existing;
    }
    const run = this.getRun(parsed.runId);
    if (parsed.requestedState !== run.state) {
      throw new TypeError("decision requested state no longer matches the run");
    }
    const duplicate = this.db.query("SELECT id FROM decisions WHERE run_id = ? AND (id = ? OR decision_hash = ?)")
      .get(parsed.runId, parsed.decisionId, parsed.decisionHash) as { id: string } | null;
    if (duplicate) throw new IdempotencyConflictError(parsed.runId, parsed.idempotencyKey);

    const transaction = this.db.transaction(() => {
      this.db.query(`INSERT INTO decisions
        (id, run_id, decision_hash, classification, policy_version, requested_state,
         resume_action, decision_json, idempotency_key, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        parsed.decisionId, parsed.runId, parsed.decisionHash, parsed.classification,
        parsed.policyVersion, parsed.requestedState, parsed.resumeAction,
        canonicalJson(parsed), parsed.idempotencyKey, parsed.createdAt,
      );
      const insertEvidence = this.db.query(`INSERT INTO decision_evidence
        (decision_id, run_id, evidence_id, evidence_run_id, source_type, trust, summary)
        VALUES (?, ?, ?, ?, ?, ?, ?)`);
      for (const evidence of parsed.sourceEvidence) {
        insertEvidence.run(parsed.decisionId, parsed.runId, evidence.evidenceId, evidence.runId,
          evidence.sourceType, evidence.trust, evidence.summary);
      }
      this.insertAudit(parsed.runId, "DECISION_RECORDED", "SUPERVISOR", "engineer-supervisor", {
        decisionId: parsed.decisionId,
        decisionHash: parsed.decisionHash,
        classification: parsed.classification,
        reasonCodes: parsed.reasonCodes,
      }, parsed.createdAt);
    });
    transaction();
    return parsed;
  }

  getDecision(runId: string, decisionId: string): DecisionRecord {
    this.getRun(runId);
    const row = this.db.query("SELECT decision_json FROM decisions WHERE run_id = ? AND id = ?")
      .get(runId, decisionId) as { decision_json: string } | null;
    if (!row) throw new EngineerNotFoundError("decision", decisionId);
    return DecisionRecordSchema.parse(JSON.parse(row.decision_json));
  }

  findDecisionByIdempotency(runId: string, idempotencyKey: string): DecisionRecord | null {
    this.getRun(runId);
    const row = this.db.query("SELECT decision_json FROM decisions WHERE run_id = ? AND idempotency_key = ?")
      .get(runId, idempotencyKey) as { decision_json: string } | null;
    return row ? DecisionRecordSchema.parse(JSON.parse(row.decision_json)) : null;
  }

  listDecisions(runId: string): DecisionRecord[] {
    this.getRun(runId);
    const rows = this.db.query("SELECT decision_json FROM decisions WHERE run_id = ? ORDER BY created_at, rowid")
      .all(runId) as Array<{ decision_json: string }>;
    return rows.map((row) => DecisionRecordSchema.parse(JSON.parse(row.decision_json)));
  }

  listOpenDecisions(runId: string): DecisionRecord[] {
    this.getRun(runId);
    const rows = this.db.query(`SELECT d.decision_json FROM decisions d
      LEFT JOIN decision_resolutions r ON r.decision_id = d.id
      WHERE d.run_id = ? AND r.id IS NULL ORDER BY d.created_at, d.rowid`).all(runId) as Array<{ decision_json: string }>;
    return rows.map((row) => DecisionRecordSchema.parse(JSON.parse(row.decision_json)));
  }

  recordDecisionResolution(record: DecisionResolution): DecisionResolution {
    const parsed = DecisionResolutionSchema.parse(record);
    for (const evidence of parsed.sourceEvidence) this.assertDecisionEvidence(parsed.runId, evidence);
    const decision = this.getDecision(parsed.runId, parsed.decisionId);
    if (!decision.options.some((option) => option.optionId === parsed.selectedOptionId)) {
      throw new TypeError("decision resolution selected an unknown option");
    }
    if (decision.classification === "AUTO") {
      if (parsed.actorType !== "SUPERVISOR" || parsed.selectedOptionId !== decision.recommendedOptionId) {
        throw new TypeError("AUTO decisions may only resolve to the policy-recommended option by the Supervisor");
      }
    } else if (parsed.actorType !== "HUMAN") {
      throw new TypeError("ASK_NOW and DEFER decisions require a human resolution");
    }

    const keyed = this.db.query("SELECT resolution_json FROM decision_resolutions WHERE run_id = ? AND idempotency_key = ?")
      .get(parsed.runId, parsed.idempotencyKey) as { resolution_json: string } | null;
    if (keyed) {
      const existing = DecisionResolutionSchema.parse(JSON.parse(keyed.resolution_json));
      if (canonicalJson(existing) !== canonicalJson(parsed)) throw new IdempotencyConflictError(parsed.runId, parsed.idempotencyKey);
      return existing;
    }
    const prior = this.db.query("SELECT resolution_json FROM decision_resolutions WHERE decision_id = ?")
      .get(parsed.decisionId) as { resolution_json: string } | null;
    if (prior) {
      // An exact payload with a new key is deliberately rejected as a non-idempotent replay.
      throw new IdempotencyConflictError(parsed.runId, parsed.idempotencyKey);
    }
    this.db.query(`INSERT INTO decision_resolutions
      (id, decision_id, run_id, resolution_hash, selected_option_id, actor_type,
       actor_id, policy_version, resolution_json, idempotency_key, resolved_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      parsed.resolutionId, parsed.decisionId, parsed.runId, parsed.resolutionHash,
      parsed.selectedOptionId, parsed.actorType, parsed.actorId, parsed.policyVersion,
      canonicalJson(parsed), parsed.idempotencyKey, parsed.resolvedAt,
    );
    this.insertAudit(parsed.runId, "DECISION_RESOLVED", parsed.actorType, parsed.actorId, {
      decisionId: parsed.decisionId,
      resolutionId: parsed.resolutionId,
      resolutionHash: parsed.resolutionHash,
      selectedOptionId: parsed.selectedOptionId,
    }, parsed.resolvedAt);
    return parsed;
  }

  getDecisionResolution(runId: string, decisionId: string): DecisionResolution | null {
    this.getDecision(runId, decisionId);
    const row = this.db.query("SELECT resolution_json FROM decision_resolutions WHERE run_id = ? AND decision_id = ?")
      .get(runId, decisionId) as { resolution_json: string } | null;
    return row ? DecisionResolutionSchema.parse(JSON.parse(row.resolution_json)) : null;
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

  latestRiskAssessment(runId: string): RiskAssessment | null {
    this.getRun(runId);
    const row = this.db.query("SELECT * FROM risk_assessments WHERE run_id = ? ORDER BY assessed_at DESC, rowid DESC LIMIT 1")
      .get(runId) as Record<string, unknown> | null;
    return row ? RiskAssessmentSchema.parse({
      assessmentId: row.id,
      runId: row.run_id,
      riskTier: row.risk_tier,
      humanGateRequired: row.human_gate_required === 1,
      ruleVersion: row.rule_version,
      matchedRules: JSON.parse(String(row.matched_rules_json)),
      features: JSON.parse(String(row.features_json)),
      assessedAt: row.assessed_at,
    }) : null;
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

  retryAttemptCount(runId: string): number {
    this.getRun(runId);
    const row = this.db.query("SELECT COUNT(*) AS count FROM retry_attempts WHERE run_id = ?").get(runId) as { count: number };
    return row.count;
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

  markRunSandboxesDestroyed(runId: string, destroyedAt: string, reason: string): number {
    this.getRun(runId);
    if (!Number.isFinite(new Date(destroyedAt).getTime())) throw new TypeError("sandbox recovery timestamp must be ISO-8601");
    const changed = this.db.query("UPDATE sandboxes SET status = 'DESTROYED', destroyed_at = ? WHERE run_id = ? AND status != 'DESTROYED'")
      .run(destroyedAt, runId).changes;
    if (changed > 0) this.insertAudit(runId, "SANDBOX_RECOVERY_DESTROYED", "SYSTEM", "worker-watchdog", { reason, count: changed }, destroyedAt);
    return changed;
  }

  recordArtifact(record: ArtifactRecord): ArtifactRecord {
    const parsed = ArtifactRecordSchema.parse(record);
    this.getRun(parsed.runId);
    const existing = this.db.query("SELECT * FROM artifacts WHERE run_id = ? AND sha256 = ? AND type = ?")
      .get(parsed.runId, parsed.sha256, parsed.type) as Record<string, unknown> | null;
    if (existing) return this.artifactFromRow(existing);
    try {
      this.db.query(`INSERT INTO artifacts
        (id, run_id, type, sha256, producer_type, producer_id, storage_reference, size_bytes, trusted, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        parsed.artifactId, parsed.runId, parsed.type, parsed.sha256, parsed.producerType,
        parsed.producerId, parsed.storageReference, parsed.sizeBytes, parsed.trusted ? 1 : 0, parsed.createdAt,
      );
      return parsed;
    } catch (error) {
      const winner = this.db.query("SELECT * FROM artifacts WHERE run_id = ? AND sha256 = ? AND type = ?")
        .get(parsed.runId, parsed.sha256, parsed.type) as Record<string, unknown> | null;
      if (winner) return this.artifactFromRow(winner);
      throw error;
    }
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
    const agent = this.db.query("SELECT run_id, role, model_tier FROM agent_executions WHERE id = ?")
      .get(input.agentExecutionId) as { run_id: string; role: string; model_tier: string } | null;
    if (!agent || agent.run_id !== input.runId || agent.role !== input.agentRole || agent.model_tier !== input.logicalTier) {
      throw new TypeError("model routing decision does not match its agent execution");
    }
    this.db.query(`INSERT INTO model_routing_decisions
      (id, run_id, agent_execution_id, agent_role, logical_tier, resolved_model, routing_policy_version,
       fallback_used, fallback_reason, cache_key, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      input.routingDecisionId, input.runId, input.agentExecutionId, input.agentRole, input.logicalTier, input.resolvedModel,
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

  recordModelCall(record: ModelCallRecord, budgetReservationId?: string): void {
    const parsed = ModelCallRecordSchema.parse(record);
    this.getRun(parsed.runId);
    const agent = this.db.query("SELECT run_id, role, model_tier FROM agent_executions WHERE id = ?")
      .get(parsed.agentExecutionId) as { run_id: string; role: string; model_tier: string } | null;
    if (!agent || agent.run_id !== parsed.runId) {
      throw new TypeError("model call agent execution does not belong to the run");
    }
    if (agent.model_tier !== parsed.logicalTier) {
      throw new TypeError("model call logical tier does not match its agent execution");
    }
    const routing = this.db.query(`SELECT logical_tier, resolved_model FROM model_routing_decisions
      WHERE run_id = ? AND agent_execution_id = ? ORDER BY rowid DESC LIMIT 1`)
      .get(parsed.runId, parsed.agentExecutionId) as { logical_tier: string; resolved_model: string } | null;
    if (!routing || routing.logical_tier !== parsed.logicalTier || routing.resolved_model !== parsed.resolvedModel) {
      throw new TypeError("model call does not match the recorded routing decision");
    }
    this.db.query(`INSERT INTO model_calls
      (id, run_id, agent_execution_id, logical_tier, resolved_model, prompt_template_version,
       input_context_refs_json, output_schema_version, cache_key, cache_hit, latency_ms,
       input_tokens, output_tokens, cached_input_tokens, cache_write_input_tokens, retry_count, budget_reservation_id, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      parsed.modelCallId, parsed.runId, parsed.agentExecutionId, parsed.logicalTier, parsed.resolvedModel,
      parsed.promptTemplateVersion, canonicalJson(parsed.inputContextRefs), parsed.outputSchemaVersion,
      parsed.cacheKey, parsed.cacheHit === null ? null : parsed.cacheHit ? 1 : 0, parsed.latencyMs,
      parsed.inputTokens, parsed.outputTokens, parsed.cachedInputTokens ?? null, parsed.cacheWriteInputTokens ?? null,
      parsed.retryCount, budgetReservationId ?? null, parsed.status, parsed.createdAt,
    );
    if (parsed.inputTokens !== null && parsed.outputTokens !== null) {
      try {
        const estimatedCostUsd = estimateGpt56CostUsd(parsed.resolvedModel, parsed.inputTokens, parsed.outputTokens, {
          cachedInputTokens: parsed.cachedInputTokens ?? 0,
          cacheWriteInputTokens: parsed.cacheWriteInputTokens ?? 0,
        });
        const routing = this.modelRouteForAgent(parsed.runId, parsed.agentExecutionId, parsed.resolvedModel);
        this.db.query(`INSERT OR IGNORE INTO cost_records
          (id, run_id, source_type, source_id, input_tokens, output_tokens, cached_input_tokens, cache_write_input_tokens, estimated_cost_usd,
           agent_execution_id, resolved_model, routing_decision_id, pricing_version, currency, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          sha256({ sourceType: "MODEL_CALL", sourceId: parsed.modelCallId }), parsed.runId,
          "MODEL_CALL", parsed.modelCallId, parsed.inputTokens, parsed.outputTokens, parsed.cachedInputTokens ?? 0, parsed.cacheWriteInputTokens ?? 0,
          estimatedCostUsd, parsed.agentExecutionId, parsed.resolvedModel, routing.routingDecisionId,
          OPENAI_GPT56_PRICING_2026_07_14.version, OPENAI_GPT56_PRICING_2026_07_14.currency, parsed.createdAt,
        );
      } catch {
        // The budget authority detects the missing cost record and fails closed.
      }
    }
  }

  reserveModelBudget(input: {
    runId: string;
    reservationId: string;
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd: number;
    agentExecutionId: string;
    model: string;
    routingDecisionId: string;
    createdAt: string;
  }): void {
    this.getRun(input.runId);
    this.db.query(`INSERT INTO cost_records
      (id, run_id, source_type, source_id, input_tokens, output_tokens, estimated_cost_usd,
       agent_execution_id, resolved_model, routing_decision_id, pricing_version, currency, created_at)
      VALUES (?, ?, 'MODEL_RESERVATION', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(input.reservationId, input.runId, input.reservationId, input.inputTokens, input.outputTokens,
        input.estimatedCostUsd, input.agentExecutionId, input.model, input.routingDecisionId,
        OPENAI_GPT56_PRICING_2026_07_14.version, OPENAI_GPT56_PRICING_2026_07_14.currency, input.createdAt);
  }

  modelRouteForAgent(runId: string, agentExecutionId: string, model: string): { routingDecisionId: string } {
    this.getRun(runId);
    const agent = this.db.query("SELECT role, model_tier FROM agent_executions WHERE id = ? AND run_id = ?")
      .get(agentExecutionId, runId) as { role: string; model_tier: string } | null;
    if (!agent) throw new TypeError("model budget reservation agent does not belong to the run");
    const route = this.db.query(`SELECT id, logical_tier FROM model_routing_decisions
      WHERE run_id = ? AND agent_execution_id = ? AND agent_role = ? AND resolved_model = ? ORDER BY rowid DESC LIMIT 1`)
      .get(runId, agentExecutionId, agent.role, model) as { id: string; logical_tier: string } | null;
    if (!route) throw new TypeError("model budget reservation does not match a recorded route");
    if (route.logical_tier !== agent.model_tier) throw new TypeError("model budget reservation route does not match its agent tier");
    return { routingDecisionId: route.id };
  }

  modelBudgetReservation(runId: string, reservationId: string): { inputTokens: number; outputTokens: number; estimatedCostUsd: number; agentExecutionId: string; model: string; routingDecisionId: string } {
    const row = this.db.query(`SELECT input_tokens, output_tokens, estimated_cost_usd, agent_execution_id, resolved_model, routing_decision_id FROM cost_records
      WHERE id = ? AND run_id = ? AND source_type = 'MODEL_RESERVATION'`)
      .get(reservationId, runId) as { input_tokens: number; output_tokens: number; estimated_cost_usd: number; agent_execution_id: string | null; resolved_model: string | null; routing_decision_id: string | null } | null;
    if (!row) throw new Error("model budget reservation is missing or already finalized");
    if (!row.agent_execution_id || !row.resolved_model || !row.routing_decision_id) throw new Error("legacy model reservation cannot authorize a new call");
    return { inputTokens: Number(row.input_tokens), outputTokens: Number(row.output_tokens), estimatedCostUsd: Number(row.estimated_cost_usd), agentExecutionId: row.agent_execution_id, model: row.resolved_model, routingDecisionId: row.routing_decision_id };
  }

  releaseModelBudgetReservation(runId: string, reservationId: string): void {
    const result = this.db.query("DELETE FROM cost_records WHERE id = ? AND run_id = ? AND source_type = 'MODEL_RESERVATION'")
      .run(reservationId, runId);
    if (Number(result.changes) !== 1) throw new Error("model budget reservation is missing or already finalized");
  }

  runtimeBudgetUsage(runId: string, now = new Date()): RunBudgetUsage {
    const run = this.db.query("SELECT created_at FROM engineer_runs WHERE id = ?").get(runId) as { created_at: string } | null;
    if (!run) throw new EngineerNotFoundError("run", runId);
    const models = this.db.query(`SELECT COUNT(*) AS calls,
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      SUM(CASE WHEN input_tokens IS NOT NULL AND output_tokens IS NOT NULL THEN 1 ELSE 0 END) AS known_calls,
      SUM(CASE WHEN (input_tokens IS NULL OR output_tokens IS NULL) AND NOT EXISTS (
        SELECT 1 FROM cost_records c WHERE c.id = model_calls.budget_reservation_id
          AND c.run_id = model_calls.run_id AND c.source_type = 'MODEL_RESERVATION'
      ) THEN 1 ELSE 0 END) AS unknown_uncovered
      FROM model_calls WHERE run_id = ? AND status = 'SUCCEEDED'`).get(runId) as { calls: number; input_tokens: number; output_tokens: number; known_calls: number; unknown_uncovered: number };
    const costs = this.db.query(`SELECT COUNT(*) AS records,
      SUM(CASE WHEN source_type = 'MODEL_CALL' THEN 1 ELSE 0 END) AS model_call_records,
      COALESCE(SUM(input_tokens), 0) AS input_tokens, COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(estimated_cost_usd), 0) AS cost FROM cost_records WHERE run_id = ?`)
      .get(runId) as { records: number; model_call_records: number; input_tokens: number; output_tokens: number; cost: number };
    const reservations = this.db.query("SELECT COUNT(*) AS count, COALESCE(SUM(input_tokens), 0) AS input_tokens, COALESCE(SUM(output_tokens), 0) AS output_tokens FROM cost_records WHERE run_id = ? AND source_type = 'MODEL_RESERVATION'")
      .get(runId) as { count: number; input_tokens: number; output_tokens: number };
    const commands = this.db.query("SELECT started_at, finished_at FROM command_executions WHERE run_id = ?").all(runId) as Array<{ started_at: string; finished_at: string | null }>;
    const artifact = this.db.query(`SELECT COALESCE(SUM(size_bytes), 0) AS bytes FROM (
      SELECT MAX(size_bytes) AS size_bytes FROM artifacts WHERE run_id = ? GROUP BY sha256
    )`).get(runId) as { bytes: number };
    const agents = this.db.query("SELECT COUNT(*) AS count FROM agent_executions WHERE run_id = ? AND status = 'RUNNING'").get(runId) as { count: number };
    const longestCommandSeconds = commands.reduce((longest, command) => command.finished_at
      ? Math.max(longest, Math.max(0, (Date.parse(command.finished_at) - Date.parse(command.started_at)) / 1_000))
      : longest, 0);
    return RunBudgetUsageSchema.parse({
      elapsedSeconds: Math.max(0, (now.getTime() - Date.parse(run.created_at)) / 1_000),
      modelCalls: Number(models.calls) + Number(reservations.count),
      inputTokens: Number(models.input_tokens) + Number(reservations.input_tokens),
      outputTokens: Number(models.output_tokens) + Number(reservations.output_tokens),
      estimatedCostUsd: Number(costs.cost),
      costKnown: Number(models.unknown_uncovered) === 0 && Number(costs.model_call_records) === Number(models.known_calls),
      longestCommandSeconds, diffLines: 0, artifactBytes: Number(artifact.bytes), activeAgents: Number(agents.count),
    });
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
      (id, run_id, command_execution_id, type, verification_pass, random_seed, status, started_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      parsed.verificationExecutionId, parsed.runId, parsed.commandExecutionId, parsed.type,
      parsed.verificationPass, parsed.randomSeed, parsed.status, parsed.startedAt, parsed.completedAt,
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
         evidence_bundle_hash, policy_version, cache_key, cache_hit, cache_observed, started_at, completed_at,
         decision, isolation_verified)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        parsed.reviewerSessionId, parsed.runId, parsed.attempt, parsed.modelTier, parsed.resolvedModel,
        parsed.inputHash, parsed.manifestHash, parsed.diffHash, parsed.evidenceBundleHash,
        parsed.policyVersion, parsed.cacheKey, parsed.cacheHit ? 1 : 0, parsed.cacheHit === null ? 0 : 1, parsed.startedAt,
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
    const latestPass = this.db.query("SELECT COALESCE(MAX(verification_pass), 1) AS pass FROM test_executions WHERE run_id = ?")
      .get(runId) as { pass: number };
    const testCounts = this.db.query(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN status <> 'PASSED' THEN 1 ELSE 0 END) AS failed FROM test_executions WHERE run_id = ? AND verification_pass = ?`)
      .get(runId, latestPass.pass) as { total: number; failed: number | null };
    const critical = this.db.query(`SELECT COUNT(*) AS count FROM security_findings
      WHERE run_id = ? AND severity = 'CRITICAL' AND status = 'OPEN' AND category NOT LIKE 'AI_ADVISORY_%'`).get(runId) as { count: number };
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
      const immutable = (operation: GitOperationRecord) => ({
        gitOperationId: operation.gitOperationId,
        runId: operation.runId,
        operationType: operation.operationType,
        requestedBy: operation.requestedBy,
        idempotencyKey: operation.idempotencyKey,
        expectedBaseCommitSha: operation.expectedBaseCommitSha,
        resultCommitSha: operation.resultCommitSha,
        approvalId: operation.approvalId,
        evidenceBundleHash: operation.evidenceBundleHash,
        startedAt: operation.startedAt,
      });
      if (sha256(immutable(current)) !== sha256(immutable(parsed))) {
        throw new IdempotencyConflictError(parsed.runId, parsed.idempotencyKey);
      }
      if (!canTransitionGitOperationStatus(current.status, parsed.status)) {
        throw new IdempotencyConflictError(parsed.runId, `${parsed.idempotencyKey}:${current.status}->${parsed.status}`);
      }
      if (current.status === parsed.status && sha256(current) !== sha256(parsed)) {
        throw new IdempotencyConflictError(parsed.runId, `${parsed.idempotencyKey}:${parsed.status}`);
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

  listGitOperations(runId: string): GitOperationRecord[] {
    this.getRun(runId);
    const rows = this.db.query("SELECT * FROM git_operations WHERE run_id = ? ORDER BY started_at, rowid")
      .all(runId) as Array<Record<string, unknown>>;
    return rows.map((row) => this.gitOperationFromRow(row));
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

  private assertDecisionEvidence(runId: string, evidence: DecisionRecord["sourceEvidence"][number]): void {
    if (evidence.runId !== runId) throw new TypeError("cross-run decision evidence rejected");
    if (evidence.sourceType === "ARTIFACT") {
      const row = this.db.query("SELECT run_id, trusted FROM artifacts WHERE id = ?").get(evidence.evidenceId) as { run_id: string; trusted: number } | null;
      if (!row || row.run_id !== runId) throw new EngineerNotFoundError("decision artifact evidence", evidence.evidenceId);
      const expectedTrust = row.trusted === 1 ? "TRUSTED_SYSTEM" : "UNTRUSTED_REPOSITORY";
      if (evidence.trust !== expectedTrust) throw new TypeError("decision artifact evidence trust mismatch");
      return;
    }
    if (evidence.sourceType === "CONTEXT_SOURCE") {
      const row = this.db.query("SELECT run_id FROM context_sources WHERE source_id = ?").get(evidence.evidenceId) as { run_id: string } | null;
      if (!row || row.run_id !== runId || evidence.trust !== "UNTRUSTED_REPOSITORY") {
        throw new EngineerNotFoundError("decision context evidence", evidence.evidenceId);
      }
      return;
    }
    if (evidence.sourceType === "POLICY") {
      if (evidence.evidenceId !== DECISION_POLICY_VERSION || evidence.trust !== "TRUSTED_SYSTEM") {
        throw new TypeError("decision policy evidence is not an authoritative installed policy");
      }
      return;
    }
    if (evidence.sourceType === "HUMAN_RESPONSE") {
      if (evidence.trust !== "TRUSTED_HUMAN") throw new TypeError("human response evidence must be server-authenticated");
      return;
    }
    if (evidence.trust !== "TRUSTED_SYSTEM") {
      throw new TypeError("system decision evidence trust mismatch");
    }
  }

  private planProposalFromRow(row: Record<string, unknown>): PlanProposal {
    if (row.context_manifest_hash === null || row.context_manifest_hash === undefined) {
      throw new Error("legacy ungrounded plan proposal is not eligible for Engineer execution");
    }
    const manifest = TaskManifestContentSchema.parse(JSON.parse(String(row.proposal_json)));
    const planningAnalysis = row.planning_analysis_json === null || row.planning_analysis_json === undefined
      ? { architectureSummary: "", assumptions: [], unresolvedQuestions: [], touchedFileEstimates: [] }
      : JSON.parse(String(row.planning_analysis_json));
    const proposalHash = String(row.proposal_hash);
    return PlanProposalSchema.parse({
      proposalSchemaVersion: proposalHash === sha256(manifest) ? "plan-proposal-v1" : "plan-proposal-v2",
      plannerPolicyVersion: "engineer-planner-v1",
      planProposalId: String(row.id), runId: String(row.run_id),
      manifest, planningAnalysis,
      proposalHash, contextManifestHash: String(row.context_manifest_hash), artifactId: String(row.artifact_id), createdAt: String(row.created_at),
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

  private budgetSnapshot(row: BudgetRow): EngineerBudgetSnapshot {
    const remainingCost = Number(Math.max(0, row.cost_limit_usd - row.used_cost_usd - row.reserved_cost_usd).toFixed(8));
    const remainingTokens = Math.max(0, row.token_limit - row.used_tokens - row.reserved_tokens);
    const remainingTime = Math.max(0, row.time_limit_seconds - row.used_time_seconds);
    const ratios = [row.cost_limit_usd === 0 ? 1 : row.used_cost_usd / row.cost_limit_usd,
      row.token_limit === 0 ? 1 : row.used_tokens / row.token_limit, row.used_time_seconds / row.time_limit_seconds];
    const status = row.status === "PAUSED" ? "PAUSED" : Math.max(...ratios) >= row.warning_threshold ? "WARNING" : "ACTIVE";
    return EngineerBudgetSnapshotSchema.parse({
      runId: row.run_id, status,
      limits: { costUsd: row.cost_limit_usd, tokens: row.token_limit, timeSeconds: row.time_limit_seconds },
      lifetimeLimits: { costUsd: row.lifetime_cost_limit_usd, tokens: row.lifetime_token_limit, timeSeconds: row.lifetime_time_limit_seconds },
      used: { costUsd: row.used_cost_usd, tokens: row.used_tokens, timeSeconds: row.used_time_seconds },
      reserved: { costUsd: row.reserved_cost_usd, tokens: row.reserved_tokens },
      remaining: { costUsd: remainingCost, tokens: remainingTokens, timeSeconds: remainingTime },
      warningThreshold: row.warning_threshold, pauseReason: row.pause_reason, resumeState: row.resume_state,
      revision: row.revision, updatedAt: row.updated_at,
    });
  }

  private insertBudgetEvent(runId: string, eventType: string, actorId: string, idempotencyKey: string, details: unknown, createdAt: string): void {
    const row = this.db.query("SELECT revision FROM run_budgets WHERE run_id = ?").get(runId) as { revision: number } | null;
    if (!row) throw new EngineerNotFoundError("run budget", runId);
    this.db.query(`INSERT INTO budget_events
      (id, run_id, event_type, actor_id, idempotency_key, budget_revision, details_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(randomUUID(), runId, eventType, actorId, idempotencyKey, row.revision, canonicalJson(details), createdAt);
  }
}
