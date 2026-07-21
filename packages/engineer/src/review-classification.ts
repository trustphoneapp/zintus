import { z } from "zod";
import { TaskManifestSchema, type TaskManifest, type TrustedEvidence } from "./contracts.js";
import { canonicalJson, sha256 } from "./hash.js";
import { isManifestPathAllowed } from "./manifest-files.js";
import {
  RequiredLaneContractSchema,
  type RequiredLaneContract,
} from "./required-lane-contracts.js";
import { REQUIRED_LANE_REVIEWER_MAPPING_POLICY_VERSION } from "./required-lane-policy-versions.js";
import { ADVERSARIAL_COVERAGE_POLICY_VERSION, AdversarialCoverageReportSchema } from "./adversarial-coverage.js";
import {
  ReviewFindingRecordSchema,
  ReviewerSessionRecordSchema,
  type ReviewFindingRecord,
  type ReviewerSessionRecord,
} from "./verification-contracts.js";

const IdentifierSchema = z.string().min(1).max(200);
const HashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const TimestampSchema = z.string().datetime({ offset: true });
const codeUnitCompare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const sortedStrings = (values: readonly string[]): string[] => [...values].sort(codeUnitCompare);

export const RequiredTestGateSchema = z.object({
  testId: IdentifierSchema,
  evidenceId: IdentifierSchema.nullable(),
  status: z.enum(["PASSED", "FAILED", "TIMED_OUT", "BLOCKED", "MISSING"]),
}).strict();

/** A byte-level reference to the exact provider function-call arguments artifact. */
export const RawReviewerOutputReferenceSchema = z.object({
  artifactId: IdentifierSchema,
  sha256: HashSchema,
  byteLength: z.number().int().nonnegative(),
  mediaType: z.literal("application/json"),
}).strict();

const ReviewFindingClassificationContentSchema = z.object({
  findingId: IdentifierSchema,
  findingFingerprint: HashSchema,
  disposition: z.enum(["BLOCKING", "HUMAN_REQUIRED", "ADVISORY"]),
  authority: z.enum([
    "REQUIRED_CRITERION_FAILURE",
    "DETERMINISTIC_SECURITY_FAILURE",
    "DETERMINISTIC_SCOPE_FAILURE",
    "ATTESTED_COVERAGE_GAP",
    "NONE",
  ]),
  authorityRefs: z.array(IdentifierSchema),
  evidenceIds: z.array(IdentifierSchema),
  reasonCode: z.enum([
    "FAILED_REQUIRED_TEST",
    "DETERMINISTIC_HIGH_RISK_SECURITY_FINDING",
    "DETERMINISTIC_SCOPE_VIOLATION",
    "ATTESTED_MUST_COVERAGE_GAP",
    "IN_SCOPE_REVIEWER_REPAIR_CANDIDATE",
    "UNSUBSTANTIATED_REQUIRED_CRITERION_CLAIM",
    "UNPROVEN_SECURITY_CLAIM",
    "REPAIR_OUTSIDE_FROZEN_SCOPE",
    "OUTSIDE_FROZEN_REQUIRED_SCOPE",
  ]),
}).strict();

export const ReviewFindingClassificationSchema = ReviewFindingClassificationContentSchema.extend({
  classificationHash: HashSchema,
}).strict().superRefine((classification, context) => {
  const { classificationHash, ...content } = classification;
  if (sha256(content) !== classificationHash) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "classificationHash does not match canonical content", path: ["classificationHash"] });
  }
  const sortedUnique = (values: readonly string[]) =>
    values.length === new Set(values).size && values.every((value, index) => value === sortedStrings(values)[index]);
  if (!sortedUnique(classification.authorityRefs)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "authorityRefs must be sorted and unique", path: ["authorityRefs"] });
  }
  if (!sortedUnique(classification.evidenceIds)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "evidenceIds must be sorted and unique", path: ["evidenceIds"] });
  }
  if (classification.disposition === "BLOCKING" && classification.authority === "NONE") {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "blocking classifications require deterministic authority", path: ["authority"] });
  }
  if (classification.disposition !== "BLOCKING" && classification.authority !== "NONE") {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "non-blocking classifications cannot claim deterministic authority", path: ["authority"] });
  }
});

const ReviewClassificationBatchContentSchema = z.object({
  schemaVersion: z.literal(1),
  policyVersion: z.literal(REQUIRED_LANE_REVIEWER_MAPPING_POLICY_VERSION),
  runId: IdentifierSchema,
  reviewerSessionId: IdentifierSchema,
  contractHash: HashSchema,
  manifestHash: HashSchema,
  rawOutput: RawReviewerOutputReferenceSchema,
  normalizedOutputHash: HashSchema,
  normalizedSessionHash: HashSchema,
  normalizedFindingsHash: HashSchema,
  trustedEvidenceIdentityHash: HashSchema,
  provenanceConflict: z.boolean(),
  systemGateReasons: z.array(z.enum([
    "MODEL_HUMAN_REQUEST", "MODEL_REJECT_WITHOUT_PROOF", "ISOLATION_NOT_VERIFIED", "PROVENANCE_CONFLICT",
    "REQUIRED_TEST_EVIDENCE_MISSING", "REQUIRED_TEST_FAILED",
  ])),
  requiredTestGates: z.array(RequiredTestGateSchema),
  result: z.enum(["REPAIR_REQUIRED", "BLOCKED", "HUMAN_REVIEW_REQUIRED", "READY_WITH_ADVISORIES", "READY"]),
  classifications: z.array(ReviewFindingClassificationSchema),
  createdAt: TimestampSchema,
}).strict();

export const ReviewClassificationBatchSchema = ReviewClassificationBatchContentSchema.extend({
  classificationHash: HashSchema,
}).strict().superRefine((batch, context) => {
  const { classificationHash, ...content } = batch;
  if (sha256(content) !== classificationHash) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "classificationHash does not match canonical content", path: ["classificationHash"] });
  }
  const ids = batch.classifications.map((item) => item.findingId);
  if (ids.length !== new Set(ids).size || ids.some((id, index) => id !== sortedStrings(ids)[index])) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "classifications must be sorted by unique findingId", path: ["classifications"] });
  }
  if (batch.systemGateReasons.length !== new Set(batch.systemGateReasons).size ||
      batch.systemGateReasons.some((reason, index) => reason !== sortedStrings(batch.systemGateReasons)[index])) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "systemGateReasons must be sorted and unique", path: ["systemGateReasons"] });
  }
  const requiredTestIds = batch.requiredTestGates.map((gate) => gate.testId);
  if (requiredTestIds.length !== new Set(requiredTestIds).size ||
      requiredTestIds.some((testId, index) => testId !== sortedStrings(requiredTestIds)[index])) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "requiredTestGates must be sorted by unique testId", path: ["requiredTestGates"] });
  }
});

export interface ClassifyReviewerOutputInput {
  contract: RequiredLaneContract;
  manifest: TaskManifest;
  session: ReviewerSessionRecord;
  findings: ReviewFindingRecord[];
  trustedEvidence: TrustedEvidence[];
  rawOutput: z.input<typeof RawReviewerOutputReferenceSchema>;
  provenanceConflict?: boolean;
  requiredTestGates?: z.input<typeof RequiredTestGateSchema>[];
}

type Classification = z.infer<typeof ReviewFindingClassificationContentSchema>;

function strings(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
}

function normalizedFindingFromOutput(
  reviewerSessionId: string,
  finding: ReviewerSessionRecord["output"]["findings"][number],
): ReviewFindingRecord {
  return ReviewFindingRecordSchema.parse({
    reviewerSessionId,
    ...finding,
    findingId: sha256({
      namespace: "review-finding-record-v1",
      reviewerSessionId,
      providerFindingId: finding.findingId,
    }),
    fingerprint: sha256({
      severity: finding.severity,
      category: finding.category.trim().toLowerCase(),
      file: finding.file,
      description: finding.description.trim().toLowerCase(),
      requiredChange: finding.requiredChange.trim().toLowerCase(),
    }),
    status: "OPEN",
  });
}

function failedRequiredTest(
  finding: ReviewFindingRecord,
  contract: Extract<RequiredLaneContract, { schemaVersion: 2 }>,
  evidence: TrustedEvidence[],
): Classification | null {
  const requiredCriteria = finding.criterionIds.filter((id) => contract.requiredCriterionIds.includes(id)).sort(codeUnitCompare);
  for (const item of evidence) {
    const criterionIds = strings(item.payload.criterionIds);
    if (item.eventType !== "INDEPENDENT_VERIFICATION" || item.producerType !== "EXECUTOR" ||
        item.payload.policyVersion !== contract.policyBindings.verificationPolicyVersion ||
        !contract.requiredTestIds.includes(String(item.payload.testId)) ||
        !["FAILED", "TIMED_OUT", "BLOCKED"].includes(String(item.payload.status))) continue;
    const refs = requiredCriteria.filter((id) => criterionIds.includes(id));
    if (refs.length > 0) return {
      findingId: finding.findingId,
      findingFingerprint: finding.fingerprint,
      disposition: "BLOCKING",
      authority: "REQUIRED_CRITERION_FAILURE",
      authorityRefs: refs,
      evidenceIds: [item.evidenceId],
      reasonCode: "FAILED_REQUIRED_TEST",
    };
  }
  return null;
}

// A hash-bound system coverage report may authorize one repair, but only for a
// MUST gap in an already-allowed test file. Model prose alone remains human-only.
function attestedCoverageGap(finding: ReviewFindingRecord, contract: Extract<RequiredLaneContract, { schemaVersion: 2 }>, manifest: TaskManifest, session: ReviewerSessionRecord, evidence: TrustedEvidence[]): Classification | null {
  if (!finding.file || !isManifestPathAllowed(finding.file, manifest) || !/(?:^|\/)(?:test|tests|__tests__)(?:\/|$)|\.(?:test|spec)\./i.test(finding.file)) return null;
  const providerFinding = session.output.findings.find((item) => normalizedFindingFromOutput(session.reviewerSessionId, item).findingId === finding.findingId);
  if (!providerFinding) return null;
  for (const item of evidence) {
    if (item.eventType !== "ADVERSARIAL_COVERAGE_REPORT" || item.producerType !== "SYSTEM" || item.producerId !== "adversarial-coverage-policy") continue;
    const report = AdversarialCoverageReportSchema.safeParse(item.payload);
    if (!report.success || report.data.policyVersion !== ADVERSARIAL_COVERAGE_POLICY_VERSION || report.data.runId !== contract.runId || report.data.manifestHash !== contract.manifestHash) continue;
    const gap = report.data.gaps.find((value) => value.gapId === providerFinding.findingId && value.blocking);
    if (!gap || !gap.criterionIds.some((id) => contract.requiredCriterionIds.includes(id))) continue;
    return { findingId: finding.findingId, findingFingerprint: finding.fingerprint, disposition: "BLOCKING", authority: "ATTESTED_COVERAGE_GAP", authorityRefs: [...gap.criterionIds].sort(codeUnitCompare), evidenceIds: [item.evidenceId], reasonCode: "ATTESTED_MUST_COVERAGE_GAP" };
  }
  return null;
}

// A concrete in-scope finding earns one bounded repair only when the Reviewer
// actually stands behind a defect on a required criterion: it either declined to
// mark that criterion satisfied, or it bound the finding to a hash-verified
// adversarial coverage gap for it. A finding raised while the Reviewer marks the
// same required criterion satisfied, with no evidence binding, is contradictory
// opinion — not repair authority — and stays human-only.
function reviewerStandsBehindInScopeDefect(finding: ReviewFindingRecord, contract: Extract<RequiredLaneContract, { schemaVersion: 2 }>, session: ReviewerSessionRecord, evidence: TrustedEvidence[]): boolean {
  const requiredFindingCriteria = finding.criterionIds.filter((id) => contract.requiredCriterionIds.includes(id));
  if (requiredFindingCriteria.length === 0) return false;
  const coverageStatus = new Map(session.output.requirementCoverage.map((item) => [item.criterionId, item.status]));
  if (requiredFindingCriteria.some((id) => coverageStatus.get(id) !== "SATISFIED")) return true;
  const providerFinding = session.output.findings.find((item) => normalizedFindingFromOutput(session.reviewerSessionId, item).findingId === finding.findingId);
  if (!providerFinding) return false;
  return evidence.some((item) => {
    if (item.eventType !== "ADVERSARIAL_COVERAGE_REPORT" || item.producerType !== "SYSTEM" || item.producerId !== "adversarial-coverage-policy") return false;
    const report = AdversarialCoverageReportSchema.safeParse(item.payload);
    if (!report.success || report.data.policyVersion !== ADVERSARIAL_COVERAGE_POLICY_VERSION || report.data.runId !== contract.runId || report.data.manifestHash !== contract.manifestHash) return false;
    return report.data.gaps.some((gap) => gap.gapId === providerFinding.findingId && gap.criterionIds.some((id) => requiredFindingCriteria.includes(id)));
  });
}

function deterministicSecurityFailure(
  finding: ReviewFindingRecord,
  contract: Extract<RequiredLaneContract, { schemaVersion: 2 }>,
  session: ReviewerSessionRecord,
  evidence: TrustedEvidence[],
): Classification | null {
  for (const item of evidence) {
    if (item.eventType !== "SECURITY_REPORT" || item.producerType !== "SYSTEM" ||
        item.producerId !== "deterministic-security-scanner" ||
        item.payload.policyVersion !== contract.policyBindings.securityPolicyVersion ||
        item.payload.diffHash !== session.diffHash) continue;
    const findings = Array.isArray(item.payload.findings) ? item.payload.findings : [];
    const match = findings.find((candidate) => {
      if (!candidate || typeof candidate !== "object") return false;
      const value = candidate as Record<string, unknown>;
      return ["HIGH", "CRITICAL"].includes(String(value.severity)) &&
        value.category === finding.category && value.file === finding.file &&
        value.lineStart === finding.lineStart && value.lineEnd === finding.lineEnd &&
        typeof value.securityFindingId === "string";
    }) as Record<string, unknown> | undefined;
    if (match) return {
      findingId: finding.findingId,
      findingFingerprint: finding.fingerprint,
      disposition: "BLOCKING",
      authority: "DETERMINISTIC_SECURITY_FAILURE",
      authorityRefs: [String(match.securityFindingId)],
      evidenceIds: [item.evidenceId],
      reasonCode: "DETERMINISTIC_HIGH_RISK_SECURITY_FINDING",
    };
  }
  return null;
}

function deterministicScopeFailure(
  finding: ReviewFindingRecord,
  contract: Extract<RequiredLaneContract, { schemaVersion: 2 }>,
  session: ReviewerSessionRecord,
  evidence: TrustedEvidence[],
): Classification | null {
  for (const item of evidence) {
    const violations = strings(item.payload.violations);
    if (item.eventType !== "FINAL_CHANGE_SCOPE_ATTESTATION" || item.producerType !== "SYSTEM" ||
        item.producerId !== "final-change-scope-policy" || item.payload.status !== "FAILED" ||
        item.payload.manifestHash !== contract.manifestHash || item.payload.diffHash !== session.diffHash ||
        !violations.includes(finding.file)) continue;
    return {
      findingId: finding.findingId,
      findingFingerprint: finding.fingerprint,
      disposition: "BLOCKING",
      authority: "DETERMINISTIC_SCOPE_FAILURE",
      authorityRefs: [finding.file],
      evidenceIds: [item.evidenceId],
      reasonCode: "DETERMINISTIC_SCOPE_VIOLATION",
    };
  }
  return null;
}

/**
 * Maps normalized Reviewer findings to deterministic gateway dispositions.
 * Model severity, prose, and decision never create blocking authority.
 */
export function classifyReviewerOutput(input: ClassifyReviewerOutputInput): ReviewClassificationBatch {
  const contract = RequiredLaneContractSchema.parse(input.contract);
  if (contract.schemaVersion !== 2) throw new TypeError("legacy Required Lane contracts cannot authorize review classification");
  if (contract.policyBindings.reviewerMappingPolicyVersion !== REQUIRED_LANE_REVIEWER_MAPPING_POLICY_VERSION) {
    throw new TypeError("Required Lane reviewer mapping policy mismatch");
  }
  const session = ReviewerSessionRecordSchema.parse(input.session);
  const manifest = TaskManifestSchema.parse(input.manifest);
  const findings = input.findings.map((finding) => ReviewFindingRecordSchema.parse(finding));
  const rawOutput = RawReviewerOutputReferenceSchema.parse(input.rawOutput);
  if (session.runId !== contract.runId || session.manifestHash !== contract.manifestHash ||
      manifest.runId !== contract.runId || manifest.manifestHash !== contract.manifestHash) {
    throw new TypeError("Reviewer session does not match the Required Lane contract");
  }
  if (findings.some((finding) => finding.reviewerSessionId !== session.reviewerSessionId)) {
    throw new TypeError("Reviewer findings do not match the Reviewer session");
  }
  const evidenceIdentities = input.trustedEvidence.map((item) => ({
    evidenceId: item.evidenceId, declaredHash: item.sha256, payloadHash: sha256(item.payload),
  })).sort((left, right) => codeUnitCompare(left.evidenceId, right.evidenceId) || codeUnitCompare(left.declaredHash, right.declaredHash));
  const duplicateEvidenceConflict = evidenceIdentities.some((item, index) => index > 0 &&
    item.evidenceId === evidenceIdentities[index - 1]?.evidenceId);
  const invalidEvidenceDigest = evidenceIdentities.some((item) => item.declaredHash !== item.payloadHash);
  const expectedFindings = session.output.findings.map((finding) => normalizedFindingFromOutput(session.reviewerSessionId, finding))
    .sort((left, right) => codeUnitCompare(left.findingId, right.findingId));
  const normalizedProvenanceConflict = session.decision !== session.output.decision ||
    session.policyVersion !== session.output.reviewPolicyVersion ||
    session.diffHash !== session.output.reviewedDiffHash ||
    session.evidenceBundleHash !== session.output.reviewedEvidenceBundleHash ||
    sha256(expectedFindings) !== sha256([...findings].sort((left, right) => codeUnitCompare(left.findingId, right.findingId)));
  const evidenceById = new Map(input.trustedEvidence
    .filter((item) => item.runId === contract.runId && item.sha256 === sha256(item.payload))
    .map((item) => [item.evidenceId, item]));
  const classifications = [...findings].sort((left, right) => codeUnitCompare(left.findingId, right.findingId)).map((finding) => {
    const referenced = [...new Set(finding.evidenceIds)].sort(codeUnitCompare).flatMap((id) => {
      const item = evidenceById.get(id);
      return item ? [item] : [];
    });
    let classification = deterministicScopeFailure(finding, contract, session, referenced)
      ?? deterministicSecurityFailure(finding, contract, session, referenced)
      ?? failedRequiredTest(finding, contract, referenced)
      ?? attestedCoverageGap(finding, contract, manifest, session, referenced);
    // A Reviewer may report a project-level finding (for example a failed
    // repository command or a Supervisor-owned scope attestation) with no
    // single source file. Empty is a valid display label in that case, not a
    // filesystem path. Only concrete file findings enter manifest path scope
    // classification; they remain strictly validated there.
    if (!classification && finding.file !== "" && !isManifestPathAllowed(finding.file, manifest)) {
      classification = ReviewFindingClassificationContentSchema.parse({
          findingId: finding.findingId, findingFingerprint: finding.fingerprint, disposition: "HUMAN_REQUIRED", authority: "NONE",
          authorityRefs: [], evidenceIds: [], reasonCode: "REPAIR_OUTSIDE_FROZEN_SCOPE",
      });
    }
    if (!classification && /(?:SECURITY|SECRET|AUTH|INJECTION|XSS|CSRF|TLS|CRYPTO|VULNERAB)/i.test(finding.category)) {
      classification = ReviewFindingClassificationContentSchema.parse({
        findingId: finding.findingId, findingFingerprint: finding.fingerprint, disposition: "HUMAN_REQUIRED", authority: "NONE",
        authorityRefs: [], evidenceIds: [], reasonCode: "UNPROVEN_SECURITY_CLAIM",
      });
    }
    // A concrete, in-scope correction is safe to attempt once even when the
    // reviewer supplied no executor evidence. It is *not* a publishing gate:
    // we give the Builder a bounded repair opportunity, then rerun the same
    // deterministic checks and an independent review. Security, out-of-scope,
    // project-level, and vague findings continue to require a human decision.
    if (!classification && finding.file !== "" && finding.lineStart >= 0 && finding.lineEnd >= finding.lineStart &&
        finding.description.trim().length > 0 && finding.requiredChange.trim().length > 0 &&
        finding.criterionIds.some((id) => contract.requiredCriterionIds.includes(id)) &&
        reviewerStandsBehindInScopeDefect(finding, contract, session, referenced)) {
      classification = ReviewFindingClassificationContentSchema.parse({
          findingId: finding.findingId, findingFingerprint: finding.fingerprint, disposition: "ADVISORY", authority: "NONE",
          authorityRefs: [], evidenceIds: [], reasonCode: "IN_SCOPE_REVIEWER_REPAIR_CANDIDATE",
      });
    }
    if (!classification && finding.criterionIds.some((id) => contract.requiredCriterionIds.includes(id))) {
      classification = ReviewFindingClassificationContentSchema.parse({
        findingId: finding.findingId, findingFingerprint: finding.fingerprint, disposition: "HUMAN_REQUIRED", authority: "NONE",
        authorityRefs: [], evidenceIds: [], reasonCode: "UNSUBSTANTIATED_REQUIRED_CRITERION_CLAIM",
      });
    }
    return classification ?? ReviewFindingClassificationContentSchema.parse({
      findingId: finding.findingId, findingFingerprint: finding.fingerprint, disposition: "ADVISORY", authority: "NONE",
      authorityRefs: [], evidenceIds: [], reasonCode: "OUTSIDE_FROZEN_REQUIRED_SCOPE",
    });
  });
  const hashedClassifications = classifications.map((classification) =>
    ReviewFindingClassificationSchema.parse({ ...classification, classificationHash: sha256(classification) }));
  const inferredRequiredTestGates = contract.requiredTestIds.map((testId) => {
    const matches = input.trustedEvidence.filter((item) => item.eventType === "INDEPENDENT_VERIFICATION" &&
      item.payload.policyVersion === contract.policyBindings.verificationPolicyVersion && item.payload.testId === testId);
    if (matches.length !== 1) return RequiredTestGateSchema.parse({ testId, evidenceId: null, status: "MISSING" });
    const item = matches[0]!;
    const commandStatus = String(item.payload.status);
    const status = commandStatus === "SUCCEEDED" ? "PASSED"
      : commandStatus === "TIMED_OUT" ? "TIMED_OUT"
        : commandStatus === "FAILED" ? "FAILED" : "BLOCKED";
    return RequiredTestGateSchema.parse({ testId, evidenceId: item.evidenceId, status });
  }).sort((left, right) => codeUnitCompare(left.testId, right.testId));
  const requiredTestGates = (input.requiredTestGates ?? inferredRequiredTestGates)
    .map((gate) => RequiredTestGateSchema.parse(gate))
    .sort((left, right) => codeUnitCompare(left.testId, right.testId));
  const requiredGateConflict = requiredTestGates.length !== contract.requiredTestIds.length ||
    new Set(requiredTestGates.map((gate) => gate.testId)).size !== requiredTestGates.length ||
    canonicalJson(requiredTestGates.map((gate) => gate.testId)) !== canonicalJson(sortedStrings(contract.requiredTestIds));
  const requiredMissing = requiredGateConflict || requiredTestGates.some((gate) => gate.status === "MISSING");
  const requiredFailed = requiredTestGates.some((gate) => ["FAILED", "TIMED_OUT", "BLOCKED"].includes(gate.status));
  const systemGateReasons = [
    ...(!session.isolationVerified ? ["ISOLATION_NOT_VERIFIED" as const] : []),
    ...(input.provenanceConflict || duplicateEvidenceConflict || invalidEvidenceDigest || normalizedProvenanceConflict
      ? ["PROVENANCE_CONFLICT" as const] : []),
    ...(session.decision === "HUMAN_REVIEW_REQUIRED" ? ["MODEL_HUMAN_REQUEST" as const] : []),
    ...(session.decision === "REJECT" ? ["MODEL_REJECT_WITHOUT_PROOF" as const] : []),
    ...(requiredMissing ? ["REQUIRED_TEST_EVIDENCE_MISSING" as const] : []),
    ...(requiredFailed ? ["REQUIRED_TEST_FAILED" as const] : []),
  ].sort(codeUnitCompare);
  const result = requiredFailed ? "BLOCKED"
    : requiredMissing ? "REPAIR_REQUIRED"
    : systemGateReasons.length > 0 || hashedClassifications.some((item) => item.disposition === "HUMAN_REQUIRED")
    ? "HUMAN_REVIEW_REQUIRED"
    : hashedClassifications.some((item) => item.disposition === "BLOCKING") ? "BLOCKED"
    : hashedClassifications.some((item) => item.reasonCode === "IN_SCOPE_REVIEWER_REPAIR_CANDIDATE") ? "REPAIR_REQUIRED"
    : hashedClassifications.length > 0 ? "READY_WITH_ADVISORIES" : "READY";
  const content = ReviewClassificationBatchContentSchema.parse({
    schemaVersion: 1,
    policyVersion: REQUIRED_LANE_REVIEWER_MAPPING_POLICY_VERSION,
    runId: contract.runId,
    reviewerSessionId: session.reviewerSessionId,
    contractHash: contract.contractHash,
    manifestHash: contract.manifestHash,
    rawOutput,
    normalizedOutputHash: sha256(session.output),
    normalizedSessionHash: sha256(session),
    normalizedFindingsHash: sha256([...findings].sort((left, right) => codeUnitCompare(left.findingId, right.findingId))),
    trustedEvidenceIdentityHash: sha256(evidenceIdentities),
    provenanceConflict: Boolean(input.provenanceConflict),
    systemGateReasons,
    requiredTestGates,
    result,
    classifications: hashedClassifications,
    createdAt: session.completedAt,
  });
  return ReviewClassificationBatchSchema.parse({ ...content, classificationHash: sha256(content) });
}

export type RawReviewerOutputReference = z.infer<typeof RawReviewerOutputReferenceSchema>;
export type RequiredTestGate = z.infer<typeof RequiredTestGateSchema>;
export type ReviewFindingClassification = z.infer<typeof ReviewFindingClassificationSchema>;
export type ReviewClassificationBatch = z.infer<typeof ReviewClassificationBatchSchema>;
