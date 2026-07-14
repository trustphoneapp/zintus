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
import { canonicalJson, sha256 } from "./hash.js";
import { EngineerLedger, type LedgerTransitionResult } from "./ledger.js";
import { assessRisk, type RiskDecision, type RiskPolicyOptions } from "./risk.js";
import { evaluateRetry, type RetryDecision } from "./retry.js";
import { canTransition, isTerminalState } from "./state-machine.js";
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
import { assertRunBudget as assertBudgetPolicy, estimateGpt56CostUsd, RunBudgetUsageSchema, type RunBudgetDecision, type RunBudgetUsage } from "./runtime-budget.js";

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
  initialRiskFeatures?: Partial<RiskFeatures>;
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
    const retainPriorFloor = run.manifestHash !== null || rank[run.riskTier] >= rank.HIGH;
    const riskTier = retainPriorFloor && rank[decision.riskTier] < rank[run.riskTier] ? run.riskTier : decision.riskTier;
    const retainedFloor = riskTier !== decision.riskTier;
    const assessment = RiskAssessmentSchema.parse({
      assessmentId: this.idFactory(),
      runId,
      riskTier,
      humanGateRequired: (retainPriorFloor && run.humanGateRequired) || decision.humanGateRequired || riskTier !== "LOW",
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
        !["REQUEST_NORMALIZED", "PLANNING", "PLAN_READY", "REPLANNING"].includes(run.state)) {
      throw new InvalidTransitionError(`ASK_NOW cannot safely interrupt ${run.state}`);
    }
    if (policy.classification === "ASK_NOW" &&
        this.ledger.listOpenDecisions(run.runId).some((decision) => decision.classification === "ASK_NOW")) {
      throw new InvalidTransitionError("an unresolved ASK_NOW decision already blocks this run");
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
    return this.ledger.recordPlanProposal(proposal);
  }

  latestPlanProposal(runId: string): PlanProposal | null {
    return this.ledger.latestPlanProposal(runId);
  }

  recordContextSnapshot(snapshot: StoredContextSnapshot): StoredContextSnapshot {
    const parsed = StoredContextSnapshotSchema.parse(snapshot);
    const run = this.ledger.getRun(parsed.manifest.runId);
    if (run.state !== "REQUEST_RECEIVED") throw new InvalidTransitionError("context may only be recorded before planning");
    if (parsed.manifest.repositoryId !== run.repository.repositoryId ||
        parsed.manifest.baseCommitSha.toLowerCase() !== run.repository.baseCommitSha.toLowerCase() ||
        parsed.manifest.requestHash !== sha256(run.requestOriginal)) {
      throw new ManifestIntegrityError("context snapshot does not match the run repository, exact base, and request");
    }
    return this.ledger.recordContextSnapshot(parsed);
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

  recordSandbox(record: SandboxRecord): SandboxRecord {
    return this.ledger.recordSandbox(record);
  }

  recordArtifact(record: ArtifactRecord): ArtifactRecord {
    return this.ledger.atomic(() => {
      const artifact = this.ledger.recordArtifact(record);
      this.assertRuntimeBudget(record.runId);
      return artifact;
    });
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
          const actualCostUsd = estimateGpt56CostUsd(record.resolvedModel, record.inputTokens, record.outputTokens);
          if (actualCostUsd > reservation.estimatedCostUsd + Number.EPSILON) {
            throw new Error("actual model cost exceeded its admitted reservation");
          }
        }
        if (record.inputTokens !== null && record.outputTokens !== null) {
          this.ledger.releaseModelBudgetReservation(record.runId, reservationId);
        }
      }
      this.ledger.recordModelCall(record, reservationId);
      if (record.status === "SUCCEEDED") this.assertRuntimeBudget(record.runId);
    });
  }

  reserveModelBudget(input: { runId: string; reservationId: string; agentExecutionId: string; model: string; inputTokenUpperBound: number; maxOutputTokens: number }): string {
    const estimatedCostUsd = estimateGpt56CostUsd(input.model, input.inputTokenUpperBound, input.maxOutputTokens);
    this.ledger.atomic(() => {
      const route = this.ledger.modelRouteForAgent(input.runId, input.agentExecutionId, input.model);
      this.ledger.reserveModelBudget({
        runId: input.runId, reservationId: input.reservationId,
        inputTokens: input.inputTokenUpperBound, outputTokens: input.maxOutputTokens,
        estimatedCostUsd, agentExecutionId: input.agentExecutionId, model: input.model,
        routingDecisionId: route.routingDecisionId, createdAt: this.timestamp(),
      });
      this.assertRuntimeBudget(input.runId);
    });
    return input.reservationId;
  }

  assertRuntimeBudget(runId: string, overrides: Partial<RunBudgetUsage> = {}): RunBudgetDecision | null {
    const frozenManifest = this.ledger.getManifest(runId);
    const proposalManifest = frozenManifest ? null : this.ledger.latestPlanProposal(runId)?.manifest;
    const manifest = frozenManifest ?? (proposalManifest
      ? TaskManifestSchema.parse({ ...proposalManifest, manifestHash: sha256(proposalManifest) })
      : { timeBudgetSeconds: 3_600, tokenBudget: 200_000, costBudgetUsd: 20 });
    const usage = { ...this.ledger.runtimeBudgetUsage(runId, new Date(this.timestamp())), ...overrides };
    return assertBudgetPolicy(manifest, RunBudgetUsageSchema.parse(usage));
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
    if (input.nextState === "PLAN_READY") {
      const context = this.ledger.latestContextSnapshot(run.runId);
      const proposal = this.ledger.latestPlanProposal(run.runId);
      if (!context || !proposal || proposal.contextManifestHash !== context.manifest.manifestHash ||
          !input.evidenceIds?.includes(context.artifactId) || !input.evidenceIds.includes(proposal.artifactId)) {
        throw new ManifestIntegrityError("PLAN_READY requires the matching persisted context and plan evidence");
      }
    }
    const unresolved = this.ledger.listOpenDecisions(run.runId);
    if (unresolved.some((decision) => decision.classification === "ASK_NOW" || decision.classification === "AUTO") &&
        input.nextState !== "CLARIFICATION_REQUIRED" && input.nextState !== "CANCELLATION_PENDING") {
      throw new InvalidTransitionError("open ASK_NOW or AUTO decisions block workflow progression");
    }
    if (input.nextState === "COMPLETED" && unresolved.some((decision) => decision.classification === "DEFER")) {
      throw new InvalidTransitionError("deferred human tasks must be resolved before completion");
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
