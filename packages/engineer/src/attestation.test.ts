import { describe, expect, test } from "bun:test";
import { canonicalJson, sha256 } from "./hash.js";
import {
  DSSE_PAYLOAD_TYPE,
  buildProvenanceStatement,
  createHmacProvenanceSigner,
  createManagedKmsProvenanceSignerStub,
  createProvenanceAttestation,
  preAuthEncoding,
  verifyProvenanceAttestation,
  type DsseEnvelope,
  type ProvenanceAttestationInput,
} from "./attestation.js";
import {
  createVerifiedCandidateCheckpoint,
  createVerifiedHardeningCandidateCheckpoint,
  type CheckpointAttestor,
  type VerifiedCandidateCheckpointInput,
  type VerifiedHardeningCandidateCheckpointInput,
} from "./index.js";

const hash = (value: string): string => sha256(value);
const checkpointAttestor: CheckpointAttestor = {
  algorithm: "test-sha256", keyId: "checkpoint-test-key",
  sign: (payload) => `test:${sha256(payload)}`,
  verify: (payload, signature) => signature === `test:${sha256(payload)}`,
};

const SECRET = "attestation-hmac-secret-32bytes!!";
const KEY_ID = "engineer-provenance-key-1";

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
    runId: "parent-run", requesterUserId: "requester-user", repositoryId: "repo",
    requiredLaneContractHash: hash("contract"), manifestHash: hash("manifest"),
    baseCommitSha: "a".repeat(40), resultCommitSha: "b".repeat(40), diffHash: hash("diff"),
    reviewerSessionId: "reviewer", classificationHash: hash("classification"), classificationResult: "READY",
    evidenceBundleId: "bundle", evidenceBundleHash: hash("bundle"),
    claimSummary: { claimIds: ["claim"], claimSetHash: hash("claim-set") },
    verificationSummary: { verificationPass: 1, testExecutionIds: ["test-a", "test-b"], testExecutionSetHash: hash("tests"),
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
  const legacy = (await createVerifiedCandidateCheckpoint(legacyInput(), checkpointAttestor)).checkpoint;
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

const REPLACEMENT_LINEAGE = {
  caseId: hash("case"), caseHash: hash("case-hash"), directiveId: hash("directive"),
  directiveHash: hash("directive-hash"), replacementId: "replacement-1", replacementHash: hash("replacement-hash"),
};

const PUBLICATION_RECEIPT = {
  publicationId: "pub-1", publicationRevision: 1, prUrl: "https://github.com/acme/repo/pull/7",
  commitSha: "b".repeat(40), idempotencyKey: "idem-1", observedAt: "2026-07-18T11:00:00.000Z",
};

async function legacyAttestationInput(): Promise<ProvenanceAttestationInput> {
  const checkpoint = (await createVerifiedCandidateCheckpoint(legacyInput(), checkpointAttestor)).checkpoint;
  return {
    checkpoint,
    resultTreeHash: hash("tree"),
    isReplacement: false,
    roles: [
      { role: "REVIEWER", agentExecutionId: "reviewer-1", modelTier: "GPT-5.6_TERRA" },
      { role: "BUILDER", agentExecutionId: "builder-1", modelTier: "GPT-5.6_TERRA" },
    ],
    budget: { costMicrousd: 12_345, tokensConsumed: 6_789, activeSeconds: 42.5 },
    approverUserId: "approver-user",
    replacementLineage: null,
    publicationReceipt: PUBLICATION_RECEIPT,
    createdAt: "2026-07-18T10:05:00.000Z",
  };
}

async function replacementAttestationInput(): Promise<ProvenanceAttestationInput> {
  const checkpoint = (await createVerifiedHardeningCandidateCheckpoint(await hardeningInput(), checkpointAttestor)).checkpoint;
  return {
    checkpoint,
    resultTreeHash: hash("tree-2"),
    isReplacement: true,
    roles: [{ role: "BUILDER", agentExecutionId: "builder-1", modelTier: "GPT-5.6_TERRA" }],
    budget: { costMicrousd: 1, tokensConsumed: 2, activeSeconds: 0 },
    approverUserId: "approver-user",
    replacementLineage: REPLACEMENT_LINEAGE,
    publicationReceipt: null,
    createdAt: "2026-07-18T10:06:00.000Z",
  };
}

/** Hand-build a DSSE envelope over an arbitrary (possibly tampered) statement object. */
async function envelopeFromStatement(
  statementObject: unknown,
  signer: ReturnType<typeof createHmacProvenanceSigner>,
): Promise<DsseEnvelope> {
  const json = canonicalJson(statementObject);
  const payloadBytes = new TextEncoder().encode(json);
  const sig = await signer.sign(preAuthEncoding(DSSE_PAYLOAD_TYPE, payloadBytes));
  return {
    payloadType: DSSE_PAYLOAD_TYPE,
    payload: Buffer.from(payloadBytes).toString("base64"),
    signatures: [{ keyid: signer.keyId, sig }],
  };
}

describe("P11 provenance attestation - construction", () => {
  test("builds an in-toto v1 statement whose subject is the verified-candidate digest", async () => {
    const input = await legacyAttestationInput();
    const built = buildProvenanceStatement(input);
    expect(built.statement._type).toBe("https://in-toto.io/Statement/v1");
    expect(built.statement.predicateType).toBe("https://zintus.dev/attestations/engineer-provenance/v1");
    expect(built.statement.subject[0].digest.sha256).toBe(input.checkpoint.checkpointHash.slice("sha256:".length));
    expect(built.statement.subject[0].name).toBe(`zintus-engineer-candidate/repo/${input.checkpoint.resultCommitSha}`);
    // predicate carries the enumerated provenance fields
    const predicate = built.statement.predicate;
    expect(predicate.frozenContractHash).toBe(input.checkpoint.requiredLaneContractHash);
    expect(predicate.repository.baseCommitSha).toBe(input.checkpoint.baseCommitSha);
    expect(predicate.result.diffHash).toBe(input.checkpoint.diffHash);
    expect(predicate.identities.approverUserId).toBe("approver-user");
    expect(predicate.identities.requesterUserId).toBe("requester-user");
    expect(predicate.publicationReceipt).not.toBeNull();
    expect(predicate.isReplacement).toBe(false);
    expect(predicate.replacementLineage).toBeNull();
  });

  test("serialization is deterministic and roles are canonically sorted", async () => {
    const input = await legacyAttestationInput();
    const first = buildProvenanceStatement(input);
    const second = buildProvenanceStatement(input);
    expect(first.statementJson).toBe(second.statementJson);
    expect(first.statementJson).toBe(canonicalJson(first.statement));
    // roles input was [REVIEWER, BUILDER]; canonical order is [BUILDER, REVIEWER]
    expect(first.statement.predicate.roles.map((entry) => entry.role)).toEqual(["BUILDER", "REVIEWER"]);
  });

  test("replacement candidate embeds its P7 lineage chain", async () => {
    const input = await replacementAttestationInput();
    const built = buildProvenanceStatement(input);
    expect(built.statement.predicate.isReplacement).toBe(true);
    expect(built.statement.predicate.replacementLineage).toEqual(REPLACEMENT_LINEAGE);
  });

  test("builder rejects a replacement candidate with no lineage", async () => {
    const input = { ...(await replacementAttestationInput()), replacementLineage: null };
    expect(() => buildProvenanceStatement(input)).toThrow(/replacement lineage/);
  });

  test("builder rejects approver equal to requester", async () => {
    const input = { ...(await legacyAttestationInput()), approverUserId: "requester-user" };
    expect(() => buildProvenanceStatement(input)).toThrow(/approver must differ/);
  });
});

describe("P11 provenance attestation - DSSE signing", () => {
  test("HMAC signer secret is not a readable property of the signer object", () => {
    const signer = createHmacProvenanceSigner({ secret: SECRET, keyId: KEY_ID });
    // Only the identity + operation surface is enumerable; no secret material.
    expect(Object.keys(signer).sort()).toEqual(["algorithm", "keyId", "sign", "verify"]);
    expect(JSON.stringify(signer)).not.toContain(SECRET);
    expect((signer as unknown as Record<string, unknown>).secret).toBeUndefined();
    expect((signer as unknown as Record<string, unknown>).key).toBeUndefined();
  });

  test("HMAC signer rejects a short secret", () => {
    expect(() => createHmacProvenanceSigner({ secret: "short", keyId: KEY_ID })).toThrow(/at least 16 bytes/);
  });

  test("managed-KMS/Sigstore signer is a stub that refuses to sign", () => {
    const stub = createManagedKmsProvenanceSignerStub({ keyId: "kms-key" });
    expect(() => stub.sign(new Uint8Array([1, 2, 3]))).toThrow(/\[HUMAN\]-gated/);
    expect(() => stub.verify(new Uint8Array([1, 2, 3]), "AA==")).toThrow(/\[HUMAN\]-gated/);
  });

  test("PAE follows the DSSE spec byte layout", () => {
    const pae = preAuthEncoding("application/x", new Uint8Array([65, 66]));
    expect(Buffer.from(pae).toString("utf8")).toBe("DSSEv1 13 application/x 2 AB");
  });

  test("a freshly created attestation verifies", async () => {
    const signer = createHmacProvenanceSigner({ secret: SECRET, keyId: KEY_ID });
    const { envelope } = await createProvenanceAttestation(await legacyAttestationInput(), signer);
    const result = await verifyProvenanceAttestation(envelope, signer);
    expect(result.ok).toBe(true);
  });
});

describe("P11 provenance attestation - offline verifier rejections", () => {
  const signer = createHmacProvenanceSigner({ secret: SECRET, keyId: KEY_ID });

  test("accepts a valid replacement attestation", async () => {
    const { envelope } = await createProvenanceAttestation(await replacementAttestationInput(), signer);
    const result = await verifyProvenanceAttestation(envelope, signer);
    expect(result.ok).toBe(true);
  });

  test("REJECT: tampered predicate bytes (re-encoded payload, not re-signed) -> signature fails", async () => {
    const { envelope } = await createProvenanceAttestation(await legacyAttestationInput(), signer);
    const decoded = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8"));
    decoded.predicate.budget.costMicrousd = 999_999; // still a valid, canonical statement
    const tampered: DsseEnvelope = {
      ...envelope,
      payload: Buffer.from(canonicalJson(decoded), "utf8").toString("base64"),
    };
    const result = await verifyProvenanceAttestation(tampered, signer);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("SIGNATURE_INVALID");
  });

  test("REJECT: one flipped signature byte", async () => {
    const { envelope } = await createProvenanceAttestation(await legacyAttestationInput(), signer);
    const sigBytes = Buffer.from(envelope.signatures[0]!.sig, "base64");
    sigBytes[0] = sigBytes[0]! ^ 0xff;
    const tampered: DsseEnvelope = {
      ...envelope,
      signatures: [{ keyid: envelope.signatures[0]!.keyid, sig: sigBytes.toString("base64") }],
    };
    const result = await verifyProvenanceAttestation(tampered, signer);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("SIGNATURE_INVALID");
  });

  test("REJECT: wrong subject digest", async () => {
    const built = buildProvenanceStatement(await legacyAttestationInput());
    const mutated = structuredClone(built.statement) as Record<string, unknown>;
    (mutated.subject as Array<{ digest: { sha256: string } }>)[0]!.digest.sha256 = "f".repeat(64);
    const envelope = await envelopeFromStatement(mutated, signer);
    const result = await verifyProvenanceAttestation(envelope, signer);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("SUBJECT_DIGEST_MISMATCH");
  });

  test("REJECT: replacement-flagged candidate with lineage stripped", async () => {
    const built = buildProvenanceStatement(await replacementAttestationInput());
    const mutated = structuredClone(built.statement) as { predicate: { replacementLineage: unknown } };
    mutated.predicate.replacementLineage = null;
    const envelope = await envelopeFromStatement(mutated, signer);
    const result = await verifyProvenanceAttestation(envelope, signer);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("MISSING_REPLACEMENT_LINEAGE");
  });

  test("REJECT: approver equal to requester", async () => {
    const built = buildProvenanceStatement(await legacyAttestationInput());
    const mutated = structuredClone(built.statement) as { predicate: { identities: { requesterUserId: string; approverUserId: string } } };
    mutated.predicate.identities.approverUserId = mutated.predicate.identities.requesterUserId;
    const envelope = await envelopeFromStatement(mutated, signer);
    const result = await verifyProvenanceAttestation(envelope, signer);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("MISSING_APPROVER");
  });

  test("REJECT: signer identity mismatch", async () => {
    const { envelope } = await createProvenanceAttestation(await legacyAttestationInput(), signer);
    const otherVerifier = createHmacProvenanceSigner({ secret: SECRET, keyId: "different-key" });
    const result = await verifyProvenanceAttestation(envelope, otherVerifier);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("SIGNER_IDENTITY_MISMATCH");
  });

  test("REJECT: signature from a different secret", async () => {
    const { envelope } = await createProvenanceAttestation(await legacyAttestationInput(), signer);
    const wrongSecret = createHmacProvenanceSigner({ secret: "another-hmac-secret-32bytes-long!", keyId: KEY_ID });
    const result = await verifyProvenanceAttestation(envelope, wrongSecret);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("SIGNATURE_INVALID");
  });

  test("REJECT: malformed envelope", async () => {
    const result = await verifyProvenanceAttestation({ not: "a dsse envelope" }, signer);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("MALFORMED_ENVELOPE");
  });

  test("REJECT: non-canonical payload bytes", async () => {
    const built = buildProvenanceStatement(await legacyAttestationInput());
    const nonCanonical = ` ${built.statementJson}`; // leading space -> valid JSON, non-canonical bytes
    const payloadBytes = Buffer.from(nonCanonical, "utf8");
    const sig = await signer.sign(preAuthEncoding(DSSE_PAYLOAD_TYPE, payloadBytes));
    const envelope: DsseEnvelope = {
      payloadType: DSSE_PAYLOAD_TYPE,
      payload: payloadBytes.toString("base64"),
      signatures: [{ keyid: signer.keyId, sig }],
    };
    const result = await verifyProvenanceAttestation(envelope, signer);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("NON_CANONICAL_PAYLOAD");
  });
});
