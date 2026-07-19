import { describe, expect, test } from "bun:test";
import { TrustedEvidenceSchema, TaskManifestSchema, type TaskManifestContent } from "./contracts.js";
import { sha256 } from "./hash.js";
import { createRequiredLaneContract } from "./required-lane-contracts.js";
import {
  REQUIRED_LANE_REVIEWER_MAPPING_POLICY_VERSION,
  SECURITY_POLICY_VERSION,
  VERIFICATION_POLICY_VERSION,
} from "./required-lane-policy-versions.js";
import { classifyReviewerOutput, ReviewClassificationBatchSchema } from "./review-classification.js";
import { TRUSTED_COMMAND_POLICY_VERSION } from "./trusted-executor.js";
import { ReviewFindingRecordSchema, ReviewerSessionRecordSchema } from "./verification-contracts.js";

const timestamp = "2026-07-17T16:00:00.000Z";
const hash = (value: string) => sha256(value);

function fixture() {
  const content: TaskManifestContent = {
    manifestVersion: 1, runId: "run-classification",
    repository: { repositoryId: "repo", provider: "local", owner: "local", name: "repo", baseBranch: "main", baseCommitSha: "a".repeat(40) },
    request: { original: "Implement scheduler", normalized: "Implement scheduler" },
    acceptanceCriteria: [
      { criterionId: "must-1", statement: "Required behavior works", verificationMethod: "Run unit tests", priority: "MUST" },
      { criterionId: "should-1", statement: "Optional polish", verificationMethod: "Review", priority: "SHOULD" },
    ],
    testPlan: [{ testId: "test-1", criterionIds: ["must-1"], type: "UNIT", description: "Unit test", command: "bun test" }],
    allowedPaths: ["src/**"], deniedPaths: [".env*"], allowedCommands: ["bun test"], prohibitedCommands: [],
    riskTier: "MEDIUM", humanGateRequired: true,
    retryBudgets: { sameFailureAttempts: 2, builderRepairAttempts: 4, reviewerFixAttempts: 2, plannerRestarts: 1, sandboxProvisioningAttempts: 3, transientModelAttempts: 3 },
    timeBudgetSeconds: 600, tokenBudget: 10_000, costBudgetUsd: 2, createdAt: timestamp,
  };
  const manifest = TaskManifestSchema.parse({ ...content, manifestHash: sha256(content) });
  const contract = createRequiredLaneContract({
    manifest, contextManifestHash: null, planProposalHash: null,
    policyBindings: {
      verificationPolicyVersion: VERIFICATION_POLICY_VERSION,
      securityPolicyVersion: SECURITY_POLICY_VERSION,
      reviewerMappingPolicyVersion: REQUIRED_LANE_REVIEWER_MAPPING_POLICY_VERSION,
      commandPolicyVersion: TRUSTED_COMMAND_POLICY_VERSION,
    },
  });
  const providerFindingId = "provider-finding-1";
  const findingContent = {
    severity: "CRITICAL" as const, category: "CORRECTNESS", file: "src/scheduler.ts",
    description: "The model claims the required behavior fails.", requiredChange: "Change it.",
  };
  const finding = ReviewFindingRecordSchema.parse({
    reviewerSessionId: "review-1",
    findingId: sha256({ namespace: "review-finding-record-v1", reviewerSessionId: "review-1", providerFindingId }),
    fingerprint: sha256({
      severity: findingContent.severity, category: findingContent.category.toLowerCase(), file: findingContent.file,
      description: findingContent.description.toLowerCase(), requiredChange: findingContent.requiredChange.toLowerCase(),
    }),
    ...findingContent, lineStart: 1, lineEnd: 1,
    criterionIds: ["must-1"], evidenceIds: [], status: "OPEN",
  });
  const output = {
    decision: "REQUEST_CHANGES" as const,
    requirementCoverage: [{ criterionId: "must-1", status: "FAILED" as const, evidenceIds: [], explanation: "Model assertion only." }],
    findings: [{
      findingId: providerFindingId, severity: finding.severity, category: finding.category, file: finding.file,
      lineStart: finding.lineStart, lineEnd: finding.lineEnd, description: finding.description,
      requiredChange: finding.requiredChange, criterionIds: finding.criterionIds, evidenceIds: finding.evidenceIds,
    }],
    unsupportedClaims: [], residualRisks: [], reviewedDiffHash: hash("d"), reviewedEvidenceBundleHash: hash("e"),
    reviewPolicyVersion: "reviewer-v1",
  };
  const session = ReviewerSessionRecordSchema.parse({
    reviewerSessionId: "review-1", runId: manifest.runId, attempt: 1, modelTier: "GPT-5.6_SOL", resolvedModel: "gpt-5.6",
    inputHash: hash("i"), manifestHash: manifest.manifestHash, diffHash: hash("d"), evidenceBundleHash: hash("e"),
    policyVersion: "reviewer-v1", cacheKey: hash("c"), cacheHit: null, startedAt: timestamp, completedAt: timestamp,
    decision: "REQUEST_CHANGES", isolationVerified: true, output,
  });
  return {
    contract, manifest, session, finding,
    requiredTestGates: [{ testId: "test-1", evidenceId: "required-pass", status: "PASSED" as const }],
    rawOutput: { artifactId: "raw-reviewer-output", sha256: hash("a"), byteLength: 123, mediaType: "application/json" as const },
  };
}

function sessionWithFinding(session: ReturnType<typeof ReviewerSessionRecordSchema.parse>, finding: ReturnType<typeof ReviewFindingRecordSchema.parse>) {
  const providerFinding = session.output.findings[0]!;
  return ReviewerSessionRecordSchema.parse({
    ...session,
    output: {
      ...session.output,
      findings: [{
        findingId: providerFinding.findingId,
        severity: finding.severity, category: finding.category, file: finding.file,
        lineStart: finding.lineStart, lineEnd: finding.lineEnd, description: finding.description,
        requiredChange: finding.requiredChange, criterionIds: finding.criterionIds, evidenceIds: finding.evidenceIds,
      }],
    },
  });
}

describe("deterministic Reviewer classification", () => {
  test("required-test gates decide readiness independently of the model", () => {
    const value = fixture();
    const approved = ReviewerSessionRecordSchema.parse({
      ...value.session,
      decision: "APPROVE",
      output: { ...value.session.output, decision: "APPROVE", findings: [], requirementCoverage: [] },
    });
    expect(classifyReviewerOutput({ ...value, session: approved, findings: [], trustedEvidence: [] })).toMatchObject({
      result: "READY", systemGateReasons: [],
    });
    expect(classifyReviewerOutput({
      ...value, session: approved, findings: [], trustedEvidence: [],
      requiredTestGates: [{ testId: "test-1", evidenceId: null, status: "MISSING" }],
    })).toMatchObject({ result: "REPAIR_REQUIRED", systemGateReasons: ["REQUIRED_TEST_EVIDENCE_MISSING"] });
    for (const status of ["FAILED", "TIMED_OUT", "BLOCKED"] as const) {
      expect(classifyReviewerOutput({
        ...value, session: approved, findings: [], trustedEvidence: [],
        requiredTestGates: [{ testId: "test-1", evidenceId: `required-${status}`, status }],
      })).toMatchObject({ result: "BLOCKED", systemGateReasons: ["REQUIRED_TEST_FAILED"] });
    }
    expect(() => classifyReviewerOutput({
      ...value, session: approved, findings: [], trustedEvidence: [],
      requiredTestGates: [
        { testId: "test-1", evidenceId: "first", status: "PASSED" },
        { testId: "test-1", evidenceId: "second", status: "PASSED" },
      ],
    })).toThrow("requiredTestGates");
  });

  test("never lets model severity or a MUST claim create blocking authority", () => {
    const value = fixture();
    const batch = classifyReviewerOutput({ ...value, findings: [value.finding], trustedEvidence: [] });
    expect(batch.result).toBe("HUMAN_REVIEW_REQUIRED");
    expect(batch.classifications).toEqual([expect.objectContaining({
      disposition: "HUMAN_REQUIRED", authority: "NONE", reasonCode: "UNSUBSTANTIATED_REQUIRED_CRITERION_CLAIM",
    })]);
    expect(batch.rawOutput.sha256).not.toBe(batch.normalizedOutputHash);
    expect(ReviewClassificationBatchSchema.parse(batch)).toEqual(batch);
  });

  test("blocks only when referenced executor evidence deterministically fails a frozen required test", () => {
    const value = fixture();
    const payload = { policyVersion: VERIFICATION_POLICY_VERSION, testId: "test-1", criterionIds: ["must-1"], status: "FAILED" };
    const evidence = TrustedEvidenceSchema.parse({
      evidenceId: "verification-failed", runId: value.session.runId, eventType: "INDEPENDENT_VERIFICATION",
      producerType: "EXECUTOR", producerId: "trusted-executor", sha256: sha256(payload), payload, createdAt: timestamp,
    });
    const finding = { ...value.finding, evidenceIds: [evidence.evidenceId] };
    const batch = classifyReviewerOutput({ ...value, session: sessionWithFinding(value.session, finding), findings: [finding], trustedEvidence: [evidence] });
    expect(batch.result).toBe("BLOCKED");
    expect(batch.classifications[0]).toMatchObject({
      disposition: "BLOCKING", authority: "REQUIRED_CRITERION_FAILURE", authorityRefs: ["must-1"],
      evidenceIds: ["verification-failed"], reasonCode: "FAILED_REQUIRED_TEST",
    });
  });

  test("does not accept unreferenced, successful, wrong-policy, or wrong-test evidence as blocking", () => {
    const value = fixture();
    for (const override of [
      { status: "PASSED" },
      { policyVersion: "wrong-policy", status: "FAILED" },
      { testId: "test-outside-contract", status: "FAILED" },
    ]) {
      const payload = { policyVersion: VERIFICATION_POLICY_VERSION, testId: "test-1", criterionIds: ["must-1"], ...override };
      const evidence = TrustedEvidenceSchema.parse({
        evidenceId: "not-authoritative", runId: value.session.runId, eventType: "INDEPENDENT_VERIFICATION",
        producerType: "EXECUTOR", producerId: "trusted-executor", sha256: sha256(payload), payload, createdAt: timestamp,
      });
      const finding = { ...value.finding, evidenceIds: [evidence.evidenceId] };
      expect(classifyReviewerOutput({ ...value, session: sessionWithFinding(value.session, finding), findings: [finding], trustedEvidence: [evidence] }).result)
        .toBe("HUMAN_REVIEW_REQUIRED");
    }
  });

  test("ignores evidence whose declared digest does not bind its payload", () => {
    const value = fixture();
    const payload = { policyVersion: VERIFICATION_POLICY_VERSION, testId: "test-1", criterionIds: ["must-1"], status: "FAILED" };
    const forged = TrustedEvidenceSchema.parse({
      evidenceId: "forged", runId: value.session.runId, eventType: "INDEPENDENT_VERIFICATION",
      producerType: "EXECUTOR", producerId: "trusted-executor", sha256: sha256({ ...payload, status: "PASSED" }), payload, createdAt: timestamp,
    });
    const batch = classifyReviewerOutput({
      ...value,
      session: sessionWithFinding(value.session, { ...value.finding, evidenceIds: [forged.evidenceId] }),
      findings: [{ ...value.finding, evidenceIds: [forged.evidenceId] }], trustedEvidence: [forged],
    });
    expect(batch.result).toBe("HUMAN_REVIEW_REQUIRED");
    expect(batch.classifications[0]?.authority).toBe("NONE");
    expect(batch.systemGateReasons).toContain("PROVENANCE_CONFLICT");
  });

  test("accepts exact deterministic security and scope attestations", () => {
    const value = fixture();
    const securityFinding = {
      securityFindingId: "security-1", runId: value.session.runId, severity: "CRITICAL", category: "CORRECTNESS",
      description: "deterministic", file: value.finding.file, lineStart: 1, lineEnd: 1, evidenceIds: [], status: "OPEN", createdAt: timestamp,
    };
    const securityPayload = { policyVersion: SECURITY_POLICY_VERSION, runId: value.session.runId, diffHash: value.session.diffHash, findings: [securityFinding] };
    const security = TrustedEvidenceSchema.parse({
      evidenceId: "security-report", runId: value.session.runId, eventType: "SECURITY_REPORT", producerType: "SYSTEM",
      producerId: "deterministic-security-scanner", sha256: sha256(securityPayload), payload: securityPayload, createdAt: timestamp,
    });
    const securityBatch = classifyReviewerOutput({
      ...value,
      session: sessionWithFinding(value.session, { ...value.finding, evidenceIds: [security.evidenceId] }),
      findings: [{ ...value.finding, evidenceIds: [security.evidenceId] }], trustedEvidence: [security],
    });
    expect(securityBatch.classifications[0]?.authority).toBe("DETERMINISTIC_SECURITY_FAILURE");

    const scopePayload = {
      policyVersion: "final-change-scope-v1", runId: value.session.runId, manifestHash: value.session.manifestHash,
      diffHash: value.session.diffHash, status: "FAILED", violations: [value.finding.file],
    };
    const scope = TrustedEvidenceSchema.parse({
      evidenceId: "scope-report", runId: value.session.runId, eventType: "FINAL_CHANGE_SCOPE_ATTESTATION", producerType: "SYSTEM",
      producerId: "final-change-scope-policy", sha256: sha256(scopePayload), payload: scopePayload, createdAt: timestamp,
    });
    const scopeBatch = classifyReviewerOutput({
      ...value,
      session: sessionWithFinding(value.session, { ...value.finding, evidenceIds: [scope.evidenceId] }),
      findings: [{ ...value.finding, evidenceIds: [scope.evidenceId] }], trustedEvidence: [scope],
    });
    expect(scopeBatch.classifications[0]?.authority).toBe("DETERMINISTIC_SCOPE_FAILURE");
  });

  test("is deterministic across finding/evidence order and rejects legacy contracts", () => {
    const value = fixture();
    const advisory = ReviewFindingRecordSchema.parse({
      ...value.finding, findingId: "finding-0", fingerprint: hash("0"), criterionIds: ["should-1"], severity: "INFO",
    });
    const first = classifyReviewerOutput({ ...value, findings: [value.finding, advisory], trustedEvidence: [] });
    const second = classifyReviewerOutput({ ...value, findings: [advisory, value.finding], trustedEvidence: [] });
    expect(first.classificationHash).toBe(second.classificationHash);
    const { contractHash: _hash, ...legacyContent } = value.contract;
    const legacyPolicyBindings = {
      verificationPolicyVersion: legacyContent.policyBindings.verificationPolicyVersion,
      securityPolicyVersion: legacyContent.policyBindings.securityPolicyVersion,
      reviewerMappingPolicyVersion: legacyContent.policyBindings.reviewerMappingPolicyVersion,
    };
    const legacy = {
      ...legacyContent, schemaVersion: 1 as const, policyVersion: "engineer-required-lane-v1" as const,
      policyBindings: legacyPolicyBindings,
    };
    const rehashed = { ...legacy, contractHash: sha256(legacy) };
    expect(() => classifyReviewerOutput({ ...value, contract: rehashed as never, findings: [], trustedEvidence: [] }))
      .toThrow("legacy Required Lane contracts");
  });

  test("uses locale-independent code-unit ordering for hash-bound classifications", () => {
    const value = fixture();
    const findingIds = ["a", "A", "!", "é", "Ω", "😀"];
    const records = findingIds.map((findingId) => ReviewFindingRecordSchema.parse({
      ...value.finding, findingId, fingerprint: hash(`fingerprint:${findingId}`), criterionIds: ["should-1"],
    }));
    const first = classifyReviewerOutput({ ...value, findings: records, trustedEvidence: [] });
    const second = classifyReviewerOutput({ ...value, findings: [...records].reverse(), trustedEvidence: [] });
    const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
    expect(first.classifications.map((item) => item.findingId)).toEqual([...findingIds].sort(compare));
    expect(first.classificationHash).toBe(second.classificationHash);
  });

  test("human-required ambiguity takes precedence over a deterministic blocking finding", () => {
    const value = fixture();
    const payload = { policyVersion: VERIFICATION_POLICY_VERSION, testId: "test-1", criterionIds: ["must-1"], status: "FAILED" };
    const evidence = TrustedEvidenceSchema.parse({
      evidenceId: "failed", runId: value.session.runId, eventType: "INDEPENDENT_VERIFICATION",
      producerType: "EXECUTOR", producerId: "trusted-executor", sha256: sha256(payload), payload, createdAt: timestamp,
    });
    const ambiguous = ReviewFindingRecordSchema.parse({
      ...value.finding, findingId: "finding-ambiguous", fingerprint: hash("ambiguous"), evidenceIds: [],
    });
    const blocked = ReviewFindingRecordSchema.parse({ ...value.finding, evidenceIds: [evidence.evidenceId] });
    const batch = classifyReviewerOutput({ ...value, findings: [blocked, ambiguous], trustedEvidence: [evidence] });
    expect(batch.classifications.some((item) => item.disposition === "BLOCKING")).toBe(true);
    expect(batch.result).toBe("HUMAN_REVIEW_REQUIRED");
  });

  test("unverified Reviewer isolation forces a human result", () => {
    const value = fixture();
    const session = ReviewerSessionRecordSchema.parse({ ...value.session, isolationVerified: false });
    expect(classifyReviewerOutput({ ...value, session, findings: [], trustedEvidence: [] }).result)
      .toBe("HUMAN_REVIEW_REQUIRED");
  });

  test("empty model REJECT and HUMAN_REVIEW_REQUIRED decisions remain human gates", () => {
    const value = fixture();
    for (const decision of ["REJECT", "HUMAN_REVIEW_REQUIRED"] as const) {
      const session = ReviewerSessionRecordSchema.parse({
        ...value.session, decision, output: { ...value.session.output, decision, findings: [] },
      });
      const batch = classifyReviewerOutput({ ...value, session, findings: [], trustedEvidence: [] });
      expect(batch.result).toBe("HUMAN_REVIEW_REQUIRED");
      expect(batch.systemGateReasons.length).toBeGreaterThan(0);
    }
  });

  test("normalized Reviewer omissions and session/output binding mismatches gate for provenance review", () => {
    const value = fixture();
    const omitted = ReviewerSessionRecordSchema.parse({
      ...value.session,
      decision: "APPROVE",
      output: { ...value.session.output, decision: "APPROVE", findings: [] },
    });
    const omittedBatch = classifyReviewerOutput({ ...value, session: omitted, findings: [value.finding], trustedEvidence: [] });
    expect(omittedBatch.systemGateReasons).toContain("PROVENANCE_CONFLICT");
    expect(omittedBatch.result).toBe("HUMAN_REVIEW_REQUIRED");

    const mismatched = ReviewerSessionRecordSchema.parse({ ...value.session, policyVersion: "different-review-policy" });
    const mismatchBatch = classifyReviewerOutput({ ...value, session: mismatched, findings: [value.finding], trustedEvidence: [] });
    expect(mismatchBatch.systemGateReasons).toContain("PROVENANCE_CONFLICT");
  });

  test("unproven security and out-of-scope repair claims require a human", () => {
    const value = fixture();
    const unprovenSecurity = ReviewFindingRecordSchema.parse({
      ...value.finding, findingId: "security-claim", fingerprint: hash("security-claim"), category: "AUTH_BYPASS",
      criterionIds: ["should-1"], evidenceIds: [],
    });
    const outsideScope = ReviewFindingRecordSchema.parse({
      ...value.finding, findingId: "outside-scope", fingerprint: hash("outside-scope"), file: "infra/prod.tf",
      criterionIds: ["should-1"], evidenceIds: [],
    });
    const batch = classifyReviewerOutput({ ...value, findings: [unprovenSecurity, outsideScope], trustedEvidence: [] });
    expect(batch.result).toBe("HUMAN_REVIEW_REQUIRED");
    expect(batch.classifications.map((item) => item.reasonCode).sort()).toEqual([
      "REPAIR_OUTSIDE_FROZEN_SCOPE", "UNPROVEN_SECURITY_CLAIM",
    ]);
  });
});
