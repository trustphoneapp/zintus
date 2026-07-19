import { z } from "zod";
import { canonicalJson, sha256 } from "./hash.js";

export const VERIFIED_CANDIDATE_CHECKPOINT_POLICY_VERSION = "verified-candidate-checkpoint-v1" as const;
export const VERIFIED_CANDIDATE_PREDICATE_TYPE = "https://zintus.dev/attestations/verified-candidate/v1" as const;
export const VERIFIED_HARDENING_CANDIDATE_CHECKPOINT_POLICY_VERSION = "verified-hardening-candidate-checkpoint-v2" as const;
export const VERIFIED_HARDENING_CANDIDATE_PREDICATE_TYPE = "https://zintus.dev/attestations/verified-hardening-candidate/v2" as const;
export const IN_TOTO_STATEMENT_TYPE = "https://in-toto.io/Statement/v1" as const;

const IdentifierSchema = z.string().min(1).max(500);
const HashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const CommitShaSchema = z.string().regex(/^[a-f0-9]{40}$|^[a-f0-9]{64}$/);
const TimestampSchema = z.string().datetime({ offset: true });
const codeUnitCompare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const sorted = (values: readonly string[]): string[] => [...values].sort(codeUnitCompare);
const sortedUnique = (values: readonly string[]): boolean =>
  values.length === new Set(values).size && values.every((value, index) => value === sorted(values)[index]);

export const BuilderDispatchCheckpointClaimSchema = z.object({
  inputHash: HashSchema,
  agentExecutionId: IdentifierSchema,
  modelTier: z.literal("GPT-5.6_TERRA"),
  workerOwnerId: IdentifierSchema.nullable(),
  workerFencingToken: z.number().int().positive().nullable(),
  status: z.enum(["SUCCEEDED", "FAILED", "PAUSED"]),
  outputArtifactId: IdentifierSchema.nullable(),
  startedAt: TimestampSchema,
  completedAt: TimestampSchema,
  outputArtifactAuthority: z.object({
    artifactId: IdentifierSchema,
    sha256: HashSchema,
    sizeBytes: z.number().int().positive(),
    createdAt: TimestampSchema,
    type: z.enum(["BUILDER_RESULT", "BUILDER_REPAIR_RESULT"]),
    producerType: z.literal("SYSTEM"),
    producerId: IdentifierSchema,
    trusted: z.literal(false),
    regularFile: z.literal(true),
    symbolicLink: z.literal(false),
  }).strict().nullable(),
}).strict().superRefine((claim, context) => {
  const startedAt = Date.parse(claim.startedAt);
  const completedAt = Date.parse(claim.completedAt);
  if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt) || completedAt < startedAt) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Builder claim terminal interval is invalid" });
  }
  if ((claim.workerOwnerId === null) !== (claim.workerFencingToken === null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "worker owner and fencing token must be paired" });
  }
  if (claim.status === "SUCCEEDED" && !claim.outputArtifactId) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "successful Builder claims require output" });
  }
  if (claim.status === "SUCCEEDED" && (!claim.outputArtifactAuthority ||
      claim.outputArtifactAuthority.artifactId !== claim.outputArtifactId)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "successful Builder claims require matching output authority" });
  }
  if (claim.outputArtifactAuthority) {
    const artifactCreatedAt = Date.parse(claim.outputArtifactAuthority.createdAt);
    if (!Number.isFinite(artifactCreatedAt) || artifactCreatedAt !== completedAt) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Builder output artifact creation must equal terminal completion" });
    }
  }
  if (claim.status !== "SUCCEEDED" && claim.outputArtifactAuthority !== null) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "non-successful Builder claims cannot bind output authority" });
  }
  if (claim.status !== "SUCCEEDED" && claim.outputArtifactId !== null) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "non-successful Builder claims cannot bind output" });
  }
});

const VerifiedCandidateCheckpointContentSchema = z.object({
  schemaVersion: z.literal(1),
  policyVersion: z.literal(VERIFIED_CANDIDATE_CHECKPOINT_POLICY_VERSION),
  parentCheckpointId: z.null(),
  runId: IdentifierSchema,
  requesterUserId: IdentifierSchema,
  repositoryId: IdentifierSchema,
  requiredLaneContractHash: HashSchema,
  manifestHash: HashSchema,
  baseCommitSha: CommitShaSchema,
  resultCommitSha: CommitShaSchema,
  diffHash: HashSchema,
  reviewerSessionId: IdentifierSchema,
  classificationHash: HashSchema,
  classificationResult: z.enum(["READY", "READY_WITH_ADVISORIES"]),
  evidenceBundleId: IdentifierSchema,
  evidenceBundleHash: HashSchema,
  claimSummary: z.object({
    claimIds: z.array(IdentifierSchema),
    claimSetHash: HashSchema,
  }).strict(),
  verificationSummary: z.object({
    verificationPass: z.number().int().positive(),
    testExecutionIds: z.array(IdentifierSchema),
    testExecutionSetHash: HashSchema,
    provenanceEventIds: z.array(IdentifierSchema),
    provenanceHash: HashSchema,
    allRequiredChecksPassed: z.literal(true),
  }).strict(),
  securitySummary: z.object({
    findingIds: z.array(IdentifierSchema),
    findingSetHash: HashSchema,
    openBlockingCriticalCount: z.literal(0),
  }).strict(),
  scopeSummary: z.object({
    artifactId: IdentifierSchema,
    artifactHash: HashSchema,
    policyVersion: z.literal("final-change-scope-v1"),
  }).strict(),
  environmentDigest: HashSchema,
  builderDispatchSummary: z.object({
    claims: z.array(BuilderDispatchCheckpointClaimSchema).min(1),
    claimSetHash: HashSchema,
  }).strict().superRefine((summary, context) => {
    if (!summary.claims.some((claim) => claim.status === "SUCCEEDED")) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "verified candidates require a successful Builder claim", path: ["claims"] });
    }
  }),
  prePromotionEventChainSummary: z.object({
    eventCount: z.number().int().positive(),
    headEventId: IdentifierSchema,
    headSequence: z.number().int().positive(),
    headStateVersion: z.number().int().positive(),
    chainHash: HashSchema,
  }).strict().superRefine((summary, context) => {
    if (summary.eventCount !== summary.headSequence || summary.eventCount !== summary.headStateVersion) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "pre-promotion event chain head/count mismatch" });
    }
  }),
  createdAt: TimestampSchema,
}).strict();

/**
 * A hardening candidate is a new authority, never an optional extension of the
 * legacy v1 authority. Keeping this as a separate strict arm prevents a v1
 * checkpoint from acquiring unsigned lineage fields (or a v2 checkpoint from
 * omitting any member of an authority pair).
 */
const VerifiedHardeningCandidateCheckpointContentSchema = VerifiedCandidateCheckpointContentSchema.omit({
  schemaVersion: true,
  policyVersion: true,
  parentCheckpointId: true,
}).extend({
  schemaVersion: z.literal(2),
  policyVersion: z.literal(VERIFIED_HARDENING_CANDIDATE_CHECKPOINT_POLICY_VERSION),
  parentCheckpointId: HashSchema,
  parentCheckpointHash: HashSchema,
  hardeningLineageId: HashSchema,
  hardeningLineageHash: HashSchema,
  seedAttestationId: HashSchema,
  seedAttestationHash: HashSchema,
}).strict();

const VerifiedCandidateCheckpointArmSchema = VerifiedCandidateCheckpointContentSchema.extend({
  checkpointId: HashSchema,
  checkpointHash: HashSchema,
}).strict();

export const VerifiedCandidateCheckpointSchema = VerifiedCandidateCheckpointArmSchema.superRefine((checkpoint, context) => {
  const { checkpointId, checkpointHash, ...content } = checkpoint;
  if (sha256(content) !== checkpointHash) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "checkpointHash does not match canonical content", path: ["checkpointHash"] });
  }
  if (sha256({ namespace: VERIFIED_CANDIDATE_CHECKPOINT_POLICY_VERSION, checkpointHash }) !== checkpointId) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "checkpointId does not match checkpointHash", path: ["checkpointId"] });
  }
  for (const [path, values] of [
    ["claimSummary", checkpoint.claimSummary.claimIds],
    ["verificationSummary", checkpoint.verificationSummary.testExecutionIds],
    ["verificationSummary", checkpoint.verificationSummary.provenanceEventIds],
    ["securitySummary", checkpoint.securitySummary.findingIds],
  ] as const) {
    if (!sortedUnique(values)) context.addIssue({ code: z.ZodIssueCode.custom, message: "identities must be code-unit sorted and unique", path: [path] });
  }
  const dispatchKeys = checkpoint.builderDispatchSummary.claims.map((claim) => `${claim.inputHash}\u0000${claim.agentExecutionId}`);
  if (!sortedUnique(dispatchKeys)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Builder claims must be code-unit sorted and unique", path: ["builderDispatchSummary", "claims"] });
  }
  const dispatchInputHashes = checkpoint.builderDispatchSummary.claims.map((claim) => claim.inputHash);
  const dispatchAgentIds = checkpoint.builderDispatchSummary.claims.map((claim) => claim.agentExecutionId);
  if (new Set(dispatchInputHashes).size !== dispatchInputHashes.length || new Set(dispatchAgentIds).size !== dispatchAgentIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Builder claim input and agent identities must be unique", path: ["builderDispatchSummary", "claims"] });
  }
  if (sha256(checkpoint.builderDispatchSummary.claims) !== checkpoint.builderDispatchSummary.claimSetHash) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Builder claimSetHash does not match the canonical sorted claims",
      path: ["builderDispatchSummary", "claimSetHash"],
    });
  }
});

const VerifiedHardeningCandidateCheckpointArmSchema = VerifiedHardeningCandidateCheckpointContentSchema.extend({
  checkpointId: HashSchema,
  checkpointHash: HashSchema,
}).strict();

export const VerifiedHardeningCandidateCheckpointSchema = VerifiedHardeningCandidateCheckpointArmSchema.superRefine((checkpoint, context) => {
  const { checkpointId, checkpointHash, ...content } = checkpoint;
  if (sha256(content) !== checkpointHash) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "checkpointHash does not match canonical content", path: ["checkpointHash"] });
  }
  if (sha256({ namespace: VERIFIED_HARDENING_CANDIDATE_CHECKPOINT_POLICY_VERSION, checkpointHash }) !== checkpointId) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "checkpointId does not match checkpointHash", path: ["checkpointId"] });
  }
  for (const [path, values] of [
    ["claimSummary", checkpoint.claimSummary.claimIds],
    ["verificationSummary", checkpoint.verificationSummary.testExecutionIds],
    ["verificationSummary", checkpoint.verificationSummary.provenanceEventIds],
    ["securitySummary", checkpoint.securitySummary.findingIds],
  ] as const) {
    if (!sortedUnique(values)) context.addIssue({ code: z.ZodIssueCode.custom, message: "identities must be code-unit sorted and unique", path: [path] });
  }
  const dispatchKeys = checkpoint.builderDispatchSummary.claims.map((claim) => `${claim.inputHash}\u0000${claim.agentExecutionId}`);
  if (!sortedUnique(dispatchKeys)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Builder claims must be code-unit sorted and unique", path: ["builderDispatchSummary", "claims"] });
  }
  const dispatchInputHashes = checkpoint.builderDispatchSummary.claims.map((claim) => claim.inputHash);
  const dispatchAgentIds = checkpoint.builderDispatchSummary.claims.map((claim) => claim.agentExecutionId);
  if (new Set(dispatchInputHashes).size !== dispatchInputHashes.length || new Set(dispatchAgentIds).size !== dispatchAgentIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Builder claim input and agent identities must be unique", path: ["builderDispatchSummary", "claims"] });
  }
  if (sha256(checkpoint.builderDispatchSummary.claims) !== checkpoint.builderDispatchSummary.claimSetHash) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Builder claimSetHash does not match the canonical sorted claims", path: ["builderDispatchSummary", "claimSetHash"] });
  }
});

/** Strict discriminated version union. Each arm is closed; no optional cross-version fields exist. */
export const VerifiedCandidateCheckpointVersionedSchema = z.discriminatedUnion("schemaVersion", [
  VerifiedCandidateCheckpointArmSchema,
  VerifiedHardeningCandidateCheckpointArmSchema,
]).superRefine((checkpoint, context) => {
  const strict = checkpoint.schemaVersion === 1
    ? VerifiedCandidateCheckpointSchema.safeParse(checkpoint)
    : VerifiedHardeningCandidateCheckpointSchema.safeParse(checkpoint);
  if (!strict.success) for (const issue of strict.error.issues) context.addIssue(issue);
});

export const VerifiedCandidateStatementSchema = z.object({
  _type: z.literal(IN_TOTO_STATEMENT_TYPE),
  subject: z.tuple([z.object({
    name: IdentifierSchema,
    digest: z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  }).strict()]),
  predicateType: z.literal(VERIFIED_CANDIDATE_PREDICATE_TYPE),
  predicate: VerifiedCandidateCheckpointSchema,
}).strict().superRefine((statement, context) => {
  const checkpoint = statement.predicate;
  const subject = statement.subject[0];
  if (subject.name !== `zintus-engineer-candidate/${checkpoint.repositoryId}/${checkpoint.resultCommitSha}` ||
      subject.digest.sha256 !== checkpoint.checkpointHash.slice("sha256:".length)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "statement subject does not match checkpoint" });
  }
});

export const SignedVerifiedCandidateAttestationSchema = z.object({
  statement: VerifiedCandidateStatementSchema,
  statementJson: z.string().min(1),
  statementHash: HashSchema,
  algorithm: IdentifierSchema,
  keyId: IdentifierSchema,
  signature: z.string().min(1).max(20_000),
}).strict().superRefine((attestation, context) => {
  const canonical = canonicalJson(attestation.statement);
  if (canonical !== attestation.statementJson) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "statementJson is not exact canonical statement bytes", path: ["statementJson"] });
  }
  if (sha256(Buffer.from(attestation.statementJson, "utf8")) !== attestation.statementHash) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "statementHash does not match statement bytes", path: ["statementHash"] });
  }
});

export const VerifiedHardeningCandidateStatementSchema = z.object({
  _type: z.literal(IN_TOTO_STATEMENT_TYPE),
  subject: z.tuple([z.object({
    name: IdentifierSchema,
    digest: z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  }).strict()]),
  predicateType: z.literal(VERIFIED_HARDENING_CANDIDATE_PREDICATE_TYPE),
  predicate: VerifiedHardeningCandidateCheckpointSchema,
}).strict().superRefine((statement, context) => {
  const checkpoint = statement.predicate;
  const subject = statement.subject[0];
  if (subject.name !== `zintus-engineer-candidate/${checkpoint.repositoryId}/${checkpoint.resultCommitSha}` ||
      subject.digest.sha256 !== checkpoint.checkpointHash.slice("sha256:".length)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "statement subject does not match checkpoint" });
  }
});

export const SignedVerifiedHardeningCandidateAttestationSchema = z.object({
  statement: VerifiedHardeningCandidateStatementSchema,
  statementJson: z.string().min(1),
  statementHash: HashSchema,
  algorithm: IdentifierSchema,
  keyId: IdentifierSchema,
  signature: z.string().min(1).max(20_000),
}).strict().superRefine((attestation, context) => {
  const canonical = canonicalJson(attestation.statement);
  if (canonical !== attestation.statementJson) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "statementJson is not exact canonical statement bytes", path: ["statementJson"] });
  }
  if (sha256(Buffer.from(attestation.statementJson, "utf8")) !== attestation.statementHash) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "statementHash does not match statement bytes", path: ["statementHash"] });
  }
});

export interface CheckpointAttestor {
  readonly algorithm: string;
  readonly keyId: string;
  sign(payload: Uint8Array): string | Promise<string>;
  verify(payload: Uint8Array, signature: string): boolean | Promise<boolean>;
}

export type VerifiedCandidateCheckpoint = z.infer<typeof VerifiedCandidateCheckpointSchema>;
export type SignedVerifiedCandidateAttestation = z.infer<typeof SignedVerifiedCandidateAttestationSchema>;
export type VerifiedCandidateCheckpointInput = z.input<typeof VerifiedCandidateCheckpointContentSchema>;
export type VerifiedHardeningCandidateCheckpoint = z.infer<typeof VerifiedHardeningCandidateCheckpointSchema>;
export type SignedVerifiedHardeningCandidateAttestation = z.infer<typeof SignedVerifiedHardeningCandidateAttestationSchema>;
export type VerifiedHardeningCandidateCheckpointInput = z.input<typeof VerifiedHardeningCandidateCheckpointContentSchema>;

/** Public, owner-scoped projection. Keep this allowlist intentionally small. */
export const VerifiedCandidateSummarySchema = z.object({
  checkpointId: HashSchema,
  checkpointHash: HashSchema,
  resultCommitSha: CommitShaSchema,
  classificationResult: z.enum(["READY", "READY_WITH_ADVISORIES"]),
  requiredTestCount: z.number().int().nonnegative(),
  allRequiredChecksPassed: z.boolean(),
  openBlockingCriticalCount: z.number().int().nonnegative(),
  environmentDigest: HashSchema,
  createdAt: TimestampSchema,
}).strict();

export type VerifiedCandidateSummary = z.infer<typeof VerifiedCandidateSummarySchema>;

export function verifiedCandidateSummary(checkpoint: VerifiedCandidateCheckpoint | VerifiedHardeningCandidateCheckpoint): VerifiedCandidateSummary {
  const strict = checkpoint.schemaVersion === 2
    ? VerifiedHardeningCandidateCheckpointSchema.parse(checkpoint)
    : VerifiedCandidateCheckpointSchema.parse(checkpoint);
  return VerifiedCandidateSummarySchema.parse({
    checkpointId: strict.checkpointId,
    checkpointHash: strict.checkpointHash,
    resultCommitSha: strict.resultCommitSha,
    classificationResult: strict.classificationResult,
    requiredTestCount: strict.verificationSummary.testExecutionIds.length,
    allRequiredChecksPassed: strict.verificationSummary.allRequiredChecksPassed,
    openBlockingCriticalCount: strict.securitySummary.openBlockingCriticalCount,
    environmentDigest: strict.environmentDigest,
    createdAt: strict.createdAt,
  });
}

export interface PromoteVerifiedCandidateInput {
  runId: string;
  reviewerSessionId: string;
  classificationHash: string;
  evidenceBundleId: string;
  attestor: CheckpointAttestor;
}

export interface VerifiedCandidatePromotionResult {
  checkpoint: VerifiedCandidateCheckpoint;
  attestation: SignedVerifiedCandidateAttestation;
  applied: boolean;
}

export interface VerifiedHardeningCandidatePromotionResult {
  checkpoint: VerifiedHardeningCandidateCheckpoint;
  attestation: SignedVerifiedHardeningCandidateAttestation;
  applied: boolean;
}

export async function verifySignedVerifiedCandidateAttestation(
  input: unknown,
  attestor: CheckpointAttestor,
): Promise<SignedVerifiedCandidateAttestation> {
  const attestation = SignedVerifiedCandidateAttestationSchema.parse(input);
  if (attestation.algorithm !== attestor.algorithm || attestation.keyId !== attestor.keyId) {
    throw new Error("checkpoint attestation signer identity mismatch");
  }
  if ((await attestor.verify(Buffer.from(attestation.statementJson, "utf8"), attestation.signature)) !== true) {
    throw new Error("checkpoint attestation signature verification failed");
  }
  return attestation;
}

export async function createVerifiedCandidateCheckpoint(
  input: VerifiedCandidateCheckpointInput,
  attestor: CheckpointAttestor,
): Promise<{ checkpoint: VerifiedCandidateCheckpoint; attestation: SignedVerifiedCandidateAttestation }> {
  const normalized = VerifiedCandidateCheckpointContentSchema.parse({
    ...input,
    claimSummary: { ...input.claimSummary, claimIds: sorted(input.claimSummary.claimIds) },
    verificationSummary: {
      ...input.verificationSummary,
      testExecutionIds: sorted(input.verificationSummary.testExecutionIds),
      provenanceEventIds: sorted(input.verificationSummary.provenanceEventIds),
    },
    securitySummary: {
      ...input.securitySummary,
      findingIds: sorted(input.securitySummary.findingIds),
    },
    builderDispatchSummary: {
      claims: [...input.builderDispatchSummary.claims].sort((left, right) =>
        codeUnitCompare(`${left.inputHash}\u0000${left.agentExecutionId}`, `${right.inputHash}\u0000${right.agentExecutionId}`)),
      claimSetHash: input.builderDispatchSummary.claimSetHash,
    },
  });
  const checkpointHash = sha256(normalized);
  const checkpoint = VerifiedCandidateCheckpointSchema.parse({
    ...normalized,
    checkpointHash,
    checkpointId: sha256({ namespace: VERIFIED_CANDIDATE_CHECKPOINT_POLICY_VERSION, checkpointHash }),
  });
  const statement = VerifiedCandidateStatementSchema.parse({
    _type: IN_TOTO_STATEMENT_TYPE,
    subject: [{
      name: `zintus-engineer-candidate/${checkpoint.repositoryId}/${checkpoint.resultCommitSha}`,
      digest: { sha256: checkpoint.checkpointHash.slice("sha256:".length) },
    }],
    predicateType: VERIFIED_CANDIDATE_PREDICATE_TYPE,
    predicate: checkpoint,
  });
  const statementJson = canonicalJson(statement);
  const payload = Buffer.from(statementJson, "utf8");
  const signature = await attestor.sign(payload);
  if (!signature) throw new Error("checkpoint attestation signature verification failed");
  const attestation = await verifySignedVerifiedCandidateAttestation({
    statement, statementJson, statementHash: sha256(payload),
    algorithm: attestor.algorithm, keyId: attestor.keyId, signature,
  }, attestor);
  return { checkpoint, attestation };
}

export async function verifySignedVerifiedHardeningCandidateAttestation(
  input: unknown,
  attestor: CheckpointAttestor,
): Promise<SignedVerifiedHardeningCandidateAttestation> {
  const attestation = SignedVerifiedHardeningCandidateAttestationSchema.parse(input);
  if (attestation.algorithm !== attestor.algorithm || attestation.keyId !== attestor.keyId) {
    throw new Error("checkpoint attestation signer identity mismatch");
  }
  if ((await attestor.verify(Buffer.from(attestation.statementJson, "utf8"), attestation.signature)) !== true) {
    throw new Error("checkpoint attestation signature verification failed");
  }
  return attestation;
}

export async function createVerifiedHardeningCandidateCheckpoint(
  input: VerifiedHardeningCandidateCheckpointInput,
  attestor: CheckpointAttestor,
): Promise<{ checkpoint: VerifiedHardeningCandidateCheckpoint; attestation: SignedVerifiedHardeningCandidateAttestation }> {
  const normalized = VerifiedHardeningCandidateCheckpointContentSchema.parse({
    ...input,
    claimSummary: { ...input.claimSummary, claimIds: sorted(input.claimSummary.claimIds) },
    verificationSummary: {
      ...input.verificationSummary,
      testExecutionIds: sorted(input.verificationSummary.testExecutionIds),
      provenanceEventIds: sorted(input.verificationSummary.provenanceEventIds),
    },
    securitySummary: { ...input.securitySummary, findingIds: sorted(input.securitySummary.findingIds) },
    builderDispatchSummary: {
      claims: [...input.builderDispatchSummary.claims].sort((left, right) =>
        codeUnitCompare(`${left.inputHash}\u0000${left.agentExecutionId}`, `${right.inputHash}\u0000${right.agentExecutionId}`)),
      claimSetHash: input.builderDispatchSummary.claimSetHash,
    },
  });
  const checkpointHash = sha256(normalized);
  const checkpoint = VerifiedHardeningCandidateCheckpointSchema.parse({
    ...normalized,
    checkpointHash,
    checkpointId: sha256({ namespace: VERIFIED_HARDENING_CANDIDATE_CHECKPOINT_POLICY_VERSION, checkpointHash }),
  });
  const statement = VerifiedHardeningCandidateStatementSchema.parse({
    _type: IN_TOTO_STATEMENT_TYPE,
    subject: [{
      name: `zintus-engineer-candidate/${checkpoint.repositoryId}/${checkpoint.resultCommitSha}`,
      digest: { sha256: checkpoint.checkpointHash.slice("sha256:".length) },
    }],
    predicateType: VERIFIED_HARDENING_CANDIDATE_PREDICATE_TYPE,
    predicate: checkpoint,
  });
  const statementJson = canonicalJson(statement);
  const payload = Buffer.from(statementJson, "utf8");
  const signature = await attestor.sign(payload);
  if (!signature) throw new Error("checkpoint attestation signature verification failed");
  const attestation = await verifySignedVerifiedHardeningCandidateAttestation({
    statement, statementJson, statementHash: sha256(payload),
    algorithm: attestor.algorithm, keyId: attestor.keyId, signature,
  }, attestor);
  return { checkpoint, attestation };
}
