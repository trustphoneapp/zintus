import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENGINEER_DATABASE_SCHEMA_SQL, ENGINEER_DATABASE_SCHEMA_VERSION } from "./database-schema.js";
import { EngineerLedger } from "./ledger.js";

describe("Engineer database schema", () => {
  test("creates phase-1 and mandatory-correction records", () => {
    const db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys=ON");
    db.exec(ENGINEER_DATABASE_SCHEMA_SQL);
    const rows = db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
    const tables = new Set(rows.map((row) => row.name));
    for (const table of [
      "engineer_runs",
      "task_manifest_versions",
      "plan_proposals",
      "context_manifests",
      "context_sources",
      "context_warnings",
      "decisions",
      "decision_evidence",
      "decision_resolutions",
      "run_state_events",
      "risk_assessments",
      "retry_attempts",
      "failure_records",
      "reviewer_sessions",
      "review_findings",
      "git_operations",
      "model_routing_decisions",
      "warm_sandboxes",
      "audit_events",
      "run_budgets",
      "budget_events",
      "repository_admissions",
    ]) {
      expect(tables.has(table)).toBe(true);
    }
    const admissionColumns = new Set((db.query("PRAGMA table_info(repository_admissions)").all() as Array<{ name: string }>).map((row) => row.name));
    expect(admissionColumns.has("authorization_expires_at")).toBe(true);
    expect(admissionColumns.has("authorization_generation")).toBe(true);
    const runColumns = new Set((db.query("PRAGMA table_info(engineer_runs)").all() as Array<{ name: string }>).map((row) => row.name));
    expect(runColumns.has("last_error")).toBe(true);
    const costColumns = new Set((db.query("PRAGMA table_info(cost_records)").all() as Array<{ name: string }>).map((row) => row.name));
    expect(costColumns.has("reservation_status")).toBe(true);
    const budgetColumns = new Set((db.query("PRAGMA table_info(run_budgets)").all() as Array<{ name: string }>).map((row) => row.name));
    expect(budgetColumns.has("ambiguous_cost_usd")).toBe(true);
    expect(budgetColumns.has("ambiguous_tokens")).toBe(true);
    const sandboxIndexes = db.query("PRAGMA index_list(sandboxes)").all() as Array<{ name: string; unique: number }>;
    expect(sandboxIndexes.find((index) => index.name === "idx_sandboxes_run")?.unique).toBe(0);
    expect(ENGINEER_DATABASE_SCHEMA_VERSION).toBe(14);
    db.close();
  });

  test("migrates the legacy one-sandbox-per-run constraint to replacement sandbox history", () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-engineer-schema-v14-"));
    const dbPath = join(root, "engineer.db");
    const legacy = new Database(dbPath, { create: true });
    legacy.exec(ENGINEER_DATABASE_SCHEMA_SQL
      .replace(
        "run_id TEXT NOT NULL REFERENCES engineer_runs(id) ON DELETE RESTRICT,\n    workspace_identity TEXT NOT NULL UNIQUE,",
        "run_id TEXT NOT NULL UNIQUE REFERENCES engineer_runs(id) ON DELETE RESTRICT,\n    workspace_identity TEXT NOT NULL UNIQUE,",
      )
      .replace("  CREATE INDEX IF NOT EXISTS idx_sandboxes_run ON sandboxes(run_id, created_at);\n", ""));
    legacy.close();

    const ledger = new EngineerLedger(dbPath);
    ledger.close();
    const migrated = new Database(dbPath);
    const table = migrated.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sandboxes'")
      .get() as { sql: string };
    expect(table.sql).not.toMatch(/run_id\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i);
    const indexes = migrated.query("PRAGMA index_list(sandboxes)").all() as Array<{ name: string; unique: number }>;
    expect(indexes.find((index) => index.name === "idx_sandboxes_run")?.unique).toBe(0);
    expect(migrated.query("PRAGMA foreign_key_check").all()).toEqual([]);
    migrated.close();
    rmSync(root, { recursive: true, force: true });
  });
});
