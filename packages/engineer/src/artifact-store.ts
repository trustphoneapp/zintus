import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, openSync, closeSync, readFileSync, readSync, readdirSync, statSync, fstatSync, lstatSync, unlinkSync, writeFileSync, createReadStream } from "node:fs";
import { join, resolve, sep } from "node:path";
import { ArtifactRecordSchema, type ArtifactRecord } from "./execution-contracts.js";
import { matchesSha256Bytes, sha256Bytes } from "./hash.js";
import { DEFAULT_RUN_ARTIFACT_BUDGET_BYTES } from "./runtime-budget.js";

export const DEFAULT_MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
export const DEFAULT_MAX_RUN_ARTIFACT_BYTES = DEFAULT_RUN_ARTIFACT_BUDGET_BYTES;

function safeIdentifier(value: string, label: string): string {
  if (!/^[A-Za-z0-9._-]{1,200}$/.test(value)) throw new TypeError(`${label} contains unsafe characters`);
  return value;
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) {
    throw new Error("artifact storage must be an owner-controlled regular directory");
  }
  chmodSync(path, 0o700);
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
    ensurePrivateDirectory(this.root);
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
    const digest = sha256Bytes(bytes);
    const hex = digest.slice("sha256:".length);
    const runRoot = join(this.root, runId);
    ensurePrivateDirectory(runRoot);
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
      if (!matchesSha256Bytes(existing, digest)) throw new Error("content-addressed artifact collision or tampering detected");
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
    const { parsed, path } = this.resolveRecord(record);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) {
      throw new Error(`artifact storage is not an owner-controlled regular file: ${parsed.artifactId}`);
    }
    const bytes = readFileSync(path);
    if (bytes.byteLength !== parsed.sizeBytes || !matchesSha256Bytes(bytes, parsed.sha256)) {
      throw new Error(`artifact integrity check failed: ${parsed.artifactId}`);
    }
    return bytes;
  }

  /** Verifies the complete artifact while retaining only a bounded prefix. */
  readVerifiedPrefix(record: ArtifactRecord, maximumBytes: number): { bytes: Buffer; totalBytes: number } {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0 || maximumBytes > DEFAULT_MAX_ARTIFACT_BYTES) {
      throw new TypeError("artifact prefix limit is invalid");
    }
    const { parsed, path } = this.resolveRecord(record);
    const fd = openSync(path, "r");
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || (process.getuid && stat.uid !== process.getuid())) {
        throw new Error(`artifact storage is not an owner-controlled regular file: ${parsed.artifactId}`);
      }
      const hash = createHash("sha256");
      const prefix = Buffer.allocUnsafe(Math.min(maximumBytes, parsed.sizeBytes));
      const chunk = Buffer.allocUnsafe(64 * 1024);
      let offset = 0;
      let prefixOffset = 0;
      while (true) {
        const read = readSync(fd, chunk, 0, chunk.byteLength, offset);
        if (read === 0) break;
        hash.update(chunk.subarray(0, read));
        if (prefixOffset < prefix.byteLength) {
          const copied = Math.min(read, prefix.byteLength - prefixOffset);
          chunk.copy(prefix, prefixOffset, 0, copied);
          prefixOffset += copied;
        }
        offset += read;
      }
      const digest = `sha256:${hash.digest("hex")}`;
      if (offset !== parsed.sizeBytes || digest !== parsed.sha256) {
        throw new Error(`artifact integrity check failed: ${parsed.artifactId}`);
      }
      return { bytes: prefix.subarray(0, prefixOffset), totalBytes: offset };
    } finally {
      closeSync(fd);
    }
  }

  /**
   * Two-pass bounded-memory reader. The first pass verifies immutable bytes;
   * the second yields small chunks so HTTP backpressure controls allocation.
   */
  async *verifiedChunks(record: ArtifactRecord, chunkBytes = 48 * 1024): AsyncGenerator<Buffer> {
    if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 3 || chunkBytes > 1024 * 1024 || chunkBytes % 3 !== 0) {
      throw new TypeError("artifact stream chunk size must be a multiple of three between 3 bytes and 1 MiB");
    }
    const { parsed, path } = this.resolveRecord(record);
    const verifyHash = createHash("sha256");
    let verifiedBytes = 0;
    for await (const value of createReadStream(path, { highWaterMark: chunkBytes })) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      verifyHash.update(chunk);
      verifiedBytes += chunk.byteLength;
    }
    if (verifiedBytes !== parsed.sizeBytes || `sha256:${verifyHash.digest("hex")}` !== parsed.sha256) {
      throw new Error(`artifact integrity check failed: ${parsed.artifactId}`);
    }
    const emittedHash = createHash("sha256");
    let emittedBytes = 0;
    for await (const value of createReadStream(path, { highWaterMark: chunkBytes })) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      emittedHash.update(chunk);
      emittedBytes += chunk.byteLength;
      yield chunk;
    }
    if (emittedBytes !== parsed.sizeBytes || `sha256:${emittedHash.digest("hex")}` !== parsed.sha256) {
      throw new Error(`artifact changed while streaming: ${parsed.artifactId}`);
    }
  }

  private resolveRecord(record: ArtifactRecord): { parsed: ArtifactRecord; path: string } {
    const parsed = ArtifactRecordSchema.parse(record);
    const expectedRoot = join(this.root, safeIdentifier(parsed.runId, "runId"));
    const path = resolve(parsed.storageReference);
    if (!path.startsWith(`${expectedRoot}${sep}`)) throw new Error("artifact reference escaped its run root");
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) {
      throw new Error(`artifact storage is not an owner-controlled regular file: ${parsed.artifactId}`);
    }
    return { parsed, path };
  }
}
