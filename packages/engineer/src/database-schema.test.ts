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
    ]) {
      expect(tables.has(table)).toBe(true);
    }
    expect(ENGINEER_DATABASE_SCHEMA_VERSION).toBe(2);
    db.close();
  });
});
