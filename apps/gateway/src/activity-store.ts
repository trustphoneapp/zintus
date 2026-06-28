import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
/// <reference types="bun-types" />
import { Database } from "bun:sqlite";

// Beside the quota ledger (~/.zintus/quota.db): a durable, machine-local usage
// history so GET /v1/activity is a real persistent feed instead of being
// re-derived from the in-memory trace ring each time. Mirrors the QuotaLedger
// open/migrate idiom (bun:sqlite + WAL + owner-only perms). Free-core, no
// custody: this DB lives only on the user's machine and is never sent anywhere.
const DEFAULT_ACTIVITY_PATH = join(homedir(), ".zintus", "activity.db");

/** Rows older than this many days are pruned on open — bounded, honest history. */
export const ACTIVITY_RETENTION_DAYS = 30;
const SECONDS_PER_DAY = 86_400;

/**
 * One COMPLETED turn, exactly as recorded. Honest by construction: cost is $0 on
 * the free tier; token counts / latency / route_reason stay `null` when the turn
 * did not record them (never fabricated into a zero or a guess).
 */
export interface ActivityRecord {
  traceId: string;
  /** Unix SECONDS (OpenAI/OpenRouter convention). */
  created: number;
  provider: string | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  /** Free-core: 0 on the free tier. Never invented. */
  costUsd: number;
  savedVsBaselineUsd: number | null;
  latencyMs: number | null;
  cacheHit: boolean;
  routeReason: string | null;
}

interface ActivityRow {
  trace_id: string;
  created: number;
  provider: string | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number;
  saved_vs_baseline_usd: number | null;
  latency_ms: number | null;
  cache_hit: number | null;
  route_reason: string | null;
}

export interface ListActivityQuery {
  /** Page size (clamped 1..1000 here; the public route caps it at 200). */
  limit?: number;
  /** Unix seconds — only rows created at/after this instant. */
  since?: number;
  provider?: string | null;
  model?: string | null;
}

export class ActivityStore {
  private readonly sqlite: Database;
  readonly retentionDays = ACTIVITY_RETENTION_DAYS;

  constructor(dbPath: string = DEFAULT_ACTIVITY_PATH) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.sqlite = new Database(dbPath, { create: true });
    // Owner-only (rw-------): activity.db carries usage metadata that warrants
    // protection. Best-effort on pre-existing DBs (mirrors QuotaLedger).
    try {
      chmodSync(dbPath, 0o600);
    } catch {
      /* pre-existing DB, best-effort */
    }
    this.sqlite.exec("PRAGMA journal_mode=WAL");
    this.initSchema();
    this.pruneOld();
  }

  private initSchema(): void {
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS activity (
        trace_id TEXT PRIMARY KEY,
        created INTEGER NOT NULL,
        provider TEXT,
        model TEXT,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cost_usd REAL NOT NULL DEFAULT 0,
        saved_vs_baseline_usd REAL,
        latency_ms INTEGER,
        cache_hit INTEGER,
        route_reason TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_activity_created ON activity (created);
    `);
  }

  /** Drop rows older than the retention window. Returns the count removed. */
  pruneOld(now = Date.now()): number {
    const cutoff = Math.floor(now / 1000) - this.retentionDays * SECONDS_PER_DAY;
    const result = this.sqlite
      .query(`DELETE FROM activity WHERE created < ?`)
      .run(cutoff);
    return Number(result.changes ?? 0);
  }

  /**
   * Record one completed turn. Idempotent on `traceId` (a re-recorded trace
   * overwrites, never duplicates). Caller is expected to wrap this best-effort:
   * a write failure must never break the chat response.
   */
  recordActivity(entry: ActivityRecord): void {
    this.sqlite
      .query(
        `INSERT INTO activity
           (trace_id, created, provider, model, input_tokens, output_tokens,
            cost_usd, saved_vs_baseline_usd, latency_ms, cache_hit, route_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(trace_id) DO UPDATE SET
           created = excluded.created,
           provider = excluded.provider,
           model = excluded.model,
           input_tokens = excluded.input_tokens,
           output_tokens = excluded.output_tokens,
           cost_usd = excluded.cost_usd,
           saved_vs_baseline_usd = excluded.saved_vs_baseline_usd,
           latency_ms = excluded.latency_ms,
           cache_hit = excluded.cache_hit,
           route_reason = excluded.route_reason`,
      )
      .run(
        entry.traceId,
        entry.created,
        entry.provider,
        entry.model,
        entry.inputTokens,
        entry.outputTokens,
        entry.costUsd,
        entry.savedVsBaselineUsd,
        entry.latencyMs,
        entry.cacheHit ? 1 : 0,
        entry.routeReason,
      );
  }

  /** Most-recent-first page of recorded turns, with optional filters. */
  listActivity(query: ListActivityQuery = {}): ActivityRecord[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (query.since != null) {
      clauses.push("created >= ?");
      params.push(query.since);
    }
    if (query.provider) {
      clauses.push("provider = ?");
      params.push(query.provider);
    }
    if (query.model) {
      clauses.push("model = ?");
      params.push(query.model);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = Math.max(1, Math.min(1000, Math.floor(query.limit ?? 50)));
    const rows = this.sqlite
      .query(
        `SELECT * FROM activity ${where}
         ORDER BY created DESC, rowid DESC
         LIMIT ?`,
      )
      .all(...params, limit) as ActivityRow[];
    return rows.map(rowToRecord);
  }

  /** Count of stored rows (test / observability helper). */
  count(): number {
    const row = this.sqlite
      .query(`SELECT COUNT(*) AS n FROM activity`)
      .get() as { n: number };
    return row.n;
  }

  close(): void {
    this.sqlite.close();
  }
}

function rowToRecord(row: ActivityRow): ActivityRecord {
  return {
    traceId: row.trace_id,
    created: row.created,
    provider: row.provider,
    model: row.model,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    costUsd: row.cost_usd,
    savedVsBaselineUsd: row.saved_vs_baseline_usd,
    latencyMs: row.latency_ms,
    cacheHit: row.cache_hit === 1,
    routeReason: row.route_reason,
  };
}

/**
 * Map a stored record to the EXACT Phase-5 `/v1/activity` entry shape produced by
 * the in-memory `toActivityEntry` helper: honest zeros for unrecorded tokens, a
 * `created_at` ISO alongside the unix `created`, and `route_reason` OMITTED when
 * the turn never recorded one. Single source of truth for the durable mapping.
 */
export function activityRecordToEntry(record: ActivityRecord): Record<string, unknown> {
  const input = record.inputTokens ?? 0;
  const output = record.outputTokens ?? 0;
  return {
    id: record.traceId,
    created: record.created,
    created_at: new Date(record.created * 1000).toISOString(),
    provider: record.provider,
    model: record.model,
    tokens: { input, output, total: input + output },
    cost_usd: record.costUsd ?? 0,
    saved_vs_baseline_usd: record.savedVsBaselineUsd ?? 0,
    latency_ms: record.latencyMs,
    cache_hit: record.cacheHit,
    ...(record.routeReason ? { route_reason: record.routeReason } : {}),
  };
}
