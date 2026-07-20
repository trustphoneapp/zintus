import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ENGINEER_DATABASE_SCHEMA_SQL,
  ENGINEER_DATABASE_SCHEMA_VERSION,
} from "./database-schema.js";
import { migrateEngineerDatabase } from "./database-migrations.js";
import { sha256, sha256Bytes } from "./hash.js";
import { EngineerLedger } from "./ledger.js";
import { ReviewCaptureUnavailableError } from "./errors.js";
import { REQUIRED_LANE_REVIEWER_MAPPING_POLICY_VERSION } from "./required-lane-policy-versions.js";

// R8-1 immutability regression.
//
// This fixture is a HARDCODED, byte-literal copy of the migration-18 SQL as it
// GENUINELY SHIPPED — i.e. review_classification_batches WITHOUT the
// reviewer_input_json / normalized_output_json columns. It deliberately does
// NOT reference ENGINEER_DATABASE_MIGRATION_18_SQL: a real historical database
// created by the shipped v18 code has exactly this shape, and if a future edit
// re-mutates the migration-18 constant this literal must stay frozen so the
// regression stays honest. Do not "DRY" this against the live constant.
const ORIGINAL_SHIPPED_MIGRATION_18_SQL = `
  CREATE TABLE review_classification_batches (
    classification_hash TEXT PRIMARY KEY NOT NULL,
    reviewer_session_id TEXT NOT NULL UNIQUE REFERENCES reviewer_sessions(id) ON DELETE RESTRICT,
    run_id TEXT NOT NULL REFERENCES engineer_runs(id) ON DELETE RESTRICT,
    contract_hash TEXT NOT NULL REFERENCES required_lane_contracts(contract_hash) ON DELETE RESTRICT,
    schema_version INTEGER NOT NULL CHECK(schema_version = 1),
    policy_version TEXT NOT NULL,
    raw_output_artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE RESTRICT,
    raw_output_hash TEXT NOT NULL,
    normalized_output_hash TEXT NOT NULL,
    normalized_session_hash TEXT NOT NULL,
    normalized_findings_hash TEXT NOT NULL,
    batch_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE INDEX idx_review_classification_batches_run
    ON review_classification_batches(run_id, created_at);

  CREATE UNIQUE INDEX idx_review_findings_id_session_v18
    ON review_findings(id, reviewer_session_id);

  CREATE TABLE review_finding_classifications (
    classification_hash TEXT PRIMARY KEY NOT NULL,
    batch_hash TEXT NOT NULL,
    reviewer_session_id TEXT NOT NULL,
    finding_id TEXT NOT NULL,
    finding_fingerprint TEXT NOT NULL,
    disposition TEXT NOT NULL CHECK(disposition IN ('BLOCKING', 'HUMAN_REQUIRED', 'ADVISORY')),
    authority TEXT NOT NULL,
    reason_code TEXT NOT NULL,
    classification_json TEXT NOT NULL,
    UNIQUE(batch_hash, finding_id),
    FOREIGN KEY(batch_hash) REFERENCES review_classification_batches(classification_hash)
      ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY(finding_id, reviewer_session_id) REFERENCES review_findings(id, reviewer_session_id)
      ON DELETE RESTRICT
  );

  CREATE TRIGGER require_complete_review_classification_batch_v18
    BEFORE INSERT ON review_classification_batches BEGIN
      SELECT CASE WHEN
        (SELECT COUNT(*) FROM review_findings WHERE reviewer_session_id = NEW.reviewer_session_id) !=
        (SELECT COUNT(*) FROM review_finding_classifications WHERE batch_hash = NEW.classification_hash)
        OR EXISTS (
          SELECT 1 FROM review_findings f
          LEFT JOIN review_finding_classifications c
            ON c.finding_id = f.id AND c.reviewer_session_id = f.reviewer_session_id
              AND c.batch_hash = NEW.classification_hash
          WHERE f.reviewer_session_id = NEW.reviewer_session_id AND c.finding_id IS NULL
        )
      THEN RAISE(ABORT, 'review classification mapping is incomplete') END;
    END;
  CREATE TRIGGER prevent_sealed_review_classification_insert_v18
    BEFORE INSERT ON review_finding_classifications
    WHEN EXISTS (
      SELECT 1 FROM review_classification_batches WHERE classification_hash = NEW.batch_hash
    ) BEGIN
      SELECT RAISE(ABORT, 'sealed review classification batches cannot accept new findings');
    END;
  CREATE TRIGGER prevent_sealed_review_finding_insert_v18
    BEFORE INSERT ON review_findings
    WHEN EXISTS (
      SELECT 1 FROM review_classification_batches WHERE reviewer_session_id = NEW.reviewer_session_id
    ) BEGIN
      SELECT RAISE(ABORT, 'sealed review sessions cannot accept new findings');
    END;

  CREATE TRIGGER prevent_reviewer_sessions_update_v18
    BEFORE UPDATE ON reviewer_sessions BEGIN
      SELECT RAISE(ABORT, 'reviewer_sessions are immutable');
    END;
  CREATE TRIGGER prevent_reviewer_sessions_delete_v18
    BEFORE DELETE ON reviewer_sessions BEGIN
      SELECT RAISE(ABORT, 'reviewer_sessions are immutable');
    END;
  CREATE TRIGGER prevent_review_findings_update_v18
    BEFORE UPDATE ON review_findings BEGIN
      SELECT RAISE(ABORT, 'review_findings are immutable');
    END;
  CREATE TRIGGER prevent_review_findings_delete_v18
    BEFORE DELETE ON review_findings BEGIN
      SELECT RAISE(ABORT, 'review_findings are immutable');
    END;
  CREATE TRIGGER prevent_review_classification_batches_update_v18
    BEFORE UPDATE ON review_classification_batches BEGIN
      SELECT RAISE(ABORT, 'review classifications are immutable');
    END;
  CREATE TRIGGER prevent_review_classification_batches_delete_v18
    BEFORE DELETE ON review_classification_batches BEGIN
      SELECT RAISE(ABORT, 'review classifications are immutable');
    END;
  CREATE TRIGGER prevent_review_finding_classifications_update_v18
    BEFORE UPDATE ON review_finding_classifications BEGIN
      SELECT RAISE(ABORT, 'review finding classifications are immutable');
    END;
  CREATE TRIGGER prevent_review_finding_classifications_delete_v18
    BEFORE DELETE ON review_finding_classifications BEGIN
      SELECT RAISE(ABORT, 'review finding classifications are immutable');
    END;
`;

/**
 * Build a genuinely-shipped v18 database: base v14 schema, the immutable
 * migrations 15-17 applied by the real code, then the ORIGINAL migration-18 SQL
 * literal above (no reviewer_input_json / normalized_output_json). One historical
 * review_classification_batches row is seeded to prove the forward migration
 * preserves existing rows.
 */
function seedGenuinelyShippedV18Database(at: string): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(ENGINEER_DATABASE_SCHEMA_SQL);
  db.query("INSERT INTO schema_migrations(version, applied_at) VALUES (14, ?)").run(at);
  // Real, immutable migrations 15-17.
  migrateEngineerDatabase(db, at, 17);
  // The genuinely-shipped migration 18 (pre-mutation shape).
  db.exec(ORIGINAL_SHIPPED_MIGRATION_18_SQL);
  db.query("INSERT INTO schema_migrations(version, applied_at) VALUES (18, ?)").run(at);

  const contractHash = sha256("hist-contract");
  const classificationHash = sha256("hist-classification");
  db.query("INSERT INTO users(id, created_at, updated_at) VALUES ('hist-user', ?, ?)").run(at, at);
  db.query(`INSERT INTO repository_connections
    (id, user_id, provider, owner, name, created_at, updated_at)
    VALUES ('hist-repo', 'hist-user', 'local', 'local', 'hist', ?, ?)`).run(at, at);
  db.query(`INSERT INTO engineer_runs
    (id, user_id, repository_id, base_branch, base_commit_sha, request_original, request_normalized,
     state, state_version, manifest_hash, risk_tier, human_gate_required, created_at, updated_at)
    VALUES ('hist-run', 'hist-user', 'hist-repo', 'main', ?, 'request', 'request',
      'REVIEW_APPROVED', 1, ?, 'LOW', 1, ?, ?)`).run("a".repeat(40), sha256("hist-manifest"), at, at);
  db.query(`INSERT INTO task_manifest_versions
    (id, run_id, version, manifest_hash, manifest_json, created_at)
    VALUES ('hist-manifest-id', 'hist-run', 1, ?, '{}', ?)`).run(sha256("hist-manifest"), at);
  db.query(`INSERT INTO required_lane_contracts
    (contract_hash, run_id, manifest_hash, schema_version, contract_json, created_at)
    VALUES (?, 'hist-run', ?, 1, '{}', ?)`).run(contractHash, sha256("hist-manifest"), at);
  db.query(`INSERT INTO artifacts
    (id, run_id, type, sha256, producer_type, producer_id, storage_reference, size_bytes, trusted, created_at)
    VALUES ('hist-raw', 'hist-run', 'REVIEWER_RAW_OUTPUT', ?, 'SYSTEM', 'reviewer', '/tmp/raw', 1, 1, ?)`).run(sha256("raw"), at);
  db.query(`INSERT INTO reviewer_sessions
    (id, run_id, attempt, model_tier, resolved_model, input_hash, manifest_hash, diff_hash,
     evidence_bundle_hash, policy_version, cache_key, cache_hit, cache_observed, started_at, completed_at,
     decision, isolation_verified)
    VALUES ('hist-reviewer', 'hist-run', 1, 'GPT-5.6_SOL', 'gpt-5.6', ?, ?, ?, ?,
      'review-v1', ?, 0, 1, ?, ?, 'APPROVE', 1)`).run(
        sha256("input"), sha256("hist-manifest"), sha256("diff"), sha256("evidence"), sha256("cache"), at, at,
      );
  // Historical batch row in the ORIGINAL 13-column shape (no json columns). This
  // reviewer session has zero findings, so the completeness trigger passes.
  db.query(`INSERT INTO review_classification_batches
    (classification_hash, reviewer_session_id, run_id, contract_hash, schema_version, policy_version,
     raw_output_artifact_id, raw_output_hash, normalized_output_hash, normalized_session_hash,
     normalized_findings_hash, batch_json, created_at)
    VALUES (?, 'hist-reviewer', 'hist-run', ?, 1, 'mapping-v1', 'hist-raw', ?, ?, ?, ?, ?, ?)`)
    .run(classificationHash, contractHash, sha256("raw"), sha256("normalized"), sha256("session"), sha256("findings"),
      JSON.stringify({ result: "READY" }), at);
  return db;
}

describe("migration 18 immutability", () => {
  test("original shipped v18 database (no json columns) upgrades cleanly on current code", () => {
    const at = "2026-07-19T00:00:00.000Z";
    const db = seedGenuinelyShippedV18Database(at);
    // Sanity: the seeded historical table genuinely lacks the mutated columns.
    const seededColumns = new Set((db.query("PRAGMA table_info(review_classification_batches)").all() as Array<{ name: string }>)
      .map((row) => row.name));
    expect(seededColumns.has("reviewer_input_json")).toBe(false);
    expect(seededColumns.has("normalized_output_json")).toBe(false);

    // The gateway open path: run every forward migration on the historical DB.
    // On pre-fix code this THROWS (the validator demands columns the shipped v18
    // never created); the fix must let it upgrade to head.
    expect(() => migrateEngineerDatabase(db, at)).not.toThrow();

    expect(db.query("SELECT MAX(version) AS version FROM schema_migrations").get())
      .toEqual({ version: ENGINEER_DATABASE_SCHEMA_VERSION });

    const upgradedColumns = new Set((db.query("PRAGMA table_info(review_classification_batches)").all() as Array<{ name: string }>)
      .map((row) => row.name));
    expect(upgradedColumns.has("reviewer_input_json")).toBe(true);
    expect(upgradedColumns.has("normalized_output_json")).toBe(true);

    // The historical row survives the forward migration.
    const row = db.query(`SELECT classification_hash, reviewer_input_json, normalized_output_json, batch_json
      FROM review_classification_batches WHERE reviewer_session_id = 'hist-reviewer'`).get() as {
        classification_hash: string; reviewer_input_json: string; normalized_output_json: string; batch_json: string;
      } | null;
    expect(row).not.toBeNull();
    expect(row!.classification_hash).toBe(sha256("hist-classification"));
    expect(row!.batch_json).toBe(JSON.stringify({ result: "READY" }));
    // Pre-existing rows carry the documented empty sentinel for the added columns.
    expect(row!.reviewer_input_json).toBe("");
    expect(row!.normalized_output_json).toBe("");
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    db.close();
  });
});

/**
 * Seed a file-backed genuinely-shipped v18 database whose review_classification_batches
 * row is a COMPLETE, schema-valid classification (valid batch_json, matching artifact,
 * schema_version=2 required-lane contract) recorded in the ORIGINAL 13-column shape via
 * the same frozen migration-18 literal above. This is exactly the durable footprint a
 * real v18 database held: a fully valid batch that simply predates the reviewer-input /
 * normalized-output columns. Returns the artifact bytes so the replay path's artifact
 * binding is satisfiable and the guard (not an upstream check) is what fires.
 */
function seedHistoricalReplayableV18Ledger(at: string): { dbPath: string; rawBytes: Buffer; reviewerSessionId: string } {
  const root = mkdtempSync(join(tmpdir(), "zintus-v18-replay-"));
  const dbPath = join(root, "engineer.sqlite");
  const db = new Database(dbPath);
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(ENGINEER_DATABASE_SCHEMA_SQL);
  db.query("INSERT INTO schema_migrations(version, applied_at) VALUES (14, ?)").run(at);
  migrateEngineerDatabase(db, at, 17);
  db.exec(ORIGINAL_SHIPPED_MIGRATION_18_SQL);
  db.query("INSERT INTO schema_migrations(version, applied_at) VALUES (18, ?)").run(at);

  const manifestHash = sha256("hist-replay-manifest");
  const contractHash = sha256("hist-replay-contract");
  const rawBytes = Buffer.from("historical reviewer raw output — predates v38 capture");
  const rawSha = sha256Bytes(rawBytes);
  const batchContent = {
    schemaVersion: 1 as const,
    policyVersion: REQUIRED_LANE_REVIEWER_MAPPING_POLICY_VERSION,
    runId: "hist-run",
    reviewerSessionId: "hist-reviewer",
    contractHash,
    manifestHash,
    rawOutput: { artifactId: "hist-raw", sha256: rawSha, byteLength: rawBytes.byteLength, mediaType: "application/json" as const },
    normalizedOutputHash: sha256("hist-normalized-output"),
    normalizedSessionHash: sha256("hist-normalized-session"),
    normalizedFindingsHash: sha256("hist-normalized-findings"),
    trustedEvidenceIdentityHash: sha256("hist-trusted-evidence"),
    provenanceConflict: false,
    systemGateReasons: [] as string[],
    requiredTestGates: [] as unknown[],
    result: "READY" as const,
    classifications: [] as unknown[],
    createdAt: at,
  };
  const batch = { ...batchContent, classificationHash: sha256(batchContent) };
  const batchJson = JSON.stringify(batch);

  db.query("INSERT INTO users(id, created_at, updated_at) VALUES ('hist-user', ?, ?)").run(at, at);
  db.query(`INSERT INTO repository_connections
    (id, user_id, provider, owner, name, created_at, updated_at)
    VALUES ('hist-repo', 'hist-user', 'local', 'local', 'hist', ?, ?)`).run(at, at);
  db.query(`INSERT INTO engineer_runs
    (id, user_id, repository_id, base_branch, base_commit_sha, request_original, request_normalized,
     state, state_version, manifest_hash, risk_tier, human_gate_required, created_at, updated_at)
    VALUES ('hist-run', 'hist-user', 'hist-repo', 'main', ?, 'request', 'request',
      'REVIEW_APPROVED', 1, ?, 'LOW', 1, ?, ?)`).run("a".repeat(40), manifestHash, at, at);
  db.query(`INSERT INTO task_manifest_versions
    (id, run_id, version, manifest_hash, manifest_json, created_at)
    VALUES ('hist-manifest-id', 'hist-run', 1, ?, '{}', ?)`).run(manifestHash, at);
  // getReviewClassification binds the batch to a schema_version=2 required-lane contract.
  db.query(`INSERT INTO required_lane_contracts
    (contract_hash, run_id, manifest_hash, schema_version, contract_json, created_at)
    VALUES (?, 'hist-run', ?, 2, '{}', ?)`).run(contractHash, manifestHash, at);
  db.query(`INSERT INTO artifacts
    (id, run_id, type, sha256, producer_type, producer_id, storage_reference, size_bytes, trusted, created_at)
    VALUES ('hist-raw', 'hist-run', 'REVIEWER_RAW_OUTPUT', ?, 'SYSTEM', 'reviewer', ?, ?, 1, ?)`)
    .run(rawSha, join(root, "missing-raw"), rawBytes.byteLength, at);
  db.query(`INSERT INTO reviewer_sessions
    (id, run_id, attempt, model_tier, resolved_model, input_hash, manifest_hash, diff_hash,
     evidence_bundle_hash, policy_version, cache_key, cache_hit, cache_observed, started_at, completed_at,
     decision, isolation_verified)
    VALUES ('hist-reviewer', 'hist-run', 1, 'GPT-5.6_SOL', 'gpt-5.6', ?, ?, ?, ?,
      'review-v1', ?, 0, 1, ?, ?, 'APPROVE', 1)`).run(
        sha256("input"), manifestHash, sha256("diff"), sha256("evidence"), sha256("cache"), at, at,
      );
  db.query(`INSERT INTO review_classification_batches
    (classification_hash, reviewer_session_id, run_id, contract_hash, schema_version, policy_version,
     raw_output_artifact_id, raw_output_hash, normalized_output_hash, normalized_session_hash,
     normalized_findings_hash, batch_json, created_at)
    VALUES (?, 'hist-reviewer', 'hist-run', ?, 1, ?, 'hist-raw', ?, ?, ?, ?, ?, ?)`)
    .run(batch.classificationHash, contractHash, batch.policyVersion, rawSha,
      batch.normalizedOutputHash, batch.normalizedSessionHash, batch.normalizedFindingsHash, batchJson, at);
  db.close();
  return { dbPath, rawBytes, reviewerSessionId: "hist-reviewer" };
}

describe("v38 pre-capture replay guard", () => {
  test("replaying a genuinely-shipped v18 classification fails with a controlled typed error, not a raw JSON.parse crash", () => {
    const at = "2026-07-19T00:00:00.000Z";
    const { dbPath, rawBytes, reviewerSessionId } = seedHistoricalReplayableV18Ledger(at);
    // Opening the ledger runs the full chain to head (v38), turning the never-captured
    // columns into the '' sentinel. All upstream bindings (batch_json, artifact, contract,
    // session) are valid, so the ONLY thing standing between us and a crash is the guard.
    const ledger = new EngineerLedger(dbPath, () => new Date(at));
    try {
      let thrown: unknown;
      try {
        ledger.getReviewClassification(reviewerSessionId, () => rawBytes);
      } catch (error) {
        thrown = error;
      }
      // Must be the controlled, typed, corruption-distinguishable error — NOT a raw
      // SyntaxError ("Unexpected end of JSON input") from JSON.parse('').
      expect(thrown).toBeInstanceOf(ReviewCaptureUnavailableError);
      expect(thrown).not.toBeInstanceOf(SyntaxError);
      expect((thrown as ReviewCaptureUnavailableError).code).toBe("ENGINEER_REVIEW_CAPTURE_PREDATES_V38");
      expect((thrown as ReviewCaptureUnavailableError).reviewerSessionId).toBe(reviewerSessionId);
      expect((thrown as Error).message).toMatch(/predates.*capture.*v38|cannot be replayed/i);
    } finally {
      ledger.close();
      rmSync(dbPath.replace(/engineer\.sqlite$/, ""), { recursive: true, force: true });
    }
  });
});
