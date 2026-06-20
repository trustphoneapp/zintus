import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { load as loadSqliteVec } from "sqlite-vec";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { eq, and } from "drizzle-orm";
import type { ChatMessage } from "@zintus/types";
import * as schema from "./schema.js";
import crypto from "node:crypto";

const DEFAULT_CACHE_PATH = join(homedir(), ".zintus", "cache.db");
const FALLBACK_VECTOR_SIZE = 256;
const DEFAULT_OLLAMA_MODEL = "nomic-embed-text";

// Default per-tier TTLs (Phase 3.2). Null = no expiry by default.
const DEFAULT_L1_TTL_MS: number | null = null;
const DEFAULT_L2_TTL_MS: number | null = null;

// Distance threshold used when the L2 tier is running on the weak deterministic
// fallback embedding. The fallback is only trustworthy for near-exact dedupe,
// so we clamp it to a very small distance regardless of the caller's request.
const NEAR_EXACT_FALLBACK_THRESHOLD = 0.02;

/**
 * Detect whether a real embedder (Ollama nomic-embed-text) is configured.
 * When false the deterministic hashing-embedding fallback is in use, which is
 * semantically weak and must only be trusted for near-exact dedupe.
 */
function hasRealEmbedder(): boolean {
  return Boolean(process.env.OLLAMA_HOST?.trim());
}

/**
 * Whether the L2 (embedding/semantic) tier is enabled.
 *
 * Phase 3.1 gating: L2 is OFF by default and L1-only UNLESS either
 *  - a real embedder is available (Ollama), OR
 *  - the CACHE_L2 env flag is explicitly set to "1".
 * Setting CACHE_L2="0" force-disables L2 even when an embedder is present.
 */
function isL2Enabled(): boolean {
  const flag = process.env.CACHE_L2?.trim();
  if (flag === "1") {
    return true;
  }
  if (flag === "0") {
    return false;
  }
  return hasRealEmbedder();
}

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((token) => token.trim())
    .filter(Boolean);
}

function hashToken(token: string): number {
  let hash = 2166136261;
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function fallbackEmbedding(text: string): number[] {
  const vector = new Array<number>(FALLBACK_VECTOR_SIZE).fill(0);
  for (const token of tokenize(text)) {
    const hash = hashToken(token);
    const slot = hash % FALLBACK_VECTOR_SIZE;
    const direction = (hash & 1) === 0 ? 1 : -1;
    vector[slot] = (vector[slot] ?? 0) + direction;
  }
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!magnitude) {
    return vector;
  }
  return vector.map((value) => value / magnitude);
}

async function embedText(text: string): Promise<number[]> {
  const host = process.env.OLLAMA_HOST?.trim();
  if (!host) {
    return fallbackEmbedding(text);
  }
  try {
    const normalizedHost = host.endsWith("/") ? host.slice(0, -1) : host;
    const response = await fetch(`${normalizedHost}/api/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: DEFAULT_OLLAMA_MODEL,
        input: [text],
      }),
    });
    if (!response.ok) {
      throw new Error();
    }
    const payload = (await response.json()) as {
      embeddings?: number[][];
    };
    if (payload.embeddings?.[0]) {
      return payload.embeddings[0];
    }
    return fallbackEmbedding(text);
  } catch {
    return fallbackEmbedding(text);
  }
}

export interface ResponseCacheOptions {
  /** Filesystem path to the sqlite database. */
  dbPath?: string;
  /** Default TTL (ms) applied to L1 (exact) entries when the caller does not
   *  pass a per-call ttlMs. Null disables expiry. */
  l1TtlMs?: number | null;
  /** Default TTL (ms) applied to L2 (semantic) lookups — entries older than
   *  this are ignored by getL2. Null disables expiry. */
  l2TtlMs?: number | null;
}

/** Options for the L2 semantic lookup path. */
export interface GetL2Options {
  threshold?: number;
  now?: number;
  /** Skip the cache entirely (Phase 3.2 bypass). */
  bypass?: boolean;
}

/** Options for the L1 exact lookup path. */
export interface GetL1Options {
  now?: number;
  /** Skip the cache entirely (Phase 3.2 bypass). */
  bypass?: boolean;
}

/** Rich result returned by getL2Detailed. */
export interface L2Result {
  responseText: string;
  /** Cosine similarity score of the matched entry. */
  score: number;
  /**
   * True when this hit was produced while running on the weak deterministic
   * fallback embedding (no real embedder configured). In that mode the match
   * is only reliable for near-exact dedupe, NOT general semantic similarity.
   */
  fallbackEmbedding: boolean;
  /** True when the indexed sqlite-vec (vec0) path produced the hit, false when
   *  it came from the linear table scan. Exposed mainly for tests/diagnostics. */
  usedVectorIndex: boolean;
}

export class ResponseCache {
  private readonly sqlite: Database;
  private readonly db;
  private sqliteVecAvailable = false;
  private sqliteVecDimensions: number | null = null;
  private readonly l1TtlMs: number | null;
  private readonly l2TtlMs: number | null;
  /** Diagnostic flag: set true whenever the last L2 lookup served a hit from
   *  the indexed vec0 path (rather than the linear scan). */
  public lastL2UsedVectorIndex = false;

  /**
   * Whether the sqlite-vec extension actually loaded. False on SQLite builds
   * without dynamic-extension support (e.g. Bun's bundled sqlite3), where L2
   * still works via the linear-scan fallback but the indexed vec0 path cannot.
   */
  get vectorIndexAvailable(): boolean {
    return this.sqliteVecAvailable;
  }

  constructor(options: string | ResponseCacheOptions = {}) {
    const opts: ResponseCacheOptions =
      typeof options === "string" ? { dbPath: options } : options;
    const dbPath = opts.dbPath ?? DEFAULT_CACHE_PATH;
    this.l1TtlMs = opts.l1TtlMs ?? DEFAULT_L1_TTL_MS;
    this.l2TtlMs = opts.l2TtlMs ?? DEFAULT_L2_TTL_MS;
    mkdirSync(dirname(dbPath), { recursive: true });
    const sqlite = new Database(dbPath, { create: true });
    this.sqlite = sqlite;
    this.db = drizzle(sqlite, { schema });
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

  init(): void {
    this.db.$client.exec(`
      CREATE TABLE IF NOT EXISTS chat_cache (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        thread_id TEXT,
        provider_id TEXT NOT NULL,
        model TEXT NOT NULL,
        prompt_text TEXT NOT NULL,
        response_text TEXT NOT NULL,
        embedding BLOB,
        created_at INTEGER NOT NULL,
        expires_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS chat_cache_vectors_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chat_cache_vector_map (
        rowid INTEGER PRIMARY KEY AUTOINCREMENT,
        cache_id TEXT NOT NULL UNIQUE
      );
    `);
    this.restoreVectorTable();
  }

  private restoreVectorTable(): void {
    if (!this.sqliteVecAvailable) {
      return;
    }
    const row = this.sqlite
      .query(
        "SELECT value FROM chat_cache_vectors_meta WHERE key = 'dimensions' LIMIT 1",
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
        `CREATE VIRTUAL TABLE IF NOT EXISTS chat_cache_vectors USING vec0(embedding float[${dimensions}])`,
      );
      this.sqlite
        .query(
          "INSERT INTO chat_cache_vectors_meta(key, value) VALUES ('dimensions', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
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
    const rows = this.db.select().from(schema.chatCache).all();
    const statement = this.sqlite.query(
      "INSERT OR REPLACE INTO chat_cache_vectors(rowid, embedding) VALUES (?, ?)",
    );
    for (const row of rows) {
      const embedding = decodeEmbedding(row.embedding);
      if (!embedding || embedding.length !== dimensions) {
        continue;
      }
      const rowId = this.resolveVectorRowId(row.id);
      statement.run(rowId, JSON.stringify(embedding));
    }
  }

  /**
   * Resolve (creating if needed) the stable integer rowid for a string cache
   * id. The mapping lives in chat_cache_vector_map. This replaces the previous
   * approach that hashed the cache id to a 32-bit integer — that was both
   * collision-prone AND relied on an unregistered SQL function in the vec0
   * search join, which made the indexed path throw and silently fall back to a
   * full linear scan.
   */
  private resolveVectorRowId(cacheId: string): number {
    const existing = this.sqlite
      .query("SELECT rowid FROM chat_cache_vector_map WHERE cache_id = ? LIMIT 1")
      .get(cacheId) as { rowid: number } | null;
    if (existing) {
      return existing.rowid;
    }
    this.sqlite
      .query("INSERT INTO chat_cache_vector_map(cache_id) VALUES (?)")
      .run(cacheId);
    const inserted = this.sqlite
      .query("SELECT rowid FROM chat_cache_vector_map WHERE cache_id = ? LIMIT 1")
      .get(cacheId) as { rowid: number };
    return inserted.rowid;
  }

  private indexCacheEmbedding(cacheId: string, embedding: number[]): void {
    if (!embedding.length || !this.ensureVectorTable(embedding.length)) {
      return;
    }
    try {
      // vec0 rowids must be integers; map the string cache id to a stable
      // autoincrement integer via chat_cache_vector_map (no hash collisions,
      // no unregistered SQL function in the search join).
      const rowId = this.resolveVectorRowId(cacheId);
      this.sqlite
        .query("INSERT OR REPLACE INTO chat_cache_vectors(rowid, embedding) VALUES (?, ?)")
        .run(rowId, JSON.stringify(embedding));
    } catch {
      this.sqliteVecAvailable = false;
    }
  }

  /**
   * Generates a deterministic L1 exact match hash key based on request payload.
   */
  public generateKey(
    messages: ChatMessage[],
    options: { model: string; providerId: string; temperature?: number; maxTokens?: number },
  ): string {
    const payload = {
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      model: options.model,
      providerId: options.providerId,
      temperature: options.temperature,
      maxTokens: options.maxTokens,
    };
    return sha256(JSON.stringify(payload));
  }

  /**
   * Retrieves exactly matched response.
   */
  public getL1(key: string, optionsOrNow: number | GetL1Options = {}): string | null {
    // Backward compatible: callers may pass a `now` number directly.
    const options: GetL1Options =
      typeof optionsOrNow === "number" ? { now: optionsOrNow } : optionsOrNow;
    if (options.bypass) {
      return null;
    }
    const now = options.now ?? Date.now();
    const row = this.db
      .select()
      .from(schema.chatCache)
      .where(eq(schema.chatCache.id, key))
      .get();
    if (!row) {
      return null;
    }
    if (row.expiresAt && row.expiresAt < now) {
      return null;
    }
    return row.responseText;
  }

  /**
   * Retrieves semantically matched response.
   */
  public async getL2(
    userPrompt: string,
    model: string,
    providerId: string,
    thresholdOrOptions: number | GetL2Options = 0.12,
    now = Date.now(),
  ): Promise<string | null> {
    // Backward compatible: callers pass (threshold, now) positionally.
    const options: GetL2Options =
      typeof thresholdOrOptions === "number"
        ? { threshold: thresholdOrOptions, now }
        : thresholdOrOptions;
    const detailed = await this.getL2Detailed(userPrompt, model, providerId, options);
    return detailed?.responseText ?? null;
  }

  /**
   * Semantic (L2) lookup returning rich metadata.
   *
   * Phase 3.1 gating:
   *  - When L2 is disabled (see isL2Enabled) this always returns null.
   *  - When L2 is enabled WITHOUT a real embedder, the deterministic fallback
   *    embedding is semantically weak, so the effective distance threshold is
   *    clamped to near-exact dedupe and the result is flagged with
   *    `fallbackEmbedding: true` so callers know not to trust it as true
   *    semantic similarity.
   */
  public async getL2Detailed(
    userPrompt: string,
    model: string,
    providerId: string,
    options: GetL2Options = {},
  ): Promise<L2Result | null> {
    this.lastL2UsedVectorIndex = false;
    if (options.bypass) {
      return null;
    }
    if (!isL2Enabled()) {
      return null;
    }

    const now = options.now ?? Date.now();
    const requested = options.threshold ?? 0.12;
    const fallback = !hasRealEmbedder();
    // Clamp the threshold when running on the weak fallback embedding so L2 is
    // only used for near-exact dedupe (Phase 3.1).
    const threshold = fallback
      ? Math.min(requested, NEAR_EXACT_FALLBACK_THRESHOLD)
      : requested;

    const queryEmbedding = await embedText(userPrompt);

    const vecMatch = this.searchCacheWithSqliteVec(
      queryEmbedding,
      model,
      providerId,
      threshold,
      now,
    );
    if (vecMatch) {
      this.lastL2UsedVectorIndex = true;
      return {
        responseText: vecMatch.responseText,
        score: vecMatch.score,
        fallbackEmbedding: fallback,
        usedVectorIndex: true,
      };
    }

    // Linear scan fallback (used when sqlite-vec is unavailable or returned no
    // candidate within the search window).
    const rows = this.db
      .select()
      .from(schema.chatCache)
      .where(
        and(
          eq(schema.chatCache.model, model),
          eq(schema.chatCache.providerId, providerId),
        ),
      )
      .all();

    const ttlCutoff = this.l2TtlMs != null ? now - this.l2TtlMs : null;
    let bestMatch: { responseText: string; score: number } | null = null;

    for (const row of rows) {
      if (row.expiresAt && row.expiresAt < now) {
        continue;
      }
      if (ttlCutoff != null && row.createdAt < ttlCutoff) {
        continue;
      }
      const embedding = decodeEmbedding(row.embedding);
      if (!embedding) {
        continue;
      }
      const score = cosineSimilarity(queryEmbedding, embedding);
      const distance = 1 - score;
      if (distance <= threshold) {
        if (!bestMatch || score > bestMatch.score) {
          bestMatch = { responseText: row.responseText, score };
        }
      }
    }

    if (!bestMatch) {
      return null;
    }
    return {
      responseText: bestMatch.responseText,
      score: bestMatch.score,
      fallbackEmbedding: fallback,
      usedVectorIndex: false,
    };
  }

  /**
   * Stores response in cache.
   */
  public async set(
    messages: ChatMessage[],
    responseText: string,
    options: {
      model: string;
      providerId: string;
      temperature?: number;
      maxTokens?: number;
      userId?: string;
      threadId?: string;
      ttlMs?: number;
    },
  ): Promise<void> {
    const key = this.generateKey(messages, options);
    const now = Date.now();
    // Per-call ttlMs wins; otherwise fall back to the configured L1 default.
    const effectiveTtl = options.ttlMs ?? this.l1TtlMs ?? undefined;
    const expiresAt = effectiveTtl ? now + effectiveTtl : null;
    const lastUser = [...messages]
      .reverse()
      .find((m) => m.role === "user")?.content ?? "";
    const embedding = await embedText(lastUser);

    this.db
      .insert(schema.chatCache)
      .values({
        id: key,
        userId: options.userId ?? null,
        threadId: options.threadId ?? null,
        providerId: options.providerId,
        model: options.model,
        promptText: lastUser,
        responseText,
        embedding: encodeEmbedding(embedding),
        createdAt: now,
        expiresAt,
      })
      .onConflictDoUpdate({
        target: schema.chatCache.id,
        set: {
          responseText,
          createdAt: now,
          expiresAt,
        },
      })
      .run();

    if (embedding.length) {
      this.indexCacheEmbedding(key, embedding);
    }
  }

  private searchCacheWithSqliteVec(
    queryEmbedding: number[],
    model: string,
    providerId: string,
    threshold: number,
    now: number,
  ): { responseText: string; score: number } | null {
    if (!queryEmbedding.length || !this.ensureVectorTable(queryEmbedding.length)) {
      return null;
    }
    try {
      // Join the vec0 result through the persisted id<->rowid map instead of an
      // (unregistered) SQL hash function. This is what previously threw and made
      // the indexed path silently fall back to a full table scan.
      const rows = this.sqlite
        .query(
          `
          SELECT
            cc.prompt_text,
            cc.response_text,
            cc.created_at,
            cc.expires_at,
            v.distance
          FROM (
            SELECT rowid, distance
            FROM chat_cache_vectors
            WHERE embedding MATCH ? AND k = 5
          ) AS v
          JOIN chat_cache_vector_map AS m ON m.rowid = v.rowid
          JOIN chat_cache AS cc ON cc.id = m.cache_id
          WHERE cc.model = ? AND cc.provider_id = ? AND v.distance <= ?
          ORDER BY v.distance ASC
          LIMIT 1
          `,
        )
        .all(JSON.stringify(queryEmbedding), model, providerId, threshold) as Array<{
          prompt_text: string;
          response_text: string;
          created_at: number;
          expires_at: number | null;
          distance: number;
        }>;

      const matched = rows[0];
      if (!matched) {
        return null;
      }
      if (matched.expires_at && matched.expires_at < now) {
        return null;
      }
      if (this.l2TtlMs != null && matched.created_at < now - this.l2TtlMs) {
        return null;
      }
      return { responseText: matched.response_text, score: 1 - matched.distance };
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
