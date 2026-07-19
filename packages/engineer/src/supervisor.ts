import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  RepositoryReferenceSchema,
  EngineerRunSchema,
  RiskAssessmentSchema,
  RiskFeaturesSchema,
  RetryBudgetsSchema,
  TaskManifestContentSchema,
  TaskManifestSchema,
  type ActorType,
  type EngineerRun,
  type RepositoryReference,
  type RetryKind,
  type RiskAssessment,
  type RiskFeatures,
  type RiskTier,
  type RunState,
  type RunStateEvent,
  type TaskManifest,
  type TaskManifestContent,
  ModelRoutingDecisionSchema,
  ReviewerInputSchema,
  TrustedEvidenceSchema,
  reviewerEvidenceBundleHash,
  type ModelRoutingDecision,
} from "./contracts.js";
import {
  type ArtifactRecord,
  type AgentExecutionRecord,
  type BuilderDispatchClaim,
  type CommandExecutionRecord,
  type ModelCallRecord,
  type SandboxRecord,
} from "./execution-contracts.js";
import type {
  ClaimEvidenceRecord,
  EvidenceBundleRecord,
  ReviewFindingRecord,
  ReviewerSessionRecord,
  SecurityFindingRecord,
  VerificationExecutionRecord,
} from "./verification-contracts.js";
import type { ReviewClassificationBatch } from "./review-classification.js";
import {
  FailureRecordSchema,
  type FailureRecord,
  type ApprovalDecisionRecord,
  type ApprovalRequestRecord,
  type NewApprovalDecisionRecord,
  type NewApprovalRequestRecord,
  type NewGitOperationRecord,
  type GitOperationRecord,
  type PublicationEvidence,
  type TestExecutionView,
} from "./control-contracts.js";
import { AdvisoryIntegrityError, BudgetPausedError, BuilderModelCallLimitError, IdempotencyConflictError, InvalidTransitionError, ManifestIntegrityError, StateVersionConflictError } from "./errors.js";
import { canonicalJson, compareCodeUnits, sha256 } from "./hash.js";
import { hardeningCheckpointMilestoneKey,hardeningReviewCompletionEvidence,OptionalHardeningIndependentCheckpointSchema,
  OptionalHardeningReviewInputAuthoritySchema,validateOptionalHardeningCheckpointChain,
  hardeningFinalRiskAssessmentId,hardeningFinalScopeArtifactId,hardeningPreReviewArtifactId,
  hardeningReviewAuthorityArtifactId,hardeningReviewerIngressTimes,resolveHardeningArtifactAuthority } from
  "./hardening-verification-recovery.js";
import { LocalArtifactStore } from "./artifact-store.js";
import {
  EngineerLedger,
  type FailureClassProjection,
  type LedgerTransitionResult,
  type RunExportTable,
  type RunObservabilityProjection,
  type ClassifiedReviewerAuthority,
  type ArtifactByteReader,
  type OptionalHardeningStartPreparation,
  type ProvenanceEmissionContext,
} from "./ledger.js";
import { buildOptionalHardeningManifest } from "./hardening-manifest.js";
import { HardeningBudgetExtensionRequiresNewRunError } from "./hardening-budget-contracts.js";
import { assessRisk, type RiskDecision, type RiskPolicyOptions } from "./risk.js";
import { derivePostVerificationRiskFeatures } from "./post-verification-risk.js";
import { buildFinalChangeScopeAttestation, FinalChangeScopeAttestationSchema,
  type FinalChangeScopeAttestation } from "./final-change-scope.js";
import { TestBaselineManifestSchema, TestIntegrityComparisonSchema,
  type TestIntegrityComparison } from "./test-integrity.js";
import { REVIEWER_POLICY_VERSION } from "./isolated-reviewer.js";
import { buildHardeningPendingSemanticRows,resolveHardeningReviewerEvidenceAuthority,
  resolveHardeningReviewerSemanticAuthority } from "./hardening-review-input-authority.js";
import { hardeningFinalRiskAuditId,hardeningPreReviewAuditId } from "./hardening-verification-recovery.js";
import { evaluateRetry, type RetryDecision } from "./retry.js";
import { canTransition, isCancellationAllowed, isTerminalState } from "./state-machine.js";
import type { PlanProposal } from "./planning.js";
import { StoredContextSnapshotSchema, type StoredContextSnapshot } from "./context-contracts.js";
import {
  DecisionEvidenceReferenceSchema,
  DecisionFactorsSchema,
  DecisionOptionSchema,
  DecisionRecordContentSchema,
  DecisionRecordSchema,
  DecisionResolutionContentSchema,
  DecisionResolutionSchema,
  type DecisionEvidenceReference,
  type DecisionFactors,
  type DecisionOption,
  type DecisionRecord,
  type DecisionResolution,
} from "./decision-contracts.js";
import { DECISION_POLICY_VERSION, classifyDecisionFactors } from "./decision-policy.js";
import type { AdvisoryBacklogPage, AdvisoryOwnerCommand, HardeningConsentRequest, HardeningQuoteRequest, OptionalHardeningChildRequest } from "./advisory-hardening-contracts.js";
import {
  createRequiredLaneContract,
  type RequiredLaneContract,
  type RequiredLaneContractAuthority,
} from "./required-lane-contracts.js";
import { TRUSTED_COMMAND_POLICY_VERSION } from "./trusted-executor.js";
import {
  REQUIRED_LANE_REVIEWER_MAPPING_POLICY_VERSION,
  SECURITY_POLICY_VERSION,
  VERIFICATION_POLICY_VERSION,
} from "./required-lane-policy-versions.js";
import { assertRunBudget as assertBudgetPolicy, estimateGpt56CostUsd, RunBudgetUsageSchema, RuntimeBudgetExhaustedError, type RunBudgetDecision, type RunBudgetUsage } from "./runtime-budget.js";
import {
  BudgetTopUpSchema,
  EngineerBudgetSelectionSchema,
  type BudgetPauseReason,
  type BudgetTopUp,
  type EngineerBudgetSelection,
  type EngineerBudgetSnapshot,
} from "./budget-contracts.js";
import type { RepositoryAdmission, RepositoryAdmissionSource } from "./repository-admission.js";
import type {
  CheckpointAttestor,
  PromoteVerifiedCandidateInput,
  VerifiedCandidatePromotionResult,
} from "./verified-candidate-checkpoint.js";
import { StaleWorkerLeaseError, type WorkerLeaseRecord } from "./worker-lease.js";

export interface RecoveryWorkerLeaseProof {
  leaseId: string;
  ownerId: string;
  fencingToken: number;
  leaseToken: string;
}

export interface RecoveryWorkerLeaseAuthority {
  assertActive(input: RecoveryWorkerLeaseProof): WorkerLeaseRecord;
  withActiveLease<T>(input: RecoveryWorkerLeaseProof, operation: (lease: WorkerLeaseRecord) => T): T;
}

export interface SupervisorOptions {
  dbPath?: string;
  now?: () => Date;
  idFactory?: () => string;
  builderModelCallLimit?: number;
  checkpointAttestor?: CheckpointAttestor;
  hardeningPromptCacheSecret?: string;
  recoveryWorkerLeaseAuthority?: RecoveryWorkerLeaseAuthority;
  /** Synchronous crash seam; a thrown error must roll back the entire hardening ingress bundle. */
  afterHardeningIngressStepForTest?:(step:"FINAL_SCOPE"|"PRE_REVIEW"|"INTEGRITY_AUDIT"|"FINAL_RISK"|
    "SEMANTIC_PREFLIGHT"|"REVIEW_AUTHORITY"|"COMPLETION")=>void;
}


/**
 * Durable backstop above the complete default workflow envelope:
 * one initial Builder pass plus four authorized repair passes may each use
 * twelve model turns, and three transient retries may be admitted. Runtime
 * token/cost/time budgets and retry progress guards remain the tighter limits.
 */
export const MAX_BUILDER_MODEL_CALLS_PER_RUN = 68;

export interface ReceiveRequestInput {
  runId?: string;
  userId: string;
  userEmail?: string;
  repository: RepositoryReference;
  request: string;
  initialRiskFeatures?: Partial<RiskFeatures>;
  budget?: Partial<EngineerBudgetSelection>;
}

export interface TransitionFacts {
  reviewerDecisionValid?: boolean;
  reviewerFindingsActionable?: boolean;
  freshReviewerSession?: boolean;
  reviewerRetryAuthorized?: boolean;
  fullVerificationRerun?: boolean;
  retryBudgetAvailable?: boolean;
  scopeWithinManifest?: boolean;
  humanApprovalValid?: boolean;
  allRequiredChecksPassed?: boolean;
  noCriticalSecurityFindings?: boolean;
  evidenceBundleComplete?: boolean;
  baseBranchCurrent?: boolean;
  prCreated?: boolean;
}

export interface TransitionInput {
  runId: string;
  expectedStateVersion: number;
  nextState: RunState;
  reasonCode: string;
  actorType?: Exclude<ActorType, "AGENT" | "EXECUTOR">;
  actorId?: string;
  evidenceIds?: string[];
  manifestHash?: string | null;
  idempotencyKey: string;
  facts?: TransitionFacts;
}

export interface FreezePlanInput {
  runId: string;
  expectedStateVersion: number;
  manifest: TaskManifestContent;
  actorId: string;
  idempotencyKey: string;
}

export interface AuthorizeRetryInput {
  runId: string;
  expectedStateVersion: number;
  kind: RetryKind;
  failureFingerprint: string;
  patchHash?: string | null;
  progressMetric?: number | null;
}

export interface CreateDecisionInput {
  runId: string;
  expectedStateVersion: number;
  question: string;
  factors: DecisionFactors;
  options: DecisionOption[];
  recommendedOptionId: string;
  sourceEvidence: DecisionEvidenceReference[];
  idempotencyKey: string;
}

export interface ResolveDecisionInput {
  runId: string;
  decisionId: string;
  expectedStateVersion: number;
  selectedOptionId: string;
  actorId: string;
  rationale: string;
  sourceEvidence: DecisionEvidenceReference[];
  idempotencyKey: string;
}

function requireFacts(facts: TransitionFacts | undefined, names: Array<keyof TransitionFacts>, state: RunState): void {
  const missing = names.filter((name) => facts?.[name] !== true);
  if (missing.length > 0) {
    throw new InvalidTransitionError(`${state} requires supervisor facts: ${missing.join(", ")}`);
  }
}

function derivedDecisionKey(base: string, suffix: string): string {
  const candidate = `${base}:${suffix}`;
  return candidate.length <= 500 ? candidate : `decision:${sha256({ base, suffix })}`;
}

/**
 * The only supported mutation surface for Engineer workflow state. Agents and
 * executors submit structured results to future adapters; they never receive this
 * object or the raw ledger.
 */
export class EngineerSupervisor {
  private readonly ledger: EngineerLedger;
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly builderModelCallLimit: number;
  private checkpointAttestor?: CheckpointAttestor;
  private recoveryWorkerLeaseAuthority?: RecoveryWorkerLeaseAuthority;
  private artifactReadAuthority?:LocalArtifactStore;
  private readonly afterHardeningIngressStepForTest?:SupervisorOptions["afterHardeningIngressStepForTest"];

  constructor(options: SupervisorOptions = {}) {
    this.ledger = new EngineerLedger(options.dbPath ?? join(homedir(), ".zintus", "engineer.db"), options.now,
      options.hardeningPromptCacheSecret);
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.builderModelCallLimit = options.builderModelCallLimit ?? MAX_BUILDER_MODEL_CALLS_PER_RUN;
    this.checkpointAttestor = options.checkpointAttestor;
    this.recoveryWorkerLeaseAuthority = options.recoveryWorkerLeaseAuthority;
    this.afterHardeningIngressStepForTest=options.afterHardeningIngressStepForTest;
    if (!Number.isSafeInteger(this.builderModelCallLimit) || this.builderModelCallLimit < 1) {
      throw new TypeError("Builder model-call limit must be a positive safe integer");
    }
  }

  /** Binds the server-owned worker-lease authority exactly once after startup wiring. */
  configureRecoveryWorkerLeaseAuthority(authority: RecoveryWorkerLeaseAuthority): void {
    if(this.recoveryWorkerLeaseAuthority&&this.recoveryWorkerLeaseAuthority!==authority){
      throw new Error("Engineer recovery worker-lease authority is already configured");
    }
    this.recoveryWorkerLeaseAuthority=authority;
  }

  configureArtifactReadAuthority(authority:LocalArtifactStore):void{
    if(!(authority instanceof LocalArtifactStore))throw new TypeError("Engineer artifact read authority must be a LocalArtifactStore");
    if(this.artifactReadAuthority&&this.artifactReadAuthority!==authority)
      throw new Error("Engineer artifact read authority is already configured");
    if(this.artifactReadAuthority===authority)return;
    this.artifactReadAuthority=authority;
    this.ledger.configureHardeningArtifactReader((artifact)=>authority.readVerifiedExact(artifact));
  }

  /** Optional-hardening artifacts may only be consumed through the admitted root/FD authority. */
  private strictArtifactReader(runId:string):ArtifactByteReader|undefined{
    if(!this.isOptionalHardeningChild(runId))return undefined;
    if(!this.artifactReadAuthority)throw new InvalidTransitionError(
      "optional-hardening durable evidence requires strict artifact-read authority");
    return (artifact)=>this.artifactReadAuthority!.readVerifiedExact(artifact);
  }

  /**
   * Holds the durable worker-lease authority across a synchronous
   * optional-hardening mutation. Lock order is worker lease DB, then Engineer
   * DB; asynchronous callbacks are forbidden at this boundary.
   */
  private withRecoveryWorkerLease<T>(runId:string,proof:RecoveryWorkerLeaseProof,operation:()=>T):T{
    const authority=this.recoveryWorkerLeaseAuthority;
    if(!authority)throw new InvalidTransitionError(
      "optional-hardening worker-lease authority is not configured");
    return authority.withActiveLease(proof,(lease)=>{
      if(lease.status!=="ACTIVE"||lease.resourceKey!==`run:${runId}`||lease.leaseId!==proof.leaseId||
        lease.ownerId!==proof.ownerId||lease.fencingToken!==proof.fencingToken){
        throw new StaleWorkerLeaseError(proof.leaseId);
      }
      const result=operation();
      if(result!==null&&typeof result==="object"&&"then" in result&&
        typeof (result as {then?:unknown}).then==="function"){
        throw new TypeError("optional-hardening worker-lease operations must be synchronous");
      }
      return result;
    });
  }

  /**
   * Server-only trust boundary. Callers must derive evidence from authenticated
   * configuration or a connector grant; a browser-supplied repository object is
   * not authorization to invoke this method.
   */
  registerRepositoryAdmission(input: {
    admissionId: string;
    ownerUserId: string;
    repository: RepositoryReference;
    source: RepositoryAdmissionSource;
    authorizationSubject: string;
    authorizationEvidenceHash: string;
    authorizationExpiresAt?: string | null;
    authorizationGeneration?: number;
    existingBasePolicy?: "REQUIRE_EXACT" | "PRESERVE_EXISTING";
  }): RepositoryAdmission {
    return this.ledger.registerRepositoryAdmission({
      ...input,
      repository: RepositoryReferenceSchema.parse(input.repository),
      now: this.timestamp(),
    });
  }

  repositoryAdmission(ownerUserId: string, repositoryId: string): RepositoryAdmission | null {
    return this.ledger.getRepositoryAdmission(ownerUserId, repositoryId);
  }

  migrateLegacyConfiguredRepositoryAdmissionEvidence(input: {
    ownerUserId: string; repositoryId: string; nextEvidenceHash: string;
  }): RepositoryAdmission {
    if (!/^sha256:[a-f0-9]{64}$/i.test(input.nextEvidenceHash)) {
      throw new Error("repository admission evidence must be canonical SHA-256");
    }
    return this.ledger.migrateLegacyConfiguredRepositoryAdmissionEvidence(
      input.ownerUserId, input.repositoryId, input.nextEvidenceHash, this.timestamp(),
    );
  }

  reauthorizeConnectorRepositoryAdmission(input: {
    ownerUserId: string; repositoryId: string; previousGeneration: number; nextGeneration: number;
    authorizationSubject: string; authorizationEvidenceHash: string; authorizationExpiresAt: string;
  }): RepositoryAdmission {
    if (!Number.isInteger(input.previousGeneration) || !Number.isInteger(input.nextGeneration) || input.previousGeneration < 1) {
      throw new Error("connector repository reauthorization generation is invalid");
    }
    if (input.nextGeneration <= input.previousGeneration) {
      throw new Error("connector repository reauthorization generation must advance");
    }
    const now = this.timestamp();
    const expiresAt = new Date(input.authorizationExpiresAt).getTime();
    if (!/^sha256:[a-f0-9]{64}$/i.test(input.authorizationEvidenceHash) ||
        !Number.isFinite(expiresAt) || expiresAt <= new Date(now).getTime()) {
      throw new Error("connector repository reauthorization is invalid");
    }
    return this.ledger.reauthorizeConnectorRepositoryAdmission({ ...input, now });
  }

  listRepositoryAdmissions(ownerUserId: string): RepositoryAdmission[] {
    return this.ledger.listRepositoryAdmissions(ownerUserId);
  }

  advanceRepositoryAdmissionBase(input: {
    ownerUserId: string; repositoryId: string; previousBaseCommitSha: string; nextBaseCommitSha: string;
  }): RepositoryAdmission {
    if (!/^[a-f0-9]{40}$|^[a-f0-9]{64}$/i.test(input.previousBaseCommitSha) ||
        !/^[a-f0-9]{40}$|^[a-f0-9]{64}$/i.test(input.nextBaseCommitSha)) {
      throw new Error("repository admission base SHAs must be exact Git object identifiers");
    }
    return this.ledger.advanceRepositoryAdmissionBase(
      input.ownerUserId, input.repositoryId, input.previousBaseCommitSha, input.nextBaseCommitSha, this.timestamp(),
    );
  }

  revokeRepositoryAdmission(ownerUserId: string, repositoryId: string): RepositoryAdmission {
    return this.ledger.revokeRepositoryAdmission(ownerUserId, repositoryId, this.timestamp());
  }

  receiveRequest(input: ReceiveRequestInput): EngineerRun {
    const request = input.request.trim();
    if (!request) throw new InvalidTransitionError("request must not be empty");
    const repository = RepositoryReferenceSchema.parse(input.repository);
    const initialRisk = assessRisk(
      RiskFeaturesSchema.parse(input.initialRiskFeatures ?? {}),
      { autoApproveLowRisk: false },
    );
    const now = this.timestamp();
    const runId = input.runId ?? this.idFactory();
    EngineerRunSchema.parse({
      runId,
      userId: input.userId,
      repository,
      requestOriginal: request,
      requestNormalized: "",
      state: "REQUEST_RECEIVED",
      stateVersion: 0,
      manifestHash: null,
      riskTier: initialRisk.riskTier,
      humanGateRequired: initialRisk.humanGateRequired,
      createdAt: now,
      updatedAt: now,
      terminalAt: null,
    });
    return this.ledger.createRun({
      runId, userId: input.userId,
      ...(input.userEmail ? { userEmail: input.userEmail } : {}),
      repository, requestOriginal: request,
      riskTier: initialRisk.riskTier, humanGateRequired: initialRisk.humanGateRequired, now,
      budget: EngineerBudgetSelectionSchema.parse(input.budget ?? {}),
    });
  }

  normalizeRequest(input: {
    runId: string;
    expectedStateVersion: number;
    normalizedRequest: string;
    actorId?: string;
    idempotencyKey: string;
  }): LedgerTransitionResult {
    const normalizedRequest = input.normalizedRequest.trim();
    if (!normalizedRequest) throw new InvalidTransitionError("normalized request must not be empty");
    const run = this.ledger.getRun(input.runId);
    const replay = this.ledger.replayTransition({
      runId: input.runId,
      idempotencyKey: input.idempotencyKey,
      nextState: "REQUEST_NORMALIZED",
      reasonCode: "REQUEST_NORMALIZED",
      actorType: "SUPERVISOR",
      actorId: input.actorId ?? "request-normalizer",
      evidenceIds: [],
      manifestHash: null,
    });
    if (replay) {
      if (replay.run.requestNormalized !== normalizedRequest) {
        throw new IdempotencyConflictError(input.runId, input.idempotencyKey);
      }
      return replay;
    }
    return this.transitionInternal(
      run,
      {
        runId: input.runId,
        expectedStateVersion: input.expectedStateVersion,
        nextState: "REQUEST_NORMALIZED",
        reasonCode: "REQUEST_NORMALIZED",
        actorType: "SUPERVISOR",
        actorId: input.actorId ?? "request-normalizer",
        idempotencyKey: input.idempotencyKey,
      },
      normalizedRequest,
    );
  }

  transition(input: TransitionInput): LedgerTransitionResult {
    const run = this.ledger.getRun(input.runId);
    return this.transitionInternal(run, input);
  }

  freezePlan(input: FreezePlanInput): LedgerTransitionResult {
    const run = this.ledger.getRun(input.runId);
    const content = TaskManifestContentSchema.parse(input.manifest);
    if (content.runId !== run.runId) throw new ManifestIntegrityError("manifest runId does not match run");
    if (sha256(content.repository) !== sha256(run.repository)) {
      throw new ManifestIntegrityError("manifest repository snapshot does not match run");
    }
    if (content.request.original !== run.requestOriginal ||
        content.request.normalized !== run.requestNormalized) {
      throw new ManifestIntegrityError("manifest request does not match the normalized run request");
    }
    if (content.riskTier !== run.riskTier || content.humanGateRequired !== run.humanGateRequired) {
      throw new ManifestIntegrityError("manifest risk and human gate must match the Supervisor decision");
    }
    const proposal = this.ledger.latestPlanProposal(run.runId);
    if (proposal && sha256(proposal.manifest) !== sha256(content)) {
      throw new ManifestIntegrityError("manifest does not match the persisted plan proposal");
    }
    if (content.riskTier !== "LOW" && !content.humanGateRequired) {
      throw new ManifestIntegrityError("medium, high, and critical manifests require a human gate");
    }
    const manifest = TaskManifestSchema.parse({ ...content, manifestHash: sha256(content) });
    const replay = this.ledger.replayTransition({
      runId: input.runId,
      idempotencyKey: input.idempotencyKey,
      nextState: "PLAN_FROZEN",
      reasonCode: "PLAN_FROZEN",
      actorType: "SUPERVISOR",
      actorId: input.actorId,
      evidenceIds: [],
      manifestHash: manifest.manifestHash,
    });
    if (replay) return replay;
    if (run.state !== "PLAN_READY") {
      throw new InvalidTransitionError(`manifest can only freeze from PLAN_READY, not ${run.state}`);
    }
    if (run.stateVersion !== input.expectedStateVersion) {
      throw new StateVersionConflictError(run.runId, input.expectedStateVersion, run.stateVersion);
    }
    const existingVersions = this.ledger.listManifestVersions(run.runId);
    if (content.manifestVersion !== existingVersions.length + 1) {
      throw new ManifestIntegrityError(`manifest version must be ${existingVersions.length + 1}`);
    }
    const timestamp = this.timestamp();
    const context = this.ledger.latestContextSnapshot(run.runId);
    const requiredLaneAuthority: RequiredLaneContractAuthority = {
      planningBinding: {
        contextManifestHash: context?.manifest.manifestHash ?? proposal?.contextManifestHash ?? null,
        planProposalHash: proposal?.proposalHash ?? null,
      },
      policyBindings: {
        verificationPolicyVersion: VERIFICATION_POLICY_VERSION,
        securityPolicyVersion: SECURITY_POLICY_VERSION,
        reviewerMappingPolicyVersion: REQUIRED_LANE_REVIEWER_MAPPING_POLICY_VERSION,
        commandPolicyVersion: TRUSTED_COMMAND_POLICY_VERSION,
      },
    };
    const requiredLaneContract = createRequiredLaneContract({
      manifest,
      ...requiredLaneAuthority.planningBinding,
      policyBindings: requiredLaneAuthority.policyBindings,
    });
    return this.ledger.freezeManifest(
      {
        runId: run.runId,
        expectedStateVersion: input.expectedStateVersion,
        previousState: run.state,
        nextState: "PLAN_FROZEN",
        reasonCode: "PLAN_FROZEN",
        actorType: "SUPERVISOR",
        actorId: input.actorId,
        evidenceIds: [],
        manifestHash: manifest.manifestHash,
        idempotencyKey: input.idempotencyKey,
        eventId: this.idFactory(),
        timestamp,
        terminalAt: null,
      },
      manifest,
      requiredLaneContract,
      requiredLaneAuthority,
    );
  }

  getRequiredLaneContract(runId: string, manifestHash?: string): RequiredLaneContract | null {
    return this.ledger.getRequiredLaneContract(runId, manifestHash);
  }

  assessRunRisk(
    runId: string,
    expectedStateVersion: number,
    features: RiskFeatures,
    options: Partial<RiskPolicyOptions> = {},
  ): RiskAssessment {
    const run = this.ledger.getRun(runId);
    if (run.stateVersion !== expectedStateVersion) {
      throw new StateVersionConflictError(runId, expectedStateVersion, run.stateVersion);
    }
    const decision = assessRisk(features, options),assessment=this.riskAssessmentFromDecision(run,decision,
      this.idFactory(),this.timestamp());
    this.ledger.recordRisk(assessment, expectedStateVersion);
    return assessment;
  }

  /** Pure deterministic final-risk projection used before the atomic hardening ingress commit. */
  prepareOptionalHardeningFinalRisk(input:{runId:string;expectedStateVersion:number;checkpointHash:string;
    features:RiskFeatures;assessedAt:string;options?:Partial<RiskPolicyOptions>}):RiskAssessment{
    const run=this.ledger.getRun(input.runId);
    if(!this.isOptionalHardeningChild(run.runId)||run.stateVersion!==input.expectedStateVersion)
      throw new InvalidTransitionError("optional-hardening final risk authority changed");
    const decision=assessRisk(input.features,input.options??{}),assessmentId=hardeningFinalRiskAssessmentId({
      runId:run.runId,checkpointHash:input.checkpointHash,featuresHash:sha256(decision.features),
      ruleVersion:decision.ruleVersion});
    return this.riskAssessmentFromDecision(run,decision,assessmentId,input.assessedAt);
  }

  private riskAssessmentFromDecision(run:EngineerRun,decision:RiskDecision,assessmentId:string,
    assessedAt:string):RiskAssessment{
    const rank: Record<RiskTier, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };
    const retainPriorFloor = run.manifestHash !== null || rank[run.riskTier] >= rank.HIGH;
    const riskTier = retainPriorFloor && rank[decision.riskTier] < rank[run.riskTier] ? run.riskTier : decision.riskTier;
    const retainedFloor = riskTier !== decision.riskTier;
    return RiskAssessmentSchema.parse({
      assessmentId,
      runId:run.runId,
      riskTier,
      humanGateRequired: (retainPriorFloor && run.humanGateRequired) || decision.humanGateRequired || riskTier !== "LOW",
      ruleVersion: decision.ruleVersion,
      matchedRules: retainedFloor ? [...decision.matchedRules, "PRIOR_RISK_TIER_FLOOR"] : decision.matchedRules,
      features: decision.features,
      assessedAt,
    });
  }

  authorizeRetry(input: AuthorizeRetryInput): RetryDecision {
    const run = this.ledger.getRun(input.runId);
    if (run.stateVersion !== input.expectedStateVersion) {
      throw new StateVersionConflictError(input.runId, input.expectedStateVersion, run.stateVersion);
    }
    const budgets = this.ledger.getManifest(input.runId)?.retryBudgets ?? RetryBudgetsSchema.parse({});
    const history = this.ledger.listRetryHistory(input.runId);
    const prior = input.kind === "REVIEWER_FIX" ? [...history].reverse().find((item) => item.kind === input.kind &&
      item.failureFingerprint === input.failureFingerprint && item.patchHash === (input.patchHash ?? null) &&
      item.progressMetric === (input.progressMetric ?? null)) : undefined;
    if (prior) {
      const kindBudget = input.kind === "BUILDER_REPAIR" ? budgets.builderRepairAttempts
        : input.kind === "REVIEWER_FIX" ? budgets.reviewerFixAttempts
          : input.kind === "PLANNER_RESTART" ? budgets.plannerRestarts
            : input.kind === "SANDBOX_PROVISIONING" ? budgets.sandboxProvisioningAttempts
              : budgets.transientModelAttempts;
      const attemptNumber = history.filter((item) => item.kind === input.kind && item.allowed).length;
      return {
        allowed: prior.allowed,
        reasonCode: prior.reasonCode,
        attemptNumber: Math.max(1, attemptNumber),
        remainingKindAttempts: Math.max(0, kindBudget - attemptNumber),
        policyVersion: prior.policyVersion as "retry-policy-v2",
      };
    }
    const decision = evaluateRetry(input, history, budgets);
    this.ledger.recordRetry({
      id: this.idFactory(),
      runId: input.runId,
      kind: input.kind,
      attemptNumber: decision.attemptNumber,
      failureFingerprint: input.failureFingerprint,
      patchHash: input.patchHash,
      progressMetric: input.progressMetric,
      allowed: decision.allowed,
      reasonCode: decision.reasonCode,
      policyVersion: decision.policyVersion,
      createdAt: this.timestamp(),
    });
    return decision;
  }

  retryAttemptCount(runId: string): number {
    return this.ledger.retryAttemptCount(runId);
  }

  createDecision(input: CreateDecisionInput): DecisionRecord {
    const currentRun = this.ledger.getRun(input.runId);
    const suppliedFactors = DecisionFactorsSchema.parse(input.factors);
    const factors = DecisionFactorsSchema.parse({
      ...suppliedFactors,
      raisesRisk: suppliedFactors.raisesRisk || input.options.some((option) => {
        const order = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 } as const;
        return option.optionId === input.recommendedOptionId && order[option.riskTier] > order[currentRun.riskTier];
      }),
      riskFloorRequiresHuman: suppliedFactors.riskFloorRequiresHuman || currentRun.riskTier !== "LOW",
    });
    const options = input.options.map((option) => DecisionOptionSchema.parse(option));
    const sourceEvidence = input.sourceEvidence.map((evidence) => DecisionEvidenceReferenceSchema.parse(evidence));
    const question = input.question.trim();
    if (!question) throw new InvalidTransitionError("decision question must not be empty");
    const policy = classifyDecisionFactors(factors);
    const existing = this.ledger.findDecisionByIdempotency(input.runId, input.idempotencyKey);
    if (existing) {
      const same = canonicalJson({
        question: existing.question,
        factors: existing.factors,
        options: existing.options,
        recommendedOptionId: existing.recommendedOptionId,
        sourceEvidence: existing.sourceEvidence,
        classification: existing.classification,
        reasonCodes: existing.reasonCodes,
      }) === canonicalJson({
        question,
        factors,
        options,
        recommendedOptionId: input.recommendedOptionId,
        sourceEvidence,
        classification: policy.classification,
        reasonCodes: policy.reasonCodes,
      });
      if (!same) throw new IdempotencyConflictError(input.runId, input.idempotencyKey);
      this.applyDecisionSideEffect(existing, input.expectedStateVersion);
      return existing;
    }

    const run = currentRun;
    if (run.stateVersion !== input.expectedStateVersion) {
      throw new StateVersionConflictError(input.runId, input.expectedStateVersion, run.stateVersion);
    }
    if (isTerminalState(run.state)) throw new InvalidTransitionError(`terminal state ${run.state} cannot create a decision`);
    if (policy.classification === "ASK_NOW" &&
        !["REQUEST_NORMALIZED", "PLANNING", "PLAN_READY", "REPLANNING", "CLARIFICATION_REQUIRED"].includes(run.state)) {
      throw new InvalidTransitionError(`ASK_NOW cannot safely interrupt ${run.state}`);
    }
    const createdAt = this.timestamp();
    const content = DecisionRecordContentSchema.parse({
      decisionId: this.idFactory(),
      runId: run.runId,
      question,
      classification: policy.classification,
      reasonCodes: policy.reasonCodes,
      factors,
      options,
      recommendedOptionId: input.recommendedOptionId,
      sourceEvidence,
      policyVersion: DECISION_POLICY_VERSION,
      requestedState: run.state,
      resumeAction: policy.classification === "ASK_NOW"
        ? (run.state === "REQUEST_NORMALIZED" ? "PLAN" : "REPLAN")
        : "NONE",
      status: "OPEN",
      idempotencyKey: input.idempotencyKey,
      createdAt,
    });
    const decision = DecisionRecordSchema.parse({ ...content, decisionHash: sha256(content) });
    this.ledger.recordDecision(decision);
    this.applyDecisionSideEffect(decision, input.expectedStateVersion);
    return decision;
  }

  resolveDecision(input: ResolveDecisionInput): DecisionResolution {
    const decision = this.ledger.getDecision(input.runId, input.decisionId);
    if (decision.classification === "AUTO") throw new InvalidTransitionError("AUTO decisions are Supervisor-resolved");
    if (!decision.options.some((option) => option.optionId === input.selectedOptionId)) {
      throw new InvalidTransitionError("selected decision option does not exist");
    }
    const sourceEvidence = input.sourceEvidence.map((evidence) => DecisionEvidenceReferenceSchema.parse(evidence));
    const rationale = input.rationale.trim();
    if (!rationale) throw new InvalidTransitionError("decision resolution rationale must not be empty");
    const existing = this.ledger.getDecisionResolution(input.runId, input.decisionId);
    if (existing) {
      const same = existing.idempotencyKey === input.idempotencyKey &&
        existing.selectedOptionId === input.selectedOptionId && existing.actorId === input.actorId &&
        existing.rationale === rationale && canonicalJson(existing.sourceEvidence) === canonicalJson(sourceEvidence);
      if (!same) throw new IdempotencyConflictError(input.runId, input.idempotencyKey);
      this.resumeResolvedDecision(decision, existing, input.expectedStateVersion);
      return existing;
    }
    const run = this.ledger.getRun(input.runId);
    if (run.stateVersion !== input.expectedStateVersion) {
      throw new StateVersionConflictError(input.runId, input.expectedStateVersion, run.stateVersion);
    }
    if (decision.classification === "ASK_NOW" && run.state !== "CLARIFICATION_REQUIRED") {
      throw new InvalidTransitionError("ASK_NOW may only resolve while CLARIFICATION_REQUIRED");
    }
    const resolvedAt = this.timestamp();
    const content = DecisionResolutionContentSchema.parse({
      resolutionId: this.idFactory(),
      decisionId: decision.decisionId,
      runId: decision.runId,
      selectedOptionId: input.selectedOptionId,
      actorType: "HUMAN",
      actorId: input.actorId,
      rationale,
      sourceEvidence,
      policyVersion: DECISION_POLICY_VERSION,
      status: "RESOLVED",
      idempotencyKey: input.idempotencyKey,
      resolvedAt,
    });
    const resolution = DecisionResolutionSchema.parse({ ...content, resolutionHash: sha256(content) });
    return this.ledger.atomic(() => {
      this.ledger.recordDecisionResolution(resolution);
      this.resumeResolvedDecision(decision, resolution, input.expectedStateVersion);
      return resolution;
    });
  }

  listDecisions(runId: string): DecisionRecord[] {
    return this.ledger.listDecisions(runId);
  }

  listOpenDecisions(runId: string): DecisionRecord[] {
    return this.ledger.listOpenDecisions(runId);
  }

  getDecisionResolution(runId: string, decisionId: string): DecisionResolution | null {
    return this.ledger.getDecisionResolution(runId, decisionId);
  }

  getRun(runId: string): EngineerRun {
    return this.ledger.getRun(runId);
  }

  listRuns(states?: RunState[]): EngineerRun[] {
    return this.ledger.listRuns(states);
  }

  listRunsForUser(userId: string, limit = 50, before?: { createdAt: string; runId: string }): EngineerRun[] {
    return this.ledger.listRunsForUser(userId, limit, before);
  }

  listRunObservability(ownerId?: string): RunObservabilityProjection[] {
    return this.ledger.listRunObservability(ownerId);
  }

  listFailureClassObservability(ownerId?: string): FailureClassProjection[] {
    return this.ledger.listFailureClassObservability(ownerId);
  }

  getManifest(runId: string, version?: number): TaskManifest | null {
    return this.ledger.getManifest(runId, version);
  }

  listManifestVersions(runId: string): TaskManifest[] {
    return this.ledger.listManifestVersions(runId);
  }

  recordPlanProposal(proposal: PlanProposal): PlanProposal {
    const run = this.ledger.getRun(proposal.runId);
    if (run.state !== "PLANNING" && run.state !== "REPLANNING") {
      throw new InvalidTransitionError("plan proposals may only be recorded while PLANNING or REPLANNING");
    }
    const context = this.ledger.latestContextSnapshot(proposal.runId);
    if (!context || context.manifest.manifestHash !== proposal.contextManifestHash) {
      throw new ManifestIntegrityError("plan proposal is not bound to the latest persisted context manifest");
    }
    return this.ledger.recordPlanProposal(proposal, run.stateVersion);
  }

  latestPlanProposal(runId: string): PlanProposal | null {
    return this.ledger.latestPlanProposal(runId);
  }

  recordContextSnapshot(snapshot: StoredContextSnapshot): StoredContextSnapshot {
    const parsed = StoredContextSnapshotSchema.parse(snapshot);
    const run = this.ledger.getRun(parsed.manifest.runId);
    if (run.state !== "REQUEST_RECEIVED" && run.state !== "PLANNING") {
      throw new InvalidTransitionError("context may only be recorded before or during planning");
    }
    if (parsed.manifest.repositoryId !== run.repository.repositoryId ||
        parsed.manifest.baseCommitSha.toLowerCase() !== run.repository.baseCommitSha.toLowerCase() ||
        parsed.manifest.requestHash !== sha256(run.requestOriginal)) {
      throw new ManifestIntegrityError("context snapshot does not match the run repository, exact base, and request");
    }
    return this.ledger.recordContextSnapshot(parsed, run.stateVersion);
  }

  latestContextSnapshot(runId: string): StoredContextSnapshot | null {
    return this.ledger.latestContextSnapshot(runId);
  }

  listEvents(runId: string, afterSequence = 0, limit = 1_000): RunStateEvent[] {
    return this.ledger.listEvents(runId, afterSequence, limit);
  }

  latestEventSequence(runId: string): number {
    return this.ledger.latestEventSequence(runId);
  }

  exportRunRecords(runId: string): Record<string, Array<Record<string, unknown>>> {
    return this.ledger.exportRunRecords(runId);
  }

  exportRunRecordTables(runId: string): RunExportTable[] {
    return this.ledger.exportRunRecordTables(runId);
  }

  exportRunRecordPage(runId: string, table: RunExportTable, offset: number, limit = 500): Array<Record<string, unknown>> {
    return this.ledger.exportRunRecordPage(runId, table, offset, limit);
  }

  configureCheckpointAttestor(attestor:CheckpointAttestor):void{this.checkpointAttestor=attestor;}
  /**
   * Bind the gateway-held resolution directive-signing secret so replacement-run
   * promotion / approval / publication authority is gated on verified lineage
   * (fail closed until configured). Composition-root use only; the secret is
   * confined to this process and never handed to a model or sandbox.
   */
  configureResolutionSigningSecret(secret:string):void{this.ledger.configureResolutionSigningSecret(secret);}
  /**
   * P11: bind the gateway-held confined signing secret so a durable APPROVE
   * atomically emits + persists a signed provenance attestation. Composition-root
   * use only; the secret is never handed to a model or sandbox.
   */
  configureProvenanceAttestationSigner(secret:string,keyId:string):void{this.ledger.configureProvenanceAttestationSigner(secret,keyId);}
  private advisoryAttestor():CheckpointAttestor{if(!this.checkpointAttestor)throw new AdvisoryIntegrityError();return this.checkpointAttestor;}
  listAdvisoryBacklogForOwner(ownerId:string,runId:string,options:{limit?:number;cursor?:string;status?:"OPEN"|"DEFERRED"|"DISMISSED";actionability?:"ACTIONABLE"|"AUDIT_ONLY"}={}):Promise<AdvisoryBacklogPage>{return this.ledger.listAdvisoryBacklogForOwner(ownerId,runId,options,this.advisoryAttestor());}
  deferAdvisoryForOwner(ownerId:string,runId:string,advisoryId:string,command:AdvisoryOwnerCommand){return this.ledger.applyAdvisoryOwnerAction(ownerId,runId,advisoryId,"DEFER",command,this.advisoryAttestor());}
  dismissAdvisoryForOwner(ownerId:string,runId:string,advisoryId:string,command:AdvisoryOwnerCommand){return this.ledger.applyAdvisoryOwnerAction(ownerId,runId,advisoryId,"DISMISS",command,this.advisoryAttestor());}
  reopenAdvisoryForOwner(ownerId:string,runId:string,advisoryId:string,command:AdvisoryOwnerCommand){return this.ledger.applyAdvisoryOwnerAction(ownerId,runId,advisoryId,"REOPEN",command,this.advisoryAttestor());}
  createHardeningQuoteForOwner(ownerId:string,input:HardeningQuoteRequest){return this.ledger.createHardeningQuoteForOwner(ownerId,input,this.advisoryAttestor());}
  getHardeningQuoteForOwner(ownerId:string,runId:string,quoteId:string){return this.ledger.getHardeningQuoteForOwner(ownerId,runId,quoteId,this.advisoryAttestor());}
  acceptHardeningConsentForOwner(ownerId:string,runId:string,input:HardeningConsentRequest){return this.ledger.acceptHardeningConsentForOwner(ownerId,runId,input,this.advisoryAttestor());}
  createOptionalHardeningChildForOwner(ownerId:string,parentRunId:string,input:OptionalHardeningChildRequest){return this.ledger.createOptionalHardeningChildForOwner(ownerId,parentRunId,input,this.advisoryAttestor());}
  listOptionalHardeningStartOperationsForOwner(ownerId:string){return this.ledger.listOptionalHardeningStartOperationsForOwner(ownerId);}
  isOptionalHardeningChild(runId:string){return this.ledger.isOptionalHardeningChild(runId);}
  getHardeningChildBudgetAuthority(childRunId:string){return this.ledger.getHardeningChildBudgetAuthority(childRunId);}
  acquireHardeningExecutionFence(input:Parameters<EngineerLedger["acquireHardeningExecutionFence"]>[0]){
    return this.ledger.acquireHardeningExecutionFence(input);
  }
  assertHardeningExecutionFence(input:Parameters<EngineerLedger["assertHardeningExecutionFence"]>[0]){
    return this.ledger.assertHardeningExecutionFence(input);
  }
  renewHardeningExecutionFence(input:Parameters<EngineerLedger["renewHardeningExecutionFence"]>[0]){
    return this.ledger.renewHardeningExecutionFence(input);
  }
  releaseHardeningExecutionFence(input:Parameters<EngineerLedger["releaseHardeningExecutionFence"]>[0]){
    return this.ledger.releaseHardeningExecutionFence(input);
  }
  reserveHardeningPaidCall(input:Parameters<EngineerLedger["reserveHardeningPaidCall"]>[0]){
    this.strictArtifactReader(input.childRunId);
    return this.ledger.reserveHardeningPaidCall(input);
  }
  markHardeningPaidCallDispatching(input:Parameters<EngineerLedger["markHardeningPaidCallDispatching"]>[0]){
    this.strictArtifactReader(input.childRunId);
    return this.ledger.markHardeningPaidCallDispatching(input);
  }
  recordHardeningPaidCallResponse(input:Parameters<EngineerLedger["recordHardeningPaidCallResponse"]>[0]){
    this.strictArtifactReader(input.childRunId);
    return this.ledger.recordHardeningPaidCallResponse(input);
  }
  recoverHardeningPaidCall(input:Parameters<EngineerLedger["recoverHardeningPaidCall"]>[0]){
    this.strictArtifactReader(input.childRunId);
    return this.ledger.recoverHardeningPaidCall(input);
  }
  hardeningPaidCallRecoveryReady(childRunId:string,nowMs:number){
    return this.ledger.hardeningPaidCallRecoveryReady(childRunId,nowMs);
  }
  voidHardeningPaidCallUnsent(input:Parameters<EngineerLedger["voidHardeningPaidCallUnsent"]>[0]){
    this.strictArtifactReader(input.childRunId);
    return this.ledger.voidHardeningPaidCallUnsent(input);
  }
  listOpenHardeningPaidCallReservations(childRunId?:string){return this.ledger.listOpenHardeningPaidCallReservations(childRunId);}
  listPendingHardeningPaidCallFinalizations(childRunId?:string){return this.ledger.listPendingHardeningPaidCallFinalizations(childRunId);}
  hasOutstandingHardeningPaidCallRecoveryWork(childRunId:string){
    return this.ledger.hasOutstandingHardeningPaidCallRecoveryWork(childRunId);
  }
  /**
   * The only production consumer for paid-call finalization intents. Claim,
   * exact successor proof, and APPLIED transition share one Engineer DB
   * transaction, so corruption can never land between validation and apply.
   */
  consumeHardeningPaidCallFinalization(input:Parameters<EngineerLedger["claimHardeningPaidCallFinalization"]>[0]&{
    expectedSuccessor:"SUCCESS"|"RECOVERY_TERMINAL";
  }){
    return this.ledger.atomic(()=>{
      const claimed=this.ledger.claimHardeningPaidCallFinalization(input);
      if(claimed.role!=="BUILDER"&&claimed.role!=="REVIEWER")
        throw new InvalidTransitionError("hardening paid-call finalization role is invalid");
      const exact=input.expectedSuccessor==="RECOVERY_TERMINAL"
        ?this.ledger.hasExactHardeningRecoveryTerminalSuccessor({childRunId:claimed.childRunId,
          reservationId:claimed.reservationId,agentExecutionId:claimed.agentExecutionId,role:claimed.role,
          expectedRunState:claimed.expectedRunState,expectedStateVersion:claimed.expectedStateVersion},
          this.strictArtifactReader(claimed.childRunId))
        :claimed.role==="BUILDER"
          ?this.ledger.hasExactHardeningBuilderSuccessor({childRunId:claimed.childRunId,
            reservationId:claimed.reservationId,agentExecutionId:claimed.agentExecutionId,
            expectedRunState:claimed.expectedRunState,expectedStateVersion:claimed.expectedStateVersion},
            this.strictArtifactReader(claimed.childRunId))
          :this.ledger.hasExactHardeningReviewerSuccessor({childRunId:claimed.childRunId,
            reservationId:claimed.reservationId,agentExecutionId:claimed.agentExecutionId},
            this.strictArtifactReader(claimed.childRunId));
      if(!exact)throw new InvalidTransitionError("hardening paid-call finalization lacks its exact deterministic successor");
      return this.ledger.applyHardeningPaidCallFinalization(input);
    });
  }
  recoverHardeningPaidCallLifecycle(input:{childRunId:string;ownerId:string;rawToken:string;nowMs:number;
    /** Capability for an ACTIVE lease on the exact run resource. */
    recoveryWorkerLease:RecoveryWorkerLeaseProof}):{
      recoveredReservations:number;appliedFinalizations:number;terminalizedPreReservationAgent:boolean;
    }{
    const authority=this.recoveryWorkerLeaseAuthority;
    if(!authority)throw new InvalidTransitionError("hardening recovery worker-lease authority is not configured");
    try{return authority.withActiveLease(input.recoveryWorkerLease,(activeRecoveryLease)=>{
      // The authority holds worker-leases.db BEGIN IMMEDIATE for this entire
      // synchronous callback. Global lock order is worker DB -> Engineer DB;
      // this callback must never re-enter the WorkerLeaseManager.
      const lease=activeRecoveryLease;
      if(lease.status!=="ACTIVE"||lease.resourceKey!==`run:${input.childRunId}`||lease.ownerId!==input.ownerId||
          lease.leaseId!==input.recoveryWorkerLease.leaseId||lease.fencingToken!==input.recoveryWorkerLease.fencingToken){
        throw new InvalidTransitionError("hardening recovery lease does not bind the exact run and owner");
      }
      return this.ledger.atomic(()=>{
    if(!this.isOptionalHardeningChild(input.childRunId)){
      return {recoveredReservations:0,appliedFinalizations:0,terminalizedPreReservationAgent:false};
    }
    // Recheck after the external run lease is held and inside the Engineer DB
    // transaction. A gateway pre-gate can race with another recovery worker;
    // zero-work runs must not advance the durable recovery fence.
    if(!this.ledger.hasOutstandingHardeningPaidCallRecoveryWork(input.childRunId)){
      return {recoveredReservations:0,appliedFinalizations:0,terminalizedPreReservationAgent:false};
    }
    const paidFenceGone=this.ledger.hardeningPaidCallRecoveryReady(input.childRunId,input.nowMs);
    if(!paidFenceGone){
      return {recoveredReservations:0,appliedFinalizations:0,terminalizedPreReservationAgent:false};
    }
    this.ledger.claimHardeningRecoveryWorkerFence({childRunId:input.childRunId,workerLeaseId:activeRecoveryLease.leaseId,
      workerOwnerId:activeRecoveryLease.ownerId,workerFencingToken:activeRecoveryLease.fencingToken,
      rawWorkerLeaseToken:input.recoveryWorkerLease.leaseToken,nowMs:input.nowMs});
    const openAtStart=this.ledger.listOpenHardeningPaidCallReservations(input.childRunId);
    const pendingAtStart=this.ledger.listPendingHardeningPaidCallFinalizations(input.childRunId);
    const recoveryHead=this.getRun(input.childRunId);
    const terminalStop:(null|{
      budgetReason:"FAILED"|"CANCELLED"|"SECURITY_BLOCKED"|"ENVIRONMENT_BLOCKED";
      advisoryReason:"FAILED"|"CANCELLED"|"BUDGET_EXHAUSTED"|"TIMED_OUT"|"SECURITY_BLOCKED"|"ENVIRONMENT_BLOCKED";
    })=recoveryHead.state==="CANCELLED"||recoveryHead.state==="CANCELLATION_PENDING"
      ?{budgetReason:"CANCELLED",advisoryReason:"CANCELLED"}
      :recoveryHead.state==="TIMED_OUT"
        ?{budgetReason:"FAILED",advisoryReason:"TIMED_OUT"}
        :recoveryHead.state==="RETRY_BUDGET_EXHAUSTED"
          ?{budgetReason:"FAILED",advisoryReason:"BUDGET_EXHAUSTED"}
          :recoveryHead.state==="SECURITY_ESCALATION"
            ?{budgetReason:"SECURITY_BLOCKED",advisoryReason:"SECURITY_BLOCKED"}
            :recoveryHead.state==="BLOCKED_BY_ENVIRONMENT"||recoveryHead.state==="BLOCKED_BY_EXTERNAL_DEPENDENCY"
              ?{budgetReason:"ENVIRONMENT_BLOCKED",advisoryReason:"ENVIRONMENT_BLOCKED"}
              :recoveryHead.state==="FAILED"||recoveryHead.state==="REJECTED"||
                  recoveryHead.state==="VERIFICATION_INCOMPLETE"||recoveryHead.state==="ROLLED_BACK"
                ?{budgetReason:"FAILED",advisoryReason:"FAILED"}
                :null;
    let recoveredReservations=0,appliedFinalizations=0;
    for(const open of openAtStart){
      this.ledger.recoverHardeningPaidCall({childRunId:input.childRunId,reservationId:open.reservationId,
        recoveryOwnerId:input.ownerId,recoveryIdempotencyKey:sha256({namespace:"engineer-hardening-paid-call-recovery-v1",
          childRunId:input.childRunId,reservationId:open.reservationId,ownerId:input.ownerId}),rawRecoveryToken:input.rawToken,nowMs:input.nowMs});
      recoveredReservations+=1;
    }
    for(const pending of this.ledger.listPendingHardeningPaidCallFinalizations(input.childRunId)){
      const idempotencyKey=sha256({namespace:"engineer-hardening-paid-call-finalization-consumer-v1",finalizationId:pending.id,ownerId:input.ownerId});
      let run=this.getRun(input.childRunId);
      const successorExists=pending.role==="BUILDER"
        ?this.ledger.hasExactHardeningBuilderSuccessor({childRunId:input.childRunId,reservationId:pending.reservationId,
          agentExecutionId:pending.agentExecutionId,expectedRunState:pending.expectedRunState,
          expectedStateVersion:pending.expectedStateVersion},this.strictArtifactReader(input.childRunId))
        :this.ledger.hasExactHardeningReviewerSuccessor({childRunId:input.childRunId,reservationId:pending.reservationId,
          agentExecutionId:pending.agentExecutionId},this.strictArtifactReader(input.childRunId));
      if(!successorExists){
        const completedAt=new Date(input.nowMs).toISOString();
        this.ledger.finalizeRunningAgentExecutions(input.childRunId,"FAILED",completedAt,"HARDENING_PAID_CALL_RECOVERY_TERMINAL");
        run=this.getRun(input.childRunId);
        // A paid response can be durable while a stale worker advances the run
        // before crashing. Exact successor validation is the authority: if it
        // fails, every still-active verification state must converge rather
        // than being stranded merely because the original CAS version moved.
        const cancellationIntent=run.state==="CANCELLED"||run.state==="CANCELLATION_PENDING";
        if(!cancellationIntent&&canTransition(run.state,"FAILED")){
          run=this.transition({runId:run.runId,expectedStateVersion:run.stateVersion,nextState:"FAILED",
            reasonCode:"HARDENING_PAID_CALL_RECOVERY_TERMINAL",actorType:"SUPERVISOR",actorId:"hardening-paid-call-recovery",
            evidenceIds:[pending.reconciliationId],manifestHash:run.manifestHash,
            idempotencyKey:`hardening-paid-call-recovery:${pending.id}:${input.recoveryWorkerLease.fencingToken}`}).run;
        }
        const cancelled=cancellationIntent||run.state==="CANCELLED"||run.state==="CANCELLATION_PENDING";
        const stop=terminalStop??(cancelled?{budgetReason:"CANCELLED" as const,advisoryReason:"CANCELLED" as const}:
          {budgetReason:"FAILED" as const,advisoryReason:"FAILED" as const});
        this.ledger.stopHardeningChildBudgetForRecovery(input.childRunId,stop.budgetReason,input.nowMs);
        this.ledger.recordOptionalHardeningStopped(input.childRunId,stop.advisoryReason);
      }
      this.consumeHardeningPaidCallFinalization({finalizationId:pending.id,ownerId:input.ownerId,rawToken:input.rawToken,
        idempotencyKey,nowMs:input.nowMs,expectedSuccessor:successorExists?"SUCCESS":"RECOVERY_TERMINAL"});
      appliedFinalizations+=1;
    }
    // C0: a crash can happen after the paid agent is durable but before the
    // first reservation exists. With the worker lease absent and no paid fence,
    // that generation has no authority to continue. It must converge instead
    // of being redispatched or left RUNNING forever.
    const records=this.ledger.exportRunRecords(input.childRunId);
    const reservations=records.hardening_child_model_reservations??[];
    const preReservationRunning=(records.agent_executions??[]).filter((agent)=>agent.status==="RUNNING"&&
      (agent.role==="BUILDER"||agent.role==="REVIEWER")&&!reservations.some((reservation)=>
        reservation.agent_execution_id===agent.id));
    let terminalizedPreReservationAgent=false;
    if(preReservationRunning.length>0&&paidFenceGone&&pendingAtStart.length===0){
      let run=this.getRun(input.childRunId);
      this.ledger.finalizeRunningAgentExecutions(input.childRunId,"FAILED",new Date(input.nowMs).toISOString(),
        "HARDENING_PRE_RESERVATION_AGENT_INTERRUPTED");
      run=this.getRun(input.childRunId);
      if((run.state==="IMPLEMENTING"||run.state==="REVIEWING")&&canTransition(run.state,"FAILED")){
        run=this.transition({runId:run.runId,expectedStateVersion:run.stateVersion,nextState:"FAILED",
          reasonCode:"HARDENING_PRE_RESERVATION_AGENT_INTERRUPTED",actorType:"SUPERVISOR",actorId:"hardening-paid-call-recovery",
          evidenceIds:[],manifestHash:run.manifestHash,
          idempotencyKey:`hardening-pre-reservation-recovery:${input.recoveryWorkerLease.fencingToken}:${run.stateVersion}`}).run;
      }
      const cancelled=run.state==="CANCELLED"||run.state==="CANCELLATION_PENDING";
      const stop=terminalStop??(cancelled?{budgetReason:"CANCELLED" as const,advisoryReason:"CANCELLED" as const}:
        {budgetReason:"FAILED" as const,advisoryReason:"FAILED" as const});
      this.ledger.stopHardeningChildBudgetForRecovery(input.childRunId,stop.budgetReason,input.nowMs);
      this.ledger.recordOptionalHardeningStopped(input.childRunId,stop.advisoryReason);
      terminalizedPreReservationAgent=true;
    }
    // Reconcile every reserved/possibly-sent call before applying the workflow
    // terminal intent. Accounting owns the first stop cause
    // (MODEL_DISPATCH_NOT_STARTED / MODEL_USAGE_AMBIGUOUS); cancellation is a
    // separate run/advisory outcome and must never overwrite that evidence.
    if(terminalStop){
      this.ledger.stopHardeningChildBudgetForRecovery(input.childRunId,terminalStop.budgetReason,input.nowMs);
      this.ledger.recordOptionalHardeningStopped(input.childRunId,terminalStop.advisoryReason);
    }
    return {recoveredReservations,appliedFinalizations,terminalizedPreReservationAgent};
    });
    });}catch(error){
      if(error instanceof StaleWorkerLeaseError){
        throw new InvalidTransitionError("hardening recovery requires an active authenticated run lease");
      }
      throw error;
    }
  }
  settleHardeningPaidCall(input:Parameters<EngineerLedger["settleHardeningPaidCall"]>[0]){
    this.strictArtifactReader(input.childRunId);
    return this.ledger.settleHardeningPaidCall(input);
  }
  claimOptionalHardeningStart(input:Parameters<EngineerLedger["claimOptionalHardeningStart"]>[0]){
    return this.ledger.claimOptionalHardeningStart(input);
  }
  listExpiredOptionalHardeningStartClaimsForOwner(ownerId:string){
    return this.ledger.listExpiredOptionalHardeningStartClaimsForOwner(ownerId);
  }
  listOptionalHardeningStartClaimsForRecovery(ownerId:string){return this.ledger.listOptionalHardeningStartClaimsForRecovery(ownerId);}
  getFinalizedOptionalHardeningStartClaim(childRunId:string){return this.ledger.getFinalizedOptionalHardeningStartClaim(childRunId);}
  hasExactHardeningBuilderSuccessor(input:Parameters<EngineerLedger["hasExactHardeningBuilderSuccessor"]>[0]){
    return this.ledger.hasExactHardeningBuilderSuccessor(input,this.strictArtifactReader(input.childRunId));
  }
  hasExactHardeningReviewerSuccessor(input:Parameters<EngineerLedger["hasExactHardeningReviewerSuccessor"]>[0]){
    return this.ledger.hasExactHardeningReviewerSuccessor(input,this.strictArtifactReader(input.childRunId));
  }
  finalizeOptionalHardeningStartClaim(input:Parameters<EngineerLedger["finalizeOptionalHardeningStartClaim"]>[0]){
    return this.ledger.finalizeOptionalHardeningStartClaim(input);
  }
  recordOptionalHardeningStopped(runId:string,reason:"FAILED"|"CANCELLED"|"BUDGET_EXHAUSTED"|"TIMED_OUT"|"SECURITY_BLOCKED"|"ENVIRONMENT_BLOCKED"){
    return this.ledger.recordOptionalHardeningStopped(runId,reason);
  }
  /**
   * Provider-free, idempotent quarantine for a restart whose signed workspace
   * or Reviewer footprint cannot be reconstructed exactly. The failure,
   * budget/advisory stop, stable UI guidance, and terminal state are one
   * Supervisor transaction.
   */
  quarantineOptionalHardeningRecovery(input:{runId:string;expectedStateVersion:number;
    reasonCode:"HARDENING_WORKSPACE_RECOVERY_AUTHORITY_INVALID"|"HARDENING_REVIEWER_RECOVERY_AUTHORITY_INVALID"}){
    if(!this.isOptionalHardeningChild(input.runId))throw new InvalidTransitionError("recovery quarantine requires an optional-hardening child");
    const guidance=input.reasonCode==="HARDENING_REVIEWER_RECOVERY_AUTHORITY_INVALID"
      ?"HARDENING_REVIEWER_RECOVERY_AUTHORITY_INVALID: Optional hardening stopped safely because its durable Reviewer footprint is partial, ambiguous, or does not match the classified result. Inspect retained evidence and start a new bounded hardening run if needed."
      :"HARDENING_WORKSPACE_RECOVERY_AUTHORITY_INVALID: Optional hardening stopped safely because its signed workspace recovery authority is missing, ambiguous, or does not match retained bytes. Start a new bounded hardening run from the last verified parent candidate.";
    const failureId=sha256({namespace:"engineer-optional-hardening-recovery-quarantine-v1",runId:input.runId,
      reasonCode:input.reasonCode});
    return this.ledger.atomic(()=>{
      let current=this.getRun(input.runId);
      const failure=FailureRecordSchema.parse({failureId,runId:input.runId,failureClass:"SECURITY_FAILURE",
        reasonCode:input.reasonCode,fingerprint:sha256({runId:input.runId,manifestHash:current.manifestHash,
          reasonCode:input.reasonCode}),evidenceIds:[],retryable:false,createdAt:this.timestamp()});
      const existing=this.ledger.listFailures(input.runId).find((item)=>item.failureId===failureId);
      if(existing&&canonicalJson({...existing,createdAt:failure.createdAt})!==canonicalJson(failure))
        throw new IdempotencyConflictError(input.runId,failureId);
      if(current.state==="FAILED"){
        const latest=this.listEvents(input.runId).at(-1);
        if(!existing||latest?.reasonCode!==input.reasonCode||this.ledger.getLastError(input.runId)!==guidance)
          throw new IdempotencyConflictError(input.runId,`hardening-recovery-quarantine:${failureId}`);
        return current;
      }
      if(current.stateVersion!==input.expectedStateVersion)
        throw new StateVersionConflictError(input.runId,input.expectedStateVersion,current.stateVersion);
      if(!canTransition(current.state,"FAILED"))throw new InvalidTransitionError(`cannot quarantine optional hardening from ${current.state}`);
      if(!existing)this.ledger.recordFailure(failure);
      const nowMs=Date.parse(failure.createdAt);
      this.ledger.stopHardeningChildBudgetForRecovery(input.runId,"SECURITY_BLOCKED",nowMs);
      this.ledger.recordOptionalHardeningStopped(input.runId,"SECURITY_BLOCKED");
      this.ledger.setLastError(input.runId,guidance,failure.createdAt);
      current=this.transition({runId:input.runId,expectedStateVersion:current.stateVersion,nextState:"FAILED",
        reasonCode:input.reasonCode,actorType:"SUPERVISOR",actorId:"hardening-recovery-quarantine",evidenceIds:[],
        manifestHash:current.manifestHash,idempotencyKey:`hardening-recovery-quarantine:${failureId}`}).run;
      return current;
    });
  }
  /**
   * Fail-closed boundary for a child whose inherited required test is stably
   * failing.  The failure, advisory stop markers, and frozen human-review
   * state are one transaction: a crash cannot expose only part of the stop.
   */
  stopOptionalHardeningForStableRequiredTest(record: import("./control-contracts.js").FailureRecord) {
    const parsed = FailureRecordSchema.parse(record);
    this.getRun(parsed.runId);
    if (!this.isOptionalHardeningChild(parsed.runId) || parsed.failureClass !== "TEST_FAILURE" ||
        parsed.reasonCode !== "STABLE_REQUIRED_TEST_FAILED" || parsed.retryable) {
      throw new InvalidTransitionError("stable required-test stop requires a non-retryable optional-hardening test failure");
    }
    return this.ledger.atomic(() => {
      const existing = this.ledger.listFailures(parsed.runId).find((item) => item.failureId === parsed.failureId);
      if (existing && canonicalJson(existing) !== canonicalJson(parsed)) {
        throw new IdempotencyConflictError(parsed.runId, parsed.failureId);
      }
      if (!existing) this.ledger.recordFailure(parsed);
      this.ledger.recordOptionalHardeningStopped(parsed.runId, "FAILED");
      const current = this.getRun(parsed.runId);
      if (current.state === "HUMAN_REVIEW_REQUIRED") {
        const latest = this.listEvents(parsed.runId).at(-1);
        if (latest?.reasonCode !== "HARDENING_STABLE_REQUIRED_TEST_FAILED" ||
            canonicalJson(latest.evidenceIds) !== canonicalJson(parsed.evidenceIds)) {
          throw new IdempotencyConflictError(parsed.runId, `hardening-stable-stop:${parsed.failureId}`);
        }
        return current;
      }
      return this.transition({
        runId: parsed.runId,
        expectedStateVersion: current.stateVersion,
        nextState: "HUMAN_REVIEW_REQUIRED",
        reasonCode: "HARDENING_STABLE_REQUIRED_TEST_FAILED",
        evidenceIds: parsed.evidenceIds,
        manifestHash: current.manifestHash,
        idempotencyKey: `hardening-stable-stop:${parsed.failureId}`,
      }).run;
    });
  }
  prepareOptionalHardeningStartForOwner(ownerId:string,parentRunId:string,childRunId:string,input:import("./hardening-start-contracts.js").HardeningStartRequest){return this.ledger.prepareOptionalHardeningStartForOwner(ownerId,parentRunId,childRunId,input,this.advisoryAttestor());}
  commitOptionalHardeningStartForOwner(ownerId:string,parentRunId:string,childRunId:string,input:import("./hardening-start-contracts.js").HardeningStartRequest,
    operation:import("./hardening-start-contracts.js").HardeningStartOperation,signedSeed:import("./hardening-start-contracts.js").SignedHardeningSeedAttestation,
    fence:import("./ledger.js").ActiveOptionalHardeningStartFence,durable:{sandbox:SandboxRecord;checkpoint:ArtifactRecord}){
    return this.ledger.commitOptionalHardeningStartForOwner(ownerId,parentRunId,childRunId,input,operation,signedSeed,this.advisoryAttestor(),fence,
      (committed)=>{this.finalizeOptionalHardeningStart(committed);this.recordSandboxWithCheckpoint(durable.sandbox,durable.checkpoint);return durable.sandbox.sandboxId;});}
  previewOptionalHardeningStart(preparation:OptionalHardeningStartPreparation){
    return buildOptionalHardeningManifest({authority:preparation.authority,lineage:preparation.lineage,parentManifest:preparation.parentManifest,child:preparation.child});
  }
  finalizeOptionalHardeningStart(preparation:OptionalHardeningStartPreparation){
    const built=this.previewOptionalHardeningStart(preparation);
    let run=this.getRun(preparation.operation.childRunId);
    if(built.status==="ENVIRONMENT_BLOCKED"){
      if(run.state==="BLOCKED_BY_ENVIRONMENT")return {run,manifest:null,contextAuthority:built.contextAuthority,status:built.status};
      if(run.state!=="REQUEST_RECEIVED"||run.stateVersion!==0)throw new InvalidTransitionError("hardening environment block requires pristine child authority");
      run=this.transition({runId:run.runId,expectedStateVersion:run.stateVersion,nextState:"BLOCKED_BY_ENVIRONMENT",
        reasonCode:built.reasonCode,manifestHash:null,idempotencyKey:`hardening-environment-blocked:${preparation.operation.operationId}`}).run;
      return {run,manifest:null,contextAuthority:built.contextAuthority,status:built.status};
    }
    const advance=(from:RunState,to:RunState,reason:string)=>{if(run.state===from){const timestamp=this.timestamp();run=this.ledger.appendTransition({runId:run.runId,
      expectedStateVersion:run.stateVersion,previousState:from,nextState:to,reasonCode:reason,actorType:"SUPERVISOR",actorId:"engineer-supervisor",
      evidenceIds:[preparation.operation.operationId,preparation.signedSeed!.attestation.seedAttestationId],manifestHash:run.manifestHash,
      idempotencyKey:`hardening-start:${preparation.operation.operationId}:${to}`,eventId:this.idFactory(),timestamp,terminalAt:null}).run;}};
    advance("REQUEST_RECEIVED","REQUEST_NORMALIZED","HARDENING_REQUEST_NORMALIZED");advance("REQUEST_NORMALIZED","PLANNING","HARDENING_DETERMINISTIC_PLANNING");
    advance("PLANNING","PLAN_READY","HARDENING_DETERMINISTIC_PLAN_READY");
    if(run.state==="PLAN_READY")run=this.freezePlan({runId:run.runId,expectedStateVersion:run.stateVersion,manifest:TaskManifestContentSchema.parse((({manifestHash:_hash,...content})=>content)(built.manifest)),
      actorId:"engineer-supervisor",idempotencyKey:`hardening-start:${preparation.operation.operationId}:PLAN_FROZEN`}).run;
    // A start request is an idempotent authority operation, not a request to
    // rewind execution.  Once the deterministic manifest is frozen, retries
    // must return the durable child at whatever later state it has reached.
    // The exact manifest binding prevents a changed request from borrowing
    // that replay behavior.
    const durableManifest=this.getManifest(run.runId);
    if(!durableManifest||durableManifest.manifestHash!==built.manifest.manifestHash){
      throw new InvalidTransitionError(`hardening start cannot resume from ${run.state}`);
    }
    return {run,manifest:built.manifest,contextAuthority:built.contextAuthority,status:built.status};
  }

  evidenceExportSummary(runId: string) {
    return this.ledger.atomic(() => ({
      run: this.ledger.getRun(runId),
      manifest: this.ledger.getManifest(runId),
      riskAssessment: this.ledger.latestRiskAssessment(runId),
      latestEventSequence: this.ledger.latestEventSequence(runId),
      artifacts: this.ledger.listArtifacts(runId),
      claims: this.ledger.listClaimEvidence(runId),
      evidenceBundles: this.ledger.listEvidenceBundles(runId),
      tests: this.ledger.listTestExecutions(runId),
      securityFindings: this.ledger.listSecurityFindings(runId),
      failures: this.ledger.listFailures(runId),
      decisions: this.ledger.listDecisions(runId).map((decision) => ({
        decision,
        resolution: this.ledger.getDecisionResolution(runId, decision.decisionId),
      })),
    }));
  }

  evidenceExportSnapshot(runId: string) {
    return this.ledger.atomic(() => {
      const events: RunStateEvent[] = [];
      let cursor = 0;
      while (true) {
        const page = this.ledger.listEvents(runId, cursor, 10_000);
        events.push(...page);
        if (page.length < 10_000) break;
        cursor = page.at(-1)!.sequence;
      }
      const decisions = this.ledger.listDecisions(runId).map((decision) => ({
        decision,
        resolution: this.ledger.getDecisionResolution(runId, decision.decisionId),
      }));
      const latestEventSequence = this.ledger.latestEventSequence(runId);
      return {
        run: this.ledger.getRun(runId),
        manifest: this.ledger.getManifest(runId),
        riskAssessment: this.ledger.latestRiskAssessment(runId),
        events,
        latestEventSequence,
        artifacts: this.ledger.listArtifacts(runId),
        durableRecords: this.ledger.exportRunRecords(runId),
        claims: this.ledger.listClaimEvidence(runId),
        evidenceBundles: this.ledger.listEvidenceBundles(runId),
        tests: this.ledger.listTestExecutions(runId),
        securityFindings: this.ledger.listSecurityFindings(runId),
        failures: this.ledger.listFailures(runId),
        decisions,
      };
    });
  }

  latestRiskAssessment(runId: string): RiskAssessment | null {
    return this.ledger.latestRiskAssessment(runId);
  }

  preflightDurableReviewerEvidence(input:Parameters<EngineerLedger["preflightDurableReviewerEvidence"]>[0]){
    const strict=this.isOptionalHardeningChild(input.runId);
    if(strict&&!this.artifactReadAuthority)throw new InvalidTransitionError(
      "optional-hardening Reviewer evidence requires strict artifact-read authority");
    return this.ledger.preflightDurableReviewerEvidence(input,strict
      ?(artifact)=>this.artifactReadAuthority!.readVerifiedExact(artifact):undefined);
  }

  recordSandbox(record: SandboxRecord): SandboxRecord {
    return this.ledger.recordSandbox(record);
  }

  recordSandboxWithCheckpoint(record:SandboxRecord,checkpoint:ArtifactRecord):SandboxRecord{
    return this.ledger.atomic(()=>{const sandbox=this.ledger.recordSandbox(record);this.ledger.recordArtifact(checkpoint);return sandbox;});
  }

  markRunSandboxesDestroyed(runId: string, destroyedAt: string, reason: string): number {
    return this.ledger.markRunSandboxesDestroyed(runId, destroyedAt, reason);
  }

  recordArtifact(record: ArtifactRecord): ArtifactRecord {
    return this.ledger.atomic(() => {
      const artifact = this.ledger.recordArtifact(record);
      this.assertRuntimeBudget(record.runId);
      return artifact;
    });
  }

  /** Deterministic O/R writer; recovery worker wall time is never authority. */
  transitionOptionalHardeningCheckpointMilestone(input:{kind:"OPENED"|"RESUMED";artifact:ArtifactRecord;
    checkpoint:ReturnType<typeof OptionalHardeningIndependentCheckpointSchema.parse>;
    workerLease:RecoveryWorkerLeaseProof}):LedgerTransitionResult{
    return this.withRecoveryWorkerLease(input.artifact.runId,input.workerLease,()=>this.ledger.atomic(()=>{
      const run=this.ledger.getRun(input.artifact.runId);
      if(!this.artifactReadAuthority||!this.isOptionalHardeningChild(run.runId)||run.manifestHash!==input.checkpoint.manifestHash)
        throw new InvalidTransitionError("optional-hardening checkpoint milestone authority changed");
      const artifacts=this.ledger.listArtifacts(run.runId),exact=artifacts.filter((candidate)=>
        candidate.type==="INDEPENDENT_VERIFICATION_CHECKPOINT");
      if(exact.length!==1||canonicalJson(exact[0])!==canonicalJson(input.artifact)||!input.artifact.trusted||
        input.artifact.producerType!=="SYSTEM"||input.artifact.producerId!=="engineer-verification")
        throw new InvalidTransitionError("optional-hardening checkpoint milestone artifact is invalid");
      let text:string,checkpoint;try{text=new TextDecoder("utf-8",{fatal:true}).decode(
        this.artifactReadAuthority.readVerifiedExact(input.artifact));checkpoint=OptionalHardeningIndependentCheckpointSchema.parse(
          JSON.parse(text));}catch{throw new InvalidTransitionError("optional-hardening checkpoint milestone bytes are invalid");}
      if(text!==canonicalJson(checkpoint)||canonicalJson(checkpoint)!==canonicalJson(input.checkpoint))
        throw new InvalidTransitionError("optional-hardening checkpoint milestone payload is invalid");
      try{resolveHardeningArtifactAuthority({authority:checkpoint.verified.securityReportArtifact,artifacts,
        readArtifact:(candidate)=>this.artifactReadAuthority!.readVerifiedExact(candidate)});}
      catch{throw new InvalidTransitionError("optional-hardening checkpoint security report authority is invalid");}
      let chain;try{chain=validateOptionalHardeningCheckpointChain({checkpoint,artifact:input.artifact,
        events:this.ledger.listEvents(run.runId),manifestHash:checkpoint.manifestHash});}
      catch{throw new InvalidTransitionError("optional-hardening checkpoint milestone chain is invalid");}
      if(chain.completed||input.kind==="OPENED"&&(chain.opened||chain.resumed)||
        input.kind==="RESUMED"&&(!chain.opened||chain.resumed))throw new InvalidTransitionError(
          "optional-hardening checkpoint milestone is not the next exact step");
      const times=hardeningReviewerIngressTimes({headTimestamp:chain.head.timestamp,
        checkpointCreatedAt:input.artifact.createdAt,checkpointEvidence:checkpoint.verified.trustedEvidence}),
        opened=input.kind==="OPENED",nextState=opened?"VERIFICATION_RECOVERY" as const:"SECURITY_REVIEW" as const,
        reasonCode=opened?"PHASE3_PROCESS_INTERRUPTED":"INDEPENDENT_VERIFICATION_CHECKPOINT_RESUMED",
        evidenceIds=[input.artifact.artifactId,input.artifact.sha256,checkpoint.checkpointHash],
        idempotencyKey=hardeningCheckpointMilestoneKey({kind:input.kind,runId:run.runId,
          artifactId:input.artifact.artifactId,artifactHash:input.artifact.sha256,checkpointHash:checkpoint.checkpointHash,
          selectedEventId:checkpoint.selectedEventId,selectedEventSequence:checkpoint.selectedEventSequence,
          selectedEventStateVersion:checkpoint.selectedEventStateVersion,selectedEventHash:checkpoint.selectedEventHash});
      return this.transitionInternal(run,{runId:run.runId,expectedStateVersion:run.stateVersion,nextState,reasonCode,
        evidenceIds,manifestHash:checkpoint.manifestHash,idempotencyKey},undefined,
        opened?times.openedAt:times.resumedAt);
    }));
  }

  /**
   * Atomically publishes the complete deterministic optional-hardening
   * Reviewer ingress bundle. None of FINAL_SCOPE, PRE_REVIEW, final risk,
   * Reviewer authority, or C can become durable independently.
   */
  completeOptionalHardeningReviewInput(input:{artifact:ArtifactRecord;finalScopeArtifact:ArtifactRecord;
    finalScope:FinalChangeScopeAttestation;preReviewArtifact:ArtifactRecord;preReview:TestIntegrityComparison;
    riskAssessment:RiskAssessment;expectedStateVersion:number;
    manifestHash:string;checkpointEvidenceIds:readonly [string,string,string];trustedEvidenceIds:readonly string[];
    reviewerInputCreatedAt:string;idempotencyKey:string;workerLease:RecoveryWorkerLeaseProof;
  }):{artifact:ArtifactRecord;transition:LedgerTransitionResult}{
    return this.withRecoveryWorkerLease(input.artifact.runId,input.workerLease,()=>this.ledger.atomic(()=>{
      const run=this.ledger.getRun(input.artifact.runId);
      if(!this.artifactReadAuthority)throw new InvalidTransitionError(
        "optional-hardening artifact read authority is unavailable");
      if(!this.isOptionalHardeningChild(run.runId)||run.manifestHash!==input.manifestHash)
        throw new InvalidTransitionError("optional-hardening Reviewer ingress authority changed");
      const artifacts=this.ledger.listArtifacts(run.runId),checkpointArtifacts=artifacts.filter((candidate)=>
        candidate.type==="INDEPENDENT_VERIFICATION_CHECKPOINT");
      if(checkpointArtifacts.length!==1)throw new InvalidTransitionError(
        "optional-hardening checkpoint authority is not unique");
      const checkpointArtifact=checkpointArtifacts[0]!;
      const decode=(artifact:ArtifactRecord,label:string):{text:string;value:unknown}=>{
        let text:string;try{text=new TextDecoder("utf-8",{fatal:true}).decode(
          this.artifactReadAuthority!.readVerifiedExact(artifact));}
        catch{throw new InvalidTransitionError(`${label} is not exact UTF-8`);}
        let value:unknown;try{value=JSON.parse(text);}catch{throw new InvalidTransitionError(`${label} is not JSON`);}
        if(text!==canonicalJson(value))throw new InvalidTransitionError(`${label} is not canonical`);
        return {text,value};
      };
      let checkpoint;try{const decoded=decode(checkpointArtifact,"optional-hardening checkpoint");
        checkpoint=OptionalHardeningIndependentCheckpointSchema.parse(decoded.value);
        if(decoded.text!==canonicalJson(checkpoint))throw new Error("schema normalization changed bytes");}
      catch{throw new InvalidTransitionError("optional-hardening checkpoint payload is invalid");}
      if(!checkpointArtifact.trusted||checkpointArtifact.producerType!=="SYSTEM"||
        checkpointArtifact.producerId!=="engineer-verification"||checkpoint.runId!==run.runId||
        checkpoint.manifestHash!==input.manifestHash)
        throw new InvalidTransitionError("optional-hardening checkpoint artifact authority is invalid");
      try{resolveHardeningArtifactAuthority({authority:checkpoint.verified.securityReportArtifact,artifacts,
        readArtifact:(candidate)=>this.artifactReadAuthority!.readVerifiedExact(candidate)});}
      catch{throw new InvalidTransitionError("optional-hardening checkpoint security report authority is invalid");}
      let chain;try{chain=validateOptionalHardeningCheckpointChain({checkpoint,artifact:checkpointArtifact,
        events:this.ledger.listEvents(run.runId),manifestHash:input.manifestHash});}
      catch{throw new InvalidTransitionError("optional-hardening checkpoint chain is invalid");}
      const times=hardeningReviewerIngressTimes({headTimestamp:chain.head.timestamp,
        checkpointCreatedAt:checkpointArtifact.createdAt,checkpointEvidence:checkpoint.verified.trustedEvidence});
      const diffArtifacts=artifacts.filter((candidate)=>candidate.artifactId===checkpoint.diffArtifactId&&
        candidate.sha256===checkpoint.diffArtifactHash&&candidate.type==="FINAL_DIFF"&&candidate.trusted&&
        candidate.producerType==="SYSTEM"&&candidate.producerId==="engineer-verification");
      if(diffArtifacts.length!==1)throw new InvalidTransitionError("optional-hardening final diff authority is invalid");
      let diff:string;try{diff=new TextDecoder("utf-8",{fatal:true}).decode(
        this.artifactReadAuthority.readVerifiedExact(diffArtifacts[0]!));}
      catch{throw new InvalidTransitionError("optional-hardening final diff bytes are invalid");}
      if(sha256(diff)!==checkpoint.diffHash)throw new InvalidTransitionError(
        "optional-hardening final diff hash is invalid");
      const manifest=this.ledger.getManifest(run.runId);
      if(!manifest||manifest.manifestHash!==input.manifestHash)
        throw new InvalidTransitionError("optional-hardening manifest authority is invalid");
      const expectedScope=buildFinalChangeScopeAttestation({manifest,diff,resultCommitSha:checkpoint.resultCommitSha,
        credentialedGitOperationCount:this.ledger.listGitOperations(run.runId).length}),scopePayloadHash=sha256(expectedScope),
        expectedScopeId=hardeningFinalScopeArtifactId({runId:run.runId,checkpointHash:checkpoint.checkpointHash,
          scopePayloadHash});
      let scopePayload;try{const decoded=decode(input.finalScopeArtifact,"optional-hardening final scope");
        scopePayload=FinalChangeScopeAttestationSchema.parse(decoded.value);
        if(decoded.text!==canonicalJson(scopePayload))throw new Error("schema normalization changed bytes");}
      catch{throw new InvalidTransitionError("optional-hardening final scope payload is invalid");}
      if(canonicalJson(scopePayload)!==canonicalJson(input.finalScope)||canonicalJson(scopePayload)!==canonicalJson(expectedScope)||
        input.finalScopeArtifact.artifactId!==expectedScopeId||input.finalScopeArtifact.runId!==run.runId||
        input.finalScopeArtifact.type!=="FINAL_CHANGE_SCOPE_ATTESTATION"||!input.finalScopeArtifact.trusted||
        input.finalScopeArtifact.producerType!=="SYSTEM"||input.finalScopeArtifact.producerId!=="final-change-scope-policy"||
        input.finalScopeArtifact.createdAt!==times.scopeAt)
        throw new InvalidTransitionError("optional-hardening final scope authority is invalid");
      let comparison;try{const decoded=decode(input.preReviewArtifact,"optional-hardening PRE_REVIEW");
        comparison=TestIntegrityComparisonSchema.parse(decoded.value);
        if(decoded.text!==canonicalJson(comparison))throw new Error("schema normalization changed bytes");}
      catch{throw new InvalidTransitionError("optional-hardening PRE_REVIEW payload is invalid");}
      const baselines=artifacts.filter((candidate)=>candidate.type==="TEST_BASELINE_MANIFEST"&&candidate.trusted&&
        candidate.producerType==="SYSTEM"&&candidate.producerId==="engineer-supervisor-test-integrity");
      if(baselines.length!==1)throw new InvalidTransitionError("optional-hardening test baseline authority is not unique");
      let baseline;try{const decoded=decode(baselines[0]!,"optional-hardening test baseline");
        baseline=TestBaselineManifestSchema.parse(decoded.value);
        if(decoded.text!==canonicalJson(baseline))throw new Error("schema normalization changed bytes");}
      catch{throw new InvalidTransitionError("optional-hardening test baseline payload is invalid");}
      const expectedPreReviewId=hardeningPreReviewArtifactId({runId:run.runId,checkpointHash:checkpoint.checkpointHash,
        baselineHash:baseline.baselineHash,comparisonHash:comparison.comparisonHash});
      if(canonicalJson(comparison)!==canonicalJson(input.preReview)||comparison.runId!==run.runId||
        comparison.baselineHash!==baseline.baselineHash||comparison.stage!=="PRE_REVIEW"||!comparison.passed||
        comparison.comparedAt!==times.preReviewAt||input.preReviewArtifact.artifactId!==expectedPreReviewId||
        input.preReviewArtifact.runId!==run.runId||input.preReviewArtifact.type!=="TEST_INTEGRITY_COMPARISON"||
        !input.preReviewArtifact.trusted||input.preReviewArtifact.producerType!=="SYSTEM"||
        input.preReviewArtifact.producerId!=="engineer-supervisor-test-integrity"||
        input.preReviewArtifact.createdAt!==times.preReviewAt)
        throw new InvalidTransitionError("optional-hardening PRE_REVIEW authority is invalid");
      const derivedRiskFeatures=derivePostVerificationRiskFeatures({diff,
        requiredChecksPassed:checkpoint.verified.executions.every((execution)=>execution.status==="PASSED"),
        retryCount:this.ledger.retryAttemptCount(run.runId),unresolvedWarnings:0,
        securityFindings:checkpoint.verified.securityFindings}),decision=assessRisk(derivedRiskFeatures,{autoApproveLowRisk:true}),
        riskId=hardeningFinalRiskAssessmentId({runId:run.runId,checkpointHash:checkpoint.checkpointHash,
          featuresHash:sha256(decision.features),ruleVersion:decision.ruleVersion}),expectedRisk=this.riskAssessmentFromDecision(
          run,decision,riskId,times.riskAt);
      if(canonicalJson(expectedRisk)!==canonicalJson(input.riskAssessment))
        throw new InvalidTransitionError("optional-hardening final risk authority is invalid");
      let authority;try{const decoded=decode(input.artifact,"optional-hardening review input");
        authority=OptionalHardeningReviewInputAuthoritySchema.parse(decoded.value);
        if(decoded.text!==canonicalJson(authority))throw new Error("schema normalization changed bytes");}
      catch{throw new InvalidTransitionError("optional-hardening review input payload is invalid");}
      const scopeEvidence=TrustedEvidenceSchema.parse({evidenceId:input.finalScopeArtifact.artifactId,runId:run.runId,
        eventType:"FINAL_CHANGE_SCOPE_ATTESTATION",producerType:"SYSTEM",producerId:"final-change-scope-policy",
        sha256:input.finalScopeArtifact.sha256,payload:scopePayload,createdAt:input.finalScopeArtifact.createdAt}),
        integrityEvidence=TrustedEvidenceSchema.parse({evidenceId:input.preReviewArtifact.artifactId,runId:run.runId,
          eventType:"TEST_INTEGRITY_ATTESTATION",producerType:"SYSTEM",
          producerId:"engineer-supervisor-test-integrity",sha256:input.preReviewArtifact.sha256,payload:comparison,
          createdAt:input.preReviewArtifact.createdAt}),trustedEvidence=[...checkpoint.verified.trustedEvidence,
          scopeEvidence,integrityEvidence].sort((left,right)=>compareCodeUnits(left.evidenceId,right.evidenceId)),
        reviewAttempt=this.ledger.nextReviewerAttempt(run.runId),reviewSessionId=sha256({
          namespace:"engineer-hardening-review-session-v1",runId:run.runId,checkpointHash:checkpoint.checkpointHash,
          attempt:reviewAttempt}),reviewerContent={reviewSessionId,runId:run.runId,reviewAttempt,manifest,
          manifestHash:manifest.manifestHash,finalDiff:diff,diffHash:checkpoint.diffHash,trustedEvidence,
          resultCommitSha:checkpoint.resultCommitSha,riskAssessment:expectedRisk,reviewPolicyVersion:REVIEWER_POLICY_VERSION,
          createdAt:times.reviewerAt},expectedReviewer=ReviewerInputSchema.parse({...reviewerContent,
            evidenceBundleHash:reviewerEvidenceBundleHash(reviewerContent)}),expectedAuthorityId=hardeningReviewAuthorityArtifactId({
              runId:run.runId,checkpointHash:checkpoint.checkpointHash,authorityHash:authority.authorityHash});
      if(canonicalJson(authority.reviewerInput)!==canonicalJson(expectedReviewer)||authority.runId!==run.runId||
        authority.manifestHash!==manifest.manifestHash||authority.diffHash!==checkpoint.diffHash||
        authority.resultCommitSha!==checkpoint.resultCommitSha||authority.checkpointArtifactId!==checkpointArtifact.artifactId||
        authority.checkpointArtifactHash!==checkpointArtifact.sha256||authority.checkpointHash!==checkpoint.checkpointHash||
        input.artifact.artifactId!==expectedAuthorityId||input.artifact.runId!==run.runId||
        input.artifact.type!=="HARDENING_REVIEW_INPUT_AUTHORITY"||!input.artifact.trusted||
        input.artifact.producerType!=="SYSTEM"||input.artifact.producerId!=="engineer-verification"||
        input.artifact.createdAt!==times.reviewerAt)
        throw new InvalidTransitionError("optional-hardening review input binding is invalid");
      const authorityArtifacts=[...artifacts];
      for(const pending of [input.finalScopeArtifact,input.preReviewArtifact]){
        const existing=authorityArtifacts.find((candidate)=>candidate.artifactId===pending.artifactId);
        if(existing&&canonicalJson(existing)!==canonicalJson(pending))throw new InvalidTransitionError(
          "optional-hardening pending evidence identity conflicts");
        if(!existing)authorityArtifacts.push(pending);
      }
      let resolvedEvidenceAuthority;try{resolvedEvidenceAuthority=resolveHardeningReviewerEvidenceAuthority({
        reviewerInput:expectedReviewer,artifacts:authorityArtifacts,runRecords:this.ledger.exportRunRecords(run.runId),
        readArtifact:(candidate)=>this.artifactReadAuthority!.readVerifiedExact(candidate)});}
      catch{throw new InvalidTransitionError("optional-hardening Reviewer evidence authority is invalid");}
      if(canonicalJson(resolvedEvidenceAuthority)!==canonicalJson(authority.evidenceAuthority)||
        sha256(resolvedEvidenceAuthority)!==authority.evidenceAuthorityHash)
        throw new InvalidTransitionError("optional-hardening Reviewer evidence authority changed");
      const pendingSemanticRows=buildHardeningPendingSemanticRows({runId:run.runId,
        checkpointHash:checkpoint.checkpointHash,preReviewArtifact:input.preReviewArtifact,preReview:comparison,
        riskAssessment:expectedRisk});
      let resolvedSemanticAuthority;try{resolvedSemanticAuthority=resolveHardeningReviewerSemanticAuthority({
        reviewerInput:expectedReviewer,artifacts:authorityArtifacts,runRecords:this.ledger.exportRunRecords(run.runId),
        pendingRows:pendingSemanticRows,readArtifact:(candidate)=>this.artifactReadAuthority!.readVerifiedExact(candidate)});}
      catch{throw new InvalidTransitionError("optional-hardening Reviewer semantic authority is invalid");}
      if(canonicalJson(resolvedSemanticAuthority)!==canonicalJson(authority.semanticAuthority))
        throw new InvalidTransitionError("optional-hardening Reviewer semantic authority changed");
      const derivedCheckpointEvidence=[checkpointArtifact.artifactId,checkpointArtifact.sha256,
        checkpoint.checkpointHash] as const,derivedTrustedIds=trustedEvidence.map((item)=>item.evidenceId).sort(),
        derivedKey=hardeningCheckpointMilestoneKey({kind:"COMPLETED",runId:run.runId,
          artifactId:checkpointArtifact.artifactId,artifactHash:checkpointArtifact.sha256,
          checkpointHash:checkpoint.checkpointHash,selectedEventId:checkpoint.selectedEventId,
          selectedEventSequence:checkpoint.selectedEventSequence,
          selectedEventStateVersion:checkpoint.selectedEventStateVersion,selectedEventHash:checkpoint.selectedEventHash});
      if(canonicalJson(input.checkpointEvidenceIds)!==canonicalJson(derivedCheckpointEvidence)||
        canonicalJson([...new Set(input.trustedEvidenceIds)].sort())!==canonicalJson(derivedTrustedIds)||
        input.reviewerInputCreatedAt!==times.reviewerAt||input.idempotencyKey!==derivedKey)
        throw new InvalidTransitionError("optional-hardening completion caller projection is invalid");
      const existingAuthority=artifacts.filter((candidate)=>candidate.type==="HARDENING_REVIEW_INPUT_AUTHORITY"),
        existingScopes=artifacts.filter((candidate)=>candidate.type==="FINAL_CHANGE_SCOPE_ATTESTATION"),
        existingPreReviews=artifacts.filter((candidate)=>{
          if(candidate.type!=="TEST_INTEGRITY_COMPARISON")return false;
          try{return TestIntegrityComparisonSchema.parse(JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(
            this.artifactReadAuthority!.readVerifiedExact(candidate)))).stage==="PRE_REVIEW";}catch{return false;}
        }),records=this.ledger.exportRunRecords(run.runId),riskRows=(records.risk_assessments??[]).filter((row)=>
          String(row.id)===riskId||Date.parse(String(row.assessed_at))>=Date.parse(times.riskAt));
      const evidenceIds=hardeningReviewCompletionEvidence({checkpointEvidenceIds:derivedCheckpointEvidence,
        authorityArtifactId:input.artifact.artifactId,authorityArtifactHash:input.artifact.sha256,
        trustedEvidenceIds:derivedTrustedIds});
      if(chain.completed){
        if(existingAuthority.length!==1||existingScopes.length!==1||existingPreReviews.length!==1||riskRows.length!==1||
          canonicalJson(existingAuthority[0])!==canonicalJson(input.artifact)||
          canonicalJson(existingScopes[0])!==canonicalJson(input.finalScopeArtifact)||
          canonicalJson(existingPreReviews[0])!==canonicalJson(input.preReviewArtifact)||
          canonicalJson(this.ledger.latestRiskAssessment(run.runId))!==canonicalJson(expectedRisk))
          throw new InvalidTransitionError("optional-hardening Reviewer ingress replay is incomplete or conflicting");
        try{this.preflightDurableReviewerEvidence(expectedReviewer);}catch{
          throw new InvalidTransitionError("optional-hardening Reviewer ingress replay semantics are invalid");}
        const replay=this.ledger.replayTransition({runId:run.runId,idempotencyKey:derivedKey,nextState:"REVIEWING",
          reasonCode:"INDEPENDENT_VERIFICATION_COMPLETE",actorType:"SUPERVISOR",actorId:"engineer-supervisor",
          evidenceIds,manifestHash:manifest.manifestHash});
        if(!replay||replay.event.timestamp!==times.completionAt)
          throw new InvalidTransitionError("optional-hardening Reviewer ingress replay event is invalid");
        return {artifact:existingAuthority[0]!,transition:replay};
      }
      if(run.state!=="SECURITY_REVIEW"||run.stateVersion!==input.expectedStateVersion||existingAuthority.length||
        existingScopes.length||existingPreReviews.length||riskRows.length)
        throw new InvalidTransitionError("optional-hardening Reviewer ingress is partial or changed");
      const scope=this.ledger.recordArtifact(input.finalScopeArtifact);
      if(canonicalJson(scope)!==canonicalJson(input.finalScopeArtifact))throw new InvalidTransitionError(
        "optional-hardening final scope identity changed");
      this.afterHardeningIngressStepForTest?.("FINAL_SCOPE");
      const preReview=this.ledger.recordArtifact(input.preReviewArtifact);
      if(canonicalJson(preReview)!==canonicalJson(input.preReviewArtifact))throw new InvalidTransitionError(
        "optional-hardening PRE_REVIEW identity changed");
      this.afterHardeningIngressStepForTest?.("PRE_REVIEW");
      this.ledger.recordTestIntegrityAttestation(preReview.artifactId,comparison,hardeningPreReviewAuditId({
        runId:run.runId,checkpointHash:checkpoint.checkpointHash,comparisonHash:comparison.comparisonHash}),
        this.strictArtifactReader(run.runId));
      this.afterHardeningIngressStepForTest?.("INTEGRITY_AUDIT");
      this.ledger.recordRisk(expectedRisk,run.stateVersion,hardeningFinalRiskAuditId({runId:run.runId,
        checkpointHash:checkpoint.checkpointHash,assessmentId:expectedRisk.assessmentId}));
      this.afterHardeningIngressStepForTest?.("FINAL_RISK");
      try{this.preflightDurableReviewerEvidence(expectedReviewer);}catch{
        throw new InvalidTransitionError("optional-hardening Reviewer evidence semantics are invalid");}
      this.afterHardeningIngressStepForTest?.("SEMANTIC_PREFLIGHT");
      const artifact=this.ledger.recordArtifact(input.artifact);
      if(canonicalJson(artifact)!==canonicalJson(input.artifact))throw new InvalidTransitionError(
        "optional-hardening review input identity changed");
      this.afterHardeningIngressStepForTest?.("REVIEW_AUTHORITY");
      const transition=this.transitionInternal(run,{runId:run.runId,expectedStateVersion:run.stateVersion,
        nextState:"REVIEWING",reasonCode:"INDEPENDENT_VERIFICATION_COMPLETE",evidenceIds,
        manifestHash:manifest.manifestHash,idempotencyKey:derivedKey},undefined,times.completionAt);
      this.afterHardeningIngressStepForTest?.("COMPLETION");
      this.assertRuntimeBudget(run.runId);
      return {artifact,transition};
    }));
  }

  /** Atomically elects the one durable cancellation request and its artifact. */
  requestRunCancellation(input:{runId:string;actorId:string;artifact:ArtifactRecord}):{
    run:EngineerRun;applied:boolean;
  }{
    return this.ledger.atomic(()=>{
      const run=this.ledger.getRun(input.runId);
      if(run.userId!==input.actorId)throw new InvalidTransitionError("cancellation actor does not own this run");
      if(run.state==="CANCELLED"||run.state==="CANCELLATION_PENDING")return {run,applied:false};
      if(run.terminalAt)throw new InvalidTransitionError(`terminal run ${run.state} cannot be cancelled`);
      if(!isCancellationAllowed(run.state))throw new InvalidTransitionError(
        `cancellation is fenced while publication state is ${run.state}; remote cleanup is not safely available`,
      );
      if(input.artifact.runId!==run.runId||input.artifact.type!=="CANCELLATION_REQUEST"||
          input.artifact.producerType!=="SYSTEM"||input.artifact.producerId!=="engineer-supervisor"||!input.artifact.trusted)
        throw new InvalidTransitionError("cancellation request artifact authority is invalid");
      const artifact=this.ledger.recordArtifact(input.artifact);
      const transitioned=this.transition({runId:run.runId,expectedStateVersion:run.stateVersion,
        nextState:"CANCELLATION_PENDING",reasonCode:"USER_CANCELLATION_REQUESTED",actorType:"HUMAN",
        actorId:input.actorId,evidenceIds:[artifact.artifactId],manifestHash:run.manifestHash,
        idempotencyKey:`control:cancel:${run.stateVersion}`}).run;
      return {run:transitioned,applied:true};
    });
  }

  /** Final cancellation CAS; caller must hold the separate durable run lease. */
  finalizeRunCancellation(input:{runId:string;outcome:"CANCELLED"|"FAILED";
    expectedLastError:string|null;lastError:string|null}):EngineerRun{
    return this.ledger.atomic(()=>{
      const run=this.ledger.getRun(input.runId);
      if(run.state===input.outcome)return run;
      if(run.state!=="CANCELLATION_PENDING")
        throw new InvalidTransitionError(`cancellation finalization requires CANCELLATION_PENDING, received ${run.state}`);
      if(this.ledger.getLastError(run.runId)!==input.expectedLastError)
        throw new InvalidTransitionError("cancellation finalization last-error authority changed");
      const transitioned=this.transition({runId:run.runId,expectedStateVersion:run.stateVersion,nextState:input.outcome,
        reasonCode:input.outcome==="CANCELLED"?"RUN_CLEANUP_COMPLETE":"CANCELLATION_CLEANUP_FAILED",
        actorType:"SUPERVISOR",actorId:"engineer-supervisor",evidenceIds:[],manifestHash:run.manifestHash,
        idempotencyKey:`control:${input.outcome.toLowerCase()}:${run.stateVersion}`}).run;
      this.ledger.setLastError(run.runId,input.lastError,this.timestamp());
      return this.ledger.getRun(transitioned.runId);
    });
  }

  listArtifacts(runId: string): ArtifactRecord[] {
    return this.ledger.listArtifacts(runId);
  }

  recordTestIntegrityAttestation(artifactId: string, comparison: unknown): void {
    const parsed=TestIntegrityComparisonSchema.parse(comparison);
    this.ledger.atomic(() => this.ledger.recordTestIntegrityAttestation(artifactId,parsed,undefined,
      this.strictArtifactReader(parsed.runId)));
  }

  recordCommandExecution(record: CommandExecutionRecord): CommandExecutionRecord {
    const run = this.ledger.getRun(record.runId);
    if (run.manifestHash === null) throw new ManifestIntegrityError("commands require a frozen manifest");
    if (!["IMPLEMENTING", "FAST_CHECKS", "UNIT_TESTING", "INTEGRATION_TESTING", "E2E_TESTING", "SECURITY_REVIEW", "REVERIFYING"]
      .includes(run.state)) {
      throw new InvalidTransitionError(`commands cannot be recorded while run is ${run.state}`);
    }
    return this.ledger.atomic(() => {
      const command = this.ledger.recordCommandExecution(record);
      this.assertRuntimeBudget(record.runId);
      return command;
    });
  }

  recordModelRouting(decision: ModelRoutingDecision): void {
    const parsed = ModelRoutingDecisionSchema.parse(decision);
    this.ledger.recordModelRouting(parsed);
  }

  recordAgentExecution(record: AgentExecutionRecord): void {
    this.ledger.atomic(() => {
      this.ledger.recordAgentExecution(record);
      if (record.status === "RUNNING") this.assertRuntimeBudget(record.runId);
    });
  }

  builderRepairExecutions(runId: string, inputHash: string): AgentExecutionRecord[] {
    return this.ledger.builderRepairExecutions(runId, inputHash);
  }

  claimBuilderDispatch(
    record: AgentExecutionRecord,
    worker: { ownerId: string; fencingToken: number } | null = null,
  ): { won: boolean; claim: BuilderDispatchClaim; execution: AgentExecutionRecord } {
    this.assertRuntimeBudget(record.runId);
    return this.ledger.claimBuilderDispatch(record, worker);
  }

  finalizeRunningAgentExecutions(
    runId: string,
    status: "PAUSED" | "FAILED",
    reason: string,
    completedAt = new Date().toISOString(),
  ): number {
    return this.ledger.atomic(() =>
      this.ledger.finalizeRunningAgentExecutions(runId, status, completedAt, reason));
  }

  recordModelCall(record: ModelCallRecord, reservationId?: string): void {
    if (record.status === "SUCCEEDED" && !reservationId) {
      throw new Error("successful model calls require a pre-admitted budget reservation");
    }
    this.ledger.atomic(() => {
      if (reservationId) {
        const reservation = this.ledger.modelBudgetReservation(record.runId, reservationId);
        if (reservation.agentExecutionId !== record.agentExecutionId || reservation.model !== record.resolvedModel) {
          throw new Error("model call does not match its budget reservation route");
        }
        const activeRoute = this.ledger.modelRouteForAgent(
          record.runId,
          record.agentExecutionId,
          record.resolvedModel,
        );
        if (activeRoute.routingDecisionId !== reservation.routingDecisionId) {
          throw new Error("model call route changed after its budget reservation was admitted");
        }
        if (record.inputTokens !== null && record.inputTokens > reservation.inputTokens) {
          throw new Error("actual model input exceeded its admitted reservation");
        }
        if (record.outputTokens !== null && record.outputTokens > reservation.outputTokens) {
          throw new Error("actual model output exceeded its admitted reservation");
        }
        if (record.inputTokens !== null && record.outputTokens !== null) {
          const actualCostUsd = estimateGpt56CostUsd(record.resolvedModel, record.inputTokens, record.outputTokens, {
            cachedInputTokens: record.cachedInputTokens ?? 0,
            cacheWriteInputTokens: record.cacheWriteInputTokens ?? 0,
          });
          if (actualCostUsd > reservation.estimatedCostUsd + Number.EPSILON) {
            throw new Error("actual model cost exceeded its admitted reservation");
          }
        }
        if (record.inputTokens !== null && record.outputTokens !== null) {
          this.ledger.releaseModelBudgetReservation(record.runId, reservationId);
        } else {
          // The provider outcome is unknown. Keep the worst-case allowance
          // fenced across restarts, but identify it separately from an active
          // in-flight request so the UI and a later reconciliation cannot call
          // it settled spend.
          this.ledger.markModelBudgetReservationAmbiguous(record.runId, reservationId);
        }
      }
      this.ledger.recordModelCall(record, reservationId);
      // A successful call was admitted against a worst-case reservation and
      // has already incurred its cost. Do not interrupt consumption of that
      // paid response here. The next model reservation remains the hard
      // budget boundary and will pause before any additional provider spend.
    });
  }

  reserveModelBudget(input: { runId: string; reservationId: string; agentExecutionId: string; model: string; inputTokenUpperBound: number; maxOutputTokens: number }): string {
    const estimatedCostUsd = estimateGpt56CostUsd(input.model, input.inputTokenUpperBound, input.maxOutputTokens);
    try {
      this.ledger.atomic(() => {
        const route = this.ledger.modelRouteForAgent(input.runId, input.agentExecutionId, input.model);
        if (route.agentRole === "BUILDER" && this.ledger.modelCallCountForRole(input.runId, "BUILDER") >= this.builderModelCallLimit) {
          throw new BuilderModelCallLimitError(input.runId, this.builderModelCallLimit);
        }
        this.ledger.reserveModelBudget({
          runId: input.runId, reservationId: input.reservationId,
          inputTokens: input.inputTokenUpperBound, outputTokens: input.maxOutputTokens,
          estimatedCostUsd, agentExecutionId: input.agentExecutionId, model: input.model,
          routingDecisionId: route.routingDecisionId, createdAt: this.timestamp(),
        });
        this.assertRuntimeBudget(input.runId);
      });
    } catch (error) {
      if (!(error instanceof RuntimeBudgetExhaustedError)) throw error;
      const joined = error.decision.hardLimitReasons.join(" ");
      const reason: BudgetPauseReason = joined.includes("TOKEN") ? "TOKEN_LIMIT_REACHED"
        : joined.includes("COST") || joined.includes("ACCOUNTING") ? "COST_LIMIT_REACHED"
          : "TIME_LIMIT_REACHED";
      this.pauseForBudget(input.runId, reason);
      throw new BudgetPausedError(input.runId, reason);
    }
    return input.reservationId;
  }

  modelCallCountForRole(runId: string, role: string): number {
    return this.ledger.modelCallCountForRole(runId, role);
  }

  assertRuntimeBudget(runId: string, overrides: Partial<RunBudgetUsage> = {}): RunBudgetDecision | null {
    const frozenManifest = this.ledger.getManifest(runId);
    const proposalManifest = frozenManifest ? null : this.ledger.latestPlanProposal(runId)?.manifest;
    const baseManifest = frozenManifest ?? (proposalManifest
      ? TaskManifestSchema.parse({ ...proposalManifest, manifestHash: sha256(proposalManifest) })
      : (() => {
          const selected = this.ledger.getBudget(runId, this.timestamp()).limits;
          return { timeBudgetSeconds: selected.timeSeconds, tokenBudget: selected.tokens, costBudgetUsd: selected.costUsd };
        })());
    const selected = this.ledger.getBudget(runId, this.timestamp()).limits;
    const manifest = { ...baseManifest, timeBudgetSeconds: selected.timeSeconds, tokenBudget: selected.tokens, costBudgetUsd: selected.costUsd };
    const usage = { ...this.ledger.runtimeBudgetUsage(runId, new Date(this.timestamp())), ...overrides };
    return assertBudgetPolicy(manifest, RunBudgetUsageSchema.parse(usage));
  }

  getBudget(runId: string): EngineerBudgetSnapshot { return this.ledger.getBudget(runId, this.timestamp()); }

  reconcileBudget(runId: string): EngineerBudgetSnapshot {
    const snapshot = this.getBudget(runId);
    if (snapshot.status !== "PAUSED") {
      const reason: BudgetPauseReason | null = snapshot.remaining.tokens === 0 ? "TOKEN_LIMIT_REACHED"
        : snapshot.remaining.costUsd === 0 ? "COST_LIMIT_REACHED"
          : snapshot.remaining.timeSeconds === 0 ? "TIME_LIMIT_REACHED" : null;
      if (reason) this.pauseForBudget(runId, reason);
    }
    return this.getBudget(runId);
  }

  topUpBudget(input: { runId: string; expectedRevision: number; topUp: BudgetTopUp; actorId: string; idempotencyKey: string }): EngineerBudgetSnapshot {
    const run = this.getRun(input.runId);
    if (run.userId !== input.actorId) throw new InvalidTransitionError("budget actor does not own this run");
    if (this.isOptionalHardeningChild(input.runId)) throw new HardeningBudgetExtensionRequiresNewRunError();
    return this.ledger.topUpBudget({ ...input, topUp: BudgetTopUpSchema.parse(input.topUp), createdAt: this.timestamp() });
  }

  resumeBudget(input: { runId: string; expectedStateVersion: number; expectedBudgetRevision: number; actorId: string; idempotencyKey: string }): LedgerTransitionResult {
    const run = this.getRun(input.runId);
    const budget = this.getBudget(input.runId);
    if (run.userId !== input.actorId) throw new InvalidTransitionError("budget actor does not own this run");
    if (this.isOptionalHardeningChild(input.runId)) throw new HardeningBudgetExtensionRequiresNewRunError();
    if (run.state !== "PAUSED_BUDGET" || budget.status !== "PAUSED" || !budget.resumeState) throw new InvalidTransitionError("run is not paused for budget");
    if (run.stateVersion !== input.expectedStateVersion) throw new StateVersionConflictError(run.runId, input.expectedStateVersion, run.stateVersion);
    if (budget.revision !== input.expectedBudgetRevision) throw new StateVersionConflictError(run.runId, input.expectedBudgetRevision, budget.revision);
    const timestamp = this.timestamp();
    return this.ledger.resumeFromBudget({
      runId: run.runId, expectedStateVersion: run.stateVersion, previousState: "PAUSED_BUDGET", nextState: budget.resumeState,
      reasonCode: "BUDGET_RESUMED", actorType: "HUMAN", actorId: input.actorId, evidenceIds: [], manifestHash: run.manifestHash,
      idempotencyKey: input.idempotencyKey, eventId: this.idFactory(), timestamp, terminalAt: null,
    });
  }

  recordVerificationExecution(record: VerificationExecutionRecord): VerificationExecutionRecord {
    const run = this.ledger.getRun(record.runId);
    if (!["FAST_CHECKS", "UNIT_TESTING", "INTEGRATION_TESTING", "E2E_TESTING", "SECURITY_REVIEW", "REVERIFYING"].includes(run.state)) {
      throw new InvalidTransitionError(`verification cannot be recorded while run is ${run.state}`);
    }
    return this.ledger.recordVerificationExecution(record);
  }

  recordSecurityFinding(record: SecurityFindingRecord): SecurityFindingRecord {
    const run = this.ledger.getRun(record.runId);
    if (run.state !== "SECURITY_REVIEW") {
      throw new InvalidTransitionError(`security findings cannot be recorded while run is ${run.state}`);
    }
    return this.ledger.recordSecurityFinding(record);
  }

  recordClassifiedReviewerSession(
    record: ReviewerSessionRecord,
    findings: ReviewFindingRecord[],
    classification: ReviewClassificationBatch,
    authority: ClassifiedReviewerAuthority,
  ): ReviewClassificationBatch {
    const run = this.ledger.getRun(record.runId);
    if (!record.isolationVerified || record.modelTier !== "GPT-5.6_SOL") {
      throw new InvalidTransitionError("Classified Reviewer session must be fresh, isolated, and routed to SOL");
    }
    const readArtifact=this.strictArtifactReader(record.runId);
    if (run.state !== "REVIEWING" && this.ledger.getReviewClassification(record.reviewerSessionId,readArtifact) === null) {
      throw new InvalidTransitionError(`classified review sessions cannot be recorded while run is ${run.state}`);
    }
    return this.ledger.recordClassifiedReviewerSession(record, findings, classification, authority,readArtifact);
  }

  getReviewClassification(reviewerSessionId: string): ReviewClassificationBatch | null {
    const runId=this.ledger.reviewClassificationRunId(reviewerSessionId);
    if(!runId)return null;
    return this.ledger.getReviewClassification(reviewerSessionId,this.strictArtifactReader(runId));
  }

  latestClassifiedReview(runId: string): ReturnType<EngineerLedger["latestClassifiedReview"]> {
    return this.ledger.latestClassifiedReview(runId,this.strictArtifactReader(runId));
  }

  async promoteVerifiedCandidate(
    input: PromoteVerifiedCandidateInput,
    expectedStateVersion: number,
  ): Promise<VerifiedCandidatePromotionResult> {
    return this.ledger.promoteVerifiedCandidate(input, expectedStateVersion);
  }

  async promoteVerifiedHardeningCandidate(
    input: PromoteVerifiedCandidateInput,
    expectedStateVersion: number,
  ): ReturnType<EngineerLedger["promoteVerifiedHardeningCandidate"]> {
    return this.ledger.promoteVerifiedHardeningCandidate(input, expectedStateVersion,this.strictArtifactReader(input.runId));
  }

  async getVerifiedCandidateCheckpoint(
    reference: { runId: string } | { checkpointId: string },
    attestor: CheckpointAttestor,
  ): ReturnType<EngineerLedger["getVerifiedCandidateCheckpoint"]> {
    return this.ledger.getVerifiedCandidateCheckpoint(reference, attestor);
  }

  async getVerifiedHardeningCandidateCheckpoint(
    reference: { runId: string } | { checkpointId: string },
    attestor: CheckpointAttestor,
  ): ReturnType<EngineerLedger["getVerifiedHardeningCandidateCheckpoint"]> {
    const runId=this.ledger.verifiedHardeningCheckpointRunId(reference);
    if(!runId)return null;
    return this.ledger.getVerifiedHardeningCandidateCheckpoint(reference,attestor,this.strictArtifactReader(runId));
  }

  nextReviewerAttempt(runId: string): number {
    return this.ledger.nextReviewerAttempt(runId);
  }

  recordClaimEvidence(record: ClaimEvidenceRecord): ClaimEvidenceRecord {
    return this.ledger.recordClaimEvidence(record);
  }

  listClaimEvidence(runId: string): ClaimEvidenceRecord[] {
    return this.ledger.listClaimEvidence(runId);
  }

  recordEvidenceBundle(record: EvidenceBundleRecord): EvidenceBundleRecord {
    return this.ledger.recordEvidenceBundle(record);
  }

  listEvidenceBundles(runId: string): EvidenceBundleRecord[] {
    return this.ledger.listEvidenceBundles(runId);
  }

  listTestExecutions(runId: string): TestExecutionView[] {
    return this.ledger.listTestExecutions(runId);
  }

  listSecurityFindings(runId: string): SecurityFindingRecord[] {
    return this.ledger.listSecurityFindings(runId);
  }

  recordApprovalRequest(record: NewApprovalRequestRecord, attestor: CheckpointAttestor): Promise<NewApprovalRequestRecord>;
  recordApprovalRequest(record: ApprovalRequestRecord): ApprovalRequestRecord;
  recordApprovalRequest(
    record: ApprovalRequestRecord,
    attestor?: CheckpointAttestor,
  ): Promise<NewApprovalRequestRecord> | ApprovalRequestRecord {
    if (!attestor || !record.verifiedCheckpointId || !record.verifiedCheckpointHash) {
      throw new Error("new approval request requires verified checkpoint authority and attestor");
    }
    return this.ledger.recordApprovalRequest(record as NewApprovalRequestRecord, attestor);
  }

  latestApprovalRequest(runId: string): ApprovalRequestRecord | null {
    return this.ledger.latestApprovalRequest(runId);
  }

  listApprovalDecisions(approvalRequestId: string): ApprovalDecisionRecord[] {
    return this.ledger.listApprovalDecisions(approvalRequestId);
  }

  decideApproval(record: NewApprovalDecisionRecord, status: ApprovalRequestRecord["status"], provenanceContext?: ProvenanceEmissionContext): NewApprovalDecisionRecord;
  decideApproval(record: ApprovalDecisionRecord, status: ApprovalRequestRecord["status"], provenanceContext?: ProvenanceEmissionContext): ApprovalDecisionRecord;
  decideApproval(record: ApprovalDecisionRecord, status: ApprovalRequestRecord["status"], provenanceContext?: ProvenanceEmissionContext): ApprovalDecisionRecord {
    if (!record.expectedVerifiedCheckpointId || !record.expectedVerifiedCheckpointHash) {
      throw new Error("approval decisions require expected verified checkpoint authority");
    }
    return this.ledger.decideApproval(record as NewApprovalDecisionRecord, status, this.timestamp(), provenanceContext);
  }

  extendApproval(record: NewApprovalDecisionRecord, deadlineAt: string, reminders: string[]): ApprovalRequestRecord;
  extendApproval(record: ApprovalDecisionRecord, deadlineAt: string, reminders: string[]): ApprovalRequestRecord;
  extendApproval(record: ApprovalDecisionRecord, deadlineAt: string, reminders: string[]): ApprovalRequestRecord {
    if (!record.expectedVerifiedCheckpointId || !record.expectedVerifiedCheckpointHash) {
      throw new Error("approval extensions require expected verified checkpoint authority");
    }
    return this.ledger.extendApproval(record as NewApprovalDecisionRecord, deadlineAt, reminders, this.timestamp());
  }

  getPublicationEvidence(runId: string): PublicationEvidence {
    return this.ledger.getPublicationEvidence(runId);
  }

  recordGitOperation(record: NewGitOperationRecord): NewGitOperationRecord {
    return this.ledger.recordGitOperation(record);
  }

  findGitOperation(runId: string, idempotencyKey: string): GitOperationRecord | null {
    return this.ledger.findGitOperation(runId, idempotencyKey);
  }

  listGitOperations(runId: string): GitOperationRecord[] {
    return this.ledger.listGitOperations(runId);
  }

  recordFailure(record: FailureRecord): FailureRecord {
    return this.ledger.recordFailure(record);
  }

  listFailures(runId: string): FailureRecord[] {
    return this.ledger.listFailures(runId);
  }
  getExactHardeningDatabaseIntegrityFatal(runId:string){
    return this.ledger.getExactHardeningDatabaseIntegrityFatal(runId);
  }
  recordOrReplayHardeningDatabaseIntegrityFatal(runId:string){
    return this.ledger.recordOrReplayHardeningDatabaseIntegrityFatal(runId);
  }

  getLastError(runId: string): string | null {
    return this.ledger.getLastError(runId);
  }

  setLastError(runId: string, message: string | null): void {
    this.ledger.setLastError(runId, message, this.timestamp());
  }

  clearLastErrorIfExact(runId:string,expected:string):boolean{
    return this.ledger.clearLastErrorIfExact(runId,expected,this.timestamp());
  }

  close(): void {
    this.ledger.close();
  }

  /**
   * The ledger's single live SQLite connection, for constructing the P7
   * Resolution Desk on the SAME connection as the ledger (see
   * `EngineerLedger.resolutionDeskConnection`). Composition-root use only.
   */
  resolutionDeskConnection(): Database {
    return this.ledger.resolutionDeskConnection();
  }

  private applyDecisionSideEffect(decision: DecisionRecord, expectedStateVersion: number): void {
    const run = this.ledger.getRun(decision.runId);
    if (decision.classification === "AUTO") {
      if (this.ledger.getDecisionResolution(decision.runId, decision.decisionId)) return;
      const resolvedAt = this.timestamp();
      const content = DecisionResolutionContentSchema.parse({
        resolutionId: this.idFactory(),
        decisionId: decision.decisionId,
        runId: decision.runId,
        selectedOptionId: decision.recommendedOptionId,
        actorType: "SUPERVISOR",
        actorId: "engineer-supervisor",
        rationale: "Applied the reversible, within-scope documented default under deterministic policy.",
        sourceEvidence: decision.sourceEvidence,
        policyVersion: DECISION_POLICY_VERSION,
        status: "RESOLVED",
        idempotencyKey: derivedDecisionKey(decision.idempotencyKey, "auto-resolution"),
        resolvedAt,
      });
      this.ledger.recordDecisionResolution(DecisionResolutionSchema.parse({ ...content, resolutionHash: sha256(content) }));
      return;
    }
    if (decision.classification !== "ASK_NOW") return;
    if (run.state === "CLARIFICATION_REQUIRED") return;
    if (run.stateVersion !== expectedStateVersion) {
      throw new StateVersionConflictError(run.runId, expectedStateVersion, run.stateVersion);
    }
    this.transition({
      runId: run.runId,
      expectedStateVersion,
      nextState: "CLARIFICATION_REQUIRED",
      reasonCode: "DECISION_REQUIRES_CLARIFICATION",
      actorType: "SUPERVISOR",
      actorId: "engineer-supervisor",
      evidenceIds: [decision.decisionId],
      idempotencyKey: derivedDecisionKey(decision.idempotencyKey, "clarification"),
    });
  }

  private resumeResolvedDecision(
    decision: DecisionRecord,
    resolution: DecisionResolution,
    expectedStateVersion: number,
  ): void {
    if (decision.classification !== "ASK_NOW") return;
    const run = this.ledger.getRun(decision.runId);
    if (run.state === "PLANNING") return;
    if (run.state !== "CLARIFICATION_REQUIRED") {
      throw new InvalidTransitionError(`resolved ASK_NOW cannot resume from ${run.state}`);
    }
    if (run.stateVersion !== expectedStateVersion) {
      throw new StateVersionConflictError(run.runId, expectedStateVersion, run.stateVersion);
    }
    if (this.ledger.listOpenDecisions(run.runId).some((open) => open.classification === "ASK_NOW")) {
      return;
    }
    this.transition({
      runId: run.runId,
      expectedStateVersion,
      nextState: "PLANNING",
      reasonCode: decision.resumeAction === "REPLAN" ? "DECISION_RESOLVED_REPLAN" : "DECISION_RESOLVED_PLAN",
      actorType: "SUPERVISOR",
      actorId: "engineer-supervisor",
      evidenceIds: [decision.decisionId, resolution.resolutionId],
      idempotencyKey: derivedDecisionKey(resolution.idempotencyKey, "resume"),
    });
  }

  private transitionInternal(
    run: EngineerRun,
    input: TransitionInput,
    normalizedRequest?: string,
    timestampOverride?:string,
  ): LedgerTransitionResult {
    const actorType = input.actorType ?? "SUPERVISOR";
    const actorId = input.actorId ?? "engineer-supervisor";
    if (input.nextState === "REVIEW_APPROVED") {
      throw new InvalidTransitionError("REVIEW_APPROVED requires verified-candidate promotion");
    }
    this.validateManifestBinding(run, input.manifestHash);
    const replay = this.ledger.replayTransition({
      runId: run.runId,
      idempotencyKey: input.idempotencyKey,
      nextState: input.nextState,
      reasonCode: input.reasonCode,
      actorType,
      actorId,
      evidenceIds: input.evidenceIds ?? [],
      manifestHash: run.manifestHash,
    });
    if (replay) return replay;
    if (run.stateVersion !== input.expectedStateVersion) {
      throw new StateVersionConflictError(run.runId, input.expectedStateVersion, run.stateVersion);
    }
    if (isTerminalState(run.state)) {
      throw new InvalidTransitionError(`terminal state ${run.state} cannot transition`);
    }
    if (input.nextState === "PLAN_FROZEN") {
      throw new InvalidTransitionError("PLAN_FROZEN requires freezePlan so the manifest and event commit atomically");
    }
    if (input.nextState === "PAUSED_BUDGET" || run.state === "PAUSED_BUDGET") {
      throw new InvalidTransitionError("budget pause and resume require the dedicated Supervisor controls");
    }
    if (!canTransition(run.state, input.nextState)) {
      throw new InvalidTransitionError(`transition ${run.state} -> ${input.nextState} is not permitted`);
    }
    if (input.nextState === "PLAN_READY") {
      const context = this.ledger.latestContextSnapshot(run.runId);
      const proposal = this.ledger.latestPlanProposal(run.runId);
      if (!context || !proposal || proposal.contextManifestHash !== context.manifest.manifestHash ||
          !input.evidenceIds?.includes(context.artifactId) || !input.evidenceIds.includes(proposal.artifactId)) {
        throw new ManifestIntegrityError("PLAN_READY requires the matching persisted context and plan evidence");
      }
    }
    const unresolved = this.ledger.listOpenDecisions(run.runId);
    const unresolvedDecisionExit = input.nextState === "CLARIFICATION_REQUIRED" ||
      input.nextState === "CANCELLATION_PENDING" || input.nextState === "CANCELLED" || input.nextState === "FAILED";
    if (unresolved.some((decision) => decision.classification === "ASK_NOW" || decision.classification === "AUTO") &&
        !unresolvedDecisionExit) {
      throw new InvalidTransitionError("open ASK_NOW or AUTO decisions block workflow progression");
    }
    if (input.nextState === "COMPLETED" && unresolved.some((decision) => decision.classification === "DEFER")) {
      throw new InvalidTransitionError("deferred human tasks must be resolved before completion");
    }
    this.validateActor(input.nextState, actorType);
    this.validateManifestBinding(run, input.manifestHash);
    this.validateStateGuards(run, input, actorType);
    const timestamp = timestampOverride??this.timestamp();
    return this.ledger.appendTransition({
      runId: run.runId,
      expectedStateVersion: input.expectedStateVersion,
      previousState: run.state,
      nextState: input.nextState,
      reasonCode: input.reasonCode,
      actorType,
      actorId,
      evidenceIds: input.evidenceIds ?? [],
      manifestHash: run.manifestHash,
      idempotencyKey: input.idempotencyKey,
      eventId: this.idFactory(),
      timestamp,
      terminalAt: isTerminalState(input.nextState) ? timestamp : null,
      ...(normalizedRequest === undefined ? {} : { normalizedRequest }),
    });
  }

  private validateActor(nextState: RunState, actorType: ActorType): void {
    if (actorType === "AGENT" || actorType === "EXECUTOR") {
      throw new InvalidTransitionError(`${actorType} cannot directly mutate authoritative workflow state`);
    }
    if (actorType === "HUMAN" && ![
      "HUMAN_APPROVED",
      "FIX_REQUESTED",
      "REJECTED",
      "HUMAN_REVIEW_REQUIRED",
      "VERIFICATION_RECOVERY",
      "CANCELLATION_PENDING",
    ].includes(nextState)) {
      throw new InvalidTransitionError(`human actor cannot directly promote state to ${nextState}`);
    }
    if (nextState === "HUMAN_APPROVED" && actorType !== "HUMAN") {
      throw new InvalidTransitionError("HUMAN_APPROVED requires a human actor");
    }
    if ((nextState === "PR_PREFLIGHT" || nextState === "PR_CREATING" || nextState === "PR_CREATED" || nextState === "COMPLETED") &&
        actorType !== "SUPERVISOR") {
      throw new InvalidTransitionError(`${nextState} is supervisor-owned`);
    }
  }

  private validateManifestBinding(run: EngineerRun, provided: string | null | undefined): void {
    if (run.manifestHash === null) {
      if (provided !== undefined && provided !== null) {
        throw new ManifestIntegrityError("unfrozen run cannot bind an arbitrary manifest hash");
      }
      return;
    }
    if (provided !== undefined && provided !== run.manifestHash) {
      throw new ManifestIntegrityError("transition manifest hash does not match the frozen manifest");
    }
  }

  private validateStateGuards(
    run: EngineerRun,
    input: TransitionInput,
    actorType: Exclude<ActorType, "AGENT" | "EXECUTOR">,
  ): void {
    const evidenceCount = input.evidenceIds?.length ?? 0;
    if (run.state === "HUMAN_REVIEW_REQUIRED" && input.nextState === "VERIFICATION_RECOVERY") {
      requireFacts(input.facts, ["reviewerRetryAuthorized"], input.nextState);
      if (actorType !== "HUMAN" || evidenceCount === 0) {
        throw new InvalidTransitionError("Reviewer recovery requires an explicit human decision and failure evidence");
      }
    }
    if (input.nextState === "REVIEW_CHANGES_REQUESTED") {
      requireFacts(input.facts, ["reviewerFindingsActionable"], input.nextState);
      if (evidenceCount === 0) throw new InvalidTransitionError("review changes require immutable finding evidence");
    }
    if (input.nextState === "REVIEW_FIX_PREPARING") {
      requireFacts(input.facts, ["retryBudgetAvailable", "scopeWithinManifest"], input.nextState);
    }
    if (run.state === "REVIEW_FIX_PREPARING" && input.nextState === "IMPLEMENTING") {
      requireFacts(input.facts, ["scopeWithinManifest"], input.nextState);
    }
    if (run.state === "REVERIFYING" && input.nextState === "FAST_CHECKS") {
      requireFacts(input.facts, ["fullVerificationRerun"], input.nextState);
    }
    if (input.nextState === "HUMAN_APPROVAL_PENDING" && run.riskTier === "CRITICAL") {
      throw new InvalidTransitionError("critical risk must block or security-escalate, not await normal approval");
    }
    if (input.nextState === "HUMAN_APPROVED") {
      requireFacts(input.facts, ["humanApprovalValid"], input.nextState);
      if (actorType !== "HUMAN" || evidenceCount === 0) {
        throw new InvalidTransitionError("human approval requires a human actor and approval evidence");
      }
    }
    if (run.state === "REVIEW_APPROVED" && input.nextState === "PR_PREFLIGHT" &&
        (run.riskTier !== "LOW" || run.humanGateRequired)) {
      throw new InvalidTransitionError("only policy-approved low-risk work may bypass human approval");
    }
    if (input.nextState === "PR_PREFLIGHT") {
      requireFacts(input.facts, [
        "reviewerDecisionValid",
        "allRequiredChecksPassed",
        "noCriticalSecurityFindings",
        "evidenceBundleComplete",
        "baseBranchCurrent",
      ], input.nextState);
      if (run.state === "HUMAN_APPROVED") {
        requireFacts(input.facts, ["humanApprovalValid"], input.nextState);
      }
      if (evidenceCount === 0) throw new InvalidTransitionError("PR preflight requires hash-bound evidence");
    }
    if (input.nextState === "PR_CREATING" && evidenceCount === 0) {
      throw new InvalidTransitionError("PR creation requires a supervisor command evidence record");
    }
    if (input.nextState === "PR_CREATED") {
      requireFacts(input.facts, ["prCreated"], input.nextState);
      if (evidenceCount === 0) throw new InvalidTransitionError("PR_CREATED requires Git service evidence");
    }
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private pauseForBudget(runId: string, reason: BudgetPauseReason): void {
    const run = this.ledger.getRun(runId);
    if (run.state === "PAUSED_BUDGET" || isTerminalState(run.state)) return;
    if (!canTransition(run.state, "PAUSED_BUDGET")) return;
    const timestamp = this.timestamp();
    this.ledger.pauseForBudget({
      runId, expectedStateVersion: run.stateVersion, previousState: run.state, nextState: "PAUSED_BUDGET",
      reasonCode: reason, actorType: "SUPERVISOR", actorId: "budget-supervisor", evidenceIds: [], manifestHash: run.manifestHash,
      idempotencyKey: `budget:pause:${run.stateVersion}:${reason}`, eventId: this.idFactory(), timestamp, terminalAt: null,
    }, reason);
  }
}

export function createEngineerSupervisor(options: SupervisorOptions = {}): EngineerSupervisor {
  return new EngineerSupervisor(options);
}

export type { RiskDecision };
