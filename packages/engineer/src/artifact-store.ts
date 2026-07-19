import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, openSync, closeSync, readFileSync, readSync, readdirSync, statSync, fstatSync, lstatSync, unlinkSync, writeFileSync, createReadStream, realpathSync, constants } from "node:fs";
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
  /** Deterministic adversarial seam; never configured by production wiring. */
  afterStrictReadStageForTest?:(stage:"ROOT_OPENED"|"RUN_OPENED"|"LEAF_VALIDATED"|"ARTIFACT_OPENED")=>void;
}

/** Content-addressed local storage. Bytes are immutable and verified again on read. */
export class LocalArtifactStore {
  private readonly root: string;
  private readonly rootIdentity: { dev: number; ino: number; uid: number };
  private readonly maxArtifactBytes: number;
  private readonly maxRunArtifactBytes: number;
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly afterStrictReadStageForTest:ArtifactStoreOptions["afterStrictReadStageForTest"];

  constructor(options: ArtifactStoreOptions) {
    const requestedRoot=resolve(options.root);
    this.maxArtifactBytes = options.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
    this.maxRunArtifactBytes = Math.min(
      options.maxRunArtifactBytes ?? DEFAULT_MAX_RUN_ARTIFACT_BYTES,
      DEFAULT_MAX_RUN_ARTIFACT_BYTES,
    );
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.afterStrictReadStageForTest=options.afterStrictReadStageForTest;
    ensurePrivateDirectory(requestedRoot);
    // Ancestor aliases such as macOS /var -> /private/var are legitimate at
    // admission. All durable paths are minted from the one canonical root.
    this.root=realpathSync(requestedRoot);
    const rootStat=lstatSync(this.root);
    this.rootIdentity={dev:rootStat.dev,ino:rootStat.ino,uid:rootStat.uid};
  }

  put(input: {
    runId: string;
    type: string;
    bytes: string | Uint8Array;
    producerType: "EXECUTOR" | "SYSTEM";
    producerId: string;
    trusted: boolean;
    createdAt?: string;
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
      createdAt: input.createdAt ?? this.now().toISOString(),
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

  /** Strict trust-boundary read: no legacy canonical-object hash fallback. */
  readVerifiedExact(record:ArtifactRecord):Buffer{
    const parsed=ArtifactRecordSchema.parse(record),runRoot=join(this.root,safeIdentifier(parsed.runId,"runId")),
      digestName=parsed.sha256.slice("sha256:".length),path=join(runRoot,digestName);
    if(resolve(parsed.storageReference)!==path)
      throw new Error("strict artifact reference is not its exact content-addressed run path");
    let rootFd:number|null=null,runFd:number|null=null,artifactFd:number|null=null;
    try{
      const rootBefore=this.assertStrictDirectory(this.root,this.rootIdentity,"artifact root");
      rootFd=openSync(this.root,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
      this.assertSameIdentity(fstatSync(rootFd),rootBefore,"artifact root changed during strict read");
      this.afterStrictReadStageForTest?.("ROOT_OPENED");
      const runBefore=this.assertStrictDirectory(runRoot,undefined,"artifact run directory");
      runFd=openSync(runRoot,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
      this.assertSameIdentity(fstatSync(runFd),runBefore,"artifact run directory changed during strict read");
      this.afterStrictReadStageForTest?.("RUN_OPENED");
      const leafBefore=lstatSync(path);
      if(!leafBefore.isFile()||leafBefore.isSymbolicLink()||(process.getuid&&leafBefore.uid!==process.getuid()))
        throw new Error(`artifact storage is not an owner-controlled regular file: ${parsed.artifactId}`);
      this.afterStrictReadStageForTest?.("LEAF_VALIDATED");
      artifactFd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
      const opened=fstatSync(artifactFd);
      if(!opened.isFile()||(process.getuid&&opened.uid!==process.getuid()))
        throw new Error(`artifact storage is not an owner-controlled regular file: ${parsed.artifactId}`);
      this.assertSameIdentity(opened,leafBefore,"artifact changed while opening strict read");
      this.afterStrictReadStageForTest?.("ARTIFACT_OPENED");
      const bytes=readFileSync(artifactFd),afterRead=fstatSync(artifactFd);
      this.assertSameIdentity(afterRead,opened,"artifact changed during strict read");
      if(bytes.byteLength!==parsed.sizeBytes||afterRead.size!==parsed.sizeBytes||sha256Bytes(bytes)!==parsed.sha256)
        throw new Error(`artifact exact-byte integrity check failed: ${parsed.artifactId}`);
      const rootAfter=this.assertStrictDirectory(this.root,this.rootIdentity,"artifact root"),
        runAfter=this.assertStrictDirectory(runRoot,runBefore,"artifact run directory"),leafAfter=lstatSync(path);
      this.assertSameIdentity(rootAfter,rootBefore,"artifact root changed during strict read");
      this.assertSameIdentity(runAfter,runBefore,"artifact run directory changed during strict read");
      this.assertSameIdentity(fstatSync(rootFd),rootBefore,"artifact root descriptor changed during strict read");
      this.assertSameIdentity(fstatSync(runFd),runBefore,"artifact run descriptor changed during strict read");
      this.assertSameIdentity(leafAfter,opened,"artifact path changed during strict read");
      if(!leafAfter.isFile()||leafAfter.isSymbolicLink())throw new Error("artifact path changed during strict read");
      return bytes;
    }catch(error){
      if(error instanceof Error&&error.message.includes(parsed.artifactId))throw error;
      throw new Error(`artifact strict path integrity check failed: ${parsed.artifactId}`,{cause:error});
    }finally{
      if(artifactFd!==null)try{closeSync(artifactFd);}catch{/* best effort */}
      if(runFd!==null)try{closeSync(runFd);}catch{/* best effort */}
      if(rootFd!==null)try{closeSync(rootFd);}catch{/* best effort */}
    }
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

  private assertStrictDirectory(path:string,expected:{dev:number;ino:number;uid?:number}|undefined,label:string){
    const stat=lstatSync(path);
    if(!stat.isDirectory()||stat.isSymbolicLink()||(process.getuid&&stat.uid!==process.getuid())||realpathSync(path)!==path)
      throw new Error(`${label} is not an owner-controlled canonical directory`);
    if(expected)this.assertSameIdentity(stat,expected,`${label} identity changed`);
    return stat;
  }

  private assertSameIdentity(actual:{dev:number;ino:number;uid?:number},expected:{dev:number;ino:number;uid?:number},message:string):void{
    if(actual.dev!==expected.dev||actual.ino!==expected.ino||
      (expected.uid!==undefined&&actual.uid!==expected.uid))throw new Error(message);
  }
}
