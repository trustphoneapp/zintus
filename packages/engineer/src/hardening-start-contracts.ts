import { z } from "zod";
import { canonicalJson, sha256 } from "./hash.js";
import { IN_TOTO_STATEMENT_TYPE, type CheckpointAttestor } from "./verified-candidate-checkpoint.js";

export const HARDENING_START_OPERATION_POLICY_VERSION = "engineer-hardening-start-operation-v1" as const;
export const HARDENING_SEED_ATTESTATION_POLICY_VERSION = "engineer-hardening-seed-attestation-v1" as const;
export const HARDENING_SEED_PREDICATE_TYPE = "https://zintus.dev/attestations/hardening-seed-verified/v1" as const;

const IdentifierSchema = z.string().min(1).max(200);
const HashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const CommitSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const TimestampSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine((value) => Number.isFinite(Date.parse(value)), "timestamp must be a real UTC millisecond instant");

export const HardeningStartRequestSchema = z.object({
  expectedChildStateVersion: z.literal(0),
  lineageId: HashSchema,
  lineageHash: HashSchema,
  idempotencyKey: IdentifierSchema,
}).strict();

const HardeningStartOperationContentSchema = z.object({
  schemaVersion: z.literal(1),
  policyVersion: z.literal(HARDENING_START_OPERATION_POLICY_VERSION),
  operationId: HashSchema,
  requesterUserId: IdentifierSchema,
  childRunId: IdentifierSchema,
  expectedChildStateVersion: z.literal(0),
  lineageId: HashSchema,
  lineageHash: HashSchema,
  idempotencyKey: IdentifierSchema,
  createdAt: TimestampSchema,
}).strict();

export const HardeningStartOperationSchema = HardeningStartOperationContentSchema.extend({
  operationHash: HashSchema,
}).strict().superRefine((operation, context) => {
  const { operationHash, ...content } = operation;
  if (sha256(content) !== operationHash) context.addIssue({ code: z.ZodIssueCode.custom, message: "operationHash does not match canonical content", path: ["operationHash"] });
  const expected = sha256({ namespace: HARDENING_START_OPERATION_POLICY_VERSION, childRunId: operation.childRunId, idempotencyKey: operation.idempotencyKey });
  if (operation.operationId !== expected) context.addIssue({ code: z.ZodIssueCode.custom, message: "operationId does not match durable idempotency authority", path: ["operationId"] });
});

export function createHardeningStartOperation(input: Omit<z.input<typeof HardeningStartOperationContentSchema>, "operationId">) {
  const operationId = sha256({ namespace: HARDENING_START_OPERATION_POLICY_VERSION, childRunId: input.childRunId, idempotencyKey: input.idempotencyKey });
  const content = HardeningStartOperationContentSchema.parse({ ...input, operationId });
  return HardeningStartOperationSchema.parse({ ...content, operationHash: sha256(content) });
}

const HardeningSeedAttestationContentSchema = z.object({
  schemaVersion: z.literal(1),
  policyVersion: z.literal(HARDENING_SEED_ATTESTATION_POLICY_VERSION),
  attestationType: z.literal("HARDENING_SEED_VERIFIED"),
  operationId: HashSchema,
  operationHash: HashSchema,
  rootRunId: IdentifierSchema,
  parentRunId: IdentifierSchema,
  childRunId: IdentifierSchema,
  requesterUserId: IdentifierSchema,
  repositoryId: IdentifierSchema,
  lineageId: HashSchema,
  lineageHash: HashSchema,
  parentCheckpointId: HashSchema,
  parentCheckpointHash: HashSchema,
  baseCommitSha: CommitSchema,
  seedResultCommitSha: CommitSchema,
  seedTreeHash: HashSchema,
  seedDiffHash: HashSchema,
  imageDigest: HashSchema,
  environmentDigest: HashSchema,
  dependencyHash: HashSchema,
  createdAt: TimestampSchema,
}).strict();

export const HardeningSeedAttestationSchema = HardeningSeedAttestationContentSchema.extend({
  seedAttestationId: HashSchema,
  seedAttestationHash: HashSchema,
}).strict().superRefine((attestation, context) => {
  const { seedAttestationId, seedAttestationHash, ...content } = attestation;
  if (sha256(content) !== seedAttestationHash) context.addIssue({ code: z.ZodIssueCode.custom, message: "seedAttestationHash does not match canonical content", path: ["seedAttestationHash"] });
  if (sha256({ namespace: HARDENING_SEED_ATTESTATION_POLICY_VERSION, seedAttestationHash }) !== seedAttestationId) context.addIssue({ code: z.ZodIssueCode.custom, message: "seedAttestationId does not match seedAttestationHash", path: ["seedAttestationId"] });
});

export const HardeningSeedStatementSchema = z.object({
  _type: z.literal(IN_TOTO_STATEMENT_TYPE),
  subject: z.tuple([z.object({
    name: IdentifierSchema,
    digest: z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  }).strict()]),
  predicateType: z.literal(HARDENING_SEED_PREDICATE_TYPE),
  predicate: HardeningSeedAttestationSchema,
}).strict().superRefine((statement, context) => {
  const attestation = statement.predicate;
  if (statement.subject[0].name !== `zintus-engineer-hardening-seed/${attestation.repositoryId}/${attestation.childRunId}` ||
      statement.subject[0].digest.sha256 !== attestation.seedAttestationHash.slice(7)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "seed attestation statement subject mismatch", path: ["subject"] });
  }
});

export const SignedHardeningSeedAttestationSchema = z.object({
  attestation: HardeningSeedAttestationSchema,
  statement: HardeningSeedStatementSchema,
  statementJson: z.string().min(1),
  statementHash: HashSchema,
  algorithm: IdentifierSchema,
  keyId: IdentifierSchema,
  signature: z.string().min(1),
}).strict().superRefine((signed, context) => {
  if (canonicalJson(signed.statement) !== signed.statementJson || sha256(signed.statementJson) !== signed.statementHash) context.addIssue({ code: z.ZodIssueCode.custom, message: "signed statement bytes/hash mismatch", path: ["statementJson"] });
  if (canonicalJson(signed.statement.predicate) !== canonicalJson(signed.attestation)) context.addIssue({ code: z.ZodIssueCode.custom, message: "statement predicate does not match seed attestation", path: ["statement", "predicate"] });
});

export async function createSignedHardeningSeedAttestation(input: z.input<typeof HardeningSeedAttestationContentSchema>, signer: CheckpointAttestor) {
  const content = HardeningSeedAttestationContentSchema.parse(input);
  const seedAttestationHash = sha256(content);
  const attestation = HardeningSeedAttestationSchema.parse({ ...content, seedAttestationHash,
    seedAttestationId: sha256({ namespace: HARDENING_SEED_ATTESTATION_POLICY_VERSION, seedAttestationHash }) });
  const statement = HardeningSeedStatementSchema.parse({ _type: IN_TOTO_STATEMENT_TYPE,
    subject: [{ name: `zintus-engineer-hardening-seed/${attestation.repositoryId}/${attestation.childRunId}`, digest: { sha256: seedAttestationHash.slice(7) } }],
    predicateType: HARDENING_SEED_PREDICATE_TYPE, predicate: attestation });
  const statementJson = canonicalJson(statement);
  const statementHash = sha256(statementJson);
  const signature = await signer.sign(Buffer.from(statementJson, "utf8"));
  return SignedHardeningSeedAttestationSchema.parse({ attestation, statement, statementJson, statementHash,
    algorithm: signer.algorithm, keyId: signer.keyId, signature });
}

export async function verifySignedHardeningSeedAttestation(input: unknown, verifier: CheckpointAttestor) {
  const signed = SignedHardeningSeedAttestationSchema.parse(input);
  if (verifier.algorithm !== signed.algorithm || verifier.keyId !== signed.keyId ||
      !(await verifier.verify(Buffer.from(signed.statementJson, "utf8"), signed.signature))) throw new TypeError("hardening seed attestation signature is invalid");
  return signed;
}

export type HardeningStartRequest = z.infer<typeof HardeningStartRequestSchema>;
export type HardeningStartOperation = z.infer<typeof HardeningStartOperationSchema>;
export type HardeningSeedAttestation = z.infer<typeof HardeningSeedAttestationSchema>;
export type SignedHardeningSeedAttestation = z.infer<typeof SignedHardeningSeedAttestationSchema>;
