import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson, sha256 } from "./hash.js";
import { createHmacProvenanceSigner, createProvenanceAttestation, type ProvenanceAttestationInput } from "./attestation.js";
import { runAttestationVerifyCli } from "./attestation-verify-cli.js";
import {
  createVerifiedCandidateCheckpoint,
  type CheckpointAttestor,
  type VerifiedCandidateCheckpointInput,
} from "./index.js";

const hash = (value: string): string => sha256(value);
const SECRET = "attestation-hmac-secret-32bytes!!";
const KEY_ID = "engineer-provenance-key-1";
const checkpointAttestor: CheckpointAttestor = {
  algorithm: "test-sha256", keyId: "checkpoint-test-key",
  sign: (payload) => `test:${sha256(payload)}`,
  verify: (payload, signature) => signature === `test:${sha256(payload)}`,
};

function legacyInput(): VerifiedCandidateCheckpointInput {
  const claim = {
    inputHash: hash("builder-input"), agentExecutionId: "builder-1", modelTier: "GPT-5.6_TERRA" as const,
    workerOwnerId: null, workerFencingToken: null, status: "SUCCEEDED" as const,
    outputArtifactId: "builder-output", startedAt: "2026-07-18T10:00:00.000Z", completedAt: "2026-07-18T10:01:00.000Z",
    outputArtifactAuthority: { artifactId: "builder-output", sha256: hash("builder-output"), sizeBytes: 1,
      createdAt: "2026-07-18T10:01:00.000Z", type: "BUILDER_RESULT" as const, producerType: "SYSTEM" as const,
      producerId: "builder", trusted: false as const, regularFile: true as const, symbolicLink: false as const },
  };
  return {
    schemaVersion: 1, policyVersion: "verified-candidate-checkpoint-v1", parentCheckpointId: null,
    runId: "parent-run", requesterUserId: "requester-user", repositoryId: "repo",
    requiredLaneContractHash: hash("contract"), manifestHash: hash("manifest"),
    baseCommitSha: "a".repeat(40), resultCommitSha: "b".repeat(40), diffHash: hash("diff"),
    reviewerSessionId: "reviewer", classificationHash: hash("classification"), classificationResult: "READY",
    evidenceBundleId: "bundle", evidenceBundleHash: hash("bundle"),
    claimSummary: { claimIds: ["claim"], claimSetHash: hash("claim-set") },
    verificationSummary: { verificationPass: 1, testExecutionIds: ["test-a"], testExecutionSetHash: hash("tests"),
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

async function attestationInput(): Promise<ProvenanceAttestationInput> {
  const checkpoint = (await createVerifiedCandidateCheckpoint(legacyInput(), checkpointAttestor)).checkpoint;
  return {
    checkpoint, resultTreeHash: hash("tree"),
    isReplacement: false,
    roles: [{ role: "BUILDER", agentExecutionId: "builder-1", modelTier: "GPT-5.6_TERRA" }],
    budget: { costMicrousd: 1, tokensConsumed: 2, activeSeconds: 3 },
    approverUserId: "approver-user", replacementLineage: null, publicationReceipt: null,
    createdAt: "2026-07-18T10:05:00.000Z",
  };
}

const dirs: string[] = [];
function writeEnvelope(contents: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "p11-cli-"));
  dirs.push(dir);
  const path = join(dir, "envelope.json");
  writeFileSync(path, typeof contents === "string" ? contents : canonicalJson(contents), "utf8");
  return path;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const env = { ENGINEER_ATTESTATION_HMAC_SECRET: SECRET, ENGINEER_ATTESTATION_KEY_ID: KEY_ID };

describe("P11 attestation-verify CLI", () => {
  test("exit 0 and VERIFIED on a valid envelope", async () => {
    const signer = createHmacProvenanceSigner({ secret: SECRET, keyId: KEY_ID });
    const { envelope } = await createProvenanceAttestation(await attestationInput(), signer);
    const outcome = await runAttestationVerifyCli([writeEnvelope(envelope)], env);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toContain("VERIFIED");
  });

  test("exit 1 and REJECTED on a tampered envelope", async () => {
    const signer = createHmacProvenanceSigner({ secret: SECRET, keyId: KEY_ID });
    const { envelope } = await createProvenanceAttestation(await attestationInput(), signer);
    const decoded = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8"));
    decoded.predicate.budget.tokensConsumed = 999;
    const tampered = { ...envelope, payload: Buffer.from(canonicalJson(decoded), "utf8").toString("base64") };
    const outcome = await runAttestationVerifyCli([writeEnvelope(tampered)], env);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.stderr).toContain("REJECTED SIGNATURE_INVALID");
  });

  test("exit 2 when the secret env is absent (key never comes from argv)", async () => {
    const outcome = await runAttestationVerifyCli([writeEnvelope("{}")], {});
    expect(outcome.exitCode).toBe(2);
    expect(outcome.stderr).toContain("ENGINEER_ATTESTATION_HMAC_SECRET");
  });

  test("exit 2 with usage when no path is given", async () => {
    const outcome = await runAttestationVerifyCli([], env);
    expect(outcome.exitCode).toBe(2);
    expect(outcome.stderr).toContain("usage:");
  });
});
