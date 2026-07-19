import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import {
  EngineerRunSchema,
  ModelRoutingDecisionSchema,
  ReviewerInputSchema,
  ReviewerOutputSchema,
  RiskAssessmentSchema,
  RunStateEventSchema,
  TERMINAL_STATES,
  TaskManifestContentSchema,
  TaskManifestSchema,
  type ActorType,
  type EngineerRun,
  type RepositoryReference,
  type ReviewerInput,
  type RetryKind,
  type RiskAssessment,
  type RunState,
  type RunStateEvent,
  type TaskManifest,
} from "./contracts.js";
import {
  ArtifactRecordSchema,
  AgentExecutionRecordSchema,
  BuilderResultSchema,
  BuilderDispatchClaimSchema,
  CommandExecutionRecordSchema,
  ModelCallRecordSchema,
  SandboxRecordSchema,
  type ArtifactRecord,
  type AgentExecutionRecord,
  type BuilderDispatchClaim,
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
  ApprovalDecisionReadRecordSchema,
  ApprovalDecisionRecordSchema,
  ApprovalRequestRecordSchema,
  ApprovalRequestReadRecordSchema,
  FailureRecordSchema,
  GitOperationReadRecordSchema,
  GitOperationRecordSchema,
  canTransitionGitOperationStatus,
  PublicationEvidenceSchema,
  TestExecutionViewSchema,
  type ApprovalRequestRecord,
  type ApprovalDecisionRecord,
  type NewApprovalDecisionRecord,
  type NewApprovalRequestRecord,
  type FailureRecord,
  type GitOperationRecord,
  type NewGitOperationRecord,
  type PublicationEvidence,
  type TestExecutionView,
} from "./control-contracts.js";
import {
  ENGINEER_DATABASE_BASE_SCHEMA_VERSION,
  ENGINEER_DATABASE_SCHEMA_SQL,
  ENGINEER_DEFAULT_ORG_ID,
  V34_ADDITIVE_COLUMN_NAMES,
} from "./database-schema.js";
import { assertEngineerDatabaseVersionSupported, migrateEngineerDatabase } from "./database-migrations.js";
import { createHmacProvenanceSigner, DSSE_PAYLOAD_TYPE, type ProvenanceSigner } from "./attestation.js";
import {
  emitPromotionProvenanceAttestationSync,
  type PromotionProvenanceOptions,
} from "./attestation-assembly.js";

/**
 * P11 caller-supplied seams for the approval-time attestation. `approverUserId`
 * is NOT here — it is the approval's own actorId (real, distinct from the
 * requester). `resultTreeHash` and `publicationReceipt` remain seams: neither is
 * durably recorded for the verified candidate, so the approve caller threads them.
 */
export interface ProvenanceEmissionContext {
  resultTreeHash: string;
  publicationReceipt?: PromotionProvenanceOptions["publicationReceipt"];
}
import {
  AdvisoryChangedError, AdvisoryCursorInvalidError, AdvisoryIntegrityError, AdvisoryMaterializationRequiredError,
  AdvisoryTransitionInvalidError,
  BuilderModelCallLimitError,
  DatabaseIntegrityCorruptionError,
  DatabaseIntegrityFatalMarkerConflictError,
  DatabaseIntegrityFatalMarkerConflictAuthorityInvalidError,
  EngineerNotFoundError,
  HardeningAuthorityInvalidError, HardeningQuoteExpiredError, HardeningSelectionInvalidError,
  HardeningPromptCacheAuthorityUnavailableError,
  HardeningPromptCacheAuthorityMismatchError,
  HardeningQuoteInputTooLargeError, HardeningQuoteVersionStaleError,
  IdempotencyConflictError,
  InvalidTransitionError,
  ReplacementLineageUnverifiedError,
  StateVersionConflictError,
  VerifiedCandidateIntegrityError,
} from "./errors.js";
import { ResolutionLineageVerifier } from "./resolution-lineage.js";
import { PublicationAuthorityService, type PublicationAuthorityDeps } from "./publication-authority.js";
import {
  AdvisoryBacklogEventSchema, AdvisoryBacklogItemSchema, AdvisoryBacklogPageSchema, AdvisoryBacklogViewSchema, AdvisoryOwnerCommandSchema,
  HardeningConsentRequestSchema, HardeningConsentSchema, HardeningQuoteRequestSchema, HardeningQuoteSchema, HardeningQuoteViewSchema,
  HardeningQuoteSizingAuthoritySchema,
  EngineerRunLineageSchema, OptionalHardeningChildCreationSchema, OptionalHardeningChildRequestSchema, OptionalHardeningChildViewSchema,
  createAdvisoryBacklogEvent, createAdvisoryBacklogItem, createEngineerRunLineage, createHardeningConsent,
  createHardeningQuoteSizingAuthority, createHardeningQuoteV2,
  createOptionalHardeningChildAuthority, hardeningChildRunId, advisoryActionability,
  type AdvisoryBacklogEvent, type AdvisoryBacklogItem, type AdvisoryBacklogPage, type AdvisoryOwnerCommand,
  type EngineerRunLineage, type HardeningConsent, type HardeningConsentRequest, type HardeningQuote, type HardeningQuoteRequest,
  type HardeningQuoteSizingAuthority,
  type HardeningQuoteView, type OptionalHardeningChildAuthority, type OptionalHardeningChildCreation, type OptionalHardeningChildRequest, type OptionalHardeningChildView,
} from "./advisory-hardening-contracts.js";
import { DEFAULT_HARDENING_ESTIMATION_AUTHORITY_V2, deterministicHardeningEstimate, deterministicHardeningEstimateV2 } from "./hardening-estimator.js";
import { hardeningBuilderSizingTemplate } from "./hardening-quote-sizing.js";
import {
  HardeningSeedAttestationSchema, HardeningStartOperationSchema, HardeningStartRequestSchema,
  SignedHardeningSeedAttestationSchema, createHardeningStartOperation, verifySignedHardeningSeedAttestation,
  type HardeningStartOperation, type HardeningStartRequest, type SignedHardeningSeedAttestation,
} from "./hardening-start-contracts.js";
import {
  HARDENING_MODEL_CALL_SLOT_POLICY_VERSION, HARDENING_START_CLAIM_POLICY_VERSION,
  HardeningModelCallSlotClaimSchema, HardeningPaidModelRoleSchema, HardeningPaidModelTierSchema,
  HardeningStartClaimIntentSchema, HardeningStartFenceSchema,
  HardeningStartClaimBusyError, HardeningStartFenceStaleError,
  createHardeningStartClaimIntent,
  type HardeningModelCallSlotClaim, type HardeningPaidModelRole, type HardeningPaidModelTier,
  type HardeningStartClaimIntent, type HardeningStartFence,
} from "./hardening-execution-fencing.js";
import {
  HardeningBudgetAuthoritySchema,
  HardeningInvalidReceiptObservationSchema,
  HardeningBudgetReconciliationSchema,
  HardeningBudgetReservationSchema,
  HardeningBudgetAuthorityInvalidError,
  HardeningBudgetStoppedError,
  HardeningExecutionFenceStaleError,
  HardeningReservationConflictError,
  createHardeningBudgetAuthority,
  createHardeningInvalidReceiptObservation,
  createHardeningBudgetReconciliation,
  createHardeningBudgetReservation,
  hardeningClientRequestId,
  assertHardeningReservationCost,
  hardeningModelCostMicrousd,
  hardeningPartitionedCostFromRatesMicrousd,
  type HardeningBudgetAuthority,
  type HardeningBudgetReconciliation,
  type HardeningBudgetReservation,
  type HardeningInvalidReceiptObservation,
  type HardeningBudgetStopReason,
} from "./hardening-budget-contracts.js";
import {
  canonicalHardeningPromptCacheMaterial,
  HardeningPromptCacheDescriptorSchema,
  type HardeningPromptCacheDescriptor,
} from "./hardening-prompt-cache.js";
import {
  HARDENING_DATABASE_INTEGRITY_GUIDANCE,
  HARDENING_DATABASE_INTEGRITY_MARKER_AUTHORITY_INVALID_GUIDANCE,
  HARDENING_DATABASE_INTEGRITY_MARKER_CONFLICT_GUIDANCE,
  canonicalHardeningDatabaseIntegrityFailure,
  canonicalHardeningDatabaseIntegrityConflictFailure,
  hardeningDatabaseIntegrityConflictFailureId,
  hardeningDatabaseIntegrityFailureId,
} from "./hardening-database-integrity.js";
import { canonicalJson, compareCodeUnits, matchesSha256Bytes, sha256, sha256Bytes } from "./hash.js";
import { PlanProposalSchema, type PlanProposal } from "./planning.js";
import { bindReviewerEvidence, reviewerFindingRecords } from "./isolated-reviewer.js";
import {
  AdversarialCoverageReportSchema,
  buildAdversarialCoverageReport,
} from "./adversarial-coverage.js";
import {
  TestBaselineManifestSchema,
  TestIntegrityComparisonSchema,
} from "./test-integrity.js";

type HardeningReceiptRead =
  | { bytes: Buffer; failureCode: null }
  | { bytes: null; failureCode: "FILE_MISSING" | "NOT_REGULAR_FILE" };

/**
 * Opens an untrusted durable receipt exactly once, rejects symlinks at open,
 * validates the opened object, and reads from that same descriptor. This keeps
 * recovery authority bound to one inode instead of a path that can be swapped
 * between exists/lstat/read operations.
 */
function readHardeningReceiptOnce(path: string): HardeningReceiptRead {
  let fd: number | null = null;
  try {
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return { bytes: null, failureCode: "FILE_MISSING" };
      if (code === "ELOOP" || code === "EISDIR") return { bytes: null, failureCode: "NOT_REGULAR_FILE" };
      throw error;
    }
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { bytes: null, failureCode: "NOT_REGULAR_FILE" };
    return { bytes: readFileSync(fd), failureCode: null };
  } finally {
    if (fd !== null) closeSync(fd);
  }
}
import {
  ReviewClassificationBatchSchema,
  RequiredTestGateSchema,
  classifyReviewerOutput,
  type RequiredTestGate,
  type ReviewClassificationBatch,
} from "./review-classification.js";
import {
  VerificationCoverageMatrixSchema,
  buildVerificationCoverageMatrix,
} from "./verification-contracts.js";
import { TestAdvisorySchema } from "./terra-advisors.js";
import { scanDiffForSecurity, securityFindingSemantics } from "./deterministic-security-scan.js";
import { buildFinalChangeScopeAttestation } from "./final-change-scope.js";
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
  RequiredLaneContractSchema,
  assertRequiredLaneContractMatchesManifest,
  type RequiredLaneContract,
  type RequiredLaneContractAuthority,
} from "./required-lane-contracts.js";
import {
  BuilderDispatchCheckpointClaimSchema,
  SignedVerifiedHardeningCandidateAttestationSchema,
  SignedVerifiedCandidateAttestationSchema,
  VerifiedHardeningCandidateCheckpointSchema,
  VerifiedCandidateCheckpointSchema,
  createVerifiedHardeningCandidateCheckpoint,
  createVerifiedCandidateCheckpoint,
  verifySignedVerifiedHardeningCandidateAttestation,
  verifySignedVerifiedCandidateAttestation,
  type CheckpointAttestor,
  type PromoteVerifiedCandidateInput,
  type SignedVerifiedHardeningCandidateAttestation,
  type SignedVerifiedCandidateAttestation,
  type VerifiedHardeningCandidateCheckpoint,
  type VerifiedHardeningCandidateCheckpointInput,
  type VerifiedCandidateCheckpoint,
  type VerifiedCandidateCheckpointInput,
  type VerifiedHardeningCandidatePromotionResult,
  type VerifiedCandidatePromotionResult,
} from "./verified-candidate-checkpoint.js";
import { FinalChangeScopeAttestationSchema } from "./final-change-scope.js";


const EXECUTION_CLOCK_WAIT_STATES = new Set<RunState>([
  "CLARIFICATION_REQUIRED",
  "PLAN_READY",
  "PLAN_FROZEN",
  "MODEL_PROVIDER_RETRY_PENDING",
  "REVIEW_APPROVED",
  "HUMAN_APPROVAL_PENDING",
  "HUMAN_REVIEW_REQUIRED",
  "FIX_REQUESTED",
  "BASE_BRANCH_STALE",
  "PR_CREATION_FAILED",
  "PAUSED_BUDGET",
  ...TERMINAL_STATES,
]);
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
  ambiguous_cost_usd: number; ambiguous_tokens: number;
  pause_reason: BudgetPauseReason | null; resume_state: RunState | null; warning_threshold: number;
  revision: number; active_since: string | null; created_at: string; updated_at: string;
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
  reasonCode: "RETRY_ALLOWED" | "KIND_BUDGET_EXHAUSTED" | "TOTAL_BUILDER_BUDGET_EXHAUSTED" | "SAME_FAILURE_LIMIT_REACHED" | "IDENTICAL_PATCH_REPEATED" | "NO_MEASURABLE_PROGRESS";
  policyVersion: string;
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

export interface ReviewerPersistenceRecoveryCandidate {
  agentExecutionId: string;
  inputHash: string;
  modelTier: "GPT-5.6_SOL";
  resolvedModel: string;
  cacheKey: string;
  cacheHit: boolean | null;
  startedAt: string;
  completedAt: string;
  outputArtifactId: string;
}

export interface RecordedReviewerOutput {
  reviewerSessionId: string;
  attempt: number;
  decision: "APPROVE" | "REQUEST_CHANGES" | "REJECT" | "HUMAN_REVIEW_REQUIRED";
  diffHash: string;
  evidenceBundleHash: string;
  outputArtifactId: string;
}

export interface ClassifiedReviewerAuthority {
  reviewerInput: ReviewerInput;
  rawOutputArtifact: ArtifactRecord;
  provenanceConflict?: boolean;
}

export type ArtifactByteReader = (artifact: ArtifactRecord) => Buffer;

export interface OptionalHardeningStartPreparation {
  replay: boolean;
  operation: HardeningStartOperation;
  lineage: EngineerRunLineage;
  authority: OptionalHardeningChildAuthority;
  parentCheckpoint: VerifiedCandidateCheckpoint;
  parentManifest: TaskManifest;
  child: { riskTier:"LOW"|"MEDIUM"|"HIGH"|"CRITICAL"; humanGateRequired:true; budget:{costMicrousd:number;tokens:number;timeSeconds:number}; createdAt:string };
  seed: { finalDiff:string; diffHash:string; baseCommitSha:string; seedResultCommitSha:string; environmentDigest:string };
  signedSeed: SignedHardeningSeedAttestation|null;
}

export interface ClaimOptionalHardeningStartInput extends Omit<HardeningStartClaimIntent, "schemaVersion" | "policyVersion"> {
  ownerId: string;
  leaseMs: number;
}

export interface FinalizeOptionalHardeningStartClaimInput {
  childRunId: string;
  claimId: string;
  fenceToken: string;
  generation: number;
  operationId: string;
  operationHash: string;
  seedAttestationId: string;
  seedAttestationHash: string;
  sandboxId: string;
}

export interface ActiveOptionalHardeningStartFence {
  claimId: string;
  fenceToken: string;
  generation: number;
}

const RUN_SELECT = `
  SELECT r.*, rc.provider, rc.owner, rc.name AS repository_name, rc.url AS repository_url
  FROM engineer_runs r
  JOIN repository_connections rc ON rc.id = r.repository_id
`;

const DIRECT_RUN_EXPORT_TABLES = [
  "task_manifest_versions", "required_lane_contracts", "plan_proposals", "context_manifests", "context_sources",
  "context_warnings", "decisions", "decision_evidence", "decision_resolutions",
  "run_state_events", "acceptance_criteria", "agent_executions", "model_calls",
  "builder_dispatch_claims",
  "verified_candidate_checkpoints",
  "sandboxes", "command_executions", "artifacts", "evidence_bundles",
  "claim_evidence", "test_executions", "security_findings", "reviewer_sessions", "review_classification_batches",
  "risk_assessments", "approval_requests", "retry_attempts", "failure_records",
  "cost_records", "audit_events", "git_operations", "model_routing_decisions",
] as const;
const JOINED_RUN_EXPORT_TABLES = [
  "sandbox_heartbeats", "test_results", "review_findings", "review_finding_classifications", "approval_decisions",
  "advisory_backlog_items", "hardening_quote_advisories", "hardening_quotes", "hardening_quote_requests", "hardening_consents",
  "engineer_run_lineage", "advisory_backlog_events", "hardening_start_operations", "hardening_seed_attestations",
  "publication_candidate_selections",
  "hardening_start_claims", "hardening_model_call_slots", "hardening_child_budget_authorities",
  "hardening_child_model_reservations", "hardening_child_tool_actions",
  "hardening_paid_call_finalizations", "hardening_recovery_worker_fences",
] as const;
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

function enableWalWithBoundedRetry(db: Database): void {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      db.exec("PRAGMA journal_mode=WAL");
      return;
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code !== "SQLITE_BUSY" || attempt === 99) throw error;
      // SQLite may return BUSY immediately while another fresh process is
      // changing journal mode even when busy_timeout is configured. Keep the
      // retry local, synchronous, and strictly bounded during startup.
      Bun.sleepSync(10);
    }
  }
}

/** Internal durable ledger. It is deliberately not exported from package index.ts. */
export class EngineerLedger {
  private readonly db: Database;
  private readonly now: () => Date;
  /**
   * P10 tenancy: the org context these ledger queries scope to. Today the whole
   * ledger is a single tenant — every pre/post-v34 row lives in the DEFAULT org,
   * so scoping the high-traffic owner queries on `org_id = <default>` preserves
   * behavior exactly while making them tenant-fenced. The multi-tenant path is
   * `TenantScopedLedgerDal` (org bound at construction, isolation-tested); the
   * SEAM not closed here is the gateway deriving a per-request org from the
   * authenticated identity and threading it in place of this constant.
   */
  private readonly tenantOrgId: string = ENGINEER_DEFAULT_ORG_ID;
  private hardeningPromptCacheSecret?: string;
  private hardeningArtifactReader?: ArtifactByteReader;
  // P7 replacement-lineage authority. Injected at composition time via
  // configureResolutionSigningSecret with the gateway-held directive-signing
  // secret (never present in any model or sandbox). When unset, replacement runs
  // cannot be granted promotion / approval / publication authority (fail closed);
  // ordinary runs never consult it.
  private resolutionSigningSecret?: string;
  private resolutionLineageVerifier?: ResolutionLineageVerifier;
  // P11 provenance-attestation signing authority. Injected at composition time
  // via configureProvenanceAttestationSigner with the gateway-held confined
  // secret (never present in any model or sandbox). When set, a durable APPROVE
  // decision MUST atomically emit + persist a signed DSSE provenance attestation
  // for its verified-candidate subject (fail closed). When unset, no attestation
  // is emitted at approval time (the generation capability is opt-in; the gateway
  // wiring threads the secret to make it required in the live lifecycle).
  private provenanceSigningSecret?: string;
  private provenanceSigner?: ProvenanceSigner;

  constructor(dbPath: string, now: () => Date = () => new Date(), hardeningPromptCacheSecret?: string) {
    this.now = now;
    if (hardeningPromptCacheSecret !== undefined) this.configureHardeningPromptCacheSecret(hardeningPromptCacheSecret);
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
    enableWalWithBoundedRetry(this.db);
    assertEngineerDatabaseVersionSupported(this.db);
    this.db.exec(ENGINEER_DATABASE_SCHEMA_SQL);
    this.db.exec("PRAGMA foreign_keys=OFF");
    try {
      this.db.exec("BEGIN IMMEDIATE");
      const sandboxSchema = this.db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sandboxes'")
        .get() as { sql: string } | null;
      if (sandboxSchema?.sql && /run_id\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i.test(sandboxSchema.sql)) {
        this.db.exec(`
          CREATE TABLE sandboxes_v14 (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL REFERENCES engineer_runs(id) ON DELETE RESTRICT,
            workspace_identity TEXT NOT NULL UNIQUE,
            image_digest TEXT NOT NULL,
            environment_digest TEXT,
            status TEXT NOT NULL,
            created_at TEXT NOT NULL,
            destroyed_at TEXT
          );
          INSERT INTO sandboxes_v14 SELECT id, run_id, workspace_identity, image_digest, environment_digest, status, created_at, destroyed_at FROM sandboxes;
          DROP TABLE sandboxes;
          ALTER TABLE sandboxes_v14 RENAME TO sandboxes;
          CREATE INDEX idx_sandboxes_run ON sandboxes(run_id, created_at);`);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* preserve the original migration error */ }
      throw error;
    } finally {
      this.db.exec("PRAGMA foreign_keys=ON");
    }
    const migrationTimestamp = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
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
    if (!costColumns.has("reservation_status")) {
      this.db.exec("ALTER TABLE cost_records ADD COLUMN reservation_status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(reservation_status IN ('ACTIVE', 'AMBIGUOUS_PROVIDER_OUTCOME'))");
    }
    const budgetColumns = new Set((this.db.query("PRAGMA table_info(run_budgets)").all() as Array<{ name: string }>).map((column) => column.name));
    if (!budgetColumns.has("ambiguous_cost_usd")) this.db.exec("ALTER TABLE run_budgets ADD COLUMN ambiguous_cost_usd REAL NOT NULL DEFAULT 0 CHECK(ambiguous_cost_usd >= 0)");
    if (!budgetColumns.has("ambiguous_tokens")) this.db.exec("ALTER TABLE run_budgets ADD COLUMN ambiguous_tokens INTEGER NOT NULL DEFAULT 0 CHECK(ambiguous_tokens >= 0)");
    const routingColumns = new Set((this.db.query("PRAGMA table_info(model_routing_decisions)").all() as Array<{ name: string }>).map((column) => column.name));
    if (!routingColumns.has("agent_execution_id")) this.db.exec("ALTER TABLE model_routing_decisions ADD COLUMN agent_execution_id TEXT");
    const modelCallColumns = new Set((this.db.query("PRAGMA table_info(model_calls)").all() as Array<{ name: string }>).map((column) => column.name));
    if (!modelCallColumns.has("budget_reservation_id")) this.db.exec("ALTER TABLE model_calls ADD COLUMN budget_reservation_id TEXT");
    if (!modelCallColumns.has("cached_input_tokens")) this.db.exec("ALTER TABLE model_calls ADD COLUMN cached_input_tokens INTEGER");
    if (!modelCallColumns.has("cache_write_input_tokens")) this.db.exec("ALTER TABLE model_calls ADD COLUMN cache_write_input_tokens INTEGER");
    // Classify historical unknown-outcome failures during migration. They
    // remain fenced at their worst-case allowance, but are no longer displayed
    // as if a provider request were still actively in flight.
    this.db.exec(`UPDATE cost_records SET reservation_status = 'AMBIGUOUS_PROVIDER_OUTCOME'
      WHERE source_type = 'MODEL_RESERVATION' AND reservation_status = 'ACTIVE' AND EXISTS (
        SELECT 1 FROM model_calls
        WHERE model_calls.run_id = cost_records.run_id
          AND model_calls.budget_reservation_id = cost_records.id
          AND model_calls.status = 'FAILED'
          AND (model_calls.input_tokens IS NULL OR model_calls.output_tokens IS NULL)
      )`);
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
    const recordedVersion = this.db.query("SELECT MAX(version) AS version FROM schema_migrations")
      .get() as { version: number | null };
    if ((recordedVersion.version ?? 0) < ENGINEER_DATABASE_BASE_SCHEMA_VERSION) {
      this.db.query("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)")
        .run(ENGINEER_DATABASE_BASE_SCHEMA_VERSION, migrationTimestamp);
    }
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* preserve the original repair failure */ }
      throw error;
    }
    migrateEngineerDatabase(this.db, migrationTimestamp);
  }

  /** Server-owned strict reader used by every optional-hardening receipt/recovery path. */
  configureHardeningArtifactReader(readArtifact:ArtifactByteReader):void{
    if(this.hardeningArtifactReader&&this.hardeningArtifactReader!==readArtifact)
      throw new Error("Engineer hardening artifact reader is already configured");
    this.hardeningArtifactReader=readArtifact;
  }

  configureHardeningPromptCacheSecret(secret: string): void {
    if (secret.length < 32) throw new TypeError("hardening prompt-cache secret must contain at least 32 characters");
    if (this.hardeningPromptCacheSecret !== undefined && this.hardeningPromptCacheSecret !== secret) {
      throw new HardeningPromptCacheAuthorityMismatchError();
    }
    this.hardeningPromptCacheSecret = secret;
  }

  /**
   * P7 verifier-injection seam. Binds the gateway-held resolution directive-
   * signing secret so the ledger can construct its ResolutionLineageVerifier on
   * its OWN durable connection (the same connection the desk writes replacement
   * rows on — see resolutionDeskConnection). The secret is owner-only and confined
   * to this process; it is never handed to a model or sandbox. Idempotent for the
   * same secret; a mismatched re-configure is rejected. Until this is called,
   * every replacement run fails closed at the promotion / approval / publication
   * authority gate (no legacy same-run fallback).
   */
  configureResolutionSigningSecret(secret: string): void {
    if (secret.length < 32) throw new TypeError("resolution signing secret must contain at least 32 characters");
    if (this.resolutionSigningSecret !== undefined && this.resolutionSigningSecret !== secret) {
      throw new Error("Engineer resolution signing authority is already configured with a different secret");
    }
    this.resolutionSigningSecret = secret;
    this.resolutionLineageVerifier = new ResolutionLineageVerifier(this.db, secret);
  }

  /**
   * P11 provenance-attestation signing seam. Binds the gateway-held confined
   * signing secret so a durable APPROVE atomically emits + persists a signed DSSE
   * provenance attestation for the approved verified candidate (see decideApproval).
   * The secret is captured in the HMAC signer's closure and is never a field of
   * the signer object, so a context holding only the signer cannot exfiltrate the
   * key; it is never handed to a model or sandbox. Idempotent for the same secret;
   * a mismatched re-configure is rejected. Until this is called, no attestation is
   * emitted at approval time.
   */
  configureProvenanceAttestationSigner(secret: string, keyId: string): void {
    if (secret.length < 32) throw new TypeError("provenance attestation signing secret must contain at least 32 characters");
    if (keyId.length < 1) throw new TypeError("provenance attestation signing keyId is required");
    if (this.provenanceSigningSecret !== undefined && this.provenanceSigningSecret !== secret) {
      throw new Error("Engineer provenance attestation signing authority is already configured with a different secret");
    }
    this.provenanceSigningSecret = secret;
    this.provenanceSigner = createHmacProvenanceSigner({ secret, keyId });
  }

  /**
   * P7 fail-closed authority gate. A run created by applying a
   * CREATE_CORRECTED_RUN / CREATE_REVERIFY_RUN directive is a "replacement run":
   * it owns a resolution_replacements row keyed by replacement_run_id. Such a run
   * must not be granted promotion, approval, or publication authority unless its
   * COMPLETE durable lineage verifies through ResolutionLineageVerifier. A run
   * with no such row is an ordinary run and keeps its existing path unchanged.
   * There is NO legacy same-run fallback: if the run is a replacement but the
   * signing authority (verifier) is unavailable, or any lineage link fails,
   * authority is refused.
   */
  private assertReplacementLineageAuthority(runId: string): void {
    const replacement = this.db.query(
      "SELECT 1 AS present FROM resolution_replacements WHERE replacement_run_id=? LIMIT 1",
    ).get(runId) as { present: number } | null;
    if (!replacement) return; // not a replacement run — ordinary authority path unchanged
    if (!this.resolutionLineageVerifier) {
      throw new ReplacementLineageUnverifiedError(runId, "SIGNING_AUTHORITY_UNAVAILABLE");
    }
    const verdict = this.resolutionLineageVerifier.verify(runId);
    if (!verdict.verified) throw new ReplacementLineageUnverifiedError(runId, verdict.reason);
  }

  /**
   * P8 publication-authority (v33) construction site. Binds the live database
   * carrying the v33 slice and the REAL companion-aware replacement-lineage
   * verifier (P7) so a P7_REPLACEMENT candidate is never publishable without
   * verified lineage. The caller supplies only the credentialed effect seams
   * (actuator/preflight/credentialProvider) — never the verifier, never the db.
   * When resolution signing is not configured, `lineageVerifier` is absent and
   * every P7_REPLACEMENT candidate fails closed (ordinary ORIGINAL candidates are
   * unaffected).
   */
  createPublicationAuthorityService(deps: Omit<PublicationAuthorityDeps, "lineageVerifier">): PublicationAuthorityService {
    return new PublicationAuthorityService(this.db, {
      ...deps,
      lineageVerifier: this.resolutionLineageVerifier,
    });
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
    // P10: repository-admission read, org-scoped (default org today) + owner-scoped.
    const row = this.db.query(`${REPOSITORY_ADMISSION_SELECT} WHERE a.owner_user_id = ? AND a.repository_id = ? AND a.org_id = ?`)
      .get(ownerUserId, repositoryId, this.tenantOrgId) as RepositoryAdmissionRow | null;
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
    // P10: repository-admission listing, org-scoped (default org today) + owner-scoped.
    return (this.db.query(`${REPOSITORY_ADMISSION_SELECT} WHERE a.owner_user_id = ? AND a.org_id = ? ORDER BY a.created_at, a.repository_id`)
      .all(ownerUserId, this.tenantOrgId) as RepositoryAdmissionRow[]).map(rowToRepositoryAdmission);
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

  /**
   * The single live SQLite connection this ledger writes on. Exposed ONLY so the
   * P7 Resolution Desk (and its server-side case-creation derivation + fenced
   * replacement factory) run on the SAME connection: their case/directive/apply
   * transactions and the executable-run inserts must be atomic with the ledger's
   * writes and see the freeze triggers in-transaction. Never a second connection
   * (cross-connection breaks the fence). Not for general callers.
   */
  resolutionDeskConnection(): Database {
    return this.db;
  }

  getRun(runId: string): EngineerRun {
    // P10: the ubiquitous run ownership guard, now org-scoped (default org today).
    const row = this.db.query(`${RUN_SELECT} WHERE r.id = ? AND r.org_id = ?`).get(runId, this.tenantOrgId) as RunRow | null;
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

  clearLastErrorIfExact(runId:string,expected:string,now:string):boolean{
    if(!expected)throw new TypeError("expected last error is required");
    const result=this.db.query("UPDATE engineer_runs SET last_error=NULL,updated_at=? WHERE id=? AND last_error=?")
      .run(now,runId,expected);
    return Number(result.changes)===1;
  }

  getBudget(runId: string, now: string): EngineerBudgetSnapshot {
    const usage = this.runtimeBudgetUsage(runId, new Date(now));
    const reservations = this.db.query(`SELECT COALESCE(SUM(estimated_cost_usd), 0) AS cost,
      COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens,
      COALESCE(SUM(CASE WHEN reservation_status = 'AMBIGUOUS_PROVIDER_OUTCOME' THEN estimated_cost_usd ELSE 0 END), 0) AS ambiguous_cost,
      COALESCE(SUM(CASE WHEN reservation_status = 'AMBIGUOUS_PROVIDER_OUTCOME' THEN input_tokens + output_tokens ELSE 0 END), 0) AS ambiguous_tokens
      FROM cost_records WHERE run_id = ? AND source_type = 'MODEL_RESERVATION'
        AND reservation_status IN ('ACTIVE', 'AMBIGUOUS_PROVIDER_OUTCOME')`).get(runId) as { cost: number; tokens: number; ambiguous_cost: number; ambiguous_tokens: number };
    const reservedCost = Number(reservations.cost);
    const reservedTokens = Number(reservations.tokens);
    const settledCost = Math.max(0, usage.estimatedCostUsd - reservedCost);
    const settledTokens = Math.max(0, usage.inputTokens + usage.outputTokens - reservedTokens);
    // Roll the active interval forward whenever the snapshot is materialized.
    // Without advancing active_since, adding the persisted total to the same
    // interval on the next read would count active time twice. A paused budget
    // has no active_since value, so human wait time remains frozen.
    this.db.query(`UPDATE run_budgets SET used_cost_usd = ?, used_tokens = ?, used_time_seconds = ?,
      reserved_cost_usd = ?, reserved_tokens = ?, ambiguous_cost_usd = ?, ambiguous_tokens = ?,
      active_since = CASE WHEN active_since IS NULL THEN NULL ELSE ? END,
      updated_at = ? WHERE run_id = ?`)
      .run(settledCost, settledTokens, Math.floor(usage.elapsedSeconds), reservedCost, reservedTokens,
        Number(reservations.ambiguous_cost), Number(reservations.ambiguous_tokens), now, now, runId);
    const row = this.db.query("SELECT * FROM run_budgets WHERE run_id = ?").get(runId) as BudgetRow | null;
    if (!row) throw new EngineerNotFoundError("run budget", runId);
    return this.budgetSnapshot(row);
  }

  topUpBudget(input: { runId: string; expectedRevision: number; topUp: BudgetTopUp; actorId: string; idempotencyKey: string; createdAt: string }): EngineerBudgetSnapshot {
    return this.atomic(() => {
      const replay = this.db.query("SELECT details_json FROM budget_events WHERE run_id = ? AND idempotency_key = ?")
        .get(input.runId, input.idempotencyKey) as { details_json: string } | null;
      if (replay) {
        if (sha256(JSON.parse(replay.details_json)) !== sha256(input.topUp)) {
          throw new Error("budget top-up idempotency key was reused with different allowance values");
        }
        return this.getBudget(input.runId, input.createdAt);
      }
      const row = this.db.query("SELECT * FROM run_budgets WHERE run_id = ?").get(input.runId) as BudgetRow | null;
      if (!row) throw new EngineerNotFoundError("run budget", input.runId);
      const run = this.db.query("SELECT state FROM engineer_runs WHERE id = ?").get(input.runId) as { state: RunState } | null;
      if (!run) throw new EngineerNotFoundError("run", input.runId);
      if (run.state !== "PAUSED_BUDGET" || row.status !== "PAUSED") {
        throw new Error("new budget top-ups are allowed only while the run is paused for budget review");
      }
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
    // P10: keeps the existing owner (user_id) scope AND adds org scope (default org today).
    const rows = before
      ? this.db.query(`${RUN_SELECT} WHERE r.user_id = ? AND r.org_id = ? AND (r.created_at < ? OR (r.created_at = ? AND r.id < ?)) ORDER BY r.created_at DESC, r.id DESC LIMIT ?`)
        .all(userId, this.tenantOrgId, before.createdAt, before.createdAt, before.runId, limit)
      : this.db.query(`${RUN_SELECT} WHERE r.user_id = ? AND r.org_id = ? ORDER BY r.created_at DESC, r.id DESC LIMIT ?`).all(userId, this.tenantOrgId, limit);
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
        SELECT id FROM engineer_runs ${ownerId === undefined ? "WHERE org_id = ?" : "WHERE org_id = ? AND user_id = ?"}
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
    // P10: org-scope the run projection (default org today), preserving the owner filter.
    const rows = (ownerId === undefined ? this.db.query(sql).all(this.tenantOrgId) : this.db.query(sql).all(this.tenantOrgId, ownerId)) as ProjectionRow[];
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
      ${ownerId === undefined ? "WHERE run.org_id = ?" : "WHERE run.org_id = ? AND run.user_id = ?"}
      GROUP BY failure.failure_class ORDER BY failure.failure_class`;
    const rows = (ownerId === undefined ? this.db.query(sql).all(this.tenantOrgId) : this.db.query(sql).all(this.tenantOrgId, ownerId)) as Array<{ failure_class: string; count: number }>;
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

  /**
   * Export a page of a run's records for attestation / byte-graph integrity.
   *
   * The v34 tenancy annotations (org_id, retention_class, connector/authority
   * actor identity) are STRIPPED here: they are operational tenancy metadata,
   * not part of a run's attested CONTENT. Leaving them in would make every
   * content-integrity hash (hardening semantic/evidence authority, verification
   * byte-graph, tamper detection) tenancy-dependent and would break attestations
   * computed before v34. Tenant isolation is enforced by the tenant-scoped DAL
   * on the query path, not by these content hashes.
   */
  exportRunRecordPage(runId: string, table: RunExportTable, offset: number, limit = 500): Array<Record<string, unknown>> {
    const rows = this.exportRunRecordPageRaw(runId, table, offset, limit);
    if (rows.length === 0) return rows;
    return rows.map((row) => {
      let stripped: Record<string, unknown> | undefined;
      for (const column of V34_ADDITIVE_COLUMN_NAMES) {
        if (column in row) {
          stripped ??= { ...row };
          delete stripped[column];
        }
      }
      return stripped ?? row;
    });
  }

  private exportRunRecordPageRaw(runId: string, table: RunExportTable, offset: number, limit = 500): Array<Record<string, unknown>> {
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
    if (table === "review_finding_classifications") {
      return this.db.query(`SELECT c.* FROM review_finding_classifications c
        JOIN reviewer_sessions s ON s.id = c.reviewer_session_id
        WHERE s.run_id = ? ORDER BY c.rowid LIMIT ? OFFSET ?`)
        .all(runId, limit, offset) as Array<Record<string, unknown>>;
    }
    if (table === "advisory_backlog_items" || table === "hardening_quotes" || table === "hardening_quote_requests" || table === "hardening_consents" || table === "advisory_backlog_events") {
      return this.db.query(`SELECT * FROM ${table} WHERE parent_run_id = ? ORDER BY rowid LIMIT ? OFFSET ?`)
        .all(runId, limit, offset) as Array<Record<string, unknown>>;
    }
    if (table === "hardening_quote_advisories") {
      return this.db.query(`SELECT m.* FROM hardening_quote_advisories m JOIN hardening_quotes q ON q.id=m.quote_id WHERE q.parent_run_id=? ORDER BY m.rowid LIMIT ? OFFSET ?`)
        .all(runId, limit, offset) as Array<Record<string, unknown>>;
    }
    if (table === "engineer_run_lineage") {
      return this.db.query(`SELECT * FROM engineer_run_lineage WHERE root_run_id=? OR parent_run_id=? OR child_run_id=? ORDER BY rowid LIMIT ? OFFSET ?`)
        .all(runId, runId, runId, limit, offset) as Array<Record<string, unknown>>;
    }
    if (table === "hardening_start_operations") {
      return this.db.query(`SELECT * FROM hardening_start_operations WHERE child_run_id=? ORDER BY rowid LIMIT ? OFFSET ?`)
        .all(runId, limit, offset) as Array<Record<string, unknown>>;
    }
    if (table === "hardening_seed_attestations") {
      return this.db.query(`SELECT * FROM hardening_seed_attestations WHERE parent_run_id=? OR child_run_id=? ORDER BY rowid LIMIT ? OFFSET ?`)
        .all(runId, runId, limit, offset) as Array<Record<string, unknown>>;
    }
    if (table === "hardening_start_claims") {
      return this.db.query(`SELECT * FROM hardening_start_claims WHERE root_run_id=? OR parent_run_id=? OR child_run_id=? ORDER BY rowid LIMIT ? OFFSET ?`)
        .all(runId, runId, runId, limit, offset) as Array<Record<string, unknown>>;
    }
    if (table === "hardening_model_call_slots") {
      return this.db.query(`SELECT * FROM hardening_model_call_slots WHERE child_run_id=? ORDER BY rowid LIMIT ? OFFSET ?`)
        .all(runId, limit, offset) as Array<Record<string, unknown>>;
    }
    if (table === "hardening_child_budget_authorities" || table === "hardening_child_model_reservations" ||
        table === "hardening_paid_call_finalizations" || table === "hardening_recovery_worker_fences" ||
        table === "hardening_child_tool_actions") {
      return this.db.query(`SELECT * FROM ${table} WHERE child_run_id=? ORDER BY rowid LIMIT ? OFFSET ?`)
        .all(runId, limit, offset) as Array<Record<string, unknown>>;
    }
    if (table === "publication_candidate_selections") {
      return this.db.query(`SELECT * FROM publication_candidate_selections WHERE root_run_id=? OR candidate_run_id=? ORDER BY rowid LIMIT ? OFFSET ?`)
        .all(runId, runId, limit, offset) as Array<Record<string, unknown>>;
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

  getRequiredLaneContract(runId: string, manifestHash?: string): RequiredLaneContract | null {
    const run = this.getRun(runId);
    const boundManifestHash = manifestHash ?? run.manifestHash;
    if (!boundManifestHash) return null;
    const row = this.db.query(`SELECT contract_hash, run_id, manifest_hash, schema_version, contract_json, created_at
      FROM required_lane_contracts WHERE run_id = ? AND manifest_hash = ?`)
      .get(runId, boundManifestHash) as {
        contract_hash: string; run_id: string; manifest_hash: string; schema_version: number;
        contract_json: string; created_at: string;
      } | null;
    if (!row) return null;
    const contract = RequiredLaneContractSchema.parse(JSON.parse(row.contract_json));
    if (contract.contractHash !== row.contract_hash || contract.runId !== row.run_id ||
        contract.runId !== runId || contract.manifestHash !== row.manifest_hash ||
        contract.manifestHash !== boundManifestHash || contract.schemaVersion !== row.schema_version ||
        contract.createdAt !== row.created_at) {
      throw new TypeError("Required Lane contract JSON does not match its relational binding");
    }
    return contract;
  }

  recordPlanProposal(proposal: PlanProposal, expectedStateVersion: number): PlanProposal {
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
    return this.atomic(() => {
      const existing = this.db.query("SELECT * FROM plan_proposals WHERE run_id = ? AND proposal_hash = ?")
        .get(proposal.runId, proposal.proposalHash) as Record<string, unknown> | null;
      if (existing) return this.planProposalFromRow(existing);
      const run = this.getRun(proposal.runId);
      if (run.stateVersion !== expectedStateVersion) {
        throw new StateVersionConflictError(run.runId, expectedStateVersion, run.stateVersion);
      }
      if (run.state !== "PLANNING" && run.state !== "REPLANNING") {
        throw new InvalidTransitionError("plan proposals may only be recorded while PLANNING or REPLANNING");
      }
      const context = this.db.query(`SELECT manifest_hash FROM context_manifests
        WHERE run_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(proposal.runId) as { manifest_hash: string } | null;
      if (!context || context.manifest_hash !== proposal.contextManifestHash) {
        throw new TypeError("plan proposal is not bound to the latest persisted context manifest");
      }
      this.db.query(`INSERT INTO plan_proposals (id, run_id, proposal_json, planning_analysis_json, proposal_hash, context_manifest_hash, artifact_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
          proposal.planProposalId, proposal.runId, canonicalJson(proposal.manifest),
          canonicalJson(proposal.planningAnalysis), proposal.proposalHash,
          proposal.contextManifestHash, proposal.artifactId, proposal.createdAt,
        );
      return proposal;
    });
  }

  latestPlanProposal(runId: string): PlanProposal | null {
    this.getRun(runId);
    const row = this.db.query("SELECT * FROM plan_proposals WHERE run_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get(runId) as Record<string, unknown> | null;
    return row ? this.planProposalFromRow(row) : null;
  }

  recordContextSnapshot(snapshot: StoredContextSnapshot, expectedStateVersion: number): StoredContextSnapshot {
    const parsed = StoredContextSnapshotSchema.parse(snapshot);
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
      const run = this.getRun(parsed.manifest.runId);
      if (run.stateVersion !== expectedStateVersion) {
        throw new StateVersionConflictError(run.runId, expectedStateVersion, run.stateVersion);
      }
      if (run.state !== "REQUEST_RECEIVED" && run.state !== "PLANNING") {
        throw new InvalidTransitionError("context may only be recorded before or during planning");
      }
      const concurrentExisting = this.db.query("SELECT manifest_hash FROM context_manifests WHERE run_id = ?")
        .get(parsed.manifest.runId) as { manifest_hash: string } | null;
      if (concurrentExisting) throw new IdempotencyConflictError(parsed.manifest.runId, "context-manifest-already-frozen");
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
      this.updateExecutionClockForTransition(
        command.runId,
        command.previousState,
        command.nextState,
        command.timestamp,
      );
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

  private updateExecutionClockForTransition(
    runId: string,
    previousState: RunState,
    nextState: RunState,
    timestamp: string,
  ): void {
    const previousMetered = !EXECUTION_CLOCK_WAIT_STATES.has(previousState);
    const nextMetered = !EXECUTION_CLOCK_WAIT_STATES.has(nextState);
    if (previousMetered === nextMetered) return;
    const row = this.db.query(`SELECT status, used_time_seconds, active_since
      FROM run_budgets WHERE run_id = ?`).get(runId) as {
        status: "ACTIVE" | "WARNING" | "PAUSED" | "EXHAUSTED";
        used_time_seconds: number;
        active_since: string | null;
      } | null;
    if (!row) return;
    if (previousMetered && !nextMetered) {
      const elapsed = row.active_since
        ? Math.max(0, Math.floor((Date.parse(timestamp) - Date.parse(row.active_since)) / 1_000))
        : 0;
      this.db.query(`UPDATE run_budgets SET used_time_seconds = ?, active_since = NULL, updated_at = ?
        WHERE run_id = ?`).run(Number(row.used_time_seconds) + elapsed, timestamp, runId);
      return;
    }
    if (!previousMetered && nextMetered && row.status !== "PAUSED" && row.status !== "EXHAUSTED") {
      this.db.query(`UPDATE run_budgets SET active_since = ?, updated_at = ? WHERE run_id = ?`)
        .run(timestamp, timestamp, runId);
    }
  }

  freezeManifest(
    command: LedgerTransitionCommand,
    manifest: TaskManifest,
    requiredLaneContract: RequiredLaneContract,
    requiredLaneAuthority: RequiredLaneContractAuthority,
  ): LedgerTransitionResult {
    const contract = assertRequiredLaneContractMatchesManifest(requiredLaneContract, manifest, requiredLaneAuthority);
    const transact = this.db.transaction(() => {
      const replay = this.findIdempotentEvent(command);
      if (replay) return { applied: false, event: replay, run: this.getRun(command.runId) };
      const run = this.getRun(command.runId);
      this.assertExpectedRun(run, command);
      const latestProposal = this.db.query(`SELECT proposal_hash, context_manifest_hash FROM plan_proposals
        WHERE run_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(command.runId) as {
          proposal_hash: string; context_manifest_hash: string | null;
        } | null;
      if ((latestProposal?.proposal_hash ?? null) !== requiredLaneAuthority.planningBinding.planProposalHash ||
          (latestProposal?.context_manifest_hash ?? null) !== requiredLaneAuthority.planningBinding.contextManifestHash) {
        throw new TypeError("Required Lane planning authority changed before freeze");
      }
      this.db
        .query(`INSERT INTO task_manifest_versions
                (id, run_id, version, manifest_hash, manifest_json, created_at)
                VALUES (?, ?, ?, ?, ?, ?)`)
        .run(randomUUID(), manifest.runId, manifest.manifestVersion, manifest.manifestHash,
          canonicalJson(manifest), manifest.createdAt);
      this.db.query(`INSERT INTO required_lane_contracts
        (contract_hash, run_id, manifest_hash, schema_version, contract_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(
          contract.contractHash,
          contract.runId,
          contract.manifestHash,
          contract.schemaVersion,
          canonicalJson(contract),
          contract.createdAt,
        );
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
      // The frozen manifest may tighten, but never raise, the user's selected
      // ceiling. Keeping this inside the freeze transaction ensures a rejected
      // contract, stale writer, or failed state promotion cannot mutate cost.
      const budget = this.db.query(`SELECT cost_limit_usd, token_limit, time_limit_seconds
        FROM run_budgets WHERE run_id = ?`).get(command.runId) as {
          cost_limit_usd: number; token_limit: number; time_limit_seconds: number;
        } | null;
      if (!budget) throw new EngineerNotFoundError("run budget", command.runId);
      const constrainedCost = Math.min(budget.cost_limit_usd, manifest.costBudgetUsd);
      const constrainedTokens = Math.min(budget.token_limit, manifest.tokenBudget);
      const constrainedTime = Math.min(budget.time_limit_seconds, manifest.timeBudgetSeconds);
      if (constrainedCost !== budget.cost_limit_usd || constrainedTokens !== budget.token_limit ||
          constrainedTime !== budget.time_limit_seconds) {
        const budgetUpdate = this.db.query(`UPDATE run_budgets
          SET cost_limit_usd = ?, token_limit = ?, time_limit_seconds = ?,
              revision = revision + 1, updated_at = ?
          WHERE run_id = ?`).run(
            constrainedCost, constrainedTokens, constrainedTime, command.timestamp, command.runId,
          );
        if (Number(budgetUpdate.changes) !== 1) throw new EngineerNotFoundError("run budget", command.runId);
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
        requiredLaneContractHash: contract.contractHash,
        eventId: event.eventId,
      }, command.timestamp);
      return { applied: true, event, run: this.getRun(command.runId) };
    });
    return transact();
  }

  recordRisk(assessment: RiskAssessment, expectedStateVersion: number, auditEventId?:string): void {
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
      }, assessment.assessedAt,auditEventId);
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
      progress_metric, allowed, reason_code, policy_version FROM retry_attempts WHERE run_id = ? ORDER BY created_at, rowid`)
      .all(runId) as Array<{
        kind: RetryKind;
        failure_fingerprint: string;
        patch_hash: string | null;
        progress_metric: number | null;
        allowed: number;
        reason_code: StoredRetryAttempt["reasonCode"];
        policy_version: string;
      }>;
    return rows.map((row) => ({
      kind: row.kind,
      failureFingerprint: row.failure_fingerprint,
      patchHash: row.patch_hash,
      progressMetric: row.progress_metric,
      allowed: row.allowed === 1,
      reasonCode: row.reason_code,
      policyVersion: row.policy_version,
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
    const existing = this.db.query("SELECT id, run_id, workspace_identity, image_digest FROM sandboxes WHERE id = ?")
      .get(parsed.sandboxId) as { id: string; run_id: string; workspace_identity: string; image_digest: string } | null;
    if (existing) {
      if (existing.run_id !== parsed.runId || existing.workspace_identity !== parsed.workspaceIdentity ||
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

  recordTestIntegrityAttestation(artifactId: string, comparisonInput: unknown, auditEventId?:string,
    readArtifact?:ArtifactByteReader): void {
    const comparison = TestIntegrityComparisonSchema.parse(comparisonInput);
    const row = this.db.query("SELECT * FROM artifacts WHERE id = ? AND run_id = ?")
      .get(artifactId, comparison.runId) as Record<string, unknown> | null;
    if (!row) throw new EngineerNotFoundError("test integrity artifact", artifactId);
    const artifact = this.artifactFromRow(row);
    if (artifact.type !== "TEST_INTEGRITY_COMPARISON" || !artifact.trusted || artifact.producerType !== "SYSTEM" ||
        artifact.producerId !== "engineer-supervisor-test-integrity") {
      throw new TypeError("test integrity attestation artifact authority is invalid");
    }
    const bytes = readArtifact?readArtifact(artifact):readFileSync(artifact.storageReference);
    if (bytes.byteLength !== artifact.sizeBytes || !matchesSha256Bytes(bytes, artifact.sha256) ||
        canonicalJson(JSON.parse(bytes.toString("utf8"))) !== canonicalJson(comparison)) {
      throw new TypeError("test integrity attestation artifact bytes are invalid");
    }
    const details = {
      artifactId, comparisonHash: comparison.comparisonHash, baselineHash: comparison.baselineHash,
      stage: comparison.stage, passed: comparison.passed,
    };
    const existing = this.db.query(`SELECT id, details_json FROM audit_events
      WHERE run_id = ? AND action = 'TEST_INTEGRITY_ATTESTED'
        AND json_extract(details_json, '$.artifactId') = ?`).get(comparison.runId, artifactId) as { id:string;details_json: string } | null;
    if (existing) {
      if ((auditEventId!==undefined&&existing.id!==auditEventId)||
          canonicalJson(JSON.parse(existing.details_json)) !== canonicalJson(details)) {
        throw new IdempotencyConflictError(comparison.runId, `test-integrity-attestation:${artifactId}`);
      }
      return;
    }
    this.insertAudit(comparison.runId, "TEST_INTEGRITY_ATTESTED", "SUPERVISOR", "engineer-supervisor-test-integrity",
      details, artifact.createdAt,auditEventId);
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
    if (parsed.status === "RUNNING" && (parsed.outputArtifactId !== null || parsed.completedAt !== null)) {
      throw new TypeError("RUNNING agent executions cannot have output or completion identity");
    }
    if (parsed.status === "SUCCEEDED" && (parsed.outputArtifactId === null || parsed.completedAt === null)) {
      throw new TypeError("SUCCEEDED agent executions require output and completion identity");
    }
    if ((parsed.status === "FAILED" || parsed.status === "PAUSED") && parsed.completedAt === null) {
      throw new TypeError("terminal agent executions require completion identity");
    }
    this.getRun(parsed.runId);
    const existing = this.db.query(`SELECT run_id, role, model_tier, status, input_hash,
      output_artifact_id, started_at, completed_at FROM agent_executions WHERE id = ?`)
      .get(parsed.agentExecutionId) as {
        run_id: string; role: string; model_tier: string; status: AgentExecutionRecord["status"];
        input_hash: string; output_artifact_id: string | null; started_at: string; completed_at: string | null;
      } | null;
    if (existing) {
      if (existing.run_id !== parsed.runId || existing.role !== parsed.role || existing.model_tier !== parsed.modelTier ||
          existing.input_hash !== parsed.inputHash || existing.started_at !== parsed.startedAt) {
        throw new IdempotencyConflictError(parsed.runId, `agent:${parsed.agentExecutionId}`);
      }
      const terminal = existing.status === "SUCCEEDED" || existing.status === "FAILED" || existing.status === "PAUSED";
      if ((terminal && parsed.status !== existing.status) ||
          (existing.output_artifact_id !== null && parsed.outputArtifactId !== existing.output_artifact_id) ||
          (existing.status === "SUCCEEDED" && (parsed.outputArtifactId === null || parsed.completedAt !== existing.completed_at)) ||
          (existing.status !== "RUNNING" && parsed.completedAt !== existing.completed_at)) {
        throw new IdempotencyConflictError(parsed.runId, `agent-status:${parsed.agentExecutionId}`);
      }
      if (existing.status === parsed.status && existing.output_artifact_id === parsed.outputArtifactId &&
          existing.completed_at === parsed.completedAt) return;
      this.db.query("UPDATE agent_executions SET status = ?, output_artifact_id = ?, completed_at = ? WHERE id = ?")
        .run(parsed.status, parsed.outputArtifactId, parsed.completedAt, parsed.agentExecutionId);
      return;
    }
    if (parsed.status !== "RUNNING") {
      throw new IdempotencyConflictError(parsed.runId, `agent-missing-running-origin:${parsed.agentExecutionId}`);
    }
    const hardeningStart=this.db.query(`SELECT 1 FROM engineer_run_lineage l JOIN hardening_start_operations o ON o.lineage_id=l.id AND o.lineage_hash=l.lineage_hash
      WHERE l.child_run_id=?`).get(parsed.runId);
    if(hardeningStart){
      if((parsed.role!=="BUILDER"&&parsed.role!=="REVIEWER")||
        (parsed.role==="BUILDER"&&parsed.modelTier!=="GPT-5.6_TERRA")||
        (parsed.role==="REVIEWER"&&parsed.modelTier!=="GPT-5.6_SOL"))throw new HardeningAuthorityInvalidError();
      const prior=this.db.query("SELECT COUNT(*) AS count FROM agent_executions WHERE run_id=? AND role=?")
        .get(parsed.runId,parsed.role) as {count:number};if(prior.count>=1)throw new BuilderModelCallLimitError(parsed.runId,1);}
    this.db.query(`INSERT INTO agent_executions
      (id, run_id, role, model_tier, status, input_hash, output_artifact_id, started_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      parsed.agentExecutionId, parsed.runId, parsed.role, parsed.modelTier, parsed.status,
      parsed.inputHash, parsed.outputArtifactId, parsed.startedAt, parsed.completedAt,
    );
  }

  claimBuilderDispatch(
    record: AgentExecutionRecord,
    worker: { ownerId: string; fencingToken: number } | null = null,
  ): { won: boolean; claim: BuilderDispatchClaim; execution: AgentExecutionRecord } {
    const parsed = AgentExecutionRecordSchema.parse(record);
    if (parsed.role !== "BUILDER" || parsed.status !== "RUNNING" || parsed.outputArtifactId !== null || parsed.completedAt !== null) {
      throw new TypeError("Builder dispatch claims require a fresh RUNNING Builder execution");
    }
    const transact = this.db.transaction(() => {
      this.getRun(parsed.runId);
      const existing = this.builderDispatchClaim(parsed.runId, parsed.inputHash);
      if (existing) {
        const execution = this.builderRepairExecutions(parsed.runId, parsed.inputHash)
          .find((candidate) => candidate.agentExecutionId === existing.agentExecutionId);
        if (!execution || execution.modelTier !== existing.modelTier) {
          throw new IdempotencyConflictError(parsed.runId, `builder-dispatch-claim:${parsed.inputHash}`);
        }
        return { won: false, claim: existing, execution };
      }
      this.recordAgentExecution(parsed);
      const claim = BuilderDispatchClaimSchema.parse({
        runId: parsed.runId, inputHash: parsed.inputHash, agentExecutionId: parsed.agentExecutionId,
        modelTier: parsed.modelTier, workerOwnerId: worker?.ownerId ?? null,
        workerFencingToken: worker?.fencingToken ?? null, claimedAt: parsed.startedAt,
      });
      this.db.query(`INSERT INTO builder_dispatch_claims
        (run_id, input_hash, agent_execution_id, model_tier, worker_owner_id, worker_fencing_token, claimed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        claim.runId, claim.inputHash, claim.agentExecutionId, claim.modelTier,
        claim.workerOwnerId, claim.workerFencingToken, claim.claimedAt,
      );
      return { won: true, claim, execution: parsed };
    });
    return transact.immediate();
  }

  builderDispatchClaim(runId: string, inputHash: string): BuilderDispatchClaim | null {
    this.getRun(runId);
    const row = this.db.query(`SELECT run_id, input_hash, agent_execution_id, model_tier,
      worker_owner_id, worker_fencing_token, claimed_at
      FROM builder_dispatch_claims WHERE run_id = ? AND input_hash = ?`).get(runId, inputHash) as Record<string, unknown> | null;
    return row ? BuilderDispatchClaimSchema.parse({
      runId: row.run_id, inputHash: row.input_hash, agentExecutionId: row.agent_execution_id,
      modelTier: row.model_tier, workerOwnerId: row.worker_owner_id,
      workerFencingToken: row.worker_fencing_token, claimedAt: row.claimed_at,
    }) : null;
  }

  builderRepairExecutions(runId: string, inputHash: string): AgentExecutionRecord[] {
    this.getRun(runId);
    const rows = this.db.query(`SELECT id, run_id, role, model_tier, status, input_hash,
      output_artifact_id, started_at, completed_at
      FROM agent_executions
      WHERE run_id = ? AND role = 'BUILDER' AND input_hash = ?
      ORDER BY rowid`).all(runId, inputHash) as Array<Record<string, unknown>>;
    return rows.map((row) => AgentExecutionRecordSchema.parse({
      agentExecutionId: row.id,
      runId: row.run_id,
      role: row.role,
      modelTier: row.model_tier,
      status: row.status,
      inputHash: row.input_hash,
      outputArtifactId: row.output_artifact_id,
      startedAt: row.started_at,
      completedAt: row.completed_at,
    }));
  }

  /**
   * Proves the exact durable Builder successor for a recovered paid call.
   * Metadata alone is not authority: the artifact must still be a regular
   * file whose bytes, schema, run/manifest/diff/completion binding, provider
   * response identity, and single state transition all agree.
   */
  hasExactHardeningBuilderSuccessor(input:{
    childRunId:string;reservationId:string;agentExecutionId:string;
    expectedRunState:string;expectedStateVersion:number;
  },readArtifact?:ArtifactByteReader):boolean{
    try{
      const run=this.getRun(input.childRunId);if(!run.manifestHash)return false;
      const agentRow=this.db.query(`SELECT id,run_id,role,model_tier,status,input_hash,output_artifact_id,started_at,completed_at
        FROM agent_executions WHERE id=? AND run_id=?`).get(input.agentExecutionId,input.childRunId) as Record<string,unknown>|null;
      if(!agentRow)return false;
      const agent=AgentExecutionRecordSchema.parse({agentExecutionId:agentRow.id,runId:agentRow.run_id,role:agentRow.role,
        modelTier:agentRow.model_tier,status:agentRow.status,inputHash:agentRow.input_hash,
        outputArtifactId:agentRow.output_artifact_id,startedAt:agentRow.started_at,completedAt:agentRow.completed_at});
      if(agent.role!=="BUILDER"||agent.modelTier!=="GPT-5.6_TERRA"||agent.status!=="SUCCEEDED"||
          !agent.outputArtifactId||!agent.completedAt)return false;
      const artifactRow=this.db.query("SELECT * FROM artifacts WHERE id=? AND run_id=?")
        .get(agent.outputArtifactId,input.childRunId) as Record<string,unknown>|null;
      if(!artifactRow)return false;const artifact=this.artifactFromRow(artifactRow);
      if(artifact.type!=="BUILDER_RESULT"||artifact.producerType!=="SYSTEM"||artifact.producerId!=="codex-builder-adapter"||
          artifact.trusted||artifact.sizeBytes<=0||(!readArtifact&&!existsSync(artifact.storageReference)))return false;
      if(!readArtifact){const stat=lstatSync(artifact.storageReference);if(!stat.isFile()||stat.isSymbolicLink())return false;}
      const bytes=readArtifact?readArtifact(artifact):readFileSync(artifact.storageReference);
      if(bytes.byteLength!==artifact.sizeBytes||!matchesSha256Bytes(bytes,artifact.sha256))return false;
      const result=BuilderResultSchema.parse(JSON.parse(bytes.toString("utf8")));
      const reservationRow=this.db.query(`SELECT * FROM hardening_child_model_reservations
        WHERE id=? AND child_run_id=? AND agent_execution_id=? AND role='BUILDER'`)
        .get(input.reservationId,input.childRunId,input.agentExecutionId) as Record<string,unknown>|null;
      if(!reservationRow)return false;
      const reservation=this.hardeningBudgetReservationFromRow(reservationRow,true,readArtifact);
      const reconciliation=this.hardeningBudgetReconciliationFromRow(reservationRow,reservation,readArtifact);
      const modelCallId=typeof reservationRow.model_call_id==="string"?reservationRow.model_call_id:null;
      const providerResponseId=typeof reservationRow.provider_response_id==="string"?reservationRow.provider_response_id:null;
      const providerResponseArtifactId=typeof reservationRow.provider_response_artifact_id==="string"
        ?reservationRow.provider_response_artifact_id:null;
      if(!providerResponseId||!providerResponseArtifactId||!modelCallId||
          reservationRow.status!=="SETTLED"||reservationRow.dispatch_status!=="SETTLED"||
          reconciliation?.status!=="SETTLED"||reservation.modelTier!=="GPT-5.6_TERRA"||
          result.runId!==input.childRunId||result.manifestHash!==run.manifestHash||result.model!==reservation.resolvedModel||
          result.diffHash!==sha256(result.diff)||result.completedAt!==agent.completedAt||artifact.createdAt!==agent.completedAt||
          result.responseIds.length!==1||result.responseIds[0]!==providerResponseId)return false;
      const routeRow=this.db.query("SELECT * FROM model_routing_decisions WHERE id=?")
        .get(reservation.routingDecisionId) as Record<string,unknown>|null;
      if(!routeRow)return false;
      const route=ModelRoutingDecisionSchema.parse({routingDecisionId:routeRow.id,runId:routeRow.run_id,
        agentExecutionId:routeRow.agent_execution_id,agentRole:routeRow.agent_role,logicalTier:routeRow.logical_tier,
        resolvedModel:routeRow.resolved_model,routingPolicyVersion:routeRow.routing_policy_version,
        fallbackUsed:Number(routeRow.fallback_used)===1,fallbackReason:routeRow.fallback_reason,
        cacheKey:routeRow.cache_key,timestamp:routeRow.timestamp});
      const routeCount=this.db.query(`SELECT COUNT(*) AS count FROM model_routing_decisions
        WHERE run_id=? AND agent_execution_id=?`).get(input.childRunId,input.agentExecutionId) as {count:number};
      if(routeCount.count!==1||route.routingDecisionId!==reservation.routingDecisionId||route.runId!==input.childRunId||
          route.agentExecutionId!==input.agentExecutionId||route.agentRole!=="BUILDER"||
          route.logicalTier!=="GPT-5.6_TERRA"||route.resolvedModel!==reservation.resolvedModel||
          route.routingPolicyVersion!=="engineer-model-routing-v2"||route.fallbackUsed||route.fallbackReason!==null||
          route.cacheKey!==null||Date.parse(route.timestamp)<Date.parse(agent.startedAt)||
          Date.parse(route.timestamp)>Date.parse(agent.completedAt))return false;
      const dispatchClaim=this.builderDispatchClaim(input.childRunId,agent.inputHash);
      if(!dispatchClaim||dispatchClaim.runId!==input.childRunId||dispatchClaim.inputHash!==agent.inputHash||
          dispatchClaim.agentExecutionId!==input.agentExecutionId||dispatchClaim.modelTier!=="GPT-5.6_TERRA"||
          dispatchClaim.claimedAt!==agent.startedAt)return false;
      const modelCallRow=this.db.query(`SELECT * FROM model_calls
        WHERE id=? AND run_id=? AND agent_execution_id=? AND budget_reservation_id=?`)
        .get(modelCallId,input.childRunId,input.agentExecutionId,input.reservationId) as Record<string,unknown>|null;
      if(!modelCallRow)return false;
      const modelCall=this.hardeningModelCallFromRow(modelCallRow);
      const modelCallCount=this.db.query(`SELECT COUNT(*) AS count FROM model_calls
        WHERE run_id=? AND agent_execution_id=?`).get(input.childRunId,input.agentExecutionId) as {count:number};
      // Builder ref[1] is a correlation hash over the exact provider input.
      // The durable requestHash is the authoritative full-request binding;
      // no inference of provider input bytes is made from the dispatch hash.
      const providerInputHash=modelCall.inputContextRefs[1];
      const expectedContextRefs=[run.manifestHash,providerInputHash,reservation.requestHash,reservation.clientRequestId,providerResponseId];
      if(modelCallCount.count!==1||modelCall.modelCallId!==modelCallId||modelCall.status!=="SUCCEEDED"||
          modelCall.logicalTier!=="GPT-5.6_TERRA"||modelCall.resolvedModel!==reservation.resolvedModel||
          modelCall.promptTemplateVersion!=="engineer-codex-builder-v3"||modelCall.outputSchemaVersion!==null||
          modelCall.cacheKey!==reservation.promptCacheKeyHash||modelCall.retryCount!==0||
          !/^sha256:[a-f0-9]{64}$/.test(providerInputHash??"")||
          canonicalJson(modelCall.inputContextRefs)!==canonicalJson(expectedContextRefs)||
          String(modelCallRow.input_context_refs_json)!==canonicalJson(expectedContextRefs)||
          modelCall.inputTokens!==reconciliation.actualInputTokens||modelCall.outputTokens!==reconciliation.actualOutputTokens||
          modelCall.cachedInputTokens!==reconciliation.actualCachedInputTokens||
          modelCall.cacheWriteInputTokens!==reconciliation.actualCacheWriteInputTokens||
          modelCall.inputTokens===null||modelCall.outputTokens===null||modelCall.cachedInputTokens===null||
          modelCall.cacheWriteInputTokens===null||modelCall.cacheHit!==(modelCall.cachedInputTokens>0))return false;
      const providerArtifactRow=this.db.query("SELECT * FROM artifacts WHERE id=? AND run_id=?")
        .get(providerResponseArtifactId,input.childRunId) as Record<string,unknown>|null;
      if(!providerArtifactRow)return false;
      const providerArtifact=this.artifactFromRow(providerArtifactRow);
      if(providerArtifact.type!=="MODEL_PROVIDER_RESPONSE"||providerArtifact.producerType!=="SYSTEM"||
          providerArtifact.producerId!=="engineer-provider-response-recorder"||!providerArtifact.trusted||
          providerArtifact.sizeBytes<=0||(!readArtifact&&!existsSync(providerArtifact.storageReference)))return false;
      if(!readArtifact){const providerStat=lstatSync(providerArtifact.storageReference);
        if(!providerStat.isFile()||providerStat.isSymbolicLink())return false;}
      const providerBytes=readArtifact?readArtifact(providerArtifact):readFileSync(providerArtifact.storageReference);
      if(providerBytes.byteLength!==providerArtifact.sizeBytes||
          !matchesSha256Bytes(providerBytes,providerArtifact.sha256))return false;
      const providerResponse=JSON.parse(providerBytes.toString("utf8")) as {id?:unknown;usage?:{
        input_tokens?:unknown;output_tokens?:unknown;input_tokens_details?:{
          cached_tokens?:unknown;cache_write_tokens?:unknown}}};
      if(providerResponse.id!==providerResponseId||
          providerResponse.usage?.input_tokens!==modelCall.inputTokens||
          providerResponse.usage?.output_tokens!==modelCall.outputTokens||
          (providerResponse.usage?.input_tokens_details?.cached_tokens??null)!==modelCall.cachedInputTokens||
          (providerResponse.usage?.input_tokens_details?.cache_write_tokens??null)!==modelCall.cacheWriteInputTokens)return false;
      const events=(this.db.query(`SELECT * FROM run_state_events WHERE run_id=? AND previous_state=? AND next_state='FAST_CHECKS'
        AND reason_code='BUILDER_IMPLEMENTATION_FINISHED' AND state_version=? ORDER BY sequence`).all(
          input.childRunId,input.expectedRunState,input.expectedStateVersion+1) as EventRow[]).map(rowToEvent);
      return events.length===1&&events[0]!.actorType==="SUPERVISOR"&&events[0]!.actorId==="engineer-supervisor"&&
        events[0]!.manifestHash===run.manifestHash&&events[0]!.evidenceIds.includes(artifact.artifactId);
    }catch{return false;}
  }

  /** Byte- and classification-bound Reviewer successor proof for recovery. */
  hasExactHardeningReviewerSuccessor(input:{
    childRunId:string;reservationId:string;agentExecutionId:string;
  },readArtifact?:ArtifactByteReader):boolean{
    try{
      const run=this.getRun(input.childRunId);if(!run.manifestHash)return false;
      const reservationRow=this.db.query(`SELECT *
        FROM hardening_child_model_reservations
        WHERE id=? AND child_run_id=? AND agent_execution_id=? AND role='REVIEWER'`)
        .get(input.reservationId,input.childRunId,input.agentExecutionId) as Record<string,unknown>|null;
      if(!reservationRow)return false;
      const reservation=this.hardeningBudgetReservationFromRow(reservationRow,true,readArtifact);
      const reconciliation=this.hardeningBudgetReconciliationFromRow(reservationRow,reservation,readArtifact);
      const modelCallId=typeof reservationRow.model_call_id==="string"?reservationRow.model_call_id:null;
      const providerResponseId=typeof reservationRow.provider_response_id==="string"?reservationRow.provider_response_id:null;
      const providerResponseArtifactId=typeof reservationRow.provider_response_artifact_id==="string"
        ?reservationRow.provider_response_artifact_id:null;
      if(!modelCallId||!providerResponseId||!providerResponseArtifactId||reservationRow.status!=="SETTLED"||
          reservationRow.dispatch_status!=="SETTLED"||reconciliation?.status!=="SETTLED"||
          reservation.modelTier!=="GPT-5.6_SOL")return false;
      const agentRow=this.db.query(`SELECT id,run_id,role,model_tier,status,input_hash,output_artifact_id,started_at,completed_at
        FROM agent_executions WHERE id=? AND run_id=?`).get(input.agentExecutionId,input.childRunId) as Record<string,unknown>|null;
      if(!agentRow)return false;
      const agent=AgentExecutionRecordSchema.parse({agentExecutionId:agentRow.id,runId:agentRow.run_id,role:agentRow.role,
        modelTier:agentRow.model_tier,status:agentRow.status,inputHash:agentRow.input_hash,
        outputArtifactId:agentRow.output_artifact_id,startedAt:agentRow.started_at,completedAt:agentRow.completed_at});
      if(agent.role!=="REVIEWER"||agent.modelTier!=="GPT-5.6_SOL"||agent.status!=="SUCCEEDED"||
          !agent.outputArtifactId||!agent.completedAt)return false;
      const artifactRow=this.db.query("SELECT * FROM artifacts WHERE id=? AND run_id=?")
        .get(agent.outputArtifactId,input.childRunId) as Record<string,unknown>|null;
      if(!artifactRow)return false;const artifact=this.artifactFromRow(artifactRow);
      if(artifact.type!=="REVIEWER_OUTPUT"||artifact.producerType!=="SYSTEM"||artifact.producerId!==agent.agentExecutionId||
          artifact.trusted||artifact.sizeBytes<=0||(!readArtifact&&!existsSync(artifact.storageReference)))return false;
      if(!readArtifact){const stat=lstatSync(artifact.storageReference);if(!stat.isFile()||stat.isSymbolicLink())return false;}
      const bytes=readArtifact?readArtifact(artifact):readFileSync(artifact.storageReference);
      if(bytes.byteLength!==artifact.sizeBytes||!matchesSha256Bytes(bytes,artifact.sha256))return false;
      const output=ReviewerOutputSchema.parse(JSON.parse(bytes.toString("utf8")));
      const authority=this.latestClassifiedReview(input.childRunId,readArtifact);if(!authority)return false;
      const rawArtifactRow=this.db.query("SELECT * FROM artifacts WHERE id=? AND run_id=?")
        .get(authority.classification.rawOutput.artifactId,input.childRunId) as Record<string,unknown>|null;
      if(!rawArtifactRow)return false;
      const rawArtifact=this.artifactFromRow(rawArtifactRow);
      if(rawArtifact.type!=="REVIEWER_RAW_OUTPUT"||rawArtifact.producerType!=="SYSTEM"||
          rawArtifact.producerId!==authority.session.reviewerSessionId||!rawArtifact.trusted||
          rawArtifact.sha256!==authority.classification.rawOutput.sha256||
          rawArtifact.sizeBytes!==authority.classification.rawOutput.byteLength||
          (!readArtifact&&!existsSync(rawArtifact.storageReference)))return false;
      if(!readArtifact){const rawStat=lstatSync(rawArtifact.storageReference);if(!rawStat.isFile()||rawStat.isSymbolicLink())return false;}
      const rawBytes=readArtifact?readArtifact(rawArtifact):readFileSync(rawArtifact.storageReference);
      if(rawBytes.byteLength!==rawArtifact.sizeBytes||!matchesSha256Bytes(rawBytes,rawArtifact.sha256))return false;
      const rawOutput=ReviewerOutputSchema.parse(JSON.parse(rawBytes.toString("utf8")));
      const routeRow=this.db.query("SELECT * FROM model_routing_decisions WHERE id=?")
        .get(reservation.routingDecisionId) as Record<string,unknown>|null;
      if(!routeRow)return false;
      const route=ModelRoutingDecisionSchema.parse({routingDecisionId:routeRow.id,runId:routeRow.run_id,
        agentExecutionId:routeRow.agent_execution_id,agentRole:routeRow.agent_role,logicalTier:routeRow.logical_tier,
        resolvedModel:routeRow.resolved_model,routingPolicyVersion:routeRow.routing_policy_version,
        fallbackUsed:Number(routeRow.fallback_used)===1,fallbackReason:routeRow.fallback_reason,
        cacheKey:routeRow.cache_key,timestamp:routeRow.timestamp});
      const routeCount=this.db.query(`SELECT COUNT(*) AS count FROM model_routing_decisions
        WHERE run_id=? AND agent_execution_id=?`).get(input.childRunId,input.agentExecutionId) as {count:number};
      if(routeCount.count!==1||route.routingDecisionId!==reservation.routingDecisionId||route.runId!==input.childRunId||
          route.agentExecutionId!==input.agentExecutionId||route.agentRole!=="REVIEWER"||
          route.logicalTier!=="GPT-5.6_SOL"||route.resolvedModel!==reservation.resolvedModel||
          route.routingPolicyVersion!=="engineer-model-routing-v2"||route.fallbackUsed||route.fallbackReason!==null||
          route.cacheKey!==null||route.timestamp!==agent.startedAt)return false;
      const modelCallRow=this.db.query(`SELECT * FROM model_calls
        WHERE id=? AND run_id=? AND agent_execution_id=? AND budget_reservation_id=?`)
        .get(modelCallId,input.childRunId,input.agentExecutionId,input.reservationId) as Record<string,unknown>|null;
      if(!modelCallRow)return false;
      const modelCall=this.hardeningModelCallFromRow(modelCallRow);
      const modelCallCount=this.db.query("SELECT COUNT(*) AS count FROM model_calls WHERE run_id=? AND agent_execution_id=?")
        .get(input.childRunId,input.agentExecutionId) as {count:number};
      const providerInputHash=modelCall.inputContextRefs[1];
      const expectedProviderInputHash=sha256({diffHash:authority.reviewerInput.diffHash,
        evidenceBundleHash:authority.reviewerInput.evidenceBundleHash});
      const expectedContextRefs=[run.manifestHash,providerInputHash,reservation.requestHash,reservation.clientRequestId,providerResponseId];
      if(modelCallCount.count!==1||modelCall.modelCallId!==modelCallId||modelCall.status!=="SUCCEEDED"||
          modelCall.logicalTier!=="GPT-5.6_SOL"||modelCall.resolvedModel!==reservation.resolvedModel||
          modelCall.promptTemplateVersion!=="engineer-isolated-reviewer-v6"||modelCall.outputSchemaVersion!=="reviewer-output-v1"||
          modelCall.cacheKey!==reservation.promptCacheKeyHash||modelCall.retryCount!==0||
          providerInputHash!==expectedProviderInputHash||
          canonicalJson(modelCall.inputContextRefs)!==canonicalJson(expectedContextRefs)||
          String(modelCallRow.input_context_refs_json)!==canonicalJson(expectedContextRefs)||
          modelCall.inputTokens!==reconciliation.actualInputTokens||modelCall.outputTokens!==reconciliation.actualOutputTokens||
          modelCall.cachedInputTokens!==reconciliation.actualCachedInputTokens||
          modelCall.cacheWriteInputTokens!==reconciliation.actualCacheWriteInputTokens||
          modelCall.inputTokens===null||modelCall.outputTokens===null||modelCall.cachedInputTokens===null||
          modelCall.cacheWriteInputTokens===null||modelCall.cacheHit!==(modelCall.cachedInputTokens>0))return false;
      const providerArtifactRow=this.db.query("SELECT * FROM artifacts WHERE id=? AND run_id=?")
        .get(providerResponseArtifactId,input.childRunId) as Record<string,unknown>|null;
      if(!providerArtifactRow)return false;
      const providerArtifact=this.artifactFromRow(providerArtifactRow);
      if(providerArtifact.type!=="MODEL_PROVIDER_RESPONSE"||providerArtifact.producerType!=="SYSTEM"||
          providerArtifact.producerId!=="engineer-provider-response-recorder"||!providerArtifact.trusted||
          (!readArtifact&&!existsSync(providerArtifact.storageReference)))return false;
      if(!readArtifact){const providerStat=lstatSync(providerArtifact.storageReference);
        if(!providerStat.isFile()||providerStat.isSymbolicLink())return false;}
      const providerBytes=readArtifact?readArtifact(providerArtifact):readFileSync(providerArtifact.storageReference);
      if(providerBytes.byteLength!==providerArtifact.sizeBytes||
          !matchesSha256Bytes(providerBytes,providerArtifact.sha256))return false;
      const providerResponse=JSON.parse(providerBytes.toString("utf8")) as {id?:unknown;usage?:{
        input_tokens?:unknown;output_tokens?:unknown;input_tokens_details?:{
          cached_tokens?:unknown;cache_write_tokens?:unknown}};output?:unknown};
      const responseCalls=Array.isArray(providerResponse.output)?providerResponse.output.filter((item)=>
        typeof item==="object"&&item!==null&&(item as {type?:unknown}).type==="function_call"&&
        (item as {name?:unknown}).name==="submit_review") as Array<{arguments?:unknown}>:[];
      if(providerResponse.id!==providerResponseId||responseCalls.length!==1||
          responseCalls[0]!.arguments!==rawBytes.toString("utf8")||
          providerResponse.usage?.input_tokens!==modelCall.inputTokens||
          providerResponse.usage?.output_tokens!==modelCall.outputTokens||
          (providerResponse.usage?.input_tokens_details?.cached_tokens??null)!==modelCall.cachedInputTokens||
          (providerResponse.usage?.input_tokens_details?.cache_write_tokens??null)!==modelCall.cacheWriteInputTokens)return false;
      return authority.classification.runId===input.childRunId&&authority.classification.manifestHash===run.manifestHash&&
        authority.session.inputHash===agent.inputHash&&authority.session.modelTier==="GPT-5.6_SOL"&&
        reservation.resolvedModel===authority.session.resolvedModel&&modelCall.resolvedModel===authority.session.resolvedModel&&
        modelCall.promptTemplateVersion===authority.session.policyVersion&&
        canonicalJson(output)===canonicalJson(authority.session.output)&&
        canonicalJson(bindReviewerEvidence(authority.reviewerInput,rawOutput))===canonicalJson(authority.session.output);
    }catch{return false;}
  }

  /** Exact deterministic failure successor used only by fenced crash recovery. */
  hasExactHardeningRecoveryTerminalSuccessor(input:{
    childRunId:string;reservationId:string;agentExecutionId:string;role:"BUILDER"|"REVIEWER";
    expectedRunState:string;expectedStateVersion:number;
  },readArtifact?:ArtifactByteReader):boolean{
    try{
      const run=this.getRun(input.childRunId);
      if(run.state!=="CANCELLATION_PENDING"&&!TERMINAL_STATES.some((state)=>state===run.state))return false;
      const agent=this.db.query("SELECT role,model_tier,status,completed_at FROM agent_executions WHERE id=? AND run_id=?")
        .get(input.agentExecutionId,input.childRunId) as
        {role:string;model_tier:string;status:string;completed_at:string|null}|null;
      if(!agent||agent.role!==input.role||!agent.completed_at||
          (agent.status!=="FAILED"&&agent.status!=="SUCCEEDED")||
          agent.model_tier!==(input.role==="BUILDER"?"GPT-5.6_TERRA":"GPT-5.6_SOL"))return false;
      if(agent.status==="SUCCEEDED"){
        const falselySuccessful=input.role==="BUILDER"
          ?!this.hasExactHardeningBuilderSuccessor({childRunId:input.childRunId,reservationId:input.reservationId,
            agentExecutionId:input.agentExecutionId,expectedRunState:input.expectedRunState,
            expectedStateVersion:input.expectedStateVersion},readArtifact)
          :!this.hasExactHardeningReviewerSuccessor({childRunId:input.childRunId,reservationId:input.reservationId,
            agentExecutionId:input.agentExecutionId},readArtifact);
        if(!falselySuccessful)return false;
      }
      const auditRows=this.db.query(`SELECT details_json FROM audit_events
        WHERE run_id=? AND action='ORPHAN_AGENT_EXECUTIONS_FINALIZED' ORDER BY created_at,id`)
        .all(input.childRunId) as Array<{details_json:string}>;
      const exactAudit=auditRows.some((row)=>{
        try{const details=JSON.parse(row.details_json) as {status?:unknown;reason?:unknown};
          return details.status==="FAILED"&&details.reason==="HARDENING_PAID_CALL_RECOVERY_TERMINAL";
        }catch{return false;}
      });
      const budget=this.db.query("SELECT status FROM hardening_child_budget_authorities WHERE child_run_id=?")
        .get(input.childRunId) as {status:string}|null;
      // RUNNING executions produce the orphan-finalization audit. A corrupt
      // already-SUCCEEDED execution is instead proven by the failed exact
      // successor check above and the terminal run/budget authorities.
      return (agent.status==="SUCCEEDED"||exactAudit)&&budget?.status==="STOPPED";
    }catch{return false;}
  }

  finalizeRunningAgentExecutions(
    runId: string,
    status: "PAUSED" | "FAILED",
    completedAt: string,
    reason: string,
  ): number {
    this.getRun(runId);
    const changed = this.db.query(`UPDATE agent_executions
      SET status = ?, completed_at = ?
      WHERE run_id = ? AND status = 'RUNNING'`).run(status, completedAt, runId).changes;
    if (changed > 0) {
      this.insertAudit(runId, "ORPHAN_AGENT_EXECUTIONS_FINALIZED", "SYSTEM", "engineer-recovery", {
        status,
        reason,
        count: changed,
      }, completedAt);
    }
    return changed;
  }

  recordModelCall(record: ModelCallRecord, budgetReservationId?: string): void {
    const parsed = ModelCallRecordSchema.parse(record);
    this.getRun(parsed.runId);
    const agent = this.db.query("SELECT run_id, role, model_tier FROM agent_executions WHERE id = ?")
      .get(parsed.agentExecutionId) as { run_id: string; role: string; model_tier: string } | null;
    if (!agent || agent.run_id !== parsed.runId) {
      throw new TypeError("model call agent execution does not belong to the run");
    }
    if(this.db.query(`SELECT 1 FROM engineer_run_lineage l JOIN hardening_start_operations o ON o.lineage_id=l.id AND o.lineage_hash=l.lineage_hash
      WHERE l.child_run_id=?`).get(parsed.runId)){
      if((agent.role!=="BUILDER"&&agent.role!=="REVIEWER")||(agent.role==="BUILDER"&&agent.model_tier!=="GPT-5.6_TERRA")||
        (agent.role==="REVIEWER"&&agent.model_tier!=="GPT-5.6_SOL"))throw new HardeningAuthorityInvalidError();
      if(!budgetReservationId)throw new HardeningAuthorityInvalidError();
      const reservationRow=this.db.query("SELECT * FROM hardening_child_model_reservations WHERE id=? AND child_run_id=?")
        .get(budgetReservationId,parsed.runId) as Record<string,unknown>|null;
      if(!reservationRow||reservationRow.status!=="RESERVED")throw new HardeningAuthorityInvalidError();
      const reservation=this.hardeningBudgetReservationFromRow(reservationRow);
      const expectedPromptVersion=reservation.role==="BUILDER"?"engineer-codex-builder-v3":"engineer-isolated-reviewer-v6";
      if(reservation.agentExecutionId!==parsed.agentExecutionId||reservation.modelTier!==parsed.logicalTier||
        reservation.resolvedModel!==parsed.resolvedModel||reservation.promptCacheKeyHash!==parsed.cacheKey||
        parsed.promptTemplateVersion!==expectedPromptVersion)throw new HardeningAuthorityInvalidError();
      const prior=this.db.query("SELECT COUNT(*) AS count FROM model_calls m JOIN agent_executions a ON a.id=m.agent_execution_id WHERE m.run_id=? AND a.role=?")
        .get(parsed.runId,agent.role) as {count:number};if(prior.count>=1)throw new BuilderModelCallLimitError(parsed.runId,1);}
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

  getAgentExecution(agentExecutionId:string):AgentExecutionRecord|null{
    const row=this.db.query("SELECT * FROM agent_executions WHERE id=?").get(agentExecutionId) as Record<string,unknown>|null;
    return row?AgentExecutionRecordSchema.parse({agentExecutionId:row.id,runId:row.run_id,role:row.role,modelTier:row.model_tier,
      status:row.status,inputHash:row.input_hash,outputArtifactId:row.output_artifact_id,startedAt:row.started_at,completedAt:row.completed_at}):null;
  }

  modelCallCountForRole(runId: string, role: string): number {
    this.getRun(runId);
    const recorded = this.db.query(`SELECT COUNT(*) AS count
      FROM model_calls call
      JOIN agent_executions agent ON agent.id = call.agent_execution_id
      WHERE call.run_id = ? AND agent.run_id = call.run_id AND agent.role = ?`)
      .get(runId, role) as { count: number };
    const orphanedReservations = this.db.query(`SELECT COUNT(*) AS count
      FROM cost_records reservation
      JOIN agent_executions agent ON agent.id = reservation.agent_execution_id
      WHERE reservation.run_id = ? AND agent.run_id = reservation.run_id AND agent.role = ?
        AND reservation.source_type = 'MODEL_RESERVATION'
        AND NOT EXISTS (
          SELECT 1 FROM model_calls call
          WHERE call.run_id = reservation.run_id AND call.budget_reservation_id = reservation.id
        )`)
      .get(runId, role) as { count: number };
    return Number(recorded.count) + Number(orphanedReservations.count);
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

  modelRouteForAgent(runId: string, agentExecutionId: string, model: string): { routingDecisionId: string; agentRole: string } {
    this.getRun(runId);
    const agent = this.db.query("SELECT role, model_tier FROM agent_executions WHERE id = ? AND run_id = ?")
      .get(agentExecutionId, runId) as { role: string; model_tier: string } | null;
    if (!agent) throw new TypeError("model budget reservation agent does not belong to the run");
    const route = this.db.query(`SELECT id, logical_tier FROM model_routing_decisions
      WHERE run_id = ? AND agent_execution_id = ? AND agent_role = ? AND resolved_model = ? ORDER BY rowid DESC LIMIT 1`)
      .get(runId, agentExecutionId, agent.role, model) as { id: string; logical_tier: string } | null;
    if (!route) throw new TypeError("model budget reservation does not match a recorded route");
    if (route.logical_tier !== agent.model_tier) throw new TypeError("model budget reservation route does not match its agent tier");
    return { routingDecisionId: route.id, agentRole: agent.role };
  }

  modelBudgetReservation(runId: string, reservationId: string): { inputTokens: number; outputTokens: number; estimatedCostUsd: number; agentExecutionId: string; model: string; routingDecisionId: string } {
    const row = this.db.query(`SELECT input_tokens, output_tokens, estimated_cost_usd, agent_execution_id, resolved_model, routing_decision_id FROM cost_records
      WHERE id = ? AND run_id = ? AND source_type = 'MODEL_RESERVATION'
        AND reservation_status IN ('ACTIVE', 'AMBIGUOUS_PROVIDER_OUTCOME')`)
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

  markModelBudgetReservationAmbiguous(runId: string, reservationId: string): void {
    const result = this.db.query(`UPDATE cost_records SET reservation_status = 'AMBIGUOUS_PROVIDER_OUTCOME'
      WHERE id = ? AND run_id = ? AND source_type = 'MODEL_RESERVATION' AND reservation_status = 'ACTIVE'`)
      .run(reservationId, runId);
    if (Number(result.changes) !== 1) throw new Error("model budget reservation is missing, finalized, or already ambiguous");
  }

  runtimeBudgetUsage(runId: string, now = new Date()): RunBudgetUsage {
    const budget = this.db.query("SELECT used_time_seconds, active_since FROM run_budgets WHERE run_id = ?")
      .get(runId) as { used_time_seconds: number; active_since: string | null } | null;
    if (!budget) throw new EngineerNotFoundError("run budget", runId);
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
    const reservations = this.db.query(`SELECT COUNT(*) AS count, COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens FROM cost_records
      WHERE run_id = ? AND source_type = 'MODEL_RESERVATION'
        AND reservation_status IN ('ACTIVE', 'AMBIGUOUS_PROVIDER_OUTCOME')`)
      .get(runId) as { count: number; input_tokens: number; output_tokens: number };
    const commands = this.db.query("SELECT started_at, finished_at FROM command_executions WHERE run_id = ?").all(runId) as Array<{ started_at: string; finished_at: string | null }>;
    const artifact = this.db.query(`SELECT COALESCE(SUM(size_bytes), 0) AS bytes FROM (
      SELECT MAX(size_bytes) AS size_bytes FROM artifacts WHERE run_id = ? GROUP BY sha256
    )`).get(runId) as { bytes: number };
    const agents = this.db.query("SELECT COUNT(*) AS count FROM agent_executions WHERE run_id = ? AND status = 'RUNNING'").get(runId) as { count: number };
    const longestCommandSeconds = commands.reduce((longest, command) => command.finished_at
      ? Math.max(longest, Math.max(0, (Date.parse(command.finished_at) - Date.parse(command.started_at)) / 1_000))
      : longest, 0);
    const activeIntervalSeconds = budget.active_since
      ? Math.max(0, (now.getTime() - Date.parse(budget.active_since)) / 1_000)
      : 0;
    return RunBudgetUsageSchema.parse({
      elapsedSeconds: Math.max(0, Number(budget.used_time_seconds) + activeIntervalSeconds),
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
    const command = this.db.query("SELECT run_id, executor_id FROM command_executions WHERE id = ?")
      .get(parsed.commandExecutionId) as { run_id: string; executor_id: string } | null;
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
    this.insertAudit(parsed.runId, "VERIFICATION_EXECUTED", "EXECUTOR", command.executor_id, {
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

  /** Legacy fixture writer only. Production must use recordClassifiedReviewerSession. */
  recordLegacyReviewerSessionForTest(
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

  /**
   * Dark Required Lane persistence entry point. The normalized Reviewer rows,
   * byte-level provider output reference, and deterministic classification are
   * committed together or not at all. Exact retries are no-ops; partial legacy
   * rows and any changed retry are rejected.
   */
  recordClassifiedReviewerSession(
    record: ReviewerSessionRecord,
    findings: ReviewFindingRecord[],
    classification: ReviewClassificationBatch,
    authority: ClassifiedReviewerAuthority,
    readArtifact?: ArtifactByteReader,
  ): ReviewClassificationBatch {
    const parsed = ReviewerSessionRecordSchema.parse(record);
    const parsedFindings = findings.map((finding) => ReviewFindingRecordSchema.parse(finding))
      .sort((left, right) => compareCodeUnits(left.findingId, right.findingId));
    const batch = ReviewClassificationBatchSchema.parse(classification);
    const reviewerInput = ReviewerInputSchema.parse(authority.reviewerInput);
    const rawArtifact = ArtifactRecordSchema.parse(authority.rawOutputArtifact);
    this.getRun(parsed.runId);
    const findingIds = parsedFindings.map((finding) => finding.findingId);
    const classificationIds = batch.classifications.map((item) => item.findingId);
    if (parsedFindings.some((finding) => finding.reviewerSessionId !== parsed.reviewerSessionId) ||
        batch.runId !== parsed.runId || batch.reviewerSessionId !== parsed.reviewerSessionId ||
        batch.manifestHash !== parsed.manifestHash || batch.normalizedOutputHash !== sha256(parsed.output) ||
        batch.normalizedSessionHash !== sha256(parsed) || batch.normalizedFindingsHash !== sha256(parsedFindings) ||
        canonicalJson(findingIds) !== canonicalJson(classificationIds)) {
      throw new IdempotencyConflictError(parsed.runId, `classified-reviewer:${parsed.reviewerSessionId}`);
    }
    if (batch.provenanceConflict !== Boolean(authority.provenanceConflict)) {
      throw new IdempotencyConflictError(parsed.runId, `classified-reviewer-provenance:${parsed.reviewerSessionId}`);
    }
    const batchJson = canonicalJson(batch);
    const transact = this.db.transaction(() => {
      const persistedReplay = this.db.query(`SELECT reviewer_session_id, batch_json, reviewer_input_json,
        normalized_output_json FROM review_classification_batches
        WHERE reviewer_session_id = ? OR classification_hash = ?`).get(
          parsed.reviewerSessionId, batch.classificationHash,
        ) as {
          reviewer_session_id: string; batch_json: string; reviewer_input_json: string;
          normalized_output_json: string;
        } | null;
      if (persistedReplay) {
        if (persistedReplay.reviewer_session_id !== parsed.reviewerSessionId || persistedReplay.batch_json !== batchJson ||
            persistedReplay.reviewer_input_json !== canonicalJson(reviewerInput) ||
            persistedReplay.normalized_output_json !== canonicalJson(parsed.output)) {
          throw new IdempotencyConflictError(parsed.runId, `classified-reviewer:${parsed.reviewerSessionId}`);
        }
        const recovered = this.getReviewClassification(parsed.reviewerSessionId, readArtifact);
        const artifactRow = this.db.query("SELECT * FROM artifacts WHERE id = ? AND run_id = ?")
          .get(rawArtifact.artifactId, parsed.runId) as Record<string, unknown> | null;
        if (!recovered || canonicalJson(recovered) !== batchJson || !artifactRow ||
            canonicalJson(this.artifactFromRow(artifactRow)) !== canonicalJson(rawArtifact)) {
          throw new IdempotencyConflictError(parsed.runId, `classified-reviewer:${parsed.reviewerSessionId}`);
        }
        return recovered;
      }
      const runRow = this.db.query("SELECT state, manifest_hash FROM engineer_runs WHERE id = ?")
        .get(parsed.runId) as { state: string; manifest_hash: string | null } | null;
      const manifestRow = this.db.query(`SELECT manifest_json FROM task_manifest_versions
        WHERE run_id = ? AND manifest_hash = ?`).get(parsed.runId, parsed.manifestHash) as { manifest_json: string } | null;
      if (!runRow || runRow.state !== "REVIEWING" || runRow.manifest_hash !== parsed.manifestHash || !manifestRow ||
          canonicalJson(TaskManifestSchema.parse(JSON.parse(manifestRow.manifest_json))) !== canonicalJson(reviewerInput.manifest)) {
        throw new IdempotencyConflictError(parsed.runId, `classified-reviewer-current-run:${parsed.reviewerSessionId}`);
      }
      const contractRow = this.db.query(`SELECT contract_json FROM required_lane_contracts
        WHERE contract_hash = ? AND run_id = ? AND manifest_hash = ? AND schema_version = 2`).get(
          batch.contractHash, parsed.runId, parsed.manifestHash,
        ) as { contract_json: string } | null;
      if (!contractRow) throw new IdempotencyConflictError(parsed.runId, `classified-reviewer-contract:${parsed.reviewerSessionId}`);
      const contract = RequiredLaneContractSchema.parse(JSON.parse(contractRow.contract_json));
      if (contract.schemaVersion !== 2 || reviewerInput.runId !== parsed.runId ||
          reviewerInput.reviewSessionId !== parsed.reviewerSessionId || reviewerInput.reviewAttempt !== parsed.attempt ||
          reviewerInput.manifestHash !== parsed.manifestHash || reviewerInput.diffHash !== parsed.diffHash ||
          reviewerInput.evidenceBundleHash !== parsed.evidenceBundleHash || reviewerInput.reviewPolicyVersion !== parsed.policyVersion ||
          sha256(reviewerInput) !== parsed.inputHash) {
        throw new IdempotencyConflictError(parsed.runId, `classified-reviewer-input:${parsed.reviewerSessionId}`);
      }
      const artifactRow = this.db.query("SELECT * FROM artifacts WHERE id = ? AND run_id = ?")
        .get(rawArtifact.artifactId, parsed.runId) as Record<string, unknown> | null;
      if (!artifactRow) throw new IdempotencyConflictError(parsed.runId, `classified-reviewer-artifact:${parsed.reviewerSessionId}`);
      const recordedArtifact = this.artifactFromRow(artifactRow);
      if (canonicalJson(recordedArtifact) !== canonicalJson(rawArtifact) || rawArtifact.type !== "REVIEWER_RAW_OUTPUT" ||
          rawArtifact.producerType !== "SYSTEM" || rawArtifact.producerId !== parsed.reviewerSessionId || !rawArtifact.trusted ||
          (!readArtifact && (!existsSync(rawArtifact.storageReference) || !lstatSync(rawArtifact.storageReference).isFile()))) {
        throw new IdempotencyConflictError(parsed.runId, `classified-reviewer-artifact:${parsed.reviewerSessionId}`);
      }
      const rawBytes = readArtifact ? readArtifact(rawArtifact) : readFileSync(rawArtifact.storageReference);
      if (rawBytes.byteLength !== rawArtifact.sizeBytes || !matchesSha256Bytes(rawBytes, rawArtifact.sha256)) {
        throw new IdempotencyConflictError(parsed.runId, `classified-reviewer-artifact-bytes:${parsed.reviewerSessionId}`);
      }
      let rawOutput;
      try {
        rawOutput = ReviewerOutputSchema.parse(JSON.parse(rawBytes.toString("utf8")));
      } catch {
        throw new IdempotencyConflictError(parsed.runId, `classified-reviewer-raw-json:${parsed.reviewerSessionId}`);
      }
      const boundOutput = bindReviewerEvidence(reviewerInput, rawOutput);
      const normalizedFromRaw = reviewerFindingRecords(parsed.reviewerSessionId, boundOutput)
        .sort((left, right) => compareCodeUnits(left.findingId, right.findingId));
      if (canonicalJson(boundOutput) !== canonicalJson(parsed.output) ||
          canonicalJson(normalizedFromRaw) !== canonicalJson(parsedFindings)) {
        throw new IdempotencyConflictError(parsed.runId, `classified-reviewer-raw-binding:${parsed.reviewerSessionId}`);
      }
      const requiredTestGates = this.assertDurableReviewerEvidence(reviewerInput, contract, readArtifact);
      const recomputed = classifyReviewerOutput({
        contract, manifest: reviewerInput.manifest, session: parsed, findings: parsedFindings,
        trustedEvidence: reviewerInput.trustedEvidence,
        rawOutput: {
          artifactId: rawArtifact.artifactId, sha256: rawArtifact.sha256,
          byteLength: rawArtifact.sizeBytes, mediaType: "application/json",
        },
        provenanceConflict: authority.provenanceConflict,
        requiredTestGates,
      });
      if (recomputed.classificationHash !== batch.classificationHash || canonicalJson(recomputed) !== batchJson) {
        throw new IdempotencyConflictError(parsed.runId, `classified-reviewer-semantics:${parsed.reviewerSessionId}`);
      }
      const existingBatch = this.db.query(`SELECT reviewer_session_id, batch_json
        FROM review_classification_batches
        WHERE reviewer_session_id = ? OR classification_hash = ?`).get(
          parsed.reviewerSessionId, batch.classificationHash,
        ) as { reviewer_session_id: string; batch_json: string } | null;
      if (existingBatch) {
        if (existingBatch.reviewer_session_id !== parsed.reviewerSessionId || existingBatch.batch_json !== batchJson) {
          throw new IdempotencyConflictError(parsed.runId, `classified-reviewer:${parsed.reviewerSessionId}`);
        }
        return batch;
      }
      const existingSession = this.db.query("SELECT id FROM reviewer_sessions WHERE id = ? OR (run_id = ? AND (attempt = ? OR input_hash = ?))")
        .get(parsed.reviewerSessionId, parsed.runId, parsed.attempt, parsed.inputHash) as { id: string } | null;
      if (existingSession) {
        throw new IdempotencyConflictError(parsed.runId, `classified-reviewer-legacy:${parsed.reviewerSessionId}`);
      }
      this.db.query(`INSERT INTO reviewer_sessions
        (id, run_id, attempt, model_tier, resolved_model, input_hash, manifest_hash, diff_hash,
         evidence_bundle_hash, policy_version, cache_key, cache_hit, cache_observed, started_at, completed_at,
         decision, isolation_verified)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        parsed.reviewerSessionId, parsed.runId, parsed.attempt, parsed.modelTier, parsed.resolvedModel,
        parsed.inputHash, parsed.manifestHash, parsed.diffHash, parsed.evidenceBundleHash,
        parsed.policyVersion, parsed.cacheKey, parsed.cacheHit ? 1 : 0, parsed.cacheHit === null ? 0 : 1,
        parsed.startedAt, parsed.completedAt, parsed.decision, parsed.isolationVerified ? 1 : 0,
      );
      const findingStatement = this.db.query(`INSERT INTO review_findings
        (id, reviewer_session_id, fingerprint, severity, category, file, line_start, line_end,
         description, required_change, criterion_ids_json, evidence_ids_json, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const finding of parsedFindings) {
        findingStatement.run(
          finding.findingId, finding.reviewerSessionId, finding.fingerprint, finding.severity,
          finding.category, finding.file, finding.lineStart, finding.lineEnd, finding.description,
          finding.requiredChange, canonicalJson(finding.criterionIds), canonicalJson(finding.evidenceIds), finding.status,
        );
      }
      const classificationStatement = this.db.query(`INSERT INTO review_finding_classifications
        (classification_hash, batch_hash, reviewer_session_id, finding_id, finding_fingerprint,
         disposition, authority, reason_code, classification_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const item of batch.classifications) {
        classificationStatement.run(
          item.classificationHash, batch.classificationHash, batch.reviewerSessionId, item.findingId,
          item.findingFingerprint, item.disposition, item.authority, item.reasonCode, canonicalJson(item),
        );
      }
      this.db.query(`INSERT INTO review_classification_batches
        (classification_hash, reviewer_session_id, run_id, contract_hash, schema_version, policy_version,
         raw_output_artifact_id, raw_output_hash, normalized_output_hash, normalized_session_hash,
         normalized_findings_hash, reviewer_input_json, normalized_output_json, batch_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        batch.classificationHash, batch.reviewerSessionId, batch.runId, batch.contractHash,
        batch.schemaVersion, batch.policyVersion, batch.rawOutput.artifactId, batch.rawOutput.sha256,
        batch.normalizedOutputHash, batch.normalizedSessionHash, batch.normalizedFindingsHash,
        canonicalJson(reviewerInput), canonicalJson(parsed.output), batchJson, batch.createdAt,
      );
      this.insertAudit(parsed.runId, "REVIEW_CLASSIFICATION_RECORDED", "SYSTEM", batch.policyVersion, {
        reviewerSessionId: parsed.reviewerSessionId,
        contractHash: batch.contractHash,
        classificationHash: batch.classificationHash,
        rawOutputArtifactId: batch.rawOutput.artifactId,
        rawOutputHash: batch.rawOutput.sha256,
        normalizedOutputHash: batch.normalizedOutputHash,
        result: batch.result,
      }, batch.createdAt);
      return batch;
    });
    return transact.immediate();
  }

  getReviewClassification(reviewerSessionId: string, readArtifact?: ArtifactByteReader): ReviewClassificationBatch | null {
    const row = this.db.query("SELECT * FROM review_classification_batches WHERE reviewer_session_id = ?")
      .get(reviewerSessionId) as Record<string, unknown> | null;
    if (!row) return null;
    const batch = ReviewClassificationBatchSchema.parse(JSON.parse(String(row.batch_json)));
    if (row.classification_hash !== batch.classificationHash || row.run_id !== batch.runId ||
        row.contract_hash !== batch.contractHash || row.schema_version !== batch.schemaVersion ||
        row.policy_version !== batch.policyVersion || row.raw_output_artifact_id !== batch.rawOutput.artifactId ||
        row.raw_output_hash !== batch.rawOutput.sha256 || row.normalized_output_hash !== batch.normalizedOutputHash ||
        row.normalized_session_hash !== batch.normalizedSessionHash || row.normalized_findings_hash !== batch.normalizedFindingsHash ||
        row.created_at !== batch.createdAt) {
      throw new Error("persisted review classification batch columns do not match its hash-bound JSON");
    }
    const session = this.db.query(`SELECT run_id, attempt, input_hash, manifest_hash, diff_hash,
      evidence_bundle_hash, policy_version FROM reviewer_sessions WHERE id = ?`)
      .get(reviewerSessionId) as {
        run_id: string; attempt: number; input_hash: string; manifest_hash: string; diff_hash: string;
        evidence_bundle_hash: string; policy_version: string;
      } | null;
    const contractRow = this.db.query(`SELECT contract_json FROM required_lane_contracts
      WHERE contract_hash = ? AND run_id = ? AND manifest_hash = ? AND schema_version = 2`)
      .get(batch.contractHash, batch.runId, batch.manifestHash) as { contract_json: string } | null;
    if (!session || session.run_id !== batch.runId || session.manifest_hash !== batch.manifestHash || !contractRow) {
      throw new Error("persisted review classification authority binding is invalid");
    }
    const children = (this.db.query(`SELECT * FROM review_finding_classifications
      WHERE batch_hash = ?`).all(batch.classificationHash) as Array<Record<string, unknown>>)
      .sort((left, right) => compareCodeUnits(String(left.finding_id), String(right.finding_id)));
    if (children.length !== batch.classifications.length) throw new Error("persisted review classification mapping is incomplete");
    for (const [index, item] of batch.classifications.entries()) {
      const child = children[index];
      if (!child || child.classification_hash !== item.classificationHash || child.reviewer_session_id !== reviewerSessionId ||
          child.finding_id !== item.findingId || child.finding_fingerprint !== item.findingFingerprint ||
          child.disposition !== item.disposition || child.authority !== item.authority || child.reason_code !== item.reasonCode ||
          child.classification_json !== canonicalJson(item)) {
        throw new Error("persisted review finding classification does not match its hash-bound JSON");
      }
    }
    const artifactRow = this.db.query("SELECT * FROM artifacts WHERE id = ? AND run_id = ?")
      .get(batch.rawOutput.artifactId, batch.runId) as Record<string, unknown> | null;
    if (!artifactRow) throw new Error("persisted review raw output artifact is missing");
    const artifact = this.artifactFromRow(artifactRow);
    if (artifact.type !== "REVIEWER_RAW_OUTPUT" || artifact.sha256 !== batch.rawOutput.sha256 ||
        artifact.sizeBytes !== batch.rawOutput.byteLength ||
        (!readArtifact && (!existsSync(artifact.storageReference) || !lstatSync(artifact.storageReference).isFile()))) {
      throw new Error("persisted review raw output artifact binding is invalid");
    }
    const bytes = readArtifact ? readArtifact(artifact) : readFileSync(artifact.storageReference);
    if (bytes.byteLength !== artifact.sizeBytes || !matchesSha256Bytes(bytes, artifact.sha256)) {
      throw new Error("persisted review raw output artifact bytes are invalid");
    }
    const reviewerInput = ReviewerInputSchema.parse(JSON.parse(String(row.reviewer_input_json)));
    const normalizedOutput = ReviewerOutputSchema.parse(JSON.parse(String(row.normalized_output_json)));
    let rawOutput;
    try { rawOutput = ReviewerOutputSchema.parse(JSON.parse(bytes.toString("utf8"))); } catch {
      throw new Error("persisted review raw output is invalid JSON");
    }
    if (sha256(reviewerInput) !== session.input_hash || sha256(normalizedOutput) !== batch.normalizedOutputHash ||
        reviewerInput.reviewSessionId !== reviewerSessionId || reviewerInput.reviewAttempt !== session.attempt ||
        reviewerInput.diffHash !== session.diff_hash || reviewerInput.evidenceBundleHash !== session.evidence_bundle_hash ||
        reviewerInput.reviewPolicyVersion !== session.policy_version ||
        canonicalJson(bindReviewerEvidence(reviewerInput, rawOutput)) !== canonicalJson(normalizedOutput)) {
      throw new Error("persisted raw and normalized Reviewer outputs do not re-bind");
    }
    const requiredTestGates = this.assertDurableReviewerEvidence(
      reviewerInput, RequiredLaneContractSchema.parse(JSON.parse(contractRow.contract_json)), readArtifact,
    );
    if (canonicalJson(requiredTestGates) !== canonicalJson(batch.requiredTestGates)) {
      throw new Error("persisted review required-test gates do not match durable evidence");
    }
    return batch;
  }

  reviewClassificationRunId(reviewerSessionId:string):string|null{
    const row=this.db.query("SELECT run_id FROM review_classification_batches WHERE reviewer_session_id=?")
      .get(reviewerSessionId) as {run_id:string}|null;
    return row?.run_id??null;
  }

  latestClassifiedReview(runId: string, readArtifact?: ArtifactByteReader): {
    classification: ReviewClassificationBatch;
    reviewerInput: ReturnType<typeof ReviewerInputSchema.parse>;
    session: ReviewerSessionRecord;
    findings: ReviewFindingRecord[];
  } | null {
    this.getRun(runId);
    const row = this.db.query(`SELECT b.*, s.attempt, s.model_tier, s.resolved_model, s.input_hash,
      s.manifest_hash, s.diff_hash, s.evidence_bundle_hash, s.policy_version AS session_policy_version,
      s.cache_key, s.cache_hit, s.cache_observed, s.started_at, s.completed_at, s.decision, s.isolation_verified
      FROM review_classification_batches b JOIN reviewer_sessions s ON s.id = b.reviewer_session_id
      WHERE b.run_id = ? ORDER BY s.attempt DESC LIMIT 1`).get(runId) as Record<string, unknown> | null;
    if (!row) return null;
    const classification = this.getReviewClassification(String(row.reviewer_session_id), readArtifact);
    if (!classification) throw new Error("classified review disappeared during rehydration");
    const reviewerInput = ReviewerInputSchema.parse(JSON.parse(String(row.reviewer_input_json)));
    const output = ReviewerOutputSchema.parse(JSON.parse(String(row.normalized_output_json)));
    const session = ReviewerSessionRecordSchema.parse({
      reviewerSessionId: row.reviewer_session_id, runId, attempt: row.attempt,
      modelTier: row.model_tier, resolvedModel: row.resolved_model, inputHash: row.input_hash,
      manifestHash: row.manifest_hash, diffHash: row.diff_hash, evidenceBundleHash: row.evidence_bundle_hash,
      policyVersion: row.session_policy_version, cacheKey: row.cache_key,
      cacheHit: row.cache_observed === 1 ? row.cache_hit === 1 : null,
      startedAt: row.started_at, completedAt: row.completed_at, decision: row.decision,
      isolationVerified: row.isolation_verified === 1, output,
    });
    const findings = (this.db.query("SELECT * FROM review_findings WHERE reviewer_session_id = ? ORDER BY id")
      .all(session.reviewerSessionId) as Array<Record<string, unknown>>).map((finding) => ReviewFindingRecordSchema.parse({
        findingId: finding.id, reviewerSessionId: finding.reviewer_session_id, fingerprint: finding.fingerprint,
        severity: finding.severity, category: finding.category, file: finding.file,
        lineStart: finding.line_start, lineEnd: finding.line_end, description: finding.description,
        requiredChange: finding.required_change, criterionIds: JSON.parse(String(finding.criterion_ids_json)),
        evidenceIds: JSON.parse(String(finding.evidence_ids_json)), status: finding.status,
      }));
    return { classification, reviewerInput, session, findings };
  }

  /** Read-only semantic gate shared by pre-spend admission and persistence. */
  preflightDurableReviewerEvidence(rawInput:ReviewerInput,readArtifact?:(artifact:ArtifactRecord)=>Buffer):RequiredTestGate[]{
    const input=ReviewerInputSchema.parse(rawInput);
    return this.db.transaction(()=>{
      const contract=this.getRequiredLaneContract(input.runId,input.manifestHash),manifest=this.getManifest(input.runId);
      if(!contract||!manifest||canonicalJson(manifest)!==canonicalJson(input.manifest))
        throw new IdempotencyConflictError(input.runId,"reviewer-evidence-contract-or-manifest");
      const latestRisk=this.latestRiskAssessment(input.runId);
      if(canonicalJson(latestRisk)!==canonicalJson(input.riskAssessment))
        throw new IdempotencyConflictError(input.runId,"reviewer-evidence-risk-assessment");
      const gates=this.assertDurableReviewerEvidence(input,contract,readArtifact);
      if(gates.some((gate)=>gate.status!=="PASSED"))
        throw new IdempotencyConflictError(input.runId,"reviewer-evidence-required-test-gate");
      return gates;
    })();
  }

  private assertDurableReviewerEvidence(input: ReviewerInput, contract: RequiredLaneContract,
    readArtifact?:(artifact:ArtifactRecord)=>Buffer): RequiredTestGate[] {
    if (contract.schemaVersion !== 2) throw new TypeError("legacy contracts cannot authorize Reviewer evidence");
    const reviewEpoch = Date.parse(input.createdAt);
    if (!Number.isFinite(reviewEpoch)) throw new TypeError("ReviewerInput createdAt is not a finite timestamp");
    const epoch = (value: unknown): number => {
      const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
      if (!Number.isFinite(parsed)) throw new TypeError("durable Reviewer evidence contains an invalid timestamp");
      return parsed;
    };
    if (this.db.query(`SELECT 1 FROM test_executions WHERE run_id = ?
      AND julianday(completed_at) IS NULL LIMIT 1`).get(input.runId)) {
      throw new IdempotencyConflictError(input.runId, "reviewer-evidence-time:verification");
    }
    const independentEvidence = input.trustedEvidence.filter((item) => item.eventType === "INDEPENDENT_VERIFICATION");
    const independentTestIds = independentEvidence.map((item) => String(item.payload.testId));
    if (independentTestIds.some((testId) => !contract.requiredTestIds.includes(testId)) ||
        independentTestIds.length !== new Set(independentTestIds).size) {
      throw new IdempotencyConflictError(input.runId, "reviewer-evidence-required-test-set");
    }
    const requiredTestGates = [...contract.requiredTestIds].sort(compareCodeUnits).map((testId) => {
      const testPlan = input.manifest.testPlan.find((test) => test.testId === testId);
      if (!testPlan?.command) throw new IdempotencyConflictError(input.runId, `reviewer-evidence-required-test:${testId}`);
      if (this.db.query(`SELECT 1 FROM audit_events a
        JOIN test_executions t ON t.id = json_extract(a.details_json, '$.verificationExecutionId')
          AND t.run_id = a.run_id
        JOIN command_executions c ON c.id = t.command_execution_id AND c.run_id = t.run_id
        WHERE a.run_id = ? AND a.action = 'VERIFICATION_EXECUTED'
          AND json_extract(a.details_json, '$.testId') = ?
          AND t.type = ? AND c.command = ? AND julianday(a.created_at) IS NULL LIMIT 1`)
        .get(input.runId, testId, testPlan.type, testPlan.command)) {
        throw new IdempotencyConflictError(input.runId, `reviewer-evidence-time:verification-audit:${testId}`);
      }
      const candidates = this.db.query(`SELECT t.id, t.verification_pass, t.status, t.completed_at
        FROM test_executions t
        JOIN command_executions c ON c.id = t.command_execution_id AND c.run_id = t.run_id
        JOIN audit_events a ON a.run_id = t.run_id AND a.action = 'VERIFICATION_EXECUTED'
          AND json_extract(a.details_json, '$.verificationExecutionId') = t.id
          AND json_extract(a.details_json, '$.testId') = ?
        WHERE t.run_id = ? AND t.type = ? AND c.command = ?
          AND julianday(t.completed_at) IS NOT NULL AND julianday(t.completed_at) <= julianday(?)
          AND julianday(a.created_at) IS NOT NULL AND julianday(a.created_at) <= julianday(?)
        ORDER BY t.verification_pass DESC, julianday(t.completed_at) DESC, t.rowid DESC
        `).all(testId, input.runId, testPlan.type, testPlan.command, input.createdAt, input.createdAt) as Array<{
          id: string; verification_pass: number; status: string; completed_at: string;
        }>;
      if (candidates.some((candidate) => !Number.isFinite(Date.parse(candidate.completed_at)))) {
        throw new IdempotencyConflictError(input.runId, `reviewer-evidence-time:verification:${testId}`);
      }
      if (candidates.some((candidate, index) => candidates.findIndex((item) => item.id === candidate.id) !== index)) {
        throw new IdempotencyConflictError(input.runId, `reviewer-evidence-duplicate-audit:${testId}`);
      }
      const latest = candidates[0];
      const supplied = independentEvidence.filter((item) => item.payload.testId === testId);
      if (!latest || supplied.length === 0) {
        return RequiredTestGateSchema.parse({ testId, evidenceId: null, status: "MISSING" });
      }
      if (!this.db.query("SELECT 1 FROM test_executions WHERE id = ? AND run_id = ?")
        .get(supplied[0]!.evidenceId, input.runId)) {
        throw new IdempotencyConflictError(input.runId, `reviewer-evidence-missing:${supplied[0]!.evidenceId}`);
      }
      if (candidates[1]?.verification_pass === latest.verification_pass || supplied.length !== 1 ||
          supplied[0]!.evidenceId !== latest.id) {
        throw new IdempotencyConflictError(input.runId, `reviewer-evidence-stale:${supplied[0]?.evidenceId ?? testId}`);
      }
      return RequiredTestGateSchema.parse({
        testId, evidenceId: latest.id,
        status: latest.status === "PASSED" ? "PASSED" : latest.status === "FAILED" ? "FAILED"
          : latest.status === "TIMED_OUT" ? "TIMED_OUT" : "BLOCKED",
      });
    });
    const assertLatestDomainArtifact = (evidence: ReviewerInput["trustedEvidence"][number], artifactType: string): void => {
      const producerByType: Record<string, string> = {
        VERIFICATION_COVERAGE_MATRIX: "verification-coverage-policy",
        SECURITY_REPORT: "deterministic-security-scanner",
        ADVERSARIAL_COVERAGE_REPORT: "adversarial-coverage-policy",
        FINAL_CHANGE_SCOPE_ATTESTATION: "final-change-scope-policy",
      };
      const expectedProducer = producerByType[artifactType];
      if (!expectedProducer || evidence.producerType !== "SYSTEM" || evidence.producerId !== expectedProducer) {
        throw new IdempotencyConflictError(input.runId, `reviewer-evidence-domain-producer:${evidence.evidenceId}`);
      }
      const rows = this.db.query(`SELECT a.*, a.rowid AS artifact_rowid FROM artifacts a
        WHERE a.run_id = ? AND a.type = ? AND a.producer_type = 'SYSTEM' AND a.producer_id = ?`)
        .all(input.runId, artifactType, expectedProducer) as Array<Record<string, unknown>>;
      if (!rows.some((row) => row.id === evidence.evidenceId)) {
        throw new IdempotencyConflictError(input.runId, `reviewer-evidence-missing:${evidence.evidenceId}`);
      }
      const candidates = rows.flatMap((row) => {
        const artifact = this.artifactFromRow(row);
        const createdEpoch = epoch(artifact.createdAt);
        if (createdEpoch > reviewEpoch) return [];
        if (!artifact.trusted || (!readArtifact&&(!existsSync(artifact.storageReference)||
            !lstatSync(artifact.storageReference).isFile()||lstatSync(artifact.storageReference).isSymbolicLink()))) {
          throw new IdempotencyConflictError(input.runId, `reviewer-evidence-domain-artifact:${artifact.artifactId}`);
        }
        const bytes = readArtifact?readArtifact(artifact):readFileSync(artifact.storageReference);
        if (bytes.byteLength !== artifact.sizeBytes || !matchesSha256Bytes(bytes, artifact.sha256)) {
          throw new IdempotencyConflictError(input.runId, `reviewer-evidence-domain-bytes:${artifact.artifactId}`);
        }
        let payload: Record<string, unknown>;
        try { payload = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>; } catch {
          throw new IdempotencyConflictError(input.runId, `reviewer-evidence-domain-json:${artifact.artifactId}`);
        }
        const relevant = payload.runId === input.runId && (
          artifactType === "VERIFICATION_COVERAGE_MATRIX" ? payload.manifestHash === input.manifestHash
            : artifactType === "SECURITY_REPORT" ? payload.diffHash === input.diffHash &&
              payload.policyVersion === contract.policyBindings.securityPolicyVersion
              : artifactType === "ADVERSARIAL_COVERAGE_REPORT" ? payload.manifestHash === input.manifestHash
                : payload.manifestHash === input.manifestHash && payload.diffHash === input.diffHash &&
                  payload.resultCommitSha === input.resultCommitSha && payload.policyVersion === "final-change-scope-v1"
        );
        if (!relevant) return [];
        return [{ artifact, createdEpoch, rowid: Number(row.artifact_rowid), semanticHash: sha256(payload) }];
      }).sort((left, right) => right.createdEpoch - left.createdEpoch || right.rowid - left.rowid);
      const semanticIdentities = new Set<string>();
      if (candidates.some((candidate) => {
        if (semanticIdentities.has(candidate.semanticHash)) return true;
        semanticIdentities.add(candidate.semanticHash);
        return false;
      })) {
        throw new IdempotencyConflictError(input.runId, `reviewer-evidence-domain-duplicate:${artifactType}`);
      }
      const latest = candidates[0];
      if (!latest || candidates.some((candidate, index) => index > 0 && candidate.createdEpoch === latest.createdEpoch)) {
        throw new IdempotencyConflictError(input.runId, `reviewer-evidence-domain-latest:${artifactType}`);
      }
      if (latest.artifact.artifactId !== evidence.evidenceId) {
        throw new IdempotencyConflictError(input.runId, `reviewer-evidence-domain-stale:${evidence.evidenceId}`);
      }
    };
    const integrityStages = new Set<string>();
    for (const evidence of input.trustedEvidence) {
      if (evidence.runId !== input.runId || epoch(evidence.createdAt) > reviewEpoch || evidence.sha256 !== sha256(evidence.payload)) {
        throw new IdempotencyConflictError(input.runId, `reviewer-evidence-digest:${evidence.evidenceId}`);
      }
      if (evidence.eventType === "INDEPENDENT_VERIFICATION") {
        if (this.db.query(`SELECT 1 FROM audit_events WHERE run_id = ? AND action = 'VERIFICATION_EXECUTED'
          AND json_extract(details_json, '$.verificationExecutionId') = ?
          AND julianday(created_at) IS NULL LIMIT 1`).get(input.runId, evidence.evidenceId)) {
          throw new IdempotencyConflictError(input.runId, `reviewer-evidence-time:verification-audit:${evidence.evidenceId}`);
        }
        const rows = this.db.query(`SELECT t.run_id, t.command_execution_id, t.verification_pass, t.type AS execution_type,
          t.status AS test_status, t.started_at AS test_started_at, t.completed_at,
          c.command, c.executor_id, c.exit_code, c.started_at, c.finished_at, c.stdout_artifact_id,
          c.stderr_artifact_id, c.environment_digest, c.commit_sha, c.status AS command_status,
          a.details_json, a.created_at AS audit_created_at
          FROM test_executions t
          JOIN command_executions c ON c.id = t.command_execution_id AND c.run_id = t.run_id
          JOIN audit_events a ON a.run_id = t.run_id AND a.action = 'VERIFICATION_EXECUTED'
            AND json_extract(a.details_json, '$.verificationExecutionId') = t.id
          WHERE t.id = ? AND t.run_id = ?
            AND julianday(a.created_at) IS NOT NULL AND julianday(a.created_at) <= julianday(?)`)
          .all(evidence.evidenceId, input.runId, input.createdAt) as Array<Record<string, unknown>>;
        if (rows.length !== 1) throw new IdempotencyConflictError(
          input.runId, rows.length === 0 ? `reviewer-evidence-missing:${evidence.evidenceId}` : `reviewer-evidence-duplicate-audit:${evidence.evidenceId}`,
        );
        const row = rows[0]!;
        const details = JSON.parse(String(row.details_json)) as Record<string, unknown>;
        const payload = evidence.payload;
        const stdoutRow = this.db.query("SELECT * FROM artifacts WHERE id = ? AND run_id = ?")
          .get(String(row.stdout_artifact_id), input.runId) as Record<string, unknown> | null;
        const stderrRow = this.db.query("SELECT * FROM artifacts WHERE id = ? AND run_id = ?")
          .get(String(row.stderr_artifact_id), input.runId) as Record<string, unknown> | null;
        const validateExecutionArtifact = (artifactRow: Record<string, unknown> | null, expectedType: string): ArtifactRecord | null => {
          if (!artifactRow) return null;
          const artifact = this.artifactFromRow(artifactRow);
          if (artifact.type !== expectedType || artifact.runId !== input.runId || artifact.producerType !== "EXECUTOR" ||
              artifact.producerId !== row.executor_id || !artifact.trusted || (!readArtifact&&
              (!existsSync(artifact.storageReference)||!lstatSync(artifact.storageReference).isFile()||
              lstatSync(artifact.storageReference).isSymbolicLink()))) return null;
          const artifactBytes = readArtifact?readArtifact(artifact):readFileSync(artifact.storageReference);
          return artifactBytes.byteLength === artifact.sizeBytes && matchesSha256Bytes(artifactBytes, artifact.sha256)
            ? artifact : null;
        };
        const stdout = validateExecutionArtifact(stdoutRow, "COMMAND_STDOUT");
        const stderr = validateExecutionArtifact(stderrRow, "COMMAND_STDERR");
        const criterionIds = Array.isArray(details.criterionIds) ? details.criterionIds : [];
        const evidenceEpoch = epoch(evidence.createdAt);
        const completedEpoch = epoch(row.completed_at);
        const commandStartedEpoch = epoch(row.started_at);
        const testStartedEpoch = epoch(row.test_started_at);
        const commandFinishedEpoch = epoch(row.finished_at);
        const auditEpoch = epoch(row.audit_created_at);
        const gate = requiredTestGates.find((candidate) => candidate.testId === payload.testId);
        if (!gate || gate.evidenceId !== evidence.evidenceId || gate.status === "MISSING" || row.commit_sha !== input.resultCommitSha ||
            evidence.createdAt !== row.completed_at ||
            evidenceEpoch !== completedEpoch || completedEpoch > reviewEpoch || auditEpoch > reviewEpoch ||
            payload.policyVersion !== contract.policyBindings.verificationPolicyVersion ||
            payload.testId !== details.testId || !contract.requiredTestIds.includes(String(payload.testId)) ||
            canonicalJson(payload.criterionIds) !== canonicalJson(criterionIds) ||
            payload.type !== details.type || payload.type !== row.execution_type || row.test_status !== details.status ||
            row.test_started_at !== row.started_at || testStartedEpoch !== commandStartedEpoch ||
            row.completed_at !== row.finished_at || completedEpoch !== commandFinishedEpoch ||
            payload.commandExecutionId !== row.command_execution_id || payload.command !== row.command ||
            payload.status !== row.command_status || payload.exitCode !== row.exit_code ||
            payload.timedOut !== (row.command_status === "TIMED_OUT") || payload.environmentDigest !== row.environment_digest ||
            payload.commitSha !== row.commit_sha || evidence.producerType !== "EXECUTOR" || evidence.producerId !== row.executor_id ||
            !stdout || !stderr || (payload.stdoutArtifact as Record<string, unknown> | undefined)?.artifactId !== row.stdout_artifact_id ||
            (payload.stdoutArtifact as Record<string, unknown> | undefined)?.sha256 !== stdout.sha256 ||
            (payload.stderrArtifact as Record<string, unknown> | undefined)?.artifactId !== row.stderr_artifact_id ||
            (payload.stderrArtifact as Record<string, unknown> | undefined)?.sha256 !== stderr.sha256) {
          throw new IdempotencyConflictError(input.runId, `reviewer-evidence-stale:${evidence.evidenceId}`);
        }
        continue;
      }
      const artifactType = evidence.eventType === "TEST_INTEGRITY_ATTESTATION"
        ? "TEST_INTEGRITY_COMPARISON"
        : evidence.eventType;
      if (!["VERIFICATION_COVERAGE_MATRIX", "SECURITY_REPORT", "ADVERSARIAL_COVERAGE_REPORT",
        "TEST_INTEGRITY_COMPARISON", "FINAL_CHANGE_SCOPE_ATTESTATION"].includes(artifactType)) {
        throw new IdempotencyConflictError(input.runId, `reviewer-evidence-type:${evidence.evidenceId}`);
      }
      if (["VERIFICATION_COVERAGE_MATRIX", "SECURITY_REPORT", "ADVERSARIAL_COVERAGE_REPORT",
        "FINAL_CHANGE_SCOPE_ATTESTATION"].includes(artifactType)) {
        assertLatestDomainArtifact(evidence, artifactType);
      }
      const artifactRow = this.db.query("SELECT * FROM artifacts WHERE id = ? AND run_id = ? AND type = ?")
        .get(evidence.evidenceId, input.runId, artifactType) as Record<string, unknown> | null;
      if (!artifactRow) throw new IdempotencyConflictError(input.runId, `reviewer-evidence-missing:${evidence.evidenceId}`);
      const artifact = this.artifactFromRow(artifactRow);
      if (!artifact.trusted || artifact.producerType !== evidence.producerType || artifact.producerId !== evidence.producerId ||
          artifact.sha256 !== evidence.sha256 || artifact.createdAt !== evidence.createdAt ||
          (!readArtifact && (!existsSync(artifact.storageReference) || !lstatSync(artifact.storageReference).isFile()))) {
        throw new IdempotencyConflictError(input.runId, `reviewer-evidence-artifact:${evidence.evidenceId}`);
      }
      const bytes = readArtifact ? readArtifact(artifact) : readFileSync(artifact.storageReference);
      let durablePayload: unknown;
      try { durablePayload = JSON.parse(bytes.toString("utf8")); } catch {
        throw new IdempotencyConflictError(input.runId, `reviewer-evidence-json:${evidence.evidenceId}`);
      }
      if (bytes.byteLength !== artifact.sizeBytes || !matchesSha256Bytes(bytes, artifact.sha256) ||
          canonicalJson(durablePayload) !== canonicalJson(evidence.payload)) {
        throw new IdempotencyConflictError(input.runId, `reviewer-evidence-bytes:${evidence.evidenceId}`);
      }
      switch (evidence.eventType) {
        case "VERIFICATION_COVERAGE_MATRIX": {
          const matrix = VerificationCoverageMatrixSchema.parse(evidence.payload);
          if (evidence.producerType !== "SYSTEM" || evidence.producerId !== "verification-coverage-policy" ||
              matrix.runId !== input.runId || matrix.manifestHash !== input.manifestHash ||
              canonicalJson(matrix) !== canonicalJson(buildVerificationCoverageMatrix(input.manifest, {
                deterministicSecurityGateCovered: this.isOptionalHardeningChild(input.runId),
              }))) {
            throw new IdempotencyConflictError(input.runId, `reviewer-evidence-coverage-binding:${evidence.evidenceId}`);
          }
          break;
        }
        case "ADVERSARIAL_COVERAGE_REPORT": {
          const report = AdversarialCoverageReportSchema.parse(evidence.payload);
          if (this.db.query(`SELECT 1 FROM artifacts a JOIN agent_executions e
            ON e.output_artifact_id = a.id AND e.run_id = a.run_id AND e.id = a.producer_id
            WHERE a.run_id = ? AND a.type = 'TEST_ADVISORY'
              AND (julianday(a.created_at) IS NULL OR julianday(e.completed_at) IS NULL) LIMIT 1`).get(input.runId)) {
            throw new IdempotencyConflictError(input.runId, "reviewer-evidence-time:test-advisory");
          }
          const advisoryRows = this.db.query(`SELECT a.*, e.input_hash AS tester_input_hash FROM artifacts a
            JOIN agent_executions e ON e.output_artifact_id = a.id AND e.run_id = a.run_id
              AND e.id = a.producer_id AND e.role = 'TESTER' AND e.status = 'SUCCEEDED'
            WHERE a.run_id = ? AND a.type = 'TEST_ADVISORY' AND a.trusted = 0
              AND a.producer_type = 'SYSTEM'
              AND julianday(a.created_at) IS NOT NULL AND julianday(e.completed_at) IS NOT NULL
              AND julianday(a.created_at) <= julianday(?) AND julianday(e.completed_at) <= julianday(?)
            ORDER BY julianday(a.created_at) DESC, a.rowid DESC`).all(input.runId, input.createdAt, input.createdAt) as Array<Record<string, unknown>>;
          const matchingAdvisories = advisoryRows.flatMap((row) => {
            const advisoryArtifact = this.artifactFromRow(row);
            if (!readArtifact && (!existsSync(advisoryArtifact.storageReference) ||
                !lstatSync(advisoryArtifact.storageReference).isFile())) return [];
            const advisoryBytes = readArtifact ? readArtifact(advisoryArtifact) : readFileSync(advisoryArtifact.storageReference);
            if (advisoryBytes.byteLength !== advisoryArtifact.sizeBytes ||
                !matchesSha256Bytes(advisoryBytes, advisoryArtifact.sha256)) return [];
            try {
              const advisory = TestAdvisorySchema.parse(JSON.parse(advisoryBytes.toString("utf8")));
              return sha256(advisory) === report.advisoryHash
                ? [{ advisory, inputHash: String(row.tester_input_hash) }] : [];
            } catch {
              return [];
            }
          });
          const expectedTesterEvidence = input.trustedEvidence.filter((item) =>
            item.eventType !== "ADVERSARIAL_COVERAGE_REPORT" &&
            !(item.eventType === "TEST_INTEGRITY_ATTESTATION" && item.payload.stage === "PRE_REVIEW"))
            .sort((left,right)=>compareCodeUnits(left.evidenceId,right.evidenceId));
          const expectedTesterInputHash = sha256({
            manifest: input.manifestHash, diff: input.diffHash, evidence: expectedTesterEvidence,
          });
          if (evidence.producerType !== "SYSTEM" || evidence.producerId !== "adversarial-coverage-policy" ||
              report.runId !== input.runId || report.manifestHash !== input.manifestHash || matchingAdvisories.length !== 1 ||
              matchingAdvisories[0]!.inputHash !== expectedTesterInputHash ||
              canonicalJson(report) !== canonicalJson(buildAdversarialCoverageReport(input.manifest, matchingAdvisories[0]!.advisory))) {
            throw new IdempotencyConflictError(input.runId, `reviewer-evidence-adversarial-binding:${evidence.evidenceId}`);
          }
          break;
        }
        case "TEST_INTEGRITY_ATTESTATION": {
          const comparison = TestIntegrityComparisonSchema.parse(evidence.payload);
          if (this.db.query(`SELECT 1 FROM artifacts WHERE run_id = ?
              AND type IN ('TEST_BASELINE_MANIFEST', 'TEST_INTEGRITY_COMPARISON')
              AND julianday(created_at) IS NULL LIMIT 1`).get(input.runId) ||
              this.db.query(`SELECT 1 FROM audit_events WHERE run_id = ?
              AND action = 'TEST_INTEGRITY_ATTESTED' AND julianday(created_at) IS NULL LIMIT 1`).get(input.runId)) {
            throw new IdempotencyConflictError(input.runId, "reviewer-evidence-time:test-integrity");
          }
          if (evidence.producerType !== "SYSTEM" || evidence.producerId !== "engineer-supervisor-test-integrity" ||
              comparison.runId !== input.runId ||
              !["PRE_VERIFICATION", "POST_INDEPENDENT_VERIFICATION", "PRE_REVIEW"].includes(comparison.stage) ||
              integrityStages.has(comparison.stage)) {
            throw new IdempotencyConflictError(input.runId, `reviewer-evidence-integrity-binding:${evidence.evidenceId}`);
          }
          integrityStages.add(comparison.stage);
          const baselineRow = this.db.query(`SELECT * FROM artifacts
            WHERE run_id = ? AND type = 'TEST_BASELINE_MANIFEST' AND trusted = 1
              AND julianday(created_at) IS NOT NULL AND julianday(created_at) <= julianday(?)
            ORDER BY julianday(created_at) DESC, rowid DESC LIMIT 1`).get(input.runId, input.createdAt) as Record<string, unknown> | null;
          if (!baselineRow) throw new IdempotencyConflictError(input.runId, `reviewer-evidence-baseline:${evidence.evidenceId}`);
          const baselineArtifact = this.artifactFromRow(baselineRow);
          const baselineBytes = readArtifact ? readArtifact(baselineArtifact) : readFileSync(baselineArtifact.storageReference);
          const baseline = TestBaselineManifestSchema.parse(JSON.parse(baselineBytes.toString("utf8")));
          if (baselineArtifact.producerType !== "SYSTEM" || baselineArtifact.producerId !== "engineer-supervisor-test-integrity" ||
              baselineBytes.byteLength !== baselineArtifact.sizeBytes || !matchesSha256Bytes(baselineBytes, baselineArtifact.sha256) ||
              baseline.baselineHash !== comparison.baselineHash || baseline.runId !== input.runId ||
              baseline.manifestHash !== input.manifestHash ||
              baseline.baseCommitSha.toLowerCase() !== input.manifest.repository.baseCommitSha.toLowerCase()) {
            throw new IdempotencyConflictError(input.runId, `reviewer-evidence-baseline-binding:${evidence.evidenceId}`);
          }
          const attestationRows = this.db.query(`SELECT actor_type, actor_id, details_json FROM audit_events
            WHERE run_id = ? AND action = 'TEST_INTEGRITY_ATTESTED'
              AND json_extract(details_json, '$.artifactId') = ?
              AND julianday(created_at) IS NOT NULL AND julianday(created_at) <= julianday(?)`)
            .all(input.runId, evidence.evidenceId, input.createdAt) as Array<{
                actor_type: string; actor_id: string; details_json: string;
              }>;
          const expectedAttestation = {
            artifactId: evidence.evidenceId, comparisonHash: comparison.comparisonHash,
            baselineHash: comparison.baselineHash, stage: comparison.stage, passed: comparison.passed,
          };
          const latestForStage = this.db.query(`SELECT a.id FROM artifacts a
            JOIN audit_events e ON e.run_id = a.run_id AND e.action = 'TEST_INTEGRITY_ATTESTED'
              AND json_extract(e.details_json, '$.artifactId') = a.id
            WHERE a.run_id = ? AND a.type = 'TEST_INTEGRITY_COMPARISON' AND a.trusted = 1
              AND a.producer_type = 'SYSTEM' AND a.producer_id = 'engineer-supervisor-test-integrity'
              AND json_extract(e.details_json, '$.baselineHash') = ?
              AND json_extract(e.details_json, '$.stage') = ?
              AND julianday(a.created_at) IS NOT NULL AND julianday(e.created_at) IS NOT NULL
              AND julianday(a.created_at) <= julianday(?) AND julianday(e.created_at) <= julianday(?)
            ORDER BY julianday(a.created_at) DESC, a.rowid DESC LIMIT 1`).get(
              input.runId, comparison.baselineHash, comparison.stage, input.createdAt, input.createdAt,
            ) as { id: string } | null;
          if (attestationRows.length !== 1 || attestationRows[0]!.actor_type !== "SUPERVISOR" ||
              attestationRows[0]!.actor_id !== "engineer-supervisor-test-integrity" ||
              canonicalJson(JSON.parse(attestationRows[0]!.details_json)) !== canonicalJson(expectedAttestation) ||
              latestForStage?.id !== evidence.evidenceId) {
            throw new IdempotencyConflictError(input.runId, `reviewer-evidence-integrity-generation:${evidence.evidenceId}`);
          }
          break;
        }
        case "SECURITY_REPORT":
          if (evidence.producerType !== "SYSTEM" || evidence.producerId !== "deterministic-security-scanner" ||
              evidence.payload.runId !== input.runId || evidence.payload.diffHash !== input.diffHash ||
              evidence.payload.policyVersion !== contract.policyBindings.securityPolicyVersion ||
              !Array.isArray(evidence.payload.findings)) {
            throw new IdempotencyConflictError(input.runId, `reviewer-evidence-security-binding:${evidence.evidenceId}`);
          }
          {
            const reportFindings = SecurityFindingRecordSchema.array().parse(evidence.payload.findings);
            let expectedId = 0;
            const expectedFindings = scanDiffForSecurity({
              runId: input.runId, diff: input.finalDiff, createdAt: input.createdAt,
              idFactory: () => `semantic-${++expectedId}`,
            });
            if (canonicalJson(reportFindings.map(securityFindingSemantics)) !==
                canonicalJson(expectedFindings.map(securityFindingSemantics))) {
              throw new IdempotencyConflictError(input.runId, `reviewer-evidence-security-semantics:${evidence.evidenceId}`);
            }
            for (const finding of reportFindings) {
              const durableRow = this.db.query(`SELECT * FROM security_findings
                WHERE id = ? AND run_id = ? AND julianday(created_at) IS NOT NULL
                  AND julianday(created_at) <= julianday(?)`)
                .get(finding.securityFindingId, input.runId, input.createdAt) as Record<string, unknown> | null;
              if (!durableRow) throw new IdempotencyConflictError(input.runId, `reviewer-evidence-security-row:${finding.securityFindingId}`);
              const durableFinding = SecurityFindingRecordSchema.parse({
                securityFindingId: durableRow.id, runId: durableRow.run_id, severity: durableRow.severity,
                category: durableRow.category, description: durableRow.description, file: durableRow.file,
                lineStart: durableRow.line_start, lineEnd: durableRow.line_end,
                evidenceIds: JSON.parse(String(durableRow.evidence_ids_json)), status: durableRow.status,
                createdAt: durableRow.created_at,
              });
              if (canonicalJson(durableFinding) !== canonicalJson(finding)) {
                throw new IdempotencyConflictError(input.runId, `reviewer-evidence-security-row:${finding.securityFindingId}`);
              }
            }
          }
          break;
        case "FINAL_CHANGE_SCOPE_ATTESTATION":
          {
            if (this.db.query(`SELECT 1 FROM git_operations WHERE run_id = ?
              AND julianday(started_at) IS NULL LIMIT 1`).get(input.runId)) {
              throw new IdempotencyConflictError(input.runId, "reviewer-evidence-time:git-operation");
            }
            const gitCount = this.db.query(`SELECT COUNT(*) AS count FROM git_operations
              WHERE run_id = ? AND julianday(started_at) IS NOT NULL
                AND julianday(started_at) <= julianday(?)`).get(input.runId, input.createdAt) as { count: number };
            const expectedScope = buildFinalChangeScopeAttestation({
              manifest: input.manifest, diff: input.finalDiff, resultCommitSha: input.resultCommitSha,
              credentialedGitOperationCount: gitCount.count,
            });
          if (evidence.producerType !== "SYSTEM" || evidence.producerId !== "final-change-scope-policy" ||
              evidence.payload.runId !== input.runId || evidence.payload.diffHash !== input.diffHash ||
              evidence.payload.manifestHash !== input.manifestHash || evidence.payload.resultCommitSha !== input.resultCommitSha ||
              evidence.payload.policyVersion !== "final-change-scope-v1" ||
              canonicalJson(evidence.payload) !== canonicalJson(expectedScope)) {
            throw new IdempotencyConflictError(input.runId, `reviewer-evidence-scope-binding:${evidence.evidenceId}`);
          }
          }
          break;
        default:
          throw new IdempotencyConflictError(input.runId, `reviewer-evidence-type:${evidence.evidenceId}`);
      }
    }
    if (!integrityStages.has("PRE_REVIEW")) {
      throw new IdempotencyConflictError(input.runId, "reviewer-evidence-integrity:missing-pre-review");
    }
    return requiredTestGates;
  }

  nextReviewerAttempt(runId: string): number {
    this.getRun(runId);
    const row = this.db.query("SELECT COALESCE(MAX(attempt), 0) AS attempt FROM reviewer_sessions WHERE run_id = ?")
      .get(runId) as { attempt: number };
    return row.attempt + 1;
  }

  legacyReviewerPersistenceRecoveryCandidateForTest(runId: string): ReviewerPersistenceRecoveryCandidate | null {
    this.getRun(runId);
    const row = this.db.query(`
      SELECT a.id AS agent_execution_id, a.input_hash, a.model_tier,
        a.started_at, a.completed_at, a.output_artifact_id,
        m.resolved_model, m.cache_key, m.cache_hit
      FROM agent_executions a
      JOIN artifacts ar ON ar.id = a.output_artifact_id
      JOIN model_calls m ON m.agent_execution_id = a.id AND m.status = 'SUCCEEDED'
      LEFT JOIN reviewer_sessions rs ON rs.run_id = a.run_id AND rs.input_hash = a.input_hash
      WHERE a.run_id = ? AND a.role = 'REVIEWER' AND a.status = 'SUCCEEDED'
        AND ar.type = 'REVIEWER_OUTPUT' AND ar.producer_id = a.id AND rs.id IS NULL
      ORDER BY a.rowid DESC, m.rowid DESC
      LIMIT 1
    `).get(runId) as {
      agent_execution_id: string;
      input_hash: string;
      model_tier: "GPT-5.6_SOL";
      resolved_model: string;
      cache_key: string;
      cache_hit: number | null;
      started_at: string;
      completed_at: string;
      output_artifact_id: string;
    } | null;
    if (!row) return null;
    return {
      agentExecutionId: row.agent_execution_id,
      inputHash: row.input_hash,
      modelTier: row.model_tier,
      resolvedModel: row.resolved_model,
      cacheKey: row.cache_key,
      cacheHit: row.cache_hit === null ? null : row.cache_hit === 1,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      outputArtifactId: row.output_artifact_id,
    };
  }

  legacyRecordedReviewerOutputForTest(runId: string, outputArtifactId: string): RecordedReviewerOutput | null {
    this.getRun(runId);
    const row = this.db.query(`
      SELECT s.id AS reviewer_session_id, s.attempt, s.decision, s.diff_hash,
        s.evidence_bundle_hash, a.output_artifact_id
      FROM agent_executions a
      JOIN reviewer_sessions s ON s.run_id = a.run_id AND s.input_hash = a.input_hash
      JOIN artifacts ar ON ar.id = a.output_artifact_id
      WHERE a.run_id = ? AND a.role = 'REVIEWER' AND a.status = 'SUCCEEDED'
        AND a.output_artifact_id = ? AND ar.type = 'REVIEWER_OUTPUT'
        AND ar.producer_id = a.id
      ORDER BY s.rowid DESC
      LIMIT 1
    `).get(runId, outputArtifactId) as {
      reviewer_session_id: string;
      attempt: number;
      decision: RecordedReviewerOutput["decision"];
      diff_hash: string;
      evidence_bundle_hash: string;
      output_artifact_id: string;
    } | null;
    return row ? {
      reviewerSessionId: row.reviewer_session_id,
      attempt: row.attempt,
      decision: row.decision,
      diffHash: row.diff_hash,
      evidenceBundleHash: row.evidence_bundle_hash,
      outputArtifactId: row.output_artifact_id,
    } : null;
  }

  recordClaimEvidence(record: ClaimEvidenceRecord): ClaimEvidenceRecord {
    const parsed = ClaimEvidenceRecordSchema.parse(record);
    this.getRun(parsed.runId);
    const existing = this.db.query(`SELECT id, run_id, criterion_id, claim, status,
      evidence_ids_json, notes, created_at FROM claim_evidence WHERE id = ?`).get(parsed.claimId) as Record<string, unknown> | null;
    if (existing) {
      const current = ClaimEvidenceRecordSchema.parse({
        claimId: existing.id, runId: existing.run_id, criterionId: existing.criterion_id,
        claim: existing.claim, status: existing.status,
        evidenceIds: JSON.parse(String(existing.evidence_ids_json)), notes: existing.notes, createdAt: existing.created_at,
      });
      if (sha256(current) !== sha256(parsed)) throw new IdempotencyConflictError(parsed.runId, `claim:${parsed.claimId}`);
      return current;
    }
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
    const existing = this.db.query(`SELECT id, bundle_hash, manifest_json FROM evidence_bundles WHERE id = ?`)
      .get(parsed.evidenceBundleId) as Record<string, unknown> | null;
    if (existing) {
      const current = EvidenceBundleRecordSchema.parse({
        evidenceBundleId: existing.id,
        bundleHash: existing.bundle_hash,
        bundle: JSON.parse(String(existing.manifest_json)),
      });
      if (sha256(current) !== sha256(parsed)) {
        throw new IdempotencyConflictError(parsed.bundle.runId, `evidence-bundle:${parsed.evidenceBundleId}`);
      }
      return current;
    }
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

  private prePromotionEventChainSummary(
    runId: string,
    classificationCreatedAt: string,
    historical?: VerifiedCandidateCheckpoint["prePromotionEventChainSummary"],
  ): VerifiedCandidateCheckpointInput["prePromotionEventChainSummary"] {
    const run = this.getRun(runId);
    const rows = this.db.query(`SELECT * FROM run_state_events WHERE run_id = ?
      ${historical ? "AND sequence <= ?" : ""} ORDER BY sequence`)
      .all(...(historical ? [runId, historical.headSequence] : [runId])) as EventRow[];
    const events = rows.map(rowToEvent).map((event) => ({
      ...event,
      evidenceIds: [...event.evidenceIds].sort(compareCodeUnits),
    }));
    if (events.length === 0 || (!historical && (run.state !== "REVIEWING" || events.length !== run.stateVersion))) {
      throw new Error("verified candidate transition authority pre-promotion event chain is incomplete");
    }
    for (const [index, event] of events.entries()) {
      const expected = index + 1;
      const previous = index === 0 ? "REQUEST_RECEIVED" : events[index - 1]!.nextState;
      if (event.runId !== runId || event.sequence !== expected || event.stateVersion !== expected ||
          event.previousState !== previous || Date.parse(event.timestamp) > Date.parse(classificationCreatedAt)) {
        throw new Error("verified candidate transition authority pre-promotion event chain is discontinuous");
      }
    }
    const head = events.at(-1)!;
    if (head.nextState !== "REVIEWING") {
      throw new Error("verified candidate transition authority pre-promotion event chain must end at REVIEWING");
    }
    const summary = {
      eventCount: events.length,
      headEventId: head.eventId,
      headSequence: head.sequence,
      headStateVersion: head.stateVersion,
      chainHash: sha256(events),
    };
    if (historical && canonicalJson(summary) !== canonicalJson(historical)) {
      throw new Error("verified candidate transition authority pre-promotion event chain no longer matches its signed snapshot");
    }
    return summary;
  }

  private verifiedCandidateContent(
    input: Omit<PromoteVerifiedCandidateInput, "attestor">,
    historicalCheckpoint?: VerifiedCandidateCheckpoint | VerifiedHardeningCandidateCheckpoint,
    readArtifact?:ArtifactByteReader,
  ): VerifiedCandidateCheckpointInput {
    const run = this.getRun(input.runId);
    if (!run.manifestHash) throw new Error("verified candidate requires a frozen manifest");
    const manifest = this.getManifest(input.runId);
    if (!manifest || manifest.manifestHash !== run.manifestHash) throw new Error("verified candidate manifest authority mismatch");
    const contract = this.getRequiredLaneContract(input.runId, run.manifestHash);
    if (!contract || contract.schemaVersion !== 2) throw new Error("verified candidate requires the exact current Required Lane contract");
    const classification = this.getReviewClassification(input.reviewerSessionId,readArtifact);
    if (!classification || classification.classificationHash !== input.classificationHash ||
        classification.runId !== input.runId || classification.manifestHash !== run.manifestHash ||
        classification.contractHash !== contract.contractHash ||
        !["READY", "READY_WITH_ADVISORIES"].includes(classification.result)) {
      throw new Error(`verified candidate classification authority mismatch: ${classification?.result ?? "missing"}`);
    }
    const latestRows = this.db.query(`SELECT b.reviewer_session_id, s.attempt
      FROM review_classification_batches b JOIN reviewer_sessions s ON s.id = b.reviewer_session_id
      WHERE b.run_id = ? ORDER BY s.attempt DESC`).all(input.runId) as Array<{ reviewer_session_id: string; attempt: number }>;
    if (latestRows.length === 0 || latestRows[0]!.reviewer_session_id !== input.reviewerSessionId ||
        latestRows.filter((row) => row.attempt === latestRows[0]!.attempt).length !== 1) {
      throw new Error("verified candidate requires the unique latest classified Reviewer session");
    }
    const reviewerRow = this.db.query(`SELECT s.*, b.reviewer_input_json FROM reviewer_sessions s
      JOIN review_classification_batches b ON b.reviewer_session_id = s.id WHERE s.id = ? AND s.run_id = ?`)
      .get(input.reviewerSessionId, input.runId) as Record<string, unknown> | null;
    if (!reviewerRow || reviewerRow.isolation_verified !== 1 || reviewerRow.decision !== "APPROVE" ||
        reviewerRow.manifest_hash !== run.manifestHash) {
      throw new Error("verified candidate Reviewer authority mismatch");
    }
    const reviewerInput = ReviewerInputSchema.parse(JSON.parse(String(reviewerRow.reviewer_input_json)));
    if (reviewerInput.diffHash !== reviewerRow.diff_hash) {
      throw new Error("verified candidate Reviewer input binding mismatch");
    }

    const bundleRow = this.db.query("SELECT * FROM evidence_bundles WHERE id = ? AND run_id = ?")
      .get(input.evidenceBundleId, input.runId) as Record<string, unknown> | null;
    if (!bundleRow) throw new EngineerNotFoundError("evidence bundle", input.evidenceBundleId);
    const evidenceBundle = EvidenceBundleRecordSchema.parse({
      evidenceBundleId: bundleRow.id,
      bundleHash: bundleRow.bundle_hash,
      bundle: JSON.parse(String(bundleRow.manifest_json)),
    });
    const bundle = evidenceBundle.bundle;
    const boundBundleIds = (this.db.query("SELECT id, manifest_json FROM evidence_bundles WHERE run_id = ?")
      .all(input.runId) as Array<{ id: string; manifest_json: string }>).flatMap((candidate) => {
        try {
          const parsed = EvidenceBundleRecordSchema.shape.bundle.parse(JSON.parse(candidate.manifest_json));
          return parsed.bundleVersion === 2 && parsed.reviewerSessionId === input.reviewerSessionId &&
            parsed.classificationHash === classification.classificationHash && parsed.classificationResult === classification.result
            ? [candidate.id] : [];
        } catch { return []; }
      });
    if (boundBundleIds.length !== 1 || boundBundleIds[0] !== input.evidenceBundleId) {
      throw new Error("verified candidate requires one exact classified Evidence Bundle v2");
    }
    if (canonicalJson(bundle) !== String(bundleRow.manifest_json) || evidenceBundle.bundleHash !== sha256(bundle) ||
        bundle.bundleVersion !== 2 || bundle.reviewerSessionId !== input.reviewerSessionId ||
        bundle.classificationHash !== classification.classificationHash || bundle.classificationResult !== classification.result ||
        bundle.runId !== input.runId || bundle.manifestHash !== run.manifestHash ||
        bundle.baseCommitSha !== run.repository.baseCommitSha || bundle.resultCommitSha !== reviewerInput.resultCommitSha ||
        bundle.finalDecision !== "APPROVE" || bundleRow.manifest_hash !== bundle.manifestHash ||
        bundleRow.base_commit_sha !== bundle.baseCommitSha || bundleRow.result_commit_sha !== bundle.resultCommitSha ||
        bundleRow.environment_digest !== bundle.environmentDigest || bundleRow.final_decision !== bundle.finalDecision ||
        bundleRow.created_at !== bundle.createdAt) {
      throw new Error("verified candidate Evidence Bundle v2 binding mismatch");
    }
    for (const bundled of bundle.artifacts) {
      const row = this.db.query("SELECT * FROM artifacts WHERE id = ? AND run_id = ?")
        .get(bundled.artifactId, input.runId) as Record<string, unknown> | null;
      if (!row) throw new Error(`verified candidate bundled artifact is missing: ${bundled.artifactId}`);
      const artifact = this.artifactFromRow(row);
      if (artifact.type !== bundled.type || artifact.sha256 !== bundled.sha256 || artifact.createdAt !== bundled.createdAt ||
          artifact.producerId !== bundled.producer || artifact.sizeBytes !== bundled.sizeBytes ||
          (!readArtifact&&(!existsSync(artifact.storageReference)||!lstatSync(artifact.storageReference).isFile()||
          lstatSync(artifact.storageReference).isSymbolicLink()))) {
        throw new Error(`verified candidate bundled artifact binding mismatch: ${bundled.artifactId}`);
      }
      const bytes = readArtifact?readArtifact(artifact):readFileSync(artifact.storageReference);
      if (bytes.byteLength !== artifact.sizeBytes || !matchesSha256Bytes(bytes, artifact.sha256)) {
        throw new Error(`verified candidate bundled artifact bytes mismatch: ${bundled.artifactId}`);
      }
    }

    const allClaims = this.listClaimEvidence(input.runId);
    const claims = (historicalCheckpoint
      ? allClaims.filter((claim) => historicalCheckpoint.claimSummary.claimIds.includes(claim.claimId))
      : allClaims).sort((left, right) => compareCodeUnits(left.claimId, right.claimId));
    if (historicalCheckpoint && claims.length !== historicalCheckpoint.claimSummary.claimIds.length) {
      throw new Error("verified candidate referenced durable claim is missing");
    }
    const projectedClaims = claims.map(({ claimId, claim, status, evidenceIds, notes }) =>
      ({ claimId, claim, status, evidenceIds, notes }));
    if (canonicalJson(projectedClaims) !== canonicalJson([...bundle.claims].sort((left, right) => compareCodeUnits(left.claimId, right.claimId)))) {
      throw new Error("verified candidate durable claims do not match Evidence Bundle v2");
    }
    for (const criterionId of contract.requiredCriterionIds) {
      if (!claims.some((claim) => claim.criterionId === criterionId && claim.status === "VERIFIED")) {
        throw new Error(`verified candidate required claim is not verified: ${criterionId}`);
      }
    }

    const gates = [...classification.requiredTestGates].sort((left, right) => compareCodeUnits(left.testId, right.testId));
    if (canonicalJson(gates.map((gate) => gate.testId)) !== canonicalJson([...contract.requiredTestIds].sort(compareCodeUnits)) ||
        gates.some((gate) => gate.status !== "PASSED" || !gate.evidenceId)) {
      throw new Error("verified candidate required-test classification is not fully passed");
    }
    const verificationAuthorities = gates.map((gate) => {
      const rows = this.db.query(`SELECT t.*, c.environment_digest, c.commit_sha, c.command,
        c.sandbox_id, c.executor_id, c.exit_code, c.status AS command_status,
        c.started_at AS command_started_at, c.finished_at, c.stdout_artifact_id,
        c.stderr_artifact_id, c.idempotency_key AS command_idempotency_key, a.details_json,
        a.id AS audit_id,
        a.actor_type AS audit_actor_type, a.actor_id AS audit_actor_id, a.created_at AS audit_created_at
        FROM test_executions t
        JOIN command_executions c ON c.id = t.command_execution_id AND c.run_id = t.run_id
        JOIN audit_events a ON a.run_id = t.run_id AND a.action = 'VERIFICATION_EXECUTED'
          AND json_extract(a.details_json, '$.verificationExecutionId') = t.id
        WHERE t.id = ? AND t.run_id = ?`).all(gate.evidenceId!, input.runId) as Array<Record<string, unknown>>;
      if (rows.length !== 1) throw new Error(`verified candidate required-test evidence is not unique: ${gate.testId}`);
      const row = rows[0]!;
      const planItem = manifest.testPlan.find((item) => item.testId === gate.testId);
      if (!planItem?.command) throw new Error(`verified candidate required test plan is missing: ${gate.testId}`);
      const expectedAuditDetails = {
        verificationExecutionId: row.id,
        testId: gate.testId,
        criterionIds: planItem.criterionIds,
        commandExecutionId: row.command_execution_id,
        type: row.type,
        status: row.status,
      };
      let details: unknown;
      try { details = JSON.parse(String(row.details_json)); } catch { details = null; }
      if (String(row.details_json) !== canonicalJson(expectedAuditDetails) || canonicalJson(details) !== canonicalJson(expectedAuditDetails) ||
          row.audit_actor_type !== "EXECUTOR" || row.audit_actor_id !== row.executor_id ||
          row.audit_created_at !== row.completed_at || row.command !== planItem.command ||
          row.type !== planItem.type || row.status !== "PASSED" || row.command_status !== "SUCCEEDED" ||
          row.completed_at !== row.finished_at || row.commit_sha !== bundle.resultCommitSha ||
          row.environment_digest !== bundle.environmentDigest) {
        throw new Error(`verified candidate required-test binding mismatch: ${gate.testId}`);
      }
      const commandArtifact = (artifactId: unknown) => {
        const artifactRow = this.db.query("SELECT * FROM artifacts WHERE id = ? AND run_id = ?")
          .get(String(artifactId), input.runId) as Record<string, unknown> | null;
        if (!artifactRow) throw new Error(`verified candidate command artifact is missing: ${String(artifactId)}`);
        const artifact = this.artifactFromRow(artifactRow);
        if (!readArtifact&&!existsSync(artifact.storageReference)) throw new Error("verified candidate command artifact bytes are missing");
        const stat = readArtifact?null:lstatSync(artifact.storageReference);
        const bytes = readArtifact?readArtifact(artifact):readFileSync(artifact.storageReference);
        if ((stat&&(!stat.isFile()||stat.isSymbolicLink())) || bytes.byteLength !== artifact.sizeBytes ||
            !matchesSha256Bytes(bytes, artifact.sha256)) {
          throw new Error("verified candidate command artifact authority is invalid");
        }
        return artifact;
      };
      const stdoutArtifact = commandArtifact(row.stdout_artifact_id);
      const stderrArtifact = commandArtifact(row.stderr_artifact_id);
      const commandRecord = CommandExecutionRecordSchema.parse({
        commandExecutionId: row.command_execution_id, runId: input.runId, sandboxId: row.sandbox_id,
        command: row.command, executorId: row.executor_id, exitCode: row.exit_code,
        timedOut: false, startedAt: row.command_started_at,
        finishedAt: row.finished_at, stdoutArtifact, stderrArtifact,
        environmentDigest: row.environment_digest, commitSha: row.commit_sha,
        status: row.command_status, idempotencyKey: row.command_idempotency_key,
      });
      const cutoff = Date.parse(classification.createdAt);
      const authorityTimes = [row.started_at, row.completed_at, row.command_started_at, row.finished_at,
        row.audit_created_at, stdoutArtifact.createdAt, stderrArtifact.createdAt].map((value) => Date.parse(String(value)));
      if (!Number.isFinite(cutoff) || authorityTimes.some((value) => !Number.isFinite(value) || value > cutoff)) {
        throw new Error(`verified candidate required-test authority postdates classification: ${gate.testId}`);
      }
      if (!historicalCheckpoint) {
        const currentPassRows = this.db.query(`SELECT COUNT(DISTINCT newer.id) AS count FROM test_executions newer
          JOIN audit_events audit ON audit.run_id = newer.run_id AND audit.action = 'VERIFICATION_EXECUTED'
            AND json_extract(audit.details_json, '$.verificationExecutionId') = newer.id
          WHERE newer.run_id = ? AND json_extract(audit.details_json, '$.testId') = ?
            AND newer.verification_pass >= ?`).get(input.runId, gate.testId, Number(row.verification_pass)) as { count: number };
        if (currentPassRows.count !== 1) {
          throw new Error(`verified candidate required-test evidence is not the unique latest pass: ${gate.testId}`);
        }
      }
      const record = VerificationExecutionRecordSchema.parse({
        verificationExecutionId: row.id, runId: row.run_id, verificationPass: row.verification_pass,
        testId: gate.testId, commandExecutionId: row.command_execution_id,
        criterionIds: planItem.criterionIds, type: row.type, randomSeed: row.random_seed,
        status: row.status, startedAt: row.started_at, completedAt: row.completed_at,
      });
      return {
        record,
        provenance: {
          verification: record,
          command: commandRecord,
          audit: {
            auditEventId: row.audit_id,
            actorType: row.audit_actor_type,
            actorId: row.audit_actor_id,
            detailsJson: row.details_json,
            createdAt: row.audit_created_at,
          },
        },
      };
    }).sort((left, right) => compareCodeUnits(left.record.verificationExecutionId, right.record.verificationExecutionId));
    const verificationRecords = verificationAuthorities.map((authority) => authority.record);
    if (new Set(verificationRecords.map((record) => record.verificationPass)).size !== 1) {
      throw new Error("verified candidate required tests do not share one verification pass");
    }

    const allSecurityFindings = this.listSecurityFindings(input.runId);
    const securityFindings = (historicalCheckpoint
      ? allSecurityFindings.filter((finding) => historicalCheckpoint.securitySummary.findingIds.includes(finding.securityFindingId))
      : allSecurityFindings)
      .sort((left, right) => compareCodeUnits(left.securityFindingId, right.securityFindingId));
    if (historicalCheckpoint && securityFindings.length !== historicalCheckpoint.securitySummary.findingIds.length) {
      throw new Error("verified candidate referenced security finding is missing");
    }
    const openCritical = securityFindings.filter((finding) => finding.severity === "CRITICAL" && finding.status === "OPEN" &&
      !finding.category.startsWith("AI_ADVISORY_")).length;
    if (openCritical !== 0) throw new Error("verified candidate has an open blocking critical security finding");

    const scopeEvidence = reviewerInput.trustedEvidence.filter((evidence) => evidence.eventType === "FINAL_CHANGE_SCOPE_ATTESTATION");
    if (scopeEvidence.length !== 1) throw new Error("verified candidate requires exactly one final scope attestation");
    const scope = scopeEvidence[0]!;
    const scopeRow = this.db.query("SELECT * FROM artifacts WHERE id = ? AND run_id = ? AND type = 'FINAL_CHANGE_SCOPE_ATTESTATION'")
      .get(scope.evidenceId, input.runId) as Record<string, unknown> | null;
    if (!scopeRow) throw new Error("verified candidate final scope artifact is missing");
    const scopeArtifact = this.artifactFromRow(scopeRow);
    const scopeBytes = readArtifact?readArtifact(scopeArtifact):readFileSync(scopeArtifact.storageReference);
    const scopePayload = FinalChangeScopeAttestationSchema.parse(JSON.parse(scopeBytes.toString("utf8")));
    if (!scopeArtifact.trusted || scopeArtifact.producerType !== "SYSTEM" || scopeArtifact.producerId !== "final-change-scope-policy" ||
        scopeBytes.byteLength !== scopeArtifact.sizeBytes || !matchesSha256Bytes(scopeBytes, scopeArtifact.sha256) ||
        scopeArtifact.sha256 !== scope.sha256 || scopePayload.status !== "SUCCEEDED" || scopePayload.violations.length !== 0 ||
        scopePayload.credentialedGitOperationCount !== 0 || scopePayload.runId !== input.runId ||
        scopePayload.manifestHash !== run.manifestHash || scopePayload.diffHash !== reviewerInput.diffHash ||
        scopePayload.resultCommitSha !== bundle.resultCommitSha) {
      throw new Error("verified candidate final scope binding mismatch");
    }
    if (!bundle.artifacts.some((artifact) => artifact.artifactId === scopeArtifact.artifactId && artifact.sha256 === scopeArtifact.sha256)) {
      throw new Error("verified candidate Evidence Bundle does not include the final scope artifact");
    }

    const allBuilderRows = this.db.query(`SELECT a.id, a.input_hash, a.model_tier, a.status, a.output_artifact_id,
      a.started_at, a.completed_at,
      d.worker_owner_id, d.worker_fencing_token, d.input_hash AS claim_input_hash, d.agent_execution_id AS claim_agent_id
      FROM agent_executions a LEFT JOIN builder_dispatch_claims d
        ON d.agent_execution_id = a.id AND d.run_id = a.run_id
      WHERE a.run_id = ? AND a.role = 'BUILDER' ORDER BY a.id`).all(input.runId) as Array<Record<string, unknown>>;
    const builderRows = historicalCheckpoint
      ? allBuilderRows.filter((row) => historicalCheckpoint.builderDispatchSummary.claims
        .some((claim) => claim.agentExecutionId === row.id && claim.inputHash === row.input_hash))
      : allBuilderRows;
    if (historicalCheckpoint && builderRows.length !== historicalCheckpoint.builderDispatchSummary.claims.length) {
      throw new Error("verified candidate referenced Builder execution is missing");
    }
    const dispatchCount = this.db.query("SELECT COUNT(*) AS count FROM builder_dispatch_claims WHERE run_id = ?")
      .get(input.runId) as { count: number };
    if (builderRows.length === 0 || (!historicalCheckpoint && dispatchCount.count !== builderRows.length)) {
      throw new Error("verified candidate Builder dispatch coverage is incomplete");
    }
    const successfulBuilderResults: Array<{ agentExecutionId: string; completedAt: string; diffHash: string }> = [];
    const classificationCreatedAt = Date.parse(classification.createdAt);
    if (!Number.isFinite(classificationCreatedAt)) {
      throw new Error("verified candidate classification time is invalid");
    }
    const builderClaims = builderRows.map((row) => {
      let outputArtifactAuthority: {
        artifactId: string; sha256: string; sizeBytes: number; createdAt: string;
        type: "BUILDER_RESULT" | "BUILDER_REPAIR_RESULT"; producerType: "SYSTEM";
        producerId: string; trusted: false; regularFile: true; symbolicLink: false;
      } | null = null;
      AgentExecutionRecordSchema.parse({
        agentExecutionId: row.id, runId: input.runId, role: "BUILDER", modelTier: row.model_tier,
        status: row.status, inputHash: row.input_hash, outputArtifactId: row.output_artifact_id,
        startedAt: row.started_at, completedAt: row.completed_at,
      });
      if (!row.completed_at || Date.parse(String(row.completed_at)) < Date.parse(String(row.started_at)) ||
          Date.parse(String(row.completed_at)) > classificationCreatedAt) {
        throw new Error("verified candidate Builder terminal completion time is invalid");
      }
      if (!row.claim_agent_id || row.input_hash !== row.claim_input_hash || row.model_tier !== "GPT-5.6_TERRA") {
        throw new Error("verified candidate Builder execution does not match its dispatch claim");
      }
      if (row.status === "SUCCEEDED") {
        const outputRow = this.db.query("SELECT * FROM artifacts WHERE id = ? AND run_id = ?")
          .get(String(row.output_artifact_id), input.runId) as Record<string, unknown> | null;
        if (!outputRow) throw new Error("verified candidate successful Builder output is missing");
        const output = this.artifactFromRow(outputRow);
        const expectedProducer = output.type === "BUILDER_RESULT" ? "codex-builder-adapter" : String(row.id);
        if (!["BUILDER_RESULT", "BUILDER_REPAIR_RESULT"].includes(output.type) || output.producerType !== "SYSTEM" ||
            output.producerId !== expectedProducer || output.trusted || output.sizeBytes <= 0 ||
            (!readArtifact&&!existsSync(output.storageReference))) {
          throw new Error("verified candidate successful Builder output provenance is invalid");
        }
        const stat = readArtifact?null:lstatSync(output.storageReference);
        if (stat&&(!stat.isFile() || stat.isSymbolicLink())) {
          throw new Error("verified candidate successful Builder output is not a regular file");
        }
        const bytes = readArtifact?readArtifact(output):readFileSync(output.storageReference);
        if (bytes.byteLength !== output.sizeBytes || !matchesSha256Bytes(bytes, output.sha256)) {
          throw new Error("verified candidate successful Builder output bytes are invalid");
        }
        outputArtifactAuthority = {
          artifactId: output.artifactId,
          sha256: output.sha256,
          sizeBytes: output.sizeBytes,
          createdAt: output.createdAt,
          type: output.type as "BUILDER_RESULT" | "BUILDER_REPAIR_RESULT",
          producerType: "SYSTEM",
          producerId: output.producerId,
          trusted: false,
          regularFile: true,
          symbolicLink: false,
        };
        let result;
        try { result = BuilderResultSchema.parse(JSON.parse(bytes.toString("utf8"))); } catch {
          throw new Error("verified candidate successful Builder output payload is invalid");
        }
        const startedAt = Date.parse(String(row.started_at));
        const completedAt = Date.parse(String(row.completed_at));
        const resultCompletedAt = Date.parse(result.completedAt);
        const artifactCreatedAt = Date.parse(output.createdAt);
        if (result.runId !== input.runId || result.manifestHash !== run.manifestHash ||
            result.diffHash !== sha256(result.diff) || !Number.isFinite(startedAt) || !Number.isFinite(completedAt) ||
            !Number.isFinite(resultCompletedAt) || !Number.isFinite(artifactCreatedAt) || completedAt < startedAt ||
            artifactCreatedAt !== completedAt || resultCompletedAt < startedAt ||
            result.completedAt !== String(row.completed_at)) {
          throw new Error("verified candidate successful Builder output payload binding is invalid");
        }
        successfulBuilderResults.push({
          agentExecutionId: String(row.id), completedAt: String(row.completed_at), diffHash: result.diffHash,
        });
      }
      return BuilderDispatchCheckpointClaimSchema.parse({
        inputHash: row.input_hash, agentExecutionId: row.id, modelTier: row.model_tier,
        workerOwnerId: row.worker_owner_id, workerFencingToken: row.worker_fencing_token,
        status: row.status, outputArtifactId: row.output_artifact_id,
        startedAt: row.started_at, completedAt: row.completed_at, outputArtifactAuthority,
      });
    }).sort((left, right) => compareCodeUnits(`${left.inputHash}\u0000${left.agentExecutionId}`, `${right.inputHash}\u0000${right.agentExecutionId}`));
    if (!builderClaims.some((claim) => claim.status === "SUCCEEDED")) {
      throw new Error("verified candidate requires at least one successful Builder execution");
    }
    const latestBuilderTime = Math.max(...successfulBuilderResults.map((result) => Date.parse(result.completedAt)));
    const latestBuilderResults = successfulBuilderResults.filter((result) => Date.parse(result.completedAt) === latestBuilderTime);
    if (latestBuilderResults.length !== 1 || latestBuilderResults[0]!.diffHash !== reviewerInput.diffHash) {
      throw new Error("verified candidate latest successful Builder output does not bind the reviewed diff");
    }

    return {
      schemaVersion: 1, policyVersion: "verified-candidate-checkpoint-v1", parentCheckpointId: null,
      runId: input.runId, requesterUserId: run.userId, repositoryId: run.repository.repositoryId,
      requiredLaneContractHash: contract.contractHash, manifestHash: run.manifestHash,
      baseCommitSha: run.repository.baseCommitSha, resultCommitSha: bundle.resultCommitSha,
      diffHash: reviewerInput.diffHash, reviewerSessionId: input.reviewerSessionId,
      classificationHash: classification.classificationHash, classificationResult: classification.result as "READY" | "READY_WITH_ADVISORIES",
      evidenceBundleId: evidenceBundle.evidenceBundleId, evidenceBundleHash: evidenceBundle.bundleHash,
      claimSummary: { claimIds: claims.map((claim) => claim.claimId), claimSetHash: sha256(claims) },
      verificationSummary: {
        verificationPass: verificationRecords[0]!.verificationPass,
        testExecutionIds: verificationRecords.map((record) => record.verificationExecutionId),
        testExecutionSetHash: sha256(verificationRecords),
        provenanceEventIds: verificationAuthorities.map((authority) => String(authority.provenance.audit.auditEventId))
          .sort(compareCodeUnits),
        provenanceHash: sha256(verificationAuthorities.map((authority) => authority.provenance)),
        allRequiredChecksPassed: true,
      },
      securitySummary: {
        findingIds: securityFindings.map((finding) => finding.securityFindingId),
        findingSetHash: sha256(securityFindings), openBlockingCriticalCount: 0,
      },
      scopeSummary: { artifactId: scopeArtifact.artifactId, artifactHash: scopeArtifact.sha256, policyVersion: "final-change-scope-v1" },
      environmentDigest: bundle.environmentDigest,
      builderDispatchSummary: { claims: builderClaims, claimSetHash: sha256(builderClaims) },
      prePromotionEventChainSummary: this.prePromotionEventChainSummary(
        input.runId,
        classification.createdAt,
        historicalCheckpoint?.prePromotionEventChainSummary,
      ),
      createdAt: classification.createdAt,
    };
  }

  async promoteVerifiedCandidate(
    input: PromoteVerifiedCandidateInput,
    expectedStateVersion: number,
  ): Promise<VerifiedCandidatePromotionResult> {
    // P7 fail-closed gate: a replacement run may never be promoted to
    // REVIEW_APPROVED unless its complete resolution lineage verifies.
    this.assertReplacementLineageAuthority(input.runId);
    const priorEvents = this.db.query(`SELECT * FROM run_state_events WHERE run_id = ?
      AND reason_code = 'VERIFIED_CANDIDATE_PROMOTED' AND next_state = 'REVIEW_APPROVED'`).all(input.runId) as EventRow[];
    if (priorEvents.length > 0) {
      if (priorEvents.length !== 1) throw new Error("verified candidate promotion authority is ambiguous");
      const event = rowToEvent(priorEvents[0]!);
      if (event.evidenceIds.length !== 1) throw new Error("verified candidate transition authority is malformed");
      const existing = await this.getVerifiedCandidateCheckpoint({ checkpointId: event.evidenceIds[0]! }, input.attestor);
      if (!existing || existing.checkpoint.reviewerSessionId !== input.reviewerSessionId ||
          existing.checkpoint.classificationHash !== input.classificationHash ||
          existing.checkpoint.evidenceBundleId !== input.evidenceBundleId ||
          existing.attestation.algorithm !== input.attestor.algorithm || existing.attestation.keyId !== input.attestor.keyId) {
        throw new IdempotencyConflictError(input.runId, "verified-candidate-promotion");
      }
      this.assertAdvisoryMaterialization(existing.checkpoint);
      return { ...existing, applied: false };
    }
    const snapshotRun = this.getRun(input.runId);
    if (snapshotRun.stateVersion !== expectedStateVersion) {
      throw new StateVersionConflictError(input.runId, expectedStateVersion, snapshotRun.stateVersion);
    }
    if (snapshotRun.state !== "REVIEWING") throw new InvalidTransitionError("verified candidate promotion requires REVIEWING");
    const snapshotContent = this.verifiedCandidateContent(input);
    const created = await createVerifiedCandidateCheckpoint(snapshotContent, input.attestor);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const eventRows = this.db.query(`SELECT * FROM run_state_events WHERE run_id = ?
        AND reason_code = 'VERIFIED_CANDIDATE_PROMOTED' AND next_state = 'REVIEW_APPROVED'`).all(input.runId) as EventRow[];
      if (eventRows.length > 0) {
        if (eventRows.length !== 1) throw new Error("verified candidate promotion authority is ambiguous");
        const event = rowToEvent(eventRows[0]!);
        if (event.evidenceIds.length !== 1) throw new Error("verified candidate transition authority is malformed");
        const row = this.db.query(`SELECT reviewer_session_id, classification_hash, evidence_bundle_id,
          signature_algorithm, signature_key_id FROM verified_candidate_checkpoints WHERE id = ?`)
          .get(event.evidenceIds[0]!) as Record<string, unknown> | null;
        if (!row || row.reviewer_session_id !== input.reviewerSessionId || row.classification_hash !== input.classificationHash ||
            row.evidence_bundle_id !== input.evidenceBundleId ||
            row.signature_algorithm !== input.attestor.algorithm || row.signature_key_id !== input.attestor.keyId) {
          throw new IdempotencyConflictError(input.runId, "verified-candidate-promotion");
        }
        this.db.exec("COMMIT");
        const existing = await this.getVerifiedCandidateCheckpoint({ checkpointId: event.evidenceIds[0]! }, input.attestor);
        if (!existing) throw new Error("verified candidate replay checkpoint disappeared");
        this.assertAdvisoryMaterialization(existing.checkpoint);
        return { ...existing, applied: false };
      }
      const run = this.getRun(input.runId);
      if (run.stateVersion !== expectedStateVersion) {
        throw new StateVersionConflictError(input.runId, expectedStateVersion, run.stateVersion);
      }
      if (run.state !== "REVIEWING") throw new InvalidTransitionError("verified candidate promotion requires REVIEWING");
      const lockedContent = this.verifiedCandidateContent(input);
      if (canonicalJson(lockedContent) !== canonicalJson(snapshotContent)) {
        throw new IdempotencyConflictError(input.runId, "verified-candidate-authority-changed");
      }
      const { checkpoint, attestation } = created;
      this.db.query(`INSERT INTO verified_candidate_checkpoints
        (id, checkpoint_hash, parent_checkpoint_id, run_id, requester_user_id, repository_id,
         required_lane_contract_hash, manifest_hash, base_commit_sha, result_commit_sha, diff_hash,
         reviewer_session_id, classification_hash, classification_result, evidence_bundle_id,
         evidence_bundle_hash, environment_digest, checkpoint_json, statement_json, statement_hash,
         signature_algorithm, signature_key_id, signature, created_at)
        VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          checkpoint.checkpointId, checkpoint.checkpointHash, checkpoint.runId, checkpoint.requesterUserId,
          checkpoint.repositoryId, checkpoint.requiredLaneContractHash, checkpoint.manifestHash,
          checkpoint.baseCommitSha, checkpoint.resultCommitSha, checkpoint.diffHash, checkpoint.reviewerSessionId,
          checkpoint.classificationHash, checkpoint.classificationResult, checkpoint.evidenceBundleId,
          checkpoint.evidenceBundleHash, checkpoint.environmentDigest, canonicalJson(checkpoint),
          attestation.statementJson, attestation.statementHash, attestation.algorithm, attestation.keyId,
          attestation.signature, checkpoint.createdAt,
        );
      this.materializeAdvisoryBacklog(checkpoint);
      const command: LedgerTransitionCommand = {
        runId: input.runId, expectedStateVersion, previousState: "REVIEWING", nextState: "REVIEW_APPROVED",
        reasonCode: "VERIFIED_CANDIDATE_PROMOTED", actorType: "SUPERVISOR", actorId: "engineer-supervisor",
        evidenceIds: [checkpoint.checkpointId], manifestHash: checkpoint.manifestHash,
        idempotencyKey: `verified-candidate:${checkpoint.checkpointId}`, eventId: checkpoint.checkpointId,
        timestamp: checkpoint.createdAt, terminalAt: null,
      };
      const event = this.insertStateEvent(command, expectedStateVersion + 1);
      if (event.evidenceIds.length !== 1 || event.evidenceIds[0] !== checkpoint.checkpointId) {
        throw new Error("verified candidate event authority mismatch");
      }
      const updated = this.db.query(`UPDATE engineer_runs SET state = 'REVIEW_APPROVED', state_version = ?, updated_at = ?
        WHERE id = ? AND state = 'REVIEWING' AND state_version = ?`).run(
          expectedStateVersion + 1, checkpoint.createdAt, input.runId, expectedStateVersion,
        );
      if (Number(updated.changes) !== 1) throw new StateVersionConflictError(input.runId, expectedStateVersion, this.getRun(input.runId).stateVersion);
      this.updateExecutionClockForTransition(input.runId, "REVIEWING", "REVIEW_APPROVED", checkpoint.createdAt);
      this.insertAudit(input.runId, "VERIFIED_CANDIDATE_PROMOTED", "SUPERVISOR", "engineer-supervisor", {
        checkpointId: checkpoint.checkpointId,
      }, checkpoint.createdAt);
      this.db.exec("COMMIT");
      const strict = await this.getVerifiedCandidateCheckpoint({ checkpointId: checkpoint.checkpointId }, input.attestor);
      if (!strict) throw new Error("verified candidate checkpoint disappeared after commit");
      return { ...strict, applied: true };
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* preserve promotion failure */ }
      throw error;
    }
  }

  private async hardeningPromotionAuthority(runId:string,attestor:CheckpointAttestor,
    readArtifact?:ArtifactByteReader):Promise<{
    lineage:EngineerRunLineage;operation:HardeningStartOperation;signedSeed:SignedHardeningSeedAttestation;
    parent:{checkpoint:VerifiedCandidateCheckpoint;attestation:SignedVerifiedCandidateAttestation};
  }>{
    const lineageRows=this.db.query("SELECT * FROM engineer_run_lineage WHERE child_run_id=?").all(runId) as Array<Record<string,unknown>>;
    if(lineageRows.length!==1)throw new HardeningAuthorityInvalidError();const lineage=this.hardeningLineageFromRow(lineageRows[0]!);
    const operationRow=this.db.query("SELECT * FROM hardening_start_operations WHERE child_run_id=? AND lineage_id=? AND lineage_hash=?")
      .get(runId,lineage.lineageId,lineage.lineageHash) as Record<string,unknown>|null;
    if(!operationRow)throw new HardeningAuthorityInvalidError();const operation=this.hardeningStartOperationFromRow(operationRow);
    const seedRow=this.db.query("SELECT * FROM hardening_seed_attestations WHERE operation_id=? AND operation_hash=?")
      .get(operation.operationId,operation.operationHash) as Record<string,unknown>|null;
    if(!seedRow)throw new HardeningAuthorityInvalidError();const signedSeed=this.hardeningSeedFromRow(seedRow);
    await verifySignedHardeningSeedAttestation(signedSeed,attestor);
    const parent=await this.getVerifiedCandidateCheckpoint({checkpointId:lineage.parentCheckpointId},attestor,true,readArtifact);
    if(!parent||parent.checkpoint.checkpointHash!==lineage.parentCheckpointHash||parent.checkpoint.runId!==lineage.parentRunId||
      parent.checkpoint.requesterUserId!==lineage.requesterUserId||parent.checkpoint.repositoryId!==lineage.repositoryId||
      operation.childRunId!==runId||operation.lineageId!==lineage.lineageId||operation.lineageHash!==lineage.lineageHash||
      signedSeed.attestation.childRunId!==runId||signedSeed.attestation.lineageId!==lineage.lineageId||
      signedSeed.attestation.lineageHash!==lineage.lineageHash||signedSeed.attestation.parentCheckpointId!==parent.checkpoint.checkpointId||
      signedSeed.attestation.parentCheckpointHash!==parent.checkpoint.checkpointHash)throw new HardeningAuthorityInvalidError();
    return {lineage,operation,signedSeed,parent};
  }

  private verifiedHardeningCandidateContent(input:PromoteVerifiedCandidateInput,authority:{lineage:EngineerRunLineage;
    signedSeed:SignedHardeningSeedAttestation;parent:{checkpoint:VerifiedCandidateCheckpoint}},
    historicalCheckpoint?:VerifiedHardeningCandidateCheckpoint,
    readArtifact?:ArtifactByteReader,
  ):VerifiedHardeningCandidateCheckpointInput{
    const legacy=this.verifiedCandidateContent(input,historicalCheckpoint,readArtifact??this.hardeningArtifactReader);
    const {schemaVersion:_schema,policyVersion:_policy,parentCheckpointId:_parent,...content}=legacy;
    return {...content,schemaVersion:2,policyVersion:"verified-hardening-candidate-checkpoint-v2",
      parentCheckpointId:authority.parent.checkpoint.checkpointId,parentCheckpointHash:authority.parent.checkpoint.checkpointHash,
      hardeningLineageId:authority.lineage.lineageId,hardeningLineageHash:authority.lineage.lineageHash,
      seedAttestationId:authority.signedSeed.attestation.seedAttestationId,
      seedAttestationHash:authority.signedSeed.attestation.seedAttestationHash};
  }

  async promoteVerifiedHardeningCandidate(input:PromoteVerifiedCandidateInput,expectedStateVersion:number,
    readArtifact?:ArtifactByteReader):Promise<VerifiedHardeningCandidatePromotionResult>{
    const strictReader=readArtifact??this.hardeningArtifactReader;
    if(!strictReader)throw new HardeningAuthorityInvalidError();
    const prior=this.db.query(`SELECT * FROM run_state_events WHERE run_id=? AND reason_code='HARDENING_CANDIDATE_VERIFIED'
      AND next_state='HUMAN_REVIEW_REQUIRED'`).all(input.runId) as EventRow[];
    if(prior.length){if(prior.length!==1)throw new Error("verified hardening candidate promotion authority is ambiguous");
      const event=rowToEvent(prior[0]!);if(event.evidenceIds.length!==1)throw new Error("verified hardening candidate transition authority is malformed");
      const existing=await this.getVerifiedHardeningCandidateCheckpoint({checkpointId:event.evidenceIds[0]!},input.attestor,strictReader);
      if(!existing||existing.checkpoint.reviewerSessionId!==input.reviewerSessionId||existing.checkpoint.classificationHash!==input.classificationHash||
        existing.checkpoint.evidenceBundleId!==input.evidenceBundleId||existing.attestation.algorithm!==input.attestor.algorithm||
        existing.attestation.keyId!==input.attestor.keyId)throw new IdempotencyConflictError(input.runId,"verified-hardening-candidate-promotion");
      return {...existing,applied:false};}
    const snapshot=this.getRun(input.runId);if(snapshot.stateVersion!==expectedStateVersion)
      throw new StateVersionConflictError(input.runId,expectedStateVersion,snapshot.stateVersion);
    if(snapshot.state!=="REVIEWING")throw new InvalidTransitionError("verified hardening candidate promotion requires REVIEWING");
    const authority=await this.hardeningPromotionAuthority(input.runId,input.attestor,strictReader);
    const snapshotContent=this.verifiedHardeningCandidateContent(input,authority,undefined,strictReader);
    const created=await createVerifiedHardeningCandidateCheckpoint(snapshotContent,input.attestor);
    this.db.exec("BEGIN IMMEDIATE");try{
      const events=this.db.query(`SELECT * FROM run_state_events WHERE run_id=? AND reason_code='HARDENING_CANDIDATE_VERIFIED'
        AND next_state='HUMAN_REVIEW_REQUIRED'`).all(input.runId) as EventRow[];
      if(events.length){if(events.length!==1)throw new Error("verified hardening candidate promotion authority is ambiguous");
        const event=rowToEvent(events[0]!);if(event.evidenceIds.length!==1)throw new Error("verified hardening candidate transition authority is malformed");
        this.db.exec("COMMIT");const existing=await this.getVerifiedHardeningCandidateCheckpoint({checkpointId:event.evidenceIds[0]!},input.attestor,strictReader);
        if(!existing||existing.checkpoint.reviewerSessionId!==input.reviewerSessionId||existing.checkpoint.classificationHash!==input.classificationHash||
          existing.checkpoint.evidenceBundleId!==input.evidenceBundleId||existing.attestation.algorithm!==input.attestor.algorithm||
          existing.attestation.keyId!==input.attestor.keyId)throw new IdempotencyConflictError(input.runId,"verified-hardening-candidate-promotion");
        return {...existing,applied:false};}
      const run=this.getRun(input.runId);if(run.stateVersion!==expectedStateVersion)
        throw new StateVersionConflictError(input.runId,expectedStateVersion,run.stateVersion);
      if(run.state!=="REVIEWING")throw new InvalidTransitionError("verified hardening candidate promotion requires REVIEWING");
      const currentLineageRow=this.db.query("SELECT * FROM engineer_run_lineage WHERE child_run_id=?").get(input.runId) as Record<string,unknown>|null;
      const currentOperationRow=this.db.query("SELECT * FROM hardening_start_operations WHERE child_run_id=?").get(input.runId) as Record<string,unknown>|null;
      const currentSeedRow=this.db.query("SELECT * FROM hardening_seed_attestations WHERE child_run_id=?").get(input.runId) as Record<string,unknown>|null;
      if(!currentLineageRow||!currentOperationRow||!currentSeedRow||canonicalJson(this.hardeningLineageFromRow(currentLineageRow))!==canonicalJson(authority.lineage)||
        canonicalJson(this.hardeningStartOperationFromRow(currentOperationRow))!==canonicalJson(authority.operation)||
        canonicalJson(this.hardeningSeedFromRow(currentSeedRow))!==canonicalJson(authority.signedSeed)||
        canonicalJson(this.verifiedHardeningCandidateContent(input,authority,undefined,strictReader))!==canonicalJson(snapshotContent))
        throw new IdempotencyConflictError(input.runId,"verified-hardening-candidate-authority-changed");
      const {checkpoint,attestation}=created;
      this.db.query(`INSERT INTO verified_candidate_checkpoints
        (id,checkpoint_hash,parent_checkpoint_id,parent_checkpoint_hash,hardening_lineage_id,hardening_lineage_hash,seed_attestation_id,
         seed_attestation_hash,run_id,requester_user_id,repository_id,required_lane_contract_hash,manifest_hash,base_commit_sha,result_commit_sha,
         diff_hash,reviewer_session_id,classification_hash,classification_result,evidence_bundle_id,evidence_bundle_hash,environment_digest,
         checkpoint_json,statement_json,statement_hash,signature_algorithm,signature_key_id,signature,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(checkpoint.checkpointId,checkpoint.checkpointHash,
          checkpoint.parentCheckpointId,checkpoint.parentCheckpointHash,checkpoint.hardeningLineageId,checkpoint.hardeningLineageHash,
          checkpoint.seedAttestationId,checkpoint.seedAttestationHash,checkpoint.runId,checkpoint.requesterUserId,checkpoint.repositoryId,
          checkpoint.requiredLaneContractHash,checkpoint.manifestHash,checkpoint.baseCommitSha,checkpoint.resultCommitSha,checkpoint.diffHash,
          checkpoint.reviewerSessionId,checkpoint.classificationHash,checkpoint.classificationResult,checkpoint.evidenceBundleId,
          checkpoint.evidenceBundleHash,checkpoint.environmentDigest,canonicalJson(checkpoint),attestation.statementJson,attestation.statementHash,
          attestation.algorithm,attestation.keyId,attestation.signature,checkpoint.createdAt);
      const startedRows=this.db.query(`SELECT e.event_json FROM advisory_backlog_events e WHERE e.child_run_id=? AND e.event_type='HARDENING_STARTED'
        AND NOT EXISTS(SELECT 1 FROM advisory_backlog_events later WHERE later.advisory_id=e.advisory_id AND later.revision>e.revision)
        ORDER BY e.advisory_id`).all(input.runId) as Array<{event_json:string}>;
      if(startedRows.length<1)throw new HardeningAuthorityInvalidError();
      const insert=this.db.query(`INSERT INTO advisory_backlog_events(id,event_hash,schema_version,policy_version,advisory_id,parent_run_id,
        parent_checkpoint_id,parent_checkpoint_hash,event_type,revision,expected_revision,actor_type,actor_id,operation_id,idempotency_key,
        quote_id,consent_id,hardening_lineage_id,child_run_id,child_checkpoint_id,child_checkpoint_hash,stop_reason,rationale,event_json,created_at)
        VALUES(?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for(const row of startedRows){const started=AdvisoryBacklogEventSchema.parse(JSON.parse(row.event_json));
        if(started.hardeningLineageId!==authority.lineage.lineageId||started.operationId!==authority.operation.operationId)
          throw new HardeningAuthorityInvalidError();
        const verified=createAdvisoryBacklogEvent({schemaVersion:1,policyVersion:"engineer-advisory-backlog-v1",advisoryId:started.advisoryId,
          parentRunId:started.parentRunId,parentCheckpointId:started.parentCheckpointId,parentCheckpointHash:started.parentCheckpointHash,
          eventType:"HARDENING_VERIFIED",revision:started.revision+1,expectedRevision:started.revision,actorType:"SYSTEM",
          actorId:"engineer-supervisor",operationId:authority.operation.operationId,
          idempotencyKey:`hardening-verified:${checkpoint.checkpointId}:${started.advisoryId}`,quoteId:authority.lineage.quoteId,
          consentId:authority.lineage.consentId,hardeningLineageId:authority.lineage.lineageId,childRunId:input.runId,
          childCheckpointId:checkpoint.checkpointId,childCheckpointHash:checkpoint.checkpointHash,stopReason:null,rationale:null,
          createdAt:checkpoint.createdAt});
        insert.run(verified.eventId,verified.eventHash,verified.policyVersion,verified.advisoryId,verified.parentRunId,verified.parentCheckpointId,
          verified.parentCheckpointHash,verified.eventType,verified.revision,verified.expectedRevision,verified.actorType,verified.actorId,
          verified.operationId,verified.idempotencyKey,verified.quoteId,verified.consentId,verified.hardeningLineageId,verified.childRunId,
          verified.childCheckpointId,verified.childCheckpointHash,verified.stopReason,verified.rationale,canonicalJson(verified),verified.createdAt);}
      const command:LedgerTransitionCommand={runId:input.runId,expectedStateVersion,previousState:"REVIEWING",nextState:"HUMAN_REVIEW_REQUIRED",
        reasonCode:"HARDENING_CANDIDATE_VERIFIED",actorType:"SUPERVISOR",actorId:"engineer-supervisor",evidenceIds:[checkpoint.checkpointId],
        manifestHash:checkpoint.manifestHash,idempotencyKey:`verified-hardening-candidate:${checkpoint.checkpointId}`,eventId:checkpoint.checkpointId,
        timestamp:checkpoint.createdAt,terminalAt:null};this.insertStateEvent(command,expectedStateVersion+1);
      const updated=this.db.query(`UPDATE engineer_runs SET state='HUMAN_REVIEW_REQUIRED',state_version=?,updated_at=?
        WHERE id=? AND state='REVIEWING' AND state_version=?`).run(expectedStateVersion+1,checkpoint.createdAt,input.runId,expectedStateVersion);
      if(Number(updated.changes)!==1)throw new StateVersionConflictError(input.runId,expectedStateVersion,this.getRun(input.runId).stateVersion);
      this.verifyHardeningBudgetUnderLock(input.runId,Date.parse(checkpoint.createdAt));
      this.updateExecutionClockForTransition(input.runId,"REVIEWING","HUMAN_REVIEW_REQUIRED",checkpoint.createdAt);
      this.insertAudit(input.runId,"HARDENING_CANDIDATE_VERIFIED","SUPERVISOR","engineer-supervisor",{checkpointId:checkpoint.checkpointId},checkpoint.createdAt);
      this.db.exec("COMMIT");const strict=await this.getVerifiedHardeningCandidateCheckpoint({checkpointId:checkpoint.checkpointId},input.attestor,strictReader);
      if(!strict)throw new Error("verified hardening candidate checkpoint disappeared after commit");return {...strict,applied:true};
    }catch(error){try{this.db.exec("ROLLBACK");}catch{}throw error;}
  }

  private expectedAdvisoryBacklog(checkpoint: VerifiedCandidateCheckpoint): AdvisoryBacklogItem[] {
    const classification = this.getReviewClassification(checkpoint.reviewerSessionId);
    const manifest = this.getManifest(checkpoint.runId);
    if (!classification || !manifest || classification.classificationHash !== checkpoint.classificationHash) throw new AdvisoryIntegrityError();
    const advisoryClassifications = classification.classifications.filter((item) => item.disposition === "ADVISORY" &&
      item.authority === "NONE" && item.reasonCode === "OUTSIDE_FROZEN_REQUIRED_SCOPE")
      .sort((a, b) => compareCodeUnits(a.findingId, b.findingId));
    if ((classification.result === "READY" && advisoryClassifications.length !== 0) ||
        (classification.result === "READY_WITH_ADVISORIES" && advisoryClassifications.length < 1)) throw new AdvisoryIntegrityError();
    return advisoryClassifications.map((classified) => {
      const finding = this.db.query("SELECT * FROM review_findings WHERE id=? AND reviewer_session_id=?")
        .get(classified.findingId, checkpoint.reviewerSessionId) as Record<string, unknown> | null;
      if (!finding || finding.fingerprint !== classified.findingFingerprint) throw new AdvisoryIntegrityError();
      const file = finding.file === null ? null : String(finding.file);
      return createAdvisoryBacklogItem({
        schemaVersion: 1, policyVersion: "engineer-advisory-backlog-v1", parentRunId: checkpoint.runId,
        requesterUserId: checkpoint.requesterUserId, repositoryId: checkpoint.repositoryId,
        parentCheckpointId: checkpoint.checkpointId, parentCheckpointHash: checkpoint.checkpointHash,
        requiredLaneContractHash: checkpoint.requiredLaneContractHash, classificationHash: checkpoint.classificationHash,
        reviewerSessionId: checkpoint.reviewerSessionId, findingId: classified.findingId,
        findingFingerprint: classified.findingFingerprint, sourceClassificationHash: classified.classificationHash,
        disposition: "ADVISORY", reasonCode: "OUTSIDE_FROZEN_REQUIRED_SCOPE", authority: "NONE",
        reportedSeverity: String(finding.severity) as AdvisoryBacklogItem["reportedSeverity"], category: String(finding.category),
        description: String(finding.description), requiredChange: String(finding.required_change), file,
        lineStart: finding.line_start === null ? null : Number(finding.line_start), lineEnd: finding.line_end === null ? null : Number(finding.line_end),
        criterionIds: JSON.parse(String(finding.criterion_ids_json)), evidenceIds: JSON.parse(String(finding.evidence_ids_json)),
        actionability: advisoryActionability(manifest, file), createdAt: classification.createdAt,
      }, manifest);
    });
  }

  private materializeAdvisoryBacklog(checkpoint: VerifiedCandidateCheckpoint): void {
    const items = this.expectedAdvisoryBacklog(checkpoint);
    const statement = this.db.query(`INSERT INTO advisory_backlog_items
      (id,advisory_hash,schema_version,policy_version,parent_run_id,requester_user_id,repository_id,parent_checkpoint_id,
       parent_checkpoint_hash,required_lane_contract_hash,classification_hash,reviewer_session_id,finding_id,
       finding_fingerprint,source_classification_hash,reported_severity,reason_code,category,file,line_start,line_end,
       actionability,item_json,created_at) VALUES (?,?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const item of items) statement.run(item.advisoryId,item.advisoryHash,item.policyVersion,item.parentRunId,item.requesterUserId,
      item.repositoryId,item.parentCheckpointId,item.parentCheckpointHash,item.requiredLaneContractHash,item.classificationHash,
      item.reviewerSessionId,item.findingId,item.findingFingerprint,item.sourceClassificationHash,item.reportedSeverity,item.reasonCode,
      item.category,item.file,item.lineStart,item.lineEnd,item.actionability,canonicalJson(item),item.createdAt);
    this.insertAudit(checkpoint.runId,"ADVISORY_BACKLOG_MATERIALIZED","SUPERVISOR","engineer-supervisor",{
      checkpointId:checkpoint.checkpointId,checkpointHash:checkpoint.checkpointHash,classificationHash:checkpoint.classificationHash,
      advisoryCount:items.length,advisoryIds:items.map((item)=>item.advisoryId).sort(compareCodeUnits),advisorySetHash:sha256(items),
    },checkpoint.createdAt);
  }

  private advisoryMarker(runId: string): { details_json: string;actor_type:string;actor_id:string;created_at:string } | null {
    const rows=this.db.query("SELECT details_json,actor_type,actor_id,created_at FROM audit_events WHERE run_id=? AND action='ADVISORY_BACKLOG_MATERIALIZED'").all(runId) as Array<{details_json:string;actor_type:string;actor_id:string;created_at:string}>;
    if(rows.length>1) throw new AdvisoryIntegrityError();
    return rows[0]??null;
  }

  private assertAdvisoryMaterialization(checkpoint: VerifiedCandidateCheckpoint): AdvisoryBacklogItem[] | null {
    const marker=this.advisoryMarker(checkpoint.runId);if(!marker)return null;
    const expected=this.expectedAdvisoryBacklog(checkpoint);
    const rows=(this.db.query("SELECT * FROM advisory_backlog_items WHERE parent_run_id=?")
      .all(checkpoint.runId) as Array<Record<string,unknown>>)
      .sort((left,right)=>compareCodeUnits(String(left.finding_id),String(right.finding_id)));
    const stored=rows.map((row)=>{let item:AdvisoryBacklogItem;try{item=AdvisoryBacklogItemSchema.parse(JSON.parse(String(row.item_json)));}catch{throw new AdvisoryIntegrityError();}
      const projection={id:item.advisoryId,advisory_hash:item.advisoryHash,schema_version:item.schemaVersion,policy_version:item.policyVersion,
        parent_run_id:item.parentRunId,requester_user_id:item.requesterUserId,repository_id:item.repositoryId,parent_checkpoint_id:item.parentCheckpointId,
        parent_checkpoint_hash:item.parentCheckpointHash,required_lane_contract_hash:item.requiredLaneContractHash,classification_hash:item.classificationHash,
        reviewer_session_id:item.reviewerSessionId,finding_id:item.findingId,finding_fingerprint:item.findingFingerprint,
        source_classification_hash:item.sourceClassificationHash,reported_severity:item.reportedSeverity,reason_code:item.reasonCode,category:item.category,
        file:item.file,line_start:item.lineStart,line_end:item.lineEnd,actionability:item.actionability,item_json:canonicalJson(item),created_at:item.createdAt};
      if(Object.entries(projection).some(([key,value])=>row[key]!==value))throw new AdvisoryIntegrityError();return item;});
    const details={checkpointId:checkpoint.checkpointId,checkpointHash:checkpoint.checkpointHash,classificationHash:checkpoint.classificationHash,
      advisoryCount:expected.length,advisoryIds:expected.map((item)=>item.advisoryId).sort(compareCodeUnits),advisorySetHash:sha256(expected)};
    if(canonicalJson(expected)!==canonicalJson(stored)||marker.details_json!==canonicalJson(details)||marker.actor_type!=="SUPERVISOR"||
      marker.actor_id!=="engineer-supervisor"||marker.created_at!==checkpoint.createdAt) throw new AdvisoryIntegrityError();
    return stored;
  }

  private advisoryEventFromRow(row:Record<string,unknown>,item:AdvisoryBacklogItem):AdvisoryBacklogEvent {
    try{const event=AdvisoryBacklogEventSchema.parse(JSON.parse(String(row.event_json)));
      const projection={id:event.eventId,event_hash:event.eventHash,schema_version:event.schemaVersion,policy_version:event.policyVersion,
        advisory_id:event.advisoryId,parent_run_id:event.parentRunId,parent_checkpoint_id:event.parentCheckpointId,parent_checkpoint_hash:event.parentCheckpointHash,
        event_type:event.eventType,revision:event.revision,expected_revision:event.expectedRevision,actor_type:event.actorType,actor_id:event.actorId,
        operation_id:event.operationId,idempotency_key:event.idempotencyKey,quote_id:event.quoteId,consent_id:event.consentId,
        hardening_lineage_id:event.hardeningLineageId,child_run_id:event.childRunId,child_checkpoint_id:event.childCheckpointId,
        child_checkpoint_hash:event.childCheckpointHash,stop_reason:event.stopReason,rationale:event.rationale,event_json:canonicalJson(event),created_at:event.createdAt};
      if(Object.entries(projection).some(([key,value])=>row[key]!==value)||event.advisoryId!==item.advisoryId||event.parentRunId!==item.parentRunId||
        event.parentCheckpointId!==item.parentCheckpointId||event.parentCheckpointHash!==item.parentCheckpointHash)throw new AdvisoryIntegrityError();
      if(['DEFERRED','DISMISSED','REOPENED'].includes(event.eventType)){
        if(event.actorType!=="USER"||event.actorId!==item.requesterUserId||event.operationId!==sha256({namespace:"engineer-advisory-owner-action-v1",
          runId:item.parentRunId,advisoryId:item.advisoryId,idempotencyKey:event.idempotencyKey}))throw new AdvisoryIntegrityError();
      }else{
        if(event.actorType!=="SYSTEM"||event.actorId!=="engineer-supervisor"||
          !['SELECTED','HARDENING_STARTED','HARDENING_VERIFIED','HARDENING_STOPPED'].includes(event.eventType))throw new AdvisoryIntegrityError();
        const authority=this.db.query(`SELECT 1 FROM hardening_start_operations o JOIN engineer_run_lineage l
          ON l.id=o.lineage_id AND l.lineage_hash=o.lineage_hash WHERE o.id=? AND l.parent_run_id=? AND l.parent_checkpoint_id=?
          AND l.parent_checkpoint_hash=? AND l.quote_id=? AND (? IS NULL OR l.child_run_id=?)`).get(event.operationId,event.parentRunId,
            event.parentCheckpointId,event.parentCheckpointHash,event.quoteId,event.childRunId,event.childRunId);
        if(!authority)throw new AdvisoryIntegrityError();
      }
      return event;}catch(error){if(error instanceof AdvisoryIntegrityError)throw error;throw new AdvisoryIntegrityError();}
  }

  private advisoryLifecycle(item:AdvisoryBacklogItem):AdvisoryBacklogEvent[] {
    const rows=this.db.query("SELECT * FROM advisory_backlog_events WHERE advisory_id=? ORDER BY revision ASC").all(item.advisoryId) as Array<Record<string,unknown>>;
    const events=rows.map((row)=>this.advisoryEventFromRow(row,item));let status:"OPEN"|"DEFERRED"|"DISMISSED"="OPEN";
    for(const [index,event] of events.entries()){if(event.revision!==index+1||event.expectedRevision!==index)throw new AdvisoryIntegrityError();
      if((event.eventType==="DEFERRED"&&status!=="OPEN")||(event.eventType==="DISMISSED"&&status==="DISMISSED")||(event.eventType==="REOPENED"&&status==="OPEN"))throw new AdvisoryIntegrityError();
      status=event.eventType==="DEFERRED"?"DEFERRED":event.eventType==="DISMISSED"?"DISMISSED":"OPEN";}
    return events;
  }

  private advisoryBacklogView(item: AdvisoryBacklogItem, exactEvent?: AdvisoryBacklogEvent | null) {
    const event = exactEvent===undefined ? this.advisoryLifecycle(item).at(-1)??null : exactEvent;
    let status: "OPEN" | "DEFERRED" | "DISMISSED" = "OPEN";
    let revision = 0;
    let updatedAt = item.createdAt;
    if (event) {
      revision = event.revision;
      updatedAt = event.createdAt;
      if (event.eventType === "DEFERRED") status = "DEFERRED";
      else if (event.eventType === "DISMISSED") status = "DISMISSED";
      else if (event.eventType !== "REOPENED") throw new AdvisoryIntegrityError();
    }
    return AdvisoryBacklogViewSchema.parse({
      advisoryId: item.advisoryId,
      severity: item.reportedSeverity,
      category: item.category,
      description: item.description,
      recommendedChange: item.requiredChange,
      file: item.actionability === "ACTIONABLE" ? item.file : null,
      lineStart: item.actionability === "ACTIONABLE" ? item.lineStart : null,
      lineEnd: item.actionability === "ACTIONABLE" ? item.lineEnd : null,
      actionability: item.actionability,
      status,
      revision,
      createdAt: item.createdAt,
      updatedAt,
    });
  }

  private promotedCheckpointForAdvisories(runId: string): VerifiedCandidateCheckpoint {
    const events = this.db.query(`SELECT evidence_ids_json FROM run_state_events WHERE run_id=?
      AND reason_code='VERIFIED_CANDIDATE_PROMOTED' AND next_state='REVIEW_APPROVED'`).all(runId) as Array<{evidence_ids_json:string}>;
    if (events.length !== 1) throw new AdvisoryIntegrityError();
    let evidenceIds: unknown;
    try { evidenceIds = JSON.parse(events[0]!.evidence_ids_json); } catch { throw new AdvisoryIntegrityError(); }
    if (!Array.isArray(evidenceIds) || evidenceIds.length !== 1 || typeof evidenceIds[0] !== "string") throw new AdvisoryIntegrityError();
    const row = this.db.query("SELECT * FROM verified_candidate_checkpoints WHERE id=? AND run_id=?")
      .get(evidenceIds[0], runId) as Record<string,unknown> | null;
    if (!row) throw new AdvisoryIntegrityError();
    try {
      const checkpoint=VerifiedCandidateCheckpointSchema.parse(JSON.parse(String(row.checkpoint_json)));
      if(String(row.checkpoint_json)!==canonicalJson(checkpoint)||row.id!==checkpoint.checkpointId||row.checkpoint_hash!==checkpoint.checkpointHash||
        row.run_id!==checkpoint.runId||row.requester_user_id!==checkpoint.requesterUserId||row.repository_id!==checkpoint.repositoryId||
        row.required_lane_contract_hash!==checkpoint.requiredLaneContractHash||row.manifest_hash!==checkpoint.manifestHash||
        row.base_commit_sha!==checkpoint.baseCommitSha||row.result_commit_sha!==checkpoint.resultCommitSha||row.diff_hash!==checkpoint.diffHash||
        row.reviewer_session_id!==checkpoint.reviewerSessionId||row.classification_hash!==checkpoint.classificationHash||
        row.classification_result!==checkpoint.classificationResult||row.evidence_bundle_id!==checkpoint.evidenceBundleId||
        row.evidence_bundle_hash!==checkpoint.evidenceBundleHash||row.environment_digest!==checkpoint.environmentDigest||row.created_at!==checkpoint.createdAt)
        throw new AdvisoryIntegrityError();
      return checkpoint;
    } catch(error) { if(error instanceof AdvisoryIntegrityError)throw error;throw new AdvisoryIntegrityError(); }
  }

  async listAdvisoryBacklogForOwner(ownerId:string,runId:string,options:{limit?:number;cursor?:string;status?:"OPEN"|"DEFERRED"|"DISMISSED";actionability?:"ACTIONABLE"|"AUDIT_ONLY"}={},attestor:CheckpointAttestor):Promise<AdvisoryBacklogPage> {
    const limit=options.limit??20; if(!Number.isInteger(limit)||limit<1||limit>50) throw new TypeError("advisory page limit must be between 1 and 50");
    const runRow=this.db.query("SELECT user_id FROM engineer_runs WHERE id=? AND user_id=?").get(runId,ownerId) as {user_id:string}|null;
    if(!runRow) throw new EngineerNotFoundError("advisory backlog",runId);
    const checkpoint=this.promotedCheckpointForAdvisories(runId);
    const materialized=this.assertAdvisoryMaterialization(checkpoint);
    const readArtifact=materialized===null?undefined:this.hardeningArtifactReader;
    if(materialized!==null&&!readArtifact)throw new AdvisoryIntegrityError();
    try{const signed=await this.getVerifiedCandidateCheckpoint({checkpointId:checkpoint.checkpointId},attestor,true,
      readArtifact);
      if(!signed||canonicalJson(signed.checkpoint)!==canonicalJson(checkpoint))throw new AdvisoryIntegrityError();}
    catch(error){if(error instanceof AdvisoryIntegrityError)throw error;throw new AdvisoryIntegrityError();}
    if(materialized===null) return AdvisoryBacklogPageSchema.parse({schemaVersion:1,materializationStatus:"LEGACY_UNAVAILABLE",items:[],nextCursor:null});
    for(const item of materialized)this.advisoryLifecycle(item);
    const filterHash=sha256({status:options.status??null,actionability:options.actionability??null});
    let before:{createdAt:string;advisoryId:string}|null=null;
    if(options.cursor){try{const parsed=JSON.parse(Buffer.from(options.cursor,"base64url").toString("utf8"));
      if(canonicalJson(parsed)!==canonicalJson({v:1,runId,ownerScopeHash:sha256({ownerId,runId}),filterHash,createdAt:parsed.createdAt,advisoryId:parsed.advisoryId})||
        typeof parsed.createdAt!=="string"||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(parsed.createdAt)||
        new Date(parsed.createdAt).toISOString()!==parsed.createdAt||typeof parsed.advisoryId!=="string"||!/^sha256:[0-9a-f]{64}$/.test(parsed.advisoryId))throw new Error();
      before={createdAt:parsed.createdAt,advisoryId:parsed.advisoryId};}catch{throw new AdvisoryCursorInvalidError();}}
    const clauses=["i.parent_run_id=?"],params:Array<string|number>=[runId];
    if(options.status){clauses.push(`COALESCE((SELECT CASE e.event_type WHEN 'DEFERRED' THEN 'DEFERRED' WHEN 'DISMISSED' THEN 'DISMISSED' WHEN 'REOPENED' THEN 'OPEN' END
      FROM advisory_backlog_events e WHERE e.advisory_id=i.id ORDER BY e.revision DESC LIMIT 1),'OPEN')=?`);params.push(options.status);}
    if(options.actionability){clauses.push("i.actionability=?");params.push(options.actionability);}
    if(before){clauses.push("(i.created_at<? OR (i.created_at=? AND i.id<?))");params.push(before.createdAt,before.createdAt,before.advisoryId);}
    params.push(limit+1);
    const itemRows=this.db.query(`SELECT i.item_json FROM advisory_backlog_items i WHERE ${clauses.join(" AND ")}
      ORDER BY i.created_at DESC,i.id DESC LIMIT ?`).all(...params) as Array<{item_json:string}>;
    const views=itemRows.map((row)=>this.advisoryBacklogView(AdvisoryBacklogItemSchema.parse(JSON.parse(row.item_json))));
    const page=views.slice(0,limit),hasMore=views.length>limit,last=page.at(-1);
    const nextCursor=hasMore&&last?Buffer.from(canonicalJson({v:1,runId,ownerScopeHash:sha256({ownerId,runId}),filterHash,createdAt:last.createdAt,advisoryId:last.advisoryId})).toString("base64url"):null;
    return AdvisoryBacklogPageSchema.parse({schemaVersion:1,materializationStatus:"COMPLETE",items:page,nextCursor});
  }

  async applyAdvisoryOwnerAction(ownerId:string,runId:string,advisoryId:string,action:"DEFER"|"DISMISS"|"REOPEN",command:AdvisoryOwnerCommand,attestor:CheckpointAttestor){
    const parsed=AdvisoryOwnerCommandSchema.parse(command);
    const preOwned=this.db.query("SELECT 1 FROM engineer_runs WHERE id=? AND user_id=?").get(runId,ownerId);if(!preOwned)throw new EngineerNotFoundError("advisory",advisoryId);
    const signedCheckpoint=this.promotedCheckpointForAdvisories(runId);
    const materializedAuthority=this.assertAdvisoryMaterialization(signedCheckpoint);
    const readArtifact=materializedAuthority===null?undefined:this.hardeningArtifactReader;
    if(materializedAuthority!==null&&!readArtifact)throw new AdvisoryIntegrityError();
    let signedAuthority:{checkpoint:VerifiedCandidateCheckpoint;attestation:SignedVerifiedCandidateAttestation};
    try{const signed=await this.getVerifiedCandidateCheckpoint({checkpointId:signedCheckpoint.checkpointId},attestor,true,
      readArtifact);
      if(!signed||canonicalJson(signed.checkpoint)!==canonicalJson(signedCheckpoint))throw new AdvisoryIntegrityError();signedAuthority=signed;}
    catch(error){if(error instanceof AdvisoryIntegrityError)throw error;throw new AdvisoryIntegrityError();}
    this.db.exec("BEGIN IMMEDIATE");
    try{const owned=this.db.query("SELECT 1 FROM engineer_runs WHERE id=? AND user_id=?").get(runId,ownerId);if(!owned)throw new EngineerNotFoundError("advisory",advisoryId);
      const signedRow=this.db.query(`SELECT checkpoint_json,statement_json,statement_hash,signature_algorithm,signature_key_id,signature
        FROM verified_candidate_checkpoints WHERE id=? AND run_id=?`).get(signedCheckpoint.checkpointId,runId) as Record<string,unknown>|null;
      if(!signedRow||signedRow.checkpoint_json!==canonicalJson(signedAuthority.checkpoint)||
        signedRow.statement_json!==signedAuthority.attestation.statementJson||signedRow.statement_hash!==signedAuthority.attestation.statementHash||
        signedRow.signature_algorithm!==signedAuthority.attestation.algorithm||signedRow.signature_key_id!==signedAuthority.attestation.keyId||
        signedRow.signature!==signedAuthority.attestation.signature)throw new AdvisoryIntegrityError();
      const checkpoint=this.promotedCheckpointForAdvisories(runId);
      if(canonicalJson(checkpoint)!==canonicalJson(signedCheckpoint))throw new AdvisoryIntegrityError();
      const materialized=this.assertAdvisoryMaterialization(checkpoint);if(materialized===null)throw new AdvisoryMaterializationRequiredError();
      const itemRow=this.db.query(`SELECT item_json FROM advisory_backlog_items WHERE id=? AND parent_run_id=?`).get(advisoryId,runId) as {item_json:string}|null;
      if(!itemRow)throw new EngineerNotFoundError("advisory",advisoryId);
      const item=AdvisoryBacklogItemSchema.parse(JSON.parse(itemRow.item_json));
      const lifecycle=this.advisoryLifecycle(item);const existing=lifecycle.find((event)=>event.idempotencyKey===parsed.idempotencyKey)??null;
      const eventType=action==="DEFER"?"DEFERRED":action==="DISMISS"?"DISMISSED":"REOPENED";
      if(existing){if(existing.eventType===eventType&&existing.expectedRevision===parsed.expectedRevision&&existing.rationale===parsed.rationale&&existing.actorId===ownerId){this.db.exec("COMMIT");return this.advisoryBacklogView(item,existing);}throw new IdempotencyConflictError(runId,parsed.idempotencyKey);}
      const prior=lifecycle.at(-1)??null;
      const revision=prior?.revision??0;if(revision!==parsed.expectedRevision)throw new AdvisoryChangedError();
      if(prior?.eventType==="HARDENING_STARTED")throw new AdvisoryTransitionInvalidError();
      const status=prior?.eventType==="DEFERRED"?"DEFERRED":prior?.eventType==="DISMISSED"?"DISMISSED":"OPEN";
      if((action==="DEFER"&&status!=="OPEN")||(action==="DISMISS"&&status==="DISMISSED")||(action==="REOPEN"&&status==="OPEN"))throw new AdvisoryTransitionInvalidError();
      const createdAt=this.now().toISOString();const event=createAdvisoryBacklogEvent({schemaVersion:1,policyVersion:"engineer-advisory-backlog-v1",advisoryId,
        parentRunId:runId,parentCheckpointId:item.parentCheckpointId,parentCheckpointHash:item.parentCheckpointHash,eventType,revision:revision+1,expectedRevision:revision,
        actorType:"USER",actorId:ownerId,operationId:sha256({namespace:"engineer-advisory-owner-action-v1",runId,advisoryId,idempotencyKey:parsed.idempotencyKey}),idempotencyKey:parsed.idempotencyKey,
        quoteId:null,consentId:null,hardeningLineageId:null,childRunId:null,childCheckpointId:null,childCheckpointHash:null,stopReason:null,rationale:parsed.rationale,createdAt});
      this.db.query(`INSERT INTO advisory_backlog_events(id,event_hash,schema_version,policy_version,advisory_id,parent_run_id,parent_checkpoint_id,parent_checkpoint_hash,event_type,revision,expected_revision,actor_type,actor_id,operation_id,idempotency_key,quote_id,consent_id,hardening_lineage_id,child_run_id,child_checkpoint_id,child_checkpoint_hash,stop_reason,rationale,event_json,created_at) VALUES(?,?,1,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,NULL,NULL,NULL,NULL,NULL,?,?,?)`).run(event.eventId,event.eventHash,event.policyVersion,event.advisoryId,event.parentRunId,event.parentCheckpointId,event.parentCheckpointHash,event.eventType,event.revision,event.expectedRevision,event.actorType,event.actorId,event.operationId,event.idempotencyKey,event.rationale,canonicalJson(event),event.createdAt);
      this.db.exec("COMMIT");return this.advisoryBacklogView(item);
    }catch(error){try{this.db.exec("ROLLBACK");}catch{}throw error;}
  }

  private hardeningQuoteFromRow(row: Record<string, unknown>): HardeningQuote {
    try {
      const quote=HardeningQuoteSchema.parse(JSON.parse(String(row.quote_json)));
      const projection:Record<string,unknown>={id:quote.quoteId,quote_hash:quote.quoteHash,schema_version:quote.schemaVersion,
        policy_version:quote.policyVersion,estimator_version:quote.estimatorVersion,parent_run_id:quote.parentRunId,
        requester_user_id:quote.requesterUserId,repository_id:quote.repositoryId,parent_checkpoint_id:quote.parentCheckpointId,
        parent_checkpoint_hash:quote.parentCheckpointHash,parent_state_version:quote.parentStateVersion,selection_hash:quote.selectionHash,
        advisory_count:quote.advisoryIds.length,routing_policy_version:quote.routingPolicyVersion,pricing_version:quote.pricingVersion,
        max_cost_microusd:quote.estimate.maxCostMicrousd,max_tokens:quote.estimate.maxTokens,max_time_seconds:quote.estimate.maxTimeSeconds,
        max_planner_calls:quote.estimate.maxPlannerCalls,max_builder_calls:quote.estimate.maxBuilderCalls,
        max_reviewer_calls:quote.estimate.maxReviewerCalls,automatic_repair_calls:quote.estimate.automaticRepairCalls,
        sizing_authority_id:quote.schemaVersion===2?quote.sizingAuthorityId:null,
        sizing_authority_hash:quote.schemaVersion===2?quote.sizingAuthorityHash:null,
        local_input_counter_version:quote.schemaVersion===2?quote.localInputCounterVersion:null,
        builder_prompt_version:quote.schemaVersion===2?quote.builderPromptVersion:null,
        reviewer_policy_version:quote.schemaVersion===2?quote.reviewerPolicyVersion:null,
        cache_policy_version:quote.schemaVersion===2?quote.cachePolicyVersion:null,
        cache_accounting_version:quote.schemaVersion===2?quote.cacheAccountingVersion:null,
        cache_write_input_multiplier_numerator:quote.schemaVersion===2?quote.cacheWriteInputMultiplier.numerator:null,
        cache_write_input_multiplier_denominator:quote.schemaVersion===2?quote.cacheWriteInputMultiplier.denominator:null,
        builder_input_token_cap:quote.schemaVersion===2?quote.inputCaps.builderInputTokens:null,
        builder_output_token_cap:quote.schemaVersion===2?quote.inputCaps.builderOutputTokens:null,
        reviewer_input_token_cap:quote.schemaVersion===2?quote.inputCaps.reviewerInputTokens:null,
        reviewer_output_token_cap:quote.schemaVersion===2?quote.inputCaps.reviewerOutputTokens:null,
        quote_json:canonicalJson(quote),created_at:quote.createdAt,expires_at:quote.expiresAt};
      if(Object.entries(projection).some(([key,value])=>row[key]!==value))throw new HardeningAuthorityInvalidError();
      const mappings=this.db.query("SELECT ordinal,advisory_id FROM hardening_quote_advisories WHERE quote_id=? ORDER BY ordinal")
        .all(quote.quoteId) as Array<{ordinal:number;advisory_id:string}>;
      if(mappings.length!==quote.advisoryIds.length||mappings.some((mapping,index)=>mapping.ordinal!==index||mapping.advisory_id!==quote.advisoryIds[index]))
        throw new HardeningAuthorityInvalidError();
      return quote;
    } catch(error) { if(error instanceof HardeningAuthorityInvalidError)throw error;throw new HardeningAuthorityInvalidError(); }
  }

  private hardeningQuoteSizingAuthorityFromRow(row:Record<string,unknown>):HardeningQuoteSizingAuthority{
    try{const authority=HardeningQuoteSizingAuthoritySchema.parse(JSON.parse(String(row.authority_json)));
      const projection:Record<string,unknown>={id:authority.sizingAuthorityId,sizing_authority_hash:authority.sizingAuthorityHash,
        schema_version:authority.schemaVersion,policy_version:authority.policyVersion,estimator_version:authority.estimatorVersion,
        local_input_counter_version:authority.localInputCounterVersion,builder_prompt_version:authority.builderPromptVersion,
        reviewer_policy_version:authority.reviewerPolicyVersion,parent_run_id:authority.parentRunId,
        cache_policy_version:authority.cachePolicyVersion,cache_accounting_version:authority.cacheAccountingVersion,
        cache_write_input_multiplier_numerator:authority.cacheWriteInputMultiplier.numerator,
        cache_write_input_multiplier_denominator:authority.cacheWriteInputMultiplier.denominator,
        requester_user_id:authority.requesterUserId,repository_id:authority.repositoryId,parent_checkpoint_id:authority.parentCheckpointId,
        parent_checkpoint_hash:authority.parentCheckpointHash,parent_manifest_hash:authority.parentManifestHash,
        selection_hash:authority.selectionHash,advisory_ids_json:canonicalJson(authority.advisoryIds),
        advisory_projection_hash:authority.advisoryProjectionHash,advisory_count:authority.advisoryCount,
        unique_file_count:authority.uniqueFileCount,builder_sizing_template_hash:authority.builderSizingTemplateHash,
        builder_sizing_input_token_upper_bound:authority.builderSizingInputTokenUpperBound,
        builder_input_token_cap:authority.inputCaps.builderInputTokens,builder_output_token_cap:authority.inputCaps.builderOutputTokens,
        reviewer_input_token_cap:authority.inputCaps.reviewerInputTokens,reviewer_output_token_cap:authority.inputCaps.reviewerOutputTokens,
        authority_json:canonicalJson(authority)};
      if(Object.entries(projection).some(([key,value])=>row[key]!==value))throw new HardeningAuthorityInvalidError();return authority;
    }catch(error){if(error instanceof HardeningAuthorityInvalidError)throw error;throw new HardeningAuthorityInvalidError();}
  }

  private hardeningConsentFromRow(row: Record<string, unknown>): HardeningConsent {
    try {
      const consent=HardeningConsentSchema.parse(JSON.parse(String(row.consent_json)));
      const projection:Record<string,unknown>={id:consent.consentId,consent_hash:consent.consentHash,schema_version:consent.schemaVersion,
        policy_version:consent.policyVersion,quote_id:consent.quoteId,quote_hash:consent.quoteHash,parent_run_id:consent.parentRunId,
        parent_checkpoint_id:consent.parentCheckpointId,parent_checkpoint_hash:consent.parentCheckpointHash,
        parent_state_version:consent.parentStateVersion,selection_hash:consent.selectionHash,requester_user_id:consent.requesterUserId,
        actor_id:consent.actorId,cost_microusd:consent.authorizedBudget.costMicrousd,tokens:consent.authorizedBudget.tokens,
        time_seconds:consent.authorizedBudget.timeSeconds,acknowledge_separate_run:1,acknowledge_parent_unchanged:1,
        acknowledge_no_automatic_repair:1,acknowledge_no_overages:1,idempotency_key:consent.idempotencyKey,
        consent_json:canonicalJson(consent),accepted_at:consent.acceptedAt,quote_expires_at:consent.quoteExpiresAt};
      if(Object.entries(projection).some(([key,value])=>row[key]!==value))throw new HardeningAuthorityInvalidError();
      return consent;
    } catch(error) { if(error instanceof HardeningAuthorityInvalidError)throw error;throw new HardeningAuthorityInvalidError(); }
  }

  private hardeningQuoteView(quote:HardeningQuote):HardeningQuoteView {
    return HardeningQuoteViewSchema.parse({...quote,status:this.now().getTime()<=Date.parse(quote.expiresAt)?"ACTIVE":"EXPIRED"});
  }

  private assertCurrentHardeningQuote(quote:HardeningQuote):asserts quote is Extract<HardeningQuote,{schemaVersion:2}>{
    if(quote.schemaVersion!==2)throw new HardeningQuoteVersionStaleError();
  }

  private async signedHardeningParent(runId:string,attestor:CheckpointAttestor) {
    const strictReader=this.hardeningArtifactReader;
    if(!strictReader)throw new HardeningAuthorityInvalidError();
    const checkpoint=this.promotedCheckpointForAdvisories(runId);
    try {
      const signed=await this.getVerifiedCandidateCheckpoint({checkpointId:checkpoint.checkpointId},attestor,true,strictReader);
      if(!signed||canonicalJson(signed.checkpoint)!==canonicalJson(checkpoint))throw new HardeningAuthorityInvalidError();
      return signed;
    } catch(error) { if(error instanceof HardeningAuthorityInvalidError)throw error;throw new HardeningAuthorityInvalidError(); }
  }

  private assertSignedHardeningParent(runId:string,signedAuthority:{checkpoint:VerifiedCandidateCheckpoint;attestation:SignedVerifiedCandidateAttestation}):VerifiedCandidateCheckpoint {
    const signedRow=this.db.query(`SELECT checkpoint_json,statement_json,statement_hash,signature_algorithm,signature_key_id,signature
      FROM verified_candidate_checkpoints WHERE id=? AND run_id=?`).get(signedAuthority.checkpoint.checkpointId,runId) as Record<string,unknown>|null;
    if(!signedRow||signedRow.checkpoint_json!==canonicalJson(signedAuthority.checkpoint)||
      signedRow.statement_json!==signedAuthority.attestation.statementJson||signedRow.statement_hash!==signedAuthority.attestation.statementHash||
      signedRow.signature_algorithm!==signedAuthority.attestation.algorithm||signedRow.signature_key_id!==signedAuthority.attestation.keyId||
      signedRow.signature!==signedAuthority.attestation.signature)throw new HardeningAuthorityInvalidError();
    const current=this.promotedCheckpointForAdvisories(runId);
    if(canonicalJson(current)!==canonicalJson(signedAuthority.checkpoint))throw new HardeningAuthorityInvalidError();
    return current;
  }

  private assertOpenActionableSelection(checkpoint:VerifiedCandidateCheckpoint,advisoryIds:readonly string[]):AdvisoryBacklogItem[] {
    const materialized=this.assertAdvisoryMaterialization(checkpoint);if(materialized===null)throw new AdvisoryMaterializationRequiredError();
    const byId=new Map(materialized.map((item)=>[item.advisoryId,item]));
    const selected=advisoryIds.map((id)=>byId.get(id));
    if(selected.some((item)=>!item||item.actionability!=="ACTIONABLE"))throw new HardeningSelectionInvalidError();
    for(const item of selected as AdvisoryBacklogItem[]){const latest=this.advisoryLifecycle(item).at(-1);if(latest&&latest.eventType!=="REOPENED")throw new HardeningSelectionInvalidError();}
    return selected as AdvisoryBacklogItem[];
  }

  private assertDeterministicQuoteAuthority(quote:HardeningQuote,checkpoint:VerifiedCandidateCheckpoint,requireOpen:boolean):AdvisoryBacklogItem[]{
    if(quote.parentRunId!==checkpoint.runId||quote.requesterUserId!==checkpoint.requesterUserId||quote.repositoryId!==checkpoint.repositoryId||
      quote.parentCheckpointId!==checkpoint.checkpointId||quote.parentCheckpointHash!==checkpoint.checkpointHash)throw new HardeningAuthorityInvalidError();
    const materialized=this.assertAdvisoryMaterialization(checkpoint);if(materialized===null)throw new HardeningAuthorityInvalidError();
    const byId=new Map(materialized.map((item)=>[item.advisoryId,item]));const selected=quote.advisoryIds.map((id)=>byId.get(id));
    if(selected.some((item)=>!item||item.actionability!=="ACTIONABLE"))throw new HardeningAuthorityInvalidError();
    if(requireOpen)for(const item of selected as AdvisoryBacklogItem[]){const latest=this.advisoryLifecycle(item).at(-1);if(latest&&latest.eventType!=="REOPENED")throw new HardeningSelectionInvalidError();}
    if(quote.schemaVersion===1){const derived=deterministicHardeningEstimate(selected as AdvisoryBacklogItem[]);
      if(quote.estimatorVersion!==derived.estimatorVersion||quote.routingPolicyVersion!==derived.routingPolicyVersion||
        quote.pricingVersion!==derived.pricingVersion||canonicalJson(quote.estimate)!==canonicalJson(derived.estimate)||
        canonicalJson(quote.assumptions)!==canonicalJson(derived.assumptions))throw new HardeningAuthorityInvalidError();
    }else{const derived=deterministicHardeningEstimateV2(selected as AdvisoryBacklogItem[]);
      if(quote.estimatorVersion!==derived.estimatorVersion||quote.routingPolicyVersion!==derived.routingPolicyVersion||
        quote.pricingVersion!==derived.pricingVersion||canonicalJson(quote.estimate)!==canonicalJson(derived.estimate)||
        canonicalJson(quote.assumptions)!==canonicalJson(derived.assumptions)||canonicalJson(quote.inputCaps)!==canonicalJson(derived.estimate.inputCaps))
        throw new HardeningAuthorityInvalidError();
      const sizingRow=this.db.query("SELECT * FROM hardening_quote_sizing_authorities WHERE id=? AND sizing_authority_hash=?")
        .get(quote.sizingAuthorityId,quote.sizingAuthorityHash) as Record<string,unknown>|null;if(!sizingRow)throw new HardeningAuthorityInvalidError();
      const sizing=this.hardeningQuoteSizingAuthorityFromRow(sizingRow),parentManifest=this.getManifest(checkpoint.runId);
      if(!parentManifest||sizing.parentManifestHash!==parentManifest.manifestHash||sizing.sizingAuthorityId!==quote.sizingAuthorityId||
        sizing.sizingAuthorityHash!==quote.sizingAuthorityHash||sizing.localInputCounterVersion!==quote.localInputCounterVersion||
        sizing.builderPromptVersion!==quote.builderPromptVersion||sizing.reviewerPolicyVersion!==quote.reviewerPolicyVersion||
        sizing.cachePolicyVersion!==quote.cachePolicyVersion||sizing.cacheAccountingVersion!==quote.cacheAccountingVersion||
        canonicalJson(sizing.cacheWriteInputMultiplier)!==canonicalJson(quote.cacheWriteInputMultiplier)||
        canonicalJson(sizing.inputCaps)!==canonicalJson(quote.inputCaps))throw new HardeningAuthorityInvalidError();
      const template=hardeningBuilderSizingTemplate({parentManifest,advisories:selected as AdvisoryBacklogItem[],parentRunId:quote.parentRunId,
        rootRunId:this.optionalHardeningRoot(quote.parentRunId),requesterUserId:quote.requesterUserId,repositoryId:quote.repositoryId,
        parentCheckpointId:quote.parentCheckpointId,parentCheckpointHash:quote.parentCheckpointHash,seedResultCommitSha:checkpoint.resultCommitSha,
        estimate:derived});
      const recomputed=createHardeningQuoteSizingAuthority({schemaVersion:1,policyVersion:"engineer-hardening-quote-sizing-authority-v1",
        estimatorVersion:"deterministic-hardening-estimator-v2",localInputCounterVersion:"response-input-byte-upper-bound-v1",
        builderPromptVersion:quote.builderPromptVersion,reviewerPolicyVersion:quote.reviewerPolicyVersion,parentRunId:quote.parentRunId,
        cachePolicyVersion:quote.cachePolicyVersion,cacheAccountingVersion:quote.cacheAccountingVersion,
        cacheWriteInputMultiplier:quote.cacheWriteInputMultiplier,
        requesterUserId:quote.requesterUserId,repositoryId:quote.repositoryId,parentCheckpointId:quote.parentCheckpointId,
        parentCheckpointHash:quote.parentCheckpointHash,parentManifestHash:parentManifest.manifestHash,selectionHash:quote.selectionHash,
        advisoryIds:quote.advisoryIds,inputCaps:quote.inputCaps},selected as AdvisoryBacklogItem[],template.request);
      if(canonicalJson(recomputed)!==canonicalJson(sizing))throw new HardeningAuthorityInvalidError();}
    return selected as AdvisoryBacklogItem[];
  }

  private quoteRequestAuthority(ownerId:string,input:HardeningQuoteRequest,version:1|2=2){
    const policyVersion=version===1?"engineer-hardening-quote-request-v1":"engineer-hardening-quote-request-v2";
    const content={schemaVersion:version,policyVersion,requesterUserId:ownerId,...input};
    const requestHash=sha256(content),requestId=sha256({namespace:policyVersion,requestHash});
    return {...content,requestHash,requestId};
  }

  private quoteRequestFromRow(row:Record<string,unknown>,ownerId:string):HardeningQuoteRequest{
    try{const decoded=JSON.parse(String(row.request_json)) as Record<string,unknown>;
      const input=HardeningQuoteRequestSchema.parse({runId:decoded.runId,advisoryIds:decoded.advisoryIds,
        expectedParentStateVersion:decoded.expectedParentStateVersion,idempotencyKey:decoded.idempotencyKey});
      const version=decoded.policyVersion==="engineer-hardening-quote-request-v1"&&decoded.schemaVersion===1?1:
        decoded.policyVersion==="engineer-hardening-quote-request-v2"&&decoded.schemaVersion===2?2:null;
      if(version===null)throw new HardeningAuthorityInvalidError();const expected=this.quoteRequestAuthority(ownerId,input,version);
      if(canonicalJson(decoded)!==canonicalJson(expected)||row.id!==expected.requestId||row.request_hash!==expected.requestHash||
        row.requester_user_id!==ownerId||row.parent_run_id!==input.runId||row.idempotency_key!==input.idempotencyKey)throw new HardeningAuthorityInvalidError();
      return input;
    }catch(error){if(error instanceof HardeningAuthorityInvalidError)throw error;throw new HardeningAuthorityInvalidError();}
  }

  private assertQuoteRequestRow(row:Record<string,unknown>,ownerId:string,input:HardeningQuoteRequest){
    const stored=this.quoteRequestFromRow(row,ownerId);
    if(canonicalJson(stored)!==canonicalJson(input))throw new IdempotencyConflictError(input.runId,input.idempotencyKey);
    const decoded=JSON.parse(String(row.request_json)) as Record<string,unknown>;
    return this.quoteRequestAuthority(ownerId,input,decoded.policyVersion==="engineer-hardening-quote-request-v1"?1:2);
  }

  async createHardeningQuoteForOwner(ownerId:string,rawInput:HardeningQuoteRequest,attestor:CheckpointAttestor):Promise<HardeningQuoteView>{
    const input=HardeningQuoteRequestSchema.parse(rawInput);
    if(!this.db.query("SELECT 1 FROM engineer_runs WHERE id=? AND user_id=?").get(input.runId,ownerId))throw new EngineerNotFoundError("hardening quote",input.runId);
    const signed=await this.signedHardeningParent(input.runId,attestor);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const run=this.db.query("SELECT user_id,repository_id,state_version FROM engineer_runs WHERE id=? AND user_id=?").get(input.runId,ownerId) as {user_id:string;repository_id:string;state_version:number}|null;
      if(!run)throw new EngineerNotFoundError("hardening quote",input.runId);
      // P10: hardening requester-scoped idempotency read, org-scoped (default org today).
      const existingRequest=this.db.query("SELECT * FROM hardening_quote_requests WHERE requester_user_id=? AND idempotency_key=? AND org_id=?").get(ownerId,input.idempotencyKey,this.tenantOrgId) as Record<string,unknown>|null;
      if(existingRequest){
        this.assertQuoteRequestRow(existingRequest,ownerId,input);
        const checkpoint=this.assertSignedHardeningParent(input.runId,signed);
        const row=this.db.query("SELECT * FROM hardening_quotes WHERE id=? AND quote_hash=?").get(String(existingRequest.quote_id),String(existingRequest.quote_hash)) as Record<string,unknown>|null;
        if(!row)throw new HardeningAuthorityInvalidError();const quote=this.hardeningQuoteFromRow(row);
        this.assertDeterministicQuoteAuthority(quote,checkpoint,false);
        this.db.exec("COMMIT");return this.hardeningQuoteView(quote);
      }
      if(run.state_version!==input.expectedParentStateVersion)throw new StateVersionConflictError(input.runId,input.expectedParentStateVersion,run.state_version);
      const checkpoint=this.assertSignedHardeningParent(input.runId,signed);const advisories=this.assertOpenActionableSelection(checkpoint,input.advisoryIds);
      const deterministic=deterministicHardeningEstimateV2(advisories),parentManifest=this.getManifest(input.runId);
      if(!parentManifest||parentManifest.manifestHash!==checkpoint.manifestHash)throw new HardeningAuthorityInvalidError();
      const template=hardeningBuilderSizingTemplate({parentManifest,advisories,parentRunId:input.runId,rootRunId:this.optionalHardeningRoot(input.runId),
        requesterUserId:ownerId,repositoryId:run.repository_id,parentCheckpointId:checkpoint.checkpointId,
        parentCheckpointHash:checkpoint.checkpointHash,seedResultCommitSha:checkpoint.resultCommitSha,estimate:deterministic});
      const sizing=createHardeningQuoteSizingAuthority({schemaVersion:1,policyVersion:"engineer-hardening-quote-sizing-authority-v1",
        estimatorVersion:"deterministic-hardening-estimator-v2",localInputCounterVersion:"response-input-byte-upper-bound-v1",
        builderPromptVersion:"engineer-codex-builder-v3",reviewerPolicyVersion:"engineer-isolated-reviewer-v6",
        cachePolicyVersion:deterministic.cachePolicyVersion,cacheAccountingVersion:deterministic.cacheAccountingVersion,
        cacheWriteInputMultiplier:deterministic.cacheWriteInputMultiplier,parentRunId:input.runId,requesterUserId:ownerId,
        repositoryId:run.repository_id,parentCheckpointId:checkpoint.checkpointId,parentCheckpointHash:checkpoint.checkpointHash,
        parentManifestHash:parentManifest.manifestHash,selectionHash:sha256(input.advisoryIds),advisoryIds:input.advisoryIds,
        inputCaps:deterministic.estimate.inputCaps},advisories,template.request);
      if(sizing.builderSizingInputTokenUpperBound>deterministic.estimate.inputCaps.builderInputTokens)throw new HardeningQuoteInputTooLargeError();
      const createdAt=this.now().toISOString();
      const expiresAt=new Date(Date.parse(createdAt)+15*60_000).toISOString();
      const quote=createHardeningQuoteV2({schemaVersion:2,policyVersion:"engineer-hardening-estimate-v2",estimatorVersion:deterministic.estimatorVersion,
        parentRunId:input.runId,requesterUserId:ownerId,repositoryId:run.repository_id,parentCheckpointId:checkpoint.checkpointId,
        parentCheckpointHash:checkpoint.checkpointHash,parentStateVersion:run.state_version,advisoryIds:input.advisoryIds,
        selectionHash:sha256(input.advisoryIds),routingPolicyVersion:deterministic.routingPolicyVersion,pricingVersion:deterministic.pricingVersion,
        estimate:deterministic.estimate,assumptions:deterministic.assumptions,sizingAuthorityId:sizing.sizingAuthorityId,
        sizingAuthorityHash:sizing.sizingAuthorityHash,localInputCounterVersion:sizing.localInputCounterVersion,
        builderPromptVersion:sizing.builderPromptVersion,reviewerPolicyVersion:sizing.reviewerPolicyVersion,
        cachePolicyVersion:sizing.cachePolicyVersion,cacheAccountingVersion:sizing.cacheAccountingVersion,
        cacheWriteInputMultiplier:sizing.cacheWriteInputMultiplier,inputCaps:sizing.inputCaps,createdAt,expiresAt},advisories,sizing);
      this.db.query(`INSERT OR IGNORE INTO hardening_quote_sizing_authorities(id,sizing_authority_hash,schema_version,policy_version,estimator_version,
        local_input_counter_version,builder_prompt_version,reviewer_policy_version,cache_policy_version,cache_accounting_version,
        cache_write_input_multiplier_numerator,cache_write_input_multiplier_denominator,parent_run_id,requester_user_id,repository_id,
        parent_checkpoint_id,parent_checkpoint_hash,parent_manifest_hash,selection_hash,advisory_ids_json,advisory_projection_hash,
        advisory_count,unique_file_count,builder_sizing_template_hash,builder_sizing_input_token_upper_bound,builder_input_token_cap,
        builder_output_token_cap,reviewer_input_token_cap,reviewer_output_token_cap,authority_json,recorded_at)
        VALUES(?,?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(sizing.sizingAuthorityId,sizing.sizingAuthorityHash,
        sizing.policyVersion,sizing.estimatorVersion,sizing.localInputCounterVersion,sizing.builderPromptVersion,sizing.reviewerPolicyVersion,
        sizing.cachePolicyVersion,sizing.cacheAccountingVersion,sizing.cacheWriteInputMultiplier.numerator,sizing.cacheWriteInputMultiplier.denominator,
        sizing.parentRunId,sizing.requesterUserId,sizing.repositoryId,sizing.parentCheckpointId,sizing.parentCheckpointHash,
        sizing.parentManifestHash,sizing.selectionHash,canonicalJson(sizing.advisoryIds),sizing.advisoryProjectionHash,sizing.advisoryCount,
        sizing.uniqueFileCount,sizing.builderSizingTemplateHash,sizing.builderSizingInputTokenUpperBound,sizing.inputCaps.builderInputTokens,
        sizing.inputCaps.builderOutputTokens,sizing.inputCaps.reviewerInputTokens,sizing.inputCaps.reviewerOutputTokens,canonicalJson(sizing),createdAt);
      const persistedSizingRow=this.db.query("SELECT * FROM hardening_quote_sizing_authorities WHERE id=? AND sizing_authority_hash=?")
        .get(sizing.sizingAuthorityId,sizing.sizingAuthorityHash) as Record<string,unknown>|null;
      if(!persistedSizingRow||canonicalJson(this.hardeningQuoteSizingAuthorityFromRow(persistedSizingRow))!==canonicalJson(sizing))
        throw new HardeningAuthorityInvalidError();
      const mapping=this.db.query("INSERT INTO hardening_quote_advisories(quote_id,ordinal,advisory_id) VALUES (?,?,?)");
      quote.advisoryIds.forEach((id,index)=>mapping.run(quote.quoteId,index,id));
      this.db.query(`INSERT INTO hardening_quotes(id,quote_hash,schema_version,policy_version,estimator_version,parent_run_id,requester_user_id,
        repository_id,parent_checkpoint_id,parent_checkpoint_hash,parent_state_version,selection_hash,advisory_count,routing_policy_version,
        pricing_version,max_cost_microusd,max_tokens,max_time_seconds,max_planner_calls,max_builder_calls,max_reviewer_calls,
        automatic_repair_calls,sizing_authority_id,sizing_authority_hash,local_input_counter_version,builder_prompt_version,reviewer_policy_version,
        cache_policy_version,cache_accounting_version,cache_write_input_multiplier_numerator,cache_write_input_multiplier_denominator,
        builder_input_token_cap,builder_output_token_cap,reviewer_input_token_cap,reviewer_output_token_cap,quote_json,created_at,expires_at)
        VALUES(?,?,2,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        quote.quoteId,quote.quoteHash,quote.policyVersion,quote.estimatorVersion,quote.parentRunId,quote.requesterUserId,quote.repositoryId,
        quote.parentCheckpointId,quote.parentCheckpointHash,quote.parentStateVersion,quote.selectionHash,quote.advisoryIds.length,
        quote.routingPolicyVersion,quote.pricingVersion,quote.estimate.maxCostMicrousd,quote.estimate.maxTokens,quote.estimate.maxTimeSeconds,
        quote.estimate.maxPlannerCalls,quote.estimate.maxBuilderCalls,quote.estimate.maxReviewerCalls,quote.estimate.automaticRepairCalls,
        quote.sizingAuthorityId,quote.sizingAuthorityHash,quote.localInputCounterVersion,quote.builderPromptVersion,quote.reviewerPolicyVersion,
        quote.cachePolicyVersion,quote.cacheAccountingVersion,quote.cacheWriteInputMultiplier.numerator,quote.cacheWriteInputMultiplier.denominator,
        quote.inputCaps.builderInputTokens,quote.inputCaps.builderOutputTokens,quote.inputCaps.reviewerInputTokens,quote.inputCaps.reviewerOutputTokens,
        canonicalJson(quote),quote.createdAt,quote.expiresAt);
      const request=this.quoteRequestAuthority(ownerId,input);
      this.db.query(`INSERT INTO hardening_quote_requests(id,request_hash,requester_user_id,parent_run_id,idempotency_key,quote_id,quote_hash,request_json,created_at)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(request.requestId,request.requestHash,ownerId,input.runId,input.idempotencyKey,quote.quoteId,quote.quoteHash,canonicalJson(request),createdAt);
      this.db.exec("COMMIT");return this.hardeningQuoteView(quote);
    } catch(error){try{this.db.exec("ROLLBACK");}catch{}throw error;}
  }

  async getHardeningQuoteForOwner(ownerId:string,runId:string,quoteId:string,attestor:CheckpointAttestor):Promise<HardeningQuoteView>{
    if(!this.db.query("SELECT 1 FROM engineer_runs WHERE id=? AND user_id=?").get(runId,ownerId))throw new EngineerNotFoundError("hardening quote",quoteId);
    const signed=await this.signedHardeningParent(runId,attestor);this.db.exec("BEGIN");
    try {
      const run=this.db.query("SELECT 1 FROM engineer_runs WHERE id=? AND user_id=?").get(runId,ownerId) as Record<string,unknown>|null;
      if(!run)throw new EngineerNotFoundError("hardening quote",quoteId);
      const checkpoint=this.assertSignedHardeningParent(runId,signed);
      const row=this.db.query("SELECT * FROM hardening_quotes WHERE id=? AND parent_run_id=? AND requester_user_id=?").get(quoteId,runId,ownerId) as Record<string,unknown>|null;
      if(!row)throw new EngineerNotFoundError("hardening quote",quoteId);const quote=this.hardeningQuoteFromRow(row);
      if(checkpoint.checkpointId!==quote.parentCheckpointId||checkpoint.checkpointHash!==quote.parentCheckpointHash)throw new HardeningAuthorityInvalidError();
      this.assertDeterministicQuoteAuthority(quote,checkpoint,false);
      const requestRow=this.db.query("SELECT * FROM hardening_quote_requests WHERE quote_id=? AND quote_hash=?").get(quote.quoteId,quote.quoteHash) as Record<string,unknown>|null;
      if(!requestRow)throw new HardeningAuthorityInvalidError();
      const requestInput=HardeningQuoteRequestSchema.parse({runId:quote.parentRunId,advisoryIds:quote.advisoryIds,expectedParentStateVersion:quote.parentStateVersion,idempotencyKey:requestRow.idempotency_key});
      this.assertQuoteRequestRow(requestRow,ownerId,requestInput);
      this.db.exec("COMMIT");return this.hardeningQuoteView(quote);
    } catch(error){try{this.db.exec("ROLLBACK");}catch{}throw error;}
  }

  async acceptHardeningConsentForOwner(ownerId:string,runId:string,rawInput:HardeningConsentRequest,attestor:CheckpointAttestor):Promise<HardeningConsent>{
    const input=HardeningConsentRequestSchema.parse(rawInput);
    if(!this.db.query("SELECT 1 FROM engineer_runs WHERE id=? AND user_id=?").get(runId,ownerId))throw new EngineerNotFoundError("hardening consent",input.quoteId);
    const signed=await this.signedHardeningParent(runId,attestor);this.db.exec("BEGIN IMMEDIATE");
    try {
      const run=this.db.query("SELECT state_version FROM engineer_runs WHERE id=? AND user_id=?").get(runId,ownerId) as {state_version:number}|null;
      if(!run)throw new EngineerNotFoundError("hardening consent",input.quoteId);
      // P10: hardening requester-scoped idempotency read, org-scoped (default org today).
      const existingRow=this.db.query("SELECT * FROM hardening_consents WHERE requester_user_id=? AND idempotency_key=? AND org_id=?").get(ownerId,input.idempotencyKey,this.tenantOrgId) as Record<string,unknown>|null;
      if(existingRow){const existing=this.hardeningConsentFromRow(existingRow);
        if(existing.parentRunId!==runId||existing.quoteId!==input.quoteId||existing.quoteHash!==input.quoteHash||existing.parentStateVersion!==input.expectedParentStateVersion||
          canonicalJson(existing.authorizedBudget)!==canonicalJson(input.authorizedBudget)||canonicalJson(existing.acknowledgements)!==canonicalJson(input.acknowledgements))
          throw new IdempotencyConflictError(runId,input.idempotencyKey);
        const checkpoint=this.assertSignedHardeningParent(runId,signed);
        const replayQuoteRow=this.db.query("SELECT * FROM hardening_quotes WHERE id=? AND quote_hash=? AND parent_run_id=? AND requester_user_id=?")
          .get(input.quoteId,input.quoteHash,runId,ownerId) as Record<string,unknown>|null;
        if(!replayQuoteRow)throw new HardeningAuthorityInvalidError();const replayQuote=this.hardeningQuoteFromRow(replayQuoteRow);this.assertCurrentHardeningQuote(replayQuote);
        if(replayQuote.parentCheckpointId!==checkpoint.checkpointId||replayQuote.parentCheckpointHash!==checkpoint.checkpointHash)throw new HardeningAuthorityInvalidError();
        this.assertDeterministicQuoteAuthority(replayQuote,checkpoint,false);
        const replayRequestRow=this.db.query("SELECT * FROM hardening_quote_requests WHERE quote_id=? AND quote_hash=?").get(replayQuote.quoteId,replayQuote.quoteHash) as Record<string,unknown>|null;
        if(!replayRequestRow)throw new HardeningAuthorityInvalidError();
        this.assertQuoteRequestRow(replayRequestRow,ownerId,HardeningQuoteRequestSchema.parse({runId,advisoryIds:replayQuote.advisoryIds,
          expectedParentStateVersion:replayQuote.parentStateVersion,idempotencyKey:replayRequestRow.idempotency_key}));
        this.db.exec("COMMIT");return existing;}
      if(run.state_version!==input.expectedParentStateVersion)throw new StateVersionConflictError(runId,input.expectedParentStateVersion,run.state_version);
      const checkpoint=this.assertSignedHardeningParent(runId,signed);
      const quoteRow=this.db.query("SELECT * FROM hardening_quotes WHERE id=? AND quote_hash=? AND parent_run_id=? AND requester_user_id=?").get(input.quoteId,input.quoteHash,runId,ownerId) as Record<string,unknown>|null;
      if(!quoteRow)throw new EngineerNotFoundError("hardening quote",input.quoteId);const quote=this.hardeningQuoteFromRow(quoteRow);this.assertCurrentHardeningQuote(quote);
      if(quote.parentStateVersion!==input.expectedParentStateVersion||quote.parentCheckpointId!==checkpoint.checkpointId||quote.parentCheckpointHash!==checkpoint.checkpointHash)throw new HardeningAuthorityInvalidError();
      this.assertDeterministicQuoteAuthority(quote,checkpoint,true);
      const now=this.now().toISOString();if(Date.parse(now)<Date.parse(quote.createdAt)||Date.parse(now)>Date.parse(quote.expiresAt))throw new HardeningQuoteExpiredError();
      const requestRow=this.db.query("SELECT * FROM hardening_quote_requests WHERE quote_id=? AND quote_hash=?").get(quote.quoteId,quote.quoteHash) as Record<string,unknown>|null;
      if(!requestRow)throw new HardeningAuthorityInvalidError();
      const quoteRequest=HardeningQuoteRequestSchema.parse({runId,advisoryIds:quote.advisoryIds,expectedParentStateVersion:quote.parentStateVersion,idempotencyKey:requestRow.idempotency_key});
      this.assertQuoteRequestRow(requestRow,ownerId,quoteRequest);
      const priorForQuote=this.db.query("SELECT * FROM hardening_consents WHERE quote_id=?").get(quote.quoteId) as Record<string,unknown>|null;
      if(priorForQuote){this.hardeningConsentFromRow(priorForQuote);throw new IdempotencyConflictError(runId,input.idempotencyKey);}
      const consent=createHardeningConsent({schemaVersion:1,policyVersion:"engineer-hardening-consent-v1",quoteId:quote.quoteId,quoteHash:quote.quoteHash,
        parentRunId:runId,parentCheckpointId:quote.parentCheckpointId,parentCheckpointHash:quote.parentCheckpointHash,parentStateVersion:quote.parentStateVersion,
        selectionHash:quote.selectionHash,requesterUserId:ownerId,actorId:ownerId,authorizedBudget:input.authorizedBudget,
        acknowledgements:input.acknowledgements,idempotencyKey:input.idempotencyKey,acceptedAt:now,quoteExpiresAt:quote.expiresAt},quote);
      this.db.query(`INSERT INTO hardening_consents(id,consent_hash,schema_version,policy_version,quote_id,quote_hash,parent_run_id,parent_checkpoint_id,
        parent_checkpoint_hash,parent_state_version,selection_hash,requester_user_id,actor_id,cost_microusd,tokens,time_seconds,
        acknowledge_separate_run,acknowledge_parent_unchanged,acknowledge_no_automatic_repair,acknowledge_no_overages,idempotency_key,consent_json,accepted_at,quote_expires_at)
        VALUES(?,?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,1,1,1,1,?,?,?,?)`).run(consent.consentId,consent.consentHash,consent.policyVersion,
        consent.quoteId,consent.quoteHash,consent.parentRunId,consent.parentCheckpointId,consent.parentCheckpointHash,consent.parentStateVersion,
        consent.selectionHash,consent.requesterUserId,consent.actorId,consent.authorizedBudget.costMicrousd,consent.authorizedBudget.tokens,
        consent.authorizedBudget.timeSeconds,consent.idempotencyKey,canonicalJson(consent),consent.acceptedAt,consent.quoteExpiresAt);
      this.db.exec("COMMIT");return consent;
    } catch(error){try{this.db.exec("ROLLBACK");}catch{}throw error;}
  }

  private hardeningLineageFromRow(row:Record<string,unknown>):EngineerRunLineage{
    try{const lineage=EngineerRunLineageSchema.parse(JSON.parse(String(row.lineage_json)));
      const projection:Record<string,unknown>={id:lineage.lineageId,lineage_hash:lineage.lineageHash,schema_version:lineage.schemaVersion,
        policy_version:lineage.policyVersion,relation:lineage.relation,root_run_id:lineage.rootRunId,parent_run_id:lineage.parentRunId,
        child_run_id:lineage.childRunId,requester_user_id:lineage.requesterUserId,repository_id:lineage.repositoryId,
        parent_checkpoint_id:lineage.parentCheckpointId,parent_checkpoint_hash:lineage.parentCheckpointHash,
        parent_base_commit_sha:lineage.parentBaseCommitSha,seed_result_commit_sha:lineage.seedResultCommitSha,
        quote_id:lineage.quoteId,quote_hash:lineage.quoteHash,consent_id:lineage.consentId,consent_hash:lineage.consentHash,
        selection_hash:lineage.selectionHash,cost_microusd:lineage.budget.costMicrousd,tokens:lineage.budget.tokens,
        time_seconds:lineage.budget.timeSeconds,lineage_json:canonicalJson(lineage),created_at:lineage.createdAt};
      if(Object.entries(projection).some(([key,value])=>row[key]!==value))throw new HardeningAuthorityInvalidError();return lineage;
    }catch(error){if(error instanceof HardeningAuthorityInvalidError)throw error;throw new HardeningAuthorityInvalidError();}
  }

  private optionalHardeningRoot(parentRunId:string):string{
    const parents=this.db.query("SELECT * FROM engineer_run_lineage WHERE child_run_id=?").all(parentRunId) as Array<Record<string,unknown>>;
    if(parents.length===0)return parentRunId;if(parents.length!==1)throw new HardeningAuthorityInvalidError();
    const parent=this.hardeningLineageFromRow(parents[0]!);
    if(parent.childRunId!==parentRunId||parent.rootRunId===parent.childRunId)throw new HardeningAuthorityInvalidError();
    const seen=new Set<string>([parentRunId]);let cursor=parent;
    while(cursor.parentRunId!==cursor.rootRunId){if(seen.has(cursor.parentRunId))throw new HardeningAuthorityInvalidError();seen.add(cursor.parentRunId);
      const rows=this.db.query("SELECT * FROM engineer_run_lineage WHERE child_run_id=?").all(cursor.parentRunId) as Array<Record<string,unknown>>;
      if(rows.length!==1)throw new HardeningAuthorityInvalidError();cursor=this.hardeningLineageFromRow(rows[0]!);
      if(cursor.rootRunId!==parent.rootRunId)throw new HardeningAuthorityInvalidError();}
    if(cursor.parentRunId!==parent.rootRunId||seen.has(parent.rootRunId))throw new HardeningAuthorityInvalidError();return parent.rootRunId;
  }

  private optionalHardeningAuthority(input:{rootRunId:string;parentRunId:string;childRunId:string;ownerId:string;repositoryId:string;
    checkpoint:VerifiedCandidateCheckpoint;quote:HardeningQuote;consent:HardeningConsent;advisories:AdvisoryBacklogItem[];createdAt:string}):OptionalHardeningChildAuthority{
    return createOptionalHardeningChildAuthority({schemaVersion:1,policyVersion:"engineer-hardening-child-request-v1",rootRunId:input.rootRunId,
      parentRunId:input.parentRunId,childRunId:input.childRunId,requesterUserId:input.ownerId,repositoryId:input.repositoryId,
      parentCheckpointId:input.checkpoint.checkpointId,parentCheckpointHash:input.checkpoint.checkpointHash,quoteId:input.quote.quoteId,
      quoteHash:input.quote.quoteHash,consentId:input.consent.consentId,consentHash:input.consent.consentHash,
      advisoryIds:input.quote.advisoryIds,requiredChanges:input.advisories.map((item)=>({advisoryId:item.advisoryId,
        requiredChange:item.requiredChange,file:item.file!,lineStart:item.lineStart,lineEnd:item.lineEnd})),selectionHash:input.quote.selectionHash,
      seedResultCommitSha:input.checkpoint.resultCommitSha,createdAt:input.createdAt});
  }

  private optionalHardeningChildView(lineage:EngineerRunLineage,riskTier:"LOW"|"MEDIUM"|"HIGH"|"CRITICAL"):OptionalHardeningChildView{
    return OptionalHardeningChildViewSchema.parse({schemaVersion:1,parentRunId:lineage.parentRunId,rootRunId:lineage.rootRunId,
      childRunId:lineage.childRunId,lineageId:lineage.lineageId,lineageHash:lineage.lineageHash,state:"REQUEST_RECEIVED",stateVersion:0,
      riskTier,humanGateRequired:true,budget:lineage.budget,createdAt:lineage.createdAt});
  }

  private assertOptionalHardeningChild(lineage:EngineerRunLineage,authority:OptionalHardeningChildAuthority,
    parent:RunRow,riskTier:"LOW"|"MEDIUM"|"HIGH"|"CRITICAL"):OptionalHardeningChildCreation{
    if(lineage.rootRunId!==authority.rootRunId||lineage.parentRunId!==authority.parentRunId||lineage.childRunId!==authority.childRunId||
      lineage.requesterUserId!==authority.requesterUserId||lineage.repositoryId!==authority.repositoryId||lineage.parentCheckpointId!==authority.parentCheckpointId||
      lineage.parentCheckpointHash!==authority.parentCheckpointHash||lineage.parentBaseCommitSha!==parent.base_commit_sha||
      lineage.seedResultCommitSha!==authority.seedResultCommitSha||lineage.quoteId!==authority.quoteId||lineage.quoteHash!==authority.quoteHash||
      lineage.consentId!==authority.consentId||lineage.consentHash!==authority.consentHash||lineage.selectionHash!==authority.selectionHash)throw new HardeningAuthorityInvalidError();
    const child=this.db.query(`${RUN_SELECT} WHERE r.id=? AND r.user_id=?`).get(lineage.childRunId,lineage.requesterUserId) as RunRow|null;
    if(!child||child.repository_id!==parent.repository_id||child.provider!==parent.provider||child.owner!==parent.owner||
      child.repository_name!==parent.repository_name||child.repository_url!==parent.repository_url||child.base_branch!==parent.base_branch||
      child.base_commit_sha!==parent.base_commit_sha||child.request_original!==canonicalJson(authority)||child.request_normalized!==canonicalJson(authority)||
      child.state!=="REQUEST_RECEIVED"||child.state_version!==0||child.manifest_hash!==null||child.risk_tier!==riskTier||child.human_gate_required!==1||
      child.created_at!==lineage.createdAt||child.updated_at!==lineage.createdAt||child.terminal_at!==null)throw new HardeningAuthorityInvalidError();
    const budget=this.db.query("SELECT * FROM run_budgets WHERE run_id=?").get(child.id) as BudgetRow|null;
    const cost=lineage.budget.costMicrousd/1_000_000;
    if(!budget||budget.cost_limit_usd!==cost||budget.token_limit!==lineage.budget.tokens||budget.time_limit_seconds!==lineage.budget.timeSeconds||
      budget.lifetime_cost_limit_usd!==cost||budget.lifetime_token_limit!==lineage.budget.tokens||budget.lifetime_time_limit_seconds!==lineage.budget.timeSeconds||
      budget.used_cost_usd!==0||budget.used_tokens!==0||budget.used_time_seconds!==0||budget.reserved_cost_usd!==0||budget.reserved_tokens!==0||
      budget.ambiguous_cost_usd!==0||budget.ambiguous_tokens!==0||budget.status!=="ACTIVE"||budget.pause_reason!==null||budget.resume_state!==null||
      budget.warning_threshold!==0.8||budget.revision!==0||budget.active_since!==lineage.createdAt||budget.created_at!==lineage.createdAt||
      budget.updated_at!==lineage.createdAt)throw new HardeningAuthorityInvalidError();
    for(const table of ["task_manifest_versions","plan_proposals","run_state_events","agent_executions","sandboxes","artifacts","approval_requests","git_operations"] as const){
      const count=this.db.query(`SELECT COUNT(*) AS count FROM ${table} WHERE run_id=?`).get(child.id) as {count:number};if(count.count!==0)throw new HardeningAuthorityInvalidError();}
    return OptionalHardeningChildCreationSchema.parse({child:this.optionalHardeningChildView(lineage,riskTier),lineage:{
      schemaVersion:lineage.schemaVersion,policyVersion:lineage.policyVersion,relation:lineage.relation,lineageId:lineage.lineageId,
      lineageHash:lineage.lineageHash,rootRunId:lineage.rootRunId,parentRunId:lineage.parentRunId,childRunId:lineage.childRunId,
      parentCheckpointId:lineage.parentCheckpointId,parentCheckpointHash:lineage.parentCheckpointHash,parentBaseCommitSha:lineage.parentBaseCommitSha,
      seedResultCommitSha:lineage.seedResultCommitSha,quoteId:lineage.quoteId,quoteHash:lineage.quoteHash,consentId:lineage.consentId,
      consentHash:lineage.consentHash,selectionHash:lineage.selectionHash,budget:lineage.budget,createdAt:lineage.createdAt,
    }});
  }

  async createOptionalHardeningChildForOwner(ownerId:string,parentRunId:string,rawInput:OptionalHardeningChildRequest,
    attestor:CheckpointAttestor):Promise<OptionalHardeningChildCreation>{
    const input=OptionalHardeningChildRequestSchema.parse(rawInput);
    if(!this.db.query("SELECT 1 FROM engineer_runs WHERE id=? AND user_id=?").get(parentRunId,ownerId))throw new EngineerNotFoundError("hardening child",parentRunId);
    const signed=await this.signedHardeningParent(parentRunId,attestor);this.db.exec("BEGIN IMMEDIATE");
    try{const parent=this.db.query(`${RUN_SELECT} WHERE r.id=? AND r.user_id=?`).get(parentRunId,ownerId) as RunRow|null;
      if(!parent)throw new EngineerNotFoundError("hardening child",parentRunId);const checkpoint=this.assertSignedHardeningParent(parentRunId,signed);
      if(parent.repository_id!==checkpoint.repositoryId||parent.base_commit_sha!==checkpoint.baseCommitSha)throw new HardeningAuthorityInvalidError();
      const consentRow=this.db.query("SELECT * FROM hardening_consents WHERE id=? AND consent_hash=? AND parent_run_id=? AND requester_user_id=?")
        .get(input.consentId,input.consentHash,parentRunId,ownerId) as Record<string,unknown>|null;
      if(!consentRow)throw new EngineerNotFoundError("hardening consent",input.consentId);const consent=this.hardeningConsentFromRow(consentRow);
      const quoteRow=this.db.query("SELECT * FROM hardening_quotes WHERE id=? AND quote_hash=? AND parent_run_id=? AND requester_user_id=?")
        .get(consent.quoteId,consent.quoteHash,parentRunId,ownerId) as Record<string,unknown>|null;
      if(!quoteRow)throw new HardeningAuthorityInvalidError();const quote=this.hardeningQuoteFromRow(quoteRow);this.assertCurrentHardeningQuote(quote);
      const {consentId:_consentId,consentHash:_consentHash,...consentContent}=consent;
      if(canonicalJson(createHardeningConsent(consentContent,quote))!==canonicalJson(consent))throw new HardeningAuthorityInvalidError();
      const requestRow=this.db.query("SELECT * FROM hardening_quote_requests WHERE quote_id=? AND quote_hash=?").get(quote.quoteId,quote.quoteHash) as Record<string,unknown>|null;
      if(!requestRow)throw new HardeningAuthorityInvalidError();this.assertQuoteRequestRow(requestRow,ownerId,HardeningQuoteRequestSchema.parse({runId:parentRunId,
        advisoryIds:quote.advisoryIds,expectedParentStateVersion:quote.parentStateVersion,idempotencyKey:requestRow.idempotency_key}));
      const childRunId=hardeningChildRunId(consent.consentHash);const rootRunId=this.optionalHardeningRoot(parentRunId);
      if(childRunId===parentRunId||childRunId===rootRunId)throw new HardeningAuthorityInvalidError();
      const existingRows=this.db.query("SELECT * FROM engineer_run_lineage WHERE consent_id=? AND consent_hash=?").all(consent.consentId,consent.consentHash) as Array<Record<string,unknown>>;
      if(existingRows.length>1)throw new HardeningAuthorityInvalidError();
      if(existingRows.length===1){const lineage=this.hardeningLineageFromRow(existingRows[0]!);const advisories=this.assertDeterministicQuoteAuthority(quote,checkpoint,false);
        const authority=this.optionalHardeningAuthority({rootRunId,parentRunId,childRunId,ownerId,repositoryId:parent.repository_id,checkpoint,quote,consent,advisories,createdAt:lineage.createdAt});
        const risk=this.optionalHardeningRisk(parent.risk_tier,advisories);const view=this.assertOptionalHardeningChild(lineage,authority,parent,risk);this.db.exec("COMMIT");return view;}
      const advisories=this.assertDeterministicQuoteAuthority(quote,checkpoint,true);
      if(this.db.query("SELECT 1 FROM engineer_runs WHERE id=?").get(childRunId))throw new HardeningAuthorityInvalidError();
      const active=this.db.query(`SELECT 1 FROM engineer_run_lineage l JOIN engineer_runs r ON r.id=l.child_run_id
        WHERE l.parent_checkpoint_id=? AND r.state NOT IN (${TERMINAL_STATES.map(()=>"?").join(",")}) LIMIT 1`).get(checkpoint.checkpointId,...TERMINAL_STATES);
      if(active)throw new HardeningSelectionInvalidError();
      const createdAt=this.now().toISOString();const risk=this.optionalHardeningRisk(parent.risk_tier,advisories);
      const authority=this.optionalHardeningAuthority({rootRunId,parentRunId,childRunId,ownerId,repositoryId:parent.repository_id,checkpoint,quote,consent,advisories,createdAt});
      const requestBytes=canonicalJson(authority);const cost=consent.authorizedBudget.costMicrousd/1_000_000;
      this.db.query(`INSERT INTO engineer_runs(id,user_id,repository_id,base_branch,base_commit_sha,request_original,request_normalized,state,state_version,
        manifest_hash,risk_tier,human_gate_required,created_at,updated_at,terminal_at) VALUES(?,?,?,?,?,?,?,'REQUEST_RECEIVED',0,NULL,?,1,?,?,NULL)`).run(
        childRunId,ownerId,parent.repository_id,parent.base_branch,parent.base_commit_sha,requestBytes,requestBytes,risk,createdAt,createdAt);
      this.db.query(`INSERT INTO run_budgets(run_id,cost_limit_usd,token_limit,time_limit_seconds,lifetime_cost_limit_usd,lifetime_token_limit,
        lifetime_time_limit_seconds,used_cost_usd,used_tokens,used_time_seconds,reserved_cost_usd,reserved_tokens,ambiguous_cost_usd,ambiguous_tokens,
        status,pause_reason,resume_state,revision,active_since,created_at,updated_at) VALUES(?,?,?,?,?,?,?,0,0,0,0,0,0,0,'ACTIVE',NULL,NULL,0,?,?,?)`).run(
        childRunId,cost,consent.authorizedBudget.tokens,consent.authorizedBudget.timeSeconds,cost,consent.authorizedBudget.tokens,
        consent.authorizedBudget.timeSeconds,createdAt,createdAt,createdAt);
      const lineage=createEngineerRunLineage({schemaVersion:1,policyVersion:"engineer-hardening-lineage-v1",relation:"OPTIONAL_HARDENING",rootRunId,
        parentRunId,childRunId,requesterUserId:ownerId,repositoryId:parent.repository_id,parentCheckpointId:checkpoint.checkpointId,
        parentCheckpointHash:checkpoint.checkpointHash,parentBaseCommitSha:checkpoint.baseCommitSha,seedResultCommitSha:checkpoint.resultCommitSha,
        quoteId:quote.quoteId,quoteHash:quote.quoteHash,consentId:consent.consentId,consentHash:consent.consentHash,selectionHash:quote.selectionHash,
        budget:consent.authorizedBudget,createdAt});
      this.db.query(`INSERT INTO engineer_run_lineage(id,lineage_hash,schema_version,policy_version,relation,root_run_id,parent_run_id,child_run_id,
        requester_user_id,repository_id,parent_checkpoint_id,parent_checkpoint_hash,parent_base_commit_sha,seed_result_commit_sha,quote_id,quote_hash,
        consent_id,consent_hash,selection_hash,cost_microusd,tokens,time_seconds,lineage_json,created_at) VALUES(?,?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        lineage.lineageId,lineage.lineageHash,lineage.policyVersion,lineage.relation,lineage.rootRunId,lineage.parentRunId,lineage.childRunId,
        lineage.requesterUserId,lineage.repositoryId,lineage.parentCheckpointId,lineage.parentCheckpointHash,lineage.parentBaseCommitSha,
        lineage.seedResultCommitSha,lineage.quoteId,lineage.quoteHash,lineage.consentId,lineage.consentHash,lineage.selectionHash,
        lineage.budget.costMicrousd,lineage.budget.tokens,lineage.budget.timeSeconds,canonicalJson(lineage),lineage.createdAt);
      const view=this.assertOptionalHardeningChild(lineage,authority,parent,risk);this.db.exec("COMMIT");return view;
    }catch(error){try{this.db.exec("ROLLBACK");}catch{}throw error;}
  }

  private optionalHardeningRisk(parent:"LOW"|"MEDIUM"|"HIGH"|"CRITICAL",advisories:readonly AdvisoryBacklogItem[]):"LOW"|"MEDIUM"|"HIGH"|"CRITICAL"{
    const floor=advisories.some((item)=>item.reportedSeverity==="HIGH"||item.reportedSeverity==="CRITICAL")?"HIGH":"LOW";
    const order={LOW:0,MEDIUM:1,HIGH:2,CRITICAL:3} as const;return order[parent]>=order[floor]?parent:floor;
  }

  private optionalHardeningStartPreparationUnderLock(ownerId:string,parentRunId:string,childRunId:string,input:HardeningStartRequest,
    checkpoint:VerifiedCandidateCheckpoint,requireOpen:boolean,operationCreatedAt:string):OptionalHardeningStartPreparation{
    const rows=this.db.query("SELECT * FROM engineer_run_lineage WHERE child_run_id=?").all(childRunId) as Array<Record<string,unknown>>;
    if(rows.length!==1)throw new HardeningAuthorityInvalidError();const lineage=this.hardeningLineageFromRow(rows[0]!);
    if(lineage.parentRunId!==parentRunId||lineage.requesterUserId!==ownerId||lineage.lineageId!==input.lineageId||lineage.lineageHash!==input.lineageHash||
      lineage.parentCheckpointId!==checkpoint.checkpointId||lineage.parentCheckpointHash!==checkpoint.checkpointHash)throw new HardeningAuthorityInvalidError();
    const parent=this.db.query(`${RUN_SELECT} WHERE r.id=? AND r.user_id=?`).get(parentRunId,ownerId) as RunRow|null;
    if(!parent||parent.repository_id!==checkpoint.repositoryId||parent.base_commit_sha!==checkpoint.baseCommitSha)throw new HardeningAuthorityInvalidError();
    const consentRow=this.db.query("SELECT * FROM hardening_consents WHERE id=? AND consent_hash=? AND parent_run_id=? AND requester_user_id=?")
      .get(lineage.consentId,lineage.consentHash,parentRunId,ownerId) as Record<string,unknown>|null;
    if(!consentRow)throw new HardeningAuthorityInvalidError();const consent=this.hardeningConsentFromRow(consentRow);
    const quoteRow=this.db.query("SELECT * FROM hardening_quotes WHERE id=? AND quote_hash=? AND parent_run_id=? AND requester_user_id=?")
      .get(lineage.quoteId,lineage.quoteHash,parentRunId,ownerId) as Record<string,unknown>|null;
    if(!quoteRow)throw new HardeningAuthorityInvalidError();const quote=this.hardeningQuoteFromRow(quoteRow);this.assertCurrentHardeningQuote(quote);
    const {consentId:_consentId,consentHash:_consentHash,...consentContent}=consent;
    if(canonicalJson(createHardeningConsent(consentContent,quote))!==canonicalJson(consent))throw new HardeningAuthorityInvalidError();
    const requestRow=this.db.query("SELECT * FROM hardening_quote_requests WHERE quote_id=? AND quote_hash=?").get(quote.quoteId,quote.quoteHash) as Record<string,unknown>|null;
    if(!requestRow)throw new HardeningAuthorityInvalidError();this.assertQuoteRequestRow(requestRow,ownerId,HardeningQuoteRequestSchema.parse({runId:parentRunId,
      advisoryIds:quote.advisoryIds,expectedParentStateVersion:quote.parentStateVersion,idempotencyKey:requestRow.idempotency_key}));
    const advisories=this.assertDeterministicQuoteAuthority(quote,checkpoint,requireOpen);
    const authority=this.optionalHardeningAuthority({rootRunId:lineage.rootRunId,parentRunId,childRunId,ownerId,repositoryId:parent.repository_id,
      checkpoint,quote,consent,advisories,createdAt:lineage.createdAt});
    const risk=this.optionalHardeningRisk(parent.risk_tier,advisories);
    if(requireOpen)this.assertOptionalHardeningChild(lineage,authority,parent,risk);
    else {const child=this.db.query(`${RUN_SELECT} WHERE r.id=? AND r.user_id=?`).get(childRunId,ownerId) as RunRow|null;
      if(!child||child.repository_id!==parent.repository_id||child.base_branch!==parent.base_branch||child.base_commit_sha!==parent.base_commit_sha||
        child.request_original!==canonicalJson(authority)||child.request_normalized!==canonicalJson(authority)||child.risk_tier!==risk||child.human_gate_required!==1||
        child.created_at!==lineage.createdAt)throw new HardeningAuthorityInvalidError();
      const budget=this.db.query("SELECT * FROM run_budgets WHERE run_id=?").get(childRunId) as BudgetRow|null;const cost=lineage.budget.costMicrousd/1_000_000;
      if(!budget||budget.cost_limit_usd!==cost||budget.token_limit!==lineage.budget.tokens||budget.time_limit_seconds!==lineage.budget.timeSeconds||
        budget.lifetime_cost_limit_usd!==cost||budget.lifetime_token_limit!==lineage.budget.tokens||budget.lifetime_time_limit_seconds!==lineage.budget.timeSeconds||
        budget.created_at!==lineage.createdAt)throw new HardeningAuthorityInvalidError();}
    const parentManifest=this.getManifest(parentRunId);if(!parentManifest)throw new HardeningAuthorityInvalidError();
    const review=this.latestClassifiedReview(parentRunId);if(!review||review.session.reviewerSessionId!==checkpoint.reviewerSessionId||
      review.reviewerInput.diffHash!==checkpoint.diffHash||review.reviewerInput.resultCommitSha!==checkpoint.resultCommitSha)throw new HardeningAuthorityInvalidError();
    const operation=createHardeningStartOperation({schemaVersion:1,policyVersion:"engineer-hardening-start-operation-v1",requesterUserId:ownerId,
      childRunId,expectedChildStateVersion:0,lineageId:lineage.lineageId,lineageHash:lineage.lineageHash,idempotencyKey:input.idempotencyKey,createdAt:operationCreatedAt});
    return {replay:false,operation,lineage,authority,parentCheckpoint:checkpoint,parentManifest,
      child:{riskTier:risk,humanGateRequired:true,budget:lineage.budget,createdAt:lineage.createdAt},
      seed:{finalDiff:review.reviewerInput.finalDiff,diffHash:checkpoint.diffHash,baseCommitSha:checkpoint.baseCommitSha,
      seedResultCommitSha:checkpoint.resultCommitSha,environmentDigest:checkpoint.environmentDigest},signedSeed:null};
  }

  private hardeningStartOperationFromRow(row:Record<string,unknown>):HardeningStartOperation{
    try{const operation=HardeningStartOperationSchema.parse(JSON.parse(String(row.operation_json)));
      if(row.id!==operation.operationId||row.operation_hash!==operation.operationHash||row.schema_version!==operation.schemaVersion||
        row.policy_version!==operation.policyVersion||row.requester_user_id!==operation.requesterUserId||row.child_run_id!==operation.childRunId||
        row.expected_child_state_version!==operation.expectedChildStateVersion||row.lineage_id!==operation.lineageId||row.lineage_hash!==operation.lineageHash||
        row.idempotency_key!==operation.idempotencyKey||row.created_at!==operation.createdAt||canonicalJson(operation)!==String(row.operation_json))throw new HardeningAuthorityInvalidError();
      return operation;}catch(error){if(error instanceof HardeningAuthorityInvalidError)throw error;throw new HardeningAuthorityInvalidError();}
  }

  private hardeningSeedFromRow(row:Record<string,unknown>):SignedHardeningSeedAttestation{
    try{const attestation=HardeningSeedAttestationSchema.parse(JSON.parse(String(row.attestation_json)));
      const signed=SignedHardeningSeedAttestationSchema.parse({attestation,statement:JSON.parse(String(row.statement_json)),statementJson:row.statement_json,
        statementHash:row.statement_hash,algorithm:row.signature_algorithm,keyId:row.signature_key_id,signature:row.signature});
      if(row.id!==attestation.seedAttestationId||row.seed_attestation_hash!==attestation.seedAttestationHash||row.schema_version!==attestation.schemaVersion||
        row.policy_version!==attestation.policyVersion||row.attestation_type!==attestation.attestationType||row.operation_id!==attestation.operationId||
        row.operation_hash!==attestation.operationHash||row.root_run_id!==attestation.rootRunId||row.parent_run_id!==attestation.parentRunId||
        row.child_run_id!==attestation.childRunId||row.requester_user_id!==attestation.requesterUserId||row.repository_id!==attestation.repositoryId||
        row.lineage_id!==attestation.lineageId||row.lineage_hash!==attestation.lineageHash||row.parent_checkpoint_id!==attestation.parentCheckpointId||
        row.parent_checkpoint_hash!==attestation.parentCheckpointHash||row.base_commit_sha!==attestation.baseCommitSha||
        row.seed_result_commit_sha!==attestation.seedResultCommitSha||row.seed_tree_hash!==attestation.seedTreeHash||row.seed_diff_hash!==attestation.seedDiffHash||
        row.image_digest!==attestation.imageDigest||row.environment_digest!==attestation.environmentDigest||row.dependency_hash!==attestation.dependencyHash||
        row.created_at!==attestation.createdAt||canonicalJson(attestation)!==String(row.attestation_json))throw new HardeningAuthorityInvalidError();return signed;
    }catch(error){if(error instanceof HardeningAuthorityInvalidError)throw error;throw new HardeningAuthorityInvalidError();}
  }

  listOptionalHardeningStartOperationsForOwner(ownerId:string):Array<{parentRunId:string;operation:HardeningStartOperation}>{
    const rows=this.db.query(`SELECT o.*,l.parent_run_id FROM hardening_start_operations o
      JOIN engineer_run_lineage l ON l.id=o.lineage_id AND l.lineage_hash=o.lineage_hash
      JOIN engineer_runs c ON c.id=o.child_run_id
      WHERE o.requester_user_id=? AND c.user_id=? ORDER BY o.created_at,o.id`).all(ownerId,ownerId) as Array<Record<string,unknown>>;
    return rows.map((row)=>({parentRunId:String(row.parent_run_id),operation:this.hardeningStartOperationFromRow(row)}));
  }

  isOptionalHardeningChild(runId:string):boolean{
    this.getRun(runId);const lineageCount=(this.db.query(
      "SELECT COUNT(*) AS count FROM engineer_run_lineage WHERE child_run_id=?").get(runId) as {count:number}).count,
      operationCount=(this.db.query("SELECT COUNT(*) AS count FROM hardening_start_operations WHERE child_run_id=?")
        .get(runId) as {count:number}).count,exact=Boolean(this.db.query(`SELECT 1 FROM engineer_run_lineage l
      JOIN hardening_start_operations o ON o.lineage_id=l.id AND o.lineage_hash=l.lineage_hash
      WHERE l.child_run_id=? AND o.child_run_id=l.child_run_id`).get(runId));
    if(exact&&lineageCount===1&&operationCount===1)return true;
    if(lineageCount===1&&operationCount===0){
      const started=this.db.query(`SELECT 1 FROM hardening_seed_attestations WHERE child_run_id=?
        UNION ALL SELECT 1 FROM hardening_child_budget_authorities WHERE child_run_id=? LIMIT 1`).get(runId,runId);
      if(!started)return true;
    }
    const marker=this.db.query(`SELECT 1 FROM engineer_run_lineage WHERE child_run_id=?
      UNION ALL SELECT 1 FROM hardening_start_operations WHERE child_run_id=?
      UNION ALL SELECT 1 FROM hardening_seed_attestations WHERE child_run_id=?
      UNION ALL SELECT 1 FROM hardening_child_budget_authorities WHERE child_run_id=?
      UNION ALL SELECT 1 FROM advisory_backlog_events WHERE child_run_id=? LIMIT 1`).get(
        runId,runId,runId,runId,runId);
    if(marker)throw new HardeningAuthorityInvalidError();
    return false;
  }

  private hardeningChildBudgetFromRow(row:Record<string,unknown>):HardeningBudgetAuthority{
    try{
      const authority=createHardeningBudgetAuthority({
        schemaVersion:1,policyVersion:"engineer-hardening-child-budget-v1",childRunId:String(row.child_run_id),
        lineageId:String(row.lineage_id),lineageHash:String(row.lineage_hash),quoteId:String(row.quote_id),quoteHash:String(row.quote_hash),
        consentId:String(row.consent_id),consentHash:String(row.consent_hash),costLimitMicrousd:Number(row.cost_limit_microusd),
        tokenLimit:Number(row.token_limit),activeTimeLimitMs:Number(row.active_time_limit_ms),
        estimationAuthority:DEFAULT_HARDENING_ESTIMATION_AUTHORITY_V2,
        paidGraph:{plannerCalls:0,builderCalls:1,reviewerCalls:1,automaticRepairCalls:0},
        toolLimits:{maxToolCalls:8,maxMutations:8,maxCommandCalls:8,maxToolArgumentBytes:131072,maxFileBytes:1048576,maxToolResultBytes:32768,
          maxSearchBytes:8388608,maxSearchResults:100,maxRangeLines:400},
        transportLimits:{builderInputCap:Number(row.builder_input_token_cap),builderOutputCeiling:6000,
          reviewerInputCap:40_000,reviewerOutputCeiling:12000,modelTimeoutMs:120000},createdAt:new Date(Number(row.created_at_ms)).toISOString(),
      });
      if(row.id!==authority.budgetAuthorityId||row.authority_hash!==authority.budgetAuthorityHash||row.schema_version!==authority.schemaVersion||
        row.policy_version!==authority.policyVersion||Number(row.max_builder_calls)!==1||Number(row.max_reviewer_calls)!==1||Number(row.automatic_repair_calls)!==0||
        Number(row.max_tool_calls)!==8||Number(row.max_mutations)!==8||Number(row.max_command_calls)!==8||Number(row.max_tool_argument_bytes)!==131072||
        Number(row.max_file_bytes)!==1048576||Number(row.max_tool_result_bytes)!==32768||Number(row.max_search_bytes)!==8388608||
        Number(row.max_search_results)!==100||Number(row.max_range_lines)!==400||Number(row.builder_output_ceiling)!==6000||
        Number(row.builder_input_token_cap)!==authority.transportLimits.builderInputCap||
        Number(row.reviewer_input_token_cap)!==authority.transportLimits.reviewerInputCap||
        Number(row.reviewer_output_ceiling)!==12000||Number(row.model_timeout_ms)!==120000)throw new HardeningBudgetAuthorityInvalidError();
      return HardeningBudgetAuthoritySchema.parse(authority);
    }catch(error){if(error instanceof HardeningBudgetAuthorityInvalidError)throw error;throw new HardeningBudgetAuthorityInvalidError();}
  }

  private initializeHardeningChildBudgetUnderLock(preparation:OptionalHardeningStartPreparation,nowMs:number):HardeningBudgetAuthority{
    if(!Number.isSafeInteger(nowMs)||nowMs<0)throw new HardeningBudgetAuthorityInvalidError();
    const existing=this.db.query("SELECT * FROM hardening_child_budget_authorities WHERE child_run_id=?").get(preparation.operation.childRunId) as Record<string,unknown>|null;
    if(existing)return this.hardeningChildBudgetFromRow(existing);
    const lineage=preparation.lineage,quoteRow=this.db.query("SELECT * FROM hardening_quotes WHERE id=? AND quote_hash=?")
      .get(lineage.quoteId,lineage.quoteHash) as Record<string,unknown>|null;if(!quoteRow)throw new HardeningBudgetAuthorityInvalidError();
    const quote=this.hardeningQuoteFromRow(quoteRow);this.assertCurrentHardeningQuote(quote);
    const authority=createHardeningBudgetAuthority({schemaVersion:1,policyVersion:"engineer-hardening-child-budget-v1",
      childRunId:lineage.childRunId,lineageId:lineage.lineageId,lineageHash:lineage.lineageHash,quoteId:lineage.quoteId,quoteHash:lineage.quoteHash,
      consentId:lineage.consentId,consentHash:lineage.consentHash,costLimitMicrousd:lineage.budget.costMicrousd,tokenLimit:lineage.budget.tokens,
      activeTimeLimitMs:lineage.budget.timeSeconds*1000,estimationAuthority:DEFAULT_HARDENING_ESTIMATION_AUTHORITY_V2,
      paidGraph:{plannerCalls:0,builderCalls:1,reviewerCalls:1,automaticRepairCalls:0},
      toolLimits:{maxToolCalls:8,maxMutations:8,maxCommandCalls:8,maxToolArgumentBytes:131072,maxFileBytes:1048576,maxToolResultBytes:32768,
        maxSearchBytes:8388608,maxSearchResults:100,maxRangeLines:400},
      transportLimits:{builderInputCap:quote.inputCaps.builderInputTokens,builderOutputCeiling:6000,
        reviewerInputCap:quote.inputCaps.reviewerInputTokens,reviewerOutputCeiling:12000,modelTimeoutMs:120000},createdAt:new Date(nowMs).toISOString()});
    this.db.query(`INSERT INTO hardening_child_budget_authorities(id,authority_hash,schema_version,policy_version,child_run_id,lineage_id,lineage_hash,
      quote_id,quote_hash,consent_id,consent_hash,cost_limit_microusd,token_limit,active_time_limit_ms,max_builder_calls,max_reviewer_calls,
      max_tool_calls,max_mutations,max_command_calls,max_tool_argument_bytes,max_file_bytes,max_tool_result_bytes,max_search_bytes,max_search_results,
      max_range_lines,builder_input_token_cap,builder_output_ceiling,reviewer_input_token_cap,reviewer_output_ceiling,model_timeout_ms,automatic_repair_calls,used_cost_microusd,used_tokens,
      reserved_cost_microusd,reserved_tokens,ambiguous_cost_microusd,ambiguous_tokens,used_active_ms,active_since_ms,fence_owner_id,
      fence_token_hash,fence_generation,fence_expires_at_ms,status,stop_reason,revision,created_at_ms,updated_at_ms)
      VALUES(${Array.from({length:48},()=>"?").join(",")})`).run(
      authority.budgetAuthorityId,authority.budgetAuthorityHash,1,authority.policyVersion,authority.childRunId,authority.lineageId,authority.lineageHash,
      authority.quoteId,authority.quoteHash,authority.consentId,authority.consentHash,authority.costLimitMicrousd,authority.tokenLimit,authority.activeTimeLimitMs,
      1,1,8,8,8,131072,1048576,32768,8388608,100,400,quote.inputCaps.builderInputTokens,6000,
      quote.inputCaps.reviewerInputTokens,12000,120000,0,0,0,0,0,0,0,0,nowMs,null,null,0,null,"ACTIVE",null,1,nowMs,nowMs);
    return authority;
  }

  getHardeningChildBudgetAuthority(childRunId:string):HardeningBudgetAuthority|null{
    const row=this.db.query("SELECT * FROM hardening_child_budget_authorities WHERE child_run_id=?").get(childRunId) as Record<string,unknown>|null;
    return row?this.hardeningChildBudgetFromRow(row):null;
  }

  /**
   * Read-only gate used by provider-free crash recovery.  Recovery callers
   * must also prove that the independent worker lease is absent; this method
   * only establishes that no live paid-call fence can still authorize a send.
   */
  hardeningPaidCallRecoveryReady(childRunId:string,nowMs:number):boolean{
    if(!Number.isSafeInteger(nowMs)||nowMs<0)throw new TypeError("invalid hardening recovery time");
    const row=this.db.query("SELECT * FROM hardening_child_budget_authorities WHERE child_run_id=?").get(childRunId) as Record<string,unknown>|null;
    if(!row)return false;
    try{this.hardeningChildBudgetFromRow(row);}
    catch(error){
      if(error instanceof HardeningPromptCacheAuthorityUnavailableError)throw error;
      if(error instanceof HardeningBudgetAuthorityInvalidError)
        throw new DatabaseIntegrityCorruptionError(childRunId,childRunId);
      throw error;
    }
    if(row.status==="STOPPED")return true;
    if(row.status!=="ACTIVE")return false;
    return row.fence_expires_at_ms===null||Number(row.fence_expires_at_ms)<=nowMs;
  }

  private hardeningActiveElapsedMs(row:Record<string,unknown>,nowMs:number):number{
    if(!Number.isSafeInteger(nowMs)||nowMs<0)throw new HardeningBudgetAuthorityInvalidError();
    const used=Number(row.used_active_ms),activeSince=row.active_since_ms===null?null:Number(row.active_since_ms);
    if(!Number.isSafeInteger(used)||used<0||row.status!=="ACTIVE"||activeSince===null||!Number.isSafeInteger(activeSince)||nowMs<activeSince)
      throw new HardeningBudgetAuthorityInvalidError();
    const elapsed=used+(nowMs-activeSince);if(!Number.isSafeInteger(elapsed))throw new HardeningBudgetAuthorityInvalidError();return elapsed;
  }

  private stopHardeningBudgetUnderLock(row:Record<string,unknown>,reason:HardeningBudgetStopReason,nowMs:number):void{
    if(row.status==="STOPPED"){if(row.stop_reason!==reason)throw new HardeningBudgetAuthorityInvalidError();return;}
    if(row.status!=="ACTIVE")throw new HardeningBudgetAuthorityInvalidError();
    const elapsed=this.hardeningActiveElapsedMs(row,nowMs);
    const changed=this.db.query(`UPDATE hardening_child_budget_authorities SET status='STOPPED',stop_reason=?,used_active_ms=?,active_since_ms=NULL,
      fence_owner_id=NULL,fence_token_hash=NULL,fence_expires_at_ms=NULL,revision=revision+1,updated_at_ms=? WHERE child_run_id=? AND revision=? AND status='ACTIVE'`)
      .run(reason,elapsed,nowMs,String(row.child_run_id),Number(row.revision));
    if(changed.changes!==1)throw new HardeningExecutionFenceStaleError();
  }

  private verifyHardeningBudgetUnderLock(childRunId:string,nowMs:number):void{
    const row=this.db.query("SELECT * FROM hardening_child_budget_authorities WHERE child_run_id=?").get(childRunId) as Record<string,unknown>|null;
    if(!row)throw new HardeningBudgetAuthorityInvalidError();
    this.hardeningChildBudgetFromRow(row);
    if(row.status==="VERIFIED")return;
    if(row.status!=="ACTIVE"||Number(row.reserved_cost_microusd)!==0||Number(row.reserved_tokens)!==0||
      Number(row.ambiguous_cost_microusd)!==0||Number(row.ambiguous_tokens)!==0)throw new HardeningBudgetAuthorityInvalidError();
    const effectiveNowMs=Math.max(nowMs,Number(row.updated_at_ms));
    const elapsed=this.hardeningActiveElapsedMs(row,effectiveNowMs);
    if(elapsed>Number(row.active_time_limit_ms))throw new HardeningBudgetAuthorityInvalidError();
    const changed=this.db.query(`UPDATE hardening_child_budget_authorities SET status='VERIFIED',stop_reason=NULL,used_active_ms=?,active_since_ms=NULL,
      fence_owner_id=NULL,fence_token_hash=NULL,fence_expires_at_ms=NULL,revision=revision+1,updated_at_ms=?
      WHERE child_run_id=? AND revision=? AND status='ACTIVE'`).run(elapsed,effectiveNowMs,childRunId,Number(row.revision));
    if(changed.changes!==1)throw new HardeningExecutionFenceStaleError();
  }

  acquireHardeningExecutionFence(input:{childRunId:string;ownerId:string;ttlMs:number;nowMs:number;idempotencyKey:string}):{
    childRunId:string;ownerId:string;rawFenceToken:string;fenceGeneration:number;expiresAtMs:number;
  }{
    if(!input.ownerId||input.ownerId.length>200||!input.idempotencyKey||input.idempotencyKey.length>200||!Number.isSafeInteger(input.ttlMs)||
      input.ttlMs<1000||input.ttlMs>300000)throw new TypeError("invalid hardening execution fence request");
    const rawFenceToken=randomBytes(32).toString("base64url"),tokenHash=sha256(rawFenceToken);
    const decision=this.db.transaction(()=>{const row=this.db.query("SELECT * FROM hardening_child_budget_authorities WHERE child_run_id=?").get(input.childRunId) as Record<string,unknown>|null;
      if(!row)return {error:new HardeningBudgetAuthorityInvalidError()} as const;
      this.hardeningChildBudgetFromRow(row);if(row.status!=="ACTIVE")return {error:new HardeningBudgetStoppedError(row.stop_reason as HardeningBudgetStopReason)} as const;
      const elapsed=this.hardeningActiveElapsedMs(row,input.nowMs);if(elapsed>=Number(row.active_time_limit_ms)){this.stopHardeningBudgetUnderLock(row,"ACTIVE_TIME_CAP_REACHED",input.nowMs);return {error:new HardeningBudgetStoppedError("ACTIVE_TIME_CAP_REACHED")} as const;}
      const currentExpiry=row.fence_expires_at_ms===null?null:Number(row.fence_expires_at_ms);
      if(currentExpiry!==null&&currentExpiry>input.nowMs)throw new HardeningExecutionFenceStaleError();
      const generation=Number(row.fence_generation)+1,expiresAtMs=Math.min(input.nowMs+input.ttlMs,input.nowMs+(Number(row.active_time_limit_ms)-elapsed));
      const changed=this.db.query(`UPDATE hardening_child_budget_authorities SET fence_owner_id=?,fence_token_hash=?,fence_generation=?,
        fence_expires_at_ms=?,revision=revision+1,updated_at_ms=? WHERE child_run_id=? AND revision=? AND status='ACTIVE'`)
        .run(input.ownerId,tokenHash,generation,expiresAtMs,input.nowMs,input.childRunId,Number(row.revision));
      if(changed.changes!==1)throw new HardeningExecutionFenceStaleError();return {value:{childRunId:input.childRunId,ownerId:input.ownerId,
        rawFenceToken,fenceGeneration:generation,expiresAtMs}} as const;}).immediate();
    if("error" in decision)throw decision.error;return decision.value;
  }

  assertHardeningExecutionFence(input:{childRunId:string;ownerId:string;fenceGeneration:number;rawFenceToken:string;nowMs:number}):HardeningBudgetAuthority{
    const decision=this.db.transaction(()=>{const row=this.db.query("SELECT * FROM hardening_child_budget_authorities WHERE child_run_id=?").get(input.childRunId) as Record<string,unknown>|null;
      if(!row)return {error:new HardeningBudgetAuthorityInvalidError()} as const;const authority=this.hardeningChildBudgetFromRow(row);
      if(row.status!=="ACTIVE")return {error:new HardeningBudgetStoppedError(row.stop_reason as HardeningBudgetStopReason)} as const;
      const elapsed=this.hardeningActiveElapsedMs(row,input.nowMs);if(elapsed>=Number(row.active_time_limit_ms)){this.stopHardeningBudgetUnderLock(row,"ACTIVE_TIME_CAP_REACHED",input.nowMs);return {error:new HardeningBudgetStoppedError("ACTIVE_TIME_CAP_REACHED")} as const;}
      if(row.fence_owner_id!==input.ownerId||Number(row.fence_generation)!==input.fenceGeneration||row.fence_token_hash!==sha256(input.rawFenceToken)||
        row.fence_expires_at_ms===null||Number(row.fence_expires_at_ms)<=input.nowMs)throw new HardeningExecutionFenceStaleError();return {value:authority} as const;}).immediate();
    if("error" in decision)throw decision.error;return decision.value;
  }

  renewHardeningExecutionFence(input:{childRunId:string;ownerId:string;fenceGeneration:number;rawFenceToken:string;ttlMs:number;nowMs:number;idempotencyKey:string}){
    if(!Number.isSafeInteger(input.ttlMs)||input.ttlMs<1000||input.ttlMs>300000)throw new TypeError("invalid hardening execution fence ttl");
    const decision=this.db.transaction(()=>{const row=this.db.query("SELECT * FROM hardening_child_budget_authorities WHERE child_run_id=?").get(input.childRunId) as Record<string,unknown>|null;
      if(!row)return {error:new HardeningBudgetAuthorityInvalidError()} as const;if(row.status!=="ACTIVE")return {error:new HardeningBudgetStoppedError(row.stop_reason as HardeningBudgetStopReason)} as const;
      if(row.fence_owner_id!==input.ownerId||Number(row.fence_generation)!==input.fenceGeneration||row.fence_token_hash!==sha256(input.rawFenceToken)||row.fence_expires_at_ms===null||Number(row.fence_expires_at_ms)<=input.nowMs)throw new HardeningExecutionFenceStaleError();
      const elapsed=this.hardeningActiveElapsedMs(row,input.nowMs),expiresAtMs=Math.min(input.nowMs+input.ttlMs,input.nowMs+(Number(row.active_time_limit_ms)-elapsed));
      if(elapsed>=Number(row.active_time_limit_ms)){this.stopHardeningBudgetUnderLock(row,"ACTIVE_TIME_CAP_REACHED",input.nowMs);return {error:new HardeningBudgetStoppedError("ACTIVE_TIME_CAP_REACHED")} as const;}
      const changed=this.db.query(`UPDATE hardening_child_budget_authorities SET fence_expires_at_ms=?,revision=revision+1,updated_at_ms=?
        WHERE child_run_id=? AND revision=? AND fence_generation=? AND fence_token_hash=?`).run(expiresAtMs,input.nowMs,input.childRunId,Number(row.revision),input.fenceGeneration,sha256(input.rawFenceToken));
      if(changed.changes!==1)throw new HardeningExecutionFenceStaleError();return {value:{...input,expiresAtMs}} as const;}).immediate();
    if("error" in decision)throw decision.error;return decision.value;
  }

  releaseHardeningExecutionFence(input:{childRunId:string;ownerId:string;fenceGeneration:number;rawFenceToken:string;nowMs:number}):void{
    this.db.transaction(()=>{const row=this.db.query("SELECT * FROM hardening_child_budget_authorities WHERE child_run_id=?").get(input.childRunId) as Record<string,unknown>|null;
      if(!row||row.status!=="ACTIVE"||row.fence_owner_id!==input.ownerId||Number(row.fence_generation)!==input.fenceGeneration||
        row.fence_token_hash!==sha256(input.rawFenceToken)||row.fence_expires_at_ms===null||Number(row.fence_expires_at_ms)<=input.nowMs)throw new HardeningExecutionFenceStaleError();
      this.hardeningActiveElapsedMs(row,input.nowMs);
      const changed=this.db.query(`UPDATE hardening_child_budget_authorities SET fence_owner_id=NULL,fence_token_hash=NULL,fence_expires_at_ms=NULL,
        revision=revision+1,updated_at_ms=? WHERE child_run_id=? AND revision=? AND fence_generation=?`).run(input.nowMs,input.childRunId,Number(row.revision),input.fenceGeneration);
      if(changed.changes!==1)throw new HardeningExecutionFenceStaleError();}).immediate();
  }

  recordOptionalHardeningStopped(runId:string,stopReason:"FAILED"|"CANCELLED"|"BUDGET_EXHAUSTED"|"TIMED_OUT"|"SECURITY_BLOCKED"|"ENVIRONMENT_BLOCKED"):void{
    const transact=this.db.transaction(()=>{
      const authority=this.db.query(`SELECT l.*,o.id AS operation_id,o.created_at AS operation_created_at
        FROM engineer_run_lineage l JOIN hardening_start_operations o ON o.lineage_id=l.id AND o.lineage_hash=l.lineage_hash
        WHERE l.child_run_id=?`).get(runId) as Record<string,unknown>|null;if(!authority)return;
      const advisories=this.db.query(`SELECT a.* FROM hardening_quote_advisories m JOIN advisory_backlog_items a ON a.id=m.advisory_id
        WHERE m.quote_id=? ORDER BY m.ordinal`).all(String(authority.quote_id)) as Array<Record<string,unknown>>;
      const createdAt=this.now().toISOString();
      for(const row of advisories){const item=AdvisoryBacklogItemSchema.parse(JSON.parse(String(row.item_json)));
        const latest=this.advisoryLifecycle(item).at(-1);if(latest?.eventType==="HARDENING_STOPPED"){
          if(latest.stopReason!==stopReason||latest.childRunId!==runId)throw new HardeningAuthorityInvalidError();continue;}
        if(latest?.eventType!=="HARDENING_STARTED"||latest.childRunId!==runId)throw new HardeningAuthorityInvalidError();
        const event=createAdvisoryBacklogEvent({schemaVersion:1,policyVersion:"engineer-advisory-backlog-v1",advisoryId:item.advisoryId,
          parentRunId:String(authority.parent_run_id),parentCheckpointId:String(authority.parent_checkpoint_id),parentCheckpointHash:String(authority.parent_checkpoint_hash),
          eventType:"HARDENING_STOPPED",revision:latest.revision+1,expectedRevision:latest.revision,actorType:"SYSTEM",actorId:"engineer-supervisor",
          operationId:String(authority.operation_id),idempotencyKey:`hardening-stopped:${String(authority.operation_id)}:${item.advisoryId}:${stopReason}`,
          quoteId:String(authority.quote_id),consentId:String(authority.consent_id),hardeningLineageId:String(authority.id),childRunId:runId,
          childCheckpointId:null,childCheckpointHash:null,stopReason,rationale:null,createdAt});
        this.db.query(`INSERT INTO advisory_backlog_events(id,event_hash,schema_version,policy_version,advisory_id,parent_run_id,parent_checkpoint_id,
          parent_checkpoint_hash,event_type,revision,expected_revision,actor_type,actor_id,operation_id,idempotency_key,quote_id,consent_id,
          hardening_lineage_id,child_run_id,child_checkpoint_id,child_checkpoint_hash,stop_reason,rationale,event_json,created_at)
          VALUES(?,?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(event.eventId,event.eventHash,event.policyVersion,event.advisoryId,
          event.parentRunId,event.parentCheckpointId,event.parentCheckpointHash,event.eventType,event.revision,event.expectedRevision,event.actorType,
          event.actorId,event.operationId,event.idempotencyKey,event.quoteId,event.consentId,event.hardeningLineageId,event.childRunId,event.childCheckpointId,
          event.childCheckpointHash,event.stopReason,event.rationale,canonicalJson(event),event.createdAt);}
    });transact.immediate();
  }

  stopHardeningChildBudgetForRecovery(childRunId:string,
    reason:"FAILED"|"CANCELLED"|"SECURITY_BLOCKED"|"ENVIRONMENT_BLOCKED",nowMs:number):void{
    this.db.transaction(()=>{
      const row=this.db.query("SELECT * FROM hardening_child_budget_authorities WHERE child_run_id=?").get(childRunId) as Record<string,unknown>|null;
      if(!row)throw new HardeningBudgetAuthorityInvalidError();this.hardeningChildBudgetFromRow(row);
      if(row.status==="ACTIVE")this.stopHardeningBudgetUnderLock(row,reason,nowMs);
      else if(row.status!=="STOPPED"&&row.status!=="VERIFIED")throw new HardeningBudgetAuthorityInvalidError();
    }).immediate();
  }

  private hardeningStartFenceFromRow(row:Record<string,unknown>):HardeningStartFence {
    const intent=HardeningStartClaimIntentSchema.parse(JSON.parse(String(row.intent_json)));
    const expected=createHardeningStartClaimIntent({requesterUserId:intent.requesterUserId,rootRunId:intent.rootRunId,
      parentRunId:intent.parentRunId,childRunId:intent.childRunId,repositoryId:intent.repositoryId,
      parentCheckpointId:intent.parentCheckpointId,parentCheckpointHash:intent.parentCheckpointHash,lineageId:intent.lineageId,
      lineageHash:intent.lineageHash,quoteId:intent.quoteId,quoteHash:intent.quoteHash,consentId:intent.consentId,
      consentHash:intent.consentHash,operationId:intent.operationId,operationHash:intent.operationHash,idempotencyKey:intent.idempotencyKey});
    if(row.id!==expected.claimId||row.intent_hash!==expected.intentHash||canonicalJson(intent)!==String(row.intent_json))throw new HardeningAuthorityInvalidError();
    return HardeningStartFenceSchema.parse({claimId:row.id,intentHash:row.intent_hash,childRunId:row.child_run_id,
      status:row.status,ownerId:row.owner_id,fenceToken:row.fence_token,generation:row.generation,
      leaseExpiresAt:row.lease_expires_at,createdAt:row.created_at,updatedAt:row.updated_at,
      finalizedOperationId:row.finalized_operation_id,finalizedOperationHash:row.finalized_operation_hash,
      seedAttestationId:row.seed_attestation_id,seedAttestationHash:row.seed_attestation_hash,sandboxId:row.sandbox_id});
  }

  claimOptionalHardeningStart(input:ClaimOptionalHardeningStartInput):{applied:boolean;stolen:boolean;intent:HardeningStartClaimIntent;fence:HardeningStartFence}{
    if(!Number.isSafeInteger(input.leaseMs)||input.leaseMs<1_000||input.leaseMs>300_000)throw new TypeError("hardening start leaseMs must be between 1000 and 300000");
    const {ownerId,leaseMs,...rawIntent}=input;if(!ownerId||ownerId.length>200)throw new TypeError("hardening start ownerId is invalid");
    const authority=createHardeningStartClaimIntent(rawIntent);const now=this.now();const createdAt=now.toISOString();
    const expiresAt=new Date(now.getTime()+leaseMs).toISOString();
    this.db.exec("BEGIN IMMEDIATE");try{
      const row=this.db.query("SELECT * FROM hardening_start_claims WHERE child_run_id=?").get(authority.intent.childRunId) as Record<string,unknown>|null;
      if(row){const fence=this.hardeningStartFenceFromRow(row);
        if(row.intent_hash!==authority.intentHash||row.id!==authority.claimId)throw new IdempotencyConflictError(authority.intent.childRunId,authority.intent.idempotencyKey);
        if(fence.status==="FINALIZED"||(fence.ownerId===ownerId&&fence.leaseExpiresAt>createdAt)){this.db.exec("COMMIT");return {applied:false,stolen:false,intent:authority.intent,fence};}
        if(fence.leaseExpiresAt>createdAt)throw new HardeningStartClaimBusyError();
        const generation=fence.generation+1;const fenceToken=sha256({namespace:HARDENING_START_CLAIM_POLICY_VERSION,
          claimId:fence.claimId,ownerId,generation,nonce:randomUUID()});
        const changed=this.db.query(`UPDATE hardening_start_claims SET owner_id=?,fence_token=?,generation=?,lease_expires_at=?,updated_at=?
          WHERE id=? AND status='PREPARING' AND generation=? AND lease_expires_at<=?`).run(ownerId,fenceToken,generation,expiresAt,createdAt,
            fence.claimId,fence.generation,createdAt);
        if(changed.changes!==1)throw new HardeningStartClaimBusyError();
        const current=this.db.query("SELECT * FROM hardening_start_claims WHERE id=?").get(fence.claimId) as Record<string,unknown>;
        this.db.exec("COMMIT");return {applied:true,stolen:true,intent:authority.intent,fence:this.hardeningStartFenceFromRow(current)};
      }
      const fenceToken=sha256({namespace:HARDENING_START_CLAIM_POLICY_VERSION,claimId:authority.claimId,ownerId,generation:1,nonce:randomUUID()});
      this.db.query(`INSERT INTO hardening_start_claims(id,intent_hash,schema_version,policy_version,requester_user_id,root_run_id,parent_run_id,
        child_run_id,repository_id,parent_checkpoint_id,parent_checkpoint_hash,lineage_id,lineage_hash,quote_id,quote_hash,consent_id,consent_hash,
        intended_operation_id,intended_operation_hash,idempotency_key,intent_json,status,owner_id,fence_token,generation,lease_expires_at,
        finalized_operation_id,finalized_operation_hash,seed_attestation_id,seed_attestation_hash,sandbox_id,created_at,updated_at)
        VALUES(?,?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'PREPARING',?,?,1,?,NULL,NULL,NULL,NULL,NULL,?,?)`).run(authority.claimId,authority.intentHash,
          HARDENING_START_CLAIM_POLICY_VERSION,authority.intent.requesterUserId,authority.intent.rootRunId,authority.intent.parentRunId,
          authority.intent.childRunId,authority.intent.repositoryId,authority.intent.parentCheckpointId,authority.intent.parentCheckpointHash,
          authority.intent.lineageId,authority.intent.lineageHash,authority.intent.quoteId,authority.intent.quoteHash,authority.intent.consentId,
          authority.intent.consentHash,authority.intent.operationId,authority.intent.operationHash,authority.intent.idempotencyKey,canonicalJson(authority.intent),
          ownerId,fenceToken,expiresAt,createdAt,createdAt);
      const current=this.db.query("SELECT * FROM hardening_start_claims WHERE id=?").get(authority.claimId) as Record<string,unknown>;
      this.db.exec("COMMIT");return {applied:true,stolen:false,intent:authority.intent,fence:this.hardeningStartFenceFromRow(current)};
    }catch(error){try{this.db.exec("ROLLBACK");}catch{}throw error;}
  }

  listExpiredOptionalHardeningStartClaimsForOwner(ownerId:string):Array<{parentRunId:string;childRunId:string;input:HardeningStartRequest}>{
    if(!ownerId||ownerId.length>200)throw new TypeError("hardening start ownerId is invalid");
    const now=this.now().toISOString();
    const rows=this.db.query(`SELECT * FROM hardening_start_claims WHERE requester_user_id=? AND status='PREPARING'
      AND lease_expires_at<=? ORDER BY created_at,id`).all(ownerId,now) as Array<Record<string,unknown>>;
    return rows.map((row)=>{
      const intent=HardeningStartClaimIntentSchema.parse(JSON.parse(String(row.intent_json)));
      this.hardeningStartFenceFromRow(row);
      return {parentRunId:intent.parentRunId,childRunId:intent.childRunId,input:HardeningStartRequestSchema.parse({
        expectedChildStateVersion:0,lineageId:intent.lineageId,lineageHash:intent.lineageHash,idempotencyKey:intent.idempotencyKey,
      })};
    });
  }

  listOptionalHardeningStartClaimsForRecovery(ownerId:string):Array<{parentRunId:string;childRunId:string;leaseExpiresAt:string;input:HardeningStartRequest}>{
    if(!ownerId||ownerId.length>200)throw new TypeError("hardening start ownerId is invalid");
    const rows=this.db.query(`SELECT * FROM hardening_start_claims WHERE requester_user_id=? AND status='PREPARING'
      ORDER BY lease_expires_at,created_at,id`).all(ownerId) as Array<Record<string,unknown>>;
    return rows.map((row)=>{const intent=HardeningStartClaimIntentSchema.parse(JSON.parse(String(row.intent_json)));const fence=this.hardeningStartFenceFromRow(row);
      return {parentRunId:intent.parentRunId,childRunId:intent.childRunId,leaseExpiresAt:fence.leaseExpiresAt,input:HardeningStartRequestSchema.parse({
        expectedChildStateVersion:0,lineageId:intent.lineageId,lineageHash:intent.lineageHash,idempotencyKey:intent.idempotencyKey})};});
  }

  getFinalizedOptionalHardeningStartClaim(childRunId:string):HardeningStartFence|null{
    this.getRun(childRunId);
    const rows=this.db.query("SELECT * FROM hardening_start_claims WHERE child_run_id=? ORDER BY id").all(childRunId) as Array<Record<string,unknown>>;
    if(rows.length===0)return null;
    if(rows.length!==1)throw new HardeningAuthorityInvalidError();
    const fence=this.hardeningStartFenceFromRow(rows[0]!);
    return fence.status==="FINALIZED"?fence:null;
  }

  finalizeOptionalHardeningStartClaim(input:FinalizeOptionalHardeningStartClaimInput):HardeningStartFence{
    const now=this.now().toISOString();this.db.exec("BEGIN IMMEDIATE");try{
      const row=this.db.query("SELECT * FROM hardening_start_claims WHERE id=? AND child_run_id=?").get(input.claimId,input.childRunId) as Record<string,unknown>|null;
      if(!row)throw new HardeningStartFenceStaleError();const fence=this.hardeningStartFenceFromRow(row);
      if(fence.status==="FINALIZED"){
        if(fence.generation!==input.generation||fence.fenceToken!==input.fenceToken||fence.finalizedOperationId!==input.operationId||
          fence.finalizedOperationHash!==input.operationHash||fence.seedAttestationId!==input.seedAttestationId||
          fence.seedAttestationHash!==input.seedAttestationHash||fence.sandboxId!==input.sandboxId)throw new HardeningStartFenceStaleError();
        this.db.exec("COMMIT");return fence;
      }
      const changed=this.db.query(`UPDATE hardening_start_claims SET status='FINALIZED',finalized_operation_id=?,finalized_operation_hash=?,
        seed_attestation_id=?,seed_attestation_hash=?,sandbox_id=?,updated_at=? WHERE id=? AND child_run_id=? AND status='PREPARING'
        AND fence_token=? AND generation=? AND lease_expires_at>=? AND intended_operation_id=? AND intended_operation_hash=?`).run(
          input.operationId,input.operationHash,input.seedAttestationId,input.seedAttestationHash,input.sandboxId,now,input.claimId,input.childRunId,
          input.fenceToken,input.generation,now,input.operationId,input.operationHash);
      if(changed.changes!==1)throw new HardeningStartFenceStaleError();
      const current=this.db.query("SELECT * FROM hardening_start_claims WHERE id=?").get(input.claimId) as Record<string,unknown>;
      this.db.exec("COMMIT");return this.hardeningStartFenceFromRow(current);
    }catch(error){try{this.db.exec("ROLLBACK");}catch{}throw error;}
  }

  private hardeningModelCallSlotFromRow(row:Record<string,unknown>):HardeningModelCallSlotClaim {
    const claim=HardeningModelCallSlotClaimSchema.parse({claimId:row.id,childRunId:row.child_run_id,role:row.role,modelTier:row.model_tier,
      status:row.status,claimantId:row.claimant_id,idempotencyKey:row.idempotency_key,modelCallId:row.model_call_id,
      createdAt:row.created_at,updatedAt:row.updated_at});
    if(claim.claimId!==sha256({namespace:HARDENING_MODEL_CALL_SLOT_POLICY_VERSION,childRunId:claim.childRunId,role:claim.role}))throw new HardeningAuthorityInvalidError();
    return claim;
  }

  private hardeningModelCallFromRow(row:Record<string,unknown>):ModelCallRecord {
    return ModelCallRecordSchema.parse({modelCallId:row.id,runId:row.run_id,agentExecutionId:row.agent_execution_id,
      logicalTier:row.logical_tier,resolvedModel:row.resolved_model,promptTemplateVersion:row.prompt_template_version,
      inputContextRefs:JSON.parse(String(row.input_context_refs_json)),outputSchemaVersion:row.output_schema_version,
      cacheKey:row.cache_key,cacheHit:row.cache_hit===null?null:Number(row.cache_hit)===1,latencyMs:Number(row.latency_ms),
      inputTokens:row.input_tokens===null?null:Number(row.input_tokens),outputTokens:row.output_tokens===null?null:Number(row.output_tokens),
      cachedInputTokens:row.cached_input_tokens===null?null:Number(row.cached_input_tokens),
      cacheWriteInputTokens:row.cache_write_input_tokens===null?null:Number(row.cache_write_input_tokens),
      retryCount:Number(row.retry_count),status:row.status,createdAt:row.created_at});
  }

  private normalizeHardeningModelCall(record:ModelCallRecord):ModelCallRecord {
    return ModelCallRecordSchema.parse({...record,
      cachedInputTokens:record.cachedInputTokens??null,
      cacheWriteInputTokens:record.cacheWriteInputTokens??null});
  }

  private recoveredInvalidReceiptInputHash(input:{recoveryIdempotencyKey:string;
    observation:HardeningInvalidReceiptObservation}):string {
    return sha256({namespace:"engineer-hardening-invalid-receipt-settlement-v1",outcome:"AMBIGUOUS_INVALID_RECEIPT",
      recoveryIdempotencyKey:input.recoveryIdempotencyKey,observationHash:input.observation.observationHash});
  }

  private hardeningBudgetReservationFromRow(row:Record<string,unknown>,strictResponseReceipt=true,
    readArtifact?:ArtifactByteReader):HardeningBudgetReservation {
    const strictReader=readArtifact??this.hardeningArtifactReader;
    const createdAtMs=Number(row.created_at_ms);
    if(!Number.isSafeInteger(createdAtMs)||createdAtMs<0)throw new HardeningBudgetAuthorityInvalidError();
    if(!this.hardeningPromptCacheSecret)throw new HardeningPromptCacheAuthorityUnavailableError();
    const reservation=HardeningBudgetReservationSchema.parse({
      schemaVersion:row.schema_version,policyVersion:row.policy_version,childRunId:row.child_run_id,
      budgetAuthorityId:row.authority_id,budgetAuthorityHash:row.authority_hash,paidCallSlotId:row.paid_slot_id,
      role:row.role,modelTier:row.model_tier,resolvedModel:row.resolved_model,pricingVersion:row.pricing_version,
      agentExecutionId:row.agent_execution_id,routingDecisionId:row.routing_decision_id,claimantId:row.agent_execution_id,
      expectedRunState:row.expected_run_state,expectedStateVersion:Number(row.expected_state_version),
      requestHash:row.request_hash,clientRequestId:row.client_request_id,
      inputTokenUpperBound:Number(row.input_token_upper_bound),outputTokenCeiling:Number(row.output_token_ceiling),
      cachePolicyVersion:row.cache_policy_version,cacheAccountingVersion:row.cache_accounting_version,
      staticPrefixHash:row.static_prefix_hash,toolSchemaHash:row.tool_schema_hash,promptCacheKeyHash:row.prompt_cache_key_hash,
      cacheShard:Number(row.cache_shard),cacheTtlSeconds:Number(row.cache_ttl_seconds),cacheBreakpointCount:Number(row.cache_breakpoint_count),
      reservedCacheWriteInputTokens:Number(row.reserved_cache_write_input_tokens),reservedCachedInputTokens:Number(row.reserved_cached_input_tokens),
      uncachedInputMicrousdPerMillion:Number(row.uncached_input_microusd_per_million),
      cachedInputMicrousdPerMillion:Number(row.cached_input_microusd_per_million),
      cacheWriteInputMicrousdPerMillion:Number(row.cache_write_input_microusd_per_million),
      outputMicrousdPerMillion:Number(row.output_microusd_per_million),reservedTokens:Number(row.reserved_tokens),
      reservedCostMicrousd:Number(row.reserved_cost_microusd),createdAt:new Date(createdAtMs).toISOString(),
      reservationHash:row.reservation_hash,reservationId:row.id,
    });
    assertHardeningReservationCost(reservation);
    if(row.currency!=="USD"||typeof row.reservation_idempotency_key!=="string"||!row.reservation_idempotency_key||
      String(row.reservation_idempotency_key).length>200||typeof row.fence_owner_id!=="string"||!row.fence_owner_id||
      !/^sha256:[a-f0-9]{64}$/.test(String(row.fence_token_hash))||!Number.isSafeInteger(Number(row.fence_generation))||
      Number(row.fence_generation)<=0)throw new HardeningBudgetAuthorityInvalidError();
    const run=this.db.query("SELECT user_id,manifest_hash FROM engineer_runs WHERE id=?").get(reservation.childRunId) as
      {user_id:string;manifest_hash:string|null}|null;
    const expectedDescriptor=run?canonicalHardeningPromptCacheMaterial({secret:this.hardeningPromptCacheSecret,
      requesterUserId:run.user_id,childRunId:reservation.childRunId,role:reservation.role,resolvedModel:reservation.resolvedModel}).descriptor:null;
    const actualDescriptor=HardeningPromptCacheDescriptorSchema.parse({cachePolicyVersion:reservation.cachePolicyVersion,
      cacheAccountingVersion:reservation.cacheAccountingVersion,staticPrefixHash:reservation.staticPrefixHash,
      toolSchemaHash:reservation.toolSchemaHash,promptCacheKeyHash:reservation.promptCacheKeyHash,cacheShard:reservation.cacheShard,
      cacheTtlSeconds:reservation.cacheTtlSeconds,cacheBreakpointCount:reservation.cacheBreakpointCount});
    if(!expectedDescriptor)throw new HardeningBudgetAuthorityInvalidError();
    if(canonicalJson(expectedDescriptor)!==canonicalJson(actualDescriptor))
      throw new HardeningPromptCacheAuthorityMismatchError();
    const expectedClientRequestId=hardeningClientRequestId({childRunId:reservation.childRunId,role:reservation.role,
      reservationIdempotencyKey:String(row.reservation_idempotency_key)});
    if(reservation.clientRequestId!==expectedClientRequestId)throw new HardeningBudgetAuthorityInvalidError();
    const dispatchStatus=String(row.dispatch_status);
    const dispatchStarted=row.dispatch_started_at_ms===null?null:Number(row.dispatch_started_at_ms);
    const responseRecorded=row.response_recorded_at_ms===null?null:Number(row.response_recorded_at_ms);
    if((dispatchStarted!==null&&(!Number.isSafeInteger(dispatchStarted)||dispatchStarted<createdAtMs))||
      (responseRecorded!==null&&(!Number.isSafeInteger(responseRecorded)||dispatchStarted===null||responseRecorded<dispatchStarted)))
      throw new HardeningBudgetAuthorityInvalidError();
    const dispatchShapeValid=
      (row.status==="RESERVED"&&dispatchStatus==="RESERVED_UNSENT"&&dispatchStarted===null&&responseRecorded===null)||
      (row.status==="RESERVED"&&dispatchStatus==="DISPATCHING"&&dispatchStarted!==null&&responseRecorded===null)||
      (row.status==="RESERVED"&&dispatchStatus==="RESPONSE_RECORDED"&&dispatchStarted!==null&&responseRecorded!==null)||
      (row.status==="SETTLED"&&dispatchStatus==="SETTLED"&&dispatchStarted!==null&&responseRecorded!==null)||
      (row.status==="AMBIGUOUS"&&dispatchStatus==="AMBIGUOUS"&&dispatchStarted!==null)||
      (row.status==="VOID_UNSENT"&&dispatchStatus==="VOID_UNSENT"&&dispatchStarted===null&&responseRecorded===null);
    if(!dispatchShapeValid)throw new HardeningBudgetAuthorityInvalidError();
    const recoveryGeneration=Number(row.recovery_generation);
    const recoveryClaimed=row.recovery_claimed_at_ms===null?null:Number(row.recovery_claimed_at_ms);
    const recoveryExpires=row.recovery_expires_at_ms===null?null:Number(row.recovery_expires_at_ms);
    const noRecoveryAuthority=row.recovery_owner_id===null&&row.recovery_token_hash===null&&
      row.recovery_idempotency_key===null&&recoveryClaimed===null&&recoveryExpires===null;
    const recoveryLowerBound=Math.max(createdAtMs,dispatchStarted??0,responseRecorded??0);
    const completeRecoveryAuthority=typeof row.recovery_owner_id==="string"&&row.recovery_owner_id.length>0&&
      row.recovery_owner_id.length<=200&&/^sha256:[a-f0-9]{64}$/.test(String(row.recovery_token_hash))&&
      typeof row.recovery_idempotency_key==="string"&&row.recovery_idempotency_key.length>0&&
      row.recovery_idempotency_key.length<=200&&recoveryClaimed!==null&&Number.isSafeInteger(recoveryClaimed)&&
      recoveryClaimed>=recoveryLowerBound&&recoveryExpires!==null&&Number.isSafeInteger(recoveryExpires)&&
      recoveryExpires>recoveryClaimed;
    if(!Number.isSafeInteger(recoveryGeneration)||recoveryGeneration<0||
      (recoveryGeneration===0&&!noRecoveryAuthority)||(recoveryGeneration>0&&!completeRecoveryAuthority)||
      (row.status!=="RESERVED"&&recoveryGeneration>0&&row.settlement_idempotency_key!==row.recovery_idempotency_key))
      throw new HardeningBudgetAuthorityInvalidError();
    if(responseRecorded!==null&&strictResponseReceipt&&!(row.status==="AMBIGUOUS"&&Number(row.recovery_generation)>0)){
      if(!strictReader)throw new HardeningBudgetAuthorityInvalidError();
      const responseModel=this.db.query("SELECT * FROM model_calls WHERE id=? AND run_id=?").get(String(row.model_call_id),reservation.childRunId) as Record<string,unknown>|null;
      const responseArtifact=this.db.query("SELECT * FROM artifacts WHERE id=? AND run_id=?").get(String(row.provider_response_artifact_id),reservation.childRunId) as Record<string,unknown>|null;
      if(!responseModel||!responseArtifact)throw new HardeningBudgetAuthorityInvalidError();
      const persisted=this.hardeningModelCallFromRow(responseModel),artifact=this.artifactFromRow(responseArtifact);
      const providerInputHash=persisted.inputContextRefs[1];
      const expectedContextRefs=[run?.manifest_hash,providerInputHash,reservation.requestHash,reservation.clientRequestId,String(row.provider_response_id)];
      if(persisted.agentExecutionId!==reservation.agentExecutionId||persisted.logicalTier!==reservation.modelTier||
        persisted.resolvedModel!==reservation.resolvedModel||persisted.cacheKey!==reservation.promptCacheKeyHash||persisted.status!=="SUCCEEDED"||
        persisted.retryCount!==0||!run?.manifest_hash||!/^sha256:[a-f0-9]{64}$/.test(providerInputHash??"")||
        canonicalJson(persisted.inputContextRefs)!==canonicalJson(expectedContextRefs)||
        String(responseModel.input_context_refs_json)!==canonicalJson(expectedContextRefs)||
        artifact.type!=="MODEL_PROVIDER_RESPONSE"||!artifact.trusted||artifact.producerType!=="SYSTEM"||
        artifact.producerId!=="engineer-provider-response-recorder"||
        (!strictReader&&(!existsSync(artifact.storageReference)||!lstatSync(artifact.storageReference).isFile())))
        throw new HardeningBudgetAuthorityInvalidError();
      const bytes=strictReader?strictReader(artifact):readFileSync(artifact.storageReference);
      if(bytes.byteLength!==artifact.sizeBytes||!matchesSha256Bytes(bytes,artifact.sha256))throw new HardeningBudgetAuthorityInvalidError();
    }
    const agent=this.db.query("SELECT run_id,role,model_tier,input_hash,started_at,completed_at FROM agent_executions WHERE id=?")
      .get(reservation.agentExecutionId) as Record<string,unknown>|null;
    const routeRow=this.db.query("SELECT * FROM model_routing_decisions WHERE id=?")
      .get(reservation.routingDecisionId) as Record<string,unknown>|null;
    const route=routeRow?ModelRoutingDecisionSchema.parse({routingDecisionId:routeRow.id,runId:routeRow.run_id,
      agentExecutionId:routeRow.agent_execution_id,agentRole:routeRow.agent_role,logicalTier:routeRow.logical_tier,
      resolvedModel:routeRow.resolved_model,routingPolicyVersion:routeRow.routing_policy_version,
      fallbackUsed:Number(routeRow.fallback_used)===1,fallbackReason:routeRow.fallback_reason,
      cacheKey:routeRow.cache_key,timestamp:routeRow.timestamp}):null;
    const routeCount=this.db.query(`SELECT COUNT(*) AS count FROM model_routing_decisions
      WHERE run_id=? AND agent_execution_id=?`).get(reservation.childRunId,reservation.agentExecutionId) as {count:number};
    const routeTime=route?Date.parse(route.timestamp):Number.NaN;
    const agentStarted=agent?Date.parse(String(agent.started_at)):Number.NaN;
    const routeTimeValid=reservation.role==="REVIEWER"?route?.timestamp===agent?.started_at:
      routeTime>=agentStarted&&routeTime<=Date.parse(agent?.completed_at===null?this.now().toISOString():String(agent?.completed_at));
    const builderClaim=reservation.role==="BUILDER"&&agent
      ?this.builderDispatchClaim(reservation.childRunId,String(agent.input_hash)):null;
    const builderClaimValid=reservation.role!=="BUILDER"||Boolean(builderClaim&&
      builderClaim.agentExecutionId===reservation.agentExecutionId&&builderClaim.modelTier==="GPT-5.6_TERRA"&&
      builderClaim.inputHash===agent?.input_hash&&builderClaim.claimedAt===agent?.started_at);
    const slot=this.db.query("SELECT * FROM hardening_model_call_slots WHERE id=?").get(reservation.paidCallSlotId) as Record<string,unknown>|null;
    const authority=this.db.query("SELECT id,authority_hash,child_run_id FROM hardening_child_budget_authorities WHERE id=? AND authority_hash=?")
      .get(reservation.budgetAuthorityId,reservation.budgetAuthorityHash) as Record<string,unknown>|null;
    const slotClaim=slot?this.hardeningModelCallSlotFromRow(slot):null;
    const slotStatusMatches=row.status==="RESERVED"?slotClaim?.status==="CLAIMED"&&slotClaim.modelCallId===null:
      row.status==="SETTLED"?slotClaim?.status==="COMPLETED"&&slotClaim.modelCallId===row.model_call_id:
      row.status==="AMBIGUOUS"?slotClaim?.status==="AMBIGUOUS"&&slotClaim.modelCallId===row.model_call_id:
      row.status==="VOID_UNSENT"?slotClaim?.status==="FAILED"&&slotClaim.modelCallId===null:false;
    if(!agent||agent.run_id!==reservation.childRunId||agent.role!==reservation.role||agent.model_tier!==reservation.modelTier||
      !route||routeCount.count!==1||route.routingDecisionId!==reservation.routingDecisionId||route.runId!==reservation.childRunId||
      route.agentExecutionId!==reservation.agentExecutionId||route.agentRole!==reservation.role||
      route.logicalTier!==reservation.modelTier||route.resolvedModel!==reservation.resolvedModel||
      route.routingPolicyVersion!=="engineer-model-routing-v2"||route.fallbackUsed||route.fallbackReason!==null||
      route.cacheKey!==null||!routeTimeValid||!builderClaimValid||
      !slotClaim||slotClaim.childRunId!==reservation.childRunId||slotClaim.role!==reservation.role||slotClaim.modelTier!==reservation.modelTier||
      slotClaim.claimantId!==reservation.agentExecutionId||slotClaim.idempotencyKey!==row.reservation_idempotency_key||!slotStatusMatches||
      !authority||authority.child_run_id!==reservation.childRunId)throw new HardeningBudgetAuthorityInvalidError();
    return reservation;
  }

  private hardeningBudgetReconciliationFromRow(row:Record<string,unknown>,reservation:HardeningBudgetReservation,
    readArtifact?:ArtifactByteReader):HardeningBudgetReconciliation|null {
    const strictReader=readArtifact??this.hardeningArtifactReader;
    if(row.status==="RESERVED")return null;
    if(row.status!=="SETTLED"&&row.status!=="AMBIGUOUS"&&row.status!=="VOID_UNSENT")throw new HardeningBudgetAuthorityInvalidError();
    if(typeof row.reconciliation_json!=="string")throw new HardeningBudgetAuthorityInvalidError();
    const reconciliation=HardeningBudgetReconciliationSchema.parse(JSON.parse(row.reconciliation_json));
    const settledAtMs=Number(row.settled_at_ms);
    const modelCallId=row.model_call_id;
    if(row.status!=="VOID_UNSENT"&&(typeof modelCallId!=="string"||!modelCallId))throw new HardeningBudgetAuthorityInvalidError();
    if(!Number.isSafeInteger(settledAtMs)||settledAtMs<0)throw new HardeningBudgetAuthorityInvalidError();
    const expected={schemaVersion:1 as const,policyVersion:"engineer-hardening-budget-reconciliation-v1" as const,
      childRunId:reservation.childRunId,reservationId:reservation.reservationId,reservationHash:reservation.reservationHash,
      status:row.status,providerResponseId:row.status==="SETTLED"?row.provider_response_id:null,
      modelCallId:row.status==="VOID_UNSENT"?null:row.model_call_id,
      actualInputTokens:row.status==="SETTLED"?Number(row.actual_input_tokens):null,
      actualOutputTokens:row.status==="SETTLED"?Number(row.actual_output_tokens):null,
      actualCachedInputTokens:row.status==="SETTLED"?Number(row.actual_cached_input_tokens):null,
      actualCacheWriteInputTokens:row.status==="SETTLED"?Number(row.actual_cache_write_input_tokens):null,
      cacheObservation:row.status==="SETTLED"?row.cache_observation:"UNKNOWN",actualCostMicrousd:row.status==="SETTLED"?Number(row.settled_cost_microusd):null,
      ...(reconciliation.invalidReceiptObservation!==undefined
        ?{invalidReceiptObservation:reconciliation.invalidReceiptObservation}:{}),
      createdAt:new Date(settledAtMs).toISOString(),reconciliationHash:row.reconciliation_hash,reconciliationId:row.reconciliation_id};
    if(canonicalJson(reconciliation)!==canonicalJson(expected))
      throw new HardeningBudgetAuthorityInvalidError();
    const settlementIdempotencyKey=typeof row.settlement_idempotency_key==="string"?row.settlement_idempotency_key:"";
    const recoveryGeneration=Number(row.recovery_generation);
    const recoveredInvalidReceipt=recoveryGeneration>0&&row.status==="AMBIGUOUS"&&row.response_recorded_at_ms!==null;
    if(recoveredInvalidReceipt!==(reconciliation.invalidReceiptObservation!==undefined))
      throw new HardeningBudgetAuthorityInvalidError();
    const totalAgentCallCount=this.db.query(`SELECT COUNT(*) AS count FROM model_calls WHERE run_id=? AND agent_execution_id=?`)
      .get(reservation.childRunId,reservation.agentExecutionId) as {count:number};
    const totalReservationCallCount=this.db.query(`SELECT COUNT(*) AS count FROM model_calls WHERE run_id=? AND budget_reservation_id=?`)
      .get(reservation.childRunId,reservation.reservationId) as {count:number};
    if(!recoveredInvalidReceipt){
      const expectedCallCount=row.status==="VOID_UNSENT"?0:1;
      if(totalAgentCallCount.count!==expectedCallCount||totalReservationCallCount.count!==expectedCallCount)
        throw new HardeningBudgetAuthorityInvalidError();
    }
    let expectedSettlementInputHash:string|null=null;
    if(recoveredInvalidReceipt){
      const observation=HardeningInvalidReceiptObservationSchema.parse(reconciliation.invalidReceiptObservation);
      const invalidRun=this.getRun(reservation.childRunId);
      const selectedModelRow=this.db.query("SELECT * FROM model_calls WHERE id=? AND run_id=? AND agent_execution_id=? AND budget_reservation_id=?")
        .get(observation.modelCallId,reservation.childRunId,reservation.agentExecutionId,reservation.reservationId) as Record<string,unknown>|null;
      const sourceModelRow=this.db.query("SELECT * FROM model_calls WHERE id=? AND run_id=?")
        .get(observation.responseRecordedModelCallId,reservation.childRunId) as Record<string,unknown>|null;
      const invalidCallCount=this.db.query(`SELECT COUNT(*) AS count FROM model_calls
        WHERE run_id=? AND agent_execution_id=?`).get(reservation.childRunId,reservation.agentExecutionId) as {count:number};
      const invalidReservationCallCount=this.db.query(`SELECT COUNT(*) AS count FROM model_calls
        WHERE run_id=? AND budget_reservation_id=?`).get(reservation.childRunId,reservation.reservationId) as {count:number};
      if(!selectedModelRow||!invalidRun.manifestHash||typeof row.provider_response_id!=="string"||
        typeof row.provider_response_artifact_id!=="string"||observation.childRunId!==reservation.childRunId||
        observation.reservationId!==reservation.reservationId||observation.reservationHash!==reservation.reservationHash||
        observation.recoveryGeneration!==recoveryGeneration||observation.recoveryOwnerId!==row.recovery_owner_id||
        observation.recoveryIdempotencyKey!==settlementIdempotencyKey||observation.recoveryIdempotencyKeyHash!==sha256(settlementIdempotencyKey)||
        observation.recoveryTokenHash!==row.recovery_token_hash||observation.recoveryClaimedAtMs!==Number(row.recovery_claimed_at_ms)||
        observation.recoveryExpiresAtMs!==Number(row.recovery_expires_at_ms)||observation.observedAtMs!==settledAtMs||
        observation.modelCallId!==row.model_call_id||observation.providerResponseId!==row.provider_response_id||
        observation.providerResponseArtifactId!==row.provider_response_artifact_id||
        invalidCallCount.count!==observation.observedModelCallCount||
        invalidReservationCallCount.count!==observation.observedReservationModelCallCount||
        (sourceModelRow===null)!==(observation.recordedModelCallRowHash===null)||
        (sourceModelRow!==null&&sha256(sourceModelRow)!==observation.recordedModelCallRowHash))
        throw new HardeningBudgetAuthorityInvalidError();
      const selectedModel=this.hardeningModelCallFromRow(selectedModelRow);
      const expectedPromptVersion=reservation.role==="BUILDER"?"engineer-codex-builder-v3":"engineer-isolated-reviewer-v6";
      const expectedOutputSchema=reservation.role==="BUILDER"?null:"reviewer-output-v1";
      const baseCallValid=selectedModel.agentExecutionId===reservation.agentExecutionId&&selectedModel.logicalTier===reservation.modelTier&&
        selectedModel.resolvedModel===reservation.resolvedModel&&selectedModel.cacheKey===reservation.promptCacheKeyHash&&
        selectedModel.promptTemplateVersion===expectedPromptVersion&&selectedModel.outputSchemaVersion===expectedOutputSchema&&
        selectedModel.retryCount===0&&selectedModelRow.budget_reservation_id===reservation.reservationId&&
        String(selectedModelRow.input_context_refs_json)===canonicalJson(selectedModel.inputContextRefs)&&
        sha256(this.normalizeHardeningModelCall(selectedModel))===observation.modelCallHash;
      if(!baseCallValid)throw new HardeningBudgetAuthorityInvalidError();
      const providerInputHash=selectedModel.inputContextRefs[1];
      const expectedRefs=[invalidRun.manifestHash,providerInputHash,reservation.requestHash,reservation.clientRequestId,row.provider_response_id];
      if(observation.modelCallKind!=="ORIGINAL_SUCCEEDED"||selectedModel.modelCallId!==observation.responseRecordedModelCallId||
        selectedModel.status!=="SUCCEEDED"||selectedModel.inputTokens===null||selectedModel.outputTokens===null||
        selectedModel.cachedInputTokens===null||selectedModel.cacheWriteInputTokens===null||
        selectedModel.cacheHit!==((selectedModel.cachedInputTokens??0)>0)||!/^sha256:[a-f0-9]{64}$/.test(providerInputHash??"")||
        canonicalJson(selectedModel.inputContextRefs)!==canonicalJson(expectedRefs)||observation.observedModelCallCount!==1||
        observation.observedReservationModelCallCount!==1)
        throw new HardeningBudgetAuthorityInvalidError();
      const invalidArtifactRow=this.db.query("SELECT * FROM artifacts WHERE id=? AND run_id=?")
        .get(observation.providerResponseArtifactId,reservation.childRunId) as Record<string,unknown>|null;
      if(!invalidArtifactRow)throw new HardeningBudgetAuthorityInvalidError();
      const invalidArtifact=this.artifactFromRow(invalidArtifactRow);
      if(observation.artifactSha256!==invalidArtifact.sha256||observation.artifactSizeBytes!==invalidArtifact.sizeBytes||
        observation.artifactStorageReferenceHash!==sha256(invalidArtifact.storageReference)||observation.artifactType!==invalidArtifact.type||
        observation.artifactTrusted!==invalidArtifact.trusted||observation.artifactProducerType!==invalidArtifact.producerType||
        observation.artifactProducerId!==invalidArtifact.producerId)
        throw new HardeningBudgetAuthorityInvalidError();
      expectedSettlementInputHash=this.recoveredInvalidReceiptInputHash({recoveryIdempotencyKey:settlementIdempotencyKey,observation});
    }else if(recoveryGeneration>0){
      const recoveryOutcome=row.status==="SETTLED"?"SETTLED_RECOVERED":row.status==="VOID_UNSENT"?"VOID_UNSENT":
        row.response_recorded_at_ms===null?"AMBIGUOUS":"AMBIGUOUS_INVALID_RECEIPT";
      expectedSettlementInputHash=sha256({recoveryIdempotencyKey:settlementIdempotencyKey,outcome:recoveryOutcome});
    }else if(row.status==="VOID_UNSENT"){
      expectedSettlementInputHash=sha256({settlementIdempotencyKey,outcome:"VOID_UNSENT"});
    }else if(typeof row.model_call_id==="string"){
      const settlementCallRow=this.db.query("SELECT * FROM model_calls WHERE id=? AND run_id=?")
        .get(row.model_call_id,reservation.childRunId) as Record<string,unknown>|null;
      if(settlementCallRow){
        expectedSettlementInputHash=sha256({modelCall:this.normalizeHardeningModelCall(this.hardeningModelCallFromRow(settlementCallRow)),
          providerResponseId:row.provider_response_id,providerResponseArtifactId:row.provider_response_artifact_id,
          settlementIdempotencyKey});
      }
    }
    if(!settlementIdempotencyKey||settlementIdempotencyKey.length>200||!Number.isSafeInteger(recoveryGeneration)||
      recoveryGeneration<0||!expectedSettlementInputHash||row.settlement_input_hash!==expectedSettlementInputHash)
      throw new HardeningBudgetAuthorityInvalidError();
    if(row.status==="SETTLED"){
      if(!strictReader)throw new HardeningBudgetAuthorityInvalidError();
      const expectedCost=hardeningPartitionedCostFromRatesMicrousd(Number(row.actual_input_tokens),Number(row.actual_cached_input_tokens),
        Number(row.actual_cache_write_input_tokens),Number(row.actual_output_tokens),{
          uncachedInputMicrousdPerMillion:reservation.uncachedInputMicrousdPerMillion,
          cachedInputMicrousdPerMillion:reservation.cachedInputMicrousdPerMillion,
          cacheWriteInputMicrousdPerMillion:reservation.cacheWriteInputMicrousdPerMillion,
          outputMicrousdPerMillion:reservation.outputMicrousdPerMillion});
      if(expectedCost!==Number(row.settled_cost_microusd)||Number(row.actual_input_tokens)>reservation.inputTokenUpperBound||
        Number(row.actual_output_tokens)>reservation.outputTokenCeiling||
        Number(row.actual_uncached_input_tokens)!==Number(row.actual_input_tokens)-Number(row.actual_cached_input_tokens)-Number(row.actual_cache_write_input_tokens))
        throw new HardeningBudgetAuthorityInvalidError();
      if(typeof row.provider_response_artifact_id!=="string"||typeof row.provider_response_id!=="string")throw new HardeningBudgetAuthorityInvalidError();
      const artifactRow=this.db.query("SELECT * FROM artifacts WHERE id=? AND run_id=?").get(row.provider_response_artifact_id,reservation.childRunId) as Record<string,unknown>|null;
      const modelCall=this.db.query("SELECT * FROM model_calls WHERE id=? AND run_id=?").get(modelCallId as string,reservation.childRunId) as Record<string,unknown>|null;
      if(!artifactRow||!modelCall)throw new HardeningBudgetAuthorityInvalidError();const artifact=this.artifactFromRow(artifactRow);
      const persistedCall=this.hardeningModelCallFromRow(modelCall);
      const expectedOutputSchema=reservation.role==="BUILDER"?null:"reviewer-output-v1";
      const expectedPromptVersion=reservation.role==="BUILDER"?"engineer-codex-builder-v3":"engineer-isolated-reviewer-v6";
      const settledRun=this.getRun(reservation.childRunId),settledProviderInputHash=persistedCall.inputContextRefs[1];
      const settledExpectedRefs=[settledRun.manifestHash,settledProviderInputHash,reservation.requestHash,
        reservation.clientRequestId,String(row.provider_response_id)];
      if(artifact.type!=="MODEL_PROVIDER_RESPONSE"||!artifact.trusted||artifact.producerType!=="SYSTEM"||
        artifact.producerId!=="engineer-provider-response-recorder"||
        (!strictReader&&(!existsSync(artifact.storageReference)||!lstatSync(artifact.storageReference).isFile()))||
        modelCall.agent_execution_id!==reservation.agentExecutionId||
        modelCall.logical_tier!==reservation.modelTier||modelCall.resolved_model!==reservation.resolvedModel||
        modelCall.cache_key!==reservation.promptCacheKeyHash||modelCall.budget_reservation_id!==reservation.reservationId||
        Number(modelCall.input_tokens)!==Number(row.actual_input_tokens)||Number(modelCall.output_tokens)!==Number(row.actual_output_tokens)||
        Number(modelCall.cached_input_tokens)!==Number(row.actual_cached_input_tokens)||
        Number(modelCall.cache_write_input_tokens)!==Number(row.actual_cache_write_input_tokens)||persistedCall.status!=="SUCCEEDED"||
        persistedCall.retryCount!==0||persistedCall.promptTemplateVersion!==expectedPromptVersion||
        persistedCall.outputSchemaVersion!==expectedOutputSchema||persistedCall.cacheHit!==(Number(row.actual_cached_input_tokens)>0)||
        !settledRun.manifestHash||!/^sha256:[a-f0-9]{64}$/.test(settledProviderInputHash??"")||
        canonicalJson(persistedCall.inputContextRefs)!==canonicalJson(settledExpectedRefs)||
        String(modelCall.input_context_refs_json)!==canonicalJson(settledExpectedRefs))throw new HardeningBudgetAuthorityInvalidError();
      const bytes=strictReader?strictReader(artifact):readFileSync(artifact.storageReference);
      if(bytes.byteLength!==artifact.sizeBytes||!matchesSha256Bytes(bytes,artifact.sha256))throw new HardeningBudgetAuthorityInvalidError();
      try{const response=JSON.parse(bytes.toString("utf8")) as {id?:unknown;usage?:{input_tokens?:unknown;output_tokens?:unknown;
          input_tokens_details?:{cached_tokens?:unknown;cache_write_tokens?:unknown}}};
        if(response.id!==row.provider_response_id||response.usage?.input_tokens!==Number(row.actual_input_tokens)||
          response.usage.output_tokens!==Number(row.actual_output_tokens)||
          response.usage.input_tokens_details?.cached_tokens!==Number(row.actual_cached_input_tokens)||
          response.usage.input_tokens_details?.cache_write_tokens!==Number(row.actual_cache_write_input_tokens))
          throw new HardeningBudgetAuthorityInvalidError();
      }catch(error){if(error instanceof HardeningBudgetAuthorityInvalidError)throw error;throw new HardeningBudgetAuthorityInvalidError();}
    }else if(row.status==="AMBIGUOUS"){
      const modelCall=this.db.query("SELECT * FROM model_calls WHERE id=? AND run_id=?").get(modelCallId as string,reservation.childRunId) as Record<string,unknown>|null;
      if(!modelCall)throw new HardeningBudgetAuthorityInvalidError();const persistedCall=this.hardeningModelCallFromRow(modelCall);
      const expectedOutputSchema=reservation.role==="BUILDER"?null:"reviewer-output-v1";
      const expectedPromptVersion=reservation.role==="BUILDER"?"engineer-codex-builder-v3":"engineer-isolated-reviewer-v6";
      const responseWasRecorded=row.response_recorded_at_ms!==null;
      const recoveredDispatchModelId=sha256({namespace:"engineer-hardening-crash-recovery-model-call-v1",
        reservationId:reservation.reservationId});
      if(modelCall.agent_execution_id!==reservation.agentExecutionId||modelCall.logical_tier!==reservation.modelTier||
        modelCall.resolved_model!==reservation.resolvedModel||modelCall.cache_key!==reservation.promptCacheKeyHash||
        modelCall.budget_reservation_id!==reservation.reservationId||
        (!responseWasRecorded&&(modelCall.input_tokens!==null||modelCall.output_tokens!==null||modelCall.cached_input_tokens!==null||
          modelCall.cache_write_input_tokens!==null||persistedCall.status!=="FAILED"||persistedCall.cacheHit!==null))||
        (responseWasRecorded&&Number(row.recovery_generation)===0&&(persistedCall.status!=="SUCCEEDED"||!persistedCall.inputContextRefs.includes(reservation.requestHash)||
          !persistedCall.inputContextRefs.includes(reservation.clientRequestId)||!persistedCall.inputContextRefs.includes(String(row.provider_response_id))))||
        (responseWasRecorded&&Number(row.recovery_generation)>0&&persistedCall.status!=="SUCCEEDED"&&
          (persistedCall.status!=="FAILED"||persistedCall.inputTokens!==null||persistedCall.outputTokens!==null||
           !persistedCall.inputContextRefs.includes(reservation.requestHash)||!persistedCall.inputContextRefs.includes(reservation.clientRequestId)))||
        (!responseWasRecorded&&Number(row.recovery_generation)>0&&(persistedCall.modelCallId!==recoveredDispatchModelId||
          canonicalJson(persistedCall.inputContextRefs)!==canonicalJson([reservation.requestHash,reservation.clientRequestId])||
          persistedCall.createdAt!==new Date(settledAtMs).toISOString()||
          persistedCall.latencyMs!==Math.max(0,settledAtMs-Number(row.dispatch_started_at_ms))))||
        persistedCall.retryCount!==0||persistedCall.promptTemplateVersion!==expectedPromptVersion||
        persistedCall.outputSchemaVersion!==expectedOutputSchema||String(modelCall.input_context_refs_json)!==canonicalJson(persistedCall.inputContextRefs))
        throw new HardeningBudgetAuthorityInvalidError();
      if(row.provider_response_id!==null&&(typeof row.provider_response_id!=="string"||!row.provider_response_id||row.provider_response_id.length>200))
        throw new HardeningBudgetAuthorityInvalidError();
      if(row.provider_response_artifact_id!==null&&!recoveredInvalidReceipt){
        if(!strictReader)throw new HardeningBudgetAuthorityInvalidError();
        if(typeof row.provider_response_artifact_id!=="string"||!row.provider_response_artifact_id)throw new HardeningBudgetAuthorityInvalidError();
        const artifact=this.db.query("SELECT * FROM artifacts WHERE id=? AND run_id=?").get(row.provider_response_artifact_id,reservation.childRunId) as Record<string,unknown>|null;
        if(!artifact)throw new HardeningBudgetAuthorityInvalidError();const record=this.artifactFromRow(artifact);
        if(record.type!=="MODEL_PROVIDER_RESPONSE"||!record.trusted||record.producerType!=="SYSTEM"||
          record.producerId!=="engineer-provider-response-recorder")throw new HardeningBudgetAuthorityInvalidError();
        if(!strictReader&&(!existsSync(record.storageReference)||!lstatSync(record.storageReference).isFile()))
          throw new HardeningBudgetAuthorityInvalidError();
        const bytes=strictReader?strictReader(record):readFileSync(record.storageReference);
        if(bytes.byteLength!==record.sizeBytes||!matchesSha256Bytes(bytes,record.sha256))throw new HardeningBudgetAuthorityInvalidError();
      }
    }else if(row.provider_response_id!==null||row.provider_response_artifact_id!==null||row.model_call_id!==null)
      throw new HardeningBudgetAuthorityInvalidError();
    return reconciliation;
  }

  reserveHardeningPaidCall(input:{childRunId:string;role:HardeningPaidModelRole;modelTier:HardeningPaidModelTier;resolvedModel:string;
    routingDecisionId:string;agentExecutionId:string;inputTokenUpperBound:number;outputTokenCeiling:number;reservationIdempotencyKey:string;
    requestHash:string;cacheDescriptor:HardeningPromptCacheDescriptor;fenceOwnerId:string;fenceGeneration:number;rawFenceToken:string;nowMs:number}):{applied:boolean;claim:HardeningModelCallSlotClaim;reservation:HardeningBudgetReservation}{
    const role=HardeningPaidModelRoleSchema.parse(input.role),tier=HardeningPaidModelTierSchema.parse(input.modelTier);
    const cacheDescriptor=HardeningPromptCacheDescriptorSchema.parse(input.cacheDescriptor);
    if((role==="BUILDER")!==(tier==="GPT-5.6_TERRA")||!Number.isSafeInteger(input.inputTokenUpperBound)||input.inputTokenUpperBound<0||
      !Number.isSafeInteger(input.outputTokenCeiling)||input.outputTokenCeiling<=0||!input.reservationIdempotencyKey||input.reservationIdempotencyKey.length>200||
      !/^sha256:[a-f0-9]{64}$/.test(input.requestHash))
      throw new TypeError("invalid hardening paid-call reservation");
    const decision=this.db.transaction(()=>{
      const budgetRow=this.db.query("SELECT * FROM hardening_child_budget_authorities WHERE child_run_id=?").get(input.childRunId) as Record<string,unknown>|null;
      if(!budgetRow)return {error:new HardeningBudgetAuthorityInvalidError()} as const;const authority=this.hardeningChildBudgetFromRow(budgetRow);
      if(budgetRow.status!=="ACTIVE")return {error:new HardeningBudgetStoppedError(budgetRow.stop_reason as HardeningBudgetStopReason)} as const;
      const elapsed=this.hardeningActiveElapsedMs(budgetRow,input.nowMs);
      if(elapsed>=authority.activeTimeLimitMs){this.stopHardeningBudgetUnderLock(budgetRow,"ACTIVE_TIME_CAP_REACHED",input.nowMs);return {error:new HardeningBudgetStoppedError("ACTIVE_TIME_CAP_REACHED")} as const;}
      if(budgetRow.fence_owner_id!==input.fenceOwnerId||Number(budgetRow.fence_generation)!==input.fenceGeneration||
        budgetRow.fence_token_hash!==sha256(input.rawFenceToken)||budgetRow.fence_expires_at_ms===null||Number(budgetRow.fence_expires_at_ms)<=input.nowMs)
        throw new HardeningExecutionFenceStaleError();
      const expectedRole=role==="BUILDER"?DEFAULT_HARDENING_ESTIMATION_AUTHORITY_V2.roles.builder:DEFAULT_HARDENING_ESTIMATION_AUTHORITY_V2.roles.reviewer;
      const roleInputCap=role==="BUILDER"?authority.transportLimits.builderInputCap:authority.transportLimits.reviewerInputCap;
      if(input.inputTokenUpperBound>roleInputCap){const reason=role==="BUILDER"?"BUILDER_INPUT_CAP_REACHED":"REVIEWER_INPUT_CAP_REACHED";
        this.stopHardeningBudgetUnderLock(budgetRow,reason,input.nowMs);return {error:new HardeningBudgetStoppedError(reason)} as const;}
      const expectedCeiling=role==="BUILDER"?authority.transportLimits.builderOutputCeiling:authority.transportLimits.reviewerOutputCeiling;
      if(input.resolvedModel!==expectedRole.model||input.outputTokenCeiling!==expectedCeiling)throw new HardeningBudgetAuthorityInvalidError();
      const existing=this.db.query("SELECT * FROM hardening_child_model_reservations WHERE child_run_id=? AND role=?")
        .get(input.childRunId,role) as Record<string,unknown>|null;
      if(!this.hardeningPromptCacheSecret)throw new HardeningPromptCacheAuthorityUnavailableError();
      const ownerRow=this.db.query("SELECT user_id,state,state_version FROM engineer_runs WHERE id=?").get(input.childRunId) as
        {user_id:string;state:string;state_version:number}|null;
      const expectedRunState=role==="BUILDER"?"IMPLEMENTING":"REVIEWING";
      if(!ownerRow||ownerRow.state!==expectedRunState)throw new HardeningBudgetAuthorityInvalidError();
      const expectedCache=ownerRow?canonicalHardeningPromptCacheMaterial({secret:this.hardeningPromptCacheSecret,
        requesterUserId:ownerRow.user_id,childRunId:input.childRunId,role,resolvedModel:input.resolvedModel}).descriptor:null;
      if(!expectedCache||canonicalJson(expectedCache)!==canonicalJson(cacheDescriptor)){
        if(existing)throw new HardeningPromptCacheAuthorityMismatchError();throw new HardeningBudgetAuthorityInvalidError();
      }
      const slotId=sha256({namespace:HARDENING_MODEL_CALL_SLOT_POLICY_VERSION,childRunId:input.childRunId,role});
      const reservedTokens=input.inputTokenUpperBound+input.outputTokenCeiling;
      if(!Number.isSafeInteger(reservedTokens))throw new HardeningBudgetAuthorityInvalidError();
      const reservedCostMicrousd=hardeningModelCostMicrousd(role,input.inputTokenUpperBound,input.outputTokenCeiling);
      const clientRequestId=hardeningClientRequestId({childRunId:input.childRunId,role,reservationIdempotencyKey:input.reservationIdempotencyKey});
      const reservation=createHardeningBudgetReservation({schemaVersion:1,policyVersion:"engineer-hardening-child-model-reservation-v1",
        childRunId:input.childRunId,budgetAuthorityId:authority.budgetAuthorityId,budgetAuthorityHash:authority.budgetAuthorityHash,paidCallSlotId:slotId,
        role,modelTier:tier,resolvedModel:input.resolvedModel,pricingVersion:DEFAULT_HARDENING_ESTIMATION_AUTHORITY_V2.pricingVersion,
        agentExecutionId:input.agentExecutionId,routingDecisionId:input.routingDecisionId,claimantId:input.agentExecutionId,
        expectedRunState,expectedStateVersion:Number(ownerRow.state_version),
        requestHash:input.requestHash,clientRequestId,
        ...cacheDescriptor,reservedCacheWriteInputTokens:input.inputTokenUpperBound,reservedCachedInputTokens:0,
        uncachedInputMicrousdPerMillion:expectedRole.uncachedInputMicrousdPerMillion,
        cachedInputMicrousdPerMillion:expectedRole.cachedInputMicrousdPerMillion,
        cacheWriteInputMicrousdPerMillion:expectedRole.cacheWriteInputMicrousdPerMillion,
        outputMicrousdPerMillion:expectedRole.outputMicrousdPerMillion,
        inputTokenUpperBound:input.inputTokenUpperBound,outputTokenCeiling:input.outputTokenCeiling,reservedTokens,reservedCostMicrousd,
        createdAt:new Date(existing?Number(existing.created_at_ms):input.nowMs).toISOString()});
      if(existing){const persistedReservation=this.hardeningBudgetReservationFromRow(existing);
        if(canonicalJson(persistedReservation)!==canonicalJson(reservation)||existing.reservation_idempotency_key!==input.reservationIdempotencyKey||
          existing.status!=="RESERVED"||existing.fence_owner_id!==input.fenceOwnerId||existing.fence_token_hash!==sha256(input.rawFenceToken)||
          Number(existing.fence_generation)!==input.fenceGeneration)throw new HardeningReservationConflictError();
        const slot=this.db.query("SELECT * FROM hardening_model_call_slots WHERE id=?").get(slotId) as Record<string,unknown>|null;
        if(!slot)throw new HardeningReservationConflictError();return {value:{applied:false,claim:this.hardeningModelCallSlotFromRow(slot),reservation:persistedReservation}} as const;}
      const totalCost=Number(budgetRow.used_cost_microusd)+Number(budgetRow.reserved_cost_microusd)+Number(budgetRow.ambiguous_cost_microusd)+reservedCostMicrousd;
      const totalTokens=Number(budgetRow.used_tokens)+Number(budgetRow.reserved_tokens)+Number(budgetRow.ambiguous_tokens)+reservedTokens;
      if(!Number.isSafeInteger(totalCost)||totalCost>authority.costLimitMicrousd){this.stopHardeningBudgetUnderLock(budgetRow,"COST_CAP_REACHED",input.nowMs);return {error:new HardeningBudgetStoppedError("COST_CAP_REACHED")} as const;}
      if(!Number.isSafeInteger(totalTokens)||totalTokens>authority.tokenLimit){this.stopHardeningBudgetUnderLock(budgetRow,"TOKEN_CAP_REACHED",input.nowMs);return {error:new HardeningBudgetStoppedError("TOKEN_CAP_REACHED")} as const;}
      const createdAt=new Date(input.nowMs).toISOString();
      this.db.query(`INSERT INTO hardening_model_call_slots(id,schema_version,policy_version,child_run_id,role,model_tier,status,claimant_id,
        idempotency_key,model_call_id,created_at,updated_at) VALUES(?,1,?,?,?,?,'CLAIMED',?,?,NULL,?,?)`).run(slotId,
        HARDENING_MODEL_CALL_SLOT_POLICY_VERSION,input.childRunId,role,tier,input.agentExecutionId,input.reservationIdempotencyKey,createdAt,createdAt);
      this.db.query(`INSERT INTO hardening_child_model_reservations(id,reservation_hash,schema_version,policy_version,authority_id,authority_hash,child_run_id,role,
        model_tier,resolved_model,routing_decision_id,agent_execution_id,expected_run_state,expected_state_version,paid_slot_id,input_token_upper_bound,output_token_ceiling,
        cache_policy_version,cache_accounting_version,static_prefix_hash,tool_schema_hash,prompt_cache_key_hash,cache_shard,cache_ttl_seconds,
        cache_breakpoint_count,reserved_cache_write_input_tokens,reserved_cached_input_tokens,uncached_input_microusd_per_million,
        cached_input_microusd_per_million,cache_write_input_microusd_per_million,output_microusd_per_million,reserved_tokens,
        reserved_cost_microusd,pricing_version,currency,reservation_idempotency_key,request_hash,client_request_id,
        fence_owner_id,fence_token_hash,fence_generation,status,dispatch_status,created_at_ms)
        VALUES(${Array.from({length:44},()=>"?").join(",")})`).run(reservation.reservationId,reservation.reservationHash,1,reservation.policyVersion,
        reservation.budgetAuthorityId,reservation.budgetAuthorityHash,reservation.childRunId,reservation.role,reservation.modelTier,reservation.resolvedModel,
        reservation.routingDecisionId,reservation.agentExecutionId,reservation.expectedRunState,reservation.expectedStateVersion,
        reservation.paidCallSlotId,reservation.inputTokenUpperBound,reservation.outputTokenCeiling,
        reservation.cachePolicyVersion,reservation.cacheAccountingVersion,reservation.staticPrefixHash,reservation.toolSchemaHash,reservation.promptCacheKeyHash,
        reservation.cacheShard,reservation.cacheTtlSeconds,reservation.cacheBreakpointCount,reservation.reservedCacheWriteInputTokens,
        reservation.reservedCachedInputTokens,reservation.uncachedInputMicrousdPerMillion,reservation.cachedInputMicrousdPerMillion,
        reservation.cacheWriteInputMicrousdPerMillion,reservation.outputMicrousdPerMillion,
        reservation.reservedTokens,reservation.reservedCostMicrousd,reservation.pricingVersion,"USD",input.reservationIdempotencyKey,
        reservation.requestHash,reservation.clientRequestId,input.fenceOwnerId,sha256(input.rawFenceToken),input.fenceGeneration,
        "RESERVED","RESERVED_UNSENT",input.nowMs);
      const changed=this.db.query(`UPDATE hardening_child_budget_authorities SET reserved_cost_microusd=reserved_cost_microusd+?,
        reserved_tokens=reserved_tokens+?,revision=revision+1,updated_at_ms=? WHERE child_run_id=? AND revision=? AND status='ACTIVE'`)
        .run(reservedCostMicrousd,reservedTokens,input.nowMs,input.childRunId,Number(budgetRow.revision));
      if(changed.changes!==1)throw new HardeningExecutionFenceStaleError();
      const slot=this.db.query("SELECT * FROM hardening_model_call_slots WHERE id=?").get(slotId) as Record<string,unknown>;
      const persistedRow=this.db.query("SELECT * FROM hardening_child_model_reservations WHERE id=?").get(reservation.reservationId) as Record<string,unknown>;
      const persistedReservation=this.hardeningBudgetReservationFromRow(persistedRow);
      if(canonicalJson(persistedReservation)!==canonicalJson(reservation))throw new HardeningBudgetAuthorityInvalidError();
      return {value:{applied:true,claim:this.hardeningModelCallSlotFromRow(slot),reservation:persistedReservation}} as const;
    }).immediate();
    if("error" in decision)throw decision.error;return decision.value;
  }

  markHardeningPaidCallDispatching(input:{childRunId:string;reservationId:string;requestHash:string;clientRequestId:string;
    fenceOwnerId:string;fenceGeneration:number;rawFenceToken:string;nowMs:number}):void{
    const decision=this.db.transaction(()=>{
      const budget=this.db.query("SELECT * FROM hardening_child_budget_authorities WHERE child_run_id=?").get(input.childRunId) as Record<string,unknown>|null;
      const row=this.db.query("SELECT * FROM hardening_child_model_reservations WHERE id=? AND child_run_id=?")
        .get(input.reservationId,input.childRunId) as Record<string,unknown>|null;
      if(!budget||!row)throw new HardeningBudgetAuthorityInvalidError();const reservation=this.hardeningBudgetReservationFromRow(row);
      if(reservation.requestHash!==input.requestHash||reservation.clientRequestId!==input.clientRequestId)
        throw new HardeningReservationConflictError();
      if(budget.status!=="ACTIVE")throw new HardeningBudgetStoppedError(budget.stop_reason as HardeningBudgetStopReason);
      if(budget.fence_owner_id!==input.fenceOwnerId||Number(budget.fence_generation)!==input.fenceGeneration||
        budget.fence_token_hash!==sha256(input.rawFenceToken)||budget.fence_expires_at_ms===null||Number(budget.fence_expires_at_ms)<=input.nowMs||
        row.fence_owner_id!==input.fenceOwnerId||Number(row.fence_generation)!==input.fenceGeneration||row.fence_token_hash!==sha256(input.rawFenceToken))
        throw new HardeningExecutionFenceStaleError();
      if(row.status==="RESERVED"&&row.dispatch_status==="DISPATCHING")return;
      if(row.status!=="RESERVED"||row.dispatch_status!=="RESERVED_UNSENT")throw new HardeningReservationConflictError();
      const changed=this.db.query(`UPDATE hardening_child_model_reservations SET dispatch_status='DISPATCHING',dispatch_started_at_ms=?
        WHERE id=? AND status='RESERVED' AND dispatch_status='RESERVED_UNSENT' AND dispatch_started_at_ms IS NULL`)
        .run(input.nowMs,input.reservationId);
      if(changed.changes!==1)throw new HardeningReservationConflictError();
    });
    decision.immediate();
  }

  private recordHardeningPaidCallFinalizationUnderLock(input:{childRunId:string;reservationId:string;
    outcome:"VOID_UNSENT"|"AMBIGUOUS"|"SETTLED"|"SETTLED_RECOVERED";
    reconciliation:HardeningBudgetReconciliation;nowMs:number}):void{
    const binding=this.db.query(`SELECT role,agent_execution_id,expected_run_state,expected_state_version,reservation_hash,paid_slot_id
      FROM hardening_child_model_reservations WHERE id=? AND child_run_id=?`).get(input.reservationId,input.childRunId) as
      {role:"BUILDER"|"REVIEWER";agent_execution_id:string;expected_run_state:"IMPLEMENTING"|"REVIEWING";expected_state_version:number;
        reservation_hash:string;paid_slot_id:string}|null;
    if(!binding||binding.expected_run_state!==(binding.role==="BUILDER"?"IMPLEMENTING":"REVIEWING"))throw new HardeningBudgetAuthorityInvalidError();
    const terminalIntentId=sha256({namespace:"engineer-hardening-paid-call-terminal-intent-v1",childRunId:input.childRunId,
      reservationId:input.reservationId,reservationHash:binding.reservation_hash,paidCallSlotId:binding.paid_slot_id,
      agentExecutionId:binding.agent_execution_id,expectedRunState:binding.expected_run_state,
      expectedStateVersion:Number(binding.expected_state_version)});
    const payload={agentExecutionId:binding.agent_execution_id,createdAtMs:input.nowMs,childRunId:input.childRunId,
      expectedRunState:binding.expected_run_state,expectedStateVersion:Number(binding.expected_state_version),outcome:input.outcome,
      paidCallSlotId:binding.paid_slot_id,policyVersion:"engineer-hardening-paid-call-finalization-v1",
      reconciliationHash:input.reconciliation.reconciliationHash,reconciliationId:input.reconciliation.reconciliationId,
      reservationHash:binding.reservation_hash,reservationId:input.reservationId,role:binding.role,schemaVersion:1,terminalIntentId};
    const payloadJson=canonicalJson(payload),payloadHash=sha256(payload);
    const id=sha256({namespace:"engineer-hardening-paid-call-finalization-v1",reservationId:input.reservationId});
    const existing=this.db.query("SELECT * FROM hardening_paid_call_finalizations WHERE reservation_id=?").get(input.reservationId) as Record<string,unknown>|null;
    if(existing){
      if(existing.id!==id||existing.child_run_id!==input.childRunId||existing.outcome!==input.outcome||
        existing.reservation_hash!==binding.reservation_hash||existing.paid_slot_id!==binding.paid_slot_id||existing.terminal_intent_id!==terminalIntentId||
        existing.reconciliation_id!==input.reconciliation.reconciliationId||existing.reconciliation_hash!==input.reconciliation.reconciliationHash||
        existing.payload_hash!==payloadHash||existing.payload_json!==payloadJson)throw new HardeningReservationConflictError();
      return;
    }
    this.db.query(`INSERT INTO hardening_paid_call_finalizations(id,reservation_id,reservation_hash,paid_slot_id,child_run_id,role,agent_execution_id,
      expected_run_state,expected_state_version,terminal_intent_id,outcome,reconciliation_id,reconciliation_hash,payload_hash,payload_json,status,created_at_ms,updated_at_ms)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'PENDING',?,?)`).run(id,input.reservationId,binding.reservation_hash,binding.paid_slot_id,
        input.childRunId,binding.role,binding.agent_execution_id,binding.expected_run_state,Number(binding.expected_state_version),terminalIntentId,
        input.outcome,input.reconciliation.reconciliationId,input.reconciliation.reconciliationHash,payloadHash,payloadJson,
        input.nowMs,input.nowMs);
  }

  private hardeningPaidCallFinalizationFromRow(row:Record<string,unknown>){
    const payload={agentExecutionId:String(row.agent_execution_id),createdAtMs:Number(row.created_at_ms),childRunId:String(row.child_run_id),
      expectedRunState:String(row.expected_run_state),expectedStateVersion:Number(row.expected_state_version),outcome:String(row.outcome),
      paidCallSlotId:String(row.paid_slot_id),policyVersion:"engineer-hardening-paid-call-finalization-v1",reconciliationHash:String(row.reconciliation_hash),
      reconciliationId:String(row.reconciliation_id),reservationHash:String(row.reservation_hash),reservationId:String(row.reservation_id),
      role:String(row.role),schemaVersion:1,terminalIntentId:String(row.terminal_intent_id)};
    if(!Number.isSafeInteger(payload.createdAtMs)||payload.createdAtMs<0||row.payload_json!==canonicalJson(payload)||row.payload_hash!==sha256(payload)||
      row.id!==sha256({namespace:"engineer-hardening-paid-call-finalization-v1",reservationId:payload.reservationId})||
      !["VOID_UNSENT","AMBIGUOUS","SETTLED","SETTLED_RECOVERED"].includes(payload.outcome)||
      !["PENDING","CLAIMED","APPLIED"].includes(String(row.status)))throw new HardeningBudgetAuthorityInvalidError();
    const reservation=this.db.query("SELECT * FROM hardening_child_model_reservations WHERE id=?")
      .get(payload.reservationId) as Record<string,unknown>|null;
    if(!reservation)throw new HardeningBudgetAuthorityInvalidError();
    const reservationAuthority=this.hardeningBudgetReservationFromRow(reservation);
    const reconciliation=this.hardeningBudgetReconciliationFromRow(reservation,reservationAuthority);
    if(!reconciliation||reservation.child_run_id!==payload.childRunId||reservation.role!==payload.role||reservation.agent_execution_id!==payload.agentExecutionId||
      Number(reservation.settled_at_ms)!==payload.createdAtMs||
      reservation.expected_run_state!==payload.expectedRunState||Number(reservation.expected_state_version)!==payload.expectedStateVersion||
      reservation.reservation_hash!==payload.reservationHash||reservation.paid_slot_id!==payload.paidCallSlotId||
      payload.terminalIntentId!==sha256({namespace:"engineer-hardening-paid-call-terminal-intent-v1",childRunId:payload.childRunId,
        reservationId:payload.reservationId,reservationHash:payload.reservationHash,paidCallSlotId:payload.paidCallSlotId,
        agentExecutionId:payload.agentExecutionId,expectedRunState:payload.expectedRunState,expectedStateVersion:payload.expectedStateVersion})||
      payload.expectedRunState!==(payload.role==="BUILDER"?"IMPLEMENTING":"REVIEWING")||reservation.reconciliation_id!==payload.reconciliationId||
      reservation.reconciliation_hash!==payload.reconciliationHash||
      (reservation.status==="VOID_UNSENT"&&payload.outcome!=="VOID_UNSENT")||
      (reservation.status==="AMBIGUOUS"&&payload.outcome!=="AMBIGUOUS")||
      (reservation.status==="SETTLED"&&((Number(reservation.recovery_generation)===0&&payload.outcome!=="SETTLED")||
        (Number(reservation.recovery_generation)>0&&payload.outcome!=="SETTLED_RECOVERED"))))
      throw new HardeningBudgetAuthorityInvalidError();
    return {...payload,id:String(row.id),status:String(row.status) as "PENDING"|"CLAIMED"|"APPLIED",
      claimOwnerId:row.claim_owner_id===null?null:String(row.claim_owner_id),claimGeneration:Number(row.claim_generation),
      claimExpiresAtMs:row.claim_expires_at_ms===null?null:Number(row.claim_expires_at_ms)};
  }

  listOpenHardeningPaidCallReservations(childRunId?:string):Array<{childRunId:string;reservationId:string;dispatchStatus:string}>{
    const rows=(childRunId?this.db.query(`SELECT child_run_id,id,dispatch_status FROM hardening_child_model_reservations
      WHERE child_run_id=? AND status='RESERVED' ORDER BY created_at_ms,id`).all(childRunId):
      this.db.query(`SELECT child_run_id,id,dispatch_status FROM hardening_child_model_reservations
        WHERE status='RESERVED' ORDER BY created_at_ms,id`).all()) as Array<Record<string,unknown>>;
    return rows.map((row)=>({childRunId:String(row.child_run_id),reservationId:String(row.id),dispatchStatus:String(row.dispatch_status)}));
  }

  /**
   * Exact read-only recovery work gate. A paid recovery sweep is useful only
   * for an open reservation, a non-applied finalization, or the C0 crash
   * boundary where a paid agent is RUNNING but no reservation was committed.
   */
  hasOutstandingHardeningPaidCallRecoveryWork(childRunId:string):boolean{
    this.getRun(childRunId);
    const row=this.db.query(`SELECT
      EXISTS(SELECT 1 FROM hardening_child_model_reservations
        WHERE child_run_id=? AND status='RESERVED') OR
      EXISTS(SELECT 1 FROM hardening_paid_call_finalizations
        WHERE child_run_id=? AND status IN ('PENDING','CLAIMED')) OR
      EXISTS(SELECT 1 FROM agent_executions AS agent
        WHERE agent.run_id=? AND agent.status='RUNNING' AND agent.role IN ('BUILDER','REVIEWER')
          AND NOT EXISTS(SELECT 1 FROM hardening_child_model_reservations AS reservation
            WHERE reservation.child_run_id=agent.run_id AND reservation.agent_execution_id=agent.id))
      AS outstanding`).get(childRunId,childRunId,childRunId) as {outstanding:number}|null;
    return Number(row?.outstanding)===1;
  }

  claimHardeningRecoveryWorkerFence(input:{childRunId:string;workerLeaseId:string;workerOwnerId:string;
    workerFencingToken:number;rawWorkerLeaseToken:string;nowMs:number}){
    if(!input.childRunId||!input.workerLeaseId||input.workerLeaseId.length>200||!input.workerOwnerId||
      input.workerOwnerId.length>200||!Number.isSafeInteger(input.workerFencingToken)||input.workerFencingToken<=0||
      !input.rawWorkerLeaseToken||input.rawWorkerLeaseToken.length>512||!Number.isSafeInteger(input.nowMs)||input.nowMs<0)
      throw new TypeError("invalid hardening recovery worker fence");
    return this.db.transaction(()=>{
      const tokenHash=sha256(input.rawWorkerLeaseToken);
      const row=this.db.query("SELECT * FROM hardening_recovery_worker_fences WHERE child_run_id=?")
        .get(input.childRunId) as Record<string,unknown>|null;
      const exact=row&&row.worker_lease_id===input.workerLeaseId&&row.worker_owner_id===input.workerOwnerId&&
        Number(row.worker_fencing_token)===input.workerFencingToken&&row.worker_lease_token_hash===tokenHash;
      if(exact)return {childRunId:input.childRunId,workerLeaseId:input.workerLeaseId,workerOwnerId:input.workerOwnerId,
        workerFencingToken:input.workerFencingToken,workerLeaseTokenHash:tokenHash,
        claimedAtMs:Number(row.claimed_at_ms),updatedAtMs:Number(row.updated_at_ms)};
      if(row&&Number(row.worker_fencing_token)>=input.workerFencingToken)throw new HardeningExecutionFenceStaleError();
      if(row){
        const changed=this.db.query(`UPDATE hardening_recovery_worker_fences SET worker_lease_id=?,worker_owner_id=?,
          worker_fencing_token=?,worker_lease_token_hash=?,claimed_at_ms=?,updated_at_ms=?
          WHERE child_run_id=? AND worker_fencing_token=?`).run(input.workerLeaseId,input.workerOwnerId,input.workerFencingToken,
            tokenHash,input.nowMs,input.nowMs,input.childRunId,Number(row.worker_fencing_token));
        if(changed.changes!==1)throw new HardeningExecutionFenceStaleError();
      }else{
        this.db.query(`INSERT INTO hardening_recovery_worker_fences(child_run_id,worker_lease_id,worker_owner_id,
          worker_fencing_token,worker_lease_token_hash,claimed_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?)`)
          .run(input.childRunId,input.workerLeaseId,input.workerOwnerId,input.workerFencingToken,tokenHash,input.nowMs,input.nowMs);
      }
      return {childRunId:input.childRunId,workerLeaseId:input.workerLeaseId,workerOwnerId:input.workerOwnerId,
        workerFencingToken:input.workerFencingToken,workerLeaseTokenHash:tokenHash,claimedAtMs:input.nowMs,updatedAtMs:input.nowMs};
    }).immediate();
  }

  listPendingHardeningPaidCallFinalizations(childRunId?:string){
    const rows=(childRunId?this.db.query(`SELECT * FROM hardening_paid_call_finalizations WHERE child_run_id=? AND status!='APPLIED'
      ORDER BY created_at_ms,id`).all(childRunId):this.db.query(`SELECT * FROM hardening_paid_call_finalizations WHERE status!='APPLIED'
      ORDER BY created_at_ms,id`).all()) as Array<Record<string,unknown>>;
    return rows.map((row)=>{
      try{return this.hardeningPaidCallFinalizationFromRow(row);}
      catch(error){
        if(error instanceof DatabaseIntegrityCorruptionError)throw error;
        if(error instanceof HardeningPromptCacheAuthorityUnavailableError||error instanceof HardeningPromptCacheAuthorityMismatchError)throw error;
        throw new DatabaseIntegrityCorruptionError(String(row.child_run_id),String(row.reservation_id));
      }
    });
  }

  claimHardeningPaidCallFinalization(input:{finalizationId:string;ownerId:string;rawToken:string;idempotencyKey:string;nowMs:number}){
    if(!input.finalizationId||!input.ownerId||input.ownerId.length>200||!input.rawToken||input.rawToken.length>200||
      !input.idempotencyKey||input.idempotencyKey.length>200||!Number.isSafeInteger(input.nowMs)||input.nowMs<0)
      throw new TypeError("invalid hardening finalization claim");
    return this.db.transaction(()=>{
      const row=this.db.query("SELECT * FROM hardening_paid_call_finalizations WHERE id=?").get(input.finalizationId) as Record<string,unknown>|null;
      if(!row)throw new HardeningBudgetAuthorityInvalidError();const current=this.hardeningPaidCallFinalizationFromRow(row);
      const exact=row.claim_owner_id===input.ownerId&&row.claim_token_hash===sha256(input.rawToken)&&row.claim_idempotency_key===input.idempotencyKey;
      if(current.status==="APPLIED"){
        if(!exact)throw new HardeningReservationConflictError();return current;
      }
      if(current.status==="CLAIMED"&&current.claimExpiresAtMs!>input.nowMs&&!exact)throw new HardeningExecutionFenceStaleError();
      if(current.status==="CLAIMED"&&exact&&current.claimExpiresAtMs!>input.nowMs)return current;
      const changed=this.db.query(`UPDATE hardening_paid_call_finalizations SET status='CLAIMED',claim_owner_id=?,claim_token_hash=?,
        claim_generation=claim_generation+1,claim_idempotency_key=?,claim_expires_at_ms=?,updated_at_ms=? WHERE id=? AND status=? AND claim_generation=?`)
        .run(input.ownerId,sha256(input.rawToken),input.idempotencyKey,input.nowMs+30_000,input.nowMs,input.finalizationId,
          current.status,current.claimGeneration);
      if(changed.changes!==1)throw new HardeningExecutionFenceStaleError();
      return this.hardeningPaidCallFinalizationFromRow(this.db.query("SELECT * FROM hardening_paid_call_finalizations WHERE id=?")
        .get(input.finalizationId) as Record<string,unknown>);
    }).immediate();
  }

  applyHardeningPaidCallFinalization(input:{finalizationId:string;ownerId:string;rawToken:string;idempotencyKey:string;nowMs:number}){
    if(!input.finalizationId||!input.ownerId||input.ownerId.length>200||!input.rawToken||input.rawToken.length>200||
      !input.idempotencyKey||input.idempotencyKey.length>200||!Number.isSafeInteger(input.nowMs)||input.nowMs<0)
      throw new TypeError("invalid hardening finalization application");
    return this.db.transaction(()=>{
      const row=this.db.query("SELECT * FROM hardening_paid_call_finalizations WHERE id=?").get(input.finalizationId) as Record<string,unknown>|null;
      if(!row)throw new HardeningBudgetAuthorityInvalidError();const current=this.hardeningPaidCallFinalizationFromRow(row);
      if(current.status==="APPLIED"){
        if(row.claim_owner_id!==input.ownerId||row.claim_token_hash!==sha256(input.rawToken)||row.claim_idempotency_key!==input.idempotencyKey)
          throw new HardeningReservationConflictError();return current;
      }
      if(current.status!=="CLAIMED"||row.claim_owner_id!==input.ownerId||row.claim_token_hash!==sha256(input.rawToken)||
        row.claim_idempotency_key!==input.idempotencyKey||current.claimExpiresAtMs!<=input.nowMs)throw new HardeningExecutionFenceStaleError();
      const changed=this.db.query(`UPDATE hardening_paid_call_finalizations SET status='APPLIED',applied_at_ms=?,updated_at_ms=?
        WHERE id=? AND status='CLAIMED' AND claim_generation=?`).run(input.nowMs,input.nowMs,input.finalizationId,current.claimGeneration);
      if(changed.changes!==1)throw new HardeningExecutionFenceStaleError();
      return this.hardeningPaidCallFinalizationFromRow(this.db.query("SELECT * FROM hardening_paid_call_finalizations WHERE id=?")
        .get(input.finalizationId) as Record<string,unknown>);
    }).immediate();
  }

  recordHardeningPaidCallResponse(input:{childRunId:string;reservationId:string;requestHash:string;clientRequestId:string;
    modelCall:ModelCallRecord;providerResponseId:string;providerResponseArtifactId:string;fenceOwnerId:string;
    fenceGeneration:number;rawFenceToken:string;nowMs:number}):void{
    const strictReader=this.hardeningArtifactReader;
    if(!strictReader)throw new HardeningBudgetAuthorityInvalidError();
    const record=this.normalizeHardeningModelCall(input.modelCall);
    const decision=this.db.transaction(()=>{
      const budget=this.db.query("SELECT * FROM hardening_child_budget_authorities WHERE child_run_id=?").get(input.childRunId) as Record<string,unknown>|null;
      const row=this.db.query("SELECT * FROM hardening_child_model_reservations WHERE id=? AND child_run_id=?")
        .get(input.reservationId,input.childRunId) as Record<string,unknown>|null;
      if(!budget||!row)throw new HardeningBudgetAuthorityInvalidError();const reservation=this.hardeningBudgetReservationFromRow(row);
      if(reservation.requestHash!==input.requestHash||reservation.clientRequestId!==input.clientRequestId||record.runId!==input.childRunId||
        record.agentExecutionId!==reservation.agentExecutionId||record.logicalTier!==reservation.modelTier||record.resolvedModel!==reservation.resolvedModel||
        record.cacheKey!==reservation.promptCacheKeyHash||record.status!=="SUCCEEDED"||record.retryCount!==0||
        !record.inputContextRefs.includes(input.requestHash)||!record.inputContextRefs.includes(input.clientRequestId)||
        !record.inputContextRefs.includes(input.providerResponseId))throw new HardeningReservationConflictError();
      if(budget.status!=="ACTIVE")throw new HardeningBudgetStoppedError(budget.stop_reason as HardeningBudgetStopReason);
      if(budget.fence_owner_id!==input.fenceOwnerId||Number(budget.fence_generation)!==input.fenceGeneration||
        budget.fence_token_hash!==sha256(input.rawFenceToken)||budget.fence_expires_at_ms===null||Number(budget.fence_expires_at_ms)<=input.nowMs||
        row.fence_owner_id!==input.fenceOwnerId||Number(row.fence_generation)!==input.fenceGeneration||row.fence_token_hash!==sha256(input.rawFenceToken))
        throw new HardeningExecutionFenceStaleError();
      if(row.status==="RESERVED"&&row.dispatch_status==="RESPONSE_RECORDED"){
        const persisted=this.db.query("SELECT * FROM model_calls WHERE id=? AND run_id=?").get(String(row.model_call_id),input.childRunId) as Record<string,unknown>|null;
        if(!persisted||canonicalJson(this.hardeningModelCallFromRow(persisted))!==canonicalJson(record)||
          row.provider_response_id!==input.providerResponseId||row.provider_response_artifact_id!==input.providerResponseArtifactId)
          throw new HardeningReservationConflictError();
        return;
      }
      if(row.status!=="RESERVED"||row.dispatch_status!=="DISPATCHING")throw new HardeningReservationConflictError();
      const artifactRow=this.db.query("SELECT * FROM artifacts WHERE id=? AND run_id=?").get(input.providerResponseArtifactId,input.childRunId) as Record<string,unknown>|null;
      if(!artifactRow)throw new HardeningBudgetAuthorityInvalidError();const artifact=this.artifactFromRow(artifactRow);
      if(artifact.type!=="MODEL_PROVIDER_RESPONSE"||!artifact.trusted||artifact.producerType!=="SYSTEM"||
        artifact.producerId!=="engineer-provider-response-recorder")throw new HardeningBudgetAuthorityInvalidError();
      const bytes=strictReader(artifact);
      if(bytes.byteLength!==artifact.sizeBytes||!matchesSha256Bytes(bytes,artifact.sha256))throw new HardeningBudgetAuthorityInvalidError();
      try{const response=JSON.parse(bytes.toString("utf8")) as {id?:unknown;usage?:{input_tokens?:unknown;output_tokens?:unknown;
          input_tokens_details?:{cached_tokens?:unknown;cache_write_tokens?:unknown}}};
        if(response.id!==input.providerResponseId||(response.usage?.input_tokens??null)!==record.inputTokens||
          (response.usage?.output_tokens??null)!==record.outputTokens||
          (response.usage?.input_tokens_details?.cached_tokens??null)!==(record.cachedInputTokens??null)||
          (response.usage?.input_tokens_details?.cache_write_tokens??null)!==(record.cacheWriteInputTokens??null))
          throw new HardeningBudgetAuthorityInvalidError();
      }catch(error){if(error instanceof HardeningBudgetAuthorityInvalidError)throw error;throw new HardeningBudgetAuthorityInvalidError();}
      this.recordModelCall(record,input.reservationId);
      const changed=this.db.query(`UPDATE hardening_child_model_reservations SET dispatch_status='RESPONSE_RECORDED',response_recorded_at_ms=?,
        model_call_id=?,provider_response_id=?,provider_response_artifact_id=? WHERE id=? AND status='RESERVED' AND dispatch_status='DISPATCHING'`)
        .run(input.nowMs,record.modelCallId,input.providerResponseId,input.providerResponseArtifactId,input.reservationId);
      if(changed.changes!==1)throw new HardeningReservationConflictError();
    });
    decision.immediate();
  }

  /**
   * Provider-free recovery for a reservation owned by a crashed generation.
   * A live ACTIVE fence cannot be displaced. Once dispatch began, the request
   * is never replayed: missing response evidence consumes the full liability.
   */
  voidHardeningPaidCallUnsent(input:{childRunId:string;reservationId:string;requestHash:string;clientRequestId:string;
    settlementIdempotencyKey:string;fenceOwnerId:string;fenceGeneration:number;rawFenceToken:string;nowMs:number}){
    return this.db.transaction(()=>{
      const budget=this.db.query("SELECT * FROM hardening_child_budget_authorities WHERE child_run_id=?").get(input.childRunId) as Record<string,unknown>|null;
      const row=this.db.query("SELECT * FROM hardening_child_model_reservations WHERE id=? AND child_run_id=?").get(input.reservationId,input.childRunId) as Record<string,unknown>|null;
      if(!budget||!row)throw new HardeningBudgetAuthorityInvalidError();
      try{this.hardeningChildBudgetFromRow(budget);}
      catch(error){
        if(error instanceof HardeningBudgetAuthorityInvalidError)
          throw new DatabaseIntegrityCorruptionError(input.childRunId,input.reservationId);
        throw error;
      }
      const reservation=this.hardeningBudgetReservationFromRow(row);
      if(reservation.requestHash!==input.requestHash||reservation.clientRequestId!==input.clientRequestId)
        throw new HardeningReservationConflictError();
      if(row.status==="VOID_UNSENT"){
        const reconciliation=this.hardeningBudgetReconciliationFromRow(row,reservation);
        if(!reconciliation||row.settlement_idempotency_key!==input.settlementIdempotencyKey)throw new HardeningReservationConflictError();
        return reconciliation;
      }
      if(budget.status!=="ACTIVE"||budget.fence_owner_id!==input.fenceOwnerId||Number(budget.fence_generation)!==input.fenceGeneration||
        budget.fence_token_hash!==sha256(input.rawFenceToken)||budget.fence_expires_at_ms===null||Number(budget.fence_expires_at_ms)<=input.nowMs||
        row.fence_owner_id!==input.fenceOwnerId||row.fence_token_hash!==sha256(input.rawFenceToken)||Number(row.fence_generation)!==input.fenceGeneration)
        throw new HardeningExecutionFenceStaleError();
      if(row.status!=="RESERVED"||row.dispatch_status!=="RESERVED_UNSENT")throw new HardeningReservationConflictError();
      const now=new Date(input.nowMs).toISOString();
      const slot=this.db.query("UPDATE hardening_model_call_slots SET status='FAILED',updated_at=? WHERE id=? AND status='CLAIMED' AND model_call_id IS NULL")
        .run(now,reservation.paidCallSlotId);if(slot.changes!==1)throw new HardeningReservationConflictError();
      const reconciliation=createHardeningBudgetReconciliation({schemaVersion:1,policyVersion:"engineer-hardening-budget-reconciliation-v1",
        childRunId:input.childRunId,reservationId:reservation.reservationId,reservationHash:reservation.reservationHash,status:"VOID_UNSENT",
        providerResponseId:null,modelCallId:null,actualInputTokens:null,actualOutputTokens:null,actualCachedInputTokens:null,
        actualCacheWriteInputTokens:null,cacheObservation:"UNKNOWN",actualCostMicrousd:null,createdAt:now});
      const changed=this.db.query(`UPDATE hardening_child_model_reservations SET status='VOID_UNSENT',dispatch_status='VOID_UNSENT',
        settlement_idempotency_key=?,settlement_input_hash=?,reconciliation_id=?,reconciliation_hash=?,reconciliation_json=?,settled_at_ms=?
        WHERE id=? AND status='RESERVED' AND dispatch_status='RESERVED_UNSENT'`).run(input.settlementIdempotencyKey,
          sha256({settlementIdempotencyKey:input.settlementIdempotencyKey,outcome:"VOID_UNSENT"}),reconciliation.reconciliationId,
          reconciliation.reconciliationHash,canonicalJson(reconciliation),input.nowMs,input.reservationId);
      if(changed.changes!==1)throw new HardeningReservationConflictError();
      const budgetChanged=this.db.query(`UPDATE hardening_child_budget_authorities SET reserved_cost_microusd=reserved_cost_microusd-?,
        reserved_tokens=reserved_tokens-?,revision=revision+1,updated_at_ms=? WHERE child_run_id=? AND revision=?
        AND reserved_cost_microusd>=? AND reserved_tokens>=?`).run(reservation.reservedCostMicrousd,reservation.reservedTokens,input.nowMs,
          input.childRunId,Number(budget.revision),reservation.reservedCostMicrousd,reservation.reservedTokens);
      if(budgetChanged.changes!==1)throw new HardeningReservationConflictError();
      this.recordHardeningPaidCallFinalizationUnderLock({childRunId:input.childRunId,reservationId:input.reservationId,
        outcome:"VOID_UNSENT",reconciliation,nowMs:input.nowMs});
      const current=this.db.query("SELECT * FROM hardening_child_budget_authorities WHERE child_run_id=?").get(input.childRunId) as Record<string,unknown>;
      this.stopHardeningBudgetUnderLock(current,"MODEL_DISPATCH_NOT_STARTED",input.nowMs);
      return reconciliation;
    }).immediate();
  }

  recoverHardeningPaidCall(input:{childRunId:string;reservationId:string;recoveryOwnerId:string;
    recoveryIdempotencyKey:string;rawRecoveryToken:string;nowMs:number}):{
      outcome:"VOID_UNSENT"|"AMBIGUOUS"|"SETTLED_RECOVERED";reconciliation:HardeningBudgetReconciliation;
    }{
    if(!input.recoveryOwnerId||input.recoveryOwnerId.length>200||!input.recoveryIdempotencyKey||input.recoveryIdempotencyKey.length>200||
      !input.rawRecoveryToken||input.rawRecoveryToken.length>200||!Number.isSafeInteger(input.nowMs)||input.nowMs<0)
      throw new TypeError("invalid hardening recovery authority");
    const decision=this.db.transaction(()=>{
      let budget=this.db.query("SELECT * FROM hardening_child_budget_authorities WHERE child_run_id=?").get(input.childRunId) as Record<string,unknown>|null;
      const row=this.db.query("SELECT * FROM hardening_child_model_reservations WHERE id=? AND child_run_id=?")
        .get(input.reservationId,input.childRunId) as Record<string,unknown>|null;
      if(!budget||!row)throw new DatabaseIntegrityCorruptionError(input.childRunId,input.reservationId);
      try{this.hardeningChildBudgetFromRow(budget);}
      catch(error){
        if(error instanceof HardeningPromptCacheAuthorityUnavailableError)throw error;
        if(error instanceof HardeningBudgetAuthorityInvalidError)
          throw new DatabaseIntegrityCorruptionError(input.childRunId,input.reservationId);
        throw error;
      }
      let reservation:HardeningBudgetReservation;
      try{reservation=this.hardeningBudgetReservationFromRow(row,false);}
      catch(error){
        if(error instanceof HardeningPromptCacheAuthorityUnavailableError||error instanceof HardeningPromptCacheAuthorityMismatchError)throw error;
        if(error instanceof HardeningBudgetAuthorityInvalidError&&this.hardeningPromptCacheSecret)
          throw new DatabaseIntegrityCorruptionError(input.childRunId,input.reservationId);
        throw error;
      }
      if(row.status==="RESERVED"&&row.dispatch_status==="RESPONSE_RECORDED"){
        const modelRow=typeof row.model_call_id==="string"?this.db.query("SELECT * FROM model_calls WHERE id=? AND run_id=?")
          .get(row.model_call_id,input.childRunId) as Record<string,unknown>|null:null;
        const artifactRow=typeof row.provider_response_artifact_id==="string"?this.db.query("SELECT * FROM artifacts WHERE id=? AND run_id=?")
          .get(row.provider_response_artifact_id,input.childRunId) as Record<string,unknown>|null:null;
        try{
          if(!modelRow||!artifactRow||typeof row.provider_response_id!=="string")throw new Error("missing durable response authority");
          const model=this.hardeningModelCallFromRow(modelRow),artifact=this.artifactFromRow(artifactRow),run=this.getRun(input.childRunId);
          const providerInputHash=model.inputContextRefs[1];
          const expectedRefs=[run.manifestHash,providerInputHash,reservation.requestHash,reservation.clientRequestId,row.provider_response_id];
          const expectedPrompt=reservation.role==="BUILDER"?"engineer-codex-builder-v3":"engineer-isolated-reviewer-v6";
          const expectedSchema=reservation.role==="BUILDER"?null:"reviewer-output-v1";
          const agentCalls=this.db.query("SELECT COUNT(*) AS count FROM model_calls WHERE run_id=? AND agent_execution_id=?")
            .get(input.childRunId,reservation.agentExecutionId) as {count:number};
          const reservationCalls=this.db.query("SELECT COUNT(*) AS count FROM model_calls WHERE run_id=? AND budget_reservation_id=?")
            .get(input.childRunId,reservation.reservationId) as {count:number};
          if(!run.manifestHash||agentCalls.count!==1||reservationCalls.count!==1||model.modelCallId!==row.model_call_id||
            model.agentExecutionId!==reservation.agentExecutionId||model.logicalTier!==reservation.modelTier||
            model.resolvedModel!==reservation.resolvedModel||model.promptTemplateVersion!==expectedPrompt||
            model.outputSchemaVersion!==expectedSchema||model.cacheKey!==reservation.promptCacheKeyHash||model.status!=="SUCCEEDED"||
            model.retryCount!==0||modelRow.budget_reservation_id!==reservation.reservationId||
            !/^sha256:[a-f0-9]{64}$/.test(providerInputHash??"")||canonicalJson(model.inputContextRefs)!==canonicalJson(expectedRefs)||
            String(modelRow.input_context_refs_json)!==canonicalJson(expectedRefs)||artifact.artifactId!==row.provider_response_artifact_id||
            artifact.type!=="MODEL_PROVIDER_RESPONSE"||!artifact.trusted||artifact.producerType!=="SYSTEM"||
            artifact.producerId!=="engineer-provider-response-recorder")throw new Error("durable response authority drift");
        }catch(error){
          if(error instanceof DatabaseIntegrityCorruptionError)throw error;
          throw new DatabaseIntegrityCorruptionError(input.childRunId,input.reservationId);
        }
      }
      if(row.status!=="RESERVED"){
        if(Number(row.recovery_generation)>0&&(row.recovery_owner_id!==input.recoveryOwnerId||
          row.recovery_token_hash!==sha256(input.rawRecoveryToken)||row.recovery_idempotency_key!==input.recoveryIdempotencyKey))
          throw new HardeningReservationConflictError();
        const reconciliation=Number(row.recovery_generation)>0&&typeof row.reconciliation_json==="string"
          ? HardeningBudgetReconciliationSchema.parse(JSON.parse(row.reconciliation_json))
          : this.hardeningBudgetReconciliationFromRow(row,reservation);
        if(!reconciliation)throw new HardeningBudgetAuthorityInvalidError();
        return {outcome:row.status==="VOID_UNSENT"?"VOID_UNSENT":row.status==="SETTLED"?"SETTLED_RECOVERED":"AMBIGUOUS",reconciliation} as const;
      }
      if(budget.status==="ACTIVE"){
        if(budget.fence_expires_at_ms!==null&&Number(budget.fence_expires_at_ms)>input.nowMs)
          throw new HardeningExecutionFenceStaleError();
      }else if(budget.status!=="STOPPED")throw new HardeningBudgetAuthorityInvalidError();
      const recoveryGeneration=Number(row.recovery_generation),recoveryExpiry=row.recovery_expires_at_ms===null?null:Number(row.recovery_expires_at_ms);
      const exactRecovery=row.recovery_owner_id===input.recoveryOwnerId&&row.recovery_token_hash===sha256(input.rawRecoveryToken)&&
        row.recovery_idempotency_key===input.recoveryIdempotencyKey;
      if(recoveryGeneration===0||(recoveryExpiry!==null&&recoveryExpiry<=input.nowMs)){
        const claimed=this.db.query(`UPDATE hardening_child_model_reservations SET recovery_owner_id=?,recovery_token_hash=?,
          recovery_generation=recovery_generation+1,recovery_idempotency_key=?,recovery_claimed_at_ms=?,recovery_expires_at_ms=?
          WHERE id=? AND status='RESERVED' AND recovery_generation=? AND
            (recovery_generation=0 OR recovery_expires_at_ms<=?)`)
          .run(input.recoveryOwnerId,sha256(input.rawRecoveryToken),input.recoveryIdempotencyKey,input.nowMs,input.nowMs+30_000,
            input.reservationId,recoveryGeneration,input.nowMs);
        if(claimed.changes!==1)throw new HardeningReservationConflictError();
      }else if(!exactRecovery)throw new HardeningExecutionFenceStaleError();
      const now=new Date(input.nowMs).toISOString(),reservedCost=reservation.reservedCostMicrousd,reservedTokens=reservation.reservedTokens;
      const finalizeBudget=(mode:"VOID"|"AMBIGUOUS"|"SETTLED",actualCost=0,actualTokens=0)=>{
        const update=mode==="VOID"
          ? `reserved_cost_microusd=reserved_cost_microusd-?,reserved_tokens=reserved_tokens-?`
          : mode==="AMBIGUOUS"
            ? `reserved_cost_microusd=reserved_cost_microusd-?,reserved_tokens=reserved_tokens-?,ambiguous_cost_microusd=ambiguous_cost_microusd+${reservedCost},ambiguous_tokens=ambiguous_tokens+${reservedTokens}`
            : `reserved_cost_microusd=reserved_cost_microusd-?,reserved_tokens=reserved_tokens-?,used_cost_microusd=used_cost_microusd+${actualCost},used_tokens=used_tokens+${actualTokens}`;
        const changed=this.db.query(`UPDATE hardening_child_budget_authorities SET ${update},revision=revision+1,updated_at_ms=?
          WHERE child_run_id=? AND reserved_cost_microusd>=? AND reserved_tokens>=?`).run(reservedCost,reservedTokens,input.nowMs,
            input.childRunId,reservedCost,reservedTokens);
        if(changed.changes!==1)throw new HardeningReservationConflictError();
      };
      if(row.dispatch_status==="RESERVED_UNSENT"){
        const slot=this.db.query("UPDATE hardening_model_call_slots SET status='FAILED',updated_at=? WHERE id=? AND status='CLAIMED' AND model_call_id IS NULL")
          .run(now,reservation.paidCallSlotId);if(slot.changes!==1)throw new HardeningReservationConflictError();
        const reconciliation=createHardeningBudgetReconciliation({schemaVersion:1,policyVersion:"engineer-hardening-budget-reconciliation-v1",
          childRunId:input.childRunId,reservationId:reservation.reservationId,reservationHash:reservation.reservationHash,status:"VOID_UNSENT",
          providerResponseId:null,modelCallId:null,actualInputTokens:null,actualOutputTokens:null,actualCachedInputTokens:null,
          actualCacheWriteInputTokens:null,cacheObservation:"UNKNOWN",actualCostMicrousd:null,createdAt:now});
        const changed=this.db.query(`UPDATE hardening_child_model_reservations SET status='VOID_UNSENT',dispatch_status='VOID_UNSENT',
          settlement_idempotency_key=?,settlement_input_hash=?,reconciliation_id=?,reconciliation_hash=?,reconciliation_json=?,settled_at_ms=?
          WHERE id=? AND status='RESERVED' AND dispatch_status='RESERVED_UNSENT'`).run(input.recoveryIdempotencyKey,
            sha256({recoveryIdempotencyKey:input.recoveryIdempotencyKey,outcome:"VOID_UNSENT"}),reconciliation.reconciliationId,
            reconciliation.reconciliationHash,canonicalJson(reconciliation),input.nowMs,input.reservationId);
        if(changed.changes!==1)throw new HardeningReservationConflictError();finalizeBudget("VOID");
        this.recordHardeningPaidCallFinalizationUnderLock({childRunId:input.childRunId,reservationId:input.reservationId,
          outcome:"VOID_UNSENT",reconciliation,nowMs:input.nowMs});
        if(budget.status==="ACTIVE"){
          const current=this.db.query("SELECT * FROM hardening_child_budget_authorities WHERE child_run_id=?").get(input.childRunId) as Record<string,unknown>;
          this.stopHardeningBudgetUnderLock(current,"MODEL_DISPATCH_NOT_STARTED",input.nowMs);
        }
        return {outcome:"VOID_UNSENT" as const,reconciliation};
      }
      if(row.dispatch_status==="DISPATCHING"){
        const modelCall=ModelCallRecordSchema.parse({modelCallId:sha256({namespace:"engineer-hardening-crash-recovery-model-call-v1",
          reservationId:reservation.reservationId}),runId:input.childRunId,agentExecutionId:reservation.agentExecutionId,
          logicalTier:reservation.modelTier,resolvedModel:reservation.resolvedModel,
          promptTemplateVersion:reservation.role==="BUILDER"?"engineer-codex-builder-v3":"engineer-isolated-reviewer-v6",
          inputContextRefs:[reservation.requestHash,reservation.clientRequestId],
          outputSchemaVersion:reservation.role==="BUILDER"?null:"reviewer-output-v1",cacheKey:reservation.promptCacheKeyHash,
          cacheHit:null,latencyMs:Math.max(0,input.nowMs-Number(row.dispatch_started_at_ms)),inputTokens:null,outputTokens:null,
          retryCount:0,status:"FAILED",createdAt:now});
        this.recordModelCall(modelCall,reservation.reservationId);
        const slot=this.db.query("UPDATE hardening_model_call_slots SET status='AMBIGUOUS',model_call_id=?,updated_at=? WHERE id=? AND status='CLAIMED'")
          .run(modelCall.modelCallId,now,reservation.paidCallSlotId);if(slot.changes!==1)throw new HardeningReservationConflictError();
        const reconciliation=createHardeningBudgetReconciliation({schemaVersion:1,policyVersion:"engineer-hardening-budget-reconciliation-v1",
          childRunId:input.childRunId,reservationId:reservation.reservationId,reservationHash:reservation.reservationHash,status:"AMBIGUOUS",
          providerResponseId:null,modelCallId:modelCall.modelCallId,actualInputTokens:null,actualOutputTokens:null,actualCachedInputTokens:null,
          actualCacheWriteInputTokens:null,cacheObservation:"UNKNOWN",actualCostMicrousd:null,createdAt:now});
        const changed=this.db.query(`UPDATE hardening_child_model_reservations SET status='AMBIGUOUS',dispatch_status='AMBIGUOUS',model_call_id=?,
          cache_observation='UNKNOWN',settlement_idempotency_key=?,settlement_input_hash=?,reconciliation_id=?,reconciliation_hash=?,reconciliation_json=?,settled_at_ms=?
          WHERE id=? AND status='RESERVED' AND dispatch_status='DISPATCHING'`).run(modelCall.modelCallId,input.recoveryIdempotencyKey,
            sha256({recoveryIdempotencyKey:input.recoveryIdempotencyKey,outcome:"AMBIGUOUS"}),reconciliation.reconciliationId,
            reconciliation.reconciliationHash,canonicalJson(reconciliation),input.nowMs,input.reservationId);
        if(changed.changes!==1)throw new HardeningReservationConflictError();finalizeBudget("AMBIGUOUS");
        this.recordHardeningPaidCallFinalizationUnderLock({childRunId:input.childRunId,reservationId:input.reservationId,
          outcome:"AMBIGUOUS",reconciliation,nowMs:input.nowMs});
        if(budget.status==="ACTIVE"){
          const current=this.db.query("SELECT * FROM hardening_child_budget_authorities WHERE child_run_id=?").get(input.childRunId) as Record<string,unknown>;
          this.stopHardeningBudgetUnderLock(current,"MODEL_USAGE_AMBIGUOUS",input.nowMs);
        }
        return {outcome:"AMBIGUOUS" as const,reconciliation};
      }
      if(row.dispatch_status!=="RESPONSE_RECORDED")throw new HardeningBudgetAuthorityInvalidError();
      if(typeof row.model_call_id!=="string"||!row.model_call_id||typeof row.provider_response_id!=="string"||
        !row.provider_response_id||typeof row.provider_response_artifact_id!=="string"||!row.provider_response_artifact_id)
        throw new HardeningBudgetAuthorityInvalidError();
      const responseRecordedModelCallId=row.model_call_id;
      const modelRow=this.db.query("SELECT * FROM model_calls WHERE id=? AND run_id=?")
        .get(responseRecordedModelCallId,input.childRunId) as Record<string,unknown>|null;
      const artifactRow=this.db.query("SELECT * FROM artifacts WHERE id=? AND run_id=?")
        .get(row.provider_response_artifact_id,input.childRunId) as Record<string,unknown>|null;
      const recoveryRun=this.getRun(input.childRunId);
      if(!recoveryRun.manifestHash)throw new HardeningBudgetAuthorityInvalidError();
      let modelCall:ModelCallRecord|null=null,receiptArtifact:ArtifactRecord|null=null,receiptValid=false;
      let receiptFailureCode:HardeningInvalidReceiptObservation["failureCode"]|null=null;
      let observedReceiptSha256:string|null=null,observedReceiptSizeBytes:number|null=null;
      if(modelRow){
        try{modelCall=this.hardeningModelCallFromRow(modelRow);}catch{modelCall=null;}
      }
      const expectedPromptVersion=reservation.role==="BUILDER"?"engineer-codex-builder-v3":"engineer-isolated-reviewer-v6";
      const expectedOutputSchema=reservation.role==="BUILDER"?null:"reviewer-output-v1";
      const providerInputHash=modelCall?.inputContextRefs[1];
      const expectedRefs=[recoveryRun.manifestHash,providerInputHash,reservation.requestHash,reservation.clientRequestId,row.provider_response_id];
      const modelBindingValid=modelRow!==null&&modelCall!==null&&modelCall.modelCallId===responseRecordedModelCallId&&
        modelCall.agentExecutionId===reservation.agentExecutionId&&modelCall.logicalTier===reservation.modelTier&&
        modelCall.resolvedModel===reservation.resolvedModel&&modelCall.cacheKey===reservation.promptCacheKeyHash&&
        modelCall.status==="SUCCEEDED"&&modelCall.retryCount===0&&modelCall.promptTemplateVersion===expectedPromptVersion&&
        modelCall.outputSchemaVersion===expectedOutputSchema&&modelRow.budget_reservation_id===reservation.reservationId&&
        /^sha256:[a-f0-9]{64}$/.test(providerInputHash??"")&&canonicalJson(modelCall.inputContextRefs)===canonicalJson(expectedRefs)&&
        String(modelRow.input_context_refs_json)===canonicalJson(expectedRefs);
      if(!modelBindingValid)throw new DatabaseIntegrityCorruptionError(input.childRunId,input.reservationId);
      if(artifactRow){
        try{receiptArtifact=this.artifactFromRow(artifactRow);}catch{receiptArtifact=null;}
      }
      if(modelBindingValid&&(!receiptArtifact||receiptArtifact.artifactId!==row.provider_response_artifact_id||
        receiptArtifact.type!=="MODEL_PROVIDER_RESPONSE"||!receiptArtifact.trusted||receiptArtifact.producerType!=="SYSTEM"||
        receiptArtifact.producerId!=="engineer-provider-response-recorder"))throw new HardeningBudgetAuthorityInvalidError();
      if(modelBindingValid&&receiptArtifact&&receiptFailureCode===null){
        const openedReceipt=readHardeningReceiptOnce(receiptArtifact.storageReference);
        if(openedReceipt.failureCode)receiptFailureCode=openedReceipt.failureCode;
        else{
            const bytes=openedReceipt.bytes;
            observedReceiptSha256=sha256Bytes(bytes);observedReceiptSizeBytes=bytes.byteLength;
            if(bytes.byteLength!==receiptArtifact.sizeBytes)receiptFailureCode="SIZE_MISMATCH";
            else if(!matchesSha256Bytes(bytes,receiptArtifact.sha256))receiptFailureCode="SHA256_MISMATCH";
            else{
              let response:{id?:unknown;usage?:{input_tokens?:unknown;output_tokens?:unknown;
                input_tokens_details?:{cached_tokens?:unknown;cache_write_tokens?:unknown}}}|null=null;
              try{response=JSON.parse(bytes.toString("utf8"));}catch{receiptFailureCode="INVALID_JSON";}
              if(response&&response.id!==row.provider_response_id)receiptFailureCode="PROVIDER_ID_MISMATCH";
              else if(response&&((response.usage?.input_tokens??null)!==modelCall!.inputTokens||
                (response.usage?.output_tokens??null)!==modelCall!.outputTokens||
                (response.usage?.input_tokens_details?.cached_tokens??null)!==(modelCall!.cachedInputTokens??null)||
                (response.usage?.input_tokens_details?.cache_write_tokens??null)!==(modelCall!.cacheWriteInputTokens??null)))
                receiptFailureCode="USAGE_MISMATCH";
              else if(response)receiptValid=true;
            }
        }
      }
      const recordedCached=modelCall?.cachedInputTokens,recordedWrite=modelCall?.cacheWriteInputTokens;
      const complete=receiptValid&&modelCall!==null&&modelCall.inputTokens!==null&&modelCall.outputTokens!==null&&recordedCached!==undefined&&recordedCached!==null&&
        recordedWrite!==undefined&&recordedWrite!==null&&modelCall.inputTokens<=reservation.inputTokenUpperBound&&
        modelCall.outputTokens<=reservation.outputTokenCeiling&&recordedCached+recordedWrite<=modelCall.inputTokens;
      if(receiptValid&&!complete)receiptFailureCode="USAGE_MISMATCH";
      if(!complete){
        if(!receiptFailureCode||artifactRow!==null&&receiptArtifact===null)throw new HardeningBudgetAuthorityInvalidError();
        const ambiguousModel=modelCall!,modelCallKind="ORIGINAL_SUCCEEDED" as const;
        const beforeCallCount=this.db.query(`SELECT COUNT(*) AS count FROM model_calls WHERE run_id=? AND agent_execution_id=?`)
          .get(input.childRunId,reservation.agentExecutionId) as {count:number};
        const beforeReservationCallCount=this.db.query(`SELECT COUNT(*) AS count FROM model_calls WHERE run_id=? AND budget_reservation_id=?`)
          .get(input.childRunId,reservation.reservationId) as {count:number};
        if(beforeCallCount.count!==1||beforeReservationCallCount.count!==1)throw new HardeningBudgetAuthorityInvalidError();
        const recoveryState=this.db.query(`SELECT recovery_generation,recovery_owner_id,recovery_token_hash,
          recovery_idempotency_key,recovery_claimed_at_ms,recovery_expires_at_ms
          FROM hardening_child_model_reservations WHERE id=?`).get(input.reservationId) as Record<string,unknown>|null;
        if(!recoveryState||recoveryState.recovery_owner_id!==input.recoveryOwnerId||
          recoveryState.recovery_idempotency_key!==input.recoveryIdempotencyKey||
          recoveryState.recovery_token_hash!==sha256(input.rawRecoveryToken))throw new HardeningBudgetAuthorityInvalidError();
        const afterCallCount=this.db.query(`SELECT COUNT(*) AS count FROM model_calls WHERE run_id=? AND agent_execution_id=?`)
          .get(input.childRunId,reservation.agentExecutionId) as {count:number};
        const afterReservationCallCount=this.db.query(`SELECT COUNT(*) AS count FROM model_calls WHERE run_id=? AND budget_reservation_id=?`)
          .get(input.childRunId,reservation.reservationId) as {count:number};
        const expectedAmbiguousRefs=expectedRefs;
        const ambiguousModelRow=this.db.query("SELECT * FROM model_calls WHERE id=? AND run_id=?")
          .get(ambiguousModel!.modelCallId,input.childRunId) as Record<string,unknown>|null;
        if(!ambiguousModelRow||afterCallCount.count!==1||afterReservationCallCount.count!==1||
          ambiguousModel.agentExecutionId!==reservation.agentExecutionId||ambiguousModel.logicalTier!==reservation.modelTier||
          ambiguousModel.resolvedModel!==reservation.resolvedModel||ambiguousModel.cacheKey!==reservation.promptCacheKeyHash||
          ambiguousModel.retryCount!==0||ambiguousModel.promptTemplateVersion!==expectedPromptVersion||
          ambiguousModel.outputSchemaVersion!==expectedOutputSchema||
          ambiguousModelRow.budget_reservation_id!==reservation.reservationId||
          canonicalJson(ambiguousModel.inputContextRefs)!==canonicalJson(expectedAmbiguousRefs)||
          String(ambiguousModelRow.input_context_refs_json)!==canonicalJson(expectedAmbiguousRefs)||
          ambiguousModel.status!=="SUCCEEDED")throw new HardeningBudgetAuthorityInvalidError();
        const invalidReceiptObservation=createHardeningInvalidReceiptObservation({schemaVersion:1,
          policyVersion:"engineer-hardening-invalid-receipt-observation-v1",childRunId:input.childRunId,
          reservationId:reservation.reservationId,
          reservationHash:reservation.reservationHash,recoveryGeneration:Number(recoveryState.recovery_generation),
          recoveryOwnerId:String(recoveryState.recovery_owner_id),recoveryIdempotencyKey:input.recoveryIdempotencyKey,
          recoveryIdempotencyKeyHash:sha256(input.recoveryIdempotencyKey),
          recoveryTokenHash:String(recoveryState.recovery_token_hash),
          recoveryClaimedAtMs:Number(recoveryState.recovery_claimed_at_ms),recoveryExpiresAtMs:Number(recoveryState.recovery_expires_at_ms),
          observedAtMs:input.nowMs,responseRecordedModelCallId,recordedModelCallRowHash:modelRow?sha256(modelRow):null,
          modelCallId:ambiguousModel!.modelCallId,modelCallHash:sha256(this.normalizeHardeningModelCall(ambiguousModel!)),
          modelCallKind,observedModelCallCount:afterCallCount.count,
          observedReservationModelCallCount:afterReservationCallCount.count,providerResponseId:row.provider_response_id,
          providerResponseArtifactId:row.provider_response_artifact_id,artifactSha256:receiptArtifact!.sha256,
          artifactSizeBytes:receiptArtifact!.sizeBytes,artifactStorageReferenceHash:sha256(receiptArtifact!.storageReference),
          artifactType:"MODEL_PROVIDER_RESPONSE",artifactTrusted:true,artifactProducerType:"SYSTEM",
          artifactProducerId:"engineer-provider-response-recorder",
          failureCode:receiptFailureCode,observedSha256:observedReceiptSha256,observedSizeBytes:observedReceiptSizeBytes});
        const invalidReceiptInputHash=this.recoveredInvalidReceiptInputHash({recoveryIdempotencyKey:input.recoveryIdempotencyKey,
          observation:invalidReceiptObservation});
        const slot=this.db.query("UPDATE hardening_model_call_slots SET status='AMBIGUOUS',model_call_id=?,updated_at=? WHERE id=? AND status='CLAIMED'")
          .run(ambiguousModel!.modelCallId,now,reservation.paidCallSlotId);if(slot.changes!==1)throw new HardeningReservationConflictError();
        const reconciliation=createHardeningBudgetReconciliation({schemaVersion:1,policyVersion:"engineer-hardening-budget-reconciliation-v1",
          childRunId:input.childRunId,reservationId:reservation.reservationId,reservationHash:reservation.reservationHash,status:"AMBIGUOUS",
          providerResponseId:null,modelCallId:ambiguousModel!.modelCallId,actualInputTokens:null,actualOutputTokens:null,actualCachedInputTokens:null,
          actualCacheWriteInputTokens:null,cacheObservation:"UNKNOWN",actualCostMicrousd:null,invalidReceiptObservation,createdAt:now});
        const changed=this.db.query(`UPDATE hardening_child_model_reservations SET status='AMBIGUOUS',dispatch_status='AMBIGUOUS',model_call_id=?,
          cache_observation='UNKNOWN',settlement_idempotency_key=?,settlement_input_hash=?,reconciliation_id=?,reconciliation_hash=?,reconciliation_json=?,settled_at_ms=?
          WHERE id=? AND status='RESERVED' AND dispatch_status='RESPONSE_RECORDED'`).run(ambiguousModel!.modelCallId,input.recoveryIdempotencyKey,
            invalidReceiptInputHash,reconciliation.reconciliationId,
            reconciliation.reconciliationHash,canonicalJson(reconciliation),input.nowMs,input.reservationId);
        if(changed.changes!==1)throw new HardeningReservationConflictError();finalizeBudget("AMBIGUOUS");
        this.recordHardeningPaidCallFinalizationUnderLock({childRunId:input.childRunId,reservationId:input.reservationId,
          outcome:"AMBIGUOUS",reconciliation,nowMs:input.nowMs});
        if(budget.status==="ACTIVE"){
          const current=this.db.query("SELECT * FROM hardening_child_budget_authorities WHERE child_run_id=?").get(input.childRunId) as Record<string,unknown>;
          this.stopHardeningBudgetUnderLock(current,"MODEL_USAGE_AMBIGUOUS",input.nowMs);
        }
        return {outcome:"AMBIGUOUS" as const,reconciliation};
      }
      const settledModel=modelCall!;
      const actualInput=settledModel.inputTokens!,actualOutput=settledModel.outputTokens!,cached=recordedCached!,write=recordedWrite!;
      const actualCost=hardeningPartitionedCostFromRatesMicrousd(actualInput,cached,write,actualOutput,{
        uncachedInputMicrousdPerMillion:reservation.uncachedInputMicrousdPerMillion,cachedInputMicrousdPerMillion:reservation.cachedInputMicrousdPerMillion,
        cacheWriteInputMicrousdPerMillion:reservation.cacheWriteInputMicrousdPerMillion,outputMicrousdPerMillion:reservation.outputMicrousdPerMillion});
      const observation=cached>0&&write>0?"MIXED":cached>0?"HIT":write>0?"WRITE":"MISS";
      const slot=this.db.query("UPDATE hardening_model_call_slots SET status='COMPLETED',model_call_id=?,updated_at=? WHERE id=? AND status='CLAIMED' AND model_call_id IS NULL")
        .run(settledModel.modelCallId,now,reservation.paidCallSlotId);if(slot.changes!==1)throw new HardeningReservationConflictError();
      const reconciliation=createHardeningBudgetReconciliation({schemaVersion:1,policyVersion:"engineer-hardening-budget-reconciliation-v1",
        childRunId:input.childRunId,reservationId:reservation.reservationId,reservationHash:reservation.reservationHash,status:"SETTLED",
        providerResponseId:String(row.provider_response_id),modelCallId:settledModel.modelCallId,actualInputTokens:actualInput,actualOutputTokens:actualOutput,
        actualCachedInputTokens:cached,actualCacheWriteInputTokens:write,cacheObservation:observation,actualCostMicrousd:actualCost,createdAt:now});
      const changed=this.db.query(`UPDATE hardening_child_model_reservations SET status='SETTLED',dispatch_status='SETTLED',
        actual_input_tokens=?,actual_uncached_input_tokens=?,actual_output_tokens=?,actual_cached_input_tokens=?,actual_cache_write_input_tokens=?,
        cache_observation=?,settled_cost_microusd=?,settlement_idempotency_key=?,settlement_input_hash=?,reconciliation_id=?,reconciliation_hash=?,
        reconciliation_json=?,settled_at_ms=? WHERE id=? AND status='RESERVED' AND dispatch_status='RESPONSE_RECORDED'`)
        .run(actualInput,actualInput-cached-write,actualOutput,cached,write,observation,actualCost,input.recoveryIdempotencyKey,
          sha256({recoveryIdempotencyKey:input.recoveryIdempotencyKey,outcome:"SETTLED_RECOVERED"}),reconciliation.reconciliationId,
          reconciliation.reconciliationHash,canonicalJson(reconciliation),input.nowMs,input.reservationId);
      if(changed.changes!==1)throw new HardeningReservationConflictError();finalizeBudget("SETTLED",actualCost,actualInput+actualOutput);
      this.recordHardeningPaidCallFinalizationUnderLock({childRunId:input.childRunId,reservationId:input.reservationId,
        outcome:"SETTLED_RECOVERED",reconciliation,nowMs:input.nowMs});
      return {outcome:"SETTLED_RECOVERED" as const,reconciliation};
    });
    return decision.immediate();
  }

  settleHardeningPaidCall(input:{childRunId:string;reservationId:string;modelCall:ModelCallRecord;providerResponseId:string|null;providerResponseArtifactId:string|null;
    settlementIdempotencyKey:string;fenceOwnerId:string;fenceGeneration:number;rawFenceToken:string;nowMs:number}):{
      status:"SETTLED"|"AMBIGUOUS";stopReason:"MODEL_USAGE_AMBIGUOUS"|"MODEL_USAGE_BOUND_VIOLATION"|null;
    }{
    const strictReader=this.hardeningArtifactReader;
    if(!strictReader)throw new HardeningBudgetAuthorityInvalidError();
    if(!input.settlementIdempotencyKey||input.settlementIdempotencyKey.length>200)throw new TypeError("invalid hardening settlement idempotency key");
    const record=this.normalizeHardeningModelCall(input.modelCall);
    if(record.runId!==input.childRunId)throw new HardeningReservationConflictError();
    const settlementInputHash=sha256({modelCall:record,providerResponseId:input.providerResponseId,
      providerResponseArtifactId:input.providerResponseArtifactId,settlementIdempotencyKey:input.settlementIdempotencyKey});
    const decision=this.db.transaction(()=>{
      const budgetRow=this.db.query("SELECT * FROM hardening_child_budget_authorities WHERE child_run_id=?").get(input.childRunId) as Record<string,unknown>|null;
      const reservation=this.db.query("SELECT * FROM hardening_child_model_reservations WHERE id=? AND child_run_id=?")
        .get(input.reservationId,input.childRunId) as Record<string,unknown>|null;
      if(!budgetRow||!reservation)throw new HardeningBudgetAuthorityInvalidError();this.hardeningChildBudgetFromRow(budgetRow);
      const reservationAuthority=this.hardeningBudgetReservationFromRow(reservation);
      const expectedPromptVersion=reservationAuthority.role==="BUILDER"?"engineer-codex-builder-v3":"engineer-isolated-reviewer-v6";
      const exactRoute=this.db.query("SELECT run_id,agent_execution_id,logical_tier,resolved_model FROM model_routing_decisions WHERE id=?")
        .get(reservationAuthority.routingDecisionId) as Record<string,unknown>|null;
      if(record.agentExecutionId!==reservationAuthority.agentExecutionId||record.logicalTier!==reservationAuthority.modelTier||
        record.resolvedModel!==reservationAuthority.resolvedModel||record.promptTemplateVersion!==expectedPromptVersion||
        record.cacheKey!==reservationAuthority.promptCacheKeyHash||!exactRoute||exactRoute.run_id!==input.childRunId||
        exactRoute.agent_execution_id!==record.agentExecutionId||exactRoute.logical_tier!==record.logicalTier||
        exactRoute.resolved_model!==record.resolvedModel)throw new HardeningReservationConflictError();
      if(reservation.status!=="RESERVED"){
        const persisted=this.db.query("SELECT * FROM model_calls WHERE id=? AND run_id=?").get(record.modelCallId,input.childRunId) as Record<string,unknown>|null;
        const persistedRecord=persisted?ModelCallRecordSchema.parse({modelCallId:persisted.id,runId:persisted.run_id,
          agentExecutionId:persisted.agent_execution_id,logicalTier:persisted.logical_tier,resolvedModel:persisted.resolved_model,
          promptTemplateVersion:persisted.prompt_template_version,inputContextRefs:JSON.parse(String(persisted.input_context_refs_json)),
          outputSchemaVersion:persisted.output_schema_version,cacheKey:persisted.cache_key,
          cacheHit:persisted.cache_hit===null?null:Number(persisted.cache_hit)===1,latencyMs:Number(persisted.latency_ms),
          inputTokens:persisted.input_tokens===null?null:Number(persisted.input_tokens),outputTokens:persisted.output_tokens===null?null:Number(persisted.output_tokens),
          cachedInputTokens:persisted.cached_input_tokens===null?null:Number(persisted.cached_input_tokens),
          cacheWriteInputTokens:persisted.cache_write_input_tokens===null?null:Number(persisted.cache_write_input_tokens),
          retryCount:Number(persisted.retry_count),status:persisted.status,createdAt:persisted.created_at}):null;
        if(reservation.settlement_idempotency_key!==input.settlementIdempotencyKey||reservation.model_call_id!==record.modelCallId||
          reservation.settlement_input_hash!==settlementInputHash||
          (reservation.status==="SETTLED"&&(reservation.provider_response_id!==input.providerResponseId||
            reservation.provider_response_artifact_id!==input.providerResponseArtifactId))||!persistedRecord)
          throw new HardeningReservationConflictError();
        this.hardeningBudgetReconciliationFromRow(reservation,reservationAuthority);
        const ambiguousHasDurableResponse=reservation.provider_response_id!==null&&
          reservation.provider_response_artifact_id!==null;
        const expectedPersistedRecord=reservation.status==="AMBIGUOUS"&&!ambiguousHasDurableResponse
          ?this.normalizeHardeningModelCall({...record,status:"FAILED",cacheHit:null,inputTokens:null,outputTokens:null,
            cachedInputTokens:null,cacheWriteInputTokens:null})
          :record;
        if(canonicalJson(persistedRecord)!==canonicalJson(expectedPersistedRecord))throw new HardeningReservationConflictError();
        const stopReason=reservation.status==="SETTLED"?null:
          budgetRow.stop_reason==="MODEL_USAGE_BOUND_VIOLATION"?"MODEL_USAGE_BOUND_VIOLATION":"MODEL_USAGE_AMBIGUOUS";
        return {value:{status:reservation.status==="SETTLED"?"SETTLED":"AMBIGUOUS",stopReason}} as const;
      }
      if(budgetRow.status!=="ACTIVE")return {error:new HardeningBudgetStoppedError(budgetRow.stop_reason as HardeningBudgetStopReason)} as const;
      const elapsed=this.hardeningActiveElapsedMs(budgetRow,input.nowMs);
      if(budgetRow.fence_owner_id!==input.fenceOwnerId||Number(budgetRow.fence_generation)!==input.fenceGeneration||
        budgetRow.fence_token_hash!==sha256(input.rawFenceToken)||budgetRow.fence_expires_at_ms===null||Number(budgetRow.fence_expires_at_ms)<=input.nowMs||
        reservation.fence_owner_id!==input.fenceOwnerId||Number(reservation.fence_generation)!==input.fenceGeneration||reservation.fence_token_hash!==sha256(input.rawFenceToken))
        throw new HardeningExecutionFenceStaleError();
      if(elapsed>=Number(budgetRow.active_time_limit_ms)){this.stopHardeningBudgetUnderLock(budgetRow,"ACTIVE_TIME_CAP_REACHED",input.nowMs);return {error:new HardeningBudgetStoppedError("ACTIVE_TIME_CAP_REACHED")} as const;}
      const responseRecorded=reservation.dispatch_status==="RESPONSE_RECORDED";
      if(reservation.dispatch_status!=="DISPATCHING"&&!responseRecorded)throw new HardeningReservationConflictError();
      if(responseRecorded){
        const persisted=this.db.query("SELECT * FROM model_calls WHERE id=? AND run_id=?").get(String(reservation.model_call_id),input.childRunId) as Record<string,unknown>|null;
        if(!persisted||canonicalJson(this.hardeningModelCallFromRow(persisted))!==canonicalJson(record)||
          reservation.provider_response_id!==input.providerResponseId||reservation.provider_response_artifact_id!==input.providerResponseArtifactId)
          throw new HardeningReservationConflictError();
      }
      const hasCompleteUsage=record.inputTokens!==null&&record.outputTokens!==null&&record.cachedInputTokens!==undefined&&record.cachedInputTokens!==null&&
        record.cacheWriteInputTokens!==undefined&&record.cacheWriteInputTokens!==null&&[record.inputTokens,record.outputTokens,
          record.cachedInputTokens,record.cacheWriteInputTokens].every((value)=>Number.isSafeInteger(value)&&value>=0);
      let artifactValid=false;
      if(hasCompleteUsage&&input.providerResponseArtifactId){const artifactRow=this.db.query("SELECT * FROM artifacts WHERE id=? AND run_id=?")
          .get(input.providerResponseArtifactId,input.childRunId) as Record<string,unknown>|null;
        if(artifactRow){const artifact=this.artifactFromRow(artifactRow);if(artifact.type==="MODEL_PROVIDER_RESPONSE"&&artifact.trusted&&artifact.producerType==="SYSTEM"){
          const bytes=strictReader(artifact);
          if(bytes.byteLength===artifact.sizeBytes&&matchesSha256Bytes(bytes,artifact.sha256)){
            try{const response=JSON.parse(bytes.toString("utf8")) as {id?:unknown;usage?:{input_tokens?:unknown;output_tokens?:unknown;
                input_tokens_details?:{cached_tokens?:unknown;cache_write_tokens?:unknown}}};
              artifactValid=typeof input.providerResponseId==="string"&&response.id===input.providerResponseId&&
                record.inputContextRefs.includes(input.providerResponseId)&&response.usage?.input_tokens===record.inputTokens&&
                response.usage?.output_tokens===record.outputTokens&&
                (response.usage?.input_tokens_details?.cached_tokens??null)===(record.cachedInputTokens??null)&&
                (response.usage?.input_tokens_details?.cache_write_tokens??null)===(record.cacheWriteInputTokens??null);
            }catch{artifactValid=false;}}}}
      }
      const inputBound=Number(reservation.input_token_upper_bound),outputBound=Number(reservation.output_token_ceiling);
      const boundViolation=hasCompleteUsage&&(record.inputTokens!>inputBound||record.outputTokens!>outputBound||
        record.cachedInputTokens!+record.cacheWriteInputTokens!>record.inputTokens!);
      const ambiguous=!hasCompleteUsage||!artifactValid||boundViolation;
      const {cachedInputTokens:_cached,cacheWriteInputTokens:_cacheWrite,...recordWithoutCachePartitions}=record;
      // Preserve authenticated response evidence even when incomplete cache
      // partitions force full-liability accounting. Only a dispatch with no
      // durable provider response is represented as a failed unknown call.
      const persistedModelCall=ambiguous&&!responseRecorded?ModelCallRecordSchema.parse({...recordWithoutCachePartitions,
        status:"FAILED",cacheHit:null,inputTokens:null,outputTokens:null}):record;
      if(!responseRecorded)this.recordModelCall(persistedModelCall,input.reservationId);
      const slotStatus=ambiguous?"AMBIGUOUS":"COMPLETED";const now=new Date(input.nowMs).toISOString();
      const slotChange=this.db.query(`UPDATE hardening_model_call_slots SET status=?,model_call_id=?,updated_at=?
        WHERE id=? AND child_run_id=? AND status='CLAIMED'`).run(slotStatus,record.modelCallId,now,String(reservation.paid_slot_id),input.childRunId);
      if(slotChange.changes!==1)throw new HardeningReservationConflictError();
      const reservedCost=Number(reservation.reserved_cost_microusd),reservedTokens=Number(reservation.reserved_tokens);
      if(ambiguous){
        const liabilityTokens=reservedTokens,liabilityCost=reservedCost;
        const reconciliation=createHardeningBudgetReconciliation({schemaVersion:1,policyVersion:"engineer-hardening-budget-reconciliation-v1",
          childRunId:input.childRunId,reservationId:input.reservationId,reservationHash:String(reservation.reservation_hash),status:"AMBIGUOUS",
          providerResponseId:null,modelCallId:record.modelCallId,actualInputTokens:null,actualOutputTokens:null,actualCachedInputTokens:null,
          actualCacheWriteInputTokens:null,cacheObservation:"UNKNOWN",actualCostMicrousd:null,createdAt:now});
        this.db.query(`UPDATE hardening_child_model_reservations SET status='AMBIGUOUS',dispatch_status='AMBIGUOUS',model_call_id=?,provider_response_id=?,provider_response_artifact_id=?,
          cache_observation='UNKNOWN',settlement_idempotency_key=?,settlement_input_hash=?,reconciliation_id=?,reconciliation_hash=?,reconciliation_json=?,
          settled_at_ms=? WHERE id=? AND status='RESERVED' AND dispatch_status=?`).run(record.modelCallId,input.providerResponseId,input.providerResponseArtifactId,
          input.settlementIdempotencyKey,settlementInputHash,reconciliation.reconciliationId,
          reconciliation.reconciliationHash,canonicalJson(reconciliation),input.nowMs,input.reservationId,
          responseRecorded?"RESPONSE_RECORDED":"DISPATCHING");
        const changed=this.db.query(`UPDATE hardening_child_budget_authorities SET reserved_cost_microusd=reserved_cost_microusd-?,
          reserved_tokens=reserved_tokens-?,ambiguous_cost_microusd=ambiguous_cost_microusd+?,ambiguous_tokens=ambiguous_tokens+?,
          revision=revision+1,updated_at_ms=? WHERE child_run_id=? AND revision=? AND reserved_cost_microusd>=? AND reserved_tokens>=?`)
          .run(reservedCost,reservedTokens,liabilityCost,liabilityTokens,input.nowMs,input.childRunId,Number(budgetRow.revision),reservedCost,reservedTokens);
        if(changed.changes!==1)throw new HardeningReservationConflictError();
        const ambiguousRow=this.db.query("SELECT * FROM hardening_child_model_reservations WHERE id=?").get(input.reservationId) as Record<string,unknown>;
        this.hardeningBudgetReconciliationFromRow(ambiguousRow,this.hardeningBudgetReservationFromRow(ambiguousRow));
        const current=this.db.query("SELECT * FROM hardening_child_budget_authorities WHERE child_run_id=?").get(input.childRunId) as Record<string,unknown>;
        const reason=boundViolation?"MODEL_USAGE_BOUND_VIOLATION":"MODEL_USAGE_AMBIGUOUS";this.stopHardeningBudgetUnderLock(current,reason,input.nowMs);
        this.recordHardeningPaidCallFinalizationUnderLock({childRunId:input.childRunId,reservationId:input.reservationId,
          outcome:"AMBIGUOUS",reconciliation,nowMs:input.nowMs});
        return {value:{status:"AMBIGUOUS" as const,stopReason:reason}} as const;
      }
      const actualInputTokens=record.inputTokens!,actualOutputTokens=record.outputTokens!,actualCachedInputTokens=record.cachedInputTokens!,
        actualCacheWriteInputTokens=record.cacheWriteInputTokens!,actualUncachedInputTokens=actualInputTokens-actualCachedInputTokens-actualCacheWriteInputTokens;
      const actualCost=hardeningPartitionedCostFromRatesMicrousd(actualInputTokens,actualCachedInputTokens,actualCacheWriteInputTokens,
        actualOutputTokens,{uncachedInputMicrousdPerMillion:Number(reservation.uncached_input_microusd_per_million),
          cachedInputMicrousdPerMillion:Number(reservation.cached_input_microusd_per_million),
          cacheWriteInputMicrousdPerMillion:Number(reservation.cache_write_input_microusd_per_million),
          outputMicrousdPerMillion:Number(reservation.output_microusd_per_million)});
      const cacheObservation=actualCachedInputTokens>0&&actualCacheWriteInputTokens>0?"MIXED":actualCachedInputTokens>0?"HIT":
        actualCacheWriteInputTokens>0?"WRITE":"MISS";
      const reconciliation=createHardeningBudgetReconciliation({schemaVersion:1,policyVersion:"engineer-hardening-budget-reconciliation-v1",
        childRunId:input.childRunId,reservationId:input.reservationId,reservationHash:String(reservation.reservation_hash),status:"SETTLED",
        providerResponseId:input.providerResponseId,modelCallId:record.modelCallId,actualInputTokens,actualOutputTokens,actualCachedInputTokens,
        actualCacheWriteInputTokens,cacheObservation,actualCostMicrousd:actualCost,createdAt:now});
      if(!responseRecorded)throw new HardeningReservationConflictError();
      const reservationChange=this.db.query(`UPDATE hardening_child_model_reservations SET status='SETTLED',dispatch_status='SETTLED',model_call_id=?,provider_response_id=?,provider_response_artifact_id=?,
        actual_input_tokens=?,actual_uncached_input_tokens=?,actual_output_tokens=?,actual_cached_input_tokens=?,actual_cache_write_input_tokens=?,cache_observation=?,
        settled_cost_microusd=?,settlement_idempotency_key=?,settlement_input_hash=?,reconciliation_id=?,reconciliation_hash=?,reconciliation_json=?,settled_at_ms=?
        WHERE id=? AND status='RESERVED' AND dispatch_status='RESPONSE_RECORDED'`).run(record.modelCallId,input.providerResponseId,input.providerResponseArtifactId,
        actualInputTokens,actualUncachedInputTokens,actualOutputTokens,actualCachedInputTokens,actualCacheWriteInputTokens,cacheObservation,actualCost,
        input.settlementIdempotencyKey,settlementInputHash,reconciliation.reconciliationId,reconciliation.reconciliationHash,canonicalJson(reconciliation),
        input.nowMs,input.reservationId);
      if(reservationChange.changes!==1)throw new HardeningReservationConflictError();
      const settledRow=this.db.query("SELECT * FROM hardening_child_model_reservations WHERE id=?").get(input.reservationId) as Record<string,unknown>;
      this.hardeningBudgetReconciliationFromRow(settledRow,this.hardeningBudgetReservationFromRow(settledRow));
      const changed=this.db.query(`UPDATE hardening_child_budget_authorities SET reserved_cost_microusd=reserved_cost_microusd-?,
        reserved_tokens=reserved_tokens-?,used_cost_microusd=used_cost_microusd+?,used_tokens=used_tokens+?,revision=revision+1,updated_at_ms=?
        WHERE child_run_id=? AND revision=? AND reserved_cost_microusd>=? AND reserved_tokens>=?`).run(reservedCost,reservedTokens,actualCost,
        actualInputTokens+actualOutputTokens,input.nowMs,input.childRunId,Number(budgetRow.revision),reservedCost,reservedTokens);
      if(changed.changes!==1)throw new HardeningReservationConflictError();
      this.recordHardeningPaidCallFinalizationUnderLock({childRunId:input.childRunId,reservationId:input.reservationId,
        outcome:"SETTLED",reconciliation,nowMs:input.nowMs});
      return {value:{status:"SETTLED" as const,stopReason:null}} as const;
    }).immediate();
    if("error" in decision)throw decision.error;return decision.value;
  }

  async prepareOptionalHardeningStartForOwner(ownerId:string,parentRunId:string,childRunId:string,rawInput:HardeningStartRequest,
    attestor:CheckpointAttestor):Promise<OptionalHardeningStartPreparation>{
    const input=HardeningStartRequestSchema.parse(rawInput);if(!this.db.query("SELECT 1 FROM engineer_runs WHERE id=? AND user_id=?").get(childRunId,ownerId))
      throw new EngineerNotFoundError("hardening child",childRunId);
    const existingRow=this.db.query("SELECT * FROM hardening_start_operations WHERE child_run_id=?").get(childRunId) as Record<string,unknown>|null;
    const signedParent=await this.signedHardeningParent(parentRunId,attestor);this.db.exec("BEGIN IMMEDIATE");
    try{const checkpoint=this.assertSignedHardeningParent(parentRunId,signedParent);
      if(existingRow){const current=this.db.query("SELECT * FROM hardening_start_operations WHERE child_run_id=?").get(childRunId) as Record<string,unknown>|null;
        if(!current)throw new HardeningAuthorityInvalidError();const operation=this.hardeningStartOperationFromRow(current);
        if(operation.requesterUserId!==ownerId||operation.expectedChildStateVersion!==input.expectedChildStateVersion||operation.lineageId!==input.lineageId||
          operation.lineageHash!==input.lineageHash||operation.idempotencyKey!==input.idempotencyKey)throw new IdempotencyConflictError(childRunId,input.idempotencyKey);
        const preparation=this.optionalHardeningStartPreparationUnderLock(ownerId,parentRunId,childRunId,input,checkpoint,false,operation.createdAt);
        if(canonicalJson(preparation.operation)!==canonicalJson(operation))throw new HardeningAuthorityInvalidError();
        const seedRow=this.db.query("SELECT * FROM hardening_seed_attestations WHERE operation_id=? AND operation_hash=?").get(operation.operationId,operation.operationHash) as Record<string,unknown>|null;
        if(!seedRow)throw new HardeningAuthorityInvalidError();const signedSeed=this.hardeningSeedFromRow(seedRow);this.db.exec("COMMIT");
        await verifySignedHardeningSeedAttestation(signedSeed,attestor);return {...preparation,replay:true,signedSeed};}
      const preparation=this.optionalHardeningStartPreparationUnderLock(ownerId,parentRunId,childRunId,input,checkpoint,true,this.now().toISOString());
      const sibling=this.db.query(`SELECT 1 FROM engineer_run_lineage l JOIN engineer_runs r ON r.id=l.child_run_id
        WHERE l.parent_checkpoint_id=? AND l.child_run_id<>? AND r.state NOT IN (${TERMINAL_STATES.map(()=>"?").join(",")}) LIMIT 1`)
        .get(checkpoint.checkpointId,childRunId,...TERMINAL_STATES);if(sibling)throw new HardeningSelectionInvalidError();
      this.db.exec("COMMIT");return preparation;
    }catch(error){try{this.db.exec("ROLLBACK");}catch{}throw error;}
  }

  async commitOptionalHardeningStartForOwner(ownerId:string,parentRunId:string,childRunId:string,rawInput:HardeningStartRequest,
    expectedOperation:HardeningStartOperation,rawSignedSeed:SignedHardeningSeedAttestation,attestor:CheckpointAttestor,
    fence:ActiveOptionalHardeningStartFence,onCommitted:(preparation:OptionalHardeningStartPreparation)=>string):Promise<OptionalHardeningStartPreparation>{
    const input=HardeningStartRequestSchema.parse(rawInput),operation=HardeningStartOperationSchema.parse(expectedOperation);
    const signedSeed=await verifySignedHardeningSeedAttestation(rawSignedSeed,attestor);const signedParent=await this.signedHardeningParent(parentRunId,attestor);
    this.db.exec("BEGIN IMMEDIATE");try{const checkpoint=this.assertSignedHardeningParent(parentRunId,signedParent);
      const existing=this.db.query("SELECT * FROM hardening_start_operations WHERE child_run_id=?").get(childRunId) as Record<string,unknown>|null;
      if(existing){const existingClaim=this.db.query("SELECT * FROM hardening_start_claims WHERE id=? AND child_run_id=?")
          .get(fence.claimId,childRunId) as Record<string,unknown>|null;
        if(!existingClaim||this.hardeningStartFenceFromRow(existingClaim).status!=="FINALIZED")throw new HardeningStartFenceStaleError();
        this.db.exec("COMMIT");return this.prepareOptionalHardeningStartForOwner(ownerId,parentRunId,childRunId,input,attestor);}
      const preparation=this.optionalHardeningStartPreparationUnderLock(ownerId,parentRunId,childRunId,input,checkpoint,true,operation.createdAt);
      if(canonicalJson(preparation.operation)!==canonicalJson(operation))throw new HardeningAuthorityInvalidError();const seed=signedSeed.attestation;
      const claimRow=this.db.query("SELECT * FROM hardening_start_claims WHERE id=? AND child_run_id=?").get(fence.claimId,childRunId) as Record<string,unknown>|null;
      if(!claimRow)throw new HardeningStartFenceStaleError();const activeFence=this.hardeningStartFenceFromRow(claimRow);const fenceNow=this.now().toISOString();
      if(activeFence.status!=="PREPARING"||activeFence.fenceToken!==fence.fenceToken||activeFence.generation!==fence.generation||
        activeFence.leaseExpiresAt<fenceNow||claimRow.intended_operation_id!==operation.operationId||claimRow.intended_operation_hash!==operation.operationHash)
        throw new HardeningStartFenceStaleError();
      if(seed.operationId!==operation.operationId||seed.operationHash!==operation.operationHash||seed.rootRunId!==preparation.lineage.rootRunId||
        seed.parentRunId!==parentRunId||seed.childRunId!==childRunId||seed.requesterUserId!==ownerId||seed.repositoryId!==preparation.lineage.repositoryId||
        seed.lineageId!==preparation.lineage.lineageId||seed.lineageHash!==preparation.lineage.lineageHash||
        seed.parentCheckpointId!==checkpoint.checkpointId||seed.parentCheckpointHash!==checkpoint.checkpointHash||
        seed.baseCommitSha!==checkpoint.baseCommitSha||seed.seedResultCommitSha!==checkpoint.resultCommitSha||seed.seedDiffHash!==checkpoint.diffHash||
        seed.environmentDigest!==checkpoint.environmentDigest||seed.createdAt!==operation.createdAt)throw new HardeningAuthorityInvalidError();
      this.db.query(`INSERT INTO hardening_start_operations(id,operation_hash,schema_version,policy_version,requester_user_id,child_run_id,
        expected_child_state_version,lineage_id,lineage_hash,idempotency_key,operation_json,created_at) VALUES(?,?,1,?,?,?,?,?,?,?,?,?)`).run(
        operation.operationId,operation.operationHash,operation.policyVersion,operation.requesterUserId,operation.childRunId,
        operation.expectedChildStateVersion,operation.lineageId,operation.lineageHash,operation.idempotencyKey,canonicalJson(operation),operation.createdAt);
      this.db.query(`INSERT INTO hardening_seed_attestations(id,seed_attestation_hash,schema_version,policy_version,attestation_type,operation_id,
        operation_hash,root_run_id,parent_run_id,child_run_id,requester_user_id,repository_id,lineage_id,lineage_hash,parent_checkpoint_id,
        parent_checkpoint_hash,base_commit_sha,seed_result_commit_sha,seed_tree_hash,seed_diff_hash,image_digest,environment_digest,dependency_hash,
        attestation_json,statement_json,statement_hash,signature_algorithm,signature_key_id,signature,created_at)
        VALUES(?,?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(seed.seedAttestationId,seed.seedAttestationHash,seed.policyVersion,
        seed.attestationType,seed.operationId,seed.operationHash,seed.rootRunId,seed.parentRunId,seed.childRunId,seed.requesterUserId,seed.repositoryId,
        seed.lineageId,seed.lineageHash,seed.parentCheckpointId,seed.parentCheckpointHash,seed.baseCommitSha,seed.seedResultCommitSha,seed.seedTreeHash,
        seed.seedDiffHash,seed.imageDigest,seed.environmentDigest,seed.dependencyHash,canonicalJson(seed),signedSeed.statementJson,signedSeed.statementHash,
        signedSeed.algorithm,signedSeed.keyId,signedSeed.signature,seed.createdAt);
      const advisories=this.assertDeterministicQuoteAuthority(this.hardeningQuoteFromRow(this.db.query("SELECT * FROM hardening_quotes WHERE id=?")
        .get(preparation.lineage.quoteId) as Record<string,unknown>),checkpoint,true);
      const insertAdvisoryEvent=(event:AdvisoryBacklogEvent)=>this.db.query(`INSERT INTO advisory_backlog_events(id,event_hash,schema_version,policy_version,
        advisory_id,parent_run_id,parent_checkpoint_id,parent_checkpoint_hash,event_type,revision,expected_revision,actor_type,actor_id,operation_id,
        idempotency_key,quote_id,consent_id,hardening_lineage_id,child_run_id,child_checkpoint_id,child_checkpoint_hash,stop_reason,rationale,event_json,created_at)
        VALUES(?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(event.eventId,event.eventHash,event.policyVersion,
        event.advisoryId,event.parentRunId,event.parentCheckpointId,event.parentCheckpointHash,event.eventType,event.revision,event.expectedRevision,event.actorType,
        event.actorId,event.operationId,event.idempotencyKey,event.quoteId,event.consentId,event.hardeningLineageId,event.childRunId,event.childCheckpointId,
        event.childCheckpointHash,event.stopReason,event.rationale,canonicalJson(event),event.createdAt);
      for(const item of advisories){let latest=this.advisoryLifecycle(item).at(-1),expectedRevision=latest?.revision??0;
        if(latest?.eventType!=="SELECTED"){const selected=createAdvisoryBacklogEvent({schemaVersion:1,policyVersion:"engineer-advisory-backlog-v1",
          advisoryId:item.advisoryId,parentRunId,parentCheckpointId:checkpoint.checkpointId,parentCheckpointHash:checkpoint.checkpointHash,eventType:"SELECTED",
          revision:expectedRevision+1,expectedRevision,actorType:"SYSTEM",actorId:"engineer-supervisor",operationId:operation.operationId,
          idempotencyKey:`hardening-selected:${operation.operationId}:${item.advisoryId}`,quoteId:preparation.lineage.quoteId,consentId:null,
          hardeningLineageId:null,childRunId:null,childCheckpointId:null,childCheckpointHash:null,stopReason:null,rationale:null,createdAt:operation.createdAt});
          insertAdvisoryEvent(selected);latest=selected;expectedRevision=selected.revision;}
        const event=createAdvisoryBacklogEvent({schemaVersion:1,policyVersion:"engineer-advisory-backlog-v1",advisoryId:item.advisoryId,
          parentRunId,parentCheckpointId:checkpoint.checkpointId,parentCheckpointHash:checkpoint.checkpointHash,eventType:"HARDENING_STARTED",
          revision:expectedRevision+1,expectedRevision,actorType:"SYSTEM",actorId:"engineer-supervisor",operationId:operation.operationId,
          idempotencyKey:`hardening-start:${operation.operationId}:${item.advisoryId}`,quoteId:preparation.lineage.quoteId,
          consentId:preparation.lineage.consentId,hardeningLineageId:preparation.lineage.lineageId,childRunId,childCheckpointId:null,
          childCheckpointHash:null,stopReason:null,rationale:null,createdAt:operation.createdAt});
        insertAdvisoryEvent(event);}
      const result={...preparation,signedSeed};const sandboxId=onCommitted(result);
      const finalizedAt=this.now().toISOString();const finalizedChange=this.db.query(`UPDATE hardening_start_claims SET status='FINALIZED',
        finalized_operation_id=?,finalized_operation_hash=?,seed_attestation_id=?,seed_attestation_hash=?,sandbox_id=?,updated_at=?
        WHERE id=? AND child_run_id=? AND status='PREPARING' AND fence_token=? AND generation=? AND lease_expires_at>=?
        AND intended_operation_id=? AND intended_operation_hash=?`).run(operation.operationId,operation.operationHash,seed.seedAttestationId,
          seed.seedAttestationHash,sandboxId,finalizedAt,fence.claimId,childRunId,fence.fenceToken,fence.generation,finalizedAt,
          operation.operationId,operation.operationHash);
      if(finalizedChange.changes!==1)throw new HardeningStartFenceStaleError();
      const finalizedRow=this.db.query("SELECT * FROM hardening_start_claims WHERE id=? AND child_run_id=?").get(fence.claimId,childRunId) as Record<string,unknown>|null;
      if(!finalizedRow)throw new HardeningStartFenceStaleError();const finalized=this.hardeningStartFenceFromRow(finalizedRow);
      if(finalized.status!=="FINALIZED"||finalized.fenceToken!==fence.fenceToken||finalized.generation!==fence.generation||
        finalized.finalizedOperationId!==operation.operationId||finalized.finalizedOperationHash!==operation.operationHash||
        finalized.seedAttestationId!==seed.seedAttestationId||finalized.seedAttestationHash!==seed.seedAttestationHash||!finalized.sandboxId)
        throw new HardeningStartFenceStaleError();
      this.initializeHardeningChildBudgetUnderLock(result,Date.parse(finalizedAt));
      this.db.exec("COMMIT");return result;
    }catch(error){try{this.db.exec("ROLLBACK");}catch{}throw error;}
  }

  async getVerifiedHardeningCandidateCheckpoint(reference:{runId:string}|{checkpointId:string},attestor:CheckpointAttestor,
    readArtifact?:ArtifactByteReader):Promise<{
    checkpoint:VerifiedHardeningCandidateCheckpoint;attestation:SignedVerifiedHardeningCandidateAttestation;
  }|null>{
    const strictReader=readArtifact??this.hardeningArtifactReader;
    if(!strictReader)throw new HardeningAuthorityInvalidError();
    let checkpointId="checkpointId" in reference?reference.checkpointId:null;let promotedRunId:string|null=null;
    if("runId" in reference){const events=this.db.query(`SELECT * FROM run_state_events WHERE run_id=?
      AND reason_code='HARDENING_CANDIDATE_VERIFIED' AND next_state='HUMAN_REVIEW_REQUIRED'`).all(reference.runId) as EventRow[];
      if(events.length===0)return null;if(events.length!==1)throw new Error("verified hardening candidate transition authority is ambiguous");
      const event=rowToEvent(events[0]!);if(event.evidenceIds.length!==1||event.previousState!=="REVIEWING"||event.actorType!=="SUPERVISOR"||
        event.actorId!=="engineer-supervisor")throw new Error("verified hardening candidate transition authority is malformed");
      checkpointId=event.evidenceIds[0]!;promotedRunId=reference.runId;}
    const row=this.db.query("SELECT * FROM verified_candidate_checkpoints WHERE id=?").get(checkpointId) as Record<string,unknown>|null;
    if(!row){if(promotedRunId)throw new VerifiedCandidateIntegrityError(promotedRunId);return null;}
    const checkpointJson=String(row.checkpoint_json);const checkpoint=VerifiedHardeningCandidateCheckpointSchema.parse(JSON.parse(checkpointJson));
    if(checkpointJson!==canonicalJson(checkpoint)||row.id!==checkpoint.checkpointId||row.checkpoint_hash!==checkpoint.checkpointHash||
      row.parent_checkpoint_id!==checkpoint.parentCheckpointId||row.parent_checkpoint_hash!==checkpoint.parentCheckpointHash||
      row.hardening_lineage_id!==checkpoint.hardeningLineageId||row.hardening_lineage_hash!==checkpoint.hardeningLineageHash||
      row.seed_attestation_id!==checkpoint.seedAttestationId||row.seed_attestation_hash!==checkpoint.seedAttestationHash||
      row.run_id!==checkpoint.runId||row.requester_user_id!==checkpoint.requesterUserId||row.repository_id!==checkpoint.repositoryId||
      row.required_lane_contract_hash!==checkpoint.requiredLaneContractHash||row.manifest_hash!==checkpoint.manifestHash||
      row.base_commit_sha!==checkpoint.baseCommitSha||row.result_commit_sha!==checkpoint.resultCommitSha||row.diff_hash!==checkpoint.diffHash||
      row.reviewer_session_id!==checkpoint.reviewerSessionId||row.classification_hash!==checkpoint.classificationHash||
      row.classification_result!==checkpoint.classificationResult||row.evidence_bundle_id!==checkpoint.evidenceBundleId||
      row.evidence_bundle_hash!==checkpoint.evidenceBundleHash||row.environment_digest!==checkpoint.environmentDigest||row.created_at!==checkpoint.createdAt)
      throw new Error("persisted verified hardening candidate columns do not match canonical checkpoint JSON");
    const attestation=SignedVerifiedHardeningCandidateAttestationSchema.parse({statement:JSON.parse(String(row.statement_json)),
      statementJson:row.statement_json,statementHash:row.statement_hash,algorithm:row.signature_algorithm,keyId:row.signature_key_id,signature:row.signature});
    await verifySignedVerifiedHardeningCandidateAttestation(attestation,attestor);
    if(canonicalJson(attestation.statement.predicate)!==canonicalJson(checkpoint))
      throw new Error("persisted verified hardening candidate statement does not bind the checkpoint");
    const authority=await this.hardeningPromotionAuthority(checkpoint.runId,attestor,strictReader);
    const expected=this.verifiedHardeningCandidateContent({runId:checkpoint.runId,reviewerSessionId:checkpoint.reviewerSessionId,
      classificationHash:checkpoint.classificationHash,evidenceBundleId:checkpoint.evidenceBundleId,attestor},authority,checkpoint,
      strictReader);
    const {checkpointId:_id,checkpointHash:_hash,...content}=checkpoint;
    if(canonicalJson(expected)!==canonicalJson(content))throw new Error("persisted verified hardening candidate no longer matches durable authority records");
    const run=this.getRun(checkpoint.runId);const events=(this.db.query("SELECT * FROM run_state_events WHERE run_id=? ORDER BY sequence")
      .all(checkpoint.runId) as EventRow[]).map(rowToEvent);const promotion=events.filter((event)=>event.reasonCode==="HARDENING_CANDIDATE_VERIFIED"||
        event.eventId===checkpoint.checkpointId);const event=promotion.length===1?promotion[0]:null;const index=event?events.indexOf(event):-1;
    const predecessor=index>0?events[index-1]:null;
    for(const [eventIndex,candidate] of events.entries()){const expected=eventIndex+1;
      const previous=eventIndex===0?"REQUEST_RECEIVED":events[eventIndex-1]!.nextState;
      if(candidate.runId!==checkpoint.runId||candidate.sequence!==expected||candidate.stateVersion!==expected||candidate.previousState!==previous)
        throw new Error("verified hardening candidate transition authority event chain is discontinuous");}
    if(events.length!==run.stateVersion||!event||!predecessor||predecessor.eventId!==checkpoint.prePromotionEventChainSummary.headEventId||
      predecessor.sequence!==checkpoint.prePromotionEventChainSummary.headSequence||predecessor.stateVersion!==checkpoint.prePromotionEventChainSummary.headStateVersion||
      event.sequence!==predecessor.sequence+1||event.stateVersion!==predecessor.stateVersion+1||event.previousState!=="REVIEWING"||
      event.nextState!=="HUMAN_REVIEW_REQUIRED"||event.reasonCode!=="HARDENING_CANDIDATE_VERIFIED"||event.actorType!=="SUPERVISOR"||
      event.actorId!=="engineer-supervisor"||event.manifestHash!==checkpoint.manifestHash||event.timestamp!==checkpoint.createdAt||
      event.idempotencyKey!==`verified-hardening-candidate:${checkpoint.checkpointId}`||canonicalJson(event.evidenceIds)!==canonicalJson([checkpoint.checkpointId]))
      throw new Error("verified hardening candidate checkpoint lacks one exact transition authority event");
    const verifiedEvents=this.db.query(`SELECT event_json FROM advisory_backlog_events WHERE child_run_id=? AND event_type='HARDENING_VERIFIED'
      ORDER BY advisory_id`).all(checkpoint.runId) as Array<{event_json:string}>;
    if(verifiedEvents.length<1)throw new Error("verified hardening candidate lacks advisory completion authority");
    for(const value of verifiedEvents){const advisory=AdvisoryBacklogEventSchema.parse(JSON.parse(value.event_json));
      if(advisory.childCheckpointId!==checkpoint.checkpointId||advisory.childCheckpointHash!==checkpoint.checkpointHash||
        advisory.hardeningLineageId!==checkpoint.hardeningLineageId)throw new Error("verified hardening advisory authority mismatch");}
    return {checkpoint,attestation};
  }

  verifiedHardeningCheckpointRunId(reference:{runId:string}|{checkpointId:string}):string|null{
    if("runId" in reference)return reference.runId;
    const row=this.db.query("SELECT run_id FROM verified_candidate_checkpoints WHERE id=? AND parent_checkpoint_hash IS NOT NULL")
      .get(reference.checkpointId) as {run_id:string}|null;
    return row?.run_id??null;
  }

  async getVerifiedCandidateCheckpoint(
    reference: { runId: string } | { checkpointId: string },
    attestor: CheckpointAttestor,
    requireEvent = true,
    readArtifact?:ArtifactByteReader,
  ): Promise<{ checkpoint: VerifiedCandidateCheckpoint; attestation: SignedVerifiedCandidateAttestation } | null> {
    let checkpointId: string | null = "checkpointId" in reference ? reference.checkpointId : null;
    let promotedRunId: string | null = null;
    if ("runId" in reference) {
      const events = this.db.query(`SELECT * FROM run_state_events WHERE run_id = ?
        AND reason_code = 'VERIFIED_CANDIDATE_PROMOTED' AND next_state = 'REVIEW_APPROVED'`).all(reference.runId) as EventRow[];
      if (events.length === 0) return null;
      if (events.length !== 1) throw new Error("verified candidate transition authority is ambiguous");
      const event = rowToEvent(events[0]!);
      if (event.evidenceIds.length !== 1 || event.previousState !== "REVIEWING" ||
          event.actorType !== "SUPERVISOR" || event.actorId !== "engineer-supervisor") {
        throw new Error("verified candidate transition authority is malformed");
      }
      checkpointId = event.evidenceIds[0]!;
      promotedRunId = reference.runId;
    }
    const row = this.db.query("SELECT * FROM verified_candidate_checkpoints WHERE id = ?")
      .get(checkpointId) as Record<string, unknown> | null;
    if (!row) {
      if (promotedRunId) throw new VerifiedCandidateIntegrityError(promotedRunId);
      return null;
    }
    const checkpointJson = String(row.checkpoint_json);
    const checkpoint = VerifiedCandidateCheckpointSchema.parse(JSON.parse(checkpointJson));
    if (checkpointJson !== canonicalJson(checkpoint) || row.id !== checkpoint.checkpointId || row.checkpoint_hash !== checkpoint.checkpointHash ||
        row.parent_checkpoint_id !== checkpoint.parentCheckpointId || row.run_id !== checkpoint.runId ||
        row.requester_user_id !== checkpoint.requesterUserId || row.repository_id !== checkpoint.repositoryId ||
        row.required_lane_contract_hash !== checkpoint.requiredLaneContractHash || row.manifest_hash !== checkpoint.manifestHash ||
        row.base_commit_sha !== checkpoint.baseCommitSha || row.result_commit_sha !== checkpoint.resultCommitSha ||
        row.diff_hash !== checkpoint.diffHash || row.reviewer_session_id !== checkpoint.reviewerSessionId ||
        row.classification_hash !== checkpoint.classificationHash || row.classification_result !== checkpoint.classificationResult ||
        row.evidence_bundle_id !== checkpoint.evidenceBundleId || row.evidence_bundle_hash !== checkpoint.evidenceBundleHash ||
        row.environment_digest !== checkpoint.environmentDigest || row.created_at !== checkpoint.createdAt) {
      throw new Error("persisted verified candidate columns do not match canonical checkpoint JSON");
    }
    const statement = JSON.parse(String(row.statement_json));
    const attestation = SignedVerifiedCandidateAttestationSchema.parse({
      statement, statementJson: row.statement_json, statementHash: row.statement_hash,
      algorithm: row.signature_algorithm, keyId: row.signature_key_id, signature: row.signature,
    });
    await verifySignedVerifiedCandidateAttestation(attestation, attestor);
    if (canonicalJson(attestation.statement.predicate) !== canonicalJson(checkpoint)) {
      throw new Error("persisted verified candidate statement does not bind the checkpoint");
    }
    const expected = this.verifiedCandidateContent({
      runId: checkpoint.runId, reviewerSessionId: checkpoint.reviewerSessionId,
      classificationHash: checkpoint.classificationHash, evidenceBundleId: checkpoint.evidenceBundleId,
    }, checkpoint,readArtifact);
    const { checkpointId: _id, checkpointHash: _hash, ...content } = checkpoint;
    if (canonicalJson(expected) !== canonicalJson(content)) {
      throw new Error("persisted verified candidate no longer matches durable authority records");
    }
    if (requireEvent) {
      this.assertVerifiedCandidateEventChain(checkpoint);
    }
    return { checkpoint, attestation };
  }

  private assertVerifiedCandidateEventChain(checkpoint: VerifiedCandidateCheckpoint): RunStateEvent {
    const run = this.getRun(checkpoint.runId);
    const events = (this.db.query("SELECT * FROM run_state_events WHERE run_id = ? ORDER BY sequence")
      .all(checkpoint.runId) as EventRow[]).map(rowToEvent);
    if (events.length !== run.stateVersion || events.length === 0) {
      throw new Error("verified candidate transition authority has an incomplete event chain");
    }
    for (const [index, event] of events.entries()) {
      const expectedVersion = index + 1;
      const expectedPrevious = index === 0 ? "REQUEST_RECEIVED" : events[index - 1]!.nextState;
      if (event.runId !== checkpoint.runId || event.sequence !== expectedVersion ||
          event.stateVersion !== expectedVersion || event.previousState !== expectedPrevious) {
        throw new Error("verified candidate transition authority event chain is discontinuous");
      }
    }
    if (events.at(-1)!.nextState !== run.state) {
      throw new Error("verified candidate transition authority does not match the durable run head");
    }
    const promotions = events.filter((event) => event.reasonCode === "VERIFIED_CANDIDATE_PROMOTED" ||
      event.nextState === "REVIEW_APPROVED" || event.eventId === checkpoint.checkpointId);
    const event = promotions.length === 1 ? promotions[0]! : null;
    const promotionIndex = event ? events.indexOf(event) : -1;
    const predecessor = promotionIndex > 0 ? events[promotionIndex - 1]! : null;
    if (!event || !predecessor || predecessor.sequence !== event.sequence - 1 ||
        predecessor.stateVersion !== event.stateVersion - 1 || predecessor.nextState !== "REVIEWING" ||
        predecessor.eventId !== checkpoint.prePromotionEventChainSummary.headEventId ||
        predecessor.sequence !== checkpoint.prePromotionEventChainSummary.headSequence ||
        predecessor.stateVersion !== checkpoint.prePromotionEventChainSummary.headStateVersion ||
        event.sequence !== checkpoint.prePromotionEventChainSummary.headSequence + 1 ||
        event.stateVersion !== checkpoint.prePromotionEventChainSummary.headStateVersion + 1 ||
        event.eventId !== checkpoint.checkpointId || event.runId !== checkpoint.runId ||
        event.previousState !== "REVIEWING" || event.nextState !== "REVIEW_APPROVED" ||
        event.reasonCode !== "VERIFIED_CANDIDATE_PROMOTED" ||
        event.actorType !== "SUPERVISOR" || event.actorId !== "engineer-supervisor" ||
        event.manifestHash !== checkpoint.manifestHash || event.timestamp !== checkpoint.createdAt ||
        event.idempotencyKey !== `verified-candidate:${checkpoint.checkpointId}` ||
        canonicalJson(event.evidenceIds) !== canonicalJson([checkpoint.checkpointId])) {
      throw new Error("verified candidate checkpoint lacks one exact transition authority event");
    }
    return event;
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

  async recordApprovalRequest(record: NewApprovalRequestRecord, attestor: CheckpointAttestor): Promise<NewApprovalRequestRecord> {
    const parsed = ApprovalRequestRecordSchema.parse(record);
    this.getRun(parsed.runId);
    // P7 fail-closed gate: a replacement run may never receive a human-approval
    // request (the approval-authority grant) unless its complete lineage verifies.
    // A decision cannot exist without a request, so gating the request closes the
    // whole approval path for an unverified replacement.
    this.assertReplacementLineageAuthority(parsed.runId);
    if (!parsed.reviewerSessionId || !parsed.classificationHash || !parsed.classificationResult) {
      throw new Error("new approval requests require classified Reviewer authority");
    }
    const authority = await this.getVerifiedCandidateCheckpoint({ checkpointId: parsed.verifiedCheckpointId }, attestor);
    if (!authority || authority.checkpoint.checkpointHash !== parsed.verifiedCheckpointHash) {
      throw new Error("approval request verified checkpoint authority does not match");
    }
    const checkpoint = authority.checkpoint;
    if (checkpoint.runId !== parsed.runId || checkpoint.manifestHash !== parsed.manifestHash ||
        checkpoint.diffHash !== parsed.diffHash || checkpoint.evidenceBundleHash !== parsed.evidenceBundleHash ||
        checkpoint.reviewerSessionId !== parsed.reviewerSessionId || checkpoint.classificationHash !== parsed.classificationHash ||
        checkpoint.classificationResult !== parsed.classificationResult) {
      throw new Error("approval request tuple does not match verified checkpoint authority");
    }
    return this.db.transaction(() => {
      const existing = this.db.query("SELECT * FROM approval_requests WHERE id = ?").get(parsed.approvalRequestId) as Record<string, unknown> | null;
      if (existing) {
        const current = ApprovalRequestRecordSchema.parse(this.approvalRequestFromRow(existing));
        if (sha256(current) !== sha256(parsed)) {
          throw new IdempotencyConflictError(parsed.runId, `approval-request:${parsed.approvalRequestId}`);
        }
        return current;
      }
      const run = this.getRun(parsed.runId);
      if (run.state !== "REVIEW_APPROVED") {
        throw new Error("approval request authority is stale because the run is no longer REVIEW_APPROVED");
      }
      this.db.query(`INSERT INTO approval_requests
        (id, run_id, risk_tier, assigned_reviewer_id, requested_at, deadline_at,
         reminder_schedule_json, timeout_action, manifest_hash, diff_hash, evidence_bundle_hash,
         reviewer_session_id, classification_hash, classification_result, status,
         verified_checkpoint_id, verified_checkpoint_hash, approval_revision)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        parsed.approvalRequestId, parsed.runId, parsed.riskTier, parsed.assignedReviewerId,
        parsed.requestedAt, parsed.deadlineAt, canonicalJson(parsed.reminderSchedule), parsed.timeoutAction,
        parsed.manifestHash, parsed.diffHash, parsed.evidenceBundleHash, parsed.reviewerSessionId!,
        parsed.classificationHash!, parsed.classificationResult!, parsed.status,
        parsed.verifiedCheckpointId, parsed.verifiedCheckpointHash, parsed.approvalRevision,
      );
      this.insertAudit(parsed.runId, "HUMAN_APPROVAL_REQUESTED", "SUPERVISOR", "engineer-supervisor", {
        approvalRequestId: parsed.approvalRequestId, riskTier: parsed.riskTier,
        deadlineAt: parsed.deadlineAt, manifestHash: parsed.manifestHash,
        diffHash: parsed.diffHash, evidenceBundleHash: parsed.evidenceBundleHash,
        verifiedCheckpointId: parsed.verifiedCheckpointId, verifiedCheckpointHash: parsed.verifiedCheckpointHash,
      }, parsed.requestedAt);
      return parsed;
    })();
  }

  latestApprovalRequest(runId: string): ApprovalRequestRecord | null {
    this.getRun(runId);
    const row = this.db.query("SELECT * FROM approval_requests WHERE run_id = ? ORDER BY requested_at DESC, rowid DESC LIMIT 1")
      .get(runId) as Record<string, unknown> | null;
    return row ? this.approvalRequestFromRow(row) : null;
  }

  listApprovalDecisions(approvalRequestId: string): ApprovalDecisionRecord[] {
    this.latestApprovalRequestById(approvalRequestId);
    const rows = this.db.query(`SELECT * FROM approval_decisions
      WHERE approval_request_id = ? ORDER BY rowid`).all(approvalRequestId) as Array<Record<string, unknown>>;
    return rows.map((row) => ApprovalDecisionReadRecordSchema.parse({
      approvalDecisionId: row.id,
      approvalRequestId: row.approval_request_id,
      actorId: row.actor_id,
      decision: row.decision,
      reason: row.reason,
      decidedAt: row.decided_at,
      expectedVerifiedCheckpointId: row.expected_verified_checkpoint_id ?? null,
      expectedVerifiedCheckpointHash: row.expected_verified_checkpoint_hash ?? null,
      expectedApprovalRevision: row.expected_approval_revision ?? null,
    }));
  }

  decideApproval(
    record: NewApprovalDecisionRecord,
    requestStatus: ApprovalRequestRecord["status"],
    now: string,
    provenanceContext?: ProvenanceEmissionContext,
  ): NewApprovalDecisionRecord {
    const parsed = ApprovalDecisionRecordSchema.parse(record);
    const validStatus = (parsed.decision === "APPROVE" && requestStatus === "APPROVED") ||
      (parsed.decision === "REQUEST_CHANGES" && requestStatus === "CHANGES_REQUESTED") ||
      (parsed.decision === "REJECT" && (requestStatus === "REJECTED" || requestStatus === "EXPIRED"));
    if (!validStatus) throw new TypeError(`decision ${parsed.decision} cannot produce approval status ${requestStatus}`);
    const transact = this.db.transaction(() => {
      const request = this.latestApprovalRequestById(parsed.approvalRequestId);
      const existing = this.db.query("SELECT * FROM approval_decisions WHERE id = ?").get(parsed.approvalDecisionId) as Record<string, unknown> | null;
      if (existing) {
        const current = ApprovalDecisionRecordSchema.parse({
          approvalDecisionId: existing.id, approvalRequestId: existing.approval_request_id,
          actorId: existing.actor_id, decision: existing.decision, reason: existing.reason, decidedAt: existing.decided_at,
          expectedVerifiedCheckpointId: existing.expected_verified_checkpoint_id,
          expectedVerifiedCheckpointHash: existing.expected_verified_checkpoint_hash,
          expectedApprovalRevision: existing.expected_approval_revision,
        });
        if (sha256(current) !== sha256(parsed)) {
          throw new IdempotencyConflictError(request.runId, `approval-decision:${parsed.approvalDecisionId}`);
        }
        if (request.status !== requestStatus || request.approvalRevision !== parsed.expectedApprovalRevision + 1) {
          throw new IdempotencyConflictError(request.runId, `approval-outcome:${parsed.approvalDecisionId}`);
        }
        return current;
      }
      this.assertApprovalDecisionAuthority(request, parsed);
      const nowMs = Date.parse(now);
      const deadlineMs = Date.parse(request.deadlineAt);
      if (!Number.isFinite(nowMs) || !Number.isFinite(deadlineMs) ||
          (requestStatus === "EXPIRED" ? nowMs <= deadlineMs : nowMs > deadlineMs)) {
        throw new IdempotencyConflictError(request.runId, `approval-deadline:${parsed.approvalRequestId}`);
      }
      this.db.query(`INSERT INTO approval_decisions
        (id, approval_request_id, actor_id, decision, reason, decided_at,
         expected_verified_checkpoint_id, expected_verified_checkpoint_hash, expected_approval_revision)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        parsed.approvalDecisionId, parsed.approvalRequestId, parsed.actorId, parsed.decision, parsed.reason, parsed.decidedAt,
        parsed.expectedVerifiedCheckpointId, parsed.expectedVerifiedCheckpointHash, parsed.expectedApprovalRevision,
      );
      const updated = this.db.query(`UPDATE approval_requests SET status = ?, approval_revision = approval_revision + 1
        WHERE id = ? AND status = 'PENDING' AND verified_checkpoint_id = ? AND verified_checkpoint_hash = ?
          AND approval_revision = ?`).run(
        requestStatus, parsed.approvalRequestId, parsed.expectedVerifiedCheckpointId, parsed.expectedVerifiedCheckpointHash,
        parsed.expectedApprovalRevision,
      );
      if (Number(updated.changes) !== 1) throw new IdempotencyConflictError(request.runId, `approval:${parsed.approvalRequestId}`);
      this.insertAudit(request.runId, `HUMAN_${parsed.decision}`, "HUMAN", parsed.actorId, {
        approvalRequestId: parsed.approvalRequestId, approvalDecisionId: parsed.approvalDecisionId, reason: parsed.reason,
        verifiedCheckpointId: parsed.expectedVerifiedCheckpointId,
      }, parsed.decidedAt);
      // P11: on a durable APPROVE bound to a distinct human approver
      // (parsed.actorId, enforced != requester by the predicate schema) and its
      // exact verified-candidate subject, atomically emit + persist the signed
      // provenance attestation IN THIS SAME TRANSACTION. Any failure here (missing
      // seam, bad subject, signer error) throws and rolls back the approval too —
      // an approval and its required attestation commit together or not at all.
      if (parsed.decision === "APPROVE" && this.provenanceSigner) {
        this.persistPromotionAttestation(parsed, provenanceContext);
      }
      return parsed;
    });
    return transact();
  }

  /**
   * Emit + persist the P11 provenance attestation for an APPROVED verified
   * candidate. Runs only inside decideApproval's transaction (its writes are part
   * of that atomic unit). Fail closed: when the signer is configured, the
   * resultTreeHash seam MUST be supplied, and the subject checkpoint MUST exist —
   * otherwise this throws and the surrounding approval rolls back. resultTreeHash
   * and publicationReceipt remain caller-supplied SEAMS (not durably recorded for
   * the verified candidate); approverUserId is now REAL (the approval's actorId).
   */
  private persistPromotionAttestation(
    parsed: NewApprovalDecisionRecord,
    provenanceContext: ProvenanceEmissionContext | undefined,
  ): void {
    const signer = this.provenanceSigner!;
    if (!parsed.expectedVerifiedCheckpointId || !parsed.expectedVerifiedCheckpointHash) {
      throw new Error("provenance attestation requires a verified-candidate subject on the approval");
    }
    if (!provenanceContext?.resultTreeHash) {
      throw new Error("provenance attestation is required but the resultTreeHash seam was not supplied");
    }
    const checkpointRow = this.db
      .query("SELECT org_id FROM verified_candidate_checkpoints WHERE id=? AND checkpoint_hash=?")
      .get(parsed.expectedVerifiedCheckpointId, parsed.expectedVerifiedCheckpointHash) as { org_id: string } | null;
    if (!checkpointRow) {
      throw new EngineerNotFoundError("verified candidate checkpoint", parsed.expectedVerifiedCheckpointId);
    }
    const emitted = emitPromotionProvenanceAttestationSync(
      this.db,
      parsed.expectedVerifiedCheckpointId,
      {
        approverUserId: parsed.actorId,
        resultTreeHash: provenanceContext.resultTreeHash,
        createdAt: parsed.decidedAt,
        publicationReceipt: provenanceContext.publicationReceipt ?? null,
      },
      signer,
    );
    this.db.query(`INSERT INTO provenance_attestations
      (statement_hash, org_id, subject_checkpoint_id, subject_checkpoint_hash, approval_decision_id,
       approver_actor_id, signature_key_id, signature_algorithm, payload_type, envelope_json, statement_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      emitted.statementHash, checkpointRow.org_id, parsed.expectedVerifiedCheckpointId,
      parsed.expectedVerifiedCheckpointHash, parsed.approvalDecisionId, parsed.actorId,
      signer.keyId, signer.algorithm, DSSE_PAYLOAD_TYPE,
      canonicalJson(emitted.envelope), emitted.statementJson, parsed.decidedAt,
    );
  }

  extendApproval(record: NewApprovalDecisionRecord, deadlineAt: string, reminders: string[], now: string): ApprovalRequestRecord {
    const parsed = ApprovalDecisionRecordSchema.parse(record);
    if (parsed.decision !== "EXTEND") throw new TypeError("approval extension requires EXTEND decision");
    return this.db.transaction(() => {
      const request = this.latestApprovalRequestById(parsed.approvalRequestId);
      const existing = this.db.query("SELECT * FROM approval_decisions WHERE id = ?").get(parsed.approvalDecisionId) as Record<string, unknown> | null;
      if (existing) {
        const current = ApprovalDecisionRecordSchema.parse({
          approvalDecisionId: existing.id, approvalRequestId: existing.approval_request_id,
          actorId: existing.actor_id, decision: existing.decision, reason: existing.reason, decidedAt: existing.decided_at,
          expectedVerifiedCheckpointId: existing.expected_verified_checkpoint_id,
          expectedVerifiedCheckpointHash: existing.expected_verified_checkpoint_hash,
          expectedApprovalRevision: existing.expected_approval_revision,
        });
        if (sha256(current) !== sha256(parsed)) {
          throw new IdempotencyConflictError(request.runId, `approval-decision:${parsed.approvalDecisionId}`);
        }
        if (request.approvalRevision !== parsed.expectedApprovalRevision + 1 ||
            request.deadlineAt !== deadlineAt || canonicalJson(request.reminderSchedule) !== canonicalJson(reminders)) {
          throw new IdempotencyConflictError(request.runId, `approval-extension:${parsed.approvalDecisionId}`);
        }
        return request;
      }
      const priorExtension = this.db.query(`SELECT id FROM approval_decisions
        WHERE approval_request_id = ? AND decision = 'EXTEND' LIMIT 1`).get(parsed.approvalRequestId) as { id: string } | null;
      if (priorExtension) {
        throw new IdempotencyConflictError(request.runId, `approval-extension:${parsed.approvalRequestId}`);
      }
      this.assertApprovalDecisionAuthority(request, parsed);
      const nowMs = Date.parse(now);
      const currentDeadlineMs = Date.parse(request.deadlineAt);
      const nextDeadlineMs = Date.parse(deadlineAt);
      if (!Number.isFinite(nowMs) || !Number.isFinite(currentDeadlineMs) || !Number.isFinite(nextDeadlineMs) ||
          nowMs > currentDeadlineMs || nextDeadlineMs <= currentDeadlineMs) {
        throw new IdempotencyConflictError(request.runId, `approval-extension-deadline:${parsed.approvalRequestId}`);
      }
      this.db.query(`INSERT INTO approval_decisions
        (id, approval_request_id, actor_id, decision, reason, decided_at,
         expected_verified_checkpoint_id, expected_verified_checkpoint_hash, expected_approval_revision)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        parsed.approvalDecisionId, parsed.approvalRequestId, parsed.actorId, parsed.decision, parsed.reason, parsed.decidedAt,
        parsed.expectedVerifiedCheckpointId, parsed.expectedVerifiedCheckpointHash, parsed.expectedApprovalRevision,
      );
      const updated = this.db.query(`UPDATE approval_requests SET deadline_at = ?, reminder_schedule_json = ?,
          approval_revision = approval_revision + 1
        WHERE id = ? AND status = 'PENDING' AND verified_checkpoint_id = ? AND verified_checkpoint_hash = ?
          AND approval_revision = ?`).run(
        deadlineAt, canonicalJson(reminders), parsed.approvalRequestId,
        parsed.expectedVerifiedCheckpointId, parsed.expectedVerifiedCheckpointHash, parsed.expectedApprovalRevision,
      );
      if (Number(updated.changes) !== 1) throw new IdempotencyConflictError(request.runId, `approval:${parsed.approvalRequestId}`);
      return { ...request, deadlineAt, reminderSchedule: reminders, approvalRevision: request.approvalRevision + 1 };
    })();
  }

  getPublicationEvidence(runId: string): PublicationEvidence {
    const run = this.getRun(runId);
    // P7 fail-closed gate: the publication-selection preflight may never surface
    // publishable evidence for a replacement run whose complete lineage does not
    // verify (no legacy same-run fallback).
    this.assertReplacementLineageAuthority(runId);
    const reviewer = this.db.query(`SELECT id, decision, input_hash, manifest_hash, diff_hash,
      evidence_bundle_hash, isolation_verified, completed_at
      FROM reviewer_sessions WHERE run_id = ? ORDER BY attempt DESC LIMIT 1`).get(runId) as Record<string, unknown> | null;
    const reviewerAgent = this.db.query(`SELECT id, status, input_hash, output_artifact_id, started_at, completed_at
      FROM agent_executions WHERE run_id = ? AND role = 'REVIEWER' ORDER BY rowid DESC LIMIT 1`)
      .get(runId) as Record<string, unknown> | null;
    if (!reviewer || !reviewerAgent) throw new EngineerNotFoundError("publication evidence", runId);
    const classificationRow = this.db.query(`SELECT b.reviewer_session_id FROM review_classification_batches b
      JOIN reviewer_sessions s ON s.id = b.reviewer_session_id
      WHERE b.run_id = ? ORDER BY s.attempt DESC, b.rowid DESC LIMIT 1`).get(runId) as { reviewer_session_id: string } | null;
    if (!classificationRow || classificationRow.reviewer_session_id !== reviewer.id) {
      throw new Error("publication blocked: latest Reviewer session has no classified authority");
    }
    const classification = this.getReviewClassification(classificationRow.reviewer_session_id);
    if (!classification || !["READY", "READY_WITH_ADVISORIES"].includes(classification.result)) {
      throw new Error("publication blocked: deterministic review classification is not ready");
    }
    const bundleRows = this.db.query(`SELECT id, bundle_hash, manifest_json FROM evidence_bundles WHERE run_id = ?`)
      .all(runId) as Array<Record<string, unknown>>;
    const boundBundles = bundleRows.map((row) => EvidenceBundleRecordSchema.parse({
      evidenceBundleId: row.id, bundleHash: row.bundle_hash, bundle: JSON.parse(String(row.manifest_json)),
    })).filter((record) => record.bundle.bundleVersion >= 2 &&
      record.bundle.reviewerSessionId === reviewer.id &&
      record.bundle.classificationHash === classification.classificationHash);
    if (boundBundles.length !== 1) {
      throw new Error("publication blocked: expected exactly one evidence bundle bound to the classified Reviewer session");
    }
    const bundleManifest = boundBundles[0]!;
    if (bundleManifest.bundleHash !== sha256(bundleManifest.bundle)) {
      throw new Error("publication blocked: classified evidence bundle hash mismatch");
    }
    if (reviewerAgent.status !== "SUCCEEDED" || reviewerAgent.input_hash !== reviewer.input_hash ||
        !reviewerAgent.output_artifact_id) {
      throw new Error("publication blocked: the latest Reviewer attempt has no completed, recorded decision");
    }
    if (bundleManifest.bundle.bundleVersion < 2 || !bundleManifest.bundle.reviewerSessionId ||
        bundleManifest.bundle.reviewerSessionId !== reviewer.id ||
        bundleManifest.bundle.classificationHash !== classification.classificationHash ||
        bundleManifest.bundle.finalDecision !== reviewer.decision ||
        bundleManifest.bundle.manifestHash !== reviewer.manifest_hash ||
        bundleManifest.bundle.manifestHash !== run.manifestHash ||
        bundleManifest.bundle.classificationResult !== classification.result) {
      throw new Error("publication blocked: the latest evidence bundle is not bound to the latest Reviewer session");
    }
    const latestPass = this.db.query("SELECT COALESCE(MAX(verification_pass), 1) AS pass FROM test_executions WHERE run_id = ?")
      .get(runId) as { pass: number };
    const testCounts = this.db.query(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN status <> 'PASSED' THEN 1 ELSE 0 END) AS failed FROM test_executions WHERE run_id = ? AND verification_pass = ?`)
      .get(runId, latestPass.pass) as { total: number; failed: number | null };
    const critical = this.db.query(`SELECT COUNT(*) AS count FROM security_findings
      WHERE run_id = ? AND severity = 'CRITICAL' AND status = 'OPEN' AND category NOT LIKE 'AI_ADVISORY_%'`).get(runId) as { count: number };
    return PublicationEvidenceSchema.parse({
      runId, reviewerSessionId: reviewer.id, reviewerDecision: reviewer.decision,
      classificationHash: classification.classificationHash, classificationResult: classification.result,
      reviewerDiffHash: reviewer.diff_hash, reviewerEvidenceBundleHash: reviewer.evidence_bundle_hash,
      reviewerIsolationVerified: reviewer.isolation_verified === 1,
      evidenceBundleId: bundleManifest.evidenceBundleId, evidenceBundleHash: bundleManifest.bundleHash,
      resultCommitSha: bundleManifest.bundle.resultCommitSha,
      allRequiredChecksPassed: testCounts.total > 0 && (testCounts.failed ?? 0) === 0,
      openCriticalSecurityFindings: critical.count,
    });
  }

  recordGitOperation(record: NewGitOperationRecord): NewGitOperationRecord {
    const parsed = GitOperationRecordSchema.parse(record);
    this.getRun(parsed.runId);
    const existing = this.db.query("SELECT * FROM git_operations WHERE run_id = ? AND idempotency_key = ?")
      .get(parsed.runId, parsed.idempotencyKey) as Record<string, unknown> | null;
    if (existing) {
      const current = this.gitOperationFromRow(existing);
      if (!current.verifiedCheckpointId || !current.verifiedCheckpointHash) {
        throw new IdempotencyConflictError(parsed.runId, `legacy-git-operation:${parsed.idempotencyKey}`);
      }
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
        verifiedCheckpointId: operation.verifiedCheckpointId,
        verifiedCheckpointHash: operation.verifiedCheckpointHash,
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
       started_at, completed_at, error_code, verified_checkpoint_id, verified_checkpoint_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      parsed.gitOperationId, parsed.runId, parsed.operationType, parsed.requestedBy, parsed.idempotencyKey,
      parsed.expectedBaseCommitSha, parsed.resultCommitSha, parsed.approvalId, parsed.evidenceBundleHash,
      parsed.status, parsed.remoteReference, parsed.startedAt, parsed.completedAt, parsed.errorCode,
      parsed.verifiedCheckpointId, parsed.verifiedCheckpointHash,
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
      (id, run_id, failure_class, reason_code, fingerprint, evidence_ids_json, retryable, underlying_cause, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      parsed.failureId, parsed.runId, parsed.failureClass, parsed.reasonCode, parsed.fingerprint,
      canonicalJson(parsed.evidenceIds), parsed.retryable ? 1 : 0, parsed.underlyingCause ?? null, parsed.createdAt,
    );
    return parsed;
  }

  listFailures(runId: string): FailureRecord[] {
    this.getRun(runId);
    const rows = this.db.query("SELECT * FROM failure_records WHERE run_id = ? ORDER BY created_at, rowid").all(runId) as Array<Record<string, unknown>>;
    return rows.map((row) => FailureRecordSchema.parse({
      failureId: row.id, runId: row.run_id, failureClass: row.failure_class, reasonCode: row.reason_code,
      fingerprint: row.fingerprint, evidenceIds: JSON.parse(String(row.evidence_ids_json)),
      retryable: row.retryable === 1,
      ...(row.underlying_cause != null ? { underlyingCause: String(row.underlying_cause) } : {}),
      createdAt: row.created_at,
    }));
  }

  private exactHardeningFatalRow(row:Record<string,unknown>|null,expected:FailureRecord):FailureRecord|null{
    if(!row)return null;
    try{
      if(row.id!==expected.failureId||row.run_id!==expected.runId||row.failure_class!==expected.failureClass||
        row.reason_code!==expected.reasonCode||row.fingerprint!==expected.fingerprint||
        row.evidence_ids_json!==canonicalJson(expected.evidenceIds)||row.retryable!==0||row.created_at!==expected.createdAt)
        return null;
      const parsed=FailureRecordSchema.parse({failureId:row.id,runId:row.run_id,failureClass:row.failure_class,
        reasonCode:row.reason_code,fingerprint:row.fingerprint,evidenceIds:JSON.parse(String(row.evidence_ids_json)),
        retryable:false,createdAt:row.created_at});
      return canonicalJson(parsed)===canonicalJson(expected)?parsed:null;
    }catch{return null;}
  }

  /** Read only. Conflict authority takes precedence even if the hostile primary row is later deleted. */
  getExactHardeningDatabaseIntegrityFatal(runId:string):FailureRecord|null{
    const run=this.getRun(runId);
    const expected=canonicalHardeningDatabaseIntegrityFailure({runId,runCreatedAt:run.createdAt});
    const expectedConflict=canonicalHardeningDatabaseIntegrityConflictFailure({runId,runCreatedAt:run.createdAt});
    const conflictRow=this.db.query("SELECT * FROM failure_records WHERE id=?")
      .get(hardeningDatabaseIntegrityConflictFailureId(runId)) as Record<string,unknown>|null;
    if(conflictRow){
      const exactConflict=this.exactHardeningFatalRow(conflictRow,expectedConflict);
      if(exactConflict)return exactConflict;
      throw new DatabaseIntegrityFatalMarkerConflictAuthorityInvalidError(runId);
    }
    const row=this.db.query("SELECT * FROM failure_records WHERE id=?")
      .get(hardeningDatabaseIntegrityFailureId(runId)) as Record<string,unknown>|null;
    if(!row)return null;
    const exact=this.exactHardeningFatalRow(row,expected);
    if(exact)return exact;
    throw new DatabaseIntegrityFatalMarkerConflictError(runId);
  }

  /**
   * Atomically inserts or replays the one canonical fatal marker and its UI
   * guidance. Competing processes construct byte-identical authority from the
   * immutable run creation time; a preoccupied ID is never accepted.
   */
  recordOrReplayHardeningDatabaseIntegrityFatal(runId:string):{status:"APPLIED"|"REPLAYED";failure:FailureRecord}{
    const outcome=this.db.transaction(()=>{
      const run=this.getRun(runId);
      const expected=canonicalHardeningDatabaseIntegrityFailure({runId,runCreatedAt:run.createdAt});
      const expectedConflict=canonicalHardeningDatabaseIntegrityConflictFailure({runId,runCreatedAt:run.createdAt});
      const conflictRow=this.db.query("SELECT * FROM failure_records WHERE id=?").get(expectedConflict.failureId) as Record<string,unknown>|null;
      if(conflictRow){
        const exactConflict=this.exactHardeningFatalRow(conflictRow,expectedConflict);
        if(exactConflict){
          this.db.query("UPDATE engineer_runs SET last_error=? WHERE id=? AND (last_error IS NULL OR last_error!=?)")
            .run(HARDENING_DATABASE_INTEGRITY_MARKER_CONFLICT_GUIDANCE,runId,HARDENING_DATABASE_INTEGRITY_MARKER_CONFLICT_GUIDANCE);
          return {kind:"CONFLICT" as const,failure:exactConflict};
        }
        this.db.query("UPDATE engineer_runs SET last_error=? WHERE id=? AND (last_error IS NULL OR last_error!=?)")
          .run(HARDENING_DATABASE_INTEGRITY_MARKER_AUTHORITY_INVALID_GUIDANCE,runId,
            HARDENING_DATABASE_INTEGRITY_MARKER_AUTHORITY_INVALID_GUIDANCE);
        return {kind:"CONFLICT_AUTHORITY_INVALID" as const};
      }
      const primaryRow=this.db.query("SELECT * FROM failure_records WHERE id=?").get(expected.failureId) as Record<string,unknown>|null;
      if(primaryRow&&!this.exactHardeningFatalRow(primaryRow,expected)){
        this.db.query(`INSERT INTO failure_records
          (id,run_id,failure_class,reason_code,fingerprint,evidence_ids_json,retryable,created_at)
          VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`).run(expectedConflict.failureId,expectedConflict.runId,
            expectedConflict.failureClass,expectedConflict.reasonCode,expectedConflict.fingerprint,
            canonicalJson(expectedConflict.evidenceIds),0,expectedConflict.createdAt);
        const insertedConflict=this.db.query("SELECT * FROM failure_records WHERE id=?").get(expectedConflict.failureId) as Record<string,unknown>|null;
        const exactConflict=this.exactHardeningFatalRow(insertedConflict,expectedConflict);
        if(!exactConflict){
          this.db.query("UPDATE engineer_runs SET last_error=? WHERE id=? AND (last_error IS NULL OR last_error!=?)")
            .run(HARDENING_DATABASE_INTEGRITY_MARKER_AUTHORITY_INVALID_GUIDANCE,runId,
              HARDENING_DATABASE_INTEGRITY_MARKER_AUTHORITY_INVALID_GUIDANCE);
          return {kind:"CONFLICT_AUTHORITY_INVALID" as const};
        }
        this.db.query("UPDATE engineer_runs SET last_error=? WHERE id=? AND (last_error IS NULL OR last_error!=?)")
          .run(HARDENING_DATABASE_INTEGRITY_MARKER_CONFLICT_GUIDANCE,runId,HARDENING_DATABASE_INTEGRITY_MARKER_CONFLICT_GUIDANCE);
        return {kind:"CONFLICT" as const,failure:exactConflict};
      }
      const inserted=primaryRow?{changes:0}:this.db.query(`INSERT INTO failure_records
        (id,run_id,failure_class,reason_code,fingerprint,evidence_ids_json,retryable,created_at)
        VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`).run(expected.failureId,expected.runId,
          expected.failureClass,expected.reasonCode,expected.fingerprint,canonicalJson(expected.evidenceIds),0,expected.createdAt);
      const persisted=this.db.query("SELECT * FROM failure_records WHERE id=?").get(expected.failureId) as Record<string,unknown>|null;
      const exact=this.exactHardeningFatalRow(persisted,expected);
      if(!exact)throw new DatabaseIntegrityFatalMarkerConflictError(runId);
      this.db.query("UPDATE engineer_runs SET last_error=? WHERE id=? AND (last_error IS NULL OR last_error!=?)")
        .run(HARDENING_DATABASE_INTEGRITY_GUIDANCE,runId,HARDENING_DATABASE_INTEGRITY_GUIDANCE);
      return {kind:"FATAL" as const,status:(inserted.changes===1?"APPLIED":"REPLAYED") as "APPLIED"|"REPLAYED",failure:exact};
    }).immediate();
    if(outcome.kind==="CONFLICT")throw new DatabaseIntegrityFatalMarkerConflictError(runId);
    if(outcome.kind==="CONFLICT_AUTHORITY_INVALID")throw new DatabaseIntegrityFatalMarkerConflictAuthorityInvalidError(runId);
    return {status:outcome.status,failure:outcome.failure};
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

  private assertApprovalDecisionAuthority(
    request: ApprovalRequestRecord,
    decision: NewApprovalDecisionRecord,
  ): asserts request is NewApprovalRequestRecord {
    if (request.status !== "PENDING") {
      throw new IdempotencyConflictError(request.runId, `approval:${request.approvalRequestId}`);
    }
    if (!request.verifiedCheckpointId || !request.verifiedCheckpointHash) {
      throw new Error("legacy approval request has no verified checkpoint authority");
    }
    if (request.verifiedCheckpointId !== decision.expectedVerifiedCheckpointId ||
        request.verifiedCheckpointHash !== decision.expectedVerifiedCheckpointHash ||
        request.approvalRevision !== decision.expectedApprovalRevision) {
      throw new IdempotencyConflictError(request.runId, `approval-checkpoint:${request.approvalRequestId}`);
    }
  }

  private approvalRequestFromRow(row: Record<string, unknown>): ApprovalRequestRecord {
    return ApprovalRequestReadRecordSchema.parse({
      approvalRequestId: row.id, runId: row.run_id, riskTier: row.risk_tier,
      assignedReviewerId: row.assigned_reviewer_id, requestedAt: row.requested_at,
      deadlineAt: row.deadline_at, reminderSchedule: JSON.parse(String(row.reminder_schedule_json)),
      timeoutAction: row.timeout_action, manifestHash: row.manifest_hash, diffHash: row.diff_hash,
      evidenceBundleHash: row.evidence_bundle_hash,
      reviewerSessionId: row.reviewer_session_id ?? null,
      classificationHash: row.classification_hash ?? null,
      classificationResult: row.classification_result ?? null,
      approvalRevision: Number(row.approval_revision),
      verifiedCheckpointId: row.verified_checkpoint_id ?? null,
      verifiedCheckpointHash: row.verified_checkpoint_hash ?? null,
      status: row.status,
    });
  }

  private gitOperationFromRow(row: Record<string, unknown>): GitOperationRecord {
    return GitOperationReadRecordSchema.parse({
      gitOperationId: row.id, runId: row.run_id, operationType: row.operation_type,
      requestedBy: row.requested_by, idempotencyKey: row.idempotency_key,
      expectedBaseCommitSha: row.expected_base_commit_sha, resultCommitSha: row.result_commit_sha,
      approvalId: row.approval_id, evidenceBundleHash: row.evidence_bundle_hash,
      verifiedCheckpointId: row.verified_checkpoint_id ?? null,
      verifiedCheckpointHash: row.verified_checkpoint_hash ?? null,
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
    auditEventId:string=randomUUID(),
  ): void {
    this.db.query(`INSERT INTO audit_events
      (id, run_id, action, actor_type, actor_id, details_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(auditEventId, runId, action, actorType, actorId, canonicalJson(details), createdAt);
  }

  private budgetSnapshot(row: BudgetRow): EngineerBudgetSnapshot {
    const remainingCost = Number(Math.max(0, row.cost_limit_usd - row.used_cost_usd - row.reserved_cost_usd).toFixed(8));
    const remainingTokens = Math.max(0, row.token_limit - row.used_tokens - row.reserved_tokens);
    const remainingTime = Math.max(0, row.time_limit_seconds - row.used_time_seconds);
    const ratios = [row.cost_limit_usd === 0 ? 1 : row.used_cost_usd / row.cost_limit_usd,
      row.token_limit === 0 ? 1 : row.used_tokens / row.token_limit, row.used_time_seconds / row.time_limit_seconds];
    const status = row.status === "PAUSED" ? "PAUSED" : Math.max(...ratios) >= row.warning_threshold ? "WARNING" : "ACTIVE";
    const latestBudgetEvent = this.db.query(`SELECT event_type FROM budget_events
      WHERE run_id = ? ORDER BY budget_revision DESC, rowid DESC LIMIT 1`).get(row.run_id) as { event_type: string } | null;
    return EngineerBudgetSnapshotSchema.parse({
      runId: row.run_id, status,
      limits: { costUsd: row.cost_limit_usd, tokens: row.token_limit, timeSeconds: row.time_limit_seconds },
      lifetimeLimits: { costUsd: row.lifetime_cost_limit_usd, tokens: row.lifetime_token_limit, timeSeconds: row.lifetime_time_limit_seconds },
      used: { costUsd: row.used_cost_usd, tokens: row.used_tokens, timeSeconds: row.used_time_seconds },
      reserved: { costUsd: row.reserved_cost_usd, tokens: row.reserved_tokens },
      ambiguous: { costUsd: row.ambiguous_cost_usd, tokens: row.ambiguous_tokens },
      remaining: { costUsd: remainingCost, tokens: remainingTokens, timeSeconds: remainingTime },
      warningThreshold: row.warning_threshold, pauseReason: row.pause_reason, resumeState: row.resume_state,
      topUpPendingResume: row.status === "PAUSED" && latestBudgetEvent?.event_type === "BUDGET_TOPPED_UP",
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
