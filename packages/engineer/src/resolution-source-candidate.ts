import type { Database } from "bun:sqlite";
import { createHmac } from "node:crypto";
import { z } from "zod";
import { sha256, sha256Bytes } from "./hash.js";

// ---------------------------------------------------------------------------
// P7 B-prime: signed pre-verification source-candidate authority (Day 3 pair 2).
//
// Sol superseded reverify option B with B-prime: a resolution case does not
// rehydrate a same-run checkpoint (transient failures have no promoted
// checkpoint, and v1/v2 rehydration needs same-run Builder rows). Instead the
// case carries a separately named and *signed* pre-verification source
// candidate. It is NOT a ready checkpoint. It binds the successful source
// Builder dispatch identity, the output/result and seed content addresses, the
// source run event head (the quiescence anchor), manifest/contract/base, the
// test-plan hash, and the transient-proof snapshot — signed with the same
// gateway-held authority that signs directives.
//
// A reverify replacement may inherit only this signed Builder summary. On
// apply the record is re-verified by re-reading every referenced durable byte
// and rejecting on any drift, so a hostile or stale digest cannot smuggle an
// unquiesced or forged source state into the reverify path.
// ---------------------------------------------------------------------------

export const RESOLUTION_SOURCE_CANDIDATE_POLICY_VERSION = "engineer-resolution-source-candidate-v1" as const;
export const RESOLUTION_SOURCE_CANDIDATE_SCHEMA_VERSION = 1 as const;
export const RESOLUTION_SOURCE_CANDIDATE_SIGNATURE_ALGORITHM = "HMAC-SHA256" as const;

const HashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const ShaSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);

export const SourceCandidateContentSchema = z.object({
  sourceRunId: z.string().min(1).max(200),
  ownerUserId: z.string().min(1).max(200),
  repositoryId: z.string().min(1).max(200),
  builderDispatch: z.object({
    agentExecutionId: z.string().min(1).max(200),
    inputHash: HashSchema,
    modelTier: z.string().min(1).max(100),
  }).strict(),
  output: z.object({
    artifactId: z.string().min(1).max(200),
    contentAddress: HashSchema,
    executionStatus: z.string().min(1).max(100),
  }).strict(),
  seed: z.object({
    artifactId: z.string().min(1).max(200),
    contentAddress: HashSchema,
  }).strict(),
  runEventHead: z.object({
    sequence: z.number().int().positive(),
    eventId: z.string().min(1).max(200),
  }).strict(),
  manifestHash: HashSchema,
  requiredLaneContractHash: HashSchema,
  baseCommitSha: ShaSchema,
  testPlanHash: HashSchema,
  transientProof: z.object({
    reasonCode: z.string().regex(/^[A-Z][A-Z0-9_]{1,127}$/),
    fingerprint: HashSchema,
  }).strict(),
  createdAt: z.string().min(1),
}).strict();
export type SourceCandidateContent = z.infer<typeof SourceCandidateContentSchema>;

export interface SignedSourceCandidate extends SourceCandidateContent {
  readonly recordId: `sha256:${string}`;
  readonly recordHash: `sha256:${string}`;
  readonly schemaVersion: typeof RESOLUTION_SOURCE_CANDIDATE_SCHEMA_VERSION;
  readonly policyVersion: typeof RESOLUTION_SOURCE_CANDIDATE_POLICY_VERSION;
  readonly signature: { algorithm: typeof RESOLUTION_SOURCE_CANDIDATE_SIGNATURE_ALGORITHM; keyId: string; value: string };
}

function canonicalContent(content: SourceCandidateContent): Record<string, unknown> {
  return {
    schemaVersion: RESOLUTION_SOURCE_CANDIDATE_SCHEMA_VERSION,
    policyVersion: RESOLUTION_SOURCE_CANDIDATE_POLICY_VERSION,
    ...SourceCandidateContentSchema.parse(content),
  };
}

/**
 * Server-side canonicalization + signing with the gateway-held HMAC authority.
 * The secret never leaves this call; callers receive only the signed record.
 * The signature binds the canonical record hash, so any byte change breaks it.
 */
export function signSourceCandidate(content: SourceCandidateContent, secret: string, keyId: string): SignedSourceCandidate {
  if (!secret) throw new Error("source-candidate signing authority is unavailable");
  const canonical = canonicalContent(content);
  const recordHash = sha256(canonical);
  const recordId = sha256({ recordHash, keyId });
  const value = createHmac("sha256", secret).update(recordHash, "utf8").digest("hex");
  return {
    ...SourceCandidateContentSchema.parse(content),
    recordId,
    recordHash,
    schemaVersion: RESOLUTION_SOURCE_CANDIDATE_SCHEMA_VERSION,
    policyVersion: RESOLUTION_SOURCE_CANDIDATE_POLICY_VERSION,
    signature: { algorithm: RESOLUTION_SOURCE_CANDIDATE_SIGNATURE_ALGORITHM, keyId, value },
  };
}

export type SourceCandidateRejectReason =
  | "SIGNING_AUTHORITY_UNAVAILABLE"
  | "RECORD_TAMPERED"
  | "SIGNATURE_INVALID"
  | "SOURCE_RUN_MISSING"
  | "BASE_COMMIT_DRIFT"
  | "MANIFEST_DRIFT"
  | "BUILDER_DISPATCH_DRIFT"
  | "BUILDER_EXECUTION_DRIFT"
  | "OUTPUT_ARTIFACT_DRIFT"
  | "OUTPUT_BYTES_DRIFT"
  | "SEED_ARTIFACT_DRIFT"
  | "SEED_BYTES_DRIFT"
  | "EVENT_HEAD_DRIFT";

export type SourceCandidateVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: SourceCandidateRejectReason };

/** Reads the exact stored bytes for a content-addressed artifact reference. */
export interface ArtifactByteReader {
  read(input: { runId: string; artifactId: string; storageReference: string }): Uint8Array | null;
}

interface ArtifactRow { id: string; run_id: string; sha256: string; storage_reference: string }

/**
 * Re-verify a signed source candidate against the live source rows. Verifies the
 * gateway signature, then re-reads every referenced durable byte and rejects on
 * any drift. When an `ArtifactByteReader` is supplied, the output and seed
 * artifact bytes are re-hashed and compared to the recorded content address
 * (true byte re-read); without one, the durable content-address rows are the
 * re-read surface.
 *
 * Quiescence: the record pins the source `runEventHead`; any new source
 * `run_state_events` row since the snapshot changes the head and fails
 * `EVENT_HEAD_DRIFT`. Combined with the case's ledger-wide source freeze (no new
 * source event/dispatch/budget row can be written while a case is open), this
 * bounds concurrent source mutation. What remains for a later slice: proving
 * quiescence of *external* state the source touched (remote refs, provider-side
 * effects) — this verifier proves durable-row quiescence only.
 */
export function verifySourceCandidate(
  db: Database,
  signed: SignedSourceCandidate,
  secret: string,
  byteReader?: ArtifactByteReader,
): SourceCandidateVerdict {
  if (!secret) return { ok: false, reason: "SIGNING_AUTHORITY_UNAVAILABLE" };

  // 1. Signature + record integrity.
  let content: SourceCandidateContent;
  try {
    const { recordId: _id, recordHash: _hash, schemaVersion: _sv, policyVersion: _pv, signature: _sig, ...rest } = signed;
    content = SourceCandidateContentSchema.parse(rest);
  } catch {
    return { ok: false, reason: "RECORD_TAMPERED" };
  }
  const recomputedHash = sha256(canonicalContent(content));
  if (recomputedHash !== signed.recordHash) return { ok: false, reason: "RECORD_TAMPERED" };
  const expectedSignature = createHmac("sha256", secret).update(signed.recordHash, "utf8").digest("hex");
  if (!constantTimeEquals(expectedSignature, signed.signature.value)) return { ok: false, reason: "SIGNATURE_INVALID" };

  // 2. Source run + base.
  const run = db.query("SELECT id,base_commit_sha FROM engineer_runs WHERE id=?").get(content.sourceRunId) as { id: string; base_commit_sha: string } | null;
  if (!run) return { ok: false, reason: "SOURCE_RUN_MISSING" };
  if (run.base_commit_sha !== content.baseCommitSha) return { ok: false, reason: "BASE_COMMIT_DRIFT" };

  // 3. Manifest freeze.
  const manifest = db.query("SELECT manifest_hash FROM task_manifest_versions WHERE run_id=? AND manifest_hash=?")
    .get(content.sourceRunId, content.manifestHash) as { manifest_hash: string } | null;
  if (!manifest) return { ok: false, reason: "MANIFEST_DRIFT" };

  // 4. Builder dispatch identity.
  const dispatch = db.query("SELECT agent_execution_id,model_tier FROM builder_dispatch_claims WHERE run_id=? AND input_hash=?")
    .get(content.sourceRunId, content.builderDispatch.inputHash) as { agent_execution_id: string; model_tier: string } | null;
  if (!dispatch || dispatch.agent_execution_id !== content.builderDispatch.agentExecutionId || dispatch.model_tier !== content.builderDispatch.modelTier) {
    return { ok: false, reason: "BUILDER_DISPATCH_DRIFT" };
  }

  // 5. Builder execution + output artifact linkage.
  const execution = db.query("SELECT id,run_id,status,output_artifact_id FROM agent_executions WHERE id=?")
    .get(content.builderDispatch.agentExecutionId) as { id: string; run_id: string; status: string; output_artifact_id: string | null } | null;
  if (!execution || execution.run_id !== content.sourceRunId || execution.status !== content.output.executionStatus
    || execution.output_artifact_id !== content.output.artifactId) {
    return { ok: false, reason: "BUILDER_EXECUTION_DRIFT" };
  }

  // 6. Output + seed artifact content addresses (durable-row re-read), with an
  //    optional true byte re-read when a reader is supplied.
  const outputDrift = reReadArtifact(db, content.sourceRunId, content.output.artifactId, content.output.contentAddress, byteReader, "OUTPUT_ARTIFACT_DRIFT", "OUTPUT_BYTES_DRIFT");
  if (outputDrift) return outputDrift;
  const seedDrift = reReadArtifact(db, content.sourceRunId, content.seed.artifactId, content.seed.contentAddress, byteReader, "SEED_ARTIFACT_DRIFT", "SEED_BYTES_DRIFT");
  if (seedDrift) return seedDrift;

  // 7. Run event head (quiescence anchor).
  const head = db.query("SELECT event_id,sequence FROM run_state_events WHERE run_id=? ORDER BY sequence DESC LIMIT 1")
    .get(content.sourceRunId) as { event_id: string; sequence: number } | null;
  if (!head || head.sequence !== content.runEventHead.sequence || head.event_id !== content.runEventHead.eventId) {
    return { ok: false, reason: "EVENT_HEAD_DRIFT" };
  }

  return { ok: true };
}

function reReadArtifact(
  db: Database, runId: string, artifactId: string, contentAddress: string,
  byteReader: ArtifactByteReader | undefined,
  rowReason: SourceCandidateRejectReason, byteReason: SourceCandidateRejectReason,
): { ok: false; reason: SourceCandidateRejectReason } | null {
  const row = db.query("SELECT id,run_id,sha256,storage_reference FROM artifacts WHERE id=?").get(artifactId) as ArtifactRow | null;
  if (!row || row.run_id !== runId || row.sha256 !== contentAddress) return { ok: false, reason: rowReason };
  if (byteReader) {
    const bytes = byteReader.read({ runId, artifactId, storageReference: row.storage_reference });
    if (!bytes || sha256Bytes(bytes) !== contentAddress) return { ok: false, reason: byteReason };
  }
  return null;
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Deterministic digest of a signed record, for durable case binding. */
export function sourceCandidateDigest(signed: SignedSourceCandidate): `sha256:${string}` {
  return sha256({ recordId: signed.recordId, recordHash: signed.recordHash, signature: signed.signature.value });
}
