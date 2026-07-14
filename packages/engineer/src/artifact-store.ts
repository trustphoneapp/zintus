import { randomUUID } from "node:crypto";
import { mkdirSync, openSync, closeSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { ArtifactRecordSchema, type ArtifactRecord } from "./execution-contracts.js";
import { sha256 } from "./hash.js";
import { DEFAULT_RUN_ARTIFACT_BUDGET_BYTES } from "./runtime-budget.js";

export const DEFAULT_MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
export const DEFAULT_MAX_RUN_ARTIFACT_BYTES = DEFAULT_RUN_ARTIFACT_BUDGET_BYTES;

function safeIdentifier(value: string, label: string): string {
  if (!/^[A-Za-z0-9._-]{1,200}$/.test(value)) throw new TypeError(`${label} contains unsafe characters`);
  return value;
}

export interface ArtifactStoreOptions {
  root: string;
  maxArtifactBytes?: number;
  maxRunArtifactBytes?: number;
  now?: () => Date;
  idFactory?: () => string;
}

/** Content-addressed local storage. Bytes are immutable and verified again on read. */
export class LocalArtifactStore {
  private readonly root: string;
  private readonly maxArtifactBytes: number;
  private readonly maxRunArtifactBytes: number;
  private readonly now: () => Date;
  private readonly idFactory: () => string;

  constructor(options: ArtifactStoreOptions) {
    this.root = resolve(options.root);
    this.maxArtifactBytes = options.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
    this.maxRunArtifactBytes = Math.min(
      options.maxRunArtifactBytes ?? DEFAULT_MAX_RUN_ARTIFACT_BYTES,
      DEFAULT_MAX_RUN_ARTIFACT_BYTES,
    );
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }

  put(input: {
    runId: string;
    type: string;
    bytes: string | Uint8Array;
    producerType: "EXECUTOR" | "SYSTEM";
    producerId: string;
    trusted: boolean;
  }): ArtifactRecord {
    const runId = safeIdentifier(input.runId, "runId");
    const bytes = typeof input.bytes === "string" ? Buffer.from(input.bytes) : Buffer.from(input.bytes);
    if (bytes.byteLength > this.maxArtifactBytes) {
      throw new RangeError(`artifact exceeds ${this.maxArtifactBytes} byte limit`);
    }
    const digest = sha256(bytes);
    const hex = digest.slice("sha256:".length);
    const runRoot = join(this.root, runId);
    mkdirSync(runRoot, { recursive: true, mode: 0o700 });
    const storageReference = join(runRoot, hex);
    const resolved = resolve(storageReference);
    if (!resolved.startsWith(`${runRoot}${sep}`)) throw new TypeError("artifact path escaped run root");
    const entries = readdirSync(runRoot, { withFileTypes: true });
    const existingRunBytes = entries.reduce((total, entry) =>
      entry.isFile() ? total + statSync(join(runRoot, entry.name)).size : total, 0);
    if (!entries.some((entry) => entry.name === hex) && existingRunBytes + bytes.byteLength >= this.maxRunArtifactBytes) {
      throw new RangeError(`run artifacts exceed ${this.maxRunArtifactBytes} byte limit`);
    }

    let fd: number | null = null;
    try {
      fd = openSync(storageReference, "wx", 0o600);
      writeFileSync(fd, bytes);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        if (fd !== null) {
          try { closeSync(fd); } catch { /* best effort */ }
          fd = null;
        }
        try { unlinkSync(storageReference); } catch { /* best effort */ }
        throw error;
      }
      const existing = readFileSync(storageReference);
      if (sha256(existing) !== digest) throw new Error("content-addressed artifact collision or tampering detected");
    } finally {
      if (fd !== null) closeSync(fd);
    }

    return ArtifactRecordSchema.parse({
      artifactId: this.idFactory(),
      runId,
      type: input.type,
      sha256: digest,
      producerType: input.producerType,
      producerId: input.producerId,
      storageReference,
      sizeBytes: bytes.byteLength,
      trusted: input.trusted,
      createdAt: this.now().toISOString(),
    });
  }

  read(record: ArtifactRecord): Buffer {
    const parsed = ArtifactRecordSchema.parse(record);
    const expectedRoot = join(this.root, safeIdentifier(parsed.runId, "runId"));
    const path = resolve(parsed.storageReference);
    if (!path.startsWith(`${expectedRoot}${sep}`)) throw new Error("artifact reference escaped its run root");
    const bytes = readFileSync(path);
    if (bytes.byteLength !== parsed.sizeBytes || sha256(bytes) !== parsed.sha256) {
      throw new Error(`artifact integrity check failed: ${parsed.artifactId}`);
    }
    return bytes;
  }
}
