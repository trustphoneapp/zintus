import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { load as loadSqliteVec } from "sqlite-vec";
import { and, desc, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { MemoryFact, MemoryThreadState } from "@zintus/types";
import * as schema from "./schema.js";
import { chunkText, embedBatchWithMetadata, embedText } from "./embeddings.js";

const DEFAULT_MEMORY_PATH = join(homedir(), ".zintus", "memory.db");

type JsonRecord = Record<string, unknown>;

export type ThreadStateRow = {
  threadId: string;
  state: JsonRecord;
  updatedAt: Date;
};

/** Where a fact applies. `thread` facts belong to one conversation; `project`
 *  facts to a project (any thread in it); `global` facts to the whole user. */
export type MemoryScope = "thread" | "project" | "global";

export type MemoryFactRow = {
  id: string;
  /** Null for `project`/`global` facts (they have no owning thread). */
  threadId: string | null;
  key: string;
  value: string;
  source?: string;
  scope: MemoryScope;
  projectId?: string;
  pinned: boolean;
  /** Epoch ms this fact was last included in a compiled context. */
  lastUsedAt?: number;
  sourceMessageId?: string;
  createdAt: Date;
  updatedAt: Date;
};

export type MemoryChunkRow = {
  id: number;
  threadId: string;
  content: string;
  relevance?: number;
  embedding?: number[];
  metadata?: JsonRecord;
  createdAt: Date;
};

export type CompileTraceRow = {
  id: number;
  threadId: string;
  trace: JsonRecord;
  createdAt: Date;
};

export class MemoryStore {
  private readonly sqlite: Database;
  private readonly db;
  private sqliteVecAvailable = false;
  private sqliteVecDimensions: number | null = null;

  constructor(dbPath = DEFAULT_MEMORY_PATH) {
    mkdirSync(dirname(dbPath), { recursive: true });
    const sqlite = new Database(dbPath, { create: true });
    this.sqlite = sqlite;
    this.db = drizzle(sqlite, { schema });
    this.tryLoadSqliteVec();
  }

  async getTopFacts(
    threadId: string,
    query: string,
    limit: number,
    projectId?: string,
  ): Promise<MemoryFact[]> {
    const normalizedQuery = query.trim().toLowerCase();
    // Thread facts (local to this conversation), the user's GLOBAL facts (user-
    // wide), and — when the turn belongs to a project — that PROJECT's facts all
    // inform the turn. All three scopes are disjoint by construction, so no dedupe
    // is needed.
    const rows = [
      ...this.listFacts(threadId),
      ...this.listFactsByScope({ scope: "global" }),
      ...(projectId
        ? this.listFactsByScope({ scope: "project", projectId })
        : []),
    ];
    const scored = rows.map((row) => {
      const haystack = `${row.key} ${row.value}`.toLowerCase();
      let relevance = normalizedQuery
        ? haystack.includes(normalizedQuery)
          ? 1
          : 0.35
        : 0.5;
      // Pinned facts are user-curated as important — always float them to the top
      // so a pinned global memory reliably makes it into the compiled context.
      if (row.pinned) {
        relevance = Math.max(relevance, 0.9);
      }
      return {
        id: row.id,
        content: `${row.key}: ${row.value}`,
        source: row.source,
        relevance,
      } satisfies MemoryFact;
    });
    return scored
      .sort((a, b) => (b.relevance ?? 0) - (a.relevance ?? 0))
      .slice(0, limit);
  }

  appendSummary(threadId: string, assistantContent: string): void {
    const prevState = (this.getThreadState(threadId)?.state ?? {}) as unknown as MemoryThreadState;
    const previousSummary = prevState.workingSummary ?? "";
    const nextSummary = summarizeSummary(previousSummary, assistantContent);
    this.upsertThreadState(threadId, {
      ...prevState,
      threadId,
      workingSummary: nextSummary,
    });
  }

  init(): void {
    this.db.$client.exec(`
      CREATE TABLE IF NOT EXISTS thread_state (
        thread_id TEXT PRIMARY KEY,
        state_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_facts (
        id TEXT PRIMARY KEY,
        thread_id TEXT,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        source TEXT,
        scope TEXT NOT NULL DEFAULT 'thread',
        project_id TEXT,
        pinned INTEGER NOT NULL DEFAULT 0,
        last_used_at INTEGER,
        source_message_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id TEXT NOT NULL,
        content TEXT NOT NULL,
        embedding BLOB,
        metadata_json TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS compile_traces (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id TEXT NOT NULL,
        trace_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_chunk_vectors_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      -- thread_id is the WHERE/filter column on every read path (listFacts,
      -- listChunks, listTraces, fact upserts). Without these indexes those are
      -- full table scans that degrade linearly as memory grows. thread_state is
      -- already covered by its PRIMARY KEY. IF NOT EXISTS keeps init() idempotent.
      CREATE INDEX IF NOT EXISTS idx_memory_facts_thread_id
        ON memory_facts (thread_id);
      CREATE INDEX IF NOT EXISTS idx_memory_facts_thread_key
        ON memory_facts (thread_id, key);
      CREATE INDEX IF NOT EXISTS idx_memory_chunks_thread_id
        ON memory_chunks (thread_id);
      CREATE INDEX IF NOT EXISTS idx_compile_traces_thread_id
        ON compile_traces (thread_id);
    `);
    try {
      this.db.$client.exec(`
        ALTER TABLE memory_chunks ADD COLUMN embedding BLOB;
      `);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("duplicate column name")) {
        throw error;
      }
    }
    this.migrateMemoryFactsGovernance();
    // Governance indexes are created AFTER the migration guarantees the columns
    // exist (a pre-governance DB lacks scope/project_id until migrated above).
    this.db.$client.exec(`
      CREATE INDEX IF NOT EXISTS idx_memory_facts_scope
        ON memory_facts (scope);
      CREATE INDEX IF NOT EXISTS idx_memory_facts_project
        ON memory_facts (project_id);
    `);
    this.restoreVectorTable();
  }

  /**
   * Bring a pre-governance `memory_facts` up to the current schema. Older DBs
   * have `thread_id NOT NULL` and lack the scope/pinned/last_used_at/
   * source_message_id columns. SQLite can't drop a NOT NULL via ALTER, so we do
   * the standard table-recreation (copy → drop → rename) inside a transaction,
   * backfilling every existing row to `scope='thread'`. Guarded + idempotent:
   * a no-op once the table already has `scope` AND a nullable `thread_id`, so
   * repeated init() calls (and already-migrated DBs) do nothing.
   */
  private migrateMemoryFactsGovernance(): void {
    const cols = this.db.$client
      .prepare("PRAGMA table_info(memory_facts)")
      .all() as Array<{ name: string; notnull: number }>;
    const hasScope = cols.some((c) => c.name === "scope");
    const threadIdNotNull =
      cols.find((c) => c.name === "thread_id")?.notnull === 1;
    if (hasScope && !threadIdNotNull) {
      return; // already on the governance schema
    }
    this.db.$client.exec(`
      BEGIN;
      CREATE TABLE memory_facts__gov (
        id TEXT PRIMARY KEY,
        thread_id TEXT,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        source TEXT,
        scope TEXT NOT NULL DEFAULT 'thread',
        project_id TEXT,
        pinned INTEGER NOT NULL DEFAULT 0,
        last_used_at INTEGER,
        source_message_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO memory_facts__gov
        (id, thread_id, key, value, source, scope, created_at, updated_at)
        SELECT id, thread_id, key, value, source, 'thread', created_at, updated_at
        FROM memory_facts;
      DROP TABLE memory_facts;
      ALTER TABLE memory_facts__gov RENAME TO memory_facts;
      CREATE INDEX IF NOT EXISTS idx_memory_facts_thread_id
        ON memory_facts (thread_id);
      CREATE INDEX IF NOT EXISTS idx_memory_facts_thread_key
        ON memory_facts (thread_id, key);
      CREATE INDEX IF NOT EXISTS idx_memory_facts_scope
        ON memory_facts (scope);
      CREATE INDEX IF NOT EXISTS idx_memory_facts_project
        ON memory_facts (project_id);
      COMMIT;
    `);
  }

  getThreadState(threadId: string): ThreadStateRow | null {
    const row = this.db
      .select()
      .from(schema.threadState)
      .where(eq(schema.threadState.threadId, threadId))
      .get();
    if (!row) {
      return null;
    }
    return {
      threadId: row.threadId,
      state: JSON.parse(row.stateJson) as JsonRecord,
      updatedAt: new Date(row.updatedAt),
    };
  }

  upsertThreadState(threadId: string, state: JsonRecord): ThreadStateRow {
    const now = Date.now();
    this.db
      .insert(schema.threadState)
      .values({
        threadId,
        stateJson: JSON.stringify(state),
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: schema.threadState.threadId,
        set: {
          stateJson: JSON.stringify(state),
          updatedAt: now,
        },
      })
      .run();
    return {
      threadId,
      state,
      updatedAt: new Date(now),
    };
  }

  private mapFactRow(
    row: typeof schema.memoryFacts.$inferSelect,
  ): MemoryFactRow {
    return {
      id: row.id,
      threadId: row.threadId ?? null,
      key: row.key,
      value: row.value,
      source: row.source ?? undefined,
      scope: (row.scope as MemoryScope | null) ?? "thread",
      projectId: row.projectId ?? undefined,
      pinned: Boolean(row.pinned),
      lastUsedAt: row.lastUsedAt ?? undefined,
      sourceMessageId: row.sourceMessageId ?? undefined,
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt),
    };
  }

  /** Facts owned by ONE thread (thread-scoped continuity path). */
  listFacts(threadId: string): MemoryFactRow[] {
    const rows = this.db
      .select()
      .from(schema.memoryFacts)
      .where(eq(schema.memoryFacts.threadId, threadId))
      .orderBy(desc(schema.memoryFacts.updatedAt))
      .all();
    return rows.map((row) => this.mapFactRow(row));
  }

  /**
   * Governance list: facts by scope, optionally narrowed to a thread/project.
   * Pinned facts sort first, then most-recently-updated. Powers GET /v1/memory
   * and the Memory Manager UI.
   */
  listFactsByScope(filter: {
    scope?: MemoryScope;
    threadId?: string;
    projectId?: string;
  }): MemoryFactRow[] {
    const conditions = [];
    if (filter.scope) {
      conditions.push(eq(schema.memoryFacts.scope, filter.scope));
    }
    if (filter.threadId) {
      conditions.push(eq(schema.memoryFacts.threadId, filter.threadId));
    }
    if (filter.projectId) {
      conditions.push(eq(schema.memoryFacts.projectId, filter.projectId));
    }
    const rows = this.db
      .select()
      .from(schema.memoryFacts)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(
        desc(schema.memoryFacts.pinned),
        desc(schema.memoryFacts.updatedAt),
      )
      .all();
    return rows.map((row) => this.mapFactRow(row));
  }

  upsertFact(input: {
    id?: string;
    threadId?: string | null;
    key: string;
    value: string;
    source?: string;
    scope?: MemoryScope;
    projectId?: string;
    pinned?: boolean;
    sourceMessageId?: string;
  }): MemoryFactRow {
    const now = Date.now();
    const id = input.id ?? randomUUID();

    const existing = this.db
      .select()
      .from(schema.memoryFacts)
      .where(eq(schema.memoryFacts.id, id))
      .get();

    const createdAt = existing?.createdAt ?? now;
    // Preserve governance fields on an auto-upsert (the engine passes only
    // thread/key/value/source) — never silently reset a user's pin/scope.
    const scope: MemoryScope =
      input.scope ?? (existing?.scope as MemoryScope | null) ?? "thread";
    const threadId = input.threadId ?? existing?.threadId ?? null;
    const projectId = input.projectId ?? existing?.projectId ?? null;
    const pinned = input.pinned ?? (existing ? Boolean(existing.pinned) : false);
    const sourceMessageId =
      input.sourceMessageId ?? existing?.sourceMessageId ?? null;

    const values = {
      id,
      threadId,
      key: input.key,
      value: input.value,
      source: input.source ?? null,
      scope,
      projectId,
      pinned,
      sourceMessageId,
      createdAt,
      updatedAt: now,
    };
    this.db
      .insert(schema.memoryFacts)
      .values(values)
      .onConflictDoUpdate({
        target: schema.memoryFacts.id,
        set: {
          threadId,
          key: input.key,
          value: input.value,
          source: input.source ?? null,
          scope,
          projectId,
          pinned,
          sourceMessageId,
          updatedAt: now,
        },
      })
      .run();

    return this.mapFactRow({
      ...values,
      lastUsedAt: existing?.lastUsedAt ?? null,
    });
  }

  /** Governance edit by id (scope-agnostic): update text and/or pin state. */
  updateFactById(
    id: string,
    patch: { key?: string; value?: string; pinned?: boolean },
  ): MemoryFactRow | null {
    const existing = this.db
      .select()
      .from(schema.memoryFacts)
      .where(eq(schema.memoryFacts.id, id))
      .get();
    if (!existing) {
      return null;
    }
    this.db
      .update(schema.memoryFacts)
      .set({
        ...(patch.key !== undefined ? { key: patch.key } : {}),
        ...(patch.value !== undefined ? { value: patch.value } : {}),
        ...(patch.pinned !== undefined ? { pinned: patch.pinned } : {}),
        updatedAt: Date.now(),
      })
      .where(eq(schema.memoryFacts.id, id))
      .run();
    const row = this.db
      .select()
      .from(schema.memoryFacts)
      .where(eq(schema.memoryFacts.id, id))
      .get();
    return row ? this.mapFactRow(row) : null;
  }

  /** Thread-scoped delete (existing continuity path — requires matching thread). */
  deleteFact(threadId: string, factId: string): boolean {
    const existing = this.db
      .select({ id: schema.memoryFacts.id })
      .from(schema.memoryFacts)
      .where(
        and(
          eq(schema.memoryFacts.threadId, threadId),
          eq(schema.memoryFacts.id, factId),
        ),
      )
      .get();
    if (!existing) {
      return false;
    }
    this.db
      .delete(schema.memoryFacts)
      .where(
        and(
          eq(schema.memoryFacts.threadId, threadId),
          eq(schema.memoryFacts.id, factId),
        ),
      )
      .run();
    return true;
  }

  /** Governance delete by id (any scope). Returns false if the id doesn't exist. */
  deleteFactById(id: string): boolean {
    const existing = this.db
      .select({ id: schema.memoryFacts.id })
      .from(schema.memoryFacts)
      .where(eq(schema.memoryFacts.id, id))
      .get();
    if (!existing) {
      return false;
    }
    this.db
      .delete(schema.memoryFacts)
      .where(eq(schema.memoryFacts.id, id))
      .run();
    return true;
  }

  /** Stamp `lastUsedAt` on the facts the compiler included this turn (curation). */
  touchFactsUsed(ids: string[]): void {
    if (ids.length === 0) {
      return;
    }
    this.db
      .update(schema.memoryFacts)
      .set({ lastUsedAt: Date.now() })
      .where(inArray(schema.memoryFacts.id, ids))
      .run();
  }

  appendChunk(input: {
    threadId: string;
    content: string;
    embedding?: number[];
    metadata?: JsonRecord;
  }): MemoryChunkRow {
    const now = Date.now();
    this.db
      .insert(schema.memoryChunks)
      .values({
        threadId: input.threadId,
        content: input.content,
        embedding: encodeEmbedding(input.embedding),
        metadataJson: input.metadata ? JSON.stringify(input.metadata) : null,
        createdAt: now,
      })
      .run();
    const inserted = this.db
      .select()
      .from(schema.memoryChunks)
      .where(
        and(
          eq(schema.memoryChunks.threadId, input.threadId),
          eq(schema.memoryChunks.createdAt, now),
          eq(schema.memoryChunks.content, input.content),
        ),
      )
      .orderBy(desc(schema.memoryChunks.id))
      .limit(1)
      .get();
    if (!inserted) {
      throw new Error("Failed to append memory chunk.");
    }
    const decodedEmbedding = decodeEmbedding(inserted.embedding) ?? undefined;
    if (decodedEmbedding) {
      this.indexChunkEmbedding(inserted.id, decodedEmbedding);
    }

    return {
      id: inserted.id,
      threadId: inserted.threadId,
      content: inserted.content,
      embedding: decodedEmbedding,
      metadata: inserted.metadataJson
        ? (JSON.parse(inserted.metadataJson) as JsonRecord)
        : undefined,
      createdAt: new Date(inserted.createdAt),
    };
  }

  async embedAndStoreChunk(threadId: string, content: string): Promise<MemoryChunkRow[]> {
    const parts = chunkText(content);
    if (!parts.length) {
      return [];
    }

    const { embeddings, metadata } = await embedBatchWithMetadata(parts);
    return parts.map((part, index) =>
      this.appendChunk({
        threadId,
        content: part,
        embedding: embeddings[index] ?? [],
        metadata,
      }),
    );
  }

  async searchChunks(threadId: string, query: string, topK = 5): Promise<MemoryChunkRow[]> {
    const queryEmbedding = await embedText(query);
    const vecMatches = this.searchChunksWithSqliteVec(threadId, queryEmbedding, topK);
    if (vecMatches?.length) {
      return vecMatches;
    }

    const rows = this.db
      .select()
      .from(schema.memoryChunks)
      .where(eq(schema.memoryChunks.threadId, threadId))
      .orderBy(desc(schema.memoryChunks.createdAt))
      .limit(Math.max(topK * 10, 50))
      .all();

    const scored = rows
      .map((row) => {
        const embedding = decodeEmbedding(row.embedding);
        if (!embedding) {
          return null;
        }
        return {
          row,
          score: cosineSimilarity(queryEmbedding, embedding),
        };
      })
      .filter((entry): entry is { row: (typeof rows)[number]; score: number } => Boolean(entry))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    if (scored.length) {
      return scored.map(({ row, score }) => ({
        id: row.id,
        threadId: row.threadId,
        content: row.content,
        relevance: score,
        embedding: decodeEmbedding(row.embedding) ?? undefined,
        metadata: row.metadataJson
          ? (JSON.parse(row.metadataJson) as JsonRecord)
          : undefined,
        createdAt: new Date(row.createdAt),
      }));
    }

    const fallbackRows = rows
      .filter((row) => row.content.toLowerCase().includes(query.toLowerCase()))
      .slice(0, topK);
    return fallbackRows.map((row) => ({
      id: row.id,
      threadId: row.threadId,
      content: row.content,
      relevance: 0.1,
      embedding: decodeEmbedding(row.embedding) ?? undefined,
      metadata: row.metadataJson
        ? (JSON.parse(row.metadataJson) as JsonRecord)
        : undefined,
      createdAt: new Date(row.createdAt),
    }));
  }

  recordCompileTrace(threadId: string, trace: JsonRecord): CompileTraceRow {
    const now = Date.now();
    const traceJson = JSON.stringify(trace);
    this.db
      .insert(schema.compileTraces)
      .values({
        threadId,
        traceJson,
        createdAt: now,
      })
      .run();
    const inserted = this.db
      .select()
      .from(schema.compileTraces)
      .where(
        and(
          eq(schema.compileTraces.threadId, threadId),
          eq(schema.compileTraces.createdAt, now),
          eq(schema.compileTraces.traceJson, traceJson),
        ),
      )
      .orderBy(desc(schema.compileTraces.id))
      .limit(1)
      .get();
    if (!inserted) {
      throw new Error("Failed to record compile trace.");
    }

    return {
      id: inserted.id,
      threadId: inserted.threadId,
      trace: JSON.parse(inserted.traceJson) as JsonRecord,
      createdAt: new Date(inserted.createdAt),
    };
  }

  getCompileTrace(id: number): CompileTraceRow | null {
    const row = this.db
      .select()
      .from(schema.compileTraces)
      .where(eq(schema.compileTraces.id, id))
      .get();
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      threadId: row.threadId,
      trace: JSON.parse(row.traceJson) as JsonRecord,
      createdAt: new Date(row.createdAt),
    };
  }

  private tryLoadSqliteVec(): void {
    try {
      loadSqliteVec(this.sqlite);
      this.sqliteVecAvailable = true;
    } catch {
      this.sqliteVecAvailable = false;
    }
  }

  private restoreVectorTable(): void {
    if (!this.sqliteVecAvailable) {
      return;
    }
    // Best-effort: a vec0 operation can throw on some platforms/SQLite builds
    // (e.g. headless Linux CI). Memory works without the indexed path, so a
    // failure here must never crash init() — just disable the indexed path.
    try {
      const row = this.sqlite
        .query(
          "SELECT value FROM memory_chunk_vectors_meta WHERE key = 'dimensions' LIMIT 1",
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
        `CREATE VIRTUAL TABLE IF NOT EXISTS memory_chunk_vectors USING vec0(embedding float[${dimensions}])`,
      );
      this.sqlite
        .query(
          "INSERT INTO memory_chunk_vectors_meta(key, value) VALUES ('dimensions', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
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
      const rows = this.db.select().from(schema.memoryChunks).all();
      // vec0 does not honor INSERT OR REPLACE on the rowid PK (it raises a UNIQUE
      // constraint on some builds, e.g. Linux CI). DELETE-then-INSERT is the
      // supported upsert idiom for a vec0 row by rowid.
      const del = this.sqlite.query(
        "DELETE FROM memory_chunk_vectors WHERE rowid = ?",
      );
      const statement = this.sqlite.query(
        "INSERT INTO memory_chunk_vectors(rowid, embedding) VALUES (?, ?)",
      );
      for (const row of rows) {
        const embedding = decodeEmbedding(row.embedding);
        if (!embedding || embedding.length !== dimensions) {
          continue;
        }
        del.run(row.id);
        statement.run(row.id, JSON.stringify(embedding));
      }
    } catch {
      // Indexed vec0 path unavailable on this platform — fall back to scan.
      this.sqliteVecAvailable = false;
    }
  }

  private indexChunkEmbedding(chunkId: number, embedding: number[]): void {
    if (!embedding.length || !this.ensureVectorTable(embedding.length)) {
      return;
    }
    try {
      // vec0 does not honor INSERT OR REPLACE on the rowid PK (UNIQUE constraint
      // on some builds, e.g. Linux CI) — DELETE-then-INSERT is the supported
      // upsert idiom for a vec0 row by rowid.
      this.sqlite
        .query("DELETE FROM memory_chunk_vectors WHERE rowid = ?")
        .run(chunkId);
      this.sqlite
        .query("INSERT INTO memory_chunk_vectors(rowid, embedding) VALUES (?, ?)")
        .run(chunkId, JSON.stringify(embedding));
    } catch {
      this.sqliteVecAvailable = false;
    }
  }

  private searchChunksWithSqliteVec(
    threadId: string,
    queryEmbedding: number[],
    topK: number,
  ): MemoryChunkRow[] | null {
    if (!queryEmbedding.length || !this.ensureVectorTable(queryEmbedding.length)) {
      return null;
    }
    try {
      const candidateCount = Math.max(topK * 20, 100);
      const rows = this.sqlite
        .query(
          `
          SELECT
            mc.id,
            mc.thread_id,
            mc.content,
            mc.embedding,
            mc.metadata_json,
            mc.created_at,
            v.distance
          FROM (
            SELECT rowid, distance
            FROM memory_chunk_vectors
            WHERE embedding MATCH ? AND k = ?
          ) AS v
          JOIN memory_chunks AS mc ON mc.id = v.rowid
          WHERE mc.thread_id = ?
          ORDER BY v.distance ASC
          LIMIT ?
          `,
        )
        .all(JSON.stringify(queryEmbedding), candidateCount, threadId, topK) as Array<{
          id: number;
          thread_id: string;
          content: string;
          embedding: Uint8Array | null;
          metadata_json: string | null;
          created_at: number;
          distance: number;
        }>;
      return rows.map((row) => ({
        id: row.id,
        threadId: row.thread_id,
        content: row.content,
        relevance: 1 - row.distance,
        embedding: decodeEmbedding(row.embedding) ?? undefined,
        metadata: row.metadata_json ? (JSON.parse(row.metadata_json) as JsonRecord) : undefined,
        createdAt: new Date(row.created_at),
      }));
    } catch {
      this.sqliteVecAvailable = false;
      return null;
    }
  }
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

function summarizeSummary(previousSummary: string, latestAssistantOutput: string): string {
  const trimmed = latestAssistantOutput.trim();
  if (!trimmed) {
    return previousSummary;
  }
  const snippet = trimmed.slice(0, 240);
  const next = previousSummary
    ? `${previousSummary}\n- ${snippet}`
    : `- ${snippet}`;
  return next.slice(-4000);
}
