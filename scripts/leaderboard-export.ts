#!/usr/bin/env bun
/**
 * Anonymized leaderboard export (P1 "inverted data moat" seed —
 * docs/audit/2026-07-02/openrouter-manus-plan.md §4).
 *
 * Reads the LOCAL quota ledger (`usage_log` in quota.db) and emits per
 * (provider, model) aggregates: request count, success rate, latency
 * p50/p95, tokens served. NOTHING identifying leaves the aggregates — no
 * prompts, no keys, no thread ids, no timestamps finer than the window edges.
 * Inspect the JSON yourself before sharing it anywhere.
 *
 * DELIBERATELY LOCAL-ONLY for now: there is no upload. When the community
 * leaderboard ingest exists (relay-hosted, opt-in — see
 * docs/LEADERBOARD-DESIGN.md), `zintus stats share` will POST exactly this
 * document, gated on an explicit `telemetry.leaderboard: true` opt-in.
 *
 * Usage:
 *   bun run scripts/leaderboard-export.ts [--db ~/.zintus/quota.db] [--days 30]
 */
import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
function flag(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

const dbPath = flag("db") ?? join(homedir(), ".zintus", "quota.db");
const days = Number(flag("days") ?? 30);
const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;

let db: Database;
try {
  db = new Database(dbPath, { readonly: true });
} catch {
  console.error(`No ledger at ${dbPath} — start the gateway once, or pass --db.`);
  process.exit(2);
}

interface Row {
  provider_id: string;
  model: string | null;
  n: number;
  ok: number;
  tokens_in: number;
  tokens_out: number;
}

const rows = db
  .query<Row, [number]>(
    `SELECT provider_id, model,
            COUNT(*) AS n,
            SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS ok,
            SUM(tokens_in) AS tokens_in,
            SUM(tokens_out) AS tokens_out
       FROM usage_log
      WHERE timestamp >= ?
      GROUP BY provider_id, model
      ORDER BY n DESC`,
  )
  .all(sinceMs);

/** p-quantile of successful-request latency for one (provider, model). */
function latencyQuantile(provider: string, model: string | null, p: number): number | null {
  const latencies = db
    .query<{ latency_ms: number }, [string, string | null, number]>(
      `SELECT latency_ms FROM usage_log
        WHERE provider_id = ? AND model IS ? AND timestamp >= ?
          AND status = 'success' AND latency_ms IS NOT NULL
        ORDER BY latency_ms`,
    )
    .all(provider, model, sinceMs)
    .map((r) => r.latency_ms);
  if (latencies.length === 0) return null;
  const idx = Math.min(latencies.length - 1, Math.floor(p * latencies.length));
  return latencies[idx] ?? null;
}

const doc = {
  schema: "zintus.leaderboard.v1",
  // Coarse window only — never precise event times.
  windowDays: days,
  generatedAt: new Date().toISOString().slice(0, 10),
  entries: rows.map((r) => ({
    provider: r.provider_id,
    model: r.model,
    requests: r.n,
    successRate: r.n > 0 ? Number((r.ok / r.n).toFixed(4)) : null,
    latencyP50Ms: latencyQuantile(r.provider_id, r.model, 0.5),
    latencyP95Ms: latencyQuantile(r.provider_id, r.model, 0.95),
    tokensIn: r.tokens_in,
    tokensOut: r.tokens_out,
  })),
};

console.log(JSON.stringify(doc, null, 2));
