import { createHash } from "node:crypto";
import { FailureRecordSchema, type FailureRecord } from "./control-contracts.js";
import { sha256 } from "./hash.js";

export const HARDENING_DATABASE_INTEGRITY_GUIDANCE =
  "DATABASE_INTEGRITY_CORRUPTION: Durable Engineer paid-call/database authority failed integrity verification. Automatic recovery is stopped. Restore the Engineer database and artifact store from the same backup, then run `bun run doctor:engineer` before resuming.";
export const HARDENING_DATABASE_INTEGRITY_MARKER_CONFLICT_GUIDANCE =
  "DATABASE_INTEGRITY_FATAL_MARKER_CONFLICT: The canonical recovery-stop marker ID is occupied by different durable data. Automatic recovery is stopped. Restore the Engineer database from a trusted backup, then run `bun run doctor:engineer` before resuming.";
export const HARDENING_DATABASE_INTEGRITY_MARKER_AUTHORITY_INVALID_GUIDANCE =
  "DATABASE_INTEGRITY_FATAL_MARKER_CONFLICT_AUTHORITY_INVALID: Both deterministic recovery-stop marker IDs are occupied by non-canonical data. Automatic recovery is stopped. Restore the Engineer database from a trusted backup, then run `bun run doctor:engineer` before resuming.";

export function hardeningDatabaseIntegrityFailureId(runId: string): string {
  return `hardening-db-integrity-${createHash("sha256").update(runId).digest("hex")}`;
}

export function hardeningDatabaseIntegrityFingerprint(runId: string): string {
  return sha256({ namespace: "engineer-hardening-database-integrity-fatal-v1", runId });
}

export function hardeningDatabaseIntegrityConflictFailureId(runId:string):string{
  const canonicalId=hardeningDatabaseIntegrityFailureId(runId);
  return `hardening-db-integrity-conflict-${sha256({namespace:"engineer-hardening-database-integrity-fatal-marker-conflict-id-v1",
    runId,canonicalId}).slice("sha256:".length)}`;
}

export function canonicalHardeningDatabaseIntegrityFailure(input: {
  runId: string;
  runCreatedAt: string;
}): FailureRecord {
  return FailureRecordSchema.parse({
    failureId: hardeningDatabaseIntegrityFailureId(input.runId),
    runId: input.runId,
    failureClass: "WORKFLOW_FAILURE",
    reasonCode: "DATABASE_INTEGRITY_CORRUPTION",
    fingerprint: hardeningDatabaseIntegrityFingerprint(input.runId),
    evidenceIds: [],
    retryable: false,
    createdAt: input.runCreatedAt,
  });
}

export function canonicalHardeningDatabaseIntegrityConflictFailure(input:{runId:string;runCreatedAt:string}):FailureRecord{
  const canonicalId=hardeningDatabaseIntegrityFailureId(input.runId);
  return FailureRecordSchema.parse({
    failureId:hardeningDatabaseIntegrityConflictFailureId(input.runId),runId:input.runId,
    failureClass:"WORKFLOW_FAILURE",reasonCode:"DATABASE_INTEGRITY_FATAL_MARKER_CONFLICT",
    fingerprint:sha256({namespace:"engineer-hardening-database-integrity-fatal-marker-conflict-v1",
      runId:input.runId,canonicalId}),evidenceIds:[canonicalId],retryable:false,createdAt:input.runCreatedAt,
  });
}
