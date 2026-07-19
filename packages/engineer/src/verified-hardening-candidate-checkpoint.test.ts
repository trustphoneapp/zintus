import { describe, expect, test } from "bun:test";
import {
  SignedVerifiedHardeningCandidateAttestationSchema,
  VerifiedCandidateCheckpointSchema,
  VerifiedCandidateCheckpointVersionedSchema,
  VerifiedHardeningCandidateCheckpointSchema,
  createVerifiedCandidateCheckpoint,
  createVerifiedHardeningCandidateCheckpoint,
  sha256,
  verifySignedVerifiedHardeningCandidateAttestation,
  type CheckpointAttestor,
  type VerifiedCandidateCheckpointInput,
  type VerifiedHardeningCandidateCheckpointInput,
} from "./index.js";
import { canonicalJson } from "./hash.js";

const hash = (value: string): string => sha256(value);
const attestor: CheckpointAttestor = {
  algorithm: "test-sha256", keyId: "checkpoint-test-key",
  sign: (payload) => `test:${sha256(payload)}`,
  verify: (payload, signature) => signature === `test:${sha256(payload)}`,
};

function legacyInput(): VerifiedCandidateCheckpointInput {
  const claim = {
    inputHash: hash("builder-input"), agentExecutionId: "builder-1", modelTier: "GPT-5.6_TERRA" as const,
    workerOwnerId: null, workerFencingToken: null, status: "SUCCEEDED" as const,
    outputArtifactId: "builder-output", startedAt: "2026-07-18T10:00:00.000Z",
    completedAt: "2026-07-18T10:01:00.000Z",
    outputArtifactAuthority: {
      artifactId: "builder-output", sha256: hash("builder-output"), sizeBytes: 1,
      createdAt: "2026-07-18T10:01:00.000Z", type: "BUILDER_RESULT" as const,
      producerType: "SYSTEM" as const, producerId: "builder", trusted: false as const,
      regularFile: true as const, symbolicLink: false as const,
    },
  };
  return {
    schemaVersion: 1, policyVersion: "verified-candidate-checkpoint-v1", parentCheckpointId: null,
    runId: "parent-run", requesterUserId: "user", repositoryId: "repo",
    requiredLaneContractHash: hash("contract"), manifestHash: hash("manifest"),
    baseCommitSha: "a".repeat(40), resultCommitSha: "b".repeat(40), diffHash: hash("diff"),
    reviewerSessionId: "reviewer", classificationHash: hash("classification"), classificationResult: "READY",
    evidenceBundleId: "bundle", evidenceBundleHash: hash("bundle"),
    claimSummary: { claimIds: ["claim"], claimSetHash: hash("claim-set") },
    verificationSummary: { verificationPass: 1, testExecutionIds: ["test"], testExecutionSetHash: hash("tests"),
      provenanceEventIds: ["event"], provenanceHash: hash("events"), allRequiredChecksPassed: true },
    securitySummary: { findingIds: [], findingSetHash: hash("findings"), openBlockingCriticalCount: 0 },
    scopeSummary: { artifactId: "scope", artifactHash: hash("scope"), policyVersion: "final-change-scope-v1" },
    environmentDigest: hash("environment"),
    builderDispatchSummary: { claims: [claim], claimSetHash: sha256([claim]) },
    prePromotionEventChainSummary: { eventCount: 1, headEventId: "reviewing", headSequence: 1,
      headStateVersion: 1, chainHash: hash("chain") },
    createdAt: "2026-07-18T10:02:00.000Z",
  };
}

async function hardeningInput(): Promise<VerifiedHardeningCandidateCheckpointInput> {
  const legacy = (await createVerifiedCandidateCheckpoint(legacyInput(), attestor)).checkpoint;
  const { checkpointId: _id, checkpointHash: _hash, schemaVersion: _schema, policyVersion: _policy,
    parentCheckpointId: _parent, ...evidence } = legacy;
  return {
    ...evidence, schemaVersion: 2, policyVersion: "verified-hardening-candidate-checkpoint-v2",
    runId: "hardening-run", resultCommitSha: "c".repeat(40),
    parentCheckpointId: legacy.checkpointId, parentCheckpointHash: legacy.checkpointHash,
    hardeningLineageId: hash("lineage-id"), hardeningLineageHash: hash("lineage-hash"),
    seedAttestationId: hash("seed-id"), seedAttestationHash: hash("seed-hash"),
  };
}

describe("verified hardening candidate checkpoint v2 contract", () => {
  test("keeps the v1 arm byte-exact while v2 is a separate strict authority", async () => {
    const before = await createVerifiedCandidateCheckpoint(legacyInput(), attestor);
    const v2 = await createVerifiedHardeningCandidateCheckpoint(await hardeningInput(), attestor);
    const after = await createVerifiedCandidateCheckpoint(legacyInput(), attestor);
    expect(after).toEqual(before);
    expect(VerifiedCandidateCheckpointSchema.parse(before.checkpoint)).toEqual(before.checkpoint);
    expect(VerifiedCandidateCheckpointVersionedSchema.parse(before.checkpoint)).toEqual(before.checkpoint);
    expect(VerifiedCandidateCheckpointVersionedSchema.parse(v2.checkpoint)).toEqual(v2.checkpoint);
    expect(v2.checkpoint.schemaVersion).toBe(2);
    expect(v2.checkpoint.policyVersion).toBe("verified-hardening-candidate-checkpoint-v2");
    expect(v2.attestation.statement.predicateType)
      .toBe("https://zintus.dev/attestations/verified-hardening-candidate/v2");
    expect(v2.attestation.statementJson).toBe(canonicalJson(v2.attestation.statement));
  });

  test("requires all six lineage authority fields and rejects cross-arm leakage", async () => {
    const legacy = await createVerifiedCandidateCheckpoint(legacyInput(), attestor);
    expect(() => VerifiedCandidateCheckpointVersionedSchema.parse({
      ...legacy.checkpoint, parentCheckpointHash: hash("leak"),
    })).toThrow();
    const input = await hardeningInput();
    for (const key of ["parentCheckpointId", "parentCheckpointHash", "hardeningLineageId", "hardeningLineageHash",
      "seedAttestationId", "seedAttestationHash"] as const) {
      const missing = { ...input } as Record<string, unknown>;
      delete missing[key];
      await expect(createVerifiedHardeningCandidateCheckpoint(missing as never, attestor)).rejects.toThrow();
    }
    await expect(createVerifiedHardeningCandidateCheckpoint({ ...input, schemaVersion: 1 } as never, attestor)).rejects.toThrow();
    await expect(createVerifiedHardeningCandidateCheckpoint({ ...input, parentCheckpointId: null } as never, attestor)).rejects.toThrow();
  });

  test("binds every authority pair into the checkpoint and exact signed bytes", async () => {
    const created = await createVerifiedHardeningCandidateCheckpoint(await hardeningInput(), attestor);
    for (const key of ["parentCheckpointId", "parentCheckpointHash", "hardeningLineageId", "hardeningLineageHash",
      "seedAttestationId", "seedAttestationHash"] as const) {
      expect(() => VerifiedHardeningCandidateCheckpointSchema.parse({
        ...created.checkpoint, [key]: hash(`tampered-${key}`),
      })).toThrow("checkpointHash");
    }
    expect(() => SignedVerifiedHardeningCandidateAttestationSchema.parse({
      ...created.attestation, statementJson: `${created.attestation.statementJson} `,
    })).toThrow("canonical");
    await expect(verifySignedVerifiedHardeningCandidateAttestation({
      ...created.attestation, signature: "test:forged",
    }, attestor)).rejects.toThrow("signature verification failed");
  });
});
