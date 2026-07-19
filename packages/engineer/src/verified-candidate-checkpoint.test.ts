import { describe, expect, test } from "bun:test";
import {
  SignedVerifiedCandidateAttestationSchema,
  VerifiedCandidateCheckpointSchema,
  VerifiedCandidateSummarySchema,
  createVerifiedCandidateCheckpoint,
  verifiedCandidateSummary,
  verifySignedVerifiedCandidateAttestation,
  sha256,
  type CheckpointAttestor,
  type VerifiedCandidateCheckpointInput,
} from "./index.js";

const hash = (value: string) => sha256(value);
const attestor: CheckpointAttestor = {
  algorithm: "test-sha256",
  keyId: "test-key-1",
  sign: (payload) => `test:${sha256(payload)}`,
  verify: (payload, signature) => signature === `test:${sha256(payload)}`,
};
const codeUnitCompare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

function input(): VerifiedCandidateCheckpointInput {
  const builderClaims = [
    { inputHash: hash("builder-z"), agentExecutionId: "agent-z", modelTier: "GPT-5.6_TERRA" as const, workerOwnerId: null, workerFencingToken: null, status: "SUCCEEDED" as const, outputArtifactId: "output-z", startedAt: "2026-07-17T11:00:00.000Z", completedAt: "2026-07-17T11:30:00.000Z", outputArtifactAuthority: { artifactId: "output-z", sha256: hash("output-z"), sizeBytes: 12, createdAt: "2026-07-17T11:30:00.000Z", type: "BUILDER_RESULT" as const, producerType: "SYSTEM" as const, producerId: "codex-builder-adapter", trusted: false as const, regularFile: true as const, symbolicLink: false as const } },
    { inputHash: hash("builder-a"), agentExecutionId: "agent-a", modelTier: "GPT-5.6_TERRA" as const, workerOwnerId: "worker-a", workerFencingToken: 2, status: "PAUSED" as const, outputArtifactId: null, startedAt: "2026-07-17T10:00:00.000Z", completedAt: "2026-07-17T10:30:00.000Z", outputArtifactAuthority: null },
  ];
  const sortedBuilderClaims = [...builderClaims].sort((left, right) =>
    codeUnitCompare(`${left.inputHash}\u0000${left.agentExecutionId}`, `${right.inputHash}\u0000${right.agentExecutionId}`));
  return {
    schemaVersion: 1,
    policyVersion: "verified-candidate-checkpoint-v1",
    parentCheckpointId: null,
    runId: "run-1",
    requesterUserId: "user-1",
    repositoryId: "repo-1",
    requiredLaneContractHash: hash("contract"),
    manifestHash: hash("manifest"),
    baseCommitSha: "a".repeat(40),
    resultCommitSha: "b".repeat(40),
    diffHash: hash("diff"),
    reviewerSessionId: "reviewer-1",
    classificationHash: hash("classification"),
    classificationResult: "READY_WITH_ADVISORIES",
    evidenceBundleId: "bundle-1",
    evidenceBundleHash: hash("bundle"),
    claimSummary: { claimIds: ["claim-z", "claim-a"], claimSetHash: hash("ignored") },
    verificationSummary: {
      verificationPass: 2, testExecutionIds: ["test-β", "test-A", "test-a"],
      testExecutionSetHash: hash("ignored"), provenanceEventIds: ["audit-z", "audit-a"],
      provenanceHash: hash("provenance"), allRequiredChecksPassed: true,
    },
    securitySummary: {
      findingIds: ["finding-z", "finding-A"], findingSetHash: hash("ignored"), openBlockingCriticalCount: 0,
    },
    scopeSummary: { artifactId: "scope-artifact", artifactHash: hash("scope"), policyVersion: "final-change-scope-v1" },
    environmentDigest: hash("environment"),
    builderDispatchSummary: {
      claims: builderClaims,
      claimSetHash: sha256(sortedBuilderClaims),
    },
    prePromotionEventChainSummary: {
      eventCount: 7, headEventId: "reviewing-event", headSequence: 7, headStateVersion: 7,
      chainHash: hash("event-chain"),
    },
    createdAt: "2026-07-17T12:00:00.000Z",
  };
}

describe("verified candidate checkpoint contract", () => {
  test("projects only the strict owner-safe verified candidate allowlist", async () => {
    const { checkpoint } = await createVerifiedCandidateCheckpoint(input(), attestor);
    const summary = verifiedCandidateSummary(checkpoint);
    expect(summary).toEqual({
      checkpointId: checkpoint.checkpointId,
      checkpointHash: checkpoint.checkpointHash,
      resultCommitSha: checkpoint.resultCommitSha,
      classificationResult: checkpoint.classificationResult,
      requiredTestCount: 3,
      allRequiredChecksPassed: true,
      openBlockingCriticalCount: 0,
      environmentDigest: checkpoint.environmentDigest,
      createdAt: checkpoint.createdAt,
    });
    expect(Object.keys(summary).sort()).toEqual([
      "allRequiredChecksPassed", "checkpointHash", "checkpointId", "classificationResult", "createdAt",
      "environmentDigest", "openBlockingCriticalCount", "requiredTestCount", "resultCommitSha",
    ].sort());
    const encoded = JSON.stringify(summary);
    for (const secret of ["user-1", "repo-1", "reviewer-1", "bundle-1", "agent-z", "scope-artifact"]) {
      expect(encoded).not.toContain(secret);
    }
    expect(() => VerifiedCandidateSummarySchema.parse({ ...summary, manifestHash: checkpoint.manifestHash })).toThrow();
  });

  test("normalizes every set with locale-independent ordering and signs exact canonical statement bytes", async () => {
    const first = await createVerifiedCandidateCheckpoint(input(), attestor);
    const reversed = input();
    reversed.claimSummary.claimIds.reverse();
    reversed.verificationSummary.testExecutionIds.reverse();
    reversed.securitySummary.findingIds.reverse();
    reversed.builderDispatchSummary.claims.reverse();
    const second = await createVerifiedCandidateCheckpoint(reversed, attestor);
    expect(second).toEqual(first);
    expect(first.checkpoint.claimSummary.claimIds).toEqual(["claim-a", "claim-z"]);
    expect(first.checkpoint.verificationSummary.testExecutionIds).toEqual(["test-A", "test-a", "test-β"]);
    expect(first.checkpoint.securitySummary.findingIds).toEqual(["finding-A", "finding-z"]);
    expect(first.checkpoint.builderDispatchSummary.claimSetHash)
      .toBe(sha256(first.checkpoint.builderDispatchSummary.claims));
    expect(first.checkpoint.parentCheckpointId).toBeNull();
    expect(first.attestation.statement.subject).toEqual([{
      name: `zintus-engineer-candidate/repo-1/${"b".repeat(40)}`,
      digest: { sha256: first.checkpoint.checkpointHash.slice("sha256:".length) },
    }]);
    expect(first.attestation.statement.predicate).toEqual(first.checkpoint);
    expect(first.attestation.statementHash).toBe(sha256(Buffer.from(first.attestation.statementJson, "utf8")));
  });

  test("binds every content field into the hash and deterministic identity", async () => {
    const original = await createVerifiedCandidateCheckpoint(input(), attestor);
    const changed = input();
    changed.scopeSummary.artifactHash = hash("different-scope");
    const altered = await createVerifiedCandidateCheckpoint(changed, attestor);
    expect(altered.checkpoint.checkpointHash).not.toBe(original.checkpoint.checkpointHash);
    expect(altered.checkpoint.checkpointId).not.toBe(original.checkpoint.checkpointId);
    const changedSummary = input();
    changedSummary.claimSummary.claimSetHash = hash("different-durable-claim-content");
    const summaryAltered = await createVerifiedCandidateCheckpoint(changedSummary, attestor);
    expect(summaryAltered.checkpoint.claimSummary.claimSetHash).toBe(changedSummary.claimSummary.claimSetHash);
    expect(summaryAltered.checkpoint.checkpointHash).not.toBe(original.checkpoint.checkpointHash);
    for (const mutate of [
      (value: VerifiedCandidateCheckpointInput) => { value.prePromotionEventChainSummary.chainHash = hash("changed-chain"); },
      (value: VerifiedCandidateCheckpointInput) => { value.builderDispatchSummary.claims[0]!.startedAt = "2026-07-17T10:59:59.000Z"; value.builderDispatchSummary.claimSetHash = sha256([...value.builderDispatchSummary.claims].sort((left, right) => codeUnitCompare(`${left.inputHash}\u0000${left.agentExecutionId}`, `${right.inputHash}\u0000${right.agentExecutionId}`))); },
      (value: VerifiedCandidateCheckpointInput) => { value.builderDispatchSummary.claims[0]!.completedAt = "2026-07-17T11:16:00.000Z"; value.builderDispatchSummary.claims[0]!.outputArtifactAuthority!.createdAt = "2026-07-17T11:16:00.000Z"; value.builderDispatchSummary.claimSetHash = sha256([...value.builderDispatchSummary.claims].sort((left, right) => codeUnitCompare(`${left.inputHash}\u0000${left.agentExecutionId}`, `${right.inputHash}\u0000${right.agentExecutionId}`))); },
      (value: VerifiedCandidateCheckpointInput) => { value.verificationSummary.provenanceHash = hash("changed-provenance"); },
    ]) {
      const value = input();
      mutate(value);
      const result = await createVerifiedCandidateCheckpoint(value, attestor);
      expect(result.checkpoint.checkpointHash).not.toBe(original.checkpoint.checkpointHash);
    }
    const tampered = { ...original.checkpoint, diffHash: hash("tampered") };
    expect(() => VerifiedCandidateCheckpointSchema.parse(tampered)).toThrow("checkpointHash");
  });

  test("rejects unsorted, duplicated, and malformed status shapes", async () => {
    const { checkpoint } = await createVerifiedCandidateCheckpoint(input(), attestor);
    expect(() => VerifiedCandidateCheckpointSchema.parse({
      ...checkpoint,
      claimSummary: { ...checkpoint.claimSummary, claimIds: [...checkpoint.claimSummary.claimIds].reverse() },
    })).toThrow();
    expect(() => VerifiedCandidateCheckpointSchema.parse({
      ...checkpoint,
      securitySummary: { ...checkpoint.securitySummary, findingIds: ["same", "same"], findingSetHash: sha256(["same", "same"]) },
    })).toThrow("sorted and unique");
    const invalid = input();
    invalid.builderDispatchSummary.claims[0] = { ...invalid.builderDispatchSummary.claims[0]!, status: "PAUSED", outputArtifactId: "forbidden", outputArtifactAuthority: null };
    await expect(createVerifiedCandidateCheckpoint(invalid, attestor)).rejects.toThrow("non-successful Builder claims");
    const running = input() as unknown as Record<string, unknown>;
    const dispatch = running.builderDispatchSummary as { claims: Array<Record<string, unknown>> };
    dispatch.claims[0] = { ...dispatch.claims[0], status: "RUNNING", outputArtifactId: null };
    await expect(createVerifiedCandidateCheckpoint(running as never, attestor)).rejects.toThrow();
    const wrongBuilderHash = input();
    wrongBuilderHash.builderDispatchSummary.claimSetHash = hash("wrong-builder-claim-set");
    await expect(createVerifiedCandidateCheckpoint(wrongBuilderHash, attestor))
      .rejects.toThrow("Builder claimSetHash does not match");
    const missingOutputAuthority = input();
    missingOutputAuthority.builderDispatchSummary.claims[0] = {
      ...missingOutputAuthority.builderDispatchSummary.claims[0]!, outputArtifactAuthority: null,
    };
    await expect(createVerifiedCandidateCheckpoint(missingOutputAuthority, attestor))
      .rejects.toThrow("matching output authority");
    const mismatchedChainHead = input();
    mismatchedChainHead.prePromotionEventChainSummary.headSequence += 1;
    await expect(createVerifiedCandidateCheckpoint(mismatchedChainHead, attestor))
      .rejects.toThrow("head/count mismatch");
    const invalidArtifactTime = input();
    invalidArtifactTime.builderDispatchSummary.claims[0]!.outputArtifactAuthority!.createdAt = "not-a-time";
    await expect(createVerifiedCandidateCheckpoint(invalidArtifactTime, attestor)).rejects.toThrow();
    const artifactAfterCompletion = input();
    artifactAfterCompletion.builderDispatchSummary.claims[0]!.outputArtifactAuthority!.createdAt = "2026-07-17T11:31:00.000Z";
    await expect(createVerifiedCandidateCheckpoint(artifactAfterCompletion, attestor))
      .rejects.toThrow("must equal terminal completion");
    expect(() => VerifiedCandidateCheckpointSchema.parse({
      ...checkpoint,
      builderDispatchSummary: { ...checkpoint.builderDispatchSummary, claimSetHash: hash("wrong-builder-claim-set") },
    })).toThrow("Builder claimSetHash does not match");
  });

  test("fails closed when signing or signature verification fails", async () => {
    await expect(createVerifiedCandidateCheckpoint(input(), { ...attestor, sign: () => "" }))
      .rejects.toThrow("signature verification failed");
    await expect(createVerifiedCandidateCheckpoint(input(), { ...attestor, verify: () => false }))
      .rejects.toThrow("signature verification failed");
    for (const invalidResult of [1, "true"] as const) {
      await expect(createVerifiedCandidateCheckpoint(input(), {
        ...attestor, verify: () => invalidResult as unknown as boolean,
      })).rejects.toThrow("signature verification failed");
    }
    await expect(createVerifiedCandidateCheckpoint(input(), { ...attestor, verify: () => { throw new Error("verifier crashed"); } }))
      .rejects.toThrow("verifier crashed");
    await expect(createVerifiedCandidateCheckpoint(input(), { ...attestor, verify: async () => { throw new Error("verifier rejected"); } }))
      .rejects.toThrow("verifier rejected");
  });

  test("rejects statement byte, hash, subject, and signature-shape tampering", async () => {
    const { attestation } = await createVerifiedCandidateCheckpoint(input(), attestor);
    expect(() => SignedVerifiedCandidateAttestationSchema.parse({ ...attestation, statementJson: `${attestation.statementJson} ` })).toThrow("canonical");
    expect(() => SignedVerifiedCandidateAttestationSchema.parse({ ...attestation, statementHash: hash("wrong") })).toThrow("statementHash");
    expect(() => SignedVerifiedCandidateAttestationSchema.parse({
      ...attestation,
      statement: { ...attestation.statement, subject: [{ ...attestation.statement.subject[0], repositoryId: "other" }] },
    })).toThrow("subject");
    expect(() => SignedVerifiedCandidateAttestationSchema.parse({ ...attestation, signature: "" })).toThrow();
    await expect(verifySignedVerifiedCandidateAttestation({ ...attestation, signature: "test:forged" }, attestor))
      .rejects.toThrow("signature verification failed");
    await expect(verifySignedVerifiedCandidateAttestation(attestation, { ...attestor, keyId: "different-key" }))
      .rejects.toThrow("signer identity mismatch");
  });
});
