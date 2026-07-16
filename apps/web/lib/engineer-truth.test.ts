import { describe, expect, test } from "bun:test";
import type { EngineerReviewBinding, RunEvent } from "./engineer";
import { deriveDiffProvenance, deriveSecurityStatus, engineerTextSha256 } from "./engineer-truth";

const diff = "diff --git a/src/a.ts b/src/a.ts\n+safe\n";
const bundle = { evidenceBundleId: "bundle-1", bundleHash: `sha256:${"b".repeat(64)}` };
const binding = (diffHash: string): EngineerReviewBinding => ({
  reviewerSessionId: "review-1", reviewerDecision: "APPROVE", reviewerDiffHash: diffHash,
  reviewerEvidenceBundleHash: `sha256:${"c".repeat(64)}`, reviewerIsolationVerified: true,
  evidenceBundleId: bundle.evidenceBundleId, evidenceBundleHash: bundle.bundleHash,
});
const event = (nextState: string, sequence: number): RunEvent => ({
  eventId: `event-${sequence}`, sequence, previousState: "TEST", nextState,
  reasonCode: "TEST", timestamp: new Date(sequence * 1_000).toISOString(), evidenceIds: [],
});

describe("Engineer truthful result projections", () => {
  test("never calls live or mismatched work reviewed", async () => {
    const hash = await engineerTextSha256(diff);
    const base = { displayedDiffHash: hash, reviewBinding: binding(hash), evidenceBundles: [bundle], approval: null, gitOperations: [] };
    expect(deriveDiffProvenance({ ...base, state: "IMPLEMENTING" })).toBe("LIVE_UNVERIFIED");
    expect(deriveDiffProvenance({ ...base, state: "SECURITY_REVIEW" })).toBe("VERIFICATION_CANDIDATE");
    expect(deriveDiffProvenance({ ...base, state: "REVIEW_APPROVED", displayedDiffHash: `sha256:${"0".repeat(64)}` })).toBe("VERIFICATION_CANDIDATE");
    expect(deriveDiffProvenance({ ...base, state: "REVIEW_APPROVED", evidenceBundles: [] })).toBe("VERIFICATION_CANDIDATE");
    expect(deriveDiffProvenance({ ...base, state: "REVIEW_APPROVED" })).toBe("REVIEWED_HASH_BOUND");
  });

  test("requires successful matching publication evidence for PUBLISHED", async () => {
    const hash = await engineerTextSha256(diff);
    const base = { state: "COMPLETED", displayedDiffHash: hash, reviewBinding: binding(hash), evidenceBundles: [bundle], approval: null };
    expect(deriveDiffProvenance({ ...base, gitOperations: [] })).toBe("REVIEWED_HASH_BOUND");
    expect(deriveDiffProvenance({ ...base, gitOperations: [{ operationType: "CREATE_PR", status: "SUCCEEDED", evidenceBundleHash: bundle.bundleHash, remoteReference: "https://github.test/pr/1" }] })).toBe("PUBLISHED");
  });

  test("shows Pending or Unavailable until durable security completion proves an empty result", () => {
    expect(deriveSecurityStatus({ events: [event("SECURITY_REVIEW", 1)], findingCount: 0, errors: [] })).toEqual({ status: "PENDING", label: "Pending" });
    expect(deriveSecurityStatus({ events: [event("SECURITY_REVIEW", 1), event("CODE_REVIEW", 2)], findingCount: 0, errors: [] })).toEqual({ status: "NO_FINDINGS", label: "No findings" });
    expect(deriveSecurityStatus({ events: [event("SECURITY_REVIEW", 1), event("CODE_REVIEW", 2)], findingCount: 0, errors: [{ section: "security" }] })).toEqual({ status: "UNAVAILABLE", label: "Unavailable" });
    expect(deriveSecurityStatus({ events: [event("SECURITY_REVIEW", 1)], findingCount: 2, errors: [] })).toEqual({ status: "FINDINGS", label: "2 findings" });
  });
});
