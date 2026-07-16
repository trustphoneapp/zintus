import { z } from "zod";
import { sha256 } from "./hash.js";

export const RUN_STATES = [
  "REQUEST_RECEIVED",
  "REQUEST_NORMALIZED",
  "CLARIFICATION_REQUIRED",
  "PLANNING",
  "PLAN_READY",
  "PLAN_FROZEN",
  "QUEUED",
  "SANDBOX_WARM_REQUESTED",
  "SANDBOX_WARM_AVAILABLE",
  "SANDBOX_WARM_CLAIMING",
  "SANDBOX_WARM_VALIDATING",
  "SANDBOX_WARM_CLAIMED",
  "SANDBOX_COLD_PROVISIONING",
  "SANDBOX_PREWARM_INVALID",
  "SANDBOX_PROVISIONING",
  "SANDBOX_PREFLIGHT",
  "SANDBOX_READY",
  "CONTEXT_BUILDING",
  "IMPLEMENTING",
  "MODEL_PROVIDER_RETRY_PENDING",
  "FAST_CHECKS",
  "UNIT_TESTING",
  "INTEGRATION_TESTING",
  "E2E_TESTING",
  "FLAKE_QUARANTINE",
  "SECURITY_REVIEW",
  "CODE_REVIEW",
  "EVIDENCE_SYNTHESIS",
  "REVIEWING",
  "REVIEW_APPROVED",
  "REVIEW_CHANGES_REQUESTED",
  "REVIEW_FIX_PREPARING",
  "VERIFICATION_RECOVERY",
  "REVERIFYING",
  "REVIEW_REJECTED",
  "HUMAN_APPROVAL_PENDING",
  "HUMAN_APPROVED",
  "FIX_REQUESTED",
  "REPLANNING",
  "PR_PREFLIGHT",
  "PR_CREATING",
  "PR_CREATED",
  "PR_CREATION_FAILED",
  "BASE_BRANCH_STALE",
  "ROLLBACK_IN_PROGRESS",
  "CANCELLATION_PENDING",
  "EVIDENCE_PACKAGING",
  "PAUSED_BUDGET",
  "COMPLETED",
  "REJECTED",
  "CANCELLED",
  "TIMED_OUT",
  "RETRY_BUDGET_EXHAUSTED",
  "BLOCKED_BY_ENVIRONMENT",
  "BLOCKED_BY_EXTERNAL_DEPENDENCY",
  "SECURITY_ESCALATION",
  "HUMAN_REVIEW_REQUIRED",
  "VERIFICATION_INCOMPLETE",
  "ROLLED_BACK",
  "FAILED",
] as const;

export const TERMINAL_STATES = [
  "COMPLETED",
  "REJECTED",
  "CANCELLED",
  "TIMED_OUT",
  "RETRY_BUDGET_EXHAUSTED",
  "BLOCKED_BY_ENVIRONMENT",
  "BLOCKED_BY_EXTERNAL_DEPENDENCY",
  "SECURITY_ESCALATION",
  "VERIFICATION_INCOMPLETE",
  "ROLLED_BACK",
  "FAILED",
] as const;

export const RunStateSchema = z.enum(RUN_STATES);
export const ActorTypeSchema = z.enum([
  "USER",
  "AGENT",
  "EXECUTOR",
  "SUPERVISOR",
  "HUMAN",
  "SYSTEM",
]);
export const RiskTierSchema = z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
export const FailureClassSchema = z.enum([
  "REQUEST_FAILURE",
  "CONTEXT_FAILURE",
  "MODEL_FAILURE",
  "SANDBOX_FAILURE",
  "DEPENDENCY_FAILURE",
  "IMPLEMENTATION_FAILURE",
  "TEST_FAILURE",
  "SECURITY_FAILURE",
  "WORKFLOW_FAILURE",
  "HUMAN_GATE_FAILURE",
  "GIT_FAILURE",
]);

const IdentifierSchema = z.string().min(1).max(200);
const ShaSchema = z.string().regex(/^[a-f0-9]{40}$|^[a-f0-9]{64}$/i);
const HashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const IsoTimestampSchema = z.string().datetime({ offset: true });

export const RepositoryReferenceSchema = z
  .object({
    repositoryId: IdentifierSchema,
    provider: z.enum(["github", "local"]),
    owner: z.string().min(1).max(200),
    name: z.string().min(1).max(200),
    url: z.string().url().optional(),
    baseBranch: z.string().min(1).max(250),
    baseCommitSha: ShaSchema,
  })
  .strict();

export const AcceptanceCriterionSchema = z
  .object({
    criterionId: IdentifierSchema,
    statement: z.string().min(1).max(4_000),
    verificationMethod: z.string().min(1).max(4_000),
    priority: z.enum(["MUST", "SHOULD", "MAY"]).default("MUST"),
  })
  .strict();

export const TestPlanItemSchema = z
  .object({
    testId: IdentifierSchema,
    criterionIds: z.array(IdentifierSchema).min(1),
    type: z.enum([
      "FORMAT",
      "LINT",
      "TYPECHECK",
      "BUILD",
      "UNIT",
      "INTEGRATION",
      "E2E",
      "SECURITY",
      "MIGRATION",
      "REGRESSION",
    ]),
    description: z.string().min(1).max(4_000),
    command: z.string().min(1).max(1_000).optional(),
  })
  .strict();

export const PlannerAssumptionSchema = z.object({
  assumptionId: IdentifierSchema,
  statement: z.string().min(1).max(4_000),
  sourceRefs: z.array(z.string().min(1).max(4_000)).max(20),
  confidence: z.number().min(0).max(1),
  reversible: z.boolean(),
}).strict();

export const PlannerQuestionSchema = z.object({
  questionId: IdentifierSchema,
  question: z.string().min(1).max(4_000),
  impact: z.string().min(1).max(4_000),
  sourceRefs: z.array(z.string().min(1).max(4_000)).max(20),
  options: z.array(z.object({
    optionId: IdentifierSchema,
    label: z.string().min(1).max(500),
    impact: z.string().min(1).max(4_000),
    reversibility: z.enum(["REVERSIBLE", "PARTIALLY_REVERSIBLE", "IRREVERSIBLE"]),
    riskTier: RiskTierSchema,
  }).strict()).min(2).max(3),
  recommendedOptionId: IdentifierSchema,
}).strict().superRefine((question, context) => {
  const ids = new Set(question.options.map((option) => option.optionId));
  if (ids.size !== question.options.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "planner question option IDs must be unique", path: ["options"] });
  }
  if (!ids.has(question.recommendedOptionId)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "planner question recommendation must reference an option", path: ["recommendedOptionId"] });
  }
});

export const TouchedFileEstimateSchema = z.object({
  path: z.string().min(1).max(2_000),
  expectedChange: z.string().min(1).max(4_000),
  confidence: z.number().min(0).max(1),
}).strict();

export const PlanningAnalysisSchema = z.object({
  architectureSummary: z.string().max(12_000),
  assumptions: z.array(PlannerAssumptionSchema).max(50),
  unresolvedQuestions: z.array(PlannerQuestionSchema).max(30),
  touchedFileEstimates: z.array(TouchedFileEstimateSchema).max(100),
}).strict().superRefine((analysis, context) => {
  const questionIds = new Set(analysis.unresolvedQuestions.map((question) => question.questionId));
  if (questionIds.size !== analysis.unresolvedQuestions.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "planner question IDs must be unique", path: ["unresolvedQuestions"] });
  }
});

export const RetryBudgetsSchema = z
  .object({
    sameFailureAttempts: z.number().int().min(0).max(10).default(2),
    builderRepairAttempts: z.number().int().min(0).max(20).default(4),
    reviewerFixAttempts: z.number().int().min(0).max(10).default(2),
    plannerRestarts: z.number().int().min(0).max(5).default(1),
    sandboxProvisioningAttempts: z.number().int().min(0).max(10).default(3),
    transientModelAttempts: z.number().int().min(0).max(10).default(3),
  })
  .strict();

const TaskManifestFields = {
  manifestVersion: z.number().int().positive(),
  runId: IdentifierSchema,
  repository: RepositoryReferenceSchema,
  request: z
    .object({
      original: z.string().min(1).max(100_000),
      normalized: z.string().min(1).max(100_000),
    })
    .strict(),
  acceptanceCriteria: z.array(AcceptanceCriterionSchema).min(1),
  testPlan: z.array(TestPlanItemSchema).min(1),
  allowedPaths: z.array(z.string().min(1).max(2_000)).min(1),
  deniedPaths: z.array(z.string().min(1).max(2_000)),
  allowedCommands: z.array(z.string().min(1).max(1_000)),
  prohibitedCommands: z.array(z.string().min(1).max(1_000)),
  riskTier: RiskTierSchema,
  humanGateRequired: z.boolean(),
  retryBudgets: RetryBudgetsSchema,
  timeBudgetSeconds: z.number().int().positive(),
  tokenBudget: z.number().int().nonnegative(),
  costBudgetUsd: z.number().nonnegative(),
  createdAt: IsoTimestampSchema,
} as const;

const TaskManifestBaseSchema = z.object(TaskManifestFields).strict();

function validateManifestRelations(
  manifest: z.infer<typeof TaskManifestBaseSchema>,
  context: z.RefinementCtx,
): void {
  const criterionIds = new Set<string>();
  for (const [index, criterion] of manifest.acceptanceCriteria.entries()) {
    if (criterionIds.has(criterion.criterionId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `duplicate acceptance criterion: ${criterion.criterionId}`,
        path: ["acceptanceCriteria", index, "criterionId"],
      });
    }
    criterionIds.add(criterion.criterionId);
  }
  const testIds = new Set<string>();
  for (const [index, testItem] of manifest.testPlan.entries()) {
    if (testIds.has(testItem.testId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `duplicate test plan item: ${testItem.testId}`,
        path: ["testPlan", index, "testId"],
      });
    }
    testIds.add(testItem.testId);
    for (const criterionId of testItem.criterionIds) {
      if (!criterionIds.has(criterionId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `test references unknown criterion: ${criterionId}`,
          path: ["testPlan", index, "criterionIds"],
        });
      }
    }
  }
}

export const TaskManifestContentSchema = TaskManifestBaseSchema.superRefine(validateManifestRelations);
export const TaskManifestSchema = TaskManifestBaseSchema.extend({
  manifestHash: HashSchema,
}).strict().superRefine((manifest, context) => {
  validateManifestRelations(manifest, context);
  const { manifestHash, ...content } = manifest;
  if (sha256(content) !== manifestHash) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "manifestHash does not match canonical manifest content",
      path: ["manifestHash"],
    });
  }
});

export const RunStateEventSchema = z
  .object({
    eventId: IdentifierSchema,
    runId: IdentifierSchema,
    sequence: z.number().int().positive(),
    previousState: RunStateSchema,
    nextState: RunStateSchema,
    reasonCode: z.string().regex(/^[A-Z][A-Z0-9_]{1,127}$/),
    actorType: ActorTypeSchema,
    actorId: IdentifierSchema,
    timestamp: IsoTimestampSchema,
    evidenceIds: z.array(IdentifierSchema),
    manifestHash: HashSchema.nullable(),
    stateVersion: z.number().int().positive(),
    idempotencyKey: z.string().min(1).max(500),
  })
  .strict();

export const EngineerRunSchema = z
  .object({
    runId: IdentifierSchema,
    userId: IdentifierSchema,
    repository: RepositoryReferenceSchema,
    requestOriginal: z.string().min(1).max(100_000),
    requestNormalized: z.string().max(100_000),
    state: RunStateSchema,
    stateVersion: z.number().int().nonnegative(),
    manifestHash: HashSchema.nullable(),
    riskTier: RiskTierSchema,
    humanGateRequired: z.boolean(),
    createdAt: IsoTimestampSchema,
    updatedAt: IsoTimestampSchema,
    terminalAt: IsoTimestampSchema.nullable(),
  })
  .strict();

export const RiskFeaturesSchema = z
  .object({
    documentationOnly: z.boolean().default(false),
    sensitiveFilesChanged: z.boolean().default(false),
    touchesAuthentication: z.boolean().default(false),
    touchesAuthorization: z.boolean().default(false),
    touchesPayments: z.boolean().default(false),
    changesDatabaseSchema: z.boolean().default(false),
    destructiveProductionOperation: z.boolean().default(false),
    privilegeEscalation: z.boolean().default(false),
    changesInfrastructure: z.boolean().default(false),
    accessesSecrets: z.boolean().default(false),
    exposesSecrets: z.boolean().default(false),
    changesDependencies: z.boolean().default(false),
    changesPublicApi: z.boolean().default(false),
    requiredChecksPassed: z.boolean().default(false),
    testCoveragePercent: z.number().min(0).max(100).nullable().default(null),
    unresolvedWarnings: z.number().int().nonnegative().default(0),
    highestSecuritySeverity: z
      .enum(["NONE", "INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"])
      .default("NONE"),
    retryCount: z.number().int().nonnegative().default(0),
    dependsOnExternalService: z.boolean().default(false),
    diffLines: z.number().int().nonnegative().default(0),
    generatedCodePercent: z.number().min(0).max(100).default(0),
    reviewerDisagreement: z.boolean().default(false),
    suspectedRunnerCompromise: z.boolean().default(false),
  })
  .strict();

export const RiskAssessmentSchema = z
  .object({
    assessmentId: IdentifierSchema,
    runId: IdentifierSchema,
    riskTier: RiskTierSchema,
    humanGateRequired: z.boolean(),
    ruleVersion: z.string().min(1).max(100),
    matchedRules: z.array(z.string().min(1).max(200)),
    features: RiskFeaturesSchema,
    assessedAt: IsoTimestampSchema,
  })
  .strict();

export const RetryKindSchema = z.enum([
  "BUILDER_REPAIR",
  "REVIEWER_FIX",
  "PLANNER_RESTART",
  "SANDBOX_PROVISIONING",
  "TRANSIENT_MODEL",
]);

export const LogicalModelTierSchema = z.enum([
  "GPT-5.6_SOL",
  "GPT-5.6_TERRA",
  "GPT-5.6_LUNA",
]);
export const ModelRoleSchema = z.enum([
  "PLANNER",
  "BUILDER",
  "TESTER",
  "SECURITY",
  "REVIEWER",
  "ARCHITECTURE_ANALYSIS",
  "REQUEST_CLASSIFIER",
  "FAILURE_CLASSIFIER",
  "RISK_FEATURE_EXTRACTOR",
  "DOCS",
  "SYNTHESIS_FORMATTER",
]);

export const TrustedEvidenceSchema = z.object({
  evidenceId: IdentifierSchema,
  runId: IdentifierSchema,
  eventType: z.string().min(1).max(200),
  producerType: z.enum(["EXECUTOR", "SYSTEM"]),
  producerId: IdentifierSchema,
  sha256: HashSchema,
  payload: z.record(z.string(), z.unknown()),
  createdAt: IsoTimestampSchema,
}).strict();

export function reviewerEvidenceBundleHash(input: {
  manifestHash: string;
  diffHash: string;
  resultCommitSha: string;
  trustedEvidence: TrustedEvidence[];
  riskAssessment?: RiskAssessment | null;
}): string {
  return sha256({
    manifestHash: input.manifestHash,
    diffHash: input.diffHash,
    resultCommitSha: input.resultCommitSha,
    trustedEvidence: input.trustedEvidence,
    riskAssessment: input.riskAssessment ?? null,
  });
}

export const ReviewerInputSchema = z.object({
  reviewSessionId: IdentifierSchema,
  runId: IdentifierSchema,
  reviewAttempt: z.number().int().positive(),
  manifest: TaskManifestSchema,
  manifestHash: HashSchema,
  finalDiff: z.string().max(5_000_000),
  diffHash: HashSchema,
  trustedEvidence: z.array(TrustedEvidenceSchema),
  riskAssessment: RiskAssessmentSchema.nullable().default(null),
  evidenceBundleHash: HashSchema,
  resultCommitSha: ShaSchema,
  reviewPolicyVersion: z.string().min(1).max(200),
  createdAt: IsoTimestampSchema,
}).strict().superRefine((input, context) => {
  if (input.manifest.runId !== input.runId) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "manifest belongs to another run", path: ["manifest"] });
  }
  if (input.manifest.manifestHash !== input.manifestHash) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "manifest hash mismatch", path: ["manifestHash"] });
  }
  if (sha256(input.finalDiff) !== input.diffHash) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "diff hash mismatch", path: ["diffHash"] });
  }
  for (const [index, evidence] of input.trustedEvidence.entries()) {
    if (evidence.runId !== input.runId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "trusted evidence belongs to another run",
        path: ["trustedEvidence", index, "runId"],
      });
    }
  }
  if (reviewerEvidenceBundleHash(input) !== input.evidenceBundleHash) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "evidence bundle hash mismatch",
      path: ["evidenceBundleHash"],
    });
  }
});

export const ReviewFindingSchema = z.object({
  findingId: IdentifierSchema,
  severity: z.enum(["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"]),
  category: z.string().min(1).max(200),
  file: z.string().max(2_000),
  lineStart: z.number().int().nonnegative(),
  lineEnd: z.number().int().nonnegative(),
  criterionIds: z.array(IdentifierSchema),
  description: z.string().min(1).max(10_000),
  requiredChange: z.string().min(1).max(10_000),
  evidenceIds: z.array(IdentifierSchema),
}).strict().refine((finding) => finding.lineEnd >= finding.lineStart, {
  message: "lineEnd must be greater than or equal to lineStart",
  path: ["lineEnd"],
});

export const ReviewerOutputSchema = z.object({
  decision: z.enum(["APPROVE", "REQUEST_CHANGES", "REJECT", "HUMAN_REVIEW_REQUIRED"]),
  requirementCoverage: z.array(z.object({
    criterionId: IdentifierSchema,
    status: z.enum(["SATISFIED", "PARTIAL", "FAILED", "UNVERIFIED"]),
    evidenceIds: z.array(IdentifierSchema),
    explanation: z.string().min(1).max(10_000),
  }).strict()),
  findings: z.array(ReviewFindingSchema),
  unsupportedClaims: z.array(z.string().min(1).max(10_000)),
  residualRisks: z.array(z.string().min(1).max(10_000)),
  reviewedDiffHash: HashSchema,
  reviewedEvidenceBundleHash: HashSchema,
  reviewPolicyVersion: z.string().min(1).max(200),
}).strict();

export const RepairContextSchema = z.object({
  runId: IdentifierSchema,
  manifestHash: HashSchema,
  manifest: TaskManifestSchema,
  reviewFindings: z.array(ReviewFindingSchema),
  reviewFindingsHash: HashSchema,
  currentCommitSha: ShaSchema,
  allowedPaths: z.array(z.string().min(1).max(2_000)),
  remainingReviewFixAttempts: z.number().int().nonnegative(),
}).strict().superRefine((input, context) => {
  if (input.manifest.runId !== input.runId || input.manifest.manifestHash !== input.manifestHash) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "repair manifest binding mismatch", path: ["manifest"] });
  }
  if (sha256(input.reviewFindings) !== input.reviewFindingsHash) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "review findings hash mismatch", path: ["reviewFindingsHash"] });
  }
});

export const ClaimEvidenceSchema = z.object({
  claimId: IdentifierSchema,
  claim: z.string().min(1).max(10_000),
  status: z.enum([
    "VERIFIED",
    "PARTIALLY_VERIFIED",
    "FAILED",
    "UNVERIFIED",
    "BLOCKED_BY_INFRASTRUCTURE",
    "BLOCKED_BY_EXTERNAL_DEPENDENCY",
    "HUMAN_REVIEW_REQUIRED",
  ]),
  evidenceIds: z.array(IdentifierSchema),
  notes: z.string().max(10_000),
}).strict().superRefine((claim, context) => {
  if (claim.status === "VERIFIED" && claim.evidenceIds.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "VERIFIED claims require evidence",
      path: ["evidenceIds"],
    });
  }
});

export const EvidenceBundleSchema = z.object({
  bundleVersion: z.number().int().positive(),
  runId: IdentifierSchema,
  manifestHash: HashSchema,
  baseCommitSha: ShaSchema,
  resultCommitSha: ShaSchema,
  environmentDigest: HashSchema,
  artifacts: z.array(z.object({
    artifactId: IdentifierSchema,
    type: z.string().min(1).max(200),
    sha256: HashSchema,
    createdAt: IsoTimestampSchema,
    producer: IdentifierSchema,
    sizeBytes: z.number().int().nonnegative(),
  }).strict()),
  claims: z.array(ClaimEvidenceSchema),
  finalDecision: z.string().min(1).max(200),
  createdAt: IsoTimestampSchema,
}).strict();

export const SupervisorPrCommandSchema = z.object({
  runId: IdentifierSchema,
  repositoryId: IdentifierSchema,
  baseBranch: z.string().min(1).max(250),
  expectedBaseCommitSha: ShaSchema,
  resultCommitSha: ShaSchema,
  manifestHash: HashSchema,
  evidenceBundleHash: HashSchema,
  reviewDecisionId: IdentifierSchema,
  humanApprovalId: IdentifierSchema.nullable(),
  riskTier: RiskTierSchema,
  idempotencyKey: z.string().regex(/^pr:create:[^:]+:[a-f0-9]{40,64}$/i),
}).strict();

export const ModelRoutingDecisionSchema = z.object({
  routingDecisionId: IdentifierSchema,
  runId: IdentifierSchema,
  agentExecutionId: IdentifierSchema,
  agentRole: ModelRoleSchema,
  logicalTier: LogicalModelTierSchema,
  resolvedModel: z.string().min(1).max(500),
  routingPolicyVersion: z.string().min(1).max(200),
  fallbackUsed: z.boolean(),
  fallbackReason: z.string().max(2_000).nullable(),
  cacheKey: z.string().max(2_000).nullable(),
  timestamp: IsoTimestampSchema,
}).strict();

export type RunState = z.infer<typeof RunStateSchema>;
export type ActorType = z.infer<typeof ActorTypeSchema>;
export type RiskTier = z.infer<typeof RiskTierSchema>;
export type FailureClass = z.infer<typeof FailureClassSchema>;
export type RepositoryReference = z.infer<typeof RepositoryReferenceSchema>;
export type TaskManifestContent = z.infer<typeof TaskManifestContentSchema>;
export type TaskManifest = z.infer<typeof TaskManifestSchema>;
export type RunStateEvent = z.infer<typeof RunStateEventSchema>;
export type EngineerRun = z.infer<typeof EngineerRunSchema>;
export type RiskFeatures = z.infer<typeof RiskFeaturesSchema>;
export type RiskAssessment = z.infer<typeof RiskAssessmentSchema>;
export type RetryBudgets = z.infer<typeof RetryBudgetsSchema>;
export type RetryKind = z.infer<typeof RetryKindSchema>;
export type LogicalModelTier = z.infer<typeof LogicalModelTierSchema>;
export type ModelRole = z.infer<typeof ModelRoleSchema>;
export type TrustedEvidence = z.infer<typeof TrustedEvidenceSchema>;
export type ReviewerInput = z.infer<typeof ReviewerInputSchema>;
export type ReviewerOutput = z.infer<typeof ReviewerOutputSchema>;
export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;
export type RepairContext = z.infer<typeof RepairContextSchema>;
export type ClaimEvidence = z.infer<typeof ClaimEvidenceSchema>;
export type EvidenceBundle = z.infer<typeof EvidenceBundleSchema>;
export type SupervisorPrCommand = z.infer<typeof SupervisorPrCommandSchema>;
export type ModelRoutingDecision = z.infer<typeof ModelRoutingDecisionSchema>;
