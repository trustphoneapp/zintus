import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import {
  ENGINEER_DATABASE_SCHEMA_SQL,
  ENGINEER_DATABASE_SCHEMA_VERSION,
} from "./database-schema.js";
import { migrateEngineerDatabase } from "./database-migrations.js";

const DEPLOYED_V18_SQL = readFileSync(new URL(
  "../../../docs/zintus-engineer/release-15h/archive/historical-fixtures/deployed-v18-review-classification.sql",
  import.meta.url,
), "utf8");

function exactDeployedV18Database(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(ENGINEER_DATABASE_SCHEMA_SQL);
  db.query("INSERT INTO schema_migrations(version, applied_at) VALUES (14, ?)")
    .run("2026-07-20T00:00:00.000Z");
  migrateEngineerDatabase(db, "2026-07-20T00:00:00.000Z", 17);
  db.exec(DEPLOYED_V18_SQL);
  db.query("INSERT INTO schema_migrations(version, applied_at) VALUES (18, ?)")
    .run("2026-07-20T00:00:00.000Z");
  return db;
}

describe("deployed v18 compatibility bridge", () => {
  test("upgrades the exact empty-batch installed shape and records the exceptional bridge", () => {
    const db = exactDeployedV18Database();
    expect(db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='review_finding_classifications'").get())
      .toBeNull();
    expect((db.query("PRAGMA foreign_key_list(review_classification_batches)").all() as Array<{ table: string }>)
      .some((row) => row.table === "artifacts")).toBe(false);

    migrateEngineerDatabase(db, "2026-07-20T01:00:00.000Z");

    expect(db.query("SELECT MAX(version) AS version FROM schema_migrations").get())
      .toEqual({ version: ENGINEER_DATABASE_SCHEMA_VERSION });
    expect(db.query("SELECT id, source_version FROM engineer_compatibility_migrations").all()).toEqual([{
      id: "deployed-v18-review-mapping-v1",
      source_version: 18,
    }]);
    expect(db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='review_finding_classifications'").get())
      .toEqual({ name: "review_finding_classifications" });
    expect(db.query("PRAGMA quick_check").all()).toEqual([{ quick_check: "ok" }]);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    db.close();
  });

  test("does not create bridge metadata for the canonical migration chain", () => {
    const db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys=ON");
    db.exec(ENGINEER_DATABASE_SCHEMA_SQL);
    db.query("INSERT INTO schema_migrations(version, applied_at) VALUES (14, ?)")
      .run("2026-07-20T00:00:00.000Z");
    migrateEngineerDatabase(db, "2026-07-20T00:00:00.000Z");
    expect(db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='engineer_compatibility_migrations'").get())
      .toBeNull();
    db.close();
  });
});
