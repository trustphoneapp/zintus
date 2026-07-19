import { z } from "zod";
import { canonicalJson, sha256 } from "./hash.js";

/**
 * P11 tenant-scoped audit export (standalone, not yet wired into live paths).
 *
 * Produces a deterministic, paginated JSON export of a run's full
 * event/evidence/attestation chain. Each page carries its own checksum and the
 * whole export carries a page-size-independent content digest, so a consumer
 * can re-page freely and still bind to the same content.
 *
 * Redaction is mandatory and defense-in-depth: storage references are collapsed
 * to a reason marker, and secret/token-bearing keys plus any string that looks
 * like a local filesystem path are scrubbed regardless of where they appear in
 * a payload. The export can therefore NEVER carry raw secrets, tokens, or local
 * paths even if an upstream record smuggled one into an otherwise-innocent
 * field.
 */

export const AUDIT_EXPORT_SCHEMA_VERSION = 1 as const;
export const AUDIT_EXPORT_POLICY_VERSION = "engineer-audit-export-v1" as const;
export const REDACTED_STORAGE_REFERENCE = "[REDACTED:storage-reference]" as const;
export const REDACTED_SECRET = "[REDACTED:secret]" as const;
export const REDACTED_PATH = "[REDACTED:path]" as const;

const IdentifierSchema = z.string().min(1).max(500);
const TimestampSchema = z.string().datetime({ offset: true });

export const AuditEntrySchema = z.object({
  kind: z.enum(["EVENT", "EVIDENCE", "ATTESTATION"]),
  id: IdentifierSchema,
  sequence: z.number().int().nonnegative(),
  tenantId: IdentifierSchema,
  runId: IdentifierSchema,
  recordedAt: TimestampSchema,
  payload: z.record(z.unknown()),
}).strict();

export type AuditEntry = z.infer<typeof AuditEntrySchema>;

export interface AuditExportRequest {
  tenantId: string;
  runId: string;
  entries: readonly AuditEntry[];
  pageSize: number;
}

export interface AuditExportPage {
  pageNumber: number;
  pageCount: number;
  entryOffset: number;
  entries: AuditEntry[];
  pageChecksum: `sha256:${string}`;
  previousPageChecksum: `sha256:${string}` | null;
}

export interface AuditExport {
  schemaVersion: typeof AUDIT_EXPORT_SCHEMA_VERSION;
  policyVersion: typeof AUDIT_EXPORT_POLICY_VERSION;
  tenantId: string;
  runId: string;
  entryCount: number;
  pageSize: number;
  pageCount: number;
  /** Digest over the ordered redacted entries. Independent of pageSize. */
  contentDigest: `sha256:${string}`;
  pages: AuditExportPage[];
}

// Keys whose values are structurally sensitive and are never exportable.
const FORBIDDEN_SECRET_KEYS = new Set([
  "secret", "secrets", "token", "tokens", "apikey", "api_key", "accesskey", "access_key",
  "password", "passphrase", "privatekey", "private_key", "authorization", "bearer", "cookie",
  "clientsecret", "client_secret", "sessiontoken", "session_token", "credential", "credentials",
]);
// Keys that name a storage/blob/filesystem location.
const STORAGE_REFERENCE_KEYS = new Set([
  "storagereference", "storage_reference", "storageref", "localpath", "local_path",
  "filepath", "file_path", "absolutepath", "absolute_path", "diskpath", "disk_path",
]);

// Absolute POSIX/Windows path detection and common token shapes.
const POSIX_PATH = /(?:^|\s)\/(?:Users|home|var|tmp|private|etc|opt|root|mnt|srv|data)\/[^\s"']*/;
const WINDOWS_PATH = /[A-Za-z]:\\[^\s"']+/;
const FILE_URI = /file:\/\/\/[^\s"']*/i;
const TOKEN_SHAPE = /\b(?:sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/;

function scrubString(value: string): string {
  if (POSIX_PATH.test(value) || WINDOWS_PATH.test(value) || FILE_URI.test(value)) return REDACTED_PATH;
  if (TOKEN_SHAPE.test(value)) return REDACTED_SECRET;
  return value;
}

function redactValue(value: unknown): unknown {
  if (typeof value === "string") return scrubString(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record)) {
      const lower = key.toLowerCase();
      if (STORAGE_REFERENCE_KEYS.has(lower)) {
        out[key] = REDACTED_STORAGE_REFERENCE;
        continue;
      }
      if (FORBIDDEN_SECRET_KEYS.has(lower)) {
        out[key] = REDACTED_SECRET;
        continue;
      }
      out[key] = redactValue(record[key]);
    }
    return out;
  }
  return value;
}

function redactEntry(entry: AuditEntry): AuditEntry {
  return {
    kind: entry.kind,
    id: entry.id,
    sequence: entry.sequence,
    tenantId: entry.tenantId,
    runId: entry.runId,
    recordedAt: entry.recordedAt,
    payload: redactValue(entry.payload) as Record<string, unknown>,
  };
}

/**
 * Build a deterministic tenant-scoped audit export. Throws if any entry escapes
 * the requested tenant/run scope -- a cross-tenant leak is a hard failure, not a
 * silently-dropped row.
 */
export function exportAuditChain(request: AuditExportRequest): AuditExport {
  if (!Number.isInteger(request.pageSize) || request.pageSize < 1) {
    throw new Error("audit export pageSize must be a positive integer");
  }
  for (const entry of request.entries) {
    AuditEntrySchema.parse(entry);
    if (entry.tenantId !== request.tenantId) {
      throw new Error(`audit export tenant scope violation: entry ${entry.id} belongs to a different tenant`);
    }
    if (entry.runId !== request.runId) {
      throw new Error(`audit export run scope violation: entry ${entry.id} belongs to a different run`);
    }
  }

  // Stable order: (sequence, id). Duplicate (sequence,id) pairs are rejected so
  // the ordering -- and therefore every checksum -- is total and unambiguous.
  const ordered = [...request.entries].sort((left, right) =>
    left.sequence !== right.sequence
      ? left.sequence - right.sequence
      : left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1]!;
    const current = ordered[index]!;
    if (previous.sequence === current.sequence && previous.id === current.id) {
      throw new Error(`audit export contains a duplicate entry key: ${current.sequence}/${current.id}`);
    }
  }

  const redacted = ordered.map(redactEntry);
  const contentDigest = sha256(redacted);

  const pageCount = Math.max(1, Math.ceil(redacted.length / request.pageSize));
  const pages: AuditExportPage[] = [];
  let previousPageChecksum: `sha256:${string}` | null = null;
  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    const offset = (pageNumber - 1) * request.pageSize;
    const pageEntries = redacted.slice(offset, offset + request.pageSize);
    const pageChecksum = sha256({
      schemaVersion: AUDIT_EXPORT_SCHEMA_VERSION,
      tenantId: request.tenantId,
      runId: request.runId,
      pageNumber,
      entryOffset: offset,
      entries: pageEntries,
    });
    pages.push({
      pageNumber,
      pageCount,
      entryOffset: offset,
      entries: pageEntries,
      pageChecksum,
      previousPageChecksum,
    });
    previousPageChecksum = pageChecksum;
  }

  return {
    schemaVersion: AUDIT_EXPORT_SCHEMA_VERSION,
    policyVersion: AUDIT_EXPORT_POLICY_VERSION,
    tenantId: request.tenantId,
    runId: request.runId,
    entryCount: redacted.length,
    pageSize: request.pageSize,
    pageCount,
    contentDigest,
    pages,
  };
}

/** Canonical serialization of a full export, for durable/transport bytes. */
export function serializeAuditExport(auditExport: AuditExport): string {
  return canonicalJson(auditExport);
}
