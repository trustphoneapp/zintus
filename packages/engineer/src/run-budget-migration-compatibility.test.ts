import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ENGINEER_DATABASE_SCHEMA_SQL } from "./database-schema.js";
import { migrateEngineerDatabase } from "./database-migrations.js";
import { sha256 } from "./hash.js";

describe("v25 run-budget compatibility", () => {
  test("preserves a populated legacy ALTER-appended column order by explicit name", () => {
    const at = "2026-07-20T00:00:00.000Z";
    const db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys=ON");
    db.exec(ENGINEER_DATABASE_SCHEMA_SQL);
    db.query("INSERT INTO schema_migrations(version, applied_at) VALUES (14, ?)").run(at);
    migrateEngineerDatabase(db, at, 24);
    db.query("INSERT INTO users(id, created_at, updated_at) VALUES ('budget-user', ?, ?)").run(at, at);
    db.query(`INSERT INTO repository_connections
      (id, user_id, provider, owner, name, created_at, updated_at)
      VALUES ('budget-repo', 'budget-user', 'local', 'local', 'budget', ?, ?)`).run(at, at);
    db.query(`INSERT INTO engineer_runs
      (id, user_id, repository_id, base_branch, base_commit_sha, request_original, request_normalized,
       state, state_version, manifest_hash, risk_tier, human_gate_required, created_at, updated_at)
      VALUES ('budget-run', 'budget-user', 'budget-repo', 'main', ?, 'request', 'request',
       'BUDGET_PAUSED', 1, ?, 'LOW', 1, ?, ?)`).run("a".repeat(40), sha256("budget-manifest"), at, at);
    db.query(`INSERT INTO run_budgets
      (run_id,cost_limit_usd,token_limit,time_limit_seconds,lifetime_cost_limit_usd,lifetime_token_limit,
       lifetime_time_limit_seconds,used_cost_usd,used_tokens,used_time_seconds,reserved_cost_usd,reserved_tokens,
       ambiguous_cost_usd,ambiguous_tokens,status,pause_reason,resume_state,warning_threshold,revision,active_since,
       created_at,updated_at)
      VALUES ('budget-run',2,20000,120,4,40000,240,1.25,12000,60,0.5,4000,0.25,2000,
       'PAUSED','COST','IMPLEMENTING',0.8,3,?,?,?)`).run(at, at, at);

    // Recreate the exact legacy order: ambiguity columns were appended later,
    // after updated_at. A positional SELECT * maps these values incorrectly.
    db.exec("PRAGMA foreign_keys=OFF");
    db.run(`CREATE TABLE run_budgets_legacy (
      run_id TEXT PRIMARY KEY REFERENCES engineer_runs(id) ON DELETE RESTRICT,
      cost_limit_usd REAL NOT NULL, token_limit INTEGER NOT NULL, time_limit_seconds INTEGER NOT NULL,
      lifetime_cost_limit_usd REAL NOT NULL, lifetime_token_limit INTEGER NOT NULL,
      lifetime_time_limit_seconds INTEGER NOT NULL, used_cost_usd REAL NOT NULL, used_tokens INTEGER NOT NULL,
      used_time_seconds INTEGER NOT NULL, reserved_cost_usd REAL NOT NULL, reserved_tokens INTEGER NOT NULL,
      status TEXT NOT NULL, pause_reason TEXT, resume_state TEXT, warning_threshold REAL NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1, active_since TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      ambiguous_cost_usd REAL NOT NULL DEFAULT 0, ambiguous_tokens INTEGER NOT NULL DEFAULT 0
    )`);
    const legacyOrder = [
      "run_id","cost_limit_usd","token_limit","time_limit_seconds","lifetime_cost_limit_usd","lifetime_token_limit",
      "lifetime_time_limit_seconds","used_cost_usd","used_tokens","used_time_seconds","reserved_cost_usd","reserved_tokens",
      "status","pause_reason","resume_state","warning_threshold","revision","active_since","created_at","updated_at",
      "ambiguous_cost_usd","ambiguous_tokens",
    ].join(",");
    db.run(`INSERT INTO run_budgets_legacy (${legacyOrder}) SELECT ${legacyOrder} FROM run_budgets`);
    db.run("DROP TABLE run_budgets");
    db.run("ALTER TABLE run_budgets_legacy RENAME TO run_budgets");
    db.exec("PRAGMA foreign_keys=ON");

    migrateEngineerDatabase(db, "2026-07-20T01:00:00.000Z", 25);

    expect(db.query(`SELECT run_id,status,pause_reason,resume_state,revision,used_cost_usd,reserved_cost_usd,
      ambiguous_cost_usd,ambiguous_tokens FROM run_budgets`).all()).toEqual([{
        run_id: "budget-run", status: "PAUSED", pause_reason: "COST", resume_state: "IMPLEMENTING", revision: 3,
        used_cost_usd: 1.25, reserved_cost_usd: 0.5, ambiguous_cost_usd: 0.25, ambiguous_tokens: 2000,
      }]);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    db.close();
  });
});
