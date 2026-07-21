-- Exact sanitized review-classification objects observed in the installed
-- single-organization pilot database at schema v18 on 2026-07-20.
-- Deliberately absent: raw_output_artifact_id FK, per-finding mapping table,
-- mapping completeness/sealing triggers, and v38 JSON columns.

CREATE TABLE review_classification_batches (
  classification_hash TEXT PRIMARY KEY NOT NULL,
  reviewer_session_id TEXT NOT NULL UNIQUE REFERENCES reviewer_sessions(id) ON DELETE RESTRICT,
  run_id TEXT NOT NULL REFERENCES engineer_runs(id) ON DELETE RESTRICT,
  contract_hash TEXT NOT NULL REFERENCES required_lane_contracts(contract_hash) ON DELETE RESTRICT,
  schema_version INTEGER NOT NULL CHECK(schema_version = 1),
  policy_version TEXT NOT NULL,
  raw_output_artifact_id TEXT NOT NULL,
  raw_output_hash TEXT NOT NULL,
  normalized_output_hash TEXT NOT NULL,
  normalized_session_hash TEXT NOT NULL,
  normalized_findings_hash TEXT NOT NULL,
  batch_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_review_classification_batches_run
  ON review_classification_batches(run_id, created_at);

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
