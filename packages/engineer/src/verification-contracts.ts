import { z } from "zod";
import { EvidenceBundleSchema, ReviewerOutputSchema, type TaskManifest, type TrustedEvidence } from "./contracts.js";
import { deterministicScopeCriterionIds } from "./final-change-scope.js";
import { sha256 } from "./hash.js";

const IdentifierSchema = z.string().min(1).max(200);
const HashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const IsoTimestampSchema = z.string().datetime({ offset: true });

export const VERIFICATION_COVERAGE_POLICY_VERSION = "engineer-verification-coverage-v1";

export const CriterionVerificationCoverageSchema = z.object({
  criterionId: IdentifierSchema,
  priority: z.enum(["MUST", "SHOULD", "MAY"]),
  testIds: z.array(IdentifierSchema),
  executableTestIds: z.array(IdentifierSchema),
  /** Present only when the final change-scope attestation is this row's proof. */
  deterministicScopeAttestation: z.literal(true).optional(),
  status: z.enum(["COVERED", "UNCOVERED"]),
}).strict();

export const VerificationCoverageMatrixSchema = z.object({
  policyVersion: z.literal(VERIFICATION_COVERAGE_POLICY_VERSION),
  runId: IdentifierSchema,
  manifestHash: HashSchema,
  criteria: z.array(CriterionVerificationCoverageSchema).min(1),
  nonExecutableTestIds: z.array(IdentifierSchema),
  allPlanItemsExecutable: z.boolean(),
  securityGateRequired: z.boolean(),
  executableSecurityTestIds: z.array(IdentifierSchema),
  deterministicSecurityGateCovered: z.boolean(),
  securityGateCovered: z.boolean(),
  allMustCriteriaCovered: z.boolean(),
  matrixHash: HashSchema,
}).strict().superRefine((matrix, context) => {
  const { matrixHash, ...content } = matrix;
  if (sha256(content) !== matrixHash) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "verification coverage matrix hash mismatch", path: ["matrixHash"] });
  }
  const expected = matrix.criteria
    .filter((criterion) => criterion.priority === "MUST")
    .every((criterion) => criterion.status === "COVERED" &&
      (criterion.executableTestIds.length > 0 || criterion.deterministicScopeAttestation === true));
  if (matrix.allMustCriteriaCovered !== expected) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "MUST coverage summary does not match matrix rows", path: ["allMustCriteriaCovered"] });
  }
  if (matrix.allPlanItemsExecutable !== (matrix.nonExecutableTestIds.length === 0)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "test-plan executability summary does not match matrix", path: ["allPlanItemsExecutable"] });
  }
  if (matrix.securityGateCovered !== (!matrix.securityGateRequired || matrix.executableSecurityTestIds.length > 0 || matrix.deterministicSecurityGateCovered)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "security gate summary does not match matrix", path: ["securityGateCovered"] });
  }
});

export function buildVerificationCoverageMatrix(manifest: TaskManifest, options: { deterministicSecurityGateCovered?: boolean } = {}) {
  const deterministicScopeCriteria = new Set(deterministicScopeCriterionIds(manifest));
  const criteria = manifest.acceptanceCriteria.map((criterion) => {
    const tests = manifest.testPlan.filter((test) => test.criterionIds.includes(criterion.criterionId));
    const executable = tests.filter((test) => Boolean(test.command));
    const deterministicScopeAttestation = deterministicScopeCriteria.has(criterion.criterionId);
    return CriterionVerificationCoverageSchema.parse({
      criterionId: criterion.criterionId,
      priority: criterion.priority,
      testIds: tests.map((test) => test.testId),
      executableTestIds: executable.map((test) => test.testId),
      ...(deterministicScopeAttestation ? { deterministicScopeAttestation: true as const } : {}),
      status: executable.length > 0 || deterministicScopeAttestation ? "COVERED" : "UNCOVERED",
    });
  });
  const content = {
    policyVersion: VERIFICATION_COVERAGE_POLICY_VERSION,
    runId: manifest.runId,
    manifestHash: manifest.manifestHash,
    criteria,
    nonExecutableTestIds: manifest.testPlan.filter((test) => !test.command).map((test) => test.testId),
    allPlanItemsExecutable: manifest.testPlan.every((test) => Boolean(test.command)),
    securityGateRequired: manifest.riskTier === "HIGH" || manifest.riskTier === "CRITICAL",
    executableSecurityTestIds: manifest.testPlan
      .filter((test) => test.type === "SECURITY" && Boolean(test.command))
      .map((test) => test.testId),
    deterministicSecurityGateCovered: options.deterministicSecurityGateCovered === true,
    securityGateCovered: manifest.riskTier !== "HIGH" && manifest.riskTier !== "CRITICAL"
      || manifest.testPlan.some((test) => test.type === "SECURITY" && Boolean(test.command))
      || options.deterministicSecurityGateCovered === true,
    allMustCriteriaCovered: criteria
      .filter((criterion) => criterion.priority === "MUST")
      .every((criterion) => criterion.status === "COVERED"),
  } as const;
  return VerificationCoverageMatrixSchema.parse({ ...content, matrixHash: sha256(content) });
}

/** Only a successful independent executor record can substantiate a criterion. */
export function trustedEvidenceSupportsCriterion(evidence: TrustedEvidence, criterionId: string): boolean {
  const criterionIds = evidence.payload.criterionIds;
  const independentlyExecuted = evidence.eventType === "INDEPENDENT_VERIFICATION"
    && evidence.producerType === "EXECUTOR"
    && evidence.payload.status === "SUCCEEDED"
    && Array.isArray(criterionIds)
    && criterionIds.every((value) => typeof value === "string")
    && criterionIds.includes(criterionId);
  const scopeAttested = evidence.eventType === "FINAL_CHANGE_SCOPE_ATTESTATION"
    && evidence.producerType === "SYSTEM"
    && evidence.producerId === "final-change-scope-policy"
    && evidence.payload.status === "SUCCEEDED"
    && evidence.payload.credentialedGitOperationCount === 0
    && Array.isArray(criterionIds)
    && criterionIds.every((value) => typeof value === "string")
    && criterionIds.includes(criterionId);
  return independentlyExecuted || scopeAttested;
}

export const VerificationExecutionRecordSchema = z.object({
  verificationExecutionId: IdentifierSchema,
  runId: IdentifierSchema,
  verificationPass: z.number().int().positive().default(1),
  testId: IdentifierSchema,
  commandExecutionId: IdentifierSchema,
  criterionIds: z.array(IdentifierSchema).min(1),
  type: z.enum(["FORMAT", "LINT", "TYPECHECK", "BUILD", "UNIT", "INTEGRATION", "E2E", "SECURITY", "MIGRATION", "REGRESSION"]),
  randomSeed: z.string().max(500).nullable(),
  status: z.enum(["PASSED", "FAILED", "TIMED_OUT", "BLOCKED"]),
  startedAt: IsoTimestampSchema,
  completedAt: IsoTimestampSchema,
}).strict();

export const SecurityFindingRecordSchema = z.object({
  securityFindingId: IdentifierSchema,
  runId: IdentifierSchema,
  severity: z.enum(["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"]),
  category: z.string().min(1).max(200),
  description: z.string().min(1).max(10_000),
  file: z.string().max(2_000).nullable(),
  lineStart: z.number().int().nonnegative().nullable(),
  lineEnd: z.number().int().nonnegative().nullable(),
  evidenceIds: z.array(IdentifierSchema),
  status: z.enum(["OPEN", "RESOLVED", "ACCEPTED_RISK"]),
  createdAt: IsoTimestampSchema,
}).strict().refine((finding) => finding.lineStart === null || finding.lineEnd === null || finding.lineEnd >= finding.lineStart, {
  message: "lineEnd must be greater than or equal to lineStart",
  path: ["lineEnd"],
});

export const ReviewerSessionRecordSchema = z.object({
  reviewerSessionId: IdentifierSchema,
  runId: IdentifierSchema,
  attempt: z.number().int().positive(),
  modelTier: z.literal("GPT-5.6_SOL"),
  resolvedModel: z.string().min(1).max(500),
  inputHash: HashSchema,
  manifestHash: HashSchema,
  diffHash: HashSchema,
  evidenceBundleHash: HashSchema,
  policyVersion: z.string().min(1).max(200),
  cacheKey: HashSchema,
  cacheHit: z.boolean().nullable(),
  startedAt: IsoTimestampSchema,
  completedAt: IsoTimestampSchema,
  decision: z.enum(["APPROVE", "REQUEST_CHANGES", "REJECT", "HUMAN_REVIEW_REQUIRED"]),
  isolationVerified: z.boolean(),
  output: ReviewerOutputSchema,
}).strict();

export const ReviewFindingRecordSchema = z.object({
  reviewerSessionId: IdentifierSchema,
  findingId: IdentifierSchema,
  fingerprint: HashSchema,
  severity: z.enum(["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"]),
  category: z.string().min(1).max(200),
  file: z.string().max(2_000),
  lineStart: z.number().int().nonnegative(),
  lineEnd: z.number().int().nonnegative(),
  description: z.string().min(1).max(10_000),
  requiredChange: z.string().min(1).max(10_000),
  criterionIds: z.array(IdentifierSchema),
  evidenceIds: z.array(IdentifierSchema),
  status: z.enum(["OPEN", "RESOLVED", "REJECTED"]),
}).strict();

export const ClaimEvidenceRecordSchema = z.object({
  claimId: IdentifierSchema,
  claim: z.string().min(1).max(10_000),
  status: z.enum([
    "VERIFIED", "PARTIALLY_VERIFIED", "FAILED", "UNVERIFIED",
    "BLOCKED_BY_INFRASTRUCTURE", "BLOCKED_BY_EXTERNAL_DEPENDENCY", "HUMAN_REVIEW_REQUIRED",
  ]),
  evidenceIds: z.array(IdentifierSchema),
  notes: z.string().max(10_000),
  runId: IdentifierSchema,
  criterionId: IdentifierSchema.nullable(),
  createdAt: IsoTimestampSchema,
}).strict().superRefine((claim, context) => {
  if (claim.status === "VERIFIED" && claim.evidenceIds.length === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "VERIFIED claims require evidence", path: ["evidenceIds"] });
  }
});

export const EvidenceBundleRecordSchema = z.object({
  evidenceBundleId: IdentifierSchema,
  bundle: EvidenceBundleSchema,
  bundleHash: HashSchema,
}).strict();

export const VerificationResultSchema = z.object({
  runId: IdentifierSchema,
  verificationExecutions: z.array(VerificationExecutionRecordSchema),
  securityFindings: z.array(SecurityFindingRecordSchema),
  reviewerSession: ReviewerSessionRecordSchema,
  claims: z.array(ClaimEvidenceRecordSchema),
  evidenceBundle: EvidenceBundleRecordSchema,
}).strict();

export type VerificationExecutionRecord = z.infer<typeof VerificationExecutionRecordSchema>;
export type CriterionVerificationCoverage = z.infer<typeof CriterionVerificationCoverageSchema>;
export type VerificationCoverageMatrix = z.infer<typeof VerificationCoverageMatrixSchema>;
export type SecurityFindingRecord = z.infer<typeof SecurityFindingRecordSchema>;
export type ReviewerSessionRecord = z.infer<typeof ReviewerSessionRecordSchema>;
export type ReviewFindingRecord = z.infer<typeof ReviewFindingRecordSchema>;
export type ClaimEvidenceRecord = z.infer<typeof ClaimEvidenceRecordSchema>;
export type EvidenceBundleRecord = z.infer<typeof EvidenceBundleRecordSchema>;
export type VerificationResult = z.infer<typeof VerificationResultSchema>;
