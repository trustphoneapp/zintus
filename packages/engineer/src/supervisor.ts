import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  RepositoryReferenceSchema,
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
  type ModelRoutingDecision,
} from "./contracts.js";
import type {
  AgentExecutionRecord,
  ArtifactRecord,
  CommandExecutionRecord,
  ModelCallRecord,
  SandboxRecord,
} from "./execution-contracts.js";
import type {
  ClaimEvidenceRecord,
  EvidenceBundleRecord,
  ReviewFindingRecord,
  ReviewerSessionRecord,
  SecurityFindingRecord,
  VerificationExecutionRecord,
} from "./verification-contracts.js";
import type {
  ApprovalDecisionRecord,
  ApprovalRequestRecord,
  FailureRecord,
  GitOperationRecord,
  PublicationEvidence,
  TestExecutionView,
} from "./control-contracts.js";
import { IdempotencyConflictError, InvalidTransitionError, ManifestIntegrityError, StateVersionConflictError } from "./errors.js";
import { sha256 } from "./hash.js";
import { EngineerLedger, type LedgerTransitionResult } from "./ledger.js";
import { assessRisk, type RiskDecision, type RiskPolicyOptions } from "./risk.js";
import { evaluateRetry, type RetryDecision } from "./retry.js";
import { canTransition, isTerminalState } from "./state-machine.js";

export interface SupervisorOptions {
  dbPath?: string;
  now?: () => Date;
  idFactory?: () => string;
}

export interface ReceiveRequestInput {
  runId?: string;
  userId: string;
  userEmail?: string;
  repository: RepositoryReference;
  request: string;
  initialRiskFeatures?: RiskFeatures;
}

export interface TransitionFacts {
  reviewerDecisionValid?: boolean;
  reviewerFindingsActionable?: boolean;
  freshReviewerSession?: boolean;
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

function requireFacts(facts: TransitionFacts | undefined, names: Array<keyof TransitionFacts>, state: RunState): void {
  const missing = names.filter((name) => facts?.[name] !== true);
  if (missing.length > 0) {
    throw new InvalidTransitionError(`${state} requires supervisor facts: ${missing.join(", ")}`);
  }
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

  constructor(options: SupervisorOptions = {}) {
    this.ledger = new EngineerLedger(options.dbPath ?? join(homedir(), ".zintus", "engineer.db"));
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
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
    return this.ledger.createRun({
      runId: input.runId ?? this.idFactory(),
      userId: input.userId,
      ...(input.userEmail ? { userEmail: input.userEmail } : {}),
      repository,
      requestOriginal: request,
      riskTier: initialRisk.riskTier,
      humanGateRequired: initialRisk.humanGateRequired,
      now,
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
    );
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
    const decision = assessRisk(features, options);
    const rank: Record<RiskTier, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };
    const riskTier = rank[decision.riskTier] < rank[run.riskTier] ? run.riskTier : decision.riskTier;
    const retainedFloor = riskTier !== decision.riskTier;
    const assessment = RiskAssessmentSchema.parse({
      assessmentId: this.idFactory(),
      runId,
      riskTier,
      humanGateRequired: run.humanGateRequired || decision.humanGateRequired || riskTier !== "LOW",
      ruleVersion: decision.ruleVersion,
      matchedRules: retainedFloor ? [...decision.matchedRules, "PRIOR_RISK_TIER_FLOOR"] : decision.matchedRules,
      features: decision.features,
      assessedAt: this.timestamp(),
    });
    this.ledger.recordRisk(assessment, expectedStateVersion);
    return assessment;
  }

  authorizeRetry(input: AuthorizeRetryInput): RetryDecision {
    const run = this.ledger.getRun(input.runId);
    if (run.stateVersion !== input.expectedStateVersion) {
      throw new StateVersionConflictError(input.runId, input.expectedStateVersion, run.stateVersion);
    }
    const budgets = this.ledger.getManifest(input.runId)?.retryBudgets ?? RetryBudgetsSchema.parse({});
    const history = this.ledger.listRetryHistory(input.runId);
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

  getRun(runId: string): EngineerRun {
    return this.ledger.getRun(runId);
  }

  listRuns(states?: RunState[]): EngineerRun[] {
    return this.ledger.listRuns(states);
  }

  getManifest(runId: string, version?: number): TaskManifest | null {
    return this.ledger.getManifest(runId, version);
  }

  listManifestVersions(runId: string): TaskManifest[] {
    return this.ledger.listManifestVersions(runId);
  }

  listEvents(runId: string): RunStateEvent[] {
    return this.ledger.listEvents(runId);
  }

  recordSandbox(record: SandboxRecord): SandboxRecord {
    return this.ledger.recordSandbox(record);
  }

  recordArtifact(record: ArtifactRecord): ArtifactRecord {
    return this.ledger.recordArtifact(record);
  }

  listArtifacts(runId: string): ArtifactRecord[] {
    return this.ledger.listArtifacts(runId);
  }

  recordCommandExecution(record: CommandExecutionRecord): CommandExecutionRecord {
    const run = this.ledger.getRun(record.runId);
    if (run.manifestHash === null) throw new ManifestIntegrityError("commands require a frozen manifest");
    if (!["IMPLEMENTING", "FAST_CHECKS", "UNIT_TESTING", "INTEGRATION_TESTING", "E2E_TESTING", "SECURITY_REVIEW", "REVERIFYING"]
      .includes(run.state)) {
      throw new InvalidTransitionError(`commands cannot be recorded while run is ${run.state}`);
    }
    return this.ledger.recordCommandExecution(record);
  }

  recordModelRouting(decision: ModelRoutingDecision): void {
    const parsed = ModelRoutingDecisionSchema.parse(decision);
    this.ledger.recordModelRouting(parsed);
  }

  recordAgentExecution(record: AgentExecutionRecord): void {
    this.ledger.recordAgentExecution(record);
  }

  recordModelCall(record: ModelCallRecord): void {
    this.ledger.recordModelCall(record);
  }

  recordVerificationExecution(record: VerificationExecutionRecord): VerificationExecutionRecord {
    const run = this.ledger.getRun(record.runId);
    if (!["FAST_CHECKS", "UNIT_TESTING", "INTEGRATION_TESTING", "E2E_TESTING", "REVERIFYING"].includes(run.state)) {
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

  recordReviewerSession(record: ReviewerSessionRecord, findings: ReviewFindingRecord[]): ReviewerSessionRecord {
    const run = this.ledger.getRun(record.runId);
    if (run.state !== "REVIEWING") {
      throw new InvalidTransitionError(`review sessions cannot be recorded while run is ${run.state}`);
    }
    if (!record.isolationVerified || record.modelTier !== "GPT-5.6_SOL") {
      throw new InvalidTransitionError("Reviewer session must be fresh, isolated, and routed to SOL");
    }
    return this.ledger.recordReviewerSession(record, findings);
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

  recordApprovalRequest(record: ApprovalRequestRecord): ApprovalRequestRecord {
    const run = this.ledger.getRun(record.runId);
    if (run.state !== "REVIEW_APPROVED") throw new InvalidTransitionError("approval may only be requested after review approval");
    return this.ledger.recordApprovalRequest(record);
  }

  latestApprovalRequest(runId: string): ApprovalRequestRecord | null {
    return this.ledger.latestApprovalRequest(runId);
  }

  decideApproval(record: ApprovalDecisionRecord, status: ApprovalRequestRecord["status"]): ApprovalDecisionRecord {
    return this.ledger.decideApproval(record, status);
  }

  extendApproval(record: ApprovalDecisionRecord, deadlineAt: string, reminders: string[]): ApprovalRequestRecord {
    return this.ledger.extendApproval(record, deadlineAt, reminders);
  }

  getPublicationEvidence(runId: string): PublicationEvidence {
    return this.ledger.getPublicationEvidence(runId);
  }

  recordGitOperation(record: GitOperationRecord): GitOperationRecord {
    return this.ledger.recordGitOperation(record);
  }

  findGitOperation(runId: string, idempotencyKey: string): GitOperationRecord | null {
    return this.ledger.findGitOperation(runId, idempotencyKey);
  }

  recordFailure(record: FailureRecord): FailureRecord {
    return this.ledger.recordFailure(record);
  }

  listFailures(runId: string): FailureRecord[] {
    return this.ledger.listFailures(runId);
  }

  close(): void {
    this.ledger.close();
  }

  private transitionInternal(
    run: EngineerRun,
    input: TransitionInput,
    normalizedRequest?: string,
  ): LedgerTransitionResult {
    const actorType = input.actorType ?? "SUPERVISOR";
    const actorId = input.actorId ?? "engineer-supervisor";
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
    if (!canTransition(run.state, input.nextState)) {
      throw new InvalidTransitionError(`transition ${run.state} -> ${input.nextState} is not permitted`);
    }
    this.validateActor(input.nextState, actorType);
    this.validateManifestBinding(run, input.manifestHash);
    this.validateStateGuards(run, input, actorType);
    const timestamp = this.timestamp();
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
    if (input.nextState === "REVIEW_APPROVED") {
      if (run.riskTier === "CRITICAL") {
        throw new InvalidTransitionError("critical risk cannot be review-approved for publication");
      }
      requireFacts(input.facts, ["reviewerDecisionValid", "freshReviewerSession"], input.nextState);
      if (evidenceCount === 0) throw new InvalidTransitionError("REVIEW_APPROVED requires review evidence");
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
}

export function createEngineerSupervisor(options: SupervisorOptions = {}): EngineerSupervisor {
  return new EngineerSupervisor(options);
}

export type { RiskDecision };
