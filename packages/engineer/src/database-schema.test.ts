import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ENGINEER_DATABASE_SCHEMA_SQL, ENGINEER_DATABASE_SCHEMA_VERSION } from "./database-schema.js";

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
    expect(ENGINEER_DATABASE_SCHEMA_VERSION).toBe(11);
    db.close();
  });
});
