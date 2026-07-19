import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { canonicalJson, sha256, sha256Bytes } from "./hash.js";
import {
  VerifiedCandidateCheckpointVersionedSchema,
  type VerifiedCandidateCheckpoint,
  type VerifiedHardeningCandidateCheckpoint,
} from "./verified-candidate-checkpoint.js";

/**
 * P11 provenance attestation (standalone, not yet wired into live paths).
 *
 * Builds an in-toto v1 Statement whose subject is the exact verified-candidate
 * digest (the checkpointHash produced by the P10 verified-candidate authority)
 * and whose predicate carries the SLSA-compatible provenance of the run. The
 * Statement is wrapped in a DSSE (Dead Simple Signing Envelope) with a
 * pluggable signer.
 *
 * Signing keys are structurally confined to the process that constructs the
 * signer (the gateway). A signer captures its secret in a closure and exposes
 * only `sign`/`verify`/`keyId`/`algorithm` -- the raw secret is never a field,
 * so it cannot be read back out of a sandbox/model context that is only handed
 * the signer object. This mirrors the `signDirective` confinement in
 * resolution-case.ts.
 *
 * The real KMS / Sigstore backend is a [HUMAN]-gated integration; the stub
 * signer here throws rather than adding a network dependency.
 */

export const P11_STATEMENT_TYPE = "https://in-toto.io/Statement/v1" as const;
export const P11_PROVENANCE_PREDICATE_TYPE = "https://zintus.dev/attestations/engineer-provenance/v1" as const;
export const P11_PROVENANCE_POLICY_VERSION = "engineer-provenance-attestation-v1" as const;
export const P11_BUILD_TYPE = "https://zintus.dev/engineer/required-lane/v1" as const;
export const DSSE_PAYLOAD_TYPE = "application/vnd.in-toto+json" as const;

const IdentifierSchema = z.string().min(1).max(500);
const HashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const BareSha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const CommitShaSchema = z.string().regex(/^[a-f0-9]{40}$|^[a-f0-9]{64}$/);
const TimestampSchema = z.string().datetime({ offset: true });
const Base64Schema = z.string().min(1).max(200_000).regex(/^[A-Za-z0-9+/]+={0,2}$/);

const codeUnitCompare = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

// --- Predicate field schemas -------------------------------------------------

const AgentRoleSchema = z.object({
  role: IdentifierSchema,
  agentExecutionId: IdentifierSchema,
  modelTier: IdentifierSchema,
}).strict();

const BudgetUsageSnapshotSchema = z.object({
  costMicrousd: z.number().int().nonnegative(),
  tokensConsumed: z.number().int().nonnegative(),
  activeSeconds: z.number().nonnegative().finite(),
}).strict();

const ReplacementLineageSchema = z.object({
  caseId: HashSchema,
  caseHash: HashSchema,
  directiveId: HashSchema,
  directiveHash: HashSchema,
  replacementId: IdentifierSchema,
  replacementHash: HashSchema,
}).strict();

const PublicationReceiptSchema = z.object({
  publicationId: IdentifierSchema,
  publicationRevision: z.number().int().nonnegative(),
  prUrl: z.string().url().max(2000),
  commitSha: CommitShaSchema,
  idempotencyKey: IdentifierSchema,
  observedAt: TimestampSchema,
}).strict();

/**
 * The full predicate. `verifiedCandidateCheckpoint` embeds the entire
 * verified-candidate authority so an offline verifier can recompute the subject
 * digest from the provided artifact without any external lookup. Every field
 * that is also carried by the checkpoint is cross-bound in the superRefine
 * below, so a predicate cannot disagree with its own embedded checkpoint.
 */
const ProvenancePredicateContentSchema = z.object({
  schemaVersion: z.literal(1),
  policyVersion: z.literal(P11_PROVENANCE_POLICY_VERSION),
  buildType: z.literal(P11_BUILD_TYPE),
  verifiedCandidateCheckpoint: VerifiedCandidateCheckpointVersionedSchema,
  isReplacement: z.boolean(),
  frozenContractHash: HashSchema,
  repository: z.object({ repositoryId: IdentifierSchema, baseCommitSha: CommitShaSchema }).strict(),
  result: z.object({
    resultCommitSha: CommitShaSchema,
    resultTreeHash: HashSchema,
    diffHash: HashSchema,
  }).strict(),
  requiredTests: z.object({
    verificationPass: z.number().int().positive(),
    testCount: z.number().int().nonnegative(),
    testExecutionSetHash: HashSchema,
    allRequiredChecksPassed: z.literal(true),
  }).strict(),
  attestationDigests: z.object({
    securityFindingSetHash: HashSchema,
    scopeArtifactHash: HashSchema,
    evidenceBundleHash: HashSchema,
    environmentDigest: HashSchema,
  }).strict(),
  roles: z.array(AgentRoleSchema).min(1),
  budget: BudgetUsageSnapshotSchema,
  identities: z.object({
    requesterUserId: IdentifierSchema,
    approverUserId: IdentifierSchema,
  }).strict(),
  replacementLineage: ReplacementLineageSchema.nullable(),
  publicationReceipt: PublicationReceiptSchema.nullable(),
  createdAt: TimestampSchema,
}).strict().superRefine((predicate, context) => {
  const checkpoint = predicate.verifiedCandidateCheckpoint;
  // A distinct human approver is a non-negotiable safety control.
  if (predicate.identities.approverUserId === predicate.identities.requesterUserId) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "approver must differ from requester", path: ["identities", "approverUserId"] });
  }
  // isReplacement means "this run is a P7 resolution replacement run" (it owns a
  // resolution_replacements row), NOT that the embedded checkpoint is a v2
  // hardening candidate -- those are DISJOINT lineages. A P7 replacement emits an
  // ordinary v1 verified-candidate checkpoint. The flag is therefore authoritative
  // from the promotion context and is cross-bound only to the presence of the P7
  // lineage payload below.
  // A replacement-flagged candidate MUST carry its P7 replacement lineage.
  if (predicate.isReplacement && predicate.replacementLineage === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "replacement-flagged candidate requires replacement lineage", path: ["replacementLineage"] });
  }
  if (!predicate.isReplacement && predicate.replacementLineage !== null) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "non-replacement candidate cannot carry replacement lineage", path: ["replacementLineage"] });
  }
  // Cross-bind every predicate field the checkpoint also asserts.
  const bindings: Array<[boolean, string, string[]]> = [
    [predicate.frozenContractHash === checkpoint.requiredLaneContractHash, "frozenContractHash mismatch", ["frozenContractHash"]],
    [predicate.repository.repositoryId === checkpoint.repositoryId, "repositoryId mismatch", ["repository", "repositoryId"]],
    [predicate.repository.baseCommitSha === checkpoint.baseCommitSha, "baseCommitSha mismatch", ["repository", "baseCommitSha"]],
    [predicate.result.resultCommitSha === checkpoint.resultCommitSha, "resultCommitSha mismatch", ["result", "resultCommitSha"]],
    [predicate.result.diffHash === checkpoint.diffHash, "diffHash mismatch", ["result", "diffHash"]],
    [predicate.requiredTests.verificationPass === checkpoint.verificationSummary.verificationPass, "verificationPass mismatch", ["requiredTests", "verificationPass"]],
    [predicate.requiredTests.testCount === checkpoint.verificationSummary.testExecutionIds.length, "testCount mismatch", ["requiredTests", "testCount"]],
    [predicate.requiredTests.testExecutionSetHash === checkpoint.verificationSummary.testExecutionSetHash, "testExecutionSetHash mismatch", ["requiredTests", "testExecutionSetHash"]],
    [predicate.attestationDigests.securityFindingSetHash === checkpoint.securitySummary.findingSetHash, "securityFindingSetHash mismatch", ["attestationDigests", "securityFindingSetHash"]],
    [predicate.attestationDigests.scopeArtifactHash === checkpoint.scopeSummary.artifactHash, "scopeArtifactHash mismatch", ["attestationDigests", "scopeArtifactHash"]],
    [predicate.attestationDigests.evidenceBundleHash === checkpoint.evidenceBundleHash, "evidenceBundleHash mismatch", ["attestationDigests", "evidenceBundleHash"]],
    [predicate.attestationDigests.environmentDigest === checkpoint.environmentDigest, "environmentDigest mismatch", ["attestationDigests", "environmentDigest"]],
    [predicate.identities.requesterUserId === checkpoint.requesterUserId, "requesterUserId mismatch", ["identities", "requesterUserId"]],
  ];
  for (const [ok, message, path] of bindings) {
    if (!ok) context.addIssue({ code: z.ZodIssueCode.custom, message, path });
  }
  // Roles must be code-unit sorted and unique on (role, agentExecutionId).
  const roleKeys = predicate.roles.map((entry) => `${entry.role} ${entry.agentExecutionId}`);
  const sortedKeys = [...roleKeys].sort(codeUnitCompare);
  if (roleKeys.some((key, index) => key !== sortedKeys[index]) || new Set(roleKeys).size !== roleKeys.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "roles must be code-unit sorted and unique", path: ["roles"] });
  }
});

export const ProvenanceStatementSchema = z.object({
  _type: z.literal(P11_STATEMENT_TYPE),
  subject: z.tuple([z.object({
    name: IdentifierSchema,
    digest: z.object({ sha256: BareSha256Schema }).strict(),
  }).strict()]),
  predicateType: z.literal(P11_PROVENANCE_PREDICATE_TYPE),
  predicate: ProvenancePredicateContentSchema,
}).strict().superRefine((statement, context) => {
  const checkpoint = statement.predicate.verifiedCandidateCheckpoint;
  const subject = statement.subject[0];
  const expectedName = `zintus-engineer-candidate/${checkpoint.repositoryId}/${checkpoint.resultCommitSha}`;
  if (subject.name !== expectedName) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "statement subject name does not match checkpoint", path: ["subject"] });
  }
  // Subject digest recomputation: the embedded checkpoint's own hash (already
  // validated against its content by the checkpoint schema) MUST equal the
  // subject digest. This is the binding between the statement and the exact
  // verified-candidate authority.
  if (subject.digest.sha256 !== checkpoint.checkpointHash.slice("sha256:".length)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "statement subject digest does not match verified-candidate checkpoint", path: ["subject", "digest"] });
  }
});

export type ProvenanceStatement = z.infer<typeof ProvenanceStatementSchema>;
export type ProvenancePredicate = z.infer<typeof ProvenancePredicateContentSchema>;

// --- DSSE envelope -----------------------------------------------------------

const DsseSignatureSchema = z.object({
  keyid: IdentifierSchema,
  sig: Base64Schema,
}).strict();

export const DsseEnvelopeSchema = z.object({
  payloadType: z.literal(DSSE_PAYLOAD_TYPE),
  payload: Base64Schema,
  signatures: z.array(DsseSignatureSchema).min(1),
}).strict();

export type DsseEnvelope = z.infer<typeof DsseEnvelopeSchema>;

export interface ProvenanceSigner {
  readonly keyId: string;
  readonly algorithm: string;
  sign(preAuthEncoded: Uint8Array): string | Promise<string>;
}

export interface ProvenanceVerifier {
  readonly keyId: string;
  readonly algorithm: string;
  verify(preAuthEncoded: Uint8Array, signatureBase64: string): boolean | Promise<boolean>;
}

const textEncoder = new TextEncoder();

/**
 * DSSE Pre-Authentication Encoding (PAE) per the spec:
 *   "DSSEv1" SP LEN(payloadType) SP payloadType SP LEN(payload) SP payload
 * Lengths are ASCII decimal of the UTF-8 byte length; the trailing payload is
 * the raw serialized statement bytes (not base64). Signing over the PAE (rather
 * than the bare payload) prevents payloadType-confusion attacks.
 */
export function preAuthEncoding(payloadType: string, payload: Uint8Array): Uint8Array {
  const typeBytes = textEncoder.encode(payloadType);
  const header = textEncoder.encode(`DSSEv1 ${typeBytes.byteLength} ${payloadType} ${payload.byteLength} `);
  const out = new Uint8Array(header.byteLength + payload.byteLength);
  out.set(header, 0);
  out.set(payload, header.byteLength);
  return out;
}

/**
 * HMAC signer/verifier. The secret is captured in the closure and is never a
 * property of the returned object, so a context that only holds the signer
 * cannot exfiltrate the key. HMAC is symmetric, so the same object verifies;
 * offline verification therefore requires the same gateway-held secret. A real
 * public-key backend (Sigstore/KMS) removes the symmetric-secret requirement --
 * that is the [HUMAN]-gated integration below.
 */
export function createHmacProvenanceSigner(options: {
  secret: Uint8Array | string;
  keyId: string;
}): ProvenanceSigner & ProvenanceVerifier {
  if (options.keyId.length < 1) throw new Error("HMAC provenance signer requires a keyId");
  const key = typeof options.secret === "string" ? Buffer.from(options.secret, "utf8") : Buffer.from(options.secret);
  if (key.byteLength < 16) throw new Error("HMAC provenance secret must be at least 16 bytes");
  const keyId = options.keyId;
  return Object.freeze({
    keyId,
    algorithm: "hmac-sha256",
    sign(preAuthEncoded: Uint8Array): string {
      return createHmac("sha256", key).update(preAuthEncoded).digest("base64");
    },
    verify(preAuthEncoded: Uint8Array, signatureBase64: string): boolean {
      const expected = createHmac("sha256", key).update(preAuthEncoded).digest();
      let supplied: Buffer;
      try {
        supplied = Buffer.from(signatureBase64, "base64");
      } catch {
        return false;
      }
      if (supplied.byteLength !== expected.byteLength) return false;
      return timingSafeEqual(expected, supplied);
    },
  });
}

/**
 * Stub for the [HUMAN]-gated managed-KMS / Sigstore signer. It deliberately
 * carries no network dependency and throws on use; wiring the real backend is a
 * separate, human-approved integration.
 */
export function createManagedKmsProvenanceSignerStub(options: {
  keyId: string;
  algorithm?: string;
}): ProvenanceSigner & ProvenanceVerifier {
  const unavailable = (): never => {
    throw new Error("managed-KMS/Sigstore provenance signing is a [HUMAN]-gated integration and is not wired in this build");
  };
  return Object.freeze({
    keyId: options.keyId,
    algorithm: options.algorithm ?? "kms-managed",
    sign: unavailable,
    verify: unavailable,
  });
}

// --- Statement construction --------------------------------------------------

export interface ProvenanceAttestationInput {
  checkpoint: VerifiedCandidateCheckpoint | VerifiedHardeningCandidateCheckpoint;
  resultTreeHash: string;
  /**
   * True iff the promoted run is a P7 resolution replacement run (it owns a
   * resolution_replacements row). This is authoritative from the promotion
   * context; a replacement REQUIRES `replacementLineage` and a non-replacement
   * MUST omit it (enforced by the predicate schema).
   */
  isReplacement: boolean;
  roles: ReadonlyArray<{ role: string; agentExecutionId: string; modelTier: string }>;
  budget: { costMicrousd: number; tokensConsumed: number; activeSeconds: number };
  approverUserId: string;
  replacementLineage?: z.infer<typeof ReplacementLineageSchema> | null;
  publicationReceipt?: z.infer<typeof PublicationReceiptSchema> | null;
  createdAt: string;
}

/**
 * Build (but do not sign) the in-toto Statement from a verified-candidate
 * checkpoint plus the P11-only fields (tree hash, roles, budget, approver,
 * optional lineage/receipt). Serialization is canonical JSON.
 */
export function buildProvenanceStatement(input: ProvenanceAttestationInput): {
  statement: ProvenanceStatement;
  statementJson: string;
  statementHash: `sha256:${string}`;
  predicateHash: `sha256:${string}`;
} {
  const checkpoint = input.checkpoint;
  const isReplacement = input.isReplacement;
  const roles = [...input.roles].sort((left, right) =>
    codeUnitCompare(`${left.role} ${left.agentExecutionId}`, `${right.role} ${right.agentExecutionId}`));
  const predicate = ProvenancePredicateContentSchema.parse({
    schemaVersion: 1,
    policyVersion: P11_PROVENANCE_POLICY_VERSION,
    buildType: P11_BUILD_TYPE,
    verifiedCandidateCheckpoint: checkpoint,
    isReplacement,
    frozenContractHash: checkpoint.requiredLaneContractHash,
    repository: { repositoryId: checkpoint.repositoryId, baseCommitSha: checkpoint.baseCommitSha },
    result: {
      resultCommitSha: checkpoint.resultCommitSha,
      resultTreeHash: input.resultTreeHash,
      diffHash: checkpoint.diffHash,
    },
    requiredTests: {
      verificationPass: checkpoint.verificationSummary.verificationPass,
      testCount: checkpoint.verificationSummary.testExecutionIds.length,
      testExecutionSetHash: checkpoint.verificationSummary.testExecutionSetHash,
      allRequiredChecksPassed: true,
    },
    attestationDigests: {
      securityFindingSetHash: checkpoint.securitySummary.findingSetHash,
      scopeArtifactHash: checkpoint.scopeSummary.artifactHash,
      evidenceBundleHash: checkpoint.evidenceBundleHash,
      environmentDigest: checkpoint.environmentDigest,
    },
    roles,
    budget: input.budget,
    identities: { requesterUserId: checkpoint.requesterUserId, approverUserId: input.approverUserId },
    replacementLineage: input.replacementLineage ?? null,
    publicationReceipt: input.publicationReceipt ?? null,
    createdAt: input.createdAt,
  });
  const statement = ProvenanceStatementSchema.parse({
    _type: P11_STATEMENT_TYPE,
    subject: [{
      name: `zintus-engineer-candidate/${checkpoint.repositoryId}/${checkpoint.resultCommitSha}`,
      digest: { sha256: checkpoint.checkpointHash.slice("sha256:".length) },
    }],
    predicateType: P11_PROVENANCE_PREDICATE_TYPE,
    predicate,
  });
  const statementJson = canonicalJson(statement);
  return {
    statement,
    statementJson,
    statementHash: sha256Bytes(textEncoder.encode(statementJson)),
    predicateHash: sha256(predicate),
  };
}

/** Build the Statement and wrap it in a signed DSSE envelope. */
export async function createProvenanceAttestation(
  input: ProvenanceAttestationInput,
  signer: ProvenanceSigner,
): Promise<{ statement: ProvenanceStatement; statementJson: string; envelope: DsseEnvelope }> {
  const built = buildProvenanceStatement(input);
  const payloadBytes = textEncoder.encode(built.statementJson);
  const pae = preAuthEncoding(DSSE_PAYLOAD_TYPE, payloadBytes);
  const sig = await signer.sign(pae);
  if (!sig) throw new Error("provenance signer produced an empty signature");
  const envelope = DsseEnvelopeSchema.parse({
    payloadType: DSSE_PAYLOAD_TYPE,
    payload: Buffer.from(payloadBytes).toString("base64"),
    signatures: [{ keyid: signer.keyId, sig }],
  });
  return { statement: built.statement, statementJson: built.statementJson, envelope };
}

// --- Offline verifier --------------------------------------------------------

export type ProvenanceVerificationFailureCode =
  | "MALFORMED_ENVELOPE"
  | "PAYLOAD_DECODE_FAILED"
  | "MALFORMED_STATEMENT"
  | "NON_CANONICAL_PAYLOAD"
  | "SUBJECT_DIGEST_MISMATCH"
  | "MISSING_REPLACEMENT_LINEAGE"
  | "MISSING_APPROVER"
  | "SIGNER_IDENTITY_MISMATCH"
  | "SIGNATURE_INVALID";

export type ProvenanceVerificationResult =
  | { ok: true; statement: ProvenanceStatement; statementJson: string }
  | { ok: false; code: ProvenanceVerificationFailureCode; message: string };

/**
 * Fully offline verification of an exported DSSE-wrapped provenance attestation.
 * Order matters: structural/binding checks that need no key run first, so a
 * caller without the signing secret still detects a tampered subject digest,
 * non-canonical payload bytes, or a missing approver/lineage. The DSSE
 * signature check (which requires the verifier key) runs last and catches every
 * remaining byte-level tamper.
 */
export async function verifyProvenanceAttestation(
  envelopeInput: unknown,
  verifier: ProvenanceVerifier,
): Promise<ProvenanceVerificationResult> {
  const envelopeParsed = DsseEnvelopeSchema.safeParse(envelopeInput);
  if (!envelopeParsed.success) {
    return { ok: false, code: "MALFORMED_ENVELOPE", message: envelopeParsed.error.message };
  }
  const envelope = envelopeParsed.data;

  let payloadBytes: Buffer;
  let payloadString: string;
  try {
    payloadBytes = Buffer.from(envelope.payload, "base64");
    payloadString = payloadBytes.toString("utf8");
  } catch {
    return { ok: false, code: "PAYLOAD_DECODE_FAILED", message: "payload is not decodable base64/UTF-8" };
  }

  let statementUnknown: unknown;
  try {
    statementUnknown = JSON.parse(payloadString);
  } catch {
    return { ok: false, code: "MALFORMED_STATEMENT", message: "payload is not valid JSON" };
  }

  const statementParsed = ProvenanceStatementSchema.safeParse(statementUnknown);
  if (!statementParsed.success) {
    // Distinguish the two safety-control rejections the schema enforces so a
    // caller can act on them, otherwise report a generic schema failure.
    const messages = statementParsed.error.issues.map((issue) => issue.message);
    if (messages.some((message) => message.includes("replacement lineage"))) {
      return { ok: false, code: "MISSING_REPLACEMENT_LINEAGE", message: "replacement-flagged candidate is missing its P7 lineage" };
    }
    if (messages.some((message) => message.includes("approver must differ"))) {
      return { ok: false, code: "MISSING_APPROVER", message: "approver is absent or equal to the requester" };
    }
    if (messages.some((message) => message.includes("subject digest"))) {
      return { ok: false, code: "SUBJECT_DIGEST_MISMATCH", message: "statement subject digest does not match the verified-candidate checkpoint" };
    }
    return { ok: false, code: "MALFORMED_STATEMENT", message: statementParsed.error.message };
  }
  const statement = statementParsed.data;

  // The payload bytes MUST be the exact canonical serialization of the parsed
  // statement. This rejects any smuggled non-canonical byte sequence that would
  // otherwise round-trip through JSON.parse.
  const canonical = canonicalJson(statement);
  if (canonical !== payloadString) {
    return { ok: false, code: "NON_CANONICAL_PAYLOAD", message: "payload bytes are not the canonical statement serialization" };
  }

  // Explicit subject-digest recomputation from the provided artifact (the
  // embedded checkpoint), independent of the schema's own binding.
  const checkpoint = statement.predicate.verifiedCandidateCheckpoint;
  if (statement.subject[0].digest.sha256 !== checkpoint.checkpointHash.slice("sha256:".length)) {
    return { ok: false, code: "SUBJECT_DIGEST_MISMATCH", message: "recomputed subject digest does not match" };
  }

  const signature = envelope.signatures[0]!;
  if (signature.keyid !== verifier.keyId) {
    return { ok: false, code: "SIGNER_IDENTITY_MISMATCH", message: "envelope key id does not match the verifier" };
  }

  const pae = preAuthEncoding(envelope.payloadType, payloadBytes);
  const signatureValid = await verifier.verify(pae, signature.sig);
  if (signatureValid !== true) {
    return { ok: false, code: "SIGNATURE_INVALID", message: "DSSE signature verification failed" };
  }

  return { ok: true, statement, statementJson: payloadString };
}
