import crypto from "node:crypto";
import { type Dirent, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { load as loadSqliteVec } from "sqlite-vec";
import { embedBatch } from "@zintus/memory";
import { chunkSource } from "./chunker.js";
import { detectLang, isSourceFile } from "./lang.js";

const DEFAULT_DB_PATH = join(homedir(), ".zintus", "code.db");

/** Directories that are never walked. */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
  "coverage",
  ".vscode",
  ".idea",
]);

/** Files larger than this are skipped (likely generated / not useful). */
const MAX_FILE_BYTES = 512 * 1024;
/** Embedding batch size to bound memory and request payloads. */
const EMBED_BATCH_SIZE = 64;

export interface CodeChunkHit {
  path: string;
  startLine: number;
  endLine: number;
  content: string;
  score: number;
}

export interface CodeIndexOptions {
  /** Filesystem path to the sqlite database. */
  dbPath?: string;
  /**
   * Optional embedding function. When omitted, falls back to the repo's
   * @zintus/memory embedBatch (local Ollama nomic-embed-text with a
   * deterministic offline fallback, so it works with NO Ollama running).
   */
  embed?: (texts: string[]) => Promise<number[][]>;
}

interface FileRow {
  path: string;
  sha256: string;
  mtime: number;
}

export class CodeIndex {
  private readonly sqlite: Database;
  private readonly embed: (texts: string[]) => Promise<number[][]>;
  private sqliteVecAvailable = false;
  private sqliteVecDimensions: number | null = null;

  /**
   * Whether the sqlite-vec extension actually loaded. False on SQLite builds
   * without dynamic-extension support (e.g. Bun's bundled sqlite3), where
   * search still works via the linear-scan fallback.
   */
  get vectorIndexAvailable(): boolean {
    return this.sqliteVecAvailable;
  }

  constructor(opts: CodeIndexOptions = {}) {
    const dbPath = opts.dbPath ?? DEFAULT_DB_PATH;
    this.embed = opts.embed ?? ((texts) => embedBatch(texts));
    mkdirSync(dirname(dbPath), { recursive: true });
    const sqlite = new Database(dbPath, { create: true });
    this.sqlite = sqlite;
    this.tryLoadSqliteVec();
    this.init();
  }

  private tryLoadSqliteVec(): void {
    try {
      loadSqliteVec(this.sqlite);
      this.sqliteVecAvailable = true;
    } catch {
      this.sqliteVecAvailable = false;
    }
  }

  private init(): void {
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS code_files (
        path TEXT PRIMARY KEY,
        sha256 TEXT NOT NULL,
        lang TEXT NOT NULL,
        mtime INTEGER NOT NULL,
        indexed_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS code_chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        content TEXT NOT NULL,
        embedding BLOB
      );
      CREATE INDEX IF NOT EXISTS idx_code_chunks_path ON code_chunks(path);
      CREATE TABLE IF NOT EXISTS code_chunk_vectors_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS code_chunk_vector_map (
        rowid INTEGER PRIMARY KEY AUTOINCREMENT,
        chunk_id INTEGER NOT NULL UNIQUE
      );
    `);
    this.restoreVectorTable();
  }

  // --- sqlite-vec lifecycle (mirrors packages/cache/src/cache.ts) ---------

  private restoreVectorTable(): void {
    if (!this.sqliteVecAvailable) {
      return;
    }
    // Best-effort: a vec0 operation can throw on some platforms/SQLite builds
    // (e.g. headless Linux CI). The index works without the indexed path, so a
    // failure here must never crash the constructor — just disable the indexed path.
    try {
      const row = this.sqlite
        .query(
          "SELECT value FROM code_chunk_vectors_meta WHERE key = 'dimensions' LIMIT 1",
        )
        .get() as { value: string } | null;
      if (!row) {
        return;
      }
      const dimensions = Number.parseInt(row.value, 10);
      if (!Number.isFinite(dimensions) || dimensions <= 0) {
        return;
      }
      if (this.ensureVectorTable(dimensions)) {
        this.backfillVectorTable(dimensions);
      }
    } catch {
      this.sqliteVecAvailable = false;
    }
  }

  private ensureVectorTable(dimensions: number): boolean {
    if (!this.sqliteVecAvailable || dimensions <= 0) {
      return false;
    }
    if (this.sqliteVecDimensions !== null) {
      return this.sqliteVecDimensions === dimensions;
    }
    try {
      this.sqlite.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS code_chunk_vectors USING vec0(embedding float[${dimensions}])`,
      );
      this.sqlite
        .query(
          "INSERT INTO code_chunk_vectors_meta(key, value) VALUES ('dimensions', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .run(String(dimensions));
      this.sqliteVecDimensions = dimensions;
      return true;
    } catch {
      this.sqliteVecAvailable = false;
      return false;
    }
  }

  private backfillVectorTable(dimensions: number): void {
    if (!this.sqliteVecAvailable || this.sqliteVecDimensions !== dimensions) {
      return;
    }
    try {
      const rows = this.sqlite
        .query("SELECT id, embedding FROM code_chunks")
        .all() as Array<{ id: number; embedding: Uint8Array | null }>;
      // vec0 does not honor INSERT OR REPLACE on the rowid PK (it raises a UNIQUE
      // constraint on some builds, e.g. Linux CI). DELETE-then-INSERT is the
      // supported upsert idiom for a vec0 row by rowid.
      const del = this.sqlite.query(
        "DELETE FROM code_chunk_vectors WHERE rowid = ?",
      );
      const statement = this.sqlite.query(
        "INSERT INTO code_chunk_vectors(rowid, embedding) VALUES (?, ?)",
      );
      for (const row of rows) {
        const embedding = decodeEmbedding(row.embedding);
        if (!embedding || embedding.length !== dimensions) {
          continue;
        }
        const rowId = this.resolveVectorRowId(row.id);
        del.run(rowId);
        statement.run(rowId, JSON.stringify(embedding));
      }
    } catch {
      // Indexed vec0 path unavailable on this platform — fall back to scan.
      this.sqliteVecAvailable = false;
    }
  }

  /**
   * Resolve (creating if needed) the stable integer rowid for a chunk id.
   * The mapping lives in code_chunk_vector_map. This mirrors cache.ts: it
   * avoids hashing ids to 32-bit integers (collision-prone) and avoids any
   * unregistered SQL function inside the vec0 search join.
   */
  private resolveVectorRowId(chunkId: number): number {
    const existing = this.sqlite
      .query("SELECT rowid FROM code_chunk_vector_map WHERE chunk_id = ? LIMIT 1")
      .get(chunkId) as { rowid: number } | null;
    if (existing) {
      return existing.rowid;
    }
    this.sqlite
      .query("INSERT INTO code_chunk_vector_map(chunk_id) VALUES (?)")
      .run(chunkId);
    const inserted = this.sqlite
      .query("SELECT rowid FROM code_chunk_vector_map WHERE chunk_id = ? LIMIT 1")
      .get(chunkId) as { rowid: number };
    return inserted.rowid;
  }

  private indexChunkEmbedding(chunkId: number, embedding: number[]): void {
    if (!embedding.length || !this.ensureVectorTable(embedding.length)) {
      return;
    }
    try {
      const rowId = this.resolveVectorRowId(chunkId);
      // vec0 does not honor INSERT OR REPLACE on the rowid PK (UNIQUE constraint
      // on some builds, e.g. Linux CI) — DELETE-then-INSERT is the supported
      // upsert idiom for a vec0 row by rowid.
      this.sqlite
        .query("DELETE FROM code_chunk_vectors WHERE rowid = ?")
        .run(rowId);
      this.sqlite
        .query("INSERT INTO code_chunk_vectors(rowid, embedding) VALUES (?, ?)")
        .run(rowId, JSON.stringify(embedding));
    } catch {
      this.sqliteVecAvailable = false;
    }
  }

  // --- public API ---------------------------------------------------------

  /**
   * Walk rootDir, skip node_modules/.git/dist/build/.next and binary/large
   * files, chunk each source file, embed and store. Idempotent: a file whose
   * sha256 AND mtime are unchanged since the last index is skipped.
   */
  async indexWorkspace(
    rootDir: string,
  ): Promise<{ filesIndexed: number; chunksIndexed: number; skipped: number }> {
    let filesIndexed = 0;
    let chunksIndexed = 0;
    let skipped = 0;

    for (const filePath of walk(rootDir)) {
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(filePath);
      } catch {
        skipped += 1;
        continue;
      }
      if (stat.size > MAX_FILE_BYTES) {
        skipped += 1;
        continue;
      }

      let content: string;
      try {
        content = readFileSync(filePath, "utf8");
      } catch {
        skipped += 1;
        continue;
      }
      if (looksBinary(content)) {
        skipped += 1;
        continue;
      }

      const mtime = Math.floor(stat.mtimeMs);
      const hash = sha256(content);
      const existing = this.getFileRow(filePath);
      if (existing && existing.sha256 === hash && existing.mtime === mtime) {
        // Unchanged since last index -> idempotent skip.
        skipped += 1;
        continue;
      }

      const chunks = chunkSource(content);
      if (chunks.length === 0) {
        skipped += 1;
        continue;
      }

      // Replace any previous chunks for this file before re-inserting.
      this.deleteChunksForFile(filePath);

      // Embed in batches so payloads stay bounded.
      const embeddings: number[][] = [];
      for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
        const batch = chunks.slice(i, i + EMBED_BATCH_SIZE);
        const vectors = await this.embed(batch.map((c) => c.content));
        for (let j = 0; j < batch.length; j += 1) {
          embeddings.push(vectors[j] ?? []);
        }
      }

      const insertChunk = this.sqlite.query(
        "INSERT INTO code_chunks(path, start_line, end_line, content, embedding) VALUES (?, ?, ?, ?, ?)",
      );
      for (let i = 0; i < chunks.length; i += 1) {
        const chunk = chunks[i];
        if (!chunk) {
          continue;
        }
        const embedding = embeddings[i] ?? [];
        insertChunk.run(
          filePath,
          chunk.startLine,
          chunk.endLine,
          chunk.content,
          encodeEmbedding(embedding),
        );
        const inserted = this.sqlite
          .query("SELECT last_insert_rowid() AS id")
          .get() as { id: number };
        if (embedding.length) {
          this.indexChunkEmbedding(inserted.id, embedding);
        }
        chunksIndexed += 1;
      }

      this.upsertFileRow(filePath, hash, detectLang(filePath), mtime);
      filesIndexed += 1;
    }

    return { filesIndexed, chunksIndexed, skipped };
  }

  /** Top-k most relevant chunks for a natural-language or code query. */
  async searchCode(query: string, topK = 8): Promise<CodeChunkHit[]> {
    const [queryEmbedding] = await this.embed([query]);
    if (!queryEmbedding || !queryEmbedding.length) {
      return [];
    }

    const vecHits = this.searchWithSqliteVec(queryEmbedding, topK);
    if (vecHits) {
      return vecHits;
    }

    // Linear-scan fallback (sqlite-vec unavailable, e.g. Bun bundled sqlite).
    const rows = this.sqlite
      .query("SELECT path, start_line, end_line, content, embedding FROM code_chunks")
      .all() as Array<{
        path: string;
        start_line: number;
        end_line: number;
        content: string;
        embedding: Uint8Array | null;
      }>;

    const scored: CodeChunkHit[] = [];
    for (const row of rows) {
      const embedding = decodeEmbedding(row.embedding);
      if (!embedding) {
        continue;
      }
      scored.push({
        path: row.path,
        startLine: row.start_line,
        endLine: row.end_line,
        content: row.content,
        score: cosineSimilarity(queryEmbedding, embedding),
      });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  /**
   * Return every stored chunk (path + 1-based inclusive line range + content),
   * UNRANKED and without embeddings. Intended for callers that do their own
   * ranking — e.g. a key-free lexical fallback — when no semantic embedder is
   * available. Cheap: a single table scan of the already-chunked index.
   */
  allChunks(): Array<{
    path: string;
    startLine: number;
    endLine: number;
    content: string;
  }> {
    const rows = this.sqlite
      .query("SELECT path, start_line, end_line, content FROM code_chunks")
      .all() as Array<{
        path: string;
        start_line: number;
        end_line: number;
        content: string;
      }>;
    return rows.map((row) => ({
      path: row.path,
      startLine: row.start_line,
      endLine: row.end_line,
      content: row.content,
    }));
  }

  close(): void {
    this.sqlite.close();
  }

  // --- internals ----------------------------------------------------------

  private searchWithSqliteVec(
    queryEmbedding: number[],
    topK: number,
  ): CodeChunkHit[] | null {
    if (!queryEmbedding.length || !this.ensureVectorTable(queryEmbedding.length)) {
      return null;
    }
    try {
      const candidateCount = Math.max(topK * 20, 100);
      // Join the vec0 result through the persisted id<->rowid map instead of an
      // (unregistered) SQL hash function, exactly as cache.ts does. This is what
      // keeps the indexed path from throwing and silently degrading to a scan.
      const rows = this.sqlite
        .query(
          `
          SELECT
            cc.path,
            cc.start_line,
            cc.end_line,
            cc.content,
            v.distance
          FROM (
            SELECT rowid, distance
            FROM code_chunk_vectors
            WHERE embedding MATCH ? AND k = ?
          ) AS v
          JOIN code_chunk_vector_map AS m ON m.rowid = v.rowid
          JOIN code_chunks AS cc ON cc.id = m.chunk_id
          ORDER BY v.distance ASC
          LIMIT ?
          `,
        )
        .all(JSON.stringify(queryEmbedding), candidateCount, topK) as Array<{
          path: string;
          start_line: number;
          end_line: number;
          content: string;
          distance: number;
        }>;
      return rows.map((row) => ({
        path: row.path,
        startLine: row.start_line,
        endLine: row.end_line,
        content: row.content,
        score: 1 - row.distance,
      }));
    } catch {
      this.sqliteVecAvailable = false;
      return null;
    }
  }

  private getFileRow(path: string): FileRow | null {
    const row = this.sqlite
      .query("SELECT path, sha256, mtime FROM code_files WHERE path = ? LIMIT 1")
      .get(path) as FileRow | null;
    return row ?? null;
  }

  private upsertFileRow(path: string, hash: string, lang: string, mtime: number): void {
    this.sqlite
      .query(
        `
        INSERT INTO code_files(path, sha256, lang, mtime, indexed_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET
          sha256 = excluded.sha256,
          lang = excluded.lang,
          mtime = excluded.mtime,
          indexed_at = excluded.indexed_at
        `,
      )
      .run(path, hash, lang, mtime, Date.now());
  }

  private deleteChunksForFile(path: string): void {
    const rows = this.sqlite
      .query("SELECT id FROM code_chunks WHERE path = ?")
      .all(path) as Array<{ id: number }>;
    for (const row of rows) {
      if (this.sqliteVecAvailable) {
        try {
          const mapped = this.sqlite
            .query("SELECT rowid FROM code_chunk_vector_map WHERE chunk_id = ? LIMIT 1")
            .get(row.id) as { rowid: number } | null;
          if (mapped) {
            this.sqlite
              .query("DELETE FROM code_chunk_vectors WHERE rowid = ?")
              .run(mapped.rowid);
            this.sqlite
              .query("DELETE FROM code_chunk_vector_map WHERE chunk_id = ?")
              .run(row.id);
          }
        } catch {
          this.sqliteVecAvailable = false;
        }
      }
    }
    this.sqlite.query("DELETE FROM code_chunks WHERE path = ?").run(path);
  }
}

// --- module-level helpers (mirror cache.ts) -------------------------------

function* walk(dir: string): Generator<string> {
  let entries: Dirent[];
  try {
    // Bun's bundled @types can infer Dirent<NonSharedBuffer> here; names are
    // strings at runtime, so coerce to the string-named Dirent shape.
    entries = readdirSync(dir, { withFileTypes: true }) as unknown as Dirent[];
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) {
        continue;
      }
      yield* walk(full);
    } else if (entry.isFile()) {
      if (isSourceFile(full)) {
        yield full;
      }
    }
  }
}

/** Heuristic binary detection: a NUL char in the first slice => binary. */
function looksBinary(content: string): boolean {
  const limit = Math.min(content.length, 8192);
  for (let i = 0; i < limit; i += 1) {
    if (content.charCodeAt(i) === 0) {
      return true;
    }
  }
  return false;
}

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function encodeEmbedding(embedding: number[] | undefined): Uint8Array | null {
  if (!embedding?.length) {
    return null;
  }
  return new TextEncoder().encode(JSON.stringify(embedding));
}

function decodeEmbedding(value: Uint8Array | null | undefined): number[] | null {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(value)) as unknown;
    if (!Array.isArray(parsed)) {
      return null;
    }
    if (!parsed.every((entry) => typeof entry === "number")) {
      return null;
    }
    return parsed as number[];
  } catch {
    return null;
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  const size = Math.min(a.length, b.length);
  if (size === 0) {
    return 0;
  }
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let index = 0; index < size; index += 1) {
    const av = a[index] ?? 0;
    const bv = b[index] ?? 0;
    dot += av * bv;
    magA += av * av;
    magB += bv * bv;
  }
  if (!magA || !magB) {
    return 0;
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}
