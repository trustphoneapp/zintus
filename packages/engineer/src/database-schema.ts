export const ENGINEER_DATABASE_BASE_SCHEMA_VERSION = 14;
export const ENGINEER_DATABASE_SCHEMA_VERSION = 31;

/**
 * Phase-1 creates the complete record namespace required by the specification.
 * Later phases add repositories and methods around these tables; they must not
 * repurpose or weaken the keys established here.
 */
export const ENGINEER_DATABASE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS repository_connections (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    provider TEXT NOT NULL,
    owner TEXT NOT NULL,
    name TEXT NOT NULL,
    url TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(user_id, provider, owner, name)
  );

  -- A connection row can be created while receiving a run and is therefore
  -- never an authorization fact. Only server-authenticated connector/config
  -- code may create an ACTIVE admission in this separate registry.
  CREATE TABLE IF NOT EXISTS repository_admissions (
    admission_id TEXT PRIMARY KEY,
    repository_id TEXT NOT NULL REFERENCES repository_connections(id) ON DELETE RESTRICT,
    owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    base_branch TEXT NOT NULL,
    base_commit_sha TEXT NOT NULL,
    source TEXT NOT NULL CHECK(source IN ('CONFIGURED_CANONICAL', 'CONNECTOR_AUTHORIZED')),
    authorization_subject TEXT NOT NULL,
    authorization_evidence_hash TEXT NOT NULL,
    authorization_expires_at TEXT,
    authorization_generation INTEGER NOT NULL DEFAULT 1 CHECK(authorization_generation > 0),
    status TEXT NOT NULL CHECK(status IN ('ACTIVE', 'REVOKED')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(owner_user_id, repository_id)
  );
  CREATE INDEX IF NOT EXISTS idx_repository_admissions_owner_status
    ON repository_admissions(owner_user_id, status);

  CREATE TABLE IF NOT EXISTS engineer_runs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    repository_id TEXT NOT NULL REFERENCES repository_connections(id) ON DELETE RESTRICT,
    base_branch TEXT NOT NULL,
    base_commit_sha TEXT NOT NULL,
    request_original TEXT NOT NULL,
    request_normalized TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL,
    state_version INTEGER NOT NULL DEFAULT 0 CHECK(state_version >= 0),
    manifest_hash TEXT,
    risk_tier TEXT NOT NULL,
    human_gate_required INTEGER NOT NULL CHECK(human_gate_required IN (0, 1)),
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    terminal_at TEXT
  );

  CREATE TABLE IF NOT EXISTS task_manifest_versions (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES engineer_runs(id) ON DELETE RESTRICT,
    version INTEGER NOT NULL CHECK(version > 0),
    manifest_hash TEXT NOT NULL,
    manifest_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(run_id, version),
    UNIQUE(run_id, manifest_hash)
  );

  CREATE TABLE IF NOT EXISTS plan_proposals (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES engineer_runs(id) ON DELETE RESTRICT,
    proposal_json TEXT NOT NULL,
    planning_analysis_json TEXT,
    proposal_hash TEXT NOT NULL,
    context_manifest_hash TEXT,
    artifact_id TEXT REFERENCES artifacts(id) ON DELETE RESTRICT,
    created_at TEXT NOT NULL,
    UNIQUE(run_id, proposal_hash),
    FOREIGN KEY(context_manifest_hash) REFERENCES context_manifests(manifest_hash) ON DELETE RESTRICT
  );

  CREATE TABLE IF NOT EXISTS context_manifests (
    manifest_hash TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES engineer_runs(id) ON DELETE RESTRICT,
    repository_id TEXT NOT NULL REFERENCES repository_connections(id) ON DELETE RESTRICT,
    base_commit_sha TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    manifest_json TEXT NOT NULL,
    artifact_id TEXT REFERENCES artifacts(id) ON DELETE RESTRICT,
    created_at TEXT NOT NULL,
    UNIQUE(run_id, manifest_hash),
    UNIQUE(run_id)
  );

  CREATE TABLE IF NOT EXISTS context_sources (
    source_id TEXT PRIMARY KEY,
    manifest_hash TEXT NOT NULL REFERENCES context_manifests(manifest_hash) ON DELETE RESTRICT,
    run_id TEXT NOT NULL REFERENCES engineer_runs(id) ON DELETE RESTRICT,
    path TEXT NOT NULL,
    kind TEXT NOT NULL,
    trust TEXT NOT NULL,
    object_id TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    byte_size INTEGER NOT NULL CHECK(byte_size >= 0),
    excerpt_truncated INTEGER NOT NULL CHECK(excerpt_truncated IN (0, 1)),
    source_json TEXT NOT NULL,
    UNIQUE(manifest_hash, path)
  );

  CREATE TABLE IF NOT EXISTS context_warnings (
    warning_id TEXT PRIMARY KEY,
    manifest_hash TEXT NOT NULL REFERENCES context_manifests(manifest_hash) ON DELETE RESTRICT,
    run_id TEXT NOT NULL REFERENCES engineer_runs(id) ON DELETE RESTRICT,
    code TEXT NOT NULL,
    path TEXT,
    source_id TEXT,
    trust TEXT NOT NULL,
    warning_json TEXT NOT NULL,
    FOREIGN KEY(source_id) REFERENCES context_sources(source_id) ON DELETE RESTRICT
  );

  CREATE TABLE IF NOT EXISTS decisions (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES engineer_runs(id) ON DELETE RESTRICT,
    decision_hash TEXT NOT NULL,
    classification TEXT NOT NULL CHECK(classification IN ('ASK_NOW', 'DEFER', 'AUTO')),
    policy_version TEXT NOT NULL,
    requested_state TEXT NOT NULL,
    resume_action TEXT NOT NULL CHECK(resume_action IN ('NONE', 'PLAN', 'REPLAN')),
    decision_json TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(id, run_id),
    UNIQUE(run_id, decision_hash),
    UNIQUE(run_id, idempotency_key)
  );

  CREATE TABLE IF NOT EXISTS decision_evidence (
    decision_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    evidence_id TEXT NOT NULL,
    evidence_run_id TEXT NOT NULL,
    source_type TEXT NOT NULL,
    trust TEXT NOT NULL,
    summary TEXT NOT NULL,
    PRIMARY KEY(decision_id, evidence_id),
    FOREIGN KEY(decision_id, run_id) REFERENCES decisions(id, run_id) ON DELETE RESTRICT,
    CHECK(run_id = evidence_run_id)
  );

  CREATE TABLE IF NOT EXISTS decision_resolutions (
    id TEXT PRIMARY KEY,
    decision_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    resolution_hash TEXT NOT NULL,
    selected_option_id TEXT NOT NULL,
    actor_type TEXT NOT NULL CHECK(actor_type IN ('HUMAN', 'SUPERVISOR')),
    actor_id TEXT NOT NULL,
    policy_version TEXT NOT NULL,
    resolution_json TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    resolved_at TEXT NOT NULL,
    FOREIGN KEY(decision_id, run_id) REFERENCES decisions(id, run_id) ON DELETE RESTRICT,
    UNIQUE(decision_id),
    UNIQUE(run_id, resolution_hash),
    UNIQUE(run_id, idempotency_key)
  );

  CREATE TABLE IF NOT EXISTS run_state_events (
    event_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES engineer_runs(id) ON DELETE RESTRICT,
    sequence INTEGER NOT NULL CHECK(sequence > 0),
    previous_state TEXT NOT NULL,
    next_state TEXT NOT NULL,
    reason_code TEXT NOT NULL,
    actor_type TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    evidence_ids_json TEXT NOT NULL,
    manifest_hash TEXT,
    state_version INTEGER NOT NULL CHECK(state_version > 0),
    idempotency_key TEXT NOT NULL,
    UNIQUE(run_id, sequence),
    UNIQUE(run_id, state_version),
    UNIQUE(run_id, idempotency_key)
  );

  CREATE TABLE IF NOT EXISTS acceptance_criteria (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES engineer_runs(id) ON DELETE RESTRICT,
    manifest_hash TEXT NOT NULL,
    criterion_id TEXT NOT NULL,
    statement TEXT NOT NULL,
    verification_method TEXT NOT NULL,
    priority TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(run_id, manifest_hash, criterion_id),
    FOREIGN KEY(run_id, manifest_hash)
      REFERENCES task_manifest_versions(run_id, manifest_hash) ON DELETE RESTRICT
  );

  CREATE TABLE IF NOT EXISTS agent_executions (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES engineer_runs(id) ON DELETE RESTRICT,
    role TEXT NOT NULL,
    model_tier TEXT NOT NULL,
    status TEXT NOT NULL,
    input_hash TEXT,
    output_artifact_id TEXT,
    started_at TEXT NOT NULL,
    completed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS model_calls (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES engineer_runs(id) ON DELETE RESTRICT,
    agent_execution_id TEXT REFERENCES agent_executions(id) ON DELETE RESTRICT,
    logical_tier TEXT NOT NULL,
    resolved_model TEXT NOT NULL,
    prompt_template_version TEXT NOT NULL,
    input_context_refs_json TEXT NOT NULL,
    output_schema_version TEXT,
    cache_key TEXT,
    cache_hit INTEGER CHECK(cache_hit IN (0, 1)),
    latency_ms INTEGER,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cached_input_tokens INTEGER,
    cache_write_input_tokens INTEGER,
    retry_count INTEGER NOT NULL DEFAULT 0,
    budget_reservation_id TEXT,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sandboxes (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES engineer_runs(id) ON DELETE RESTRICT,
    workspace_identity TEXT NOT NULL UNIQUE,
    image_digest TEXT NOT NULL,
    environment_digest TEXT,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    destroyed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_sandboxes_run ON sandboxes(run_id, created_at);

  CREATE TABLE IF NOT EXISTS sandbox_heartbeats (
    id TEXT PRIMARY KEY,
    sandbox_id TEXT NOT NULL REFERENCES sandboxes(id) ON DELETE CASCADE,
    observed_at TEXT NOT NULL,
    status TEXT NOT NULL,
    UNIQUE(sandbox_id, observed_at)
  );

  CREATE TABLE IF NOT EXISTS command_executions (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES engineer_runs(id) ON DELETE RESTRICT,
    sandbox_id TEXT NOT NULL REFERENCES sandboxes(id) ON DELETE RESTRICT,
    command TEXT NOT NULL,
    executor_id TEXT NOT NULL,
    exit_code INTEGER,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    stdout_artifact_id TEXT,
    stderr_artifact_id TEXT,
    environment_digest TEXT NOT NULL,
    commit_sha TEXT NOT NULL,
    status TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    UNIQUE(run_id, idempotency_key)
  );

  CREATE TABLE IF NOT EXISTS artifacts (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES engineer_runs(id) ON DELETE RESTRICT,
    type TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    producer_type TEXT NOT NULL,
    producer_id TEXT NOT NULL,
    storage_reference TEXT NOT NULL,
    size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
    trusted INTEGER NOT NULL CHECK(trusted IN (0, 1)),
    created_at TEXT NOT NULL,
    UNIQUE(run_id, sha256, type)
  );

  CREATE TABLE IF NOT EXISTS evidence_bundles (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES engineer_runs(id) ON DELETE RESTRICT,
    manifest_hash TEXT NOT NULL,
    bundle_hash TEXT NOT NULL,
    base_commit_sha TEXT NOT NULL,
    result_commit_sha TEXT NOT NULL,
    environment_digest TEXT NOT NULL,
    manifest_json TEXT NOT NULL,
    final_decision TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(run_id, bundle_hash)
  );

  CREATE TABLE IF NOT EXISTS claim_evidence (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES engineer_runs(id) ON DELETE RESTRICT,
    criterion_id TEXT,
    claim TEXT NOT NULL,
    status TEXT NOT NULL,
    evidence_ids_json TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS test_executions (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES engineer_runs(id) ON DELETE RESTRICT,
    command_execution_id TEXT NOT NULL REFERENCES command_executions(id) ON DELETE RESTRICT,
    type TEXT NOT NULL,
    verification_pass INTEGER NOT NULL DEFAULT 1,
    random_seed TEXT,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    completed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS test_results (
    id TEXT PRIMARY KEY,
    test_execution_id TEXT NOT NULL REFERENCES test_executions(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    status TEXT NOT NULL,
    duration_ms INTEGER,
    artifact_id TEXT REFERENCES artifacts(id) ON DELETE RESTRICT
  );

  CREATE TABLE IF NOT EXISTS security_findings (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES engineer_runs(id) ON DELETE RESTRICT,
    severity TEXT NOT NULL,
    category TEXT NOT NULL,
    description TEXT NOT NULL,
    file TEXT,
    line_start INTEGER,
    line_end INTEGER,
    evidence_ids_json TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS reviewer_sessions (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES engineer_runs(id) ON DELETE RESTRICT,
    attempt INTEGER NOT NULL CHECK(attempt > 0),
    model_tier TEXT NOT NULL,
    resolved_model TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    manifest_hash TEXT NOT NULL,
    diff_hash TEXT NOT NULL,
    evidence_bundle_hash TEXT NOT NULL,
    policy_version TEXT NOT NULL,
    cache_key TEXT,
    cache_hit INTEGER NOT NULL CHECK(cache_hit IN (0, 1)),
    cache_observed INTEGER NOT NULL DEFAULT 0 CHECK(cache_observed IN (0, 1)),
    started_at TEXT NOT NULL,
    completed_at TEXT,
    decision TEXT,
    isolation_verified INTEGER NOT NULL CHECK(isolation_verified IN (0, 1)),
    UNIQUE(run_id, attempt),
    UNIQUE(run_id, input_hash)
  );

  CREATE TABLE IF NOT EXISTS review_findings (
    id TEXT PRIMARY KEY,
    reviewer_session_id TEXT NOT NULL REFERENCES reviewer_sessions(id) ON DELETE RESTRICT,
    fingerprint TEXT NOT NULL,
    severity TEXT NOT NULL,
    category TEXT NOT NULL,
    file TEXT,
    line_start INTEGER,
    line_end INTEGER,
    description TEXT NOT NULL,
    required_change TEXT NOT NULL,
    criterion_ids_json TEXT NOT NULL,
    evidence_ids_json TEXT NOT NULL,
    status TEXT NOT NULL,
    UNIQUE(reviewer_session_id, fingerprint)
  );

  CREATE TABLE IF NOT EXISTS risk_assessments (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES engineer_runs(id) ON DELETE RESTRICT,
    risk_tier TEXT NOT NULL,
    human_gate_required INTEGER NOT NULL CHECK(human_gate_required IN (0, 1)),
    rule_version TEXT NOT NULL,
    matched_rules_json TEXT NOT NULL,
    features_json TEXT NOT NULL,
    assessed_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS approval_requests (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES engineer_runs(id) ON DELETE RESTRICT,
    risk_tier TEXT NOT NULL,
    assigned_reviewer_id TEXT,
    requested_at TEXT NOT NULL,
    deadline_at TEXT NOT NULL,
    reminder_schedule_json TEXT NOT NULL,
    timeout_action TEXT NOT NULL,
    manifest_hash TEXT NOT NULL,
    diff_hash TEXT NOT NULL,
    evidence_bundle_hash TEXT NOT NULL,
    status TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS approval_decisions (
    id TEXT PRIMARY KEY,
    approval_request_id TEXT NOT NULL REFERENCES approval_requests(id) ON DELETE RESTRICT,
    actor_id TEXT NOT NULL,
    decision TEXT NOT NULL,
    reason TEXT NOT NULL,
    decided_at TEXT NOT NULL,
    UNIQUE(approval_request_id, actor_id, decided_at)
  );

  CREATE TABLE IF NOT EXISTS retry_attempts (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES engineer_runs(id) ON DELETE RESTRICT,
    kind TEXT NOT NULL,
    attempt_number INTEGER NOT NULL CHECK(attempt_number > 0),
    failure_fingerprint TEXT NOT NULL,
    patch_hash TEXT,
    progress_metric REAL,
    allowed INTEGER NOT NULL CHECK(allowed IN (0, 1)),
    reason_code TEXT NOT NULL,
    policy_version TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS failure_records (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES engineer_runs(id) ON DELETE RESTRICT,
    failure_class TEXT NOT NULL,
    reason_code TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    evidence_ids_json TEXT NOT NULL,
    retryable INTEGER NOT NULL CHECK(retryable IN (0, 1)),
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS cost_records (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES engineer_runs(id) ON DELETE RESTRICT,
    source_type TEXT NOT NULL,
    source_id TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cached_input_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_input_tokens INTEGER NOT NULL DEFAULT 0,
    estimated_cost_usd REAL NOT NULL DEFAULT 0,
    agent_execution_id TEXT,
    resolved_model TEXT,
    routing_decision_id TEXT,
    pricing_version TEXT,
    currency TEXT,
    reservation_status TEXT NOT NULL DEFAULT 'ACTIVE'
      CHECK(reservation_status IN ('ACTIVE', 'AMBIGUOUS_PROVIDER_OUTCOME')),
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS run_budgets (
    run_id TEXT PRIMARY KEY REFERENCES engineer_runs(id) ON DELETE RESTRICT,
    cost_limit_usd REAL NOT NULL CHECK(cost_limit_usd >= 0), token_limit INTEGER NOT NULL CHECK(token_limit >= 0),
    time_limit_seconds INTEGER NOT NULL CHECK(time_limit_seconds > 0),
    lifetime_cost_limit_usd REAL NOT NULL CHECK(lifetime_cost_limit_usd >= cost_limit_usd),
    lifetime_token_limit INTEGER NOT NULL CHECK(lifetime_token_limit >= token_limit),
    lifetime_time_limit_seconds INTEGER NOT NULL CHECK(lifetime_time_limit_seconds >= time_limit_seconds),
    used_cost_usd REAL NOT NULL DEFAULT 0 CHECK(used_cost_usd >= 0), used_tokens INTEGER NOT NULL DEFAULT 0 CHECK(used_tokens >= 0),
    used_time_seconds INTEGER NOT NULL DEFAULT 0 CHECK(used_time_seconds >= 0), reserved_cost_usd REAL NOT NULL DEFAULT 0 CHECK(reserved_cost_usd >= 0),
    reserved_tokens INTEGER NOT NULL DEFAULT 0 CHECK(reserved_tokens >= 0),
    ambiguous_cost_usd REAL NOT NULL DEFAULT 0 CHECK(ambiguous_cost_usd >= 0),
    ambiguous_tokens INTEGER NOT NULL DEFAULT 0 CHECK(ambiguous_tokens >= 0),
    status TEXT NOT NULL CHECK(status IN ('ACTIVE', 'WARNING', 'PAUSED')),
    pause_reason TEXT, resume_state TEXT, warning_threshold REAL NOT NULL DEFAULT 0.8 CHECK(warning_threshold >= 0.5 AND warning_threshold <= 0.99),
    revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0), active_since TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );

  INSERT OR IGNORE INTO run_budgets
    (run_id, cost_limit_usd, token_limit, time_limit_seconds, lifetime_cost_limit_usd, lifetime_token_limit,
     lifetime_time_limit_seconds, status, active_since, created_at, updated_at)
  SELECT id, 20, 200000, 3600, 100, 1000000, 86400, 'ACTIVE', updated_at, created_at, updated_at FROM engineer_runs;

  CREATE TABLE IF NOT EXISTS budget_events (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES engineer_runs(id) ON DELETE RESTRICT,
    event_type TEXT NOT NULL, actor_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
    budget_revision INTEGER NOT NULL CHECK(budget_revision > 0), details_json TEXT NOT NULL, created_at TEXT NOT NULL,
    UNIQUE(run_id, idempotency_key)
  );

  CREATE TABLE IF NOT EXISTS audit_events (
    id TEXT PRIMARY KEY,
    run_id TEXT REFERENCES engineer_runs(id) ON DELETE RESTRICT,
    action TEXT NOT NULL,
    actor_type TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    details_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS git_operations (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES engineer_runs(id) ON DELETE RESTRICT,
    operation_type TEXT NOT NULL,
    requested_by TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    expected_base_commit_sha TEXT NOT NULL,
    result_commit_sha TEXT,
    approval_id TEXT,
    evidence_bundle_hash TEXT,
    status TEXT NOT NULL,
    remote_reference TEXT,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    error_code TEXT,
    UNIQUE(run_id, idempotency_key)
  );

  CREATE TABLE IF NOT EXISTS model_routing_decisions (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES engineer_runs(id) ON DELETE RESTRICT,
    agent_execution_id TEXT REFERENCES agent_executions(id) ON DELETE RESTRICT,
    agent_role TEXT NOT NULL,
    logical_tier TEXT NOT NULL,
    resolved_model TEXT NOT NULL,
    routing_policy_version TEXT NOT NULL,
    fallback_used INTEGER NOT NULL CHECK(fallback_used IN (0, 1)),
    fallback_reason TEXT,
    cache_key TEXT,
    timestamp TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS warm_sandboxes (
    id TEXT PRIMARY KEY,
    warm_key TEXT NOT NULL UNIQUE,
    repository_id TEXT NOT NULL REFERENCES repository_connections(id) ON DELETE RESTRICT,
    base_commit_sha TEXT NOT NULL,
    image_digest TEXT NOT NULL,
    lockfile_hash TEXT NOT NULL,
    toolchain_hash TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    claimed_by_run_id TEXT REFERENCES engineer_runs(id) ON DELETE RESTRICT,
    claimed_at TEXT,
    validation_artifact_id TEXT REFERENCES artifacts(id) ON DELETE RESTRICT,
    quarantine_reason TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_engineer_runs_user_updated ON engineer_runs(user_id, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_engineer_runs_user_created ON engineer_runs(user_id, created_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_run_state_events_run_sequence ON run_state_events(run_id, sequence);
  CREATE INDEX IF NOT EXISTS idx_artifacts_run_created ON artifacts(run_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_evidence_bundles_run_created ON evidence_bundles(run_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_model_calls_run_created ON model_calls(run_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_cost_records_run_created ON cost_records(run_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_approval_requests_run_requested ON approval_requests(run_id, requested_at DESC);
  CREATE INDEX IF NOT EXISTS idx_approval_decisions_request_decided ON approval_decisions(approval_request_id, decided_at);
  CREATE INDEX IF NOT EXISTS idx_retry_attempts_run_created ON retry_attempts(run_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_failures_run_fingerprint ON failure_records(run_id, fingerprint);
  CREATE INDEX IF NOT EXISTS idx_audit_run_created ON audit_events(run_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_decisions_run_created ON decisions(run_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_budget_events_run_created ON budget_events(run_id, created_at);
`;

/**
 * Required Lane contracts are deliberately migrated separately from the v14
 * bootstrap schema. Replaying the bootstrap keeps older installations
 * readable; this migration records the point at which new frozen runs gain
 * the stronger contract without inventing contracts for historical runs.
 */
export const ENGINEER_DATABASE_MIGRATION_15_SQL = `
  CREATE TABLE required_lane_contracts (
    contract_hash TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    manifest_hash TEXT NOT NULL,
    schema_version INTEGER NOT NULL CHECK(schema_version = 1),
    contract_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(run_id, manifest_hash),
    FOREIGN KEY(run_id, manifest_hash)
      REFERENCES task_manifest_versions(run_id, manifest_hash) ON DELETE RESTRICT
  );

  CREATE INDEX idx_required_lane_contracts_run
    ON required_lane_contracts(run_id, created_at);
`;

/** Tighten the already-deployed draft v15 text primary key without rewriting history. */
export const ENGINEER_DATABASE_MIGRATION_16_SQL = `
  DROP INDEX idx_required_lane_contracts_run;
  ALTER TABLE required_lane_contracts RENAME TO required_lane_contracts_v15;

  CREATE TABLE required_lane_contracts (
    contract_hash TEXT PRIMARY KEY NOT NULL,
    run_id TEXT NOT NULL,
    manifest_hash TEXT NOT NULL,
    schema_version INTEGER NOT NULL CHECK(schema_version = 1),
    contract_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(run_id, manifest_hash),
    FOREIGN KEY(run_id, manifest_hash)
      REFERENCES task_manifest_versions(run_id, manifest_hash) ON DELETE RESTRICT
  );

  INSERT INTO required_lane_contracts
    (contract_hash, run_id, manifest_hash, schema_version, contract_json, created_at)
    SELECT contract_hash, run_id, manifest_hash, schema_version, contract_json, created_at
    FROM required_lane_contracts_v15;

  DROP TABLE required_lane_contracts_v15;
  CREATE INDEX idx_required_lane_contracts_run
    ON required_lane_contracts(run_id, created_at);
`;

/** Allow immutable legacy v1 contracts and command-policy-bound v2 contracts. */
export const ENGINEER_DATABASE_MIGRATION_17_SQL = `
  DROP INDEX idx_required_lane_contracts_run;
  ALTER TABLE required_lane_contracts RENAME TO required_lane_contracts_v16;

  CREATE TABLE required_lane_contracts (
    contract_hash TEXT PRIMARY KEY NOT NULL,
    run_id TEXT NOT NULL,
    manifest_hash TEXT NOT NULL,
    schema_version INTEGER NOT NULL CHECK(schema_version IN (1, 2)),
    contract_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(run_id, manifest_hash),
    FOREIGN KEY(run_id, manifest_hash)
      REFERENCES task_manifest_versions(run_id, manifest_hash) ON DELETE RESTRICT
  );

  INSERT INTO required_lane_contracts
    (contract_hash, run_id, manifest_hash, schema_version, contract_json, created_at)
    SELECT contract_hash, run_id, manifest_hash, schema_version, contract_json, created_at
    FROM required_lane_contracts_v16;

  DROP TABLE required_lane_contracts_v16;
  CREATE INDEX idx_required_lane_contracts_run
    ON required_lane_contracts(run_id, created_at);
`;

/**
 * Persist the immutable deterministic classification alongside the exact
 * normalized session/findings hashes and the byte-level provider artifact ref.
 */
export const ENGINEER_DATABASE_MIGRATION_18_SQL = `
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
    reviewer_input_json TEXT NOT NULL,
    normalized_output_json TEXT NOT NULL,
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

/** Bind new approval requests directly to deterministic Reviewer authority. */
export const ENGINEER_DATABASE_MIGRATION_19_SQL = `
  ALTER TABLE approval_requests ADD COLUMN reviewer_session_id TEXT
    REFERENCES reviewer_sessions(id) ON DELETE RESTRICT;
  ALTER TABLE approval_requests ADD COLUMN classification_hash TEXT
    REFERENCES review_classification_batches(classification_hash) ON DELETE RESTRICT;
  ALTER TABLE approval_requests ADD COLUMN classification_result TEXT
    CHECK(classification_result IN ('READY_WITH_ADVISORIES', 'READY'));
`;

/** Exclusive, durable authority for one paid Builder dispatch per repair input. */
export const ENGINEER_DATABASE_MIGRATION_20_SQL = `
  CREATE TABLE builder_dispatch_claims (
    run_id TEXT NOT NULL REFERENCES engineer_runs(id) ON DELETE RESTRICT,
    input_hash TEXT NOT NULL,
    agent_execution_id TEXT NOT NULL UNIQUE REFERENCES agent_executions(id) ON DELETE RESTRICT,
    model_tier TEXT NOT NULL CHECK(model_tier = 'GPT-5.6_TERRA'),
    worker_owner_id TEXT,
    worker_fencing_token INTEGER CHECK(worker_fencing_token IS NULL OR worker_fencing_token > 0),
    claimed_at TEXT NOT NULL,
    CHECK((worker_owner_id IS NULL AND worker_fencing_token IS NULL) OR
          (worker_owner_id IS NOT NULL AND worker_fencing_token IS NOT NULL)),
    PRIMARY KEY(run_id, input_hash)
  );
  CREATE INDEX idx_builder_dispatch_claims_agent ON builder_dispatch_claims(agent_execution_id);
  CREATE TRIGGER require_valid_builder_dispatch_claim_v20
    BEFORE INSERT ON builder_dispatch_claims BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM agent_executions
        WHERE id = NEW.agent_execution_id AND run_id = NEW.run_id
          AND role = 'BUILDER' AND model_tier = NEW.model_tier
          AND input_hash = NEW.input_hash AND status = 'RUNNING'
          AND output_artifact_id IS NULL
      ) THEN RAISE(ABORT, 'builder dispatch claim does not match its running agent') END;
    END;
  CREATE TRIGGER prevent_builder_dispatch_claims_update_v20
    BEFORE UPDATE ON builder_dispatch_claims BEGIN
      SELECT RAISE(ABORT, 'builder dispatch claims are immutable');
    END;
  CREATE TRIGGER prevent_builder_dispatch_claims_delete_v20
    BEFORE DELETE ON builder_dispatch_claims BEGIN
      SELECT RAISE(ABORT, 'builder dispatch claims are immutable');
    END;
`;

/** Immutable signed authority for one verified candidate before approval/publication. */
export const ENGINEER_DATABASE_MIGRATION_21_SQL = `
  CREATE TABLE verified_candidate_checkpoints (
    id TEXT PRIMARY KEY,
    checkpoint_hash TEXT NOT NULL UNIQUE,
    parent_checkpoint_id TEXT CHECK(parent_checkpoint_id IS NULL),
    run_id TEXT NOT NULL REFERENCES engineer_runs(id) ON DELETE RESTRICT,
    requester_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    repository_id TEXT NOT NULL REFERENCES repository_connections(id) ON DELETE RESTRICT,
    required_lane_contract_hash TEXT NOT NULL REFERENCES required_lane_contracts(contract_hash) ON DELETE RESTRICT,
    manifest_hash TEXT NOT NULL,
    base_commit_sha TEXT NOT NULL,
    result_commit_sha TEXT NOT NULL,
    diff_hash TEXT NOT NULL,
    reviewer_session_id TEXT NOT NULL REFERENCES reviewer_sessions(id) ON DELETE RESTRICT,
    classification_hash TEXT NOT NULL UNIQUE REFERENCES review_classification_batches(classification_hash) ON DELETE RESTRICT,
    classification_result TEXT NOT NULL CHECK(classification_result IN ('READY', 'READY_WITH_ADVISORIES')),
    evidence_bundle_id TEXT NOT NULL UNIQUE REFERENCES evidence_bundles(id) ON DELETE RESTRICT,
    evidence_bundle_hash TEXT NOT NULL,
    environment_digest TEXT NOT NULL,
    checkpoint_json TEXT NOT NULL,
    statement_json TEXT NOT NULL,
    statement_hash TEXT NOT NULL,
    signature_algorithm TEXT NOT NULL,
    signature_key_id TEXT NOT NULL,
    signature TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(run_id, manifest_hash) REFERENCES task_manifest_versions(run_id, manifest_hash) ON DELETE RESTRICT
  );
  CREATE INDEX idx_verified_candidate_checkpoints_run_created
    ON verified_candidate_checkpoints(run_id, created_at);
  CREATE TRIGGER prevent_verified_candidate_checkpoints_update_v21
    BEFORE UPDATE ON verified_candidate_checkpoints BEGIN
      SELECT RAISE(ABORT, 'verified candidate checkpoints are immutable');
    END;
  CREATE TRIGGER prevent_verified_candidate_checkpoints_delete_v21
    BEFORE DELETE ON verified_candidate_checkpoints BEGIN
      SELECT RAISE(ABORT, 'verified candidate checkpoints are immutable');
    END;
  CREATE TRIGGER require_verified_candidate_checkpoint_bindings_v21
    BEFORE INSERT ON verified_candidate_checkpoints BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM engineer_runs r
        WHERE r.id = NEW.run_id AND r.user_id = NEW.requester_user_id
          AND r.repository_id = NEW.repository_id AND r.base_commit_sha = NEW.base_commit_sha
          AND r.manifest_hash = NEW.manifest_hash
      ) THEN RAISE(ABORT, 'checkpoint run binding mismatch') END;
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM required_lane_contracts c
        WHERE c.contract_hash = NEW.required_lane_contract_hash AND c.run_id = NEW.run_id
          AND c.manifest_hash = NEW.manifest_hash
      ) THEN RAISE(ABORT, 'checkpoint contract binding mismatch') END;
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM reviewer_sessions s
        WHERE s.id = NEW.reviewer_session_id AND s.run_id = NEW.run_id
          AND s.manifest_hash = NEW.manifest_hash AND s.diff_hash = NEW.diff_hash
      ) THEN RAISE(ABORT, 'checkpoint reviewer binding mismatch') END;
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM review_classification_batches b
        WHERE b.classification_hash = NEW.classification_hash
          AND b.reviewer_session_id = NEW.reviewer_session_id AND b.run_id = NEW.run_id
          AND b.contract_hash = NEW.required_lane_contract_hash
          AND json_extract(b.batch_json, '$.result') = NEW.classification_result
      ) THEN RAISE(ABORT, 'checkpoint classification binding mismatch') END;
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM evidence_bundles e
        WHERE e.id = NEW.evidence_bundle_id AND e.run_id = NEW.run_id
          AND e.bundle_hash = NEW.evidence_bundle_hash AND e.manifest_hash = NEW.manifest_hash
          AND e.base_commit_sha = NEW.base_commit_sha AND e.result_commit_sha = NEW.result_commit_sha
          AND e.environment_digest = NEW.environment_digest
          AND json_extract(e.manifest_json, '$.bundleVersion') = 2
          AND json_extract(e.manifest_json, '$.reviewerSessionId') = NEW.reviewer_session_id
          AND json_extract(e.manifest_json, '$.classificationHash') = NEW.classification_hash
          AND json_extract(e.manifest_json, '$.classificationResult') = NEW.classification_result
      ) THEN RAISE(ABORT, 'checkpoint evidence bundle binding mismatch') END;
    END;

  ALTER TABLE approval_requests ADD COLUMN verified_checkpoint_id TEXT
    REFERENCES verified_candidate_checkpoints(id) ON DELETE RESTRICT;
  ALTER TABLE approval_requests ADD COLUMN verified_checkpoint_hash TEXT
    REFERENCES verified_candidate_checkpoints(checkpoint_hash) ON DELETE RESTRICT;
  ALTER TABLE git_operations ADD COLUMN verified_checkpoint_id TEXT
    REFERENCES verified_candidate_checkpoints(id) ON DELETE RESTRICT;
  ALTER TABLE git_operations ADD COLUMN verified_checkpoint_hash TEXT
    REFERENCES verified_candidate_checkpoints(checkpoint_hash) ON DELETE RESTRICT;

  CREATE TRIGGER require_approval_checkpoint_pair_v21
    BEFORE INSERT ON approval_requests
    WHEN (NEW.verified_checkpoint_id IS NULL) != (NEW.verified_checkpoint_hash IS NULL) BEGIN
      SELECT RAISE(ABORT, 'approval checkpoint identity must be paired');
    END;
  CREATE TRIGGER require_approval_checkpoint_pair_update_v21
    BEFORE UPDATE ON approval_requests
    WHEN (NEW.verified_checkpoint_id IS NULL) != (NEW.verified_checkpoint_hash IS NULL) BEGIN
      SELECT RAISE(ABORT, 'approval checkpoint identity must be paired');
    END;
  CREATE TRIGGER require_approval_checkpoint_match_v21
    BEFORE INSERT ON approval_requests WHEN NEW.verified_checkpoint_id IS NOT NULL AND NEW.verified_checkpoint_hash IS NOT NULL BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM verified_candidate_checkpoints c
        WHERE c.id = NEW.verified_checkpoint_id AND c.checkpoint_hash = NEW.verified_checkpoint_hash
          AND c.run_id = NEW.run_id AND c.manifest_hash = NEW.manifest_hash
          AND c.diff_hash = NEW.diff_hash AND c.evidence_bundle_hash = NEW.evidence_bundle_hash
          AND c.reviewer_session_id = NEW.reviewer_session_id
          AND c.classification_hash = NEW.classification_hash
          AND c.classification_result = NEW.classification_result
      ) THEN RAISE(ABORT, 'approval checkpoint binding mismatch') END;
    END;
  CREATE TRIGGER require_approval_checkpoint_match_update_v21
    BEFORE UPDATE ON approval_requests WHEN NEW.verified_checkpoint_id IS NOT NULL AND NEW.verified_checkpoint_hash IS NOT NULL BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM verified_candidate_checkpoints c
        WHERE c.id = NEW.verified_checkpoint_id AND c.checkpoint_hash = NEW.verified_checkpoint_hash
          AND c.run_id = NEW.run_id AND c.manifest_hash = NEW.manifest_hash
          AND c.diff_hash = NEW.diff_hash AND c.evidence_bundle_hash = NEW.evidence_bundle_hash
          AND c.reviewer_session_id = NEW.reviewer_session_id
          AND c.classification_hash = NEW.classification_hash
          AND c.classification_result = NEW.classification_result
      ) THEN RAISE(ABORT, 'approval checkpoint binding mismatch') END;
    END;
  CREATE TRIGGER prevent_approval_checkpoint_rebinding_v21
    BEFORE UPDATE ON approval_requests
    WHEN NEW.verified_checkpoint_id IS NOT OLD.verified_checkpoint_id
      OR NEW.verified_checkpoint_hash IS NOT OLD.verified_checkpoint_hash BEGIN
      SELECT RAISE(ABORT, 'approval checkpoint identity is immutable');
    END;
  CREATE TRIGGER require_git_checkpoint_pair_v21
    BEFORE INSERT ON git_operations
    WHEN (NEW.verified_checkpoint_id IS NULL) != (NEW.verified_checkpoint_hash IS NULL) BEGIN
      SELECT RAISE(ABORT, 'git checkpoint identity must be paired');
    END;
  CREATE TRIGGER require_git_checkpoint_pair_update_v21
    BEFORE UPDATE ON git_operations
    WHEN (NEW.verified_checkpoint_id IS NULL) != (NEW.verified_checkpoint_hash IS NULL) BEGIN
      SELECT RAISE(ABORT, 'git checkpoint identity must be paired');
    END;
  CREATE TRIGGER require_git_checkpoint_match_v21
    BEFORE INSERT ON git_operations WHEN NEW.verified_checkpoint_id IS NOT NULL AND NEW.verified_checkpoint_hash IS NOT NULL BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM verified_candidate_checkpoints c
        WHERE c.id = NEW.verified_checkpoint_id AND c.checkpoint_hash = NEW.verified_checkpoint_hash
          AND c.run_id = NEW.run_id
          AND (NEW.result_commit_sha IS NULL OR c.result_commit_sha = NEW.result_commit_sha)
          AND (NEW.evidence_bundle_hash IS NULL OR c.evidence_bundle_hash = NEW.evidence_bundle_hash)
      ) THEN RAISE(ABORT, 'git checkpoint binding mismatch') END;
      SELECT CASE WHEN NEW.approval_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM approval_requests a
        WHERE a.id = NEW.approval_id AND a.run_id = NEW.run_id
          AND a.verified_checkpoint_id = NEW.verified_checkpoint_id
          AND a.verified_checkpoint_hash = NEW.verified_checkpoint_hash
      ) THEN RAISE(ABORT, 'git checkpoint approval mismatch') END;
    END;
  CREATE TRIGGER require_git_checkpoint_match_update_v21
    BEFORE UPDATE ON git_operations WHEN NEW.verified_checkpoint_id IS NOT NULL AND NEW.verified_checkpoint_hash IS NOT NULL BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM verified_candidate_checkpoints c
        WHERE c.id = NEW.verified_checkpoint_id AND c.checkpoint_hash = NEW.verified_checkpoint_hash
          AND c.run_id = NEW.run_id
          AND (NEW.result_commit_sha IS NULL OR c.result_commit_sha = NEW.result_commit_sha)
          AND (NEW.evidence_bundle_hash IS NULL OR c.evidence_bundle_hash = NEW.evidence_bundle_hash)
      ) THEN RAISE(ABORT, 'git checkpoint binding mismatch') END;
      SELECT CASE WHEN NEW.approval_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM approval_requests a
        WHERE a.id = NEW.approval_id AND a.run_id = NEW.run_id
          AND a.verified_checkpoint_id = NEW.verified_checkpoint_id
          AND a.verified_checkpoint_hash = NEW.verified_checkpoint_hash
      ) THEN RAISE(ABORT, 'git checkpoint approval mismatch') END;
    END;
  CREATE TRIGGER prevent_git_checkpoint_rebinding_v21
    BEFORE UPDATE ON git_operations
    WHEN NEW.verified_checkpoint_id IS NOT OLD.verified_checkpoint_id
      OR NEW.verified_checkpoint_hash IS NOT OLD.verified_checkpoint_hash BEGIN
      SELECT RAISE(ABORT, 'git checkpoint identity is immutable');
    END;
  CREATE TRIGGER prevent_run_state_events_update_v21
    BEFORE UPDATE ON run_state_events BEGIN
      SELECT RAISE(ABORT, 'run state events are immutable');
    END;
  CREATE TRIGGER prevent_run_state_events_delete_v21
    BEFORE DELETE ON run_state_events BEGIN
      SELECT RAISE(ABORT, 'run state events are immutable');
    END;
`;

/** Checkpoint-bound human decisions and mandatory bindings for all new publication rows. */
export const ENGINEER_DATABASE_MIGRATION_22_SQL = `
  ALTER TABLE approval_requests ADD COLUMN approval_revision INTEGER NOT NULL DEFAULT 0
    CHECK(approval_revision >= 0);
  ALTER TABLE approval_decisions ADD COLUMN expected_verified_checkpoint_id TEXT
    REFERENCES verified_candidate_checkpoints(id) ON DELETE RESTRICT;
  ALTER TABLE approval_decisions ADD COLUMN expected_verified_checkpoint_hash TEXT
    REFERENCES verified_candidate_checkpoints(checkpoint_hash) ON DELETE RESTRICT;
  ALTER TABLE approval_decisions ADD COLUMN expected_approval_revision INTEGER
    CHECK(expected_approval_revision IS NULL OR expected_approval_revision >= 0);
  CREATE INDEX idx_approval_decisions_checkpoint_v22
    ON approval_decisions(expected_verified_checkpoint_id, expected_verified_checkpoint_hash);

  CREATE TRIGGER require_new_approval_checkpoint_v22
    BEFORE INSERT ON approval_requests
    WHEN NEW.verified_checkpoint_id IS NULL OR NEW.verified_checkpoint_hash IS NULL
      OR NEW.approval_revision != 0 BEGIN
      SELECT RAISE(ABORT, 'new approval request requires verified checkpoint authority');
    END;
  CREATE TRIGGER require_new_git_checkpoint_v22
    BEFORE INSERT ON git_operations
    WHEN NEW.verified_checkpoint_id IS NULL OR NEW.verified_checkpoint_hash IS NULL BEGIN
      SELECT RAISE(ABORT, 'new git operation requires verified checkpoint authority');
    END;
  CREATE TRIGGER require_new_approval_decision_checkpoint_v22
    BEFORE INSERT ON approval_decisions
    WHEN NEW.expected_verified_checkpoint_id IS NULL OR NEW.expected_verified_checkpoint_hash IS NULL
      OR NEW.expected_approval_revision IS NULL BEGIN
      SELECT RAISE(ABORT, 'new approval decision requires verified checkpoint authority');
    END;
  CREATE TRIGGER require_approval_decision_checkpoint_pair_update_v22
    BEFORE UPDATE ON approval_decisions
    WHEN (NEW.expected_verified_checkpoint_id IS NULL) != (NEW.expected_verified_checkpoint_hash IS NULL) BEGIN
      SELECT RAISE(ABORT, 'approval decision checkpoint identity must be paired');
    END;
  CREATE TRIGGER require_approval_decision_checkpoint_match_v22
    BEFORE INSERT ON approval_decisions
    WHEN NEW.expected_verified_checkpoint_id IS NOT NULL AND NEW.expected_verified_checkpoint_hash IS NOT NULL BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM approval_requests a
        JOIN verified_candidate_checkpoints c
          ON c.id = NEW.expected_verified_checkpoint_id
         AND c.checkpoint_hash = NEW.expected_verified_checkpoint_hash
        WHERE a.id = NEW.approval_request_id
          AND a.verified_checkpoint_id = NEW.expected_verified_checkpoint_id
          AND a.verified_checkpoint_hash = NEW.expected_verified_checkpoint_hash
          AND a.approval_revision = NEW.expected_approval_revision
          AND c.run_id = a.run_id
      ) THEN RAISE(ABORT, 'approval decision checkpoint binding mismatch') END;
    END;
  CREATE TRIGGER require_approval_decision_checkpoint_match_update_v22
    BEFORE UPDATE ON approval_decisions
    WHEN NEW.expected_verified_checkpoint_id IS NOT NULL AND NEW.expected_verified_checkpoint_hash IS NOT NULL BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM approval_requests a
        JOIN verified_candidate_checkpoints c
          ON c.id = NEW.expected_verified_checkpoint_id
         AND c.checkpoint_hash = NEW.expected_verified_checkpoint_hash
        WHERE a.id = NEW.approval_request_id
          AND a.verified_checkpoint_id = NEW.expected_verified_checkpoint_id
          AND a.verified_checkpoint_hash = NEW.expected_verified_checkpoint_hash
          AND a.approval_revision = NEW.expected_approval_revision
          AND c.run_id = a.run_id
      ) THEN RAISE(ABORT, 'approval decision checkpoint binding mismatch') END;
    END;
  CREATE TRIGGER prevent_approval_decision_checkpoint_rebinding_v22
    BEFORE UPDATE ON approval_decisions
    WHEN NEW.expected_verified_checkpoint_id IS NOT OLD.expected_verified_checkpoint_id
      OR NEW.expected_verified_checkpoint_hash IS NOT OLD.expected_verified_checkpoint_hash
      OR NEW.expected_approval_revision IS NOT OLD.expected_approval_revision BEGIN
      SELECT RAISE(ABORT, 'approval decision checkpoint identity is immutable');
    END;
`;

/** Immutable optional-hardening authority, lineage, and publication selection. */
export const ENGINEER_DATABASE_MIGRATION_23_SQL = `
  CREATE TABLE advisory_backlog_items (
    id TEXT PRIMARY KEY NOT NULL CHECK(length(id)=71 AND substr(id,1,7)='sha256:' AND substr(id,8) NOT GLOB '*[^0-9a-f]*'),
    advisory_hash TEXT NOT NULL UNIQUE CHECK(length(advisory_hash)=71 AND substr(advisory_hash,1,7)='sha256:' AND substr(advisory_hash,8) NOT GLOB '*[^0-9a-f]*'),
    schema_version INTEGER NOT NULL CHECK(schema_version=1), policy_version TEXT NOT NULL CHECK(policy_version='engineer-advisory-backlog-v1'),
    parent_run_id TEXT NOT NULL REFERENCES engineer_runs(id) ON DELETE RESTRICT,
    requester_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    repository_id TEXT NOT NULL REFERENCES repository_connections(id) ON DELETE RESTRICT,
    parent_checkpoint_id TEXT NOT NULL REFERENCES verified_candidate_checkpoints(id) ON DELETE RESTRICT,
    parent_checkpoint_hash TEXT NOT NULL REFERENCES verified_candidate_checkpoints(checkpoint_hash) ON DELETE RESTRICT,
    required_lane_contract_hash TEXT NOT NULL REFERENCES required_lane_contracts(contract_hash) ON DELETE RESTRICT,
    classification_hash TEXT NOT NULL REFERENCES review_classification_batches(classification_hash) ON DELETE RESTRICT,
    reviewer_session_id TEXT NOT NULL REFERENCES reviewer_sessions(id) ON DELETE RESTRICT,
    finding_id TEXT NOT NULL, finding_fingerprint TEXT NOT NULL,
    source_classification_hash TEXT NOT NULL REFERENCES review_finding_classifications(classification_hash) ON DELETE RESTRICT,
    reported_severity TEXT NOT NULL CHECK(reported_severity IN ('INFO','LOW','MEDIUM','HIGH','CRITICAL')),
    reason_code TEXT NOT NULL CHECK(reason_code='OUTSIDE_FROZEN_REQUIRED_SCOPE'),
    category TEXT NOT NULL, file TEXT, line_start INTEGER, line_end INTEGER,
    actionability TEXT NOT NULL CHECK(actionability IN ('ACTIONABLE','AUDIT_ONLY')),
    item_json TEXT NOT NULL, created_at TEXT NOT NULL,
    UNIQUE(parent_checkpoint_id,finding_id),
    FOREIGN KEY(finding_id,reviewer_session_id) REFERENCES review_findings(id,reviewer_session_id) ON DELETE RESTRICT,
    CHECK((line_start IS NULL AND line_end IS NULL) OR (line_start>=0 AND line_end>=line_start)),
    CHECK(actionability!='ACTIONABLE' OR file IS NOT NULL)
  );
  CREATE INDEX idx_advisory_backlog_parent_run_v23 ON advisory_backlog_items(parent_run_id,created_at,id);
  CREATE INDEX idx_advisory_backlog_checkpoint_actionability_v23 ON advisory_backlog_items(parent_checkpoint_id,actionability);
  CREATE INDEX idx_advisory_backlog_classification_v23 ON advisory_backlog_items(classification_hash,source_classification_hash);

  CREATE TABLE hardening_quote_advisories (
    quote_id TEXT NOT NULL, ordinal INTEGER NOT NULL CHECK(ordinal>=0),
    advisory_id TEXT NOT NULL REFERENCES advisory_backlog_items(id) ON DELETE RESTRICT,
    PRIMARY KEY(quote_id,advisory_id), UNIQUE(quote_id,ordinal),
    FOREIGN KEY(quote_id) REFERENCES hardening_quotes(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
  );

  CREATE TABLE hardening_quotes (
    id TEXT PRIMARY KEY NOT NULL CHECK(length(id)=71 AND substr(id,1,7)='sha256:' AND substr(id,8) NOT GLOB '*[^0-9a-f]*'),
    quote_hash TEXT NOT NULL UNIQUE CHECK(length(quote_hash)=71 AND substr(quote_hash,1,7)='sha256:' AND substr(quote_hash,8) NOT GLOB '*[^0-9a-f]*'),
    schema_version INTEGER NOT NULL CHECK(schema_version=1), policy_version TEXT NOT NULL CHECK(policy_version='engineer-hardening-estimate-v1'),
    estimator_version TEXT NOT NULL CHECK(estimator_version='deterministic-hardening-estimator-v1'),
    parent_run_id TEXT NOT NULL REFERENCES engineer_runs(id) ON DELETE RESTRICT,
    requester_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    repository_id TEXT NOT NULL REFERENCES repository_connections(id) ON DELETE RESTRICT,
    parent_checkpoint_id TEXT NOT NULL REFERENCES verified_candidate_checkpoints(id) ON DELETE RESTRICT,
    parent_checkpoint_hash TEXT NOT NULL REFERENCES verified_candidate_checkpoints(checkpoint_hash) ON DELETE RESTRICT,
    parent_state_version INTEGER NOT NULL CHECK(parent_state_version>=0),
    selection_hash TEXT NOT NULL CHECK(length(selection_hash)=71 AND substr(selection_hash,1,7)='sha256:' AND substr(selection_hash,8) NOT GLOB '*[^0-9a-f]*'),
    advisory_count INTEGER NOT NULL CHECK(advisory_count BETWEEN 1 AND 20),
    routing_policy_version TEXT NOT NULL, pricing_version TEXT NOT NULL,
    max_cost_microusd INTEGER NOT NULL CHECK(max_cost_microusd BETWEEN 0 AND 100000000),
    max_tokens INTEGER NOT NULL CHECK(max_tokens BETWEEN 0 AND 1000000),
    max_time_seconds INTEGER NOT NULL CHECK(max_time_seconds BETWEEN 1 AND 86400),
    max_planner_calls INTEGER NOT NULL CHECK(max_planner_calls BETWEEN 0 AND 1),
    max_builder_calls INTEGER NOT NULL CHECK(max_builder_calls=1), max_reviewer_calls INTEGER NOT NULL CHECK(max_reviewer_calls=1),
    automatic_repair_calls INTEGER NOT NULL CHECK(automatic_repair_calls=0), quote_json TEXT NOT NULL,
    created_at TEXT NOT NULL, expires_at TEXT NOT NULL CHECK(expires_at>created_at)
  );
  CREATE INDEX idx_hardening_quotes_checkpoint_created_v23 ON hardening_quotes(parent_checkpoint_id,created_at DESC);
  CREATE INDEX idx_hardening_quotes_user_expiry_v23 ON hardening_quotes(requester_user_id,expires_at);

  CREATE TABLE hardening_consents (
    id TEXT PRIMARY KEY NOT NULL CHECK(length(id)=71 AND substr(id,1,7)='sha256:' AND substr(id,8) NOT GLOB '*[^0-9a-f]*'),
    consent_hash TEXT NOT NULL UNIQUE CHECK(length(consent_hash)=71 AND substr(consent_hash,1,7)='sha256:' AND substr(consent_hash,8) NOT GLOB '*[^0-9a-f]*'),
    schema_version INTEGER NOT NULL CHECK(schema_version=1), policy_version TEXT NOT NULL CHECK(policy_version='engineer-hardening-consent-v1'),
    quote_id TEXT NOT NULL UNIQUE REFERENCES hardening_quotes(id) ON DELETE RESTRICT,
    quote_hash TEXT NOT NULL REFERENCES hardening_quotes(quote_hash) ON DELETE RESTRICT,
    parent_run_id TEXT NOT NULL REFERENCES engineer_runs(id) ON DELETE RESTRICT,
    parent_checkpoint_id TEXT NOT NULL REFERENCES verified_candidate_checkpoints(id) ON DELETE RESTRICT,
    parent_checkpoint_hash TEXT NOT NULL REFERENCES verified_candidate_checkpoints(checkpoint_hash) ON DELETE RESTRICT,
    parent_state_version INTEGER NOT NULL CHECK(parent_state_version>=0),
    selection_hash TEXT NOT NULL CHECK(length(selection_hash)=71 AND substr(selection_hash,1,7)='sha256:' AND substr(selection_hash,8) NOT GLOB '*[^0-9a-f]*'),
    requester_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT, actor_id TEXT NOT NULL,
    cost_microusd INTEGER NOT NULL CHECK(cost_microusd BETWEEN 1 AND 100000000),
    tokens INTEGER NOT NULL CHECK(tokens BETWEEN 1 AND 1000000), time_seconds INTEGER NOT NULL CHECK(time_seconds BETWEEN 1 AND 86400),
    acknowledge_separate_run INTEGER NOT NULL CHECK(acknowledge_separate_run=1),
    acknowledge_parent_unchanged INTEGER NOT NULL CHECK(acknowledge_parent_unchanged=1),
    acknowledge_no_automatic_repair INTEGER NOT NULL CHECK(acknowledge_no_automatic_repair=1),
    acknowledge_no_overages INTEGER NOT NULL CHECK(acknowledge_no_overages=1),
    idempotency_key TEXT NOT NULL, consent_json TEXT NOT NULL, accepted_at TEXT NOT NULL, quote_expires_at TEXT NOT NULL,
    UNIQUE(requester_user_id,idempotency_key)
  );
  CREATE INDEX idx_hardening_consents_checkpoint_accepted_v23 ON hardening_consents(parent_checkpoint_id,accepted_at);
  CREATE INDEX idx_hardening_consents_user_accepted_v23 ON hardening_consents(requester_user_id,accepted_at);

  CREATE TABLE engineer_run_lineage (
    id TEXT PRIMARY KEY NOT NULL CHECK(length(id)=71 AND substr(id,1,7)='sha256:' AND substr(id,8) NOT GLOB '*[^0-9a-f]*'),
    lineage_hash TEXT NOT NULL UNIQUE CHECK(length(lineage_hash)=71 AND substr(lineage_hash,1,7)='sha256:' AND substr(lineage_hash,8) NOT GLOB '*[^0-9a-f]*'),
    schema_version INTEGER NOT NULL CHECK(schema_version=1), policy_version TEXT NOT NULL CHECK(policy_version='engineer-hardening-lineage-v1'),
    relation TEXT NOT NULL CHECK(relation='OPTIONAL_HARDENING'),
    root_run_id TEXT NOT NULL REFERENCES engineer_runs(id) ON DELETE RESTRICT,
    parent_run_id TEXT NOT NULL REFERENCES engineer_runs(id) ON DELETE RESTRICT,
    child_run_id TEXT NOT NULL UNIQUE REFERENCES engineer_runs(id) ON DELETE RESTRICT,
    requester_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    repository_id TEXT NOT NULL REFERENCES repository_connections(id) ON DELETE RESTRICT,
    parent_checkpoint_id TEXT NOT NULL REFERENCES verified_candidate_checkpoints(id) ON DELETE RESTRICT,
    parent_checkpoint_hash TEXT NOT NULL REFERENCES verified_candidate_checkpoints(checkpoint_hash) ON DELETE RESTRICT,
    parent_base_commit_sha TEXT NOT NULL, seed_result_commit_sha TEXT NOT NULL,
    quote_id TEXT NOT NULL REFERENCES hardening_quotes(id) ON DELETE RESTRICT,
    quote_hash TEXT NOT NULL REFERENCES hardening_quotes(quote_hash) ON DELETE RESTRICT,
    consent_id TEXT NOT NULL UNIQUE REFERENCES hardening_consents(id) ON DELETE RESTRICT,
    consent_hash TEXT NOT NULL REFERENCES hardening_consents(consent_hash) ON DELETE RESTRICT,
    selection_hash TEXT NOT NULL CHECK(length(selection_hash)=71 AND substr(selection_hash,1,7)='sha256:' AND substr(selection_hash,8) NOT GLOB '*[^0-9a-f]*'),
    cost_microusd INTEGER NOT NULL CHECK(cost_microusd>0),
    tokens INTEGER NOT NULL CHECK(tokens>0), time_seconds INTEGER NOT NULL CHECK(time_seconds>0),
    lineage_json TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(parent_checkpoint_id,child_run_id)
  );
  CREATE INDEX idx_run_lineage_root_created_v23 ON engineer_run_lineage(root_run_id,created_at,child_run_id);
  CREATE INDEX idx_run_lineage_checkpoint_created_v23 ON engineer_run_lineage(parent_checkpoint_id,created_at);

  CREATE TABLE advisory_backlog_events (
    id TEXT PRIMARY KEY NOT NULL CHECK(length(id)=71 AND substr(id,1,7)='sha256:' AND substr(id,8) NOT GLOB '*[^0-9a-f]*'),
    event_hash TEXT NOT NULL UNIQUE CHECK(length(event_hash)=71 AND substr(event_hash,1,7)='sha256:' AND substr(event_hash,8) NOT GLOB '*[^0-9a-f]*'),
    schema_version INTEGER NOT NULL CHECK(schema_version=1), policy_version TEXT NOT NULL CHECK(policy_version='engineer-advisory-backlog-v1'),
    advisory_id TEXT NOT NULL REFERENCES advisory_backlog_items(id) ON DELETE RESTRICT,
    parent_run_id TEXT NOT NULL REFERENCES engineer_runs(id) ON DELETE RESTRICT,
    parent_checkpoint_id TEXT NOT NULL REFERENCES verified_candidate_checkpoints(id) ON DELETE RESTRICT,
    parent_checkpoint_hash TEXT NOT NULL REFERENCES verified_candidate_checkpoints(checkpoint_hash) ON DELETE RESTRICT,
    event_type TEXT NOT NULL CHECK(event_type IN ('SELECTED','DEFERRED','DISMISSED','REOPENED','HARDENING_STARTED','HARDENING_VERIFIED','HARDENING_STOPPED')),
    revision INTEGER NOT NULL CHECK(revision>0), expected_revision INTEGER NOT NULL CHECK(expected_revision>=0 AND revision=expected_revision+1),
    actor_type TEXT NOT NULL CHECK(actor_type IN ('USER','SYSTEM')), actor_id TEXT NOT NULL,
    operation_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
    quote_id TEXT REFERENCES hardening_quotes(id) ON DELETE RESTRICT, consent_id TEXT REFERENCES hardening_consents(id) ON DELETE RESTRICT,
    hardening_lineage_id TEXT REFERENCES engineer_run_lineage(id) ON DELETE RESTRICT,
    child_run_id TEXT REFERENCES engineer_runs(id) ON DELETE RESTRICT,
    child_checkpoint_id TEXT REFERENCES verified_candidate_checkpoints(id) ON DELETE RESTRICT,
    child_checkpoint_hash TEXT REFERENCES verified_candidate_checkpoints(checkpoint_hash) ON DELETE RESTRICT,
    stop_reason TEXT CHECK(stop_reason IN ('FAILED','CANCELLED','BUDGET_EXHAUSTED','TIMED_OUT','SECURITY_BLOCKED','ENVIRONMENT_BLOCKED')),
    rationale TEXT, event_json TEXT NOT NULL, created_at TEXT NOT NULL,
    UNIQUE(advisory_id,revision), UNIQUE(advisory_id,idempotency_key)
  );
  CREATE INDEX idx_advisory_events_parent_created_v23 ON advisory_backlog_events(parent_run_id,created_at,id);
  CREATE INDEX idx_advisory_events_revision_v23 ON advisory_backlog_events(advisory_id,revision DESC);
  CREATE INDEX idx_advisory_events_child_v23 ON advisory_backlog_events(child_run_id,event_type);

  CREATE TABLE candidate_lineage_attestations (
    lineage_attestation_id TEXT PRIMARY KEY NOT NULL CHECK(length(lineage_attestation_id)=71 AND substr(lineage_attestation_id,1,7)='sha256:' AND substr(lineage_attestation_id,8) NOT GLOB '*[^0-9a-f]*'),
    lineage_attestation_hash TEXT NOT NULL UNIQUE CHECK(length(lineage_attestation_hash)=71 AND substr(lineage_attestation_hash,1,7)='sha256:' AND substr(lineage_attestation_hash,8) NOT GLOB '*[^0-9a-f]*'),
    schema_version INTEGER NOT NULL CHECK(schema_version=1), policy_version TEXT NOT NULL CHECK(policy_version='engineer-candidate-lineage-v1'),
    relation TEXT NOT NULL CHECK(relation='OPTIONAL_HARDENING'),
    lineage_id TEXT NOT NULL UNIQUE REFERENCES engineer_run_lineage(id) ON DELETE RESTRICT,
    lineage_hash TEXT NOT NULL REFERENCES engineer_run_lineage(lineage_hash) ON DELETE RESTRICT,
    root_run_id TEXT NOT NULL REFERENCES engineer_runs(id) ON DELETE RESTRICT,
    parent_run_id TEXT NOT NULL REFERENCES engineer_runs(id) ON DELETE RESTRICT,
    child_run_id TEXT NOT NULL REFERENCES engineer_runs(id) ON DELETE RESTRICT,
    requester_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    repository_id TEXT NOT NULL REFERENCES repository_connections(id) ON DELETE RESTRICT,
    parent_checkpoint_id TEXT NOT NULL REFERENCES verified_candidate_checkpoints(id) ON DELETE RESTRICT,
    parent_checkpoint_hash TEXT NOT NULL REFERENCES verified_candidate_checkpoints(checkpoint_hash) ON DELETE RESTRICT,
    parent_result_commit_sha TEXT NOT NULL,
    child_checkpoint_id TEXT NOT NULL UNIQUE REFERENCES verified_candidate_checkpoints(id) ON DELETE RESTRICT,
    child_checkpoint_hash TEXT NOT NULL REFERENCES verified_candidate_checkpoints(checkpoint_hash) ON DELETE RESTRICT,
    child_result_commit_sha TEXT NOT NULL, parent_base_commit_sha TEXT NOT NULL,
    selection_hash TEXT NOT NULL CHECK(length(selection_hash)=71 AND substr(selection_hash,1,7)='sha256:' AND substr(selection_hash,8) NOT GLOB '*[^0-9a-f]*'),
    quote_hash TEXT NOT NULL REFERENCES hardening_quotes(quote_hash) ON DELETE RESTRICT,
    consent_hash TEXT NOT NULL REFERENCES hardening_consents(consent_hash) ON DELETE RESTRICT,
    attestation_json TEXT NOT NULL, statement_json TEXT NOT NULL,
    statement_hash TEXT NOT NULL CHECK(length(statement_hash)=71 AND substr(statement_hash,1,7)='sha256:' AND substr(statement_hash,8) NOT GLOB '*[^0-9a-f]*'),
    signature_algorithm TEXT NOT NULL, signature_key_id TEXT NOT NULL, signature TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE INDEX idx_candidate_lineage_checkpoint_created_v23 ON candidate_lineage_attestations(parent_checkpoint_id,created_at);
  CREATE INDEX idx_candidate_lineage_child_v23 ON candidate_lineage_attestations(child_run_id,child_checkpoint_id);
  CREATE INDEX idx_candidate_lineage_root_created_v23 ON candidate_lineage_attestations(root_run_id,created_at);

  CREATE TABLE publication_candidate_selections (
    id TEXT PRIMARY KEY NOT NULL CHECK(length(id)=71 AND substr(id,1,7)='sha256:' AND substr(id,8) NOT GLOB '*[^0-9a-f]*'),
    selection_hash TEXT NOT NULL UNIQUE CHECK(length(selection_hash)=71 AND substr(selection_hash,1,7)='sha256:' AND substr(selection_hash,8) NOT GLOB '*[^0-9a-f]*'),
    schema_version INTEGER NOT NULL CHECK(schema_version=1), policy_version TEXT NOT NULL CHECK(policy_version='engineer-publication-selection-v1'),
    root_run_id TEXT NOT NULL REFERENCES engineer_runs(id) ON DELETE RESTRICT,
    candidate_run_id TEXT NOT NULL REFERENCES engineer_runs(id) ON DELETE RESTRICT,
    requester_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    repository_id TEXT NOT NULL REFERENCES repository_connections(id) ON DELETE RESTRICT,
    candidate_kind TEXT NOT NULL CHECK(candidate_kind IN ('PARENT','HARDENED_CHILD')),
    selected_checkpoint_id TEXT NOT NULL REFERENCES verified_candidate_checkpoints(id) ON DELETE RESTRICT,
    selected_checkpoint_hash TEXT NOT NULL REFERENCES verified_candidate_checkpoints(checkpoint_hash) ON DELETE RESTRICT,
    selected_result_commit_sha TEXT NOT NULL,
    candidate_lineage_attestation_id TEXT REFERENCES candidate_lineage_attestations(lineage_attestation_id) ON DELETE RESTRICT,
    candidate_lineage_attestation_hash TEXT REFERENCES candidate_lineage_attestations(lineage_attestation_hash) ON DELETE RESTRICT,
    revision INTEGER NOT NULL CHECK(revision>0), expected_revision INTEGER NOT NULL CHECK(expected_revision>=0 AND revision=expected_revision+1),
    previous_selection_id TEXT REFERENCES publication_candidate_selections(id) ON DELETE RESTRICT,
    reason_code TEXT NOT NULL CHECK(reason_code IN ('USER_SELECTED_PARENT','USER_SELECTED_HARDENED_CHILD')),
    actor_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, selection_json TEXT NOT NULL, selected_at TEXT NOT NULL,
    UNIQUE(root_run_id,revision), UNIQUE(root_run_id,idempotency_key),
    CHECK((revision=1 AND previous_selection_id IS NULL) OR (revision>1 AND previous_selection_id IS NOT NULL)),
    CHECK((candidate_kind='PARENT' AND candidate_lineage_attestation_id IS NULL AND candidate_lineage_attestation_hash IS NULL AND reason_code='USER_SELECTED_PARENT') OR
          (candidate_kind='HARDENED_CHILD' AND candidate_lineage_attestation_id IS NOT NULL AND candidate_lineage_attestation_hash IS NOT NULL AND reason_code='USER_SELECTED_HARDENED_CHILD'))
  );
  CREATE INDEX idx_publication_selection_root_revision_v23 ON publication_candidate_selections(root_run_id,revision DESC);
  CREATE INDEX idx_publication_selection_candidate_v23 ON publication_candidate_selections(candidate_run_id,selected_at);
  CREATE INDEX idx_publication_selection_checkpoint_v23 ON publication_candidate_selections(selected_checkpoint_id,selected_checkpoint_hash);

  ALTER TABLE approval_requests ADD COLUMN publication_selection_id TEXT REFERENCES publication_candidate_selections(id) ON DELETE RESTRICT;
  ALTER TABLE approval_requests ADD COLUMN publication_selection_hash TEXT REFERENCES publication_candidate_selections(selection_hash) ON DELETE RESTRICT;
  ALTER TABLE git_operations ADD COLUMN publication_selection_id TEXT REFERENCES publication_candidate_selections(id) ON DELETE RESTRICT;
  ALTER TABLE git_operations ADD COLUMN publication_selection_hash TEXT REFERENCES publication_candidate_selections(selection_hash) ON DELETE RESTRICT;
  CREATE INDEX idx_approval_selection_pair_v23 ON approval_requests(publication_selection_id,publication_selection_hash);
  CREATE INDEX idx_git_selection_pair_v23 ON git_operations(publication_selection_id,publication_selection_hash);

  CREATE TRIGGER require_advisory_binding_v23 BEFORE INSERT ON advisory_backlog_items BEGIN
    SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM verified_candidate_checkpoints c WHERE c.id=NEW.parent_checkpoint_id AND c.checkpoint_hash=NEW.parent_checkpoint_hash AND c.run_id=NEW.parent_run_id AND c.requester_user_id=NEW.requester_user_id AND c.repository_id=NEW.repository_id AND c.required_lane_contract_hash=NEW.required_lane_contract_hash AND c.classification_hash=NEW.classification_hash AND c.reviewer_session_id=NEW.reviewer_session_id) THEN RAISE(ABORT,'advisory checkpoint binding mismatch') END;
    SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM review_finding_classifications f WHERE f.classification_hash=NEW.source_classification_hash AND f.batch_hash=NEW.classification_hash AND f.reviewer_session_id=NEW.reviewer_session_id AND f.finding_id=NEW.finding_id AND f.finding_fingerprint=NEW.finding_fingerprint AND f.disposition='ADVISORY' AND f.authority='NONE' AND f.reason_code=NEW.reason_code) THEN RAISE(ABORT,'advisory classification binding mismatch') END;
    SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM review_findings f WHERE f.id=NEW.finding_id AND f.reviewer_session_id=NEW.reviewer_session_id AND f.fingerprint=NEW.finding_fingerprint AND f.severity=NEW.reported_severity AND f.category=NEW.category AND f.file IS NEW.file AND f.line_start IS NEW.line_start AND f.line_end IS NEW.line_end AND f.description=json_extract(NEW.item_json,'$.description') AND f.required_change=json_extract(NEW.item_json,'$.requiredChange') AND json(f.criterion_ids_json)=json(json_extract(NEW.item_json,'$.criterionIds')) AND json(f.evidence_ids_json)=json(json_extract(NEW.item_json,'$.evidenceIds'))) THEN RAISE(ABORT,'advisory finding binding mismatch') END;
  END;
  CREATE TRIGGER require_quote_binding_v23 BEFORE INSERT ON hardening_quotes BEGIN
    SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM verified_candidate_checkpoints c JOIN engineer_runs r ON r.id=c.run_id WHERE c.id=NEW.parent_checkpoint_id AND c.checkpoint_hash=NEW.parent_checkpoint_hash AND c.run_id=NEW.parent_run_id AND c.requester_user_id=NEW.requester_user_id AND c.repository_id=NEW.repository_id AND r.state_version=NEW.parent_state_version) THEN RAISE(ABORT,'hardening quote checkpoint binding mismatch') END;
    SELECT CASE WHEN (SELECT COUNT(*) FROM hardening_quote_advisories m JOIN advisory_backlog_items a ON a.id=m.advisory_id WHERE m.quote_id=NEW.id AND a.parent_run_id=NEW.parent_run_id AND a.parent_checkpoint_id=NEW.parent_checkpoint_id AND a.parent_checkpoint_hash=NEW.parent_checkpoint_hash AND a.actionability='ACTIONABLE')!=NEW.advisory_count OR (SELECT COALESCE(MAX(ordinal),-1) FROM hardening_quote_advisories WHERE quote_id=NEW.id)!=NEW.advisory_count-1 OR json_array_length(json_extract(NEW.quote_json,'$.advisoryIds'))!=NEW.advisory_count OR json_extract(NEW.quote_json,'$.selectionHash')!=NEW.selection_hash OR EXISTS(SELECT 1 FROM json_each(NEW.quote_json,'$.advisoryIds') j LEFT JOIN hardening_quote_advisories m ON m.quote_id=NEW.id AND m.ordinal=CAST(j.key AS INTEGER) WHERE m.advisory_id IS NULL OR m.advisory_id!=j.value) THEN RAISE(ABORT,'hardening quote advisory mapping incomplete') END;
    SELECT CASE WHEN NEW.routing_policy_version!='engineer-model-routing-v2' OR NEW.pricing_version!='openai-gpt56-pricing-2026-07-14' THEN RAISE(ABORT,'hardening quote frozen version mismatch') END;
    SELECT CASE WHEN ABS((julianday(NEW.expires_at)-julianday(NEW.created_at))*86400000-900000)>1 THEN RAISE(ABORT,'hardening quote expiry invalid') END;
  END;
  CREATE TRIGGER prevent_sealed_quote_mapping_v23 BEFORE INSERT ON hardening_quote_advisories WHEN EXISTS(SELECT 1 FROM hardening_quotes WHERE id=NEW.quote_id) BEGIN SELECT RAISE(ABORT,'hardening quote mappings are sealed'); END;
  CREATE TRIGGER require_consent_binding_v23 BEFORE INSERT ON hardening_consents BEGIN
    SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM hardening_quotes q JOIN engineer_runs r ON r.id=q.parent_run_id WHERE q.id=NEW.quote_id AND q.quote_hash=NEW.quote_hash AND q.parent_run_id=NEW.parent_run_id AND q.parent_checkpoint_id=NEW.parent_checkpoint_id AND q.parent_checkpoint_hash=NEW.parent_checkpoint_hash AND q.parent_state_version=NEW.parent_state_version AND r.state_version=NEW.parent_state_version AND q.selection_hash=NEW.selection_hash AND q.requester_user_id=NEW.requester_user_id AND NEW.actor_id=NEW.requester_user_id AND NEW.cost_microusd<=q.max_cost_microusd AND NEW.tokens<=q.max_tokens AND NEW.time_seconds<=q.max_time_seconds AND NEW.quote_expires_at=q.expires_at AND NEW.accepted_at>=q.created_at AND NEW.accepted_at<=q.expires_at) THEN RAISE(ABORT,'hardening consent quote binding mismatch') END;
  END;
  CREATE TRIGGER require_lineage_binding_v23 BEFORE INSERT ON engineer_run_lineage BEGIN
    SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM engineer_runs p JOIN engineer_runs root ON root.id=NEW.root_run_id JOIN engineer_runs c ON c.id=NEW.child_run_id JOIN verified_candidate_checkpoints v ON v.id=NEW.parent_checkpoint_id WHERE p.id=NEW.parent_run_id AND p.user_id=NEW.requester_user_id AND p.repository_id=NEW.repository_id AND root.user_id=NEW.requester_user_id AND root.repository_id=NEW.repository_id AND c.user_id=NEW.requester_user_id AND c.repository_id=NEW.repository_id AND c.base_branch=p.base_branch AND c.base_commit_sha=p.base_commit_sha AND v.checkpoint_hash=NEW.parent_checkpoint_hash AND v.run_id=p.id AND v.base_commit_sha=NEW.parent_base_commit_sha AND v.result_commit_sha=NEW.seed_result_commit_sha AND c.created_at=NEW.created_at) THEN RAISE(ABORT,'hardening run lineage run binding mismatch') END;
    SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM hardening_quotes q JOIN hardening_consents c ON c.quote_id=q.id WHERE q.id=NEW.quote_id AND q.quote_hash=NEW.quote_hash AND c.id=NEW.consent_id AND c.consent_hash=NEW.consent_hash AND q.selection_hash=NEW.selection_hash AND c.cost_microusd=NEW.cost_microusd AND c.tokens=NEW.tokens AND c.time_seconds=NEW.time_seconds AND q.parent_checkpoint_id=NEW.parent_checkpoint_id AND c.parent_checkpoint_id=NEW.parent_checkpoint_id) THEN RAISE(ABORT,'hardening run lineage authority mismatch') END;
    SELECT CASE WHEN NOT ((NEW.root_run_id=NEW.parent_run_id AND NOT EXISTS(SELECT 1 FROM engineer_run_lineage WHERE child_run_id=NEW.parent_run_id)) OR EXISTS(SELECT 1 FROM engineer_run_lineage prior WHERE prior.child_run_id=NEW.parent_run_id AND prior.root_run_id=NEW.root_run_id)) THEN RAISE(ABORT,'hardening root ancestry mismatch') END;
    SELECT CASE WHEN NEW.child_run_id NOT LIKE 'hardening-%' OR json_extract(NEW.lineage_json,'$.childRunId')!=NEW.child_run_id OR json_extract(NEW.lineage_json,'$.consentHash')!=NEW.consent_hash THEN RAISE(ABORT,'hardening child identity mismatch') END;
    SELECT CASE WHEN EXISTS (SELECT 1 FROM engineer_run_lineage l JOIN engineer_runs r ON r.id=l.child_run_id WHERE l.parent_checkpoint_id=NEW.parent_checkpoint_id AND r.state NOT IN ('COMPLETED','REJECTED','CANCELLED','TIMED_OUT','RETRY_BUDGET_EXHAUSTED','BLOCKED_BY_ENVIRONMENT','BLOCKED_BY_EXTERNAL_DEPENDENCY','SECURITY_ESCALATION','VERIFICATION_INCOMPLETE','ROLLED_BACK','FAILED')) THEN RAISE(ABORT,'active hardening child already exists') END;
  END;
  CREATE TRIGGER require_advisory_event_binding_v23 BEFORE INSERT ON advisory_backlog_events BEGIN
    SELECT CASE WHEN NEW.revision!=(SELECT COUNT(*)+1 FROM advisory_backlog_events WHERE advisory_id=NEW.advisory_id) OR NEW.expected_revision!=NEW.revision-1 THEN RAISE(ABORT,'advisory event revision conflict') END;
    SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM advisory_backlog_items a WHERE a.id=NEW.advisory_id AND a.parent_run_id=NEW.parent_run_id AND a.parent_checkpoint_id=NEW.parent_checkpoint_id AND a.parent_checkpoint_hash=NEW.parent_checkpoint_hash) THEN RAISE(ABORT,'advisory event binding mismatch') END;
    SELECT CASE WHEN (NEW.event_type='SELECTED' AND NOT(NEW.quote_id IS NOT NULL AND NEW.consent_id IS NULL AND NEW.hardening_lineage_id IS NULL AND NEW.child_run_id IS NULL AND NEW.child_checkpoint_id IS NULL AND NEW.child_checkpoint_hash IS NULL AND NEW.stop_reason IS NULL)) OR (NEW.event_type IN ('DEFERRED','DISMISSED','REOPENED') AND NOT(NEW.quote_id IS NULL AND NEW.consent_id IS NULL AND NEW.hardening_lineage_id IS NULL AND NEW.child_run_id IS NULL AND NEW.child_checkpoint_id IS NULL AND NEW.child_checkpoint_hash IS NULL AND NEW.stop_reason IS NULL)) OR (NEW.event_type='HARDENING_STARTED' AND NOT(NEW.quote_id IS NOT NULL AND NEW.consent_id IS NOT NULL AND NEW.hardening_lineage_id IS NOT NULL AND NEW.child_run_id IS NOT NULL AND NEW.child_checkpoint_id IS NULL AND NEW.child_checkpoint_hash IS NULL AND NEW.stop_reason IS NULL)) OR (NEW.event_type='HARDENING_VERIFIED' AND NOT(NEW.quote_id IS NOT NULL AND NEW.consent_id IS NOT NULL AND NEW.hardening_lineage_id IS NOT NULL AND NEW.child_run_id IS NOT NULL AND NEW.child_checkpoint_id IS NOT NULL AND NEW.child_checkpoint_hash IS NOT NULL AND NEW.stop_reason IS NULL)) OR (NEW.event_type='HARDENING_STOPPED' AND NOT(NEW.hardening_lineage_id IS NOT NULL AND NEW.child_run_id IS NOT NULL AND NEW.child_checkpoint_id IS NULL AND NEW.child_checkpoint_hash IS NULL AND NEW.stop_reason IS NOT NULL)) THEN RAISE(ABORT,'advisory event shape mismatch') END;
    SELECT CASE WHEN NEW.quote_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM hardening_quotes q JOIN hardening_quote_advisories m ON m.quote_id=q.id WHERE q.id=NEW.quote_id AND q.parent_run_id=NEW.parent_run_id AND q.parent_checkpoint_id=NEW.parent_checkpoint_id AND q.parent_checkpoint_hash=NEW.parent_checkpoint_hash AND m.advisory_id=NEW.advisory_id) THEN RAISE(ABORT,'advisory event quote binding mismatch') END;
    SELECT CASE WHEN NEW.hardening_lineage_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM engineer_run_lineage l WHERE l.id=NEW.hardening_lineage_id AND l.parent_run_id=NEW.parent_run_id AND l.parent_checkpoint_id=NEW.parent_checkpoint_id AND l.parent_checkpoint_hash=NEW.parent_checkpoint_hash AND l.child_run_id=NEW.child_run_id AND (NEW.quote_id IS NULL OR l.quote_id=NEW.quote_id) AND (NEW.consent_id IS NULL OR l.consent_id=NEW.consent_id)) THEN RAISE(ABORT,'advisory event lineage binding mismatch') END;
    SELECT CASE WHEN NEW.child_checkpoint_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM verified_candidate_checkpoints c WHERE c.id=NEW.child_checkpoint_id AND c.checkpoint_hash=NEW.child_checkpoint_hash AND c.run_id=NEW.child_run_id) THEN RAISE(ABORT,'advisory event child checkpoint mismatch') END;
    SELECT CASE WHEN NEW.revision=1 AND NEW.event_type NOT IN('SELECTED','DEFERRED','DISMISSED') THEN RAISE(ABORT,'invalid initial advisory event') END;
    SELECT CASE WHEN NEW.revision>1 AND NOT EXISTS(SELECT 1 FROM advisory_backlog_events prior WHERE prior.advisory_id=NEW.advisory_id AND prior.revision=NEW.revision-1 AND ((NEW.event_type='SELECTED' AND prior.event_type IN('DEFERRED','REOPENED')) OR (NEW.event_type='DEFERRED' AND prior.event_type IN('SELECTED','REOPENED')) OR (NEW.event_type='DISMISSED' AND prior.event_type IN('SELECTED','DEFERRED','REOPENED')) OR (NEW.event_type='REOPENED' AND prior.event_type IN('DEFERRED','DISMISSED')) OR (NEW.event_type='HARDENING_STARTED' AND prior.event_type='SELECTED') OR (NEW.event_type IN('HARDENING_VERIFIED','HARDENING_STOPPED') AND prior.event_type='HARDENING_STARTED'))) THEN RAISE(ABORT,'invalid advisory event transition') END;
  END;
  CREATE TRIGGER require_candidate_lineage_binding_v23 BEFORE INSERT ON candidate_lineage_attestations BEGIN
    SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM engineer_run_lineage l JOIN verified_candidate_checkpoints p ON p.id=NEW.parent_checkpoint_id JOIN verified_candidate_checkpoints c ON c.id=NEW.child_checkpoint_id WHERE l.id=NEW.lineage_id AND l.lineage_hash=NEW.lineage_hash AND l.root_run_id=NEW.root_run_id AND l.parent_run_id=NEW.parent_run_id AND l.child_run_id=NEW.child_run_id AND l.requester_user_id=NEW.requester_user_id AND l.repository_id=NEW.repository_id AND l.parent_checkpoint_id=NEW.parent_checkpoint_id AND l.parent_checkpoint_hash=NEW.parent_checkpoint_hash AND p.checkpoint_hash=NEW.parent_checkpoint_hash AND p.run_id=NEW.parent_run_id AND p.requester_user_id=NEW.requester_user_id AND p.repository_id=NEW.repository_id AND p.result_commit_sha=NEW.parent_result_commit_sha AND c.checkpoint_hash=NEW.child_checkpoint_hash AND c.run_id=NEW.child_run_id AND c.result_commit_sha=NEW.child_result_commit_sha AND l.parent_base_commit_sha=NEW.parent_base_commit_sha AND l.selection_hash=NEW.selection_hash AND l.quote_hash=NEW.quote_hash AND l.consent_hash=NEW.consent_hash AND c.created_at=NEW.created_at) THEN RAISE(ABORT,'candidate lineage binding mismatch') END;
  END;
  CREATE TRIGGER require_publication_selection_binding_v23 BEFORE INSERT ON publication_candidate_selections BEGIN
    SELECT CASE WHEN NEW.revision!=(SELECT COUNT(*)+1 FROM publication_candidate_selections WHERE root_run_id=NEW.root_run_id) OR NEW.expected_revision!=NEW.revision-1 OR (NEW.revision>1 AND NEW.previous_selection_id!=(SELECT id FROM publication_candidate_selections WHERE root_run_id=NEW.root_run_id ORDER BY revision DESC LIMIT 1)) THEN RAISE(ABORT,'publication selection revision conflict') END;
    SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM engineer_runs r JOIN verified_candidate_checkpoints c ON c.id=NEW.selected_checkpoint_id WHERE r.id=NEW.candidate_run_id AND r.user_id=NEW.requester_user_id AND r.repository_id=NEW.repository_id AND c.run_id=r.id AND c.checkpoint_hash=NEW.selected_checkpoint_hash AND c.result_commit_sha=NEW.selected_result_commit_sha) THEN RAISE(ABORT,'publication selection candidate mismatch') END;
    SELECT CASE WHEN NEW.candidate_kind='PARENT' AND NEW.candidate_run_id!=NEW.root_run_id THEN RAISE(ABORT,'parent publication selection must use root run') END;
    SELECT CASE WHEN NEW.candidate_kind='HARDENED_CHILD' AND NOT EXISTS(SELECT 1 FROM candidate_lineage_attestations a WHERE a.lineage_attestation_id=NEW.candidate_lineage_attestation_id AND a.lineage_attestation_hash=NEW.candidate_lineage_attestation_hash AND a.root_run_id=NEW.root_run_id AND a.child_run_id=NEW.candidate_run_id AND a.child_checkpoint_id=NEW.selected_checkpoint_id AND a.child_checkpoint_hash=NEW.selected_checkpoint_hash) THEN RAISE(ABORT,'child publication selection lacks verified lineage') END;
  END;
  CREATE TRIGGER require_approval_selection_v23 BEFORE INSERT ON approval_requests
    WHEN NEW.publication_selection_id IS NOT NULL OR NEW.publication_selection_hash IS NOT NULL BEGIN
    SELECT CASE WHEN NEW.publication_selection_id IS NULL OR NEW.publication_selection_hash IS NULL OR NOT EXISTS(SELECT 1 FROM publication_candidate_selections s WHERE s.id=NEW.publication_selection_id AND s.selection_hash=NEW.publication_selection_hash AND s.candidate_run_id=NEW.run_id AND s.selected_checkpoint_id=NEW.verified_checkpoint_id AND s.selected_checkpoint_hash=NEW.verified_checkpoint_hash AND s.revision=(SELECT MAX(latest.revision) FROM publication_candidate_selections latest WHERE latest.root_run_id=s.root_run_id)) THEN RAISE(ABORT,'approval publication selection binding mismatch') END;
  END;
  CREATE TRIGGER require_git_selection_v23 BEFORE INSERT ON git_operations
    WHEN NEW.publication_selection_id IS NOT NULL OR NEW.publication_selection_hash IS NOT NULL BEGIN
    SELECT CASE WHEN NEW.publication_selection_id IS NULL OR NEW.publication_selection_hash IS NULL OR NOT EXISTS(SELECT 1 FROM publication_candidate_selections s LEFT JOIN approval_requests a ON a.id=NEW.approval_id WHERE s.id=NEW.publication_selection_id AND s.selection_hash=NEW.publication_selection_hash AND s.candidate_run_id=NEW.run_id AND s.selected_checkpoint_id=NEW.verified_checkpoint_id AND s.selected_checkpoint_hash=NEW.verified_checkpoint_hash AND s.selected_result_commit_sha=NEW.result_commit_sha AND s.revision=(SELECT MAX(latest.revision) FROM publication_candidate_selections latest WHERE latest.root_run_id=s.root_run_id) AND (NEW.approval_id IS NULL OR (a.publication_selection_id=s.id AND a.publication_selection_hash=s.selection_hash))) THEN RAISE(ABORT,'git publication selection binding mismatch') END;
  END;
  CREATE TRIGGER prevent_approval_selection_rebinding_v23 BEFORE UPDATE ON approval_requests WHEN NEW.publication_selection_id IS NOT OLD.publication_selection_id OR NEW.publication_selection_hash IS NOT OLD.publication_selection_hash BEGIN SELECT RAISE(ABORT,'approval publication selection is immutable'); END;
  CREATE TRIGGER prevent_git_selection_rebinding_v23 BEFORE UPDATE ON git_operations WHEN NEW.publication_selection_id IS NOT OLD.publication_selection_id OR NEW.publication_selection_hash IS NOT OLD.publication_selection_hash BEGIN SELECT RAISE(ABORT,'git publication selection is immutable'); END;

  CREATE TRIGGER prevent_advisory_backlog_items_update_v23 BEFORE UPDATE ON advisory_backlog_items BEGIN SELECT RAISE(ABORT,'advisory backlog items are immutable'); END;
  CREATE TRIGGER prevent_advisory_backlog_items_delete_v23 BEFORE DELETE ON advisory_backlog_items BEGIN SELECT RAISE(ABORT,'advisory backlog items are immutable'); END;
  CREATE TRIGGER prevent_hardening_quote_advisories_update_v23 BEFORE UPDATE ON hardening_quote_advisories BEGIN SELECT RAISE(ABORT,'hardening quote mappings are immutable'); END;
  CREATE TRIGGER prevent_hardening_quote_advisories_delete_v23 BEFORE DELETE ON hardening_quote_advisories BEGIN SELECT RAISE(ABORT,'hardening quote mappings are immutable'); END;
  CREATE TRIGGER prevent_hardening_quotes_update_v23 BEFORE UPDATE ON hardening_quotes BEGIN SELECT RAISE(ABORT,'hardening quotes are immutable'); END;
  CREATE TRIGGER prevent_hardening_quotes_delete_v23 BEFORE DELETE ON hardening_quotes BEGIN SELECT RAISE(ABORT,'hardening quotes are immutable'); END;
  CREATE TRIGGER prevent_hardening_consents_update_v23 BEFORE UPDATE ON hardening_consents BEGIN SELECT RAISE(ABORT,'hardening consents are immutable'); END;
  CREATE TRIGGER prevent_hardening_consents_delete_v23 BEFORE DELETE ON hardening_consents BEGIN SELECT RAISE(ABORT,'hardening consents are immutable'); END;
  CREATE TRIGGER prevent_engineer_run_lineage_update_v23 BEFORE UPDATE ON engineer_run_lineage BEGIN SELECT RAISE(ABORT,'engineer run lineage is immutable'); END;
  CREATE TRIGGER prevent_engineer_run_lineage_delete_v23 BEFORE DELETE ON engineer_run_lineage BEGIN SELECT RAISE(ABORT,'engineer run lineage is immutable'); END;
  CREATE TRIGGER prevent_advisory_backlog_events_update_v23 BEFORE UPDATE ON advisory_backlog_events BEGIN SELECT RAISE(ABORT,'advisory backlog events are immutable'); END;
  CREATE TRIGGER prevent_advisory_backlog_events_delete_v23 BEFORE DELETE ON advisory_backlog_events BEGIN SELECT RAISE(ABORT,'advisory backlog events are immutable'); END;
  CREATE TRIGGER prevent_candidate_lineage_attestations_update_v23 BEFORE UPDATE ON candidate_lineage_attestations BEGIN SELECT RAISE(ABORT,'candidate lineage attestations are immutable'); END;
  CREATE TRIGGER prevent_candidate_lineage_attestations_delete_v23 BEFORE DELETE ON candidate_lineage_attestations BEGIN SELECT RAISE(ABORT,'candidate lineage attestations are immutable'); END;
  CREATE TRIGGER prevent_publication_candidate_selections_update_v23 BEFORE UPDATE ON publication_candidate_selections BEGIN SELECT RAISE(ABORT,'publication candidate selections are immutable'); END;
  CREATE TRIGGER prevent_publication_candidate_selections_delete_v23 BEFORE DELETE ON publication_candidate_selections BEGIN SELECT RAISE(ABORT,'publication candidate selections are immutable'); END;
`;

/** Durable request-idempotency authority for deterministic hardening quotes. */
export const ENGINEER_DATABASE_MIGRATION_24_SQL = `
  CREATE TABLE hardening_quote_requests (
    id TEXT PRIMARY KEY NOT NULL CHECK(length(id)=71 AND substr(id,1,7)='sha256:' AND substr(id,8) NOT GLOB '*[^0-9a-f]*'),
    request_hash TEXT NOT NULL UNIQUE CHECK(length(request_hash)=71 AND substr(request_hash,1,7)='sha256:' AND substr(request_hash,8) NOT GLOB '*[^0-9a-f]*'),
    requester_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    parent_run_id TEXT NOT NULL REFERENCES engineer_runs(id) ON DELETE RESTRICT,
    idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 200),
    quote_id TEXT NOT NULL UNIQUE REFERENCES hardening_quotes(id) ON DELETE RESTRICT,
    quote_hash TEXT NOT NULL REFERENCES hardening_quotes(quote_hash) ON DELETE RESTRICT,
    request_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(requester_user_id,idempotency_key)
  );
  CREATE INDEX idx_hardening_quote_requests_run_created_v24 ON hardening_quote_requests(parent_run_id,created_at,id);
  CREATE TRIGGER require_hardening_quote_request_binding_v24 BEFORE INSERT ON hardening_quote_requests BEGIN
    SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM hardening_quotes q WHERE q.id=NEW.quote_id AND q.quote_hash=NEW.quote_hash AND q.parent_run_id=NEW.parent_run_id AND q.requester_user_id=NEW.requester_user_id AND q.created_at=NEW.created_at) THEN RAISE(ABORT,'hardening quote request authority mismatch') END;
    SELECT CASE WHEN json_extract(NEW.request_json,'$.runId') IS NOT NEW.parent_run_id OR json_extract(NEW.request_json,'$.idempotencyKey') IS NOT NEW.idempotency_key OR json_extract(NEW.request_json,'$.requestHash') IS NOT NEW.request_hash THEN RAISE(ABORT,'hardening quote request projection mismatch') END;
  END;
  CREATE TRIGGER prevent_hardening_quote_requests_update_v24 BEFORE UPDATE ON hardening_quote_requests BEGIN SELECT RAISE(ABORT,'hardening quote requests are immutable'); END;
  CREATE TRIGGER prevent_hardening_quote_requests_delete_v24 BEFORE DELETE ON hardening_quote_requests BEGIN SELECT RAISE(ABORT,'hardening quote requests are immutable'); END;
`;

/** Permit an unstarted optional-hardening child budget to begin at revision zero. */
export const ENGINEER_DATABASE_MIGRATION_25_SQL = `
  CREATE TABLE run_budgets_v25 (
    run_id TEXT PRIMARY KEY REFERENCES engineer_runs(id) ON DELETE RESTRICT,
    cost_limit_usd REAL NOT NULL CHECK(cost_limit_usd >= 0), token_limit INTEGER NOT NULL CHECK(token_limit >= 0),
    time_limit_seconds INTEGER NOT NULL CHECK(time_limit_seconds > 0),
    lifetime_cost_limit_usd REAL NOT NULL CHECK(lifetime_cost_limit_usd >= cost_limit_usd),
    lifetime_token_limit INTEGER NOT NULL CHECK(lifetime_token_limit >= token_limit),
    lifetime_time_limit_seconds INTEGER NOT NULL CHECK(lifetime_time_limit_seconds >= time_limit_seconds),
    used_cost_usd REAL NOT NULL DEFAULT 0 CHECK(used_cost_usd >= 0), used_tokens INTEGER NOT NULL DEFAULT 0 CHECK(used_tokens >= 0),
    used_time_seconds INTEGER NOT NULL DEFAULT 0 CHECK(used_time_seconds >= 0), reserved_cost_usd REAL NOT NULL DEFAULT 0 CHECK(reserved_cost_usd >= 0),
    reserved_tokens INTEGER NOT NULL DEFAULT 0 CHECK(reserved_tokens >= 0),
    ambiguous_cost_usd REAL NOT NULL DEFAULT 0 CHECK(ambiguous_cost_usd >= 0),
    ambiguous_tokens INTEGER NOT NULL DEFAULT 0 CHECK(ambiguous_tokens >= 0),
    status TEXT NOT NULL CHECK(status IN ('ACTIVE', 'WARNING', 'PAUSED')),
    pause_reason TEXT, resume_state TEXT, warning_threshold REAL NOT NULL DEFAULT 0.8 CHECK(warning_threshold >= 0.5 AND warning_threshold <= 0.99),
    revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 0), active_since TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  INSERT INTO run_budgets_v25 SELECT * FROM run_budgets;
  DROP TABLE run_budgets;
  ALTER TABLE run_budgets_v25 RENAME TO run_budgets;
`;

/** Immutable idempotency and signed seed authority for starting optional-hardening children. */
export const ENGINEER_DATABASE_MIGRATION_26_SQL = `
  CREATE UNIQUE INDEX uq_engineer_run_lineage_pair_v26 ON engineer_run_lineage(id,lineage_hash);
  CREATE UNIQUE INDEX uq_verified_candidate_checkpoint_pair_v26 ON verified_candidate_checkpoints(id,checkpoint_hash);

  CREATE TABLE hardening_start_operations (
    id TEXT PRIMARY KEY NOT NULL CHECK(length(id)=71 AND substr(id,1,7)='sha256:' AND substr(id,8) NOT GLOB '*[^0-9a-f]*'),
    operation_hash TEXT NOT NULL UNIQUE CHECK(length(operation_hash)=71 AND substr(operation_hash,1,7)='sha256:' AND substr(operation_hash,8) NOT GLOB '*[^0-9a-f]*'),
    schema_version INTEGER NOT NULL CHECK(schema_version=1),
    policy_version TEXT NOT NULL CHECK(policy_version='engineer-hardening-start-operation-v1'),
    requester_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    child_run_id TEXT NOT NULL UNIQUE REFERENCES engineer_runs(id) ON DELETE RESTRICT,
    expected_child_state_version INTEGER NOT NULL CHECK(expected_child_state_version=0),
    lineage_id TEXT NOT NULL,
    lineage_hash TEXT NOT NULL,
    idempotency_key TEXT NOT NULL CHECK(length(idempotency_key)>0 AND length(idempotency_key)<=200),
    operation_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(requester_user_id,child_run_id,idempotency_key),
    FOREIGN KEY(lineage_id,lineage_hash) REFERENCES engineer_run_lineage(id,lineage_hash) ON DELETE RESTRICT
  );
  CREATE UNIQUE INDEX uq_hardening_start_operation_pair_v26 ON hardening_start_operations(id,operation_hash);
  CREATE INDEX idx_hardening_start_operations_child_created_v26 ON hardening_start_operations(child_run_id,created_at,id);

  CREATE TABLE hardening_seed_attestations (
    id TEXT PRIMARY KEY NOT NULL CHECK(length(id)=71 AND substr(id,1,7)='sha256:' AND substr(id,8) NOT GLOB '*[^0-9a-f]*'),
    seed_attestation_hash TEXT NOT NULL UNIQUE CHECK(length(seed_attestation_hash)=71 AND substr(seed_attestation_hash,1,7)='sha256:' AND substr(seed_attestation_hash,8) NOT GLOB '*[^0-9a-f]*'),
    schema_version INTEGER NOT NULL CHECK(schema_version=1),
    policy_version TEXT NOT NULL CHECK(policy_version='engineer-hardening-seed-attestation-v1'),
    attestation_type TEXT NOT NULL CHECK(attestation_type='HARDENING_SEED_VERIFIED'),
    operation_id TEXT NOT NULL UNIQUE,
    operation_hash TEXT NOT NULL,
    root_run_id TEXT NOT NULL REFERENCES engineer_runs(id) ON DELETE RESTRICT,
    parent_run_id TEXT NOT NULL REFERENCES engineer_runs(id) ON DELETE RESTRICT,
    child_run_id TEXT NOT NULL UNIQUE REFERENCES engineer_runs(id) ON DELETE RESTRICT,
    requester_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    repository_id TEXT NOT NULL REFERENCES repository_connections(id) ON DELETE RESTRICT,
    lineage_id TEXT NOT NULL,
    lineage_hash TEXT NOT NULL,
    parent_checkpoint_id TEXT NOT NULL,
    parent_checkpoint_hash TEXT NOT NULL,
    base_commit_sha TEXT NOT NULL,
    seed_result_commit_sha TEXT NOT NULL,
    seed_tree_hash TEXT NOT NULL,
    seed_diff_hash TEXT NOT NULL,
    image_digest TEXT NOT NULL,
    environment_digest TEXT NOT NULL,
    dependency_hash TEXT NOT NULL,
    attestation_json TEXT NOT NULL,
    statement_json TEXT NOT NULL,
    statement_hash TEXT NOT NULL,
    signature_algorithm TEXT NOT NULL,
    signature_key_id TEXT NOT NULL,
    signature TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(operation_id,operation_hash) REFERENCES hardening_start_operations(id,operation_hash) ON DELETE RESTRICT,
    FOREIGN KEY(lineage_id,lineage_hash) REFERENCES engineer_run_lineage(id,lineage_hash) ON DELETE RESTRICT,
    FOREIGN KEY(parent_checkpoint_id,parent_checkpoint_hash) REFERENCES verified_candidate_checkpoints(id,checkpoint_hash) ON DELETE RESTRICT
  );
  CREATE INDEX idx_hardening_seed_attestations_child_created_v26 ON hardening_seed_attestations(child_run_id,created_at,id);

  CREATE TRIGGER require_hardening_start_operation_binding_v26 BEFORE INSERT ON hardening_start_operations BEGIN
    SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM engineer_run_lineage l JOIN engineer_runs c ON c.id=l.child_run_id WHERE l.id=NEW.lineage_id AND l.lineage_hash=NEW.lineage_hash AND l.child_run_id=NEW.child_run_id AND l.requester_user_id=NEW.requester_user_id AND c.user_id=NEW.requester_user_id AND c.state='REQUEST_RECEIVED' AND c.state_version=NEW.expected_child_state_version) THEN RAISE(ABORT,'hardening start operation authority mismatch') END;
    SELECT CASE WHEN json_extract(NEW.operation_json,'$.operationId') IS NOT NEW.id OR json_extract(NEW.operation_json,'$.operationHash') IS NOT NEW.operation_hash OR json_extract(NEW.operation_json,'$.childRunId') IS NOT NEW.child_run_id OR json_extract(NEW.operation_json,'$.lineageId') IS NOT NEW.lineage_id OR json_extract(NEW.operation_json,'$.lineageHash') IS NOT NEW.lineage_hash OR json_extract(NEW.operation_json,'$.expectedChildStateVersion') IS NOT NEW.expected_child_state_version OR json_extract(NEW.operation_json,'$.idempotencyKey') IS NOT NEW.idempotency_key THEN RAISE(ABORT,'hardening start operation projection mismatch') END;
  END;
  CREATE TRIGGER require_hardening_seed_attestation_binding_v26 BEFORE INSERT ON hardening_seed_attestations BEGIN
    SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM hardening_start_operations o JOIN engineer_run_lineage l ON l.id=o.lineage_id AND l.lineage_hash=o.lineage_hash JOIN verified_candidate_checkpoints c ON c.id=l.parent_checkpoint_id AND c.checkpoint_hash=l.parent_checkpoint_hash WHERE o.id=NEW.operation_id AND o.operation_hash=NEW.operation_hash AND o.child_run_id=NEW.child_run_id AND o.requester_user_id=NEW.requester_user_id AND l.root_run_id=NEW.root_run_id AND l.parent_run_id=NEW.parent_run_id AND l.repository_id=NEW.repository_id AND l.id=NEW.lineage_id AND l.lineage_hash=NEW.lineage_hash AND c.id=NEW.parent_checkpoint_id AND c.checkpoint_hash=NEW.parent_checkpoint_hash AND c.base_commit_sha=NEW.base_commit_sha AND c.result_commit_sha=NEW.seed_result_commit_sha) THEN RAISE(ABORT,'hardening seed attestation authority mismatch') END;
    SELECT CASE WHEN json_extract(NEW.attestation_json,'$.seedAttestationId') IS NOT NEW.id OR json_extract(NEW.attestation_json,'$.seedAttestationHash') IS NOT NEW.seed_attestation_hash OR json_extract(NEW.attestation_json,'$.operationId') IS NOT NEW.operation_id OR json_extract(NEW.attestation_json,'$.operationHash') IS NOT NEW.operation_hash OR json_extract(NEW.attestation_json,'$.lineageId') IS NOT NEW.lineage_id OR json_extract(NEW.attestation_json,'$.lineageHash') IS NOT NEW.lineage_hash OR json_extract(NEW.attestation_json,'$.parentCheckpointId') IS NOT NEW.parent_checkpoint_id OR json_extract(NEW.attestation_json,'$.parentCheckpointHash') IS NOT NEW.parent_checkpoint_hash OR json_extract(NEW.attestation_json,'$.seedTreeHash') IS NOT NEW.seed_tree_hash OR json_extract(NEW.attestation_json,'$.seedDiffHash') IS NOT NEW.seed_diff_hash OR json_extract(NEW.attestation_json,'$.imageDigest') IS NOT NEW.image_digest OR json_extract(NEW.attestation_json,'$.environmentDigest') IS NOT NEW.environment_digest OR json_extract(NEW.attestation_json,'$.dependencyHash') IS NOT NEW.dependency_hash THEN RAISE(ABORT,'hardening seed attestation projection mismatch') END;
  END;
  CREATE TRIGGER prevent_hardening_start_operations_update_v26 BEFORE UPDATE ON hardening_start_operations BEGIN SELECT RAISE(ABORT,'hardening start operations are immutable'); END;
  CREATE TRIGGER prevent_hardening_start_operations_delete_v26 BEFORE DELETE ON hardening_start_operations BEGIN SELECT RAISE(ABORT,'hardening start operations are immutable'); END;
  CREATE TRIGGER prevent_hardening_seed_attestations_update_v26 BEFORE UPDATE ON hardening_seed_attestations BEGIN SELECT RAISE(ABORT,'hardening seed attestations are immutable'); END;
  CREATE TRIGGER prevent_hardening_seed_attestations_delete_v26 BEFORE DELETE ON hardening_seed_attestations BEGIN SELECT RAISE(ABORT,'hardening seed attestations are immutable'); END;
`;

/** Versioned verified-candidate storage for lineage-bound hardening candidates. */
export const ENGINEER_DATABASE_MIGRATION_27_SQL = `
  PRAGMA defer_foreign_keys=ON;
  DROP TRIGGER prevent_verified_candidate_checkpoints_update_v21;
  DROP TRIGGER prevent_verified_candidate_checkpoints_delete_v21;
  DROP TRIGGER require_verified_candidate_checkpoint_bindings_v21;
  CREATE UNIQUE INDEX uq_hardening_seed_attestation_pair_v27
    ON hardening_seed_attestations(id,seed_attestation_hash);

  CREATE TABLE verified_candidate_checkpoints_v27 (
    id TEXT PRIMARY KEY,
    checkpoint_hash TEXT NOT NULL UNIQUE,
    parent_checkpoint_id TEXT,
    parent_checkpoint_hash TEXT,
    hardening_lineage_id TEXT,
    hardening_lineage_hash TEXT,
    seed_attestation_id TEXT,
    seed_attestation_hash TEXT,
    run_id TEXT NOT NULL REFERENCES engineer_runs(id) ON DELETE RESTRICT,
    requester_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    repository_id TEXT NOT NULL REFERENCES repository_connections(id) ON DELETE RESTRICT,
    required_lane_contract_hash TEXT NOT NULL REFERENCES required_lane_contracts(contract_hash) ON DELETE RESTRICT,
    manifest_hash TEXT NOT NULL,
    base_commit_sha TEXT NOT NULL,
    result_commit_sha TEXT NOT NULL,
    diff_hash TEXT NOT NULL,
    reviewer_session_id TEXT NOT NULL REFERENCES reviewer_sessions(id) ON DELETE RESTRICT,
    classification_hash TEXT NOT NULL UNIQUE REFERENCES review_classification_batches(classification_hash) ON DELETE RESTRICT,
    classification_result TEXT NOT NULL CHECK(classification_result IN ('READY', 'READY_WITH_ADVISORIES')),
    evidence_bundle_id TEXT NOT NULL UNIQUE REFERENCES evidence_bundles(id) ON DELETE RESTRICT,
    evidence_bundle_hash TEXT NOT NULL,
    environment_digest TEXT NOT NULL,
    checkpoint_json TEXT NOT NULL,
    statement_json TEXT NOT NULL,
    statement_hash TEXT NOT NULL,
    signature_algorithm TEXT NOT NULL,
    signature_key_id TEXT NOT NULL,
    signature TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(id,checkpoint_hash),
    CHECK(
      (json_extract(checkpoint_json,'$.schemaVersion')=1 AND
       json_extract(checkpoint_json,'$.policyVersion')='verified-candidate-checkpoint-v1' AND
       json_type(checkpoint_json,'$.parentCheckpointId')='null' AND
       parent_checkpoint_id IS NULL AND parent_checkpoint_hash IS NULL AND
       hardening_lineage_id IS NULL AND hardening_lineage_hash IS NULL AND
       seed_attestation_id IS NULL AND seed_attestation_hash IS NULL) OR
      (json_extract(checkpoint_json,'$.schemaVersion')=2 AND
       json_extract(checkpoint_json,'$.policyVersion')='verified-hardening-candidate-checkpoint-v2' AND
       parent_checkpoint_id IS NOT NULL AND parent_checkpoint_hash IS NOT NULL AND
       hardening_lineage_id IS NOT NULL AND hardening_lineage_hash IS NOT NULL AND
       seed_attestation_id IS NOT NULL AND seed_attestation_hash IS NOT NULL)
    ),
    FOREIGN KEY(run_id, manifest_hash) REFERENCES task_manifest_versions(run_id, manifest_hash) ON DELETE RESTRICT,
    FOREIGN KEY(parent_checkpoint_id,parent_checkpoint_hash)
      REFERENCES verified_candidate_checkpoints(id,checkpoint_hash) ON DELETE RESTRICT,
    FOREIGN KEY(hardening_lineage_id,hardening_lineage_hash)
      REFERENCES engineer_run_lineage(id,lineage_hash) ON DELETE RESTRICT,
    FOREIGN KEY(seed_attestation_id,seed_attestation_hash)
      REFERENCES hardening_seed_attestations(id,seed_attestation_hash) ON DELETE RESTRICT
  );
  INSERT INTO verified_candidate_checkpoints_v27
    (id,checkpoint_hash,parent_checkpoint_id,parent_checkpoint_hash,hardening_lineage_id,hardening_lineage_hash,
     seed_attestation_id,seed_attestation_hash,run_id,requester_user_id,repository_id,required_lane_contract_hash,
     manifest_hash,base_commit_sha,result_commit_sha,diff_hash,reviewer_session_id,classification_hash,
     classification_result,evidence_bundle_id,evidence_bundle_hash,environment_digest,checkpoint_json,
     statement_json,statement_hash,signature_algorithm,signature_key_id,signature,created_at)
  SELECT id,checkpoint_hash,NULL,NULL,NULL,NULL,NULL,NULL,run_id,requester_user_id,repository_id,
     required_lane_contract_hash,manifest_hash,base_commit_sha,result_commit_sha,diff_hash,reviewer_session_id,
     classification_hash,classification_result,evidence_bundle_id,evidence_bundle_hash,environment_digest,
     checkpoint_json,statement_json,statement_hash,signature_algorithm,signature_key_id,signature,created_at
  FROM verified_candidate_checkpoints;
  DROP TABLE verified_candidate_checkpoints;
  ALTER TABLE verified_candidate_checkpoints_v27 RENAME TO verified_candidate_checkpoints;

  CREATE INDEX idx_verified_candidate_checkpoints_run_created
    ON verified_candidate_checkpoints(run_id, created_at);
  CREATE UNIQUE INDEX uq_verified_candidate_checkpoint_pair_v26
    ON verified_candidate_checkpoints(id,checkpoint_hash);
  CREATE TRIGGER prevent_verified_candidate_checkpoints_update_v21
    BEFORE UPDATE ON verified_candidate_checkpoints BEGIN
      SELECT RAISE(ABORT, 'verified candidate checkpoints are immutable');
    END;
  CREATE TRIGGER prevent_verified_candidate_checkpoints_delete_v21
    BEFORE DELETE ON verified_candidate_checkpoints BEGIN
      SELECT RAISE(ABORT, 'verified candidate checkpoints are immutable');
    END;
  CREATE TRIGGER require_verified_candidate_checkpoint_bindings_v21
    BEFORE INSERT ON verified_candidate_checkpoints BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM engineer_runs r
        WHERE r.id = NEW.run_id AND r.user_id = NEW.requester_user_id
          AND r.repository_id = NEW.repository_id AND r.base_commit_sha = NEW.base_commit_sha
          AND r.manifest_hash = NEW.manifest_hash
      ) THEN RAISE(ABORT, 'checkpoint run binding mismatch') END;
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM required_lane_contracts c
        WHERE c.contract_hash = NEW.required_lane_contract_hash AND c.run_id = NEW.run_id
          AND c.manifest_hash = NEW.manifest_hash
      ) THEN RAISE(ABORT, 'checkpoint contract binding mismatch') END;
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM reviewer_sessions s
        WHERE s.id = NEW.reviewer_session_id AND s.run_id = NEW.run_id
          AND s.manifest_hash = NEW.manifest_hash AND s.diff_hash = NEW.diff_hash
      ) THEN RAISE(ABORT, 'checkpoint reviewer binding mismatch') END;
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM review_classification_batches b
        WHERE b.classification_hash = NEW.classification_hash
          AND b.reviewer_session_id = NEW.reviewer_session_id AND b.run_id = NEW.run_id
          AND b.contract_hash = NEW.required_lane_contract_hash
          AND json_extract(b.batch_json, '$.result') = NEW.classification_result
      ) THEN RAISE(ABORT, 'checkpoint classification binding mismatch') END;
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM evidence_bundles e
        WHERE e.id = NEW.evidence_bundle_id AND e.run_id = NEW.run_id
          AND e.bundle_hash = NEW.evidence_bundle_hash AND e.manifest_hash = NEW.manifest_hash
          AND e.base_commit_sha = NEW.base_commit_sha AND e.result_commit_sha = NEW.result_commit_sha
          AND e.environment_digest = NEW.environment_digest
          AND json_extract(e.manifest_json, '$.bundleVersion') = 2
          AND json_extract(e.manifest_json, '$.reviewerSessionId') = NEW.reviewer_session_id
          AND json_extract(e.manifest_json, '$.classificationHash') = NEW.classification_hash
          AND json_extract(e.manifest_json, '$.classificationResult') = NEW.classification_result
      ) THEN RAISE(ABORT, 'checkpoint evidence bundle binding mismatch') END;
    END;
  CREATE TRIGGER require_verified_candidate_checkpoint_version_v27
    BEFORE INSERT ON verified_candidate_checkpoints BEGIN
      SELECT CASE WHEN NOT (
        (NEW.parent_checkpoint_id IS NULL AND NEW.parent_checkpoint_hash IS NULL AND
         NEW.hardening_lineage_id IS NULL AND NEW.hardening_lineage_hash IS NULL AND
         NEW.seed_attestation_id IS NULL AND NEW.seed_attestation_hash IS NULL) OR
        (json_extract(NEW.checkpoint_json,'$.schemaVersion')=2 AND
         json_extract(NEW.checkpoint_json,'$.policyVersion')='verified-hardening-candidate-checkpoint-v2' AND
         json_extract(NEW.checkpoint_json,'$.parentCheckpointId') IS NEW.parent_checkpoint_id AND
         json_extract(NEW.checkpoint_json,'$.parentCheckpointHash') IS NEW.parent_checkpoint_hash AND
         json_extract(NEW.checkpoint_json,'$.hardeningLineageId') IS NEW.hardening_lineage_id AND
         json_extract(NEW.checkpoint_json,'$.hardeningLineageHash') IS NEW.hardening_lineage_hash AND
         json_extract(NEW.checkpoint_json,'$.seedAttestationId') IS NEW.seed_attestation_id AND
         json_extract(NEW.checkpoint_json,'$.seedAttestationHash') IS NEW.seed_attestation_hash)
      ) THEN RAISE(ABORT,'verified candidate checkpoint version binding mismatch') END;
    END;
`;

/** Pre-side-effect hardening fencing and fail-closed paid model-call slots. */
export const ENGINEER_DATABASE_MIGRATION_28_SQL = `
  CREATE TABLE hardening_start_claims (
    id TEXT PRIMARY KEY NOT NULL CHECK(length(id)=71 AND substr(id,1,7)='sha256:' AND substr(id,8) NOT GLOB '*[^0-9a-f]*'),
    intent_hash TEXT NOT NULL UNIQUE CHECK(length(intent_hash)=71 AND substr(intent_hash,1,7)='sha256:' AND substr(intent_hash,8) NOT GLOB '*[^0-9a-f]*'),
    schema_version INTEGER NOT NULL CHECK(schema_version=1),
    policy_version TEXT NOT NULL CHECK(policy_version='engineer-hardening-start-claim-v1'),
    requester_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    root_run_id TEXT NOT NULL REFERENCES engineer_runs(id) ON DELETE RESTRICT,
    parent_run_id TEXT NOT NULL REFERENCES engineer_runs(id) ON DELETE RESTRICT,
    child_run_id TEXT NOT NULL UNIQUE REFERENCES engineer_runs(id) ON DELETE RESTRICT,
    repository_id TEXT NOT NULL REFERENCES repository_connections(id) ON DELETE RESTRICT,
    parent_checkpoint_id TEXT NOT NULL,
    parent_checkpoint_hash TEXT NOT NULL,
    lineage_id TEXT NOT NULL,
    lineage_hash TEXT NOT NULL,
    quote_id TEXT NOT NULL,
    quote_hash TEXT NOT NULL,
    consent_id TEXT NOT NULL,
    consent_hash TEXT NOT NULL,
    intended_operation_id TEXT NOT NULL,
    intended_operation_hash TEXT NOT NULL,
    idempotency_key TEXT NOT NULL CHECK(length(idempotency_key)>0 AND length(idempotency_key)<=200),
    intent_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('PREPARING','FINALIZED')),
    owner_id TEXT NOT NULL CHECK(length(owner_id)>0 AND length(owner_id)<=200),
    fence_token TEXT NOT NULL CHECK(length(fence_token)=71 AND substr(fence_token,1,7)='sha256:' AND substr(fence_token,8) NOT GLOB '*[^0-9a-f]*'),
    generation INTEGER NOT NULL CHECK(generation>0),
    lease_expires_at TEXT NOT NULL,
    finalized_operation_id TEXT,
    finalized_operation_hash TEXT,
    seed_attestation_id TEXT,
    seed_attestation_hash TEXT,
    sandbox_id TEXT REFERENCES sandboxes(id) ON DELETE RESTRICT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(requester_user_id,child_run_id,idempotency_key),
    FOREIGN KEY(parent_checkpoint_id,parent_checkpoint_hash) REFERENCES verified_candidate_checkpoints(id,checkpoint_hash) ON DELETE RESTRICT,
    FOREIGN KEY(lineage_id,lineage_hash) REFERENCES engineer_run_lineage(id,lineage_hash) ON DELETE RESTRICT,
    FOREIGN KEY(quote_id) REFERENCES hardening_quotes(id) ON DELETE RESTRICT,
    FOREIGN KEY(quote_hash) REFERENCES hardening_quotes(quote_hash) ON DELETE RESTRICT,
    FOREIGN KEY(consent_id) REFERENCES hardening_consents(id) ON DELETE RESTRICT,
    FOREIGN KEY(consent_hash) REFERENCES hardening_consents(consent_hash) ON DELETE RESTRICT,
    FOREIGN KEY(finalized_operation_id,finalized_operation_hash) REFERENCES hardening_start_operations(id,operation_hash) ON DELETE RESTRICT,
    FOREIGN KEY(seed_attestation_id,seed_attestation_hash) REFERENCES hardening_seed_attestations(id,seed_attestation_hash) ON DELETE RESTRICT,
    CHECK((status='PREPARING' AND finalized_operation_id IS NULL AND finalized_operation_hash IS NULL AND seed_attestation_id IS NULL AND seed_attestation_hash IS NULL AND sandbox_id IS NULL) OR
          (status='FINALIZED' AND finalized_operation_id IS NOT NULL AND finalized_operation_hash IS NOT NULL AND seed_attestation_id IS NOT NULL AND seed_attestation_hash IS NOT NULL AND sandbox_id IS NOT NULL))
  );
  CREATE INDEX idx_hardening_start_claims_recovery_v28 ON hardening_start_claims(status,lease_expires_at,child_run_id);
  CREATE TRIGGER require_hardening_start_claim_binding_v28 BEFORE INSERT ON hardening_start_claims BEGIN
    SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM engineer_run_lineage l JOIN engineer_runs p ON p.id=l.parent_run_id JOIN engineer_runs c ON c.id=l.child_run_id JOIN hardening_quotes q ON q.id=l.quote_id AND q.quote_hash=l.quote_hash JOIN hardening_consents k ON k.id=l.consent_id AND k.consent_hash=l.consent_hash WHERE l.id=NEW.lineage_id AND l.lineage_hash=NEW.lineage_hash AND l.root_run_id=NEW.root_run_id AND l.parent_run_id=NEW.parent_run_id AND l.child_run_id=NEW.child_run_id AND l.requester_user_id=NEW.requester_user_id AND l.repository_id=NEW.repository_id AND l.parent_checkpoint_id=NEW.parent_checkpoint_id AND l.parent_checkpoint_hash=NEW.parent_checkpoint_hash AND l.quote_id=NEW.quote_id AND l.quote_hash=NEW.quote_hash AND l.consent_id=NEW.consent_id AND l.consent_hash=NEW.consent_hash AND p.user_id=NEW.requester_user_id AND c.user_id=NEW.requester_user_id AND c.repository_id=NEW.repository_id) THEN RAISE(ABORT,'hardening start claim ancestry mismatch') END;
    SELECT CASE WHEN json_extract(NEW.intent_json,'$.requesterUserId') IS NOT NEW.requester_user_id OR json_extract(NEW.intent_json,'$.rootRunId') IS NOT NEW.root_run_id OR json_extract(NEW.intent_json,'$.parentRunId') IS NOT NEW.parent_run_id OR json_extract(NEW.intent_json,'$.childRunId') IS NOT NEW.child_run_id OR json_extract(NEW.intent_json,'$.repositoryId') IS NOT NEW.repository_id OR json_extract(NEW.intent_json,'$.parentCheckpointId') IS NOT NEW.parent_checkpoint_id OR json_extract(NEW.intent_json,'$.parentCheckpointHash') IS NOT NEW.parent_checkpoint_hash OR json_extract(NEW.intent_json,'$.lineageId') IS NOT NEW.lineage_id OR json_extract(NEW.intent_json,'$.lineageHash') IS NOT NEW.lineage_hash OR json_extract(NEW.intent_json,'$.quoteId') IS NOT NEW.quote_id OR json_extract(NEW.intent_json,'$.quoteHash') IS NOT NEW.quote_hash OR json_extract(NEW.intent_json,'$.consentId') IS NOT NEW.consent_id OR json_extract(NEW.intent_json,'$.consentHash') IS NOT NEW.consent_hash OR json_extract(NEW.intent_json,'$.operationId') IS NOT NEW.intended_operation_id OR json_extract(NEW.intent_json,'$.operationHash') IS NOT NEW.intended_operation_hash OR json_extract(NEW.intent_json,'$.idempotencyKey') IS NOT NEW.idempotency_key THEN RAISE(ABORT,'hardening start claim projection mismatch') END;
  END;
  CREATE TRIGGER fence_hardening_start_claim_update_v28 BEFORE UPDATE ON hardening_start_claims BEGIN
    SELECT CASE WHEN OLD.id IS NOT NEW.id OR OLD.intent_hash IS NOT NEW.intent_hash OR OLD.schema_version IS NOT NEW.schema_version OR OLD.policy_version IS NOT NEW.policy_version OR OLD.requester_user_id IS NOT NEW.requester_user_id OR OLD.root_run_id IS NOT NEW.root_run_id OR OLD.parent_run_id IS NOT NEW.parent_run_id OR OLD.child_run_id IS NOT NEW.child_run_id OR OLD.repository_id IS NOT NEW.repository_id OR OLD.parent_checkpoint_id IS NOT NEW.parent_checkpoint_id OR OLD.parent_checkpoint_hash IS NOT NEW.parent_checkpoint_hash OR OLD.lineage_id IS NOT NEW.lineage_id OR OLD.lineage_hash IS NOT NEW.lineage_hash OR OLD.quote_id IS NOT NEW.quote_id OR OLD.quote_hash IS NOT NEW.quote_hash OR OLD.consent_id IS NOT NEW.consent_id OR OLD.consent_hash IS NOT NEW.consent_hash OR OLD.intended_operation_id IS NOT NEW.intended_operation_id OR OLD.intended_operation_hash IS NOT NEW.intended_operation_hash OR OLD.idempotency_key IS NOT NEW.idempotency_key OR OLD.intent_json IS NOT NEW.intent_json OR OLD.created_at IS NOT NEW.created_at THEN RAISE(ABORT,'hardening start claim immutable authority mismatch') END;
    SELECT CASE WHEN OLD.status='FINALIZED' THEN RAISE(ABORT,'finalized hardening start claim is immutable') END;
    SELECT CASE WHEN NEW.generation<OLD.generation OR NEW.generation>OLD.generation+1 OR (NEW.generation=OLD.generation AND (NEW.owner_id IS NOT OLD.owner_id OR NEW.fence_token IS NOT OLD.fence_token OR NEW.lease_expires_at IS NOT OLD.lease_expires_at)) OR (NEW.generation=OLD.generation+1 AND NEW.status!='PREPARING') THEN RAISE(ABORT,'hardening start claim fence transition mismatch') END;
  END;
  CREATE TRIGGER prevent_hardening_start_claim_delete_v28 BEFORE DELETE ON hardening_start_claims BEGIN SELECT RAISE(ABORT,'hardening start claims are durable'); END;

  CREATE TABLE hardening_model_call_slots (
    id TEXT PRIMARY KEY NOT NULL CHECK(length(id)=71 AND substr(id,1,7)='sha256:' AND substr(id,8) NOT GLOB '*[^0-9a-f]*'),
    schema_version INTEGER NOT NULL CHECK(schema_version=1),
    policy_version TEXT NOT NULL CHECK(policy_version='engineer-hardening-model-call-slot-v1'),
    child_run_id TEXT NOT NULL REFERENCES engineer_runs(id) ON DELETE RESTRICT,
    role TEXT NOT NULL CHECK(role IN ('BUILDER','REVIEWER')),
    model_tier TEXT NOT NULL CHECK((role='BUILDER' AND model_tier='GPT-5.6_TERRA') OR (role='REVIEWER' AND model_tier='GPT-5.6_SOL')),
    status TEXT NOT NULL CHECK(status IN ('CLAIMED','COMPLETED','FAILED','AMBIGUOUS')),
    claimant_id TEXT NOT NULL CHECK(length(claimant_id)>0 AND length(claimant_id)<=200),
    idempotency_key TEXT NOT NULL CHECK(length(idempotency_key)>0 AND length(idempotency_key)<=200),
    model_call_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(child_run_id,role),
    UNIQUE(child_run_id,idempotency_key)
  );
  CREATE INDEX idx_hardening_model_call_slots_child_v28 ON hardening_model_call_slots(child_run_id,role,status);
  CREATE TRIGGER require_hardening_model_call_slot_child_v28 BEFORE INSERT ON hardening_model_call_slots BEGIN
    SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM engineer_run_lineage l JOIN hardening_start_claims c ON c.child_run_id=l.child_run_id AND c.status='FINALIZED' WHERE l.child_run_id=NEW.child_run_id AND l.relation='OPTIONAL_HARDENING') THEN RAISE(ABORT,'hardening paid-call child authority mismatch') END;
  END;
  CREATE TRIGGER fence_hardening_model_call_slot_update_v28 BEFORE UPDATE ON hardening_model_call_slots BEGIN
    SELECT CASE WHEN OLD.id IS NOT NEW.id OR OLD.schema_version IS NOT NEW.schema_version OR OLD.policy_version IS NOT NEW.policy_version OR OLD.child_run_id IS NOT NEW.child_run_id OR OLD.role IS NOT NEW.role OR OLD.model_tier IS NOT NEW.model_tier OR OLD.claimant_id IS NOT NEW.claimant_id OR OLD.idempotency_key IS NOT NEW.idempotency_key OR OLD.created_at IS NOT NEW.created_at THEN RAISE(ABORT,'hardening paid-call immutable authority mismatch') END;
    SELECT CASE WHEN OLD.status!='CLAIMED' OR NEW.status NOT IN ('COMPLETED','FAILED','AMBIGUOUS') THEN RAISE(ABORT,'hardening paid-call slot is already consumed') END;
  END;
  CREATE TRIGGER prevent_hardening_model_call_slot_delete_v28 BEFORE DELETE ON hardening_model_call_slots BEGIN SELECT RAISE(ABORT,'hardening paid-call slots are durable'); END;
`;

/** Integer, consent-bound, no-overage authority for optional-hardening children. */
export const ENGINEER_DATABASE_MIGRATION_29_SQL = `
  PRAGMA defer_foreign_keys=ON;

  CREATE TABLE hardening_quote_sizing_authorities (
    id TEXT PRIMARY KEY NOT NULL CHECK(length(id)=71 AND substr(id,1,7)='sha256:' AND substr(id,8) NOT GLOB '*[^0-9a-f]*'),
    sizing_authority_hash TEXT NOT NULL UNIQUE CHECK(length(sizing_authority_hash)=71 AND substr(sizing_authority_hash,1,7)='sha256:' AND substr(sizing_authority_hash,8) NOT GLOB '*[^0-9a-f]*'),
    schema_version INTEGER NOT NULL CHECK(schema_version=1),
    policy_version TEXT NOT NULL CHECK(policy_version='engineer-hardening-quote-sizing-authority-v1'),
    estimator_version TEXT NOT NULL CHECK(estimator_version='deterministic-hardening-estimator-v2'),
    local_input_counter_version TEXT NOT NULL CHECK(local_input_counter_version='response-input-byte-upper-bound-v1'),
    builder_prompt_version TEXT NOT NULL CHECK(builder_prompt_version='engineer-codex-builder-v3'),
    reviewer_policy_version TEXT NOT NULL CHECK(reviewer_policy_version='engineer-isolated-reviewer-v6'),
    cache_policy_version TEXT NOT NULL CHECK(cache_policy_version='engineer-hardening-prompt-cache-v1'),
    cache_accounting_version TEXT NOT NULL CHECK(cache_accounting_version='openai-prompt-cache-accounting-v1'),
    cache_write_input_multiplier_numerator INTEGER NOT NULL CHECK(cache_write_input_multiplier_numerator=5),
    cache_write_input_multiplier_denominator INTEGER NOT NULL CHECK(cache_write_input_multiplier_denominator=4),
    parent_run_id TEXT NOT NULL REFERENCES engineer_runs(id) ON DELETE RESTRICT,
    requester_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    repository_id TEXT NOT NULL REFERENCES repository_connections(id) ON DELETE RESTRICT,
    parent_checkpoint_id TEXT NOT NULL,
    parent_checkpoint_hash TEXT NOT NULL,
    parent_manifest_hash TEXT NOT NULL,
    selection_hash TEXT NOT NULL CHECK(length(selection_hash)=71 AND substr(selection_hash,1,7)='sha256:' AND substr(selection_hash,8) NOT GLOB '*[^0-9a-f]*'),
    advisory_ids_json TEXT NOT NULL,
    advisory_projection_hash TEXT NOT NULL CHECK(length(advisory_projection_hash)=71 AND substr(advisory_projection_hash,1,7)='sha256:' AND substr(advisory_projection_hash,8) NOT GLOB '*[^0-9a-f]*'),
    advisory_count INTEGER NOT NULL CHECK(advisory_count BETWEEN 1 AND 20),
    unique_file_count INTEGER NOT NULL CHECK(unique_file_count BETWEEN 0 AND 20),
    builder_sizing_template_hash TEXT NOT NULL CHECK(length(builder_sizing_template_hash)=71 AND substr(builder_sizing_template_hash,1,7)='sha256:' AND substr(builder_sizing_template_hash,8) NOT GLOB '*[^0-9a-f]*'),
    builder_sizing_input_token_upper_bound INTEGER NOT NULL CHECK(builder_sizing_input_token_upper_bound>0),
    builder_input_token_cap INTEGER NOT NULL CHECK(builder_input_token_cap BETWEEN 1 AND 40000),
    builder_output_token_cap INTEGER NOT NULL CHECK(builder_output_token_cap=6000),
    reviewer_input_token_cap INTEGER NOT NULL CHECK(reviewer_input_token_cap=40000),
    reviewer_output_token_cap INTEGER NOT NULL CHECK(reviewer_output_token_cap=12000),
    authority_json TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    UNIQUE(id,sizing_authority_hash),
    FOREIGN KEY(parent_checkpoint_id,parent_checkpoint_hash) REFERENCES verified_candidate_checkpoints(id,checkpoint_hash) ON DELETE RESTRICT,
    FOREIGN KEY(parent_run_id,parent_manifest_hash) REFERENCES task_manifest_versions(run_id,manifest_hash) ON DELETE RESTRICT,
    CHECK(builder_sizing_input_token_upper_bound<=builder_input_token_cap),
    CHECK(json_array_length(advisory_ids_json)=advisory_count)
  );
  CREATE UNIQUE INDEX uq_hardening_quote_sizing_authority_pair_v29 ON hardening_quote_sizing_authorities(id,sizing_authority_hash);
  CREATE INDEX idx_hardening_quote_sizing_checkpoint_v29 ON hardening_quote_sizing_authorities(parent_checkpoint_id,selection_hash,id);
  CREATE TRIGGER require_hardening_quote_sizing_authority_projection_v29 BEFORE INSERT ON hardening_quote_sizing_authorities BEGIN
    SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM verified_candidate_checkpoints c JOIN engineer_runs r ON r.id=c.run_id
      JOIN task_manifest_versions m ON m.run_id=c.run_id AND m.manifest_hash=c.manifest_hash
      WHERE c.id=NEW.parent_checkpoint_id AND c.checkpoint_hash=NEW.parent_checkpoint_hash AND c.run_id=NEW.parent_run_id
        AND c.requester_user_id=NEW.requester_user_id AND c.repository_id=NEW.repository_id AND m.manifest_hash=NEW.parent_manifest_hash)
      THEN RAISE(ABORT,'hardening quote sizing parent authority mismatch') END;
    SELECT CASE WHEN json_extract(NEW.authority_json,'$.sizingAuthorityId')!=NEW.id OR
      json_extract(NEW.authority_json,'$.sizingAuthorityHash')!=NEW.sizing_authority_hash OR
      json_extract(NEW.authority_json,'$.schemaVersion')!=NEW.schema_version OR
      json_extract(NEW.authority_json,'$.policyVersion')!=NEW.policy_version OR
      json_extract(NEW.authority_json,'$.estimatorVersion')!=NEW.estimator_version OR
      json_extract(NEW.authority_json,'$.localInputCounterVersion')!=NEW.local_input_counter_version OR
      json_extract(NEW.authority_json,'$.builderPromptVersion')!=NEW.builder_prompt_version OR
      json_extract(NEW.authority_json,'$.reviewerPolicyVersion')!=NEW.reviewer_policy_version OR
      json_extract(NEW.authority_json,'$.cachePolicyVersion')!=NEW.cache_policy_version OR
      json_extract(NEW.authority_json,'$.cacheAccountingVersion')!=NEW.cache_accounting_version OR
      json_extract(NEW.authority_json,'$.cacheWriteInputMultiplier.numerator')!=NEW.cache_write_input_multiplier_numerator OR
      json_extract(NEW.authority_json,'$.cacheWriteInputMultiplier.denominator')!=NEW.cache_write_input_multiplier_denominator OR
      json_extract(NEW.authority_json,'$.parentRunId')!=NEW.parent_run_id OR
      json_extract(NEW.authority_json,'$.requesterUserId')!=NEW.requester_user_id OR
      json_extract(NEW.authority_json,'$.repositoryId')!=NEW.repository_id OR
      json_extract(NEW.authority_json,'$.parentCheckpointId')!=NEW.parent_checkpoint_id OR
      json_extract(NEW.authority_json,'$.parentCheckpointHash')!=NEW.parent_checkpoint_hash OR
      json_extract(NEW.authority_json,'$.parentManifestHash')!=NEW.parent_manifest_hash OR
      json_extract(NEW.authority_json,'$.selectionHash')!=NEW.selection_hash OR
      json(json_extract(NEW.authority_json,'$.advisoryIds'))!=json(NEW.advisory_ids_json) OR
      json_extract(NEW.authority_json,'$.advisoryProjectionHash')!=NEW.advisory_projection_hash OR
      json_extract(NEW.authority_json,'$.advisoryCount')!=NEW.advisory_count OR
      json_extract(NEW.authority_json,'$.uniqueFileCount')!=NEW.unique_file_count OR
      json_extract(NEW.authority_json,'$.builderSizingTemplateHash')!=NEW.builder_sizing_template_hash OR
      json_extract(NEW.authority_json,'$.builderSizingInputTokenUpperBound')!=NEW.builder_sizing_input_token_upper_bound OR
      json_extract(NEW.authority_json,'$.inputCaps.builderInputTokens')!=NEW.builder_input_token_cap OR
      json_extract(NEW.authority_json,'$.inputCaps.builderOutputTokens')!=NEW.builder_output_token_cap OR
      json_extract(NEW.authority_json,'$.inputCaps.reviewerInputTokens')!=NEW.reviewer_input_token_cap OR
      json_extract(NEW.authority_json,'$.inputCaps.reviewerOutputTokens')!=NEW.reviewer_output_token_cap
      THEN RAISE(ABORT,'hardening quote sizing JSON projection mismatch') END;
  END;
  CREATE TRIGGER prevent_hardening_quote_sizing_authority_update_v29 BEFORE UPDATE ON hardening_quote_sizing_authorities BEGIN SELECT RAISE(ABORT,'hardening quote sizing authorities are immutable'); END;
  CREATE TRIGGER prevent_hardening_quote_sizing_authority_delete_v29 BEFORE DELETE ON hardening_quote_sizing_authorities BEGIN SELECT RAISE(ABORT,'hardening quote sizing authorities are immutable'); END;

  CREATE TABLE hardening_quotes_v29 (
    id TEXT PRIMARY KEY NOT NULL CHECK(length(id)=71 AND substr(id,1,7)='sha256:' AND substr(id,8) NOT GLOB '*[^0-9a-f]*'),
    quote_hash TEXT NOT NULL UNIQUE CHECK(length(quote_hash)=71 AND substr(quote_hash,1,7)='sha256:' AND substr(quote_hash,8) NOT GLOB '*[^0-9a-f]*'),
    schema_version INTEGER NOT NULL CHECK(schema_version IN (1,2)),
    policy_version TEXT NOT NULL,
    estimator_version TEXT NOT NULL,
    parent_run_id TEXT NOT NULL REFERENCES engineer_runs(id) ON DELETE RESTRICT,
    requester_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    repository_id TEXT NOT NULL REFERENCES repository_connections(id) ON DELETE RESTRICT,
    parent_checkpoint_id TEXT NOT NULL REFERENCES verified_candidate_checkpoints(id) ON DELETE RESTRICT,
    parent_checkpoint_hash TEXT NOT NULL REFERENCES verified_candidate_checkpoints(checkpoint_hash) ON DELETE RESTRICT,
    parent_state_version INTEGER NOT NULL CHECK(parent_state_version>=0),
    selection_hash TEXT NOT NULL CHECK(length(selection_hash)=71 AND substr(selection_hash,1,7)='sha256:' AND substr(selection_hash,8) NOT GLOB '*[^0-9a-f]*'),
    advisory_count INTEGER NOT NULL CHECK(advisory_count BETWEEN 1 AND 20),
    routing_policy_version TEXT NOT NULL, pricing_version TEXT NOT NULL,
    max_cost_microusd INTEGER NOT NULL CHECK(max_cost_microusd BETWEEN 0 AND 100000000),
    max_tokens INTEGER NOT NULL CHECK(max_tokens BETWEEN 0 AND 1000000),
    max_time_seconds INTEGER NOT NULL CHECK(max_time_seconds BETWEEN 1 AND 86400),
    max_planner_calls INTEGER NOT NULL CHECK(max_planner_calls BETWEEN 0 AND 1),
    max_builder_calls INTEGER NOT NULL CHECK(max_builder_calls=1), max_reviewer_calls INTEGER NOT NULL CHECK(max_reviewer_calls=1),
    automatic_repair_calls INTEGER NOT NULL CHECK(automatic_repair_calls=0),
    sizing_authority_id TEXT, sizing_authority_hash TEXT, local_input_counter_version TEXT, builder_prompt_version TEXT,
    reviewer_policy_version TEXT, cache_policy_version TEXT, cache_accounting_version TEXT,
    cache_write_input_multiplier_numerator INTEGER, cache_write_input_multiplier_denominator INTEGER,
    builder_input_token_cap INTEGER, builder_output_token_cap INTEGER, reviewer_input_token_cap INTEGER, reviewer_output_token_cap INTEGER,
    quote_json TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL CHECK(expires_at>created_at),
    FOREIGN KEY(sizing_authority_id,sizing_authority_hash) REFERENCES hardening_quote_sizing_authorities(id,sizing_authority_hash) ON DELETE RESTRICT,
    CHECK((schema_version=1 AND policy_version='engineer-hardening-estimate-v1' AND estimator_version='deterministic-hardening-estimator-v1'
      AND sizing_authority_id IS NULL AND sizing_authority_hash IS NULL AND local_input_counter_version IS NULL AND builder_prompt_version IS NULL
      AND reviewer_policy_version IS NULL AND cache_policy_version IS NULL AND cache_accounting_version IS NULL
      AND cache_write_input_multiplier_numerator IS NULL AND cache_write_input_multiplier_denominator IS NULL
      AND builder_input_token_cap IS NULL AND builder_output_token_cap IS NULL AND reviewer_input_token_cap IS NULL AND reviewer_output_token_cap IS NULL)
      OR (schema_version=2 AND policy_version='engineer-hardening-estimate-v2' AND estimator_version='deterministic-hardening-estimator-v2'
      AND sizing_authority_id IS NOT NULL AND sizing_authority_hash IS NOT NULL AND local_input_counter_version='response-input-byte-upper-bound-v1'
      AND builder_prompt_version='engineer-codex-builder-v3' AND reviewer_policy_version='engineer-isolated-reviewer-v6'
      AND cache_policy_version='engineer-hardening-prompt-cache-v1' AND cache_accounting_version='openai-prompt-cache-accounting-v1'
      AND cache_write_input_multiplier_numerator=5 AND cache_write_input_multiplier_denominator=4
      AND builder_input_token_cap BETWEEN 1 AND 40000 AND builder_output_token_cap=6000
      AND reviewer_input_token_cap=40000 AND reviewer_output_token_cap=12000))
  );
  INSERT INTO hardening_quotes_v29(id,quote_hash,schema_version,policy_version,estimator_version,parent_run_id,requester_user_id,
    repository_id,parent_checkpoint_id,parent_checkpoint_hash,parent_state_version,selection_hash,advisory_count,routing_policy_version,
    pricing_version,max_cost_microusd,max_tokens,max_time_seconds,max_planner_calls,max_builder_calls,max_reviewer_calls,
    automatic_repair_calls,quote_json,created_at,expires_at)
    SELECT id,quote_hash,schema_version,policy_version,estimator_version,parent_run_id,requester_user_id,repository_id,parent_checkpoint_id,
    parent_checkpoint_hash,parent_state_version,selection_hash,advisory_count,routing_policy_version,pricing_version,max_cost_microusd,
    max_tokens,max_time_seconds,max_planner_calls,max_builder_calls,max_reviewer_calls,automatic_repair_calls,quote_json,created_at,expires_at
    FROM hardening_quotes;
  DROP TABLE hardening_quotes;
  ALTER TABLE hardening_quotes_v29 RENAME TO hardening_quotes;
  CREATE INDEX idx_hardening_quotes_checkpoint_created_v23 ON hardening_quotes(parent_checkpoint_id,created_at DESC);
  CREATE INDEX idx_hardening_quotes_user_expiry_v23 ON hardening_quotes(requester_user_id,expires_at);
  CREATE INDEX idx_hardening_quotes_sizing_v29 ON hardening_quotes(sizing_authority_id,sizing_authority_hash,id);
  CREATE TRIGGER require_quote_binding_v23 BEFORE INSERT ON hardening_quotes BEGIN
    SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM verified_candidate_checkpoints c JOIN engineer_runs r ON r.id=c.run_id WHERE c.id=NEW.parent_checkpoint_id AND c.checkpoint_hash=NEW.parent_checkpoint_hash AND c.run_id=NEW.parent_run_id AND c.requester_user_id=NEW.requester_user_id AND c.repository_id=NEW.repository_id AND r.state_version=NEW.parent_state_version) THEN RAISE(ABORT,'hardening quote checkpoint binding mismatch') END;
    SELECT CASE WHEN (SELECT COUNT(*) FROM hardening_quote_advisories m JOIN advisory_backlog_items a ON a.id=m.advisory_id WHERE m.quote_id=NEW.id AND a.parent_run_id=NEW.parent_run_id AND a.parent_checkpoint_id=NEW.parent_checkpoint_id AND a.parent_checkpoint_hash=NEW.parent_checkpoint_hash AND a.actionability='ACTIONABLE')!=NEW.advisory_count OR (SELECT COALESCE(MAX(ordinal),-1) FROM hardening_quote_advisories WHERE quote_id=NEW.id)!=NEW.advisory_count-1 OR json_array_length(json_extract(NEW.quote_json,'$.advisoryIds'))!=NEW.advisory_count OR json_extract(NEW.quote_json,'$.selectionHash')!=NEW.selection_hash OR EXISTS(SELECT 1 FROM json_each(NEW.quote_json,'$.advisoryIds') j LEFT JOIN hardening_quote_advisories m ON m.quote_id=NEW.id AND m.ordinal=CAST(j.key AS INTEGER) WHERE m.advisory_id IS NULL OR m.advisory_id!=j.value) THEN RAISE(ABORT,'hardening quote advisory mapping incomplete') END;
    SELECT CASE WHEN NEW.routing_policy_version!='engineer-model-routing-v2' OR NEW.pricing_version!='openai-gpt56-pricing-2026-07-14' THEN RAISE(ABORT,'hardening quote frozen version mismatch') END;
    SELECT CASE WHEN ABS((julianday(NEW.expires_at)-julianday(NEW.created_at))*86400000-900000)>1 THEN RAISE(ABORT,'hardening quote expiry invalid') END;
  END;
  CREATE TRIGGER require_hardening_quote_version_projection_v29 BEFORE INSERT ON hardening_quotes BEGIN
    SELECT CASE WHEN NEW.schema_version=2 AND NOT EXISTS(SELECT 1 FROM hardening_quote_sizing_authorities s WHERE s.id=NEW.sizing_authority_id
      AND s.sizing_authority_hash=NEW.sizing_authority_hash AND s.parent_run_id=NEW.parent_run_id AND s.requester_user_id=NEW.requester_user_id
      AND s.repository_id=NEW.repository_id AND s.parent_checkpoint_id=NEW.parent_checkpoint_id AND s.parent_checkpoint_hash=NEW.parent_checkpoint_hash
      AND s.selection_hash=NEW.selection_hash AND s.local_input_counter_version=NEW.local_input_counter_version
      AND s.builder_prompt_version=NEW.builder_prompt_version AND s.reviewer_policy_version=NEW.reviewer_policy_version
      AND s.cache_policy_version=NEW.cache_policy_version AND s.cache_accounting_version=NEW.cache_accounting_version
      AND s.cache_write_input_multiplier_numerator=NEW.cache_write_input_multiplier_numerator
      AND s.cache_write_input_multiplier_denominator=NEW.cache_write_input_multiplier_denominator
      AND s.builder_input_token_cap=NEW.builder_input_token_cap AND s.builder_output_token_cap=NEW.builder_output_token_cap
      AND s.reviewer_input_token_cap=NEW.reviewer_input_token_cap AND s.reviewer_output_token_cap=NEW.reviewer_output_token_cap)
      THEN RAISE(ABORT,'hardening quote sizing authority mismatch') END;
    SELECT CASE WHEN json_extract(NEW.quote_json,'$.schemaVersion')!=NEW.schema_version OR json_extract(NEW.quote_json,'$.quoteId')!=NEW.id
      OR json_extract(NEW.quote_json,'$.quoteHash')!=NEW.quote_hash OR json_extract(NEW.quote_json,'$.policyVersion')!=NEW.policy_version
      OR json_extract(NEW.quote_json,'$.estimatorVersion')!=NEW.estimator_version OR json_extract(NEW.quote_json,'$.parentRunId')!=NEW.parent_run_id
      OR json_extract(NEW.quote_json,'$.requesterUserId')!=NEW.requester_user_id OR json_extract(NEW.quote_json,'$.repositoryId')!=NEW.repository_id
      OR json_extract(NEW.quote_json,'$.parentCheckpointId')!=NEW.parent_checkpoint_id OR json_extract(NEW.quote_json,'$.parentCheckpointHash')!=NEW.parent_checkpoint_hash
      OR json_extract(NEW.quote_json,'$.parentStateVersion')!=NEW.parent_state_version OR json_extract(NEW.quote_json,'$.selectionHash')!=NEW.selection_hash
      OR json_array_length(json_extract(NEW.quote_json,'$.advisoryIds'))!=NEW.advisory_count
      OR json_extract(NEW.quote_json,'$.routingPolicyVersion')!=NEW.routing_policy_version OR json_extract(NEW.quote_json,'$.pricingVersion')!=NEW.pricing_version
      OR json_extract(NEW.quote_json,'$.estimate.maxCostMicrousd')!=NEW.max_cost_microusd OR json_extract(NEW.quote_json,'$.estimate.maxTokens')!=NEW.max_tokens
      OR json_extract(NEW.quote_json,'$.estimate.maxTimeSeconds')!=NEW.max_time_seconds OR json_extract(NEW.quote_json,'$.estimate.maxPlannerCalls')!=NEW.max_planner_calls
      OR json_extract(NEW.quote_json,'$.estimate.maxBuilderCalls')!=NEW.max_builder_calls OR json_extract(NEW.quote_json,'$.estimate.maxReviewerCalls')!=NEW.max_reviewer_calls
      OR json_extract(NEW.quote_json,'$.estimate.automaticRepairCalls')!=NEW.automatic_repair_calls
      OR (NEW.schema_version=2 AND (json_extract(NEW.quote_json,'$.sizingAuthorityId')!=NEW.sizing_authority_id
      OR json_extract(NEW.quote_json,'$.sizingAuthorityHash')!=NEW.sizing_authority_hash
      OR json_extract(NEW.quote_json,'$.localInputCounterVersion')!=NEW.local_input_counter_version
      OR json_extract(NEW.quote_json,'$.builderPromptVersion')!=NEW.builder_prompt_version OR json_extract(NEW.quote_json,'$.reviewerPolicyVersion')!=NEW.reviewer_policy_version
      OR json_extract(NEW.quote_json,'$.cachePolicyVersion')!=NEW.cache_policy_version OR json_extract(NEW.quote_json,'$.cacheAccountingVersion')!=NEW.cache_accounting_version
      OR json_extract(NEW.quote_json,'$.cacheWriteInputMultiplier.numerator')!=NEW.cache_write_input_multiplier_numerator
      OR json_extract(NEW.quote_json,'$.cacheWriteInputMultiplier.denominator')!=NEW.cache_write_input_multiplier_denominator
      OR json_extract(NEW.quote_json,'$.inputCaps.builderInputTokens')!=NEW.builder_input_token_cap
      OR json_extract(NEW.quote_json,'$.inputCaps.builderOutputTokens')!=NEW.builder_output_token_cap
      OR json_extract(NEW.quote_json,'$.inputCaps.reviewerInputTokens')!=NEW.reviewer_input_token_cap
      OR json_extract(NEW.quote_json,'$.inputCaps.reviewerOutputTokens')!=NEW.reviewer_output_token_cap))
      THEN RAISE(ABORT,'hardening quote version JSON projection mismatch') END;
  END;
  CREATE TRIGGER prevent_hardening_quotes_update_v23 BEFORE UPDATE ON hardening_quotes BEGIN SELECT RAISE(ABORT,'hardening quotes are immutable'); END;
  CREATE TRIGGER prevent_hardening_quotes_delete_v23 BEFORE DELETE ON hardening_quotes BEGIN SELECT RAISE(ABORT,'hardening quotes are immutable'); END;

  CREATE UNIQUE INDEX uq_hardening_quote_pair_v29 ON hardening_quotes(id,quote_hash);
  CREATE UNIQUE INDEX uq_hardening_consent_pair_v29 ON hardening_consents(id,consent_hash);
  CREATE UNIQUE INDEX uq_hardening_model_call_slot_binding_v29 ON hardening_model_call_slots(id,child_run_id,role);

  CREATE TABLE hardening_child_budget_authorities (
    id TEXT PRIMARY KEY NOT NULL CHECK(length(id)=71 AND substr(id,1,7)='sha256:' AND substr(id,8) NOT GLOB '*[^0-9a-f]*'),
    authority_hash TEXT NOT NULL UNIQUE CHECK(length(authority_hash)=71 AND substr(authority_hash,1,7)='sha256:' AND substr(authority_hash,8) NOT GLOB '*[^0-9a-f]*'),
    schema_version INTEGER NOT NULL CHECK(schema_version=1),
    policy_version TEXT NOT NULL CHECK(policy_version='engineer-hardening-child-budget-v1'),
    child_run_id TEXT NOT NULL UNIQUE REFERENCES engineer_runs(id) ON DELETE RESTRICT,
    lineage_id TEXT NOT NULL,
    lineage_hash TEXT NOT NULL,
    quote_id TEXT NOT NULL,
    quote_hash TEXT NOT NULL,
    consent_id TEXT NOT NULL,
    consent_hash TEXT NOT NULL,
    cost_limit_microusd INTEGER NOT NULL CHECK(cost_limit_microusd>0),
    token_limit INTEGER NOT NULL CHECK(token_limit>0),
    active_time_limit_ms INTEGER NOT NULL CHECK(active_time_limit_ms BETWEEN 1000 AND 86400000),
    max_builder_calls INTEGER NOT NULL DEFAULT 1 CHECK(max_builder_calls=1),
    max_reviewer_calls INTEGER NOT NULL DEFAULT 1 CHECK(max_reviewer_calls=1),
    max_tool_calls INTEGER NOT NULL DEFAULT 8 CHECK(max_tool_calls=8),
    max_mutations INTEGER NOT NULL DEFAULT 8 CHECK(max_mutations=8),
    max_command_calls INTEGER NOT NULL DEFAULT 8 CHECK(max_command_calls=8),
    max_tool_argument_bytes INTEGER NOT NULL DEFAULT 131072 CHECK(max_tool_argument_bytes=131072),
    max_file_bytes INTEGER NOT NULL DEFAULT 1048576 CHECK(max_file_bytes=1048576),
    max_tool_result_bytes INTEGER NOT NULL DEFAULT 32768 CHECK(max_tool_result_bytes=32768),
    max_search_bytes INTEGER NOT NULL DEFAULT 8388608 CHECK(max_search_bytes=8388608),
    max_search_results INTEGER NOT NULL DEFAULT 100 CHECK(max_search_results=100),
    max_range_lines INTEGER NOT NULL DEFAULT 400 CHECK(max_range_lines=400),
    builder_input_token_cap INTEGER NOT NULL CHECK(builder_input_token_cap BETWEEN 1 AND 40000),
    builder_output_ceiling INTEGER NOT NULL DEFAULT 6000 CHECK(builder_output_ceiling=6000),
    reviewer_input_token_cap INTEGER NOT NULL CHECK(reviewer_input_token_cap=40000),
    reviewer_output_ceiling INTEGER NOT NULL DEFAULT 12000 CHECK(reviewer_output_ceiling=12000),
    model_timeout_ms INTEGER NOT NULL DEFAULT 120000 CHECK(model_timeout_ms=120000),
    automatic_repair_calls INTEGER NOT NULL DEFAULT 0 CHECK(automatic_repair_calls=0),
    used_cost_microusd INTEGER NOT NULL DEFAULT 0 CHECK(used_cost_microusd>=0),
    used_tokens INTEGER NOT NULL DEFAULT 0 CHECK(used_tokens>=0),
    reserved_cost_microusd INTEGER NOT NULL DEFAULT 0 CHECK(reserved_cost_microusd>=0),
    reserved_tokens INTEGER NOT NULL DEFAULT 0 CHECK(reserved_tokens>=0),
    ambiguous_cost_microusd INTEGER NOT NULL DEFAULT 0 CHECK(ambiguous_cost_microusd>=0),
    ambiguous_tokens INTEGER NOT NULL DEFAULT 0 CHECK(ambiguous_tokens>=0),
    used_active_ms INTEGER NOT NULL DEFAULT 0 CHECK(used_active_ms>=0),
    active_since_ms INTEGER CHECK(active_since_ms IS NULL OR active_since_ms>=0),
    fence_owner_id TEXT,
    fence_token_hash TEXT CHECK(fence_token_hash IS NULL OR (length(fence_token_hash)=71 AND substr(fence_token_hash,1,7)='sha256:' AND substr(fence_token_hash,8) NOT GLOB '*[^0-9a-f]*')),
    fence_generation INTEGER NOT NULL DEFAULT 0 CHECK(fence_generation>=0),
    fence_expires_at_ms INTEGER CHECK(fence_expires_at_ms IS NULL OR fence_expires_at_ms>=0),
    status TEXT NOT NULL CHECK(status IN ('ACTIVE','STOPPED','VERIFIED')),
    stop_reason TEXT CHECK(stop_reason IN ('COST_CAP_REACHED','TOKEN_CAP_REACHED','BUILDER_INPUT_CAP_REACHED','REVIEWER_INPUT_CAP_REACHED','ACTIVE_TIME_CAP_REACHED','BUILDER_CALL_CAP_REACHED','REVIEWER_CALL_CAP_REACHED','MODEL_USAGE_AMBIGUOUS','MODEL_USAGE_BOUND_VIOLATION','MODEL_DISPATCH_NOT_STARTED','TOOL_CALL_CAP_REACHED','MUTATION_CAP_REACHED','COMMAND_CALL_CAP_REACHED','COMMAND_TIME_CAP_REACHED','NO_PROGRESS','CANCELLED','SECURITY_BLOCKED','ENVIRONMENT_BLOCKED','LEGACY_BUDGET_AUTHORITY_MISSING','FAILED')),
    revision INTEGER NOT NULL CHECK(revision>0),
    created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
    updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms>=created_at_ms),
    UNIQUE(id,authority_hash),
    FOREIGN KEY(lineage_id,lineage_hash) REFERENCES engineer_run_lineage(id,lineage_hash) ON DELETE RESTRICT,
    FOREIGN KEY(quote_id,quote_hash) REFERENCES hardening_quotes(id,quote_hash) ON DELETE RESTRICT,
    FOREIGN KEY(consent_id,consent_hash) REFERENCES hardening_consents(id,consent_hash) ON DELETE RESTRICT,
    CHECK((fence_owner_id IS NULL AND fence_token_hash IS NULL AND fence_expires_at_ms IS NULL) OR (fence_owner_id IS NOT NULL AND fence_token_hash IS NOT NULL AND fence_expires_at_ms IS NOT NULL AND fence_generation>0)),
    CHECK((status='ACTIVE' AND stop_reason IS NULL AND active_since_ms IS NOT NULL) OR (status='STOPPED' AND stop_reason IS NOT NULL AND active_since_ms IS NULL) OR (status='VERIFIED' AND stop_reason IS NULL AND active_since_ms IS NULL))
  );
  CREATE UNIQUE INDEX uq_hardening_child_budget_authority_pair_v29 ON hardening_child_budget_authorities(id,authority_hash);
  CREATE INDEX idx_hardening_child_budget_status_deadline_v29 ON hardening_child_budget_authorities(status,active_since_ms,child_run_id);
  CREATE INDEX idx_hardening_child_budget_fence_expiry_v29 ON hardening_child_budget_authorities(status,fence_expires_at_ms,child_run_id);
  CREATE TRIGGER require_hardening_child_budget_authority_v29 BEFORE INSERT ON hardening_child_budget_authorities BEGIN
    SELECT CASE WHEN NOT EXISTS(
      SELECT 1 FROM engineer_run_lineage l
      JOIN hardening_quotes q ON q.id=l.quote_id AND q.quote_hash=l.quote_hash
      JOIN hardening_consents c ON c.id=l.consent_id AND c.consent_hash=l.consent_hash
      JOIN engineer_runs r ON r.id=l.child_run_id AND r.user_id=l.requester_user_id
      JOIN hardening_start_claims s ON s.child_run_id=l.child_run_id AND s.status='FINALIZED'
      JOIN run_budgets b ON b.run_id=l.child_run_id
      WHERE l.id=NEW.lineage_id AND l.lineage_hash=NEW.lineage_hash AND l.child_run_id=NEW.child_run_id
        AND l.relation='OPTIONAL_HARDENING' AND l.quote_id=NEW.quote_id AND l.quote_hash=NEW.quote_hash
        AND l.consent_id=NEW.consent_id AND l.consent_hash=NEW.consent_hash
        AND c.cost_microusd=NEW.cost_limit_microusd AND c.tokens=NEW.token_limit
        AND c.time_seconds*1000=NEW.active_time_limit_ms
        AND q.schema_version=2 AND NEW.cost_limit_microusd<=q.max_cost_microusd AND NEW.token_limit<=q.max_tokens
        AND NEW.builder_input_token_cap=q.builder_input_token_cap AND NEW.builder_output_ceiling=q.builder_output_token_cap
        AND NEW.reviewer_input_token_cap=q.reviewer_input_token_cap AND NEW.reviewer_output_ceiling=q.reviewer_output_token_cap
        AND NEW.active_time_limit_ms<=q.max_time_seconds*1000
        AND b.cost_limit_usd=CAST(NEW.cost_limit_microusd AS REAL)/1000000
        AND b.token_limit=NEW.token_limit AND b.time_limit_seconds=c.time_seconds
        AND b.lifetime_cost_limit_usd=b.cost_limit_usd AND b.lifetime_token_limit=b.token_limit
        AND b.lifetime_time_limit_seconds=b.time_limit_seconds AND b.used_cost_usd=0 AND b.used_tokens=0
        AND b.used_time_seconds=0 AND b.reserved_cost_usd=0 AND b.reserved_tokens=0
        AND b.ambiguous_cost_usd=0 AND b.ambiguous_tokens=0
    ) THEN RAISE(ABORT,'hardening child budget authority binding mismatch') END;
  END;
  CREATE TRIGGER fence_hardening_child_budget_authority_update_v29 BEFORE UPDATE ON hardening_child_budget_authorities BEGIN
    SELECT CASE WHEN OLD.id IS NOT NEW.id OR OLD.authority_hash IS NOT NEW.authority_hash OR OLD.schema_version IS NOT NEW.schema_version OR OLD.policy_version IS NOT NEW.policy_version OR OLD.child_run_id IS NOT NEW.child_run_id OR OLD.lineage_id IS NOT NEW.lineage_id OR OLD.lineage_hash IS NOT NEW.lineage_hash OR OLD.quote_id IS NOT NEW.quote_id OR OLD.quote_hash IS NOT NEW.quote_hash OR OLD.consent_id IS NOT NEW.consent_id OR OLD.consent_hash IS NOT NEW.consent_hash OR OLD.cost_limit_microusd IS NOT NEW.cost_limit_microusd OR OLD.token_limit IS NOT NEW.token_limit OR OLD.active_time_limit_ms IS NOT NEW.active_time_limit_ms OR OLD.max_builder_calls IS NOT NEW.max_builder_calls OR OLD.max_reviewer_calls IS NOT NEW.max_reviewer_calls OR OLD.max_tool_calls IS NOT NEW.max_tool_calls OR OLD.max_mutations IS NOT NEW.max_mutations OR OLD.max_command_calls IS NOT NEW.max_command_calls OR OLD.max_tool_argument_bytes IS NOT NEW.max_tool_argument_bytes OR OLD.max_file_bytes IS NOT NEW.max_file_bytes OR OLD.max_tool_result_bytes IS NOT NEW.max_tool_result_bytes OR OLD.max_search_bytes IS NOT NEW.max_search_bytes OR OLD.max_search_results IS NOT NEW.max_search_results OR OLD.max_range_lines IS NOT NEW.max_range_lines OR OLD.builder_input_token_cap IS NOT NEW.builder_input_token_cap OR OLD.builder_output_ceiling IS NOT NEW.builder_output_ceiling OR OLD.reviewer_input_token_cap IS NOT NEW.reviewer_input_token_cap OR OLD.reviewer_output_ceiling IS NOT NEW.reviewer_output_ceiling OR OLD.model_timeout_ms IS NOT NEW.model_timeout_ms OR OLD.automatic_repair_calls IS NOT NEW.automatic_repair_calls OR OLD.created_at_ms IS NOT NEW.created_at_ms THEN RAISE(ABORT,'hardening child budget immutable authority mismatch') END;
    SELECT CASE WHEN NEW.revision!=OLD.revision+1 OR NEW.used_cost_microusd<OLD.used_cost_microusd OR NEW.used_tokens<OLD.used_tokens OR NEW.ambiguous_cost_microusd<OLD.ambiguous_cost_microusd OR NEW.ambiguous_tokens<OLD.ambiguous_tokens OR NEW.used_active_ms<OLD.used_active_ms OR NEW.updated_at_ms<OLD.updated_at_ms THEN RAISE(ABORT,'hardening child budget monotonic accounting mismatch') END;
    SELECT CASE WHEN OLD.status!='ACTIVE' AND NOT (OLD.status='STOPPED' AND NEW.status='STOPPED'
      AND OLD.stop_reason IS NEW.stop_reason AND OLD.active_since_ms IS NEW.active_since_ms
      AND OLD.fence_owner_id IS NEW.fence_owner_id AND OLD.fence_token_hash IS NEW.fence_token_hash
      AND OLD.fence_generation IS NEW.fence_generation AND OLD.fence_expires_at_ms IS NEW.fence_expires_at_ms)
      THEN RAISE(ABORT,'terminal hardening child budget is immutable') END;
    SELECT CASE WHEN OLD.status='STOPPED' AND NOT EXISTS(
      SELECT 1 FROM hardening_child_model_reservations r WHERE r.child_run_id=OLD.child_run_id AND r.settled_at_ms=NEW.updated_at_ms
        AND OLD.reserved_cost_microusd-NEW.reserved_cost_microusd=r.reserved_cost_microusd
        AND OLD.reserved_tokens-NEW.reserved_tokens=r.reserved_tokens
        AND ((r.status='VOID_UNSENT' AND NEW.used_cost_microusd=OLD.used_cost_microusd AND NEW.used_tokens=OLD.used_tokens
          AND NEW.ambiguous_cost_microusd=OLD.ambiguous_cost_microusd AND NEW.ambiguous_tokens=OLD.ambiguous_tokens) OR
        (r.status='AMBIGUOUS' AND NEW.used_cost_microusd=OLD.used_cost_microusd AND NEW.used_tokens=OLD.used_tokens
          AND NEW.ambiguous_cost_microusd-OLD.ambiguous_cost_microusd=r.reserved_cost_microusd
          AND NEW.ambiguous_tokens-OLD.ambiguous_tokens=r.reserved_tokens) OR
        (r.status='SETTLED' AND NEW.ambiguous_cost_microusd=OLD.ambiguous_cost_microusd AND NEW.ambiguous_tokens=OLD.ambiguous_tokens
          AND NEW.used_cost_microusd-OLD.used_cost_microusd=r.settled_cost_microusd
          AND NEW.used_tokens-OLD.used_tokens=r.actual_input_tokens+r.actual_output_tokens)))
      THEN RAISE(ABORT,'stopped hardening child reconciliation mismatch') END;
    SELECT CASE WHEN NEW.status NOT IN ('ACTIVE','STOPPED','VERIFIED') THEN RAISE(ABORT,'hardening child budget status transition mismatch') END;
    SELECT CASE WHEN NEW.fence_generation<OLD.fence_generation OR NEW.fence_generation>OLD.fence_generation+1 THEN RAISE(ABORT,'hardening child budget fence generation mismatch') END;
    SELECT CASE WHEN NEW.fence_generation=OLD.fence_generation AND (OLD.fence_owner_id IS NOT NEW.fence_owner_id OR OLD.fence_token_hash IS NOT NEW.fence_token_hash) AND NOT (NEW.fence_owner_id IS NULL AND NEW.fence_token_hash IS NULL AND NEW.fence_expires_at_ms IS NULL) THEN RAISE(ABORT,'hardening child budget fence owner mismatch') END;
  END;
  CREATE TRIGGER prevent_hardening_child_budget_authority_delete_v29 BEFORE DELETE ON hardening_child_budget_authorities BEGIN SELECT RAISE(ABORT,'hardening child budget authority is durable'); END;

  CREATE TABLE hardening_child_model_reservations (
    id TEXT PRIMARY KEY NOT NULL CHECK(length(id)=71 AND substr(id,1,7)='sha256:' AND substr(id,8) NOT GLOB '*[^0-9a-f]*'),
    reservation_hash TEXT NOT NULL UNIQUE CHECK(length(reservation_hash)=71 AND substr(reservation_hash,1,7)='sha256:' AND substr(reservation_hash,8) NOT GLOB '*[^0-9a-f]*'),
    schema_version INTEGER NOT NULL CHECK(schema_version=1),
    policy_version TEXT NOT NULL CHECK(policy_version='engineer-hardening-child-model-reservation-v1'),
    authority_id TEXT NOT NULL,
    authority_hash TEXT NOT NULL,
    child_run_id TEXT NOT NULL REFERENCES engineer_runs(id) ON DELETE RESTRICT,
    role TEXT NOT NULL CHECK(role IN ('BUILDER','REVIEWER')),
    model_tier TEXT NOT NULL CHECK((role='BUILDER' AND model_tier='GPT-5.6_TERRA') OR (role='REVIEWER' AND model_tier='GPT-5.6_SOL')),
    resolved_model TEXT NOT NULL,
    routing_decision_id TEXT NOT NULL REFERENCES model_routing_decisions(id) ON DELETE RESTRICT,
    agent_execution_id TEXT NOT NULL REFERENCES agent_executions(id) ON DELETE RESTRICT,
    expected_run_state TEXT NOT NULL CHECK(expected_run_state IN ('IMPLEMENTING','REVIEWING')),
    expected_state_version INTEGER NOT NULL CHECK(expected_state_version>=0),
    paid_slot_id TEXT NOT NULL,
    input_token_upper_bound INTEGER NOT NULL CHECK(input_token_upper_bound>=0),
    output_token_ceiling INTEGER NOT NULL CHECK(output_token_ceiling>0),
    cache_policy_version TEXT NOT NULL CHECK(cache_policy_version='engineer-hardening-prompt-cache-v1'),
    cache_accounting_version TEXT NOT NULL CHECK(cache_accounting_version='openai-prompt-cache-accounting-v1'),
    static_prefix_hash TEXT NOT NULL CHECK(length(static_prefix_hash)=71 AND substr(static_prefix_hash,1,7)='sha256:' AND substr(static_prefix_hash,8) NOT GLOB '*[^0-9a-f]*'),
    tool_schema_hash TEXT NOT NULL CHECK(length(tool_schema_hash)=71 AND substr(tool_schema_hash,1,7)='sha256:' AND substr(tool_schema_hash,8) NOT GLOB '*[^0-9a-f]*'),
    prompt_cache_key_hash TEXT NOT NULL CHECK(length(prompt_cache_key_hash)=71 AND substr(prompt_cache_key_hash,1,7)='sha256:' AND substr(prompt_cache_key_hash,8) NOT GLOB '*[^0-9a-f]*'),
    cache_shard INTEGER NOT NULL CHECK(cache_shard BETWEEN 0 AND 3),
    cache_ttl_seconds INTEGER NOT NULL CHECK(cache_ttl_seconds=1800),
    cache_breakpoint_count INTEGER NOT NULL CHECK(cache_breakpoint_count=1),
    reserved_cache_write_input_tokens INTEGER NOT NULL CHECK(reserved_cache_write_input_tokens=input_token_upper_bound),
    reserved_cached_input_tokens INTEGER NOT NULL CHECK(reserved_cached_input_tokens=0),
    uncached_input_microusd_per_million INTEGER NOT NULL CHECK(uncached_input_microusd_per_million>0),
    cached_input_microusd_per_million INTEGER NOT NULL CHECK(cached_input_microusd_per_million>0),
    cache_write_input_microusd_per_million INTEGER NOT NULL CHECK(cache_write_input_microusd_per_million>0),
    output_microusd_per_million INTEGER NOT NULL CHECK(output_microusd_per_million>0),
    reserved_tokens INTEGER NOT NULL CHECK(reserved_tokens=input_token_upper_bound+output_token_ceiling),
    reserved_cost_microusd INTEGER NOT NULL CHECK(reserved_cost_microusd>=0),
    pricing_version TEXT NOT NULL,
    currency TEXT NOT NULL CHECK(currency='USD'),
    reservation_idempotency_key TEXT NOT NULL,
    request_hash TEXT NOT NULL CHECK(length(request_hash)=71 AND substr(request_hash,1,7)='sha256:' AND substr(request_hash,8) NOT GLOB '*[^0-9a-f]*'),
    client_request_id TEXT NOT NULL CHECK(length(client_request_id)=36 AND lower(client_request_id)=client_request_id
      AND client_request_id GLOB '????????-????-4???-[89ab]???-????????????'
      AND replace(client_request_id,'-','') NOT GLOB '*[^0-9a-f]*'),
    fence_owner_id TEXT NOT NULL,
    fence_token_hash TEXT NOT NULL,
    fence_generation INTEGER NOT NULL CHECK(fence_generation>0),
    recovery_owner_id TEXT,
    recovery_token_hash TEXT CHECK(recovery_token_hash IS NULL OR (length(recovery_token_hash)=71 AND substr(recovery_token_hash,1,7)='sha256:' AND substr(recovery_token_hash,8) NOT GLOB '*[^0-9a-f]*')),
    recovery_generation INTEGER NOT NULL DEFAULT 0 CHECK(recovery_generation>=0),
    recovery_idempotency_key TEXT,
    recovery_claimed_at_ms INTEGER CHECK(recovery_claimed_at_ms IS NULL OR recovery_claimed_at_ms>=0),
    recovery_expires_at_ms INTEGER CHECK(recovery_expires_at_ms IS NULL OR recovery_expires_at_ms>=0),
    status TEXT NOT NULL CHECK(status IN ('RESERVED','SETTLED','AMBIGUOUS','VOID_UNSENT')),
    dispatch_status TEXT NOT NULL CHECK(dispatch_status IN ('RESERVED_UNSENT','DISPATCHING','RESPONSE_RECORDED','SETTLED','AMBIGUOUS','VOID_UNSENT')),
    dispatch_started_at_ms INTEGER CHECK(dispatch_started_at_ms IS NULL OR dispatch_started_at_ms>=0),
    response_recorded_at_ms INTEGER CHECK(response_recorded_at_ms IS NULL OR response_recorded_at_ms>=0),
    model_call_id TEXT REFERENCES model_calls(id) ON DELETE RESTRICT,
    provider_response_id TEXT,
    provider_response_artifact_id TEXT REFERENCES artifacts(id) ON DELETE RESTRICT,
    actual_input_tokens INTEGER CHECK(actual_input_tokens IS NULL OR actual_input_tokens>=0),
    actual_uncached_input_tokens INTEGER CHECK(actual_uncached_input_tokens IS NULL OR actual_uncached_input_tokens>=0),
    actual_output_tokens INTEGER CHECK(actual_output_tokens IS NULL OR actual_output_tokens>=0),
    actual_cached_input_tokens INTEGER CHECK(actual_cached_input_tokens IS NULL OR actual_cached_input_tokens>=0),
    actual_cache_write_input_tokens INTEGER CHECK(actual_cache_write_input_tokens IS NULL OR actual_cache_write_input_tokens>=0),
    cache_observation TEXT CHECK(cache_observation IN ('MISS','HIT','WRITE','MIXED','UNKNOWN')),
    settled_cost_microusd INTEGER CHECK(settled_cost_microusd IS NULL OR settled_cost_microusd>=0),
    settlement_idempotency_key TEXT,
    settlement_input_hash TEXT CHECK(settlement_input_hash IS NULL OR (length(settlement_input_hash)=71 AND substr(settlement_input_hash,1,7)='sha256:' AND substr(settlement_input_hash,8) NOT GLOB '*[^0-9a-f]*')),
    reconciliation_id TEXT CHECK(reconciliation_id IS NULL OR (length(reconciliation_id)=71 AND substr(reconciliation_id,1,7)='sha256:' AND substr(reconciliation_id,8) NOT GLOB '*[^0-9a-f]*')),
    reconciliation_hash TEXT CHECK(reconciliation_hash IS NULL OR (length(reconciliation_hash)=71 AND substr(reconciliation_hash,1,7)='sha256:' AND substr(reconciliation_hash,8) NOT GLOB '*[^0-9a-f]*')),
    reconciliation_json TEXT,
    settled_at_ms INTEGER CHECK(settled_at_ms IS NULL OR settled_at_ms>=0),
    created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
    UNIQUE(child_run_id,role),
    UNIQUE(child_run_id,reservation_idempotency_key),
    UNIQUE(reconciliation_id),
    UNIQUE(id,reconciliation_id,reconciliation_hash),
    FOREIGN KEY(authority_id,authority_hash) REFERENCES hardening_child_budget_authorities(id,authority_hash) ON DELETE RESTRICT,
    FOREIGN KEY(paid_slot_id,child_run_id,role) REFERENCES hardening_model_call_slots(id,child_run_id,role) ON DELETE RESTRICT,
    CHECK((recovery_generation=0 AND recovery_owner_id IS NULL AND recovery_token_hash IS NULL AND recovery_idempotency_key IS NULL AND recovery_claimed_at_ms IS NULL AND recovery_expires_at_ms IS NULL) OR
      (recovery_generation>0 AND recovery_owner_id IS NOT NULL AND recovery_token_hash IS NOT NULL AND recovery_idempotency_key IS NOT NULL
        AND recovery_claimed_at_ms IS NOT NULL AND recovery_expires_at_ms IS NOT NULL AND recovery_expires_at_ms>recovery_claimed_at_ms)),
    CHECK((status='RESERVED' AND dispatch_status='RESERVED_UNSENT' AND dispatch_started_at_ms IS NULL AND response_recorded_at_ms IS NULL AND model_call_id IS NULL AND provider_response_id IS NULL AND provider_response_artifact_id IS NULL AND actual_input_tokens IS NULL AND actual_uncached_input_tokens IS NULL AND actual_output_tokens IS NULL AND actual_cached_input_tokens IS NULL AND actual_cache_write_input_tokens IS NULL AND cache_observation IS NULL AND settled_cost_microusd IS NULL AND settlement_idempotency_key IS NULL AND settlement_input_hash IS NULL AND reconciliation_id IS NULL AND reconciliation_hash IS NULL AND reconciliation_json IS NULL AND settled_at_ms IS NULL)
      OR (status='RESERVED' AND dispatch_status='DISPATCHING' AND dispatch_started_at_ms IS NOT NULL AND response_recorded_at_ms IS NULL AND model_call_id IS NULL AND provider_response_id IS NULL AND provider_response_artifact_id IS NULL AND actual_input_tokens IS NULL AND actual_uncached_input_tokens IS NULL AND actual_output_tokens IS NULL AND actual_cached_input_tokens IS NULL AND actual_cache_write_input_tokens IS NULL AND cache_observation IS NULL AND settled_cost_microusd IS NULL AND settlement_idempotency_key IS NULL AND settlement_input_hash IS NULL AND reconciliation_id IS NULL AND reconciliation_hash IS NULL AND reconciliation_json IS NULL AND settled_at_ms IS NULL)
      OR (status='RESERVED' AND dispatch_status='RESPONSE_RECORDED' AND dispatch_started_at_ms IS NOT NULL AND response_recorded_at_ms IS NOT NULL AND model_call_id IS NOT NULL AND provider_response_id IS NOT NULL AND provider_response_artifact_id IS NOT NULL AND actual_input_tokens IS NULL AND actual_uncached_input_tokens IS NULL AND actual_output_tokens IS NULL AND actual_cached_input_tokens IS NULL AND actual_cache_write_input_tokens IS NULL AND cache_observation IS NULL AND settled_cost_microusd IS NULL AND settlement_idempotency_key IS NULL AND settlement_input_hash IS NULL AND reconciliation_id IS NULL AND reconciliation_hash IS NULL AND reconciliation_json IS NULL AND settled_at_ms IS NULL)
      OR (status='SETTLED' AND dispatch_status='SETTLED' AND dispatch_started_at_ms IS NOT NULL AND response_recorded_at_ms IS NOT NULL AND model_call_id IS NOT NULL AND provider_response_id IS NOT NULL AND provider_response_artifact_id IS NOT NULL AND actual_input_tokens IS NOT NULL AND actual_uncached_input_tokens IS NOT NULL AND actual_output_tokens IS NOT NULL AND actual_cached_input_tokens IS NOT NULL AND actual_cache_write_input_tokens IS NOT NULL AND cache_observation IN ('MISS','HIT','WRITE','MIXED') AND actual_uncached_input_tokens+actual_cached_input_tokens+actual_cache_write_input_tokens=actual_input_tokens AND ((cache_observation='MISS' AND actual_cached_input_tokens=0 AND actual_cache_write_input_tokens=0) OR (cache_observation='HIT' AND actual_cached_input_tokens>0 AND actual_cache_write_input_tokens=0) OR (cache_observation='WRITE' AND actual_cached_input_tokens=0 AND actual_cache_write_input_tokens>0) OR (cache_observation='MIXED' AND actual_cached_input_tokens>0 AND actual_cache_write_input_tokens>0)) AND settled_cost_microusd IS NOT NULL AND settlement_idempotency_key IS NOT NULL AND settlement_input_hash IS NOT NULL AND reconciliation_id IS NOT NULL AND reconciliation_hash IS NOT NULL AND reconciliation_json IS NOT NULL AND settled_at_ms IS NOT NULL)
      OR (status='AMBIGUOUS' AND dispatch_status='AMBIGUOUS' AND dispatch_started_at_ms IS NOT NULL AND
        ((response_recorded_at_ms IS NULL AND model_call_id IS NOT NULL AND provider_response_id IS NULL AND provider_response_artifact_id IS NULL) OR
         (response_recorded_at_ms IS NOT NULL AND response_recorded_at_ms>=dispatch_started_at_ms AND model_call_id IS NOT NULL AND provider_response_id IS NOT NULL AND provider_response_artifact_id IS NOT NULL))
        AND actual_input_tokens IS NULL AND actual_uncached_input_tokens IS NULL AND actual_output_tokens IS NULL AND actual_cached_input_tokens IS NULL AND actual_cache_write_input_tokens IS NULL AND cache_observation='UNKNOWN' AND settled_cost_microusd IS NULL AND settlement_idempotency_key IS NOT NULL AND settlement_input_hash IS NOT NULL AND reconciliation_id IS NOT NULL AND reconciliation_hash IS NOT NULL AND reconciliation_json IS NOT NULL AND settled_at_ms IS NOT NULL)
      OR (status='VOID_UNSENT' AND dispatch_status='VOID_UNSENT' AND dispatch_started_at_ms IS NULL AND response_recorded_at_ms IS NULL AND model_call_id IS NULL AND provider_response_id IS NULL AND provider_response_artifact_id IS NULL AND actual_input_tokens IS NULL AND actual_uncached_input_tokens IS NULL AND actual_output_tokens IS NULL AND actual_cached_input_tokens IS NULL AND actual_cache_write_input_tokens IS NULL AND cache_observation IS NULL AND settled_cost_microusd IS NULL AND settlement_idempotency_key IS NOT NULL AND settlement_input_hash IS NOT NULL AND reconciliation_id IS NOT NULL AND reconciliation_hash IS NOT NULL AND reconciliation_json IS NOT NULL AND settled_at_ms IS NOT NULL))
  );
  CREATE UNIQUE INDEX uq_hardening_child_model_call_v29 ON hardening_child_model_reservations(model_call_id) WHERE model_call_id IS NOT NULL;
  CREATE UNIQUE INDEX uq_hardening_child_model_settlement_v29 ON hardening_child_model_reservations(child_run_id,settlement_idempotency_key) WHERE settlement_idempotency_key IS NOT NULL;
  CREATE INDEX idx_hardening_child_model_reservation_status_v29 ON hardening_child_model_reservations(child_run_id,status,created_at_ms,id);
  CREATE TRIGGER require_hardening_child_model_reservation_binding_v29 BEFORE INSERT ON hardening_child_model_reservations BEGIN
    SELECT CASE WHEN NOT EXISTS(
      SELECT 1 FROM hardening_child_budget_authorities b
      JOIN hardening_model_call_slots s ON s.id=NEW.paid_slot_id AND s.child_run_id=NEW.child_run_id AND s.role=NEW.role
      JOIN agent_executions a ON a.id=NEW.agent_execution_id AND a.run_id=NEW.child_run_id AND a.role=NEW.role AND a.model_tier=NEW.model_tier
      JOIN model_routing_decisions r ON r.id=NEW.routing_decision_id AND r.run_id=NEW.child_run_id AND r.agent_execution_id=NEW.agent_execution_id AND r.logical_tier=NEW.model_tier AND r.resolved_model=NEW.resolved_model
      JOIN engineer_runs e ON e.id=NEW.child_run_id AND e.state=NEW.expected_run_state AND e.state_version=NEW.expected_state_version
      WHERE b.id=NEW.authority_id AND b.authority_hash=NEW.authority_hash AND b.child_run_id=NEW.child_run_id
        AND b.status='ACTIVE' AND s.status='CLAIMED' AND s.claimant_id=NEW.agent_execution_id
        AND NEW.expected_run_state=CASE NEW.role WHEN 'BUILDER' THEN 'IMPLEMENTING' ELSE 'REVIEWING' END
        AND NEW.fence_owner_id=b.fence_owner_id AND NEW.fence_token_hash=b.fence_token_hash AND NEW.fence_generation=b.fence_generation
        AND NEW.input_token_upper_bound<=CASE NEW.role WHEN 'BUILDER' THEN b.builder_input_token_cap ELSE b.reviewer_input_token_cap END
        AND NEW.output_token_ceiling=CASE NEW.role WHEN 'BUILDER' THEN b.builder_output_ceiling ELSE b.reviewer_output_ceiling END
        AND NEW.cache_policy_version='engineer-hardening-prompt-cache-v1'
        AND NEW.cache_accounting_version='openai-prompt-cache-accounting-v1'
        AND NEW.static_prefix_hash=CASE NEW.role WHEN 'BUILDER' THEN 'sha256:46103ef13dc30de366aa72958a2fc460d86a4da0fb1bda4f0b96a8b57cd2b392' ELSE 'sha256:a51545419c7e6c80cf19cee1f4116a9c33ffe39c8aafebede02aab85bc10004f' END
        AND NEW.tool_schema_hash=CASE NEW.role WHEN 'BUILDER' THEN 'sha256:be90c1de245b388734d99e8159e37bed3f17cf5806d603c473c7fb234dc62cf4' ELSE 'sha256:dcf5dda91b5352eb1dcd664cd1c19a44a9760f754f86b7f4ea96607d7814f719' END
        AND NEW.cache_shard=0
        AND NEW.reserved_cache_write_input_tokens=NEW.input_token_upper_bound AND NEW.reserved_cached_input_tokens=0
        AND NEW.uncached_input_microusd_per_million=CASE NEW.role WHEN 'BUILDER' THEN 2500000 ELSE 5000000 END
        AND NEW.cached_input_microusd_per_million=CASE NEW.role WHEN 'BUILDER' THEN 250000 ELSE 500000 END
        AND NEW.cache_write_input_microusd_per_million=CASE NEW.role WHEN 'BUILDER' THEN 3125000 ELSE 6250000 END
        AND NEW.output_microusd_per_million=CASE NEW.role WHEN 'BUILDER' THEN 15000000 ELSE 30000000 END
        AND NEW.reserved_cost_microusd=((NEW.reserved_cache_write_input_tokens*NEW.cache_write_input_microusd_per_million+999999)/1000000)
          +((NEW.output_token_ceiling*NEW.output_microusd_per_million+999999)/1000000)
    ) THEN RAISE(ABORT,'hardening child model reservation binding mismatch') END;
  END;
  CREATE TRIGGER fence_hardening_child_model_reservation_update_v29 BEFORE UPDATE ON hardening_child_model_reservations BEGIN
    SELECT CASE WHEN OLD.id IS NOT NEW.id OR OLD.reservation_hash IS NOT NEW.reservation_hash OR OLD.schema_version IS NOT NEW.schema_version OR OLD.policy_version IS NOT NEW.policy_version OR OLD.authority_id IS NOT NEW.authority_id OR OLD.authority_hash IS NOT NEW.authority_hash OR OLD.child_run_id IS NOT NEW.child_run_id OR OLD.role IS NOT NEW.role OR OLD.model_tier IS NOT NEW.model_tier OR OLD.resolved_model IS NOT NEW.resolved_model OR OLD.routing_decision_id IS NOT NEW.routing_decision_id OR OLD.agent_execution_id IS NOT NEW.agent_execution_id OR OLD.expected_run_state IS NOT NEW.expected_run_state OR OLD.expected_state_version IS NOT NEW.expected_state_version OR OLD.paid_slot_id IS NOT NEW.paid_slot_id OR OLD.input_token_upper_bound IS NOT NEW.input_token_upper_bound OR OLD.output_token_ceiling IS NOT NEW.output_token_ceiling OR OLD.cache_policy_version IS NOT NEW.cache_policy_version OR OLD.cache_accounting_version IS NOT NEW.cache_accounting_version OR OLD.static_prefix_hash IS NOT NEW.static_prefix_hash OR OLD.tool_schema_hash IS NOT NEW.tool_schema_hash OR OLD.prompt_cache_key_hash IS NOT NEW.prompt_cache_key_hash OR OLD.cache_shard IS NOT NEW.cache_shard OR OLD.cache_ttl_seconds IS NOT NEW.cache_ttl_seconds OR OLD.cache_breakpoint_count IS NOT NEW.cache_breakpoint_count OR OLD.reserved_cache_write_input_tokens IS NOT NEW.reserved_cache_write_input_tokens OR OLD.reserved_cached_input_tokens IS NOT NEW.reserved_cached_input_tokens OR OLD.uncached_input_microusd_per_million IS NOT NEW.uncached_input_microusd_per_million OR OLD.cached_input_microusd_per_million IS NOT NEW.cached_input_microusd_per_million OR OLD.cache_write_input_microusd_per_million IS NOT NEW.cache_write_input_microusd_per_million OR OLD.output_microusd_per_million IS NOT NEW.output_microusd_per_million OR OLD.reserved_tokens IS NOT NEW.reserved_tokens OR OLD.reserved_cost_microusd IS NOT NEW.reserved_cost_microusd OR OLD.pricing_version IS NOT NEW.pricing_version OR OLD.currency IS NOT NEW.currency OR OLD.reservation_idempotency_key IS NOT NEW.reservation_idempotency_key OR OLD.request_hash IS NOT NEW.request_hash OR OLD.client_request_id IS NOT NEW.client_request_id OR OLD.fence_owner_id IS NOT NEW.fence_owner_id OR OLD.fence_token_hash IS NOT NEW.fence_token_hash OR OLD.fence_generation IS NOT NEW.fence_generation OR OLD.created_at_ms IS NOT NEW.created_at_ms THEN RAISE(ABORT,'hardening child model reservation immutable liability mismatch') END;
    SELECT CASE WHEN NOT (
      OLD.status='RESERVED' AND (
        (OLD.dispatch_status=NEW.dispatch_status AND NEW.status='RESERVED' AND NEW.recovery_generation=OLD.recovery_generation+1) OR
        (OLD.dispatch_status='RESERVED_UNSENT' AND NEW.status='RESERVED' AND NEW.dispatch_status='DISPATCHING') OR
        (OLD.dispatch_status='DISPATCHING' AND NEW.status='RESERVED' AND NEW.dispatch_status='RESPONSE_RECORDED') OR
        (OLD.dispatch_status='RESERVED_UNSENT' AND NEW.status='VOID_UNSENT' AND NEW.dispatch_status='VOID_UNSENT') OR
        (OLD.dispatch_status='DISPATCHING' AND NEW.status='AMBIGUOUS' AND NEW.dispatch_status='AMBIGUOUS') OR
        (OLD.dispatch_status='RESPONSE_RECORDED' AND NEW.status='SETTLED' AND NEW.dispatch_status='SETTLED') OR
        (OLD.dispatch_status='RESPONSE_RECORDED' AND NEW.status='AMBIGUOUS' AND NEW.dispatch_status='AMBIGUOUS')))
      THEN RAISE(ABORT,'hardening child model reservation transition mismatch') END;
    SELECT CASE WHEN NEW.status='RESERVED' AND NEW.dispatch_status=OLD.dispatch_status AND
      (NEW.recovery_generation!=OLD.recovery_generation+1 OR NEW.recovery_claimed_at_ms<COALESCE(OLD.recovery_expires_at_ms,OLD.created_at_ms) OR
       NEW.recovery_owner_id IS NULL OR NEW.recovery_token_hash IS NULL OR NEW.recovery_idempotency_key IS NULL OR
       NEW.recovery_expires_at_ms<=NEW.recovery_claimed_at_ms)
      THEN RAISE(ABORT,'hardening recovery claim mismatch') END;
    SELECT CASE WHEN NEW.status='RESERVED' AND NEW.dispatch_status=OLD.dispatch_status AND (
      OLD.dispatch_started_at_ms IS NOT NEW.dispatch_started_at_ms OR OLD.response_recorded_at_ms IS NOT NEW.response_recorded_at_ms OR
      OLD.model_call_id IS NOT NEW.model_call_id OR OLD.provider_response_id IS NOT NEW.provider_response_id OR
      OLD.provider_response_artifact_id IS NOT NEW.provider_response_artifact_id OR OLD.actual_input_tokens IS NOT NEW.actual_input_tokens OR
      OLD.actual_uncached_input_tokens IS NOT NEW.actual_uncached_input_tokens OR OLD.actual_output_tokens IS NOT NEW.actual_output_tokens OR
      OLD.actual_cached_input_tokens IS NOT NEW.actual_cached_input_tokens OR OLD.actual_cache_write_input_tokens IS NOT NEW.actual_cache_write_input_tokens OR
      OLD.cache_observation IS NOT NEW.cache_observation OR OLD.settled_cost_microusd IS NOT NEW.settled_cost_microusd OR
      OLD.settlement_idempotency_key IS NOT NEW.settlement_idempotency_key OR OLD.settlement_input_hash IS NOT NEW.settlement_input_hash OR
      OLD.reconciliation_id IS NOT NEW.reconciliation_id OR OLD.reconciliation_hash IS NOT NEW.reconciliation_hash OR
      OLD.reconciliation_json IS NOT NEW.reconciliation_json OR OLD.settled_at_ms IS NOT NEW.settled_at_ms)
      THEN RAISE(ABORT,'hardening recovery claim changed dispatch evidence') END;
    SELECT CASE WHEN NEW.status!='RESERVED' AND (NEW.recovery_generation!=OLD.recovery_generation OR
      NEW.recovery_owner_id IS NOT OLD.recovery_owner_id OR NEW.recovery_token_hash IS NOT OLD.recovery_token_hash OR
      NEW.recovery_idempotency_key IS NOT OLD.recovery_idempotency_key OR NEW.recovery_claimed_at_ms IS NOT OLD.recovery_claimed_at_ms OR
      NEW.recovery_expires_at_ms IS NOT OLD.recovery_expires_at_ms)
      THEN RAISE(ABORT,'hardening recovery claim changed during finalization') END;
    SELECT CASE WHEN
      (OLD.dispatch_status='RESERVED_UNSENT' AND ((NEW.dispatch_status='DISPATCHING' AND
        (NEW.dispatch_started_at_ms IS NULL OR NEW.dispatch_started_at_ms<OLD.created_at_ms OR NEW.response_recorded_at_ms IS NOT NULL)) OR
        (NEW.dispatch_status='VOID_UNSENT' AND (NEW.dispatch_started_at_ms IS NOT NULL OR NEW.response_recorded_at_ms IS NOT NULL)))) OR
      (OLD.dispatch_status='DISPATCHING' AND (NEW.dispatch_started_at_ms IS NOT OLD.dispatch_started_at_ms OR
        (NEW.dispatch_status='RESPONSE_RECORDED' AND (NEW.response_recorded_at_ms IS NULL OR NEW.response_recorded_at_ms<OLD.dispatch_started_at_ms)) OR
        (NEW.dispatch_status='AMBIGUOUS' AND NEW.response_recorded_at_ms IS NOT NULL))) OR
      (OLD.dispatch_status='RESPONSE_RECORDED' AND (NEW.dispatch_started_at_ms IS NOT OLD.dispatch_started_at_ms OR
        NEW.response_recorded_at_ms IS NOT OLD.response_recorded_at_ms))
      THEN RAISE(ABORT,'hardening dispatch timestamp mismatch') END;
    SELECT CASE WHEN NEW.status='RESERVED' AND NEW.dispatch_status='RESPONSE_RECORDED' AND NOT EXISTS(
      SELECT 1 FROM model_calls m JOIN artifacts a ON a.id=NEW.provider_response_artifact_id
      WHERE m.id=NEW.model_call_id AND m.run_id=OLD.child_run_id AND m.agent_execution_id=OLD.agent_execution_id
        AND m.logical_tier=OLD.model_tier AND m.resolved_model=OLD.resolved_model AND m.cache_key=OLD.prompt_cache_key_hash
        AND m.budget_reservation_id=OLD.id AND m.status='SUCCEEDED' AND m.retry_count=0
        AND EXISTS(SELECT 1 FROM json_each(m.input_context_refs_json) WHERE value=OLD.request_hash)
        AND EXISTS(SELECT 1 FROM json_each(m.input_context_refs_json) WHERE value=OLD.client_request_id)
        AND EXISTS(SELECT 1 FROM json_each(m.input_context_refs_json) WHERE value=NEW.provider_response_id)
        AND a.run_id=OLD.child_run_id AND a.type='MODEL_PROVIDER_RESPONSE' AND a.trusted=1
        AND a.producer_type='SYSTEM' AND a.producer_id='engineer-provider-response-recorder')
      THEN RAISE(ABORT,'hardening response receipt projection mismatch') END;
    SELECT CASE WHEN NEW.status='SETTLED' AND (
      NEW.actual_input_tokens>OLD.input_token_upper_bound OR NEW.actual_output_tokens>OLD.output_token_ceiling OR
      NEW.actual_uncached_input_tokens+NEW.actual_cached_input_tokens+NEW.actual_cache_write_input_tokens!=NEW.actual_input_tokens OR
      NEW.settled_cost_microusd!=((NEW.actual_uncached_input_tokens*OLD.uncached_input_microusd_per_million+999999)/1000000)
        +((NEW.actual_cached_input_tokens*OLD.cached_input_microusd_per_million+999999)/1000000)
        +((NEW.actual_cache_write_input_tokens*OLD.cache_write_input_microusd_per_million+999999)/1000000)
        +((NEW.actual_output_tokens*OLD.output_microusd_per_million+999999)/1000000) OR
      NOT EXISTS(SELECT 1 FROM model_calls m JOIN hardening_model_call_slots s ON s.id=OLD.paid_slot_id
        JOIN artifacts a ON a.id=NEW.provider_response_artifact_id AND a.run_id=OLD.child_run_id AND a.type='MODEL_PROVIDER_RESPONSE'
          AND a.trusted=1 AND a.producer_type='SYSTEM' AND a.producer_id='engineer-provider-response-recorder'
        WHERE m.id=NEW.model_call_id AND m.run_id=OLD.child_run_id AND m.agent_execution_id=OLD.agent_execution_id
          AND m.logical_tier=OLD.model_tier AND m.resolved_model=OLD.resolved_model AND m.cache_key=OLD.prompt_cache_key_hash
          AND m.budget_reservation_id=OLD.id AND m.input_tokens=NEW.actual_input_tokens AND m.output_tokens=NEW.actual_output_tokens
          AND m.cached_input_tokens=NEW.actual_cached_input_tokens AND m.cache_write_input_tokens=NEW.actual_cache_write_input_tokens
          AND m.prompt_template_version=CASE OLD.role WHEN 'BUILDER' THEN 'engineer-codex-builder-v3' ELSE 'engineer-isolated-reviewer-v6' END
          AND m.output_schema_version IS CASE OLD.role WHEN 'BUILDER' THEN NULL ELSE 'reviewer-output-v1' END
          AND m.status='SUCCEEDED' AND m.retry_count=0 AND m.cache_hit=CASE WHEN NEW.actual_cached_input_tokens>0 THEN 1 ELSE 0 END
          AND s.status='COMPLETED' AND s.model_call_id=NEW.model_call_id)
    ) THEN RAISE(ABORT,'hardening settled usage projection mismatch') END;
    SELECT CASE WHEN NEW.status='AMBIGUOUS' AND NOT EXISTS(SELECT 1 FROM model_calls m JOIN hardening_model_call_slots s ON s.id=OLD.paid_slot_id
      WHERE m.id=NEW.model_call_id AND m.run_id=OLD.child_run_id AND m.agent_execution_id=OLD.agent_execution_id
        AND m.logical_tier=OLD.model_tier AND m.resolved_model=OLD.resolved_model AND m.cache_key=OLD.prompt_cache_key_hash
        AND m.budget_reservation_id=OLD.id
        AND m.prompt_template_version=CASE OLD.role WHEN 'BUILDER' THEN 'engineer-codex-builder-v3' ELSE 'engineer-isolated-reviewer-v6' END
        AND m.output_schema_version IS CASE OLD.role WHEN 'BUILDER' THEN NULL ELSE 'reviewer-output-v1' END
        AND m.retry_count=0 AND s.status='AMBIGUOUS' AND s.model_call_id=NEW.model_call_id
        AND ((OLD.dispatch_status='DISPATCHING' AND NEW.response_recorded_at_ms IS NULL AND m.status='FAILED' AND m.input_tokens IS NULL
          AND m.output_tokens IS NULL AND m.cached_input_tokens IS NULL AND m.cache_write_input_tokens IS NULL AND m.cache_hit IS NULL
          AND NEW.provider_response_id IS NULL AND NEW.provider_response_artifact_id IS NULL) OR
        (OLD.dispatch_status='RESPONSE_RECORDED' AND NEW.response_recorded_at_ms=OLD.response_recorded_at_ms
          AND NEW.provider_response_id=OLD.provider_response_id AND NEW.provider_response_artifact_id=OLD.provider_response_artifact_id
          AND ((m.status='SUCCEEDED' AND m.id=OLD.model_call_id) OR
            (NEW.recovery_generation>0 AND m.status='FAILED' AND m.input_tokens IS NULL AND m.output_tokens IS NULL
              AND m.cached_input_tokens IS NULL AND m.cache_write_input_tokens IS NULL AND m.cache_hit IS NULL
              AND EXISTS(SELECT 1 FROM json_each(m.input_context_refs_json) WHERE value=OLD.request_hash)
              AND EXISTS(SELECT 1 FROM json_each(m.input_context_refs_json) WHERE value=OLD.client_request_id))))))
      THEN RAISE(ABORT,'hardening ambiguous usage projection mismatch') END;
    SELECT CASE WHEN NEW.status='VOID_UNSENT' AND NOT EXISTS(SELECT 1 FROM hardening_model_call_slots s WHERE s.id=OLD.paid_slot_id
      AND s.status='FAILED' AND s.model_call_id IS NULL) THEN RAISE(ABORT,'hardening unsent slot projection mismatch') END;
    SELECT CASE WHEN NEW.status!='RESERVED' AND (json_valid(NEW.reconciliation_json) IS NOT 1 OR json_extract(NEW.reconciliation_json,'$.schemaVersion') IS NOT 1 OR
      json_extract(NEW.reconciliation_json,'$.policyVersion') IS NOT 'engineer-hardening-budget-reconciliation-v1' OR
      json_extract(NEW.reconciliation_json,'$.childRunId') IS NOT OLD.child_run_id OR json_extract(NEW.reconciliation_json,'$.reservationId') IS NOT OLD.id OR
      json_extract(NEW.reconciliation_json,'$.reservationHash') IS NOT OLD.reservation_hash OR json_extract(NEW.reconciliation_json,'$.status') IS NOT NEW.status OR
      json_extract(NEW.reconciliation_json,'$.reconciliationId') IS NOT NEW.reconciliation_id OR
      json_extract(NEW.reconciliation_json,'$.reconciliationHash') IS NOT NEW.reconciliation_hash OR
      json_type(NEW.reconciliation_json,'$.createdAt') IS NOT 'text'
      ) THEN RAISE(ABORT,'hardening reconciliation authority projection mismatch') END;
    SELECT CASE WHEN NEW.status='SETTLED' AND (json_extract(NEW.reconciliation_json,'$.providerResponseId') IS NOT NEW.provider_response_id OR
      json_extract(NEW.reconciliation_json,'$.modelCallId') IS NOT NEW.model_call_id OR json_extract(NEW.reconciliation_json,'$.actualInputTokens') IS NOT NEW.actual_input_tokens OR
      json_extract(NEW.reconciliation_json,'$.actualOutputTokens') IS NOT NEW.actual_output_tokens OR
      json_extract(NEW.reconciliation_json,'$.actualCachedInputTokens') IS NOT NEW.actual_cached_input_tokens OR
      json_extract(NEW.reconciliation_json,'$.actualCacheWriteInputTokens') IS NOT NEW.actual_cache_write_input_tokens OR
      json_extract(NEW.reconciliation_json,'$.cacheObservation') IS NOT NEW.cache_observation OR
      json_extract(NEW.reconciliation_json,'$.actualCostMicrousd') IS NOT NEW.settled_cost_microusd)
      THEN RAISE(ABORT,'hardening settled reconciliation projection mismatch') END;
    SELECT CASE WHEN NEW.status IN ('AMBIGUOUS','VOID_UNSENT') AND (json_type(NEW.reconciliation_json,'$.providerResponseId') IS NOT 'null' OR
      json_type(NEW.reconciliation_json,'$.actualInputTokens') IS NOT 'null' OR json_type(NEW.reconciliation_json,'$.actualOutputTokens') IS NOT 'null' OR
      json_type(NEW.reconciliation_json,'$.actualCachedInputTokens') IS NOT 'null' OR json_type(NEW.reconciliation_json,'$.actualCacheWriteInputTokens') IS NOT 'null' OR
      json_type(NEW.reconciliation_json,'$.actualCostMicrousd') IS NOT 'null' OR json_extract(NEW.reconciliation_json,'$.cacheObservation') IS NOT 'UNKNOWN' OR
      (NEW.status='AMBIGUOUS' AND json_extract(NEW.reconciliation_json,'$.modelCallId') IS NOT NEW.model_call_id) OR
      (NEW.status='VOID_UNSENT' AND json_type(NEW.reconciliation_json,'$.modelCallId') IS NOT 'null'))
      THEN RAISE(ABORT,'hardening unresolved reconciliation projection mismatch') END;
  END;
  CREATE TRIGGER prevent_hardening_child_model_reservation_delete_v29 BEFORE DELETE ON hardening_child_model_reservations BEGIN SELECT RAISE(ABORT,'hardening child model reservation is durable'); END;

  CREATE TABLE hardening_paid_call_finalizations (
    id TEXT PRIMARY KEY NOT NULL CHECK(length(id)=71 AND substr(id,1,7)='sha256:' AND substr(id,8) NOT GLOB '*[^0-9a-f]*'),
    reservation_id TEXT NOT NULL UNIQUE REFERENCES hardening_child_model_reservations(id) ON DELETE RESTRICT,
    reservation_hash TEXT NOT NULL,
    paid_slot_id TEXT NOT NULL,
    child_run_id TEXT NOT NULL REFERENCES engineer_runs(id) ON DELETE RESTRICT,
    role TEXT NOT NULL CHECK(role IN ('BUILDER','REVIEWER')),
    agent_execution_id TEXT NOT NULL REFERENCES agent_executions(id) ON DELETE RESTRICT,
    expected_run_state TEXT NOT NULL CHECK(expected_run_state IN ('IMPLEMENTING','REVIEWING')),
    expected_state_version INTEGER NOT NULL CHECK(expected_state_version>=0),
    terminal_intent_id TEXT NOT NULL UNIQUE CHECK(length(terminal_intent_id)=71 AND substr(terminal_intent_id,1,7)='sha256:' AND substr(terminal_intent_id,8) NOT GLOB '*[^0-9a-f]*'),
    outcome TEXT NOT NULL CHECK(outcome IN ('VOID_UNSENT','AMBIGUOUS','SETTLED','SETTLED_RECOVERED')),
    reconciliation_id TEXT NOT NULL,
    reconciliation_hash TEXT NOT NULL,
    payload_hash TEXT NOT NULL CHECK(length(payload_hash)=71 AND substr(payload_hash,1,7)='sha256:' AND substr(payload_hash,8) NOT GLOB '*[^0-9a-f]*'),
    payload_json TEXT NOT NULL CHECK(json_valid(payload_json)=1),
    status TEXT NOT NULL CHECK(status IN ('PENDING','CLAIMED','APPLIED')),
    claim_owner_id TEXT,
    claim_token_hash TEXT CHECK(claim_token_hash IS NULL OR (length(claim_token_hash)=71 AND substr(claim_token_hash,1,7)='sha256:' AND substr(claim_token_hash,8) NOT GLOB '*[^0-9a-f]*')),
    claim_generation INTEGER NOT NULL DEFAULT 0 CHECK(claim_generation>=0),
    claim_idempotency_key TEXT,
    claim_expires_at_ms INTEGER CHECK(claim_expires_at_ms IS NULL OR claim_expires_at_ms>=0),
    created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
    updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms>=created_at_ms),
    applied_at_ms INTEGER CHECK(applied_at_ms IS NULL OR applied_at_ms>=created_at_ms),
    CHECK((status='PENDING' AND claim_generation=0 AND claim_owner_id IS NULL AND claim_token_hash IS NULL AND claim_idempotency_key IS NULL AND claim_expires_at_ms IS NULL AND applied_at_ms IS NULL) OR
      (status='CLAIMED' AND claim_generation>0 AND claim_owner_id IS NOT NULL AND claim_token_hash IS NOT NULL AND claim_idempotency_key IS NOT NULL AND claim_expires_at_ms>updated_at_ms AND applied_at_ms IS NULL) OR
      (status='APPLIED' AND claim_generation>0 AND claim_owner_id IS NOT NULL AND claim_token_hash IS NOT NULL AND claim_idempotency_key IS NOT NULL AND claim_expires_at_ms IS NOT NULL AND applied_at_ms IS NOT NULL)),
    FOREIGN KEY(reservation_id,reconciliation_id,reconciliation_hash)
      REFERENCES hardening_child_model_reservations(id,reconciliation_id,reconciliation_hash) ON DELETE RESTRICT
  );
  CREATE INDEX idx_hardening_paid_call_finalization_status_v29 ON hardening_paid_call_finalizations(status,claim_expires_at_ms,created_at_ms,id);
  CREATE TRIGGER require_hardening_paid_call_finalization_binding_v29 BEFORE INSERT ON hardening_paid_call_finalizations BEGIN
    SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM hardening_child_model_reservations r WHERE r.id=NEW.reservation_id
      AND r.reservation_hash=NEW.reservation_hash AND r.paid_slot_id=NEW.paid_slot_id
      AND r.child_run_id=NEW.child_run_id AND r.role=NEW.role AND r.agent_execution_id=NEW.agent_execution_id
      AND NEW.expected_run_state=r.expected_run_state AND NEW.expected_state_version=r.expected_state_version
      AND r.reconciliation_id=NEW.reconciliation_id AND r.reconciliation_hash=NEW.reconciliation_hash
      AND r.status IN ('VOID_UNSENT','AMBIGUOUS','SETTLED') AND NEW.outcome=CASE r.status
        WHEN 'VOID_UNSENT' THEN 'VOID_UNSENT' WHEN 'AMBIGUOUS' THEN 'AMBIGUOUS'
        ELSE CASE WHEN r.recovery_generation=0 THEN 'SETTLED' ELSE 'SETTLED_RECOVERED' END END)
      THEN RAISE(ABORT,'hardening paid-call finalization binding mismatch') END;
    SELECT CASE WHEN NEW.payload_json IS NOT json_object('agentExecutionId',NEW.agent_execution_id,'childRunId',NEW.child_run_id,
      'createdAtMs',NEW.created_at_ms,'expectedRunState',NEW.expected_run_state,'expectedStateVersion',NEW.expected_state_version,
      'outcome',NEW.outcome,'paidCallSlotId',NEW.paid_slot_id,'policyVersion','engineer-hardening-paid-call-finalization-v1',
      'reconciliationHash',NEW.reconciliation_hash,'reconciliationId',NEW.reconciliation_id,'reservationHash',NEW.reservation_hash,
      'reservationId',NEW.reservation_id,'role',NEW.role,'schemaVersion',1,'terminalIntentId',NEW.terminal_intent_id)
      THEN RAISE(ABORT,'hardening paid-call finalization payload projection mismatch') END;
  END;
  CREATE TRIGGER fence_hardening_paid_call_finalization_update_v29 BEFORE UPDATE ON hardening_paid_call_finalizations BEGIN
    SELECT CASE WHEN OLD.id IS NOT NEW.id OR OLD.reservation_id IS NOT NEW.reservation_id OR OLD.reservation_hash IS NOT NEW.reservation_hash OR
      OLD.paid_slot_id IS NOT NEW.paid_slot_id OR OLD.terminal_intent_id IS NOT NEW.terminal_intent_id OR OLD.child_run_id IS NOT NEW.child_run_id OR
      OLD.role IS NOT NEW.role OR OLD.agent_execution_id IS NOT NEW.agent_execution_id OR OLD.expected_run_state IS NOT NEW.expected_run_state OR
      OLD.expected_state_version IS NOT NEW.expected_state_version OR
      OLD.outcome IS NOT NEW.outcome OR OLD.reconciliation_id IS NOT NEW.reconciliation_id OR OLD.reconciliation_hash IS NOT NEW.reconciliation_hash OR
      OLD.payload_hash IS NOT NEW.payload_hash OR OLD.payload_json IS NOT NEW.payload_json OR OLD.created_at_ms IS NOT NEW.created_at_ms
      THEN RAISE(ABORT,'hardening paid-call finalization immutable payload mismatch') END;
    SELECT CASE WHEN NOT ((OLD.status='PENDING' AND NEW.status='CLAIMED' AND NEW.claim_generation=1) OR
      (OLD.status='CLAIMED' AND NEW.status='CLAIMED' AND NEW.claim_generation=OLD.claim_generation+1 AND OLD.claim_expires_at_ms<=NEW.updated_at_ms) OR
      (OLD.status='CLAIMED' AND NEW.status='APPLIED' AND NEW.claim_generation=OLD.claim_generation AND
        NEW.claim_owner_id=OLD.claim_owner_id AND NEW.claim_token_hash=OLD.claim_token_hash AND NEW.claim_idempotency_key=OLD.claim_idempotency_key))
      THEN RAISE(ABORT,'hardening paid-call finalization transition mismatch') END;
  END;
  CREATE TRIGGER prevent_hardening_paid_call_finalization_delete_v29 BEFORE DELETE ON hardening_paid_call_finalizations BEGIN SELECT RAISE(ABORT,'hardening paid-call finalization is durable'); END;

  CREATE TABLE hardening_child_tool_actions (
    id TEXT PRIMARY KEY NOT NULL CHECK(length(id)=71 AND substr(id,1,7)='sha256:' AND substr(id,8) NOT GLOB '*[^0-9a-f]*'),
    schema_version INTEGER NOT NULL CHECK(schema_version=1),
    policy_version TEXT NOT NULL CHECK(policy_version='engineer-hardening-child-tool-action-v1'),
    authority_id TEXT NOT NULL,
    authority_hash TEXT NOT NULL,
    child_run_id TEXT NOT NULL REFERENCES engineer_runs(id) ON DELETE RESTRICT,
    paid_slot_id TEXT NOT NULL REFERENCES hardening_model_call_slots(id) ON DELETE RESTRICT,
    provider_response_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 7),
    tool_call_id TEXT NOT NULL,
    tool_name TEXT NOT NULL CHECK(tool_name IN ('list_files','search_files','read_file','read_file_range','write_file','run_command','git_diff')),
    arguments_hash TEXT NOT NULL CHECK(length(arguments_hash)=71 AND substr(arguments_hash,1,7)='sha256:' AND substr(arguments_hash,8) NOT GLOB '*[^0-9a-f]*'),
    argument_bytes INTEGER NOT NULL CHECK(argument_bytes>=0),
    effect TEXT NOT NULL CHECK(effect IN ('READ','WRITE','COMMAND')),
    fence_owner_id TEXT NOT NULL,
    fence_token_hash TEXT NOT NULL,
    fence_generation INTEGER NOT NULL CHECK(fence_generation>0),
    status TEXT NOT NULL CHECK(status IN ('AUTHORIZED','COMPLETED','FAILED')),
    command_execution_id TEXT REFERENCES command_executions(id) ON DELETE RESTRICT,
    created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
    finished_at_ms INTEGER CHECK(finished_at_ms IS NULL OR finished_at_ms>=created_at_ms),
    UNIQUE(child_run_id,provider_response_id,ordinal),
    UNIQUE(child_run_id,tool_call_id),
    FOREIGN KEY(authority_id,authority_hash) REFERENCES hardening_child_budget_authorities(id,authority_hash) ON DELETE RESTRICT,
    CHECK((status='AUTHORIZED' AND command_execution_id IS NULL AND finished_at_ms IS NULL) OR (status IN ('COMPLETED','FAILED') AND finished_at_ms IS NOT NULL))
  );
  CREATE INDEX idx_hardening_child_tool_actions_run_status_v29 ON hardening_child_tool_actions(child_run_id,status,ordinal);
  CREATE TRIGGER require_hardening_child_tool_action_binding_v29 BEFORE INSERT ON hardening_child_tool_actions BEGIN
    SELECT CASE WHEN NOT EXISTS(
      SELECT 1 FROM hardening_child_budget_authorities b
      JOIN hardening_child_model_reservations r ON r.authority_id=b.id AND r.authority_hash=b.authority_hash AND r.child_run_id=b.child_run_id AND r.role='BUILDER' AND r.status='SETTLED'
      WHERE b.id=NEW.authority_id AND b.authority_hash=NEW.authority_hash AND b.child_run_id=NEW.child_run_id AND b.status='ACTIVE'
        AND r.paid_slot_id=NEW.paid_slot_id AND NEW.fence_owner_id=b.fence_owner_id AND NEW.fence_token_hash=b.fence_token_hash AND NEW.fence_generation=b.fence_generation
    ) THEN RAISE(ABORT,'hardening child tool action authority mismatch') END;
    SELECT CASE WHEN (SELECT COUNT(*) FROM hardening_child_tool_actions WHERE child_run_id=NEW.child_run_id)>=8 THEN RAISE(ABORT,'hardening child tool call cap reached') END;
    SELECT CASE WHEN NEW.effect='WRITE' AND (SELECT COUNT(*) FROM hardening_child_tool_actions WHERE child_run_id=NEW.child_run_id AND effect='WRITE')>=8 THEN RAISE(ABORT,'hardening child mutation cap reached') END;
    SELECT CASE WHEN NEW.effect='COMMAND' AND (SELECT COUNT(*) FROM hardening_child_tool_actions WHERE child_run_id=NEW.child_run_id AND effect='COMMAND')>=8 THEN RAISE(ABORT,'hardening child command cap reached') END;
  END;
  CREATE TRIGGER fence_hardening_child_tool_action_update_v29 BEFORE UPDATE ON hardening_child_tool_actions BEGIN
    SELECT CASE WHEN OLD.id IS NOT NEW.id OR OLD.schema_version IS NOT NEW.schema_version OR OLD.policy_version IS NOT NEW.policy_version OR OLD.authority_id IS NOT NEW.authority_id OR OLD.authority_hash IS NOT NEW.authority_hash OR OLD.child_run_id IS NOT NEW.child_run_id OR OLD.paid_slot_id IS NOT NEW.paid_slot_id OR OLD.provider_response_id IS NOT NEW.provider_response_id OR OLD.ordinal IS NOT NEW.ordinal OR OLD.tool_call_id IS NOT NEW.tool_call_id OR OLD.tool_name IS NOT NEW.tool_name OR OLD.arguments_hash IS NOT NEW.arguments_hash OR OLD.argument_bytes IS NOT NEW.argument_bytes OR OLD.effect IS NOT NEW.effect OR OLD.fence_owner_id IS NOT NEW.fence_owner_id OR OLD.fence_token_hash IS NOT NEW.fence_token_hash OR OLD.fence_generation IS NOT NEW.fence_generation OR OLD.created_at_ms IS NOT NEW.created_at_ms THEN RAISE(ABORT,'hardening child tool action immutable authority mismatch') END;
    SELECT CASE WHEN OLD.status!='AUTHORIZED' OR NEW.status NOT IN ('COMPLETED','FAILED') THEN RAISE(ABORT,'hardening child tool action transition mismatch') END;
  END;
  CREATE TRIGGER prevent_hardening_child_tool_action_delete_v29 BEFORE DELETE ON hardening_child_tool_actions BEGIN SELECT RAISE(ABORT,'hardening child tool actions are durable'); END;

  CREATE TRIGGER prevent_hardening_child_budget_limit_update_v29 BEFORE UPDATE OF cost_limit_usd,token_limit,time_limit_seconds,lifetime_cost_limit_usd,lifetime_token_limit,lifetime_time_limit_seconds ON run_budgets WHEN EXISTS(SELECT 1 FROM engineer_run_lineage l WHERE l.child_run_id=OLD.run_id AND l.relation='OPTIONAL_HARDENING') BEGIN
    SELECT CASE WHEN NEW.cost_limit_usd IS NOT OLD.cost_limit_usd OR NEW.token_limit IS NOT OLD.token_limit OR NEW.time_limit_seconds IS NOT OLD.time_limit_seconds OR NEW.lifetime_cost_limit_usd IS NOT OLD.lifetime_cost_limit_usd OR NEW.lifetime_token_limit IS NOT OLD.lifetime_token_limit OR NEW.lifetime_time_limit_seconds IS NOT OLD.lifetime_time_limit_seconds THEN RAISE(ABORT,'hardening child budget requires a new quote consent and child') END;
  END;
  CREATE TRIGGER prevent_hardening_child_budget_topup_event_v29 BEFORE INSERT ON budget_events WHEN NEW.event_type IN ('BUDGET_TOPPED_UP','BUDGET_RESUMED') AND EXISTS(SELECT 1 FROM engineer_run_lineage l WHERE l.child_run_id=NEW.run_id AND l.relation='OPTIONAL_HARDENING') BEGIN SELECT RAISE(ABORT,'hardening child budget cannot be topped up or resumed'); END;
`;

/**
 * Forward-install the paid-call terminal-intent consumer for databases that
 * already recorded the unreleased v29 budget migration before the consumer
 * tables/triggers were frozen. Existing rows and tables are never rewritten;
 * the exact v29 authority is installed when absent and its mutable claim
 * triggers are refreshed deterministically.
 */
export const ENGINEER_DATABASE_MIGRATION_30_SQL = `
  DROP TRIGGER IF EXISTS prevent_hardening_paid_call_finalization_delete_v29;
  DROP TRIGGER IF EXISTS fence_hardening_paid_call_finalization_update_v29;
  DROP TRIGGER IF EXISTS require_hardening_paid_call_finalization_binding_v29;
  DROP INDEX IF EXISTS idx_hardening_paid_call_finalization_status_v29;
  CREATE TABLE IF NOT EXISTS hardening_paid_call_finalizations (
    id TEXT PRIMARY KEY NOT NULL CHECK(length(id)=71 AND substr(id,1,7)='sha256:' AND substr(id,8) NOT GLOB '*[^0-9a-f]*'),
    reservation_id TEXT NOT NULL UNIQUE REFERENCES hardening_child_model_reservations(id) ON DELETE RESTRICT,
    reservation_hash TEXT NOT NULL,
    paid_slot_id TEXT NOT NULL,
    child_run_id TEXT NOT NULL REFERENCES engineer_runs(id) ON DELETE RESTRICT,
    role TEXT NOT NULL CHECK(role IN ('BUILDER','REVIEWER')),
    agent_execution_id TEXT NOT NULL REFERENCES agent_executions(id) ON DELETE RESTRICT,
    expected_run_state TEXT NOT NULL CHECK(expected_run_state IN ('IMPLEMENTING','REVIEWING')),
    expected_state_version INTEGER NOT NULL CHECK(expected_state_version>=0),
    terminal_intent_id TEXT NOT NULL UNIQUE CHECK(length(terminal_intent_id)=71 AND substr(terminal_intent_id,1,7)='sha256:' AND substr(terminal_intent_id,8) NOT GLOB '*[^0-9a-f]*'),
    outcome TEXT NOT NULL CHECK(outcome IN ('VOID_UNSENT','AMBIGUOUS','SETTLED','SETTLED_RECOVERED')),
    reconciliation_id TEXT NOT NULL,
    reconciliation_hash TEXT NOT NULL,
    payload_hash TEXT NOT NULL CHECK(length(payload_hash)=71 AND substr(payload_hash,1,7)='sha256:' AND substr(payload_hash,8) NOT GLOB '*[^0-9a-f]*'),
    payload_json TEXT NOT NULL CHECK(json_valid(payload_json)=1),
    status TEXT NOT NULL CHECK(status IN ('PENDING','CLAIMED','APPLIED')),
    claim_owner_id TEXT,
    claim_token_hash TEXT CHECK(claim_token_hash IS NULL OR (length(claim_token_hash)=71 AND substr(claim_token_hash,1,7)='sha256:' AND substr(claim_token_hash,8) NOT GLOB '*[^0-9a-f]*')),
    claim_generation INTEGER NOT NULL DEFAULT 0 CHECK(claim_generation>=0),
    claim_idempotency_key TEXT,
    claim_expires_at_ms INTEGER CHECK(claim_expires_at_ms IS NULL OR claim_expires_at_ms>=0),
    created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
    updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms>=created_at_ms),
    applied_at_ms INTEGER CHECK(applied_at_ms IS NULL OR applied_at_ms>=created_at_ms),
    CHECK((status='PENDING' AND claim_generation=0 AND claim_owner_id IS NULL AND claim_token_hash IS NULL AND claim_idempotency_key IS NULL AND claim_expires_at_ms IS NULL AND applied_at_ms IS NULL) OR
      (status='CLAIMED' AND claim_generation>0 AND claim_owner_id IS NOT NULL AND claim_token_hash IS NOT NULL AND claim_idempotency_key IS NOT NULL AND claim_expires_at_ms>updated_at_ms AND applied_at_ms IS NULL) OR
      (status='APPLIED' AND claim_generation>0 AND claim_owner_id IS NOT NULL AND claim_token_hash IS NOT NULL AND claim_idempotency_key IS NOT NULL AND claim_expires_at_ms IS NOT NULL AND applied_at_ms IS NOT NULL)),
    FOREIGN KEY(reservation_id,reconciliation_id,reconciliation_hash)
      REFERENCES hardening_child_model_reservations(id,reconciliation_id,reconciliation_hash) ON DELETE RESTRICT
  );
  CREATE INDEX idx_hardening_paid_call_finalization_status_v29 ON hardening_paid_call_finalizations(status,claim_expires_at_ms,created_at_ms,id);
  CREATE TRIGGER require_hardening_paid_call_finalization_binding_v29 BEFORE INSERT ON hardening_paid_call_finalizations BEGIN
    SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM hardening_child_model_reservations r WHERE r.id=NEW.reservation_id
      AND r.reservation_hash=NEW.reservation_hash AND r.paid_slot_id=NEW.paid_slot_id
      AND r.child_run_id=NEW.child_run_id AND r.role=NEW.role AND r.agent_execution_id=NEW.agent_execution_id
      AND NEW.expected_run_state=r.expected_run_state AND NEW.expected_state_version=r.expected_state_version
      AND r.reconciliation_id=NEW.reconciliation_id AND r.reconciliation_hash=NEW.reconciliation_hash
      AND r.status IN ('VOID_UNSENT','AMBIGUOUS','SETTLED') AND NEW.outcome=CASE r.status
        WHEN 'VOID_UNSENT' THEN 'VOID_UNSENT' WHEN 'AMBIGUOUS' THEN 'AMBIGUOUS'
        ELSE CASE WHEN r.recovery_generation=0 THEN 'SETTLED' ELSE 'SETTLED_RECOVERED' END END)
      THEN RAISE(ABORT,'hardening paid-call finalization binding mismatch') END;
    SELECT CASE WHEN NEW.payload_json IS NOT json_object('agentExecutionId',NEW.agent_execution_id,'childRunId',NEW.child_run_id,
      'createdAtMs',NEW.created_at_ms,'expectedRunState',NEW.expected_run_state,'expectedStateVersion',NEW.expected_state_version,
      'outcome',NEW.outcome,'paidCallSlotId',NEW.paid_slot_id,'policyVersion','engineer-hardening-paid-call-finalization-v1',
      'reconciliationHash',NEW.reconciliation_hash,'reconciliationId',NEW.reconciliation_id,'reservationHash',NEW.reservation_hash,
      'reservationId',NEW.reservation_id,'role',NEW.role,'schemaVersion',1,'terminalIntentId',NEW.terminal_intent_id)
      THEN RAISE(ABORT,'hardening paid-call finalization payload projection mismatch') END;
  END;
  CREATE TRIGGER fence_hardening_paid_call_finalization_update_v29 BEFORE UPDATE ON hardening_paid_call_finalizations BEGIN
    SELECT CASE WHEN OLD.id IS NOT NEW.id OR OLD.reservation_id IS NOT NEW.reservation_id OR OLD.reservation_hash IS NOT NEW.reservation_hash OR
      OLD.paid_slot_id IS NOT NEW.paid_slot_id OR OLD.terminal_intent_id IS NOT NEW.terminal_intent_id OR OLD.child_run_id IS NOT NEW.child_run_id OR
      OLD.role IS NOT NEW.role OR OLD.agent_execution_id IS NOT NEW.agent_execution_id OR OLD.expected_run_state IS NOT NEW.expected_run_state OR
      OLD.expected_state_version IS NOT NEW.expected_state_version OR
      OLD.outcome IS NOT NEW.outcome OR OLD.reconciliation_id IS NOT NEW.reconciliation_id OR OLD.reconciliation_hash IS NOT NEW.reconciliation_hash OR
      OLD.payload_hash IS NOT NEW.payload_hash OR OLD.payload_json IS NOT NEW.payload_json OR OLD.created_at_ms IS NOT NEW.created_at_ms
      THEN RAISE(ABORT,'hardening paid-call finalization immutable payload mismatch') END;
    SELECT CASE WHEN NOT ((OLD.status='PENDING' AND NEW.status='CLAIMED' AND NEW.claim_generation=1) OR
      (OLD.status='CLAIMED' AND NEW.status='CLAIMED' AND NEW.claim_generation=OLD.claim_generation+1 AND OLD.claim_expires_at_ms<=NEW.updated_at_ms) OR
      (OLD.status='CLAIMED' AND NEW.status='APPLIED' AND NEW.claim_generation=OLD.claim_generation AND
        NEW.claim_owner_id=OLD.claim_owner_id AND NEW.claim_token_hash=OLD.claim_token_hash AND NEW.claim_idempotency_key=OLD.claim_idempotency_key))
      THEN RAISE(ABORT,'hardening paid-call finalization transition mismatch') END;
  END;
  CREATE TRIGGER prevent_hardening_paid_call_finalization_delete_v29 BEFORE DELETE ON hardening_paid_call_finalizations BEGIN SELECT RAISE(ABORT,'hardening paid-call finalization is durable'); END;

  CREATE TABLE hardening_recovery_worker_fences (
    child_run_id TEXT PRIMARY KEY NOT NULL REFERENCES engineer_runs(id) ON DELETE RESTRICT,
    worker_lease_id TEXT NOT NULL CHECK(length(worker_lease_id) BETWEEN 1 AND 200),
    worker_owner_id TEXT NOT NULL CHECK(length(worker_owner_id) BETWEEN 1 AND 200),
    worker_fencing_token INTEGER NOT NULL CHECK(worker_fencing_token>0),
    worker_lease_token_hash TEXT NOT NULL CHECK(length(worker_lease_token_hash)=71 AND substr(worker_lease_token_hash,1,7)='sha256:' AND substr(worker_lease_token_hash,8) NOT GLOB '*[^0-9a-f]*'),
    claimed_at_ms INTEGER NOT NULL CHECK(claimed_at_ms>=0),
    updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms>=claimed_at_ms),
    UNIQUE(child_run_id,worker_fencing_token)
  );
  CREATE INDEX idx_hardening_recovery_worker_fence_generation_v30
    ON hardening_recovery_worker_fences(child_run_id,worker_fencing_token);
  CREATE TRIGGER require_hardening_recovery_worker_fence_child_v30 BEFORE INSERT ON hardening_recovery_worker_fences BEGIN
    SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM engineer_run_lineage l JOIN hardening_start_operations o
      ON o.lineage_id=l.id AND o.lineage_hash=l.lineage_hash WHERE l.child_run_id=NEW.child_run_id AND l.relation='OPTIONAL_HARDENING')
      THEN RAISE(ABORT,'hardening recovery worker fence child authority mismatch') END;
  END;
  CREATE TRIGGER fence_hardening_recovery_worker_fence_update_v30 BEFORE UPDATE ON hardening_recovery_worker_fences BEGIN
    SELECT CASE WHEN OLD.child_run_id IS NOT NEW.child_run_id OR NEW.worker_fencing_token<=OLD.worker_fencing_token OR
      NEW.updated_at_ms<OLD.updated_at_ms OR NEW.claimed_at_ms!=NEW.updated_at_ms
      THEN RAISE(ABORT,'hardening recovery worker fence generation mismatch') END;
  END;
  CREATE TRIGGER prevent_hardening_recovery_worker_fence_delete_v30 BEFORE DELETE ON hardening_recovery_worker_fences BEGIN
    SELECT RAISE(ABORT,'hardening recovery worker fences are durable');
  END;
`;

/**
 * P7 Developer Resolution Desk (Day 2C). Four additive authority tables plus
 * their indexes, immutability/projection triggers, and the ledger-wide source
 * freeze that opening a case installs. Every v14-v30 byte is preserved; the
 * migration only creates new objects.
 *
 * The freeze is not a fifth table: a `resolution_cases` row keyed to a source
 * run IS the freeze. The `freeze_source_*` triggers below reject every
 * competing mutation of that source run at the storage layer, so the freeze is
 * enforced inside the transaction of every path that writes a source-owned row
 * (transition, retry/resume/top-up, hardening, approval, publication/Git,
 * worker dispatch) regardless of which code path attempts it. Case decisions
 * operate on the new resolution tables and on the *replacement* run (a distinct
 * run id with no case), so they are never blocked.
 *
 * A case binds only its immutable authority in `case_json`/`case_hash`; the
 * mutable lifecycle (`state`, `case_version`) is fenced separately and every
 * transition appends an immutable `resolution_events` row, mirroring the
 * engineer_runs + run_state_events split.
 */
export const ENGINEER_DATABASE_MIGRATION_31_SQL = `
  PRAGMA defer_foreign_keys=ON;

  CREATE TABLE resolution_cases (
    id TEXT PRIMARY KEY NOT NULL CHECK(length(id)=71 AND substr(id,1,7)='sha256:' AND substr(id,8) NOT GLOB '*[^0-9a-f]*'),
    case_hash TEXT NOT NULL UNIQUE CHECK(length(case_hash)=71 AND substr(case_hash,1,7)='sha256:' AND substr(case_hash,8) NOT GLOB '*[^0-9a-f]*'),
    schema_version INTEGER NOT NULL CHECK(schema_version=1),
    policy_version TEXT NOT NULL CHECK(policy_version='engineer-resolution-case-v1'),
    source_run_id TEXT NOT NULL UNIQUE REFERENCES engineer_runs(id) ON DELETE RESTRICT,
    owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    repository_id TEXT NOT NULL REFERENCES repository_connections(id) ON DELETE RESTRICT,
    source_state TEXT NOT NULL,
    source_state_version INTEGER NOT NULL CHECK(source_state_version>=0),
    base_commit_sha TEXT NOT NULL,
    manifest_hash TEXT NOT NULL,
    required_lane_contract_hash TEXT NOT NULL,
    blockers_json TEXT NOT NULL CHECK(json_valid(blockers_json)=1 AND json_type(blockers_json)='array'),
    blocker_count INTEGER NOT NULL CHECK(blocker_count>=0 AND blocker_count=json_array_length(blockers_json)),
    correction_eligible INTEGER NOT NULL CHECK(correction_eligible IN (0,1)),
    reverify_eligible INTEGER NOT NULL CHECK(reverify_eligible IN (0,1)),
    reverify_reason TEXT NOT NULL,
    pre_verification_candidate_present INTEGER NOT NULL CHECK(pre_verification_candidate_present IN (0,1)),
    pre_verification_candidate_digest TEXT CHECK(pre_verification_candidate_digest IS NULL OR (length(pre_verification_candidate_digest)=71 AND substr(pre_verification_candidate_digest,1,7)='sha256:' AND substr(pre_verification_candidate_digest,8) NOT GLOB '*[^0-9a-f]*')),
    source_actual_microusd INTEGER NOT NULL CHECK(source_actual_microusd>=0),
    prior_replacement_actual_microusd INTEGER NOT NULL CHECK(prior_replacement_actual_microusd>=0),
    ambiguous_liability_microusd INTEGER NOT NULL CHECK(ambiguous_liability_microusd>=0),
    cumulative_ceiling_microusd INTEGER NOT NULL CHECK(cumulative_ceiling_microusd>=0),
    pricing_policy_digest TEXT NOT NULL CHECK(length(pricing_policy_digest)=71 AND substr(pricing_policy_digest,1,7)='sha256:' AND substr(pricing_policy_digest,8) NOT GLOB '*[^0-9a-f]*'),
    case_version INTEGER NOT NULL DEFAULT 0 CHECK(case_version>=0),
    state TEXT NOT NULL CHECK(state IN ('OPEN','DIRECTIVE_ISSUED','APPLYING','RESOLVED_CORRECTED','RESOLVED_REVERIFIED','REJECTED_CLOSED')),
    case_json TEXT NOT NULL CHECK(json_valid(case_json)=1),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    CHECK((pre_verification_candidate_present=1)=(pre_verification_candidate_digest IS NOT NULL)),
    FOREIGN KEY(source_run_id,manifest_hash) REFERENCES task_manifest_versions(run_id,manifest_hash) ON DELETE RESTRICT
  );
  CREATE UNIQUE INDEX uq_resolution_case_pair_v31 ON resolution_cases(id,case_hash);
  CREATE INDEX idx_resolution_cases_owner_created_v31 ON resolution_cases(owner_user_id,created_at DESC,id);
  CREATE INDEX idx_resolution_cases_source_run_v31 ON resolution_cases(source_run_id,case_version);
  CREATE TRIGGER require_resolution_case_projection_v31 BEFORE INSERT ON resolution_cases BEGIN
    SELECT CASE WHEN json_extract(NEW.case_json,'$.caseId')!=NEW.id OR
      json_extract(NEW.case_json,'$.caseHash')!=NEW.case_hash OR
      json_extract(NEW.case_json,'$.schemaVersion')!=NEW.schema_version OR
      json_extract(NEW.case_json,'$.policyVersion')!=NEW.policy_version OR
      json_extract(NEW.case_json,'$.sourceRunId')!=NEW.source_run_id OR
      json_extract(NEW.case_json,'$.ownerUserId')!=NEW.owner_user_id OR
      json_extract(NEW.case_json,'$.repositoryId')!=NEW.repository_id OR
      json_extract(NEW.case_json,'$.sourceState')!=NEW.source_state OR
      json_extract(NEW.case_json,'$.sourceStateVersion')!=NEW.source_state_version OR
      json_extract(NEW.case_json,'$.baseCommitSha')!=NEW.base_commit_sha OR
      json_extract(NEW.case_json,'$.manifestHash')!=NEW.manifest_hash OR
      json_extract(NEW.case_json,'$.requiredLaneContractHash')!=NEW.required_lane_contract_hash OR
      json(json_extract(NEW.case_json,'$.blockers'))!=json(NEW.blockers_json) OR
      json_extract(NEW.case_json,'$.blockerCount')!=NEW.blocker_count OR
      json_extract(NEW.case_json,'$.correctionEligible')!=NEW.correction_eligible OR
      json_extract(NEW.case_json,'$.reverifyEligible')!=NEW.reverify_eligible OR
      json_extract(NEW.case_json,'$.reverifyReason')!=NEW.reverify_reason OR
      json_extract(NEW.case_json,'$.preVerificationCandidatePresent')!=NEW.pre_verification_candidate_present OR
      json_extract(NEW.case_json,'$.preVerificationCandidateDigest') IS NOT NEW.pre_verification_candidate_digest OR
      json_extract(NEW.case_json,'$.spendingMicrousd.sourceActual')!=NEW.source_actual_microusd OR
      json_extract(NEW.case_json,'$.spendingMicrousd.priorReplacementActual')!=NEW.prior_replacement_actual_microusd OR
      json_extract(NEW.case_json,'$.spendingMicrousd.ambiguousLiability')!=NEW.ambiguous_liability_microusd OR
      json_extract(NEW.case_json,'$.spendingMicrousd.cumulativeCeiling')!=NEW.cumulative_ceiling_microusd OR
      json_extract(NEW.case_json,'$.pricingPolicyDigest')!=NEW.pricing_policy_digest OR
      json_extract(NEW.case_json,'$.createdAt')!=NEW.created_at OR
      json_extract(NEW.case_json,'$.expiresAt')!=NEW.expires_at
      THEN RAISE(ABORT,'resolution case JSON projection mismatch') END;
    SELECT CASE WHEN NEW.case_version!=0 OR NEW.state!='OPEN'
      THEN RAISE(ABORT,'resolution case must open at version 0') END;
  END;
  CREATE TRIGGER fence_resolution_case_update_v31 BEFORE UPDATE ON resolution_cases BEGIN
    SELECT CASE WHEN OLD.id IS NOT NEW.id OR OLD.case_hash IS NOT NEW.case_hash OR OLD.schema_version IS NOT NEW.schema_version OR
      OLD.policy_version IS NOT NEW.policy_version OR OLD.source_run_id IS NOT NEW.source_run_id OR OLD.owner_user_id IS NOT NEW.owner_user_id OR
      OLD.repository_id IS NOT NEW.repository_id OR OLD.source_state IS NOT NEW.source_state OR OLD.source_state_version IS NOT NEW.source_state_version OR
      OLD.base_commit_sha IS NOT NEW.base_commit_sha OR OLD.manifest_hash IS NOT NEW.manifest_hash OR OLD.required_lane_contract_hash IS NOT NEW.required_lane_contract_hash OR
      OLD.blockers_json IS NOT NEW.blockers_json OR OLD.blocker_count IS NOT NEW.blocker_count OR OLD.correction_eligible IS NOT NEW.correction_eligible OR
      OLD.reverify_eligible IS NOT NEW.reverify_eligible OR OLD.reverify_reason IS NOT NEW.reverify_reason OR
      OLD.pre_verification_candidate_present IS NOT NEW.pre_verification_candidate_present OR OLD.pre_verification_candidate_digest IS NOT NEW.pre_verification_candidate_digest OR
      OLD.source_actual_microusd IS NOT NEW.source_actual_microusd OR OLD.prior_replacement_actual_microusd IS NOT NEW.prior_replacement_actual_microusd OR
      OLD.ambiguous_liability_microusd IS NOT NEW.ambiguous_liability_microusd OR OLD.cumulative_ceiling_microusd IS NOT NEW.cumulative_ceiling_microusd OR
      OLD.pricing_policy_digest IS NOT NEW.pricing_policy_digest OR
      OLD.case_json IS NOT NEW.case_json OR OLD.created_at IS NOT NEW.created_at OR OLD.expires_at IS NOT NEW.expires_at
      THEN RAISE(ABORT,'resolution case authority is immutable') END;
    SELECT CASE WHEN NOT (NEW.case_version=OLD.case_version+1 AND (
      (OLD.state='OPEN' AND NEW.state='DIRECTIVE_ISSUED') OR
      (OLD.state='DIRECTIVE_ISSUED' AND NEW.state IN ('APPLYING','REJECTED_CLOSED')) OR
      (OLD.state='APPLYING' AND NEW.state IN ('RESOLVED_CORRECTED','RESOLVED_REVERIFIED'))))
      THEN RAISE(ABORT,'resolution case transition mismatch') END;
  END;
  CREATE TRIGGER prevent_resolution_case_delete_v31 BEFORE DELETE ON resolution_cases BEGIN SELECT RAISE(ABORT,'resolution cases are durable'); END;

  CREATE TABLE resolution_directives (
    id TEXT PRIMARY KEY NOT NULL CHECK(length(id)=71 AND substr(id,1,7)='sha256:' AND substr(id,8) NOT GLOB '*[^0-9a-f]*'),
    directive_hash TEXT NOT NULL UNIQUE CHECK(length(directive_hash)=71 AND substr(directive_hash,1,7)='sha256:' AND substr(directive_hash,8) NOT GLOB '*[^0-9a-f]*'),
    schema_version INTEGER NOT NULL CHECK(schema_version=1),
    policy_version TEXT NOT NULL CHECK(policy_version='engineer-resolution-directive-v1'),
    case_id TEXT NOT NULL REFERENCES resolution_cases(id) ON DELETE RESTRICT,
    case_hash TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('CREATE_CORRECTED_RUN','CREATE_REVERIFY_RUN','REJECT_AND_CLOSE')),
    expected_case_version INTEGER NOT NULL CHECK(expected_case_version>=0),
    expected_source_run_version INTEGER NOT NULL CHECK(expected_source_run_version>=0),
    selected_blockers_json TEXT NOT NULL CHECK(json_valid(selected_blockers_json)=1 AND json_type(selected_blockers_json)='array'),
    budget_max_cost_microusd INTEGER CHECK(budget_max_cost_microusd IS NULL OR budget_max_cost_microusd>=0),
    budget_max_tokens INTEGER CHECK(budget_max_tokens IS NULL OR budget_max_tokens>=0),
    budget_max_active_seconds INTEGER CHECK(budget_max_active_seconds IS NULL OR budget_max_active_seconds>0),
    budget_pricing_policy_digest TEXT CHECK(budget_pricing_policy_digest IS NULL OR (length(budget_pricing_policy_digest)=71 AND substr(budget_pricing_policy_digest,1,7)='sha256:' AND substr(budget_pricing_policy_digest,8) NOT GLOB '*[^0-9a-f]*')),
    signature_algorithm TEXT NOT NULL CHECK(signature_algorithm='HMAC-SHA256'),
    signature_key_id TEXT NOT NULL,
    signature TEXT NOT NULL CHECK(length(signature)=64 AND signature NOT GLOB '*[^0-9a-f]*'),
    directive_json TEXT NOT NULL CHECK(json_valid(directive_json)=1),
    idempotency_key TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL CHECK(length(request_fingerprint)=71 AND substr(request_fingerprint,1,7)='sha256:' AND substr(request_fingerprint,8) NOT GLOB '*[^0-9a-f]*'),
    response_json TEXT NOT NULL CHECK(json_valid(response_json)=1),
    ttl_seconds INTEGER NOT NULL CHECK(ttl_seconds=900),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    UNIQUE(case_id,idempotency_key),
    CHECK((type='CREATE_CORRECTED_RUN')=(budget_max_cost_microusd IS NOT NULL AND budget_max_tokens IS NOT NULL AND budget_max_active_seconds IS NOT NULL AND budget_pricing_policy_digest IS NOT NULL)),
    CHECK((type='CREATE_CORRECTED_RUN' AND json_array_length(selected_blockers_json)>0) OR (type!='CREATE_CORRECTED_RUN' AND json_array_length(selected_blockers_json)=0)),
    FOREIGN KEY(case_id,case_hash) REFERENCES resolution_cases(id,case_hash) ON DELETE RESTRICT
  );
  CREATE UNIQUE INDEX uq_resolution_directive_pair_v31 ON resolution_directives(id,directive_hash);
  CREATE UNIQUE INDEX uq_resolution_directive_case_open_v31 ON resolution_directives(case_id);
  CREATE INDEX idx_resolution_directives_case_created_v31 ON resolution_directives(case_id,created_at,id);
  CREATE TRIGGER require_resolution_directive_projection_v31 BEFORE INSERT ON resolution_directives BEGIN
    SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM resolution_cases c WHERE c.id=NEW.case_id AND c.case_hash=NEW.case_hash)
      THEN RAISE(ABORT,'resolution directive case binding mismatch') END;
    SELECT CASE WHEN json_extract(NEW.directive_json,'$.directiveId')!=NEW.id OR
      json_extract(NEW.directive_json,'$.directiveHash')!=NEW.directive_hash OR
      json_extract(NEW.directive_json,'$.schemaVersion')!=NEW.schema_version OR
      json_extract(NEW.directive_json,'$.policyVersion')!=NEW.policy_version OR
      json_extract(NEW.directive_json,'$.caseId')!=NEW.case_id OR
      json_extract(NEW.directive_json,'$.caseHash')!=NEW.case_hash OR
      json_extract(NEW.directive_json,'$.type')!=NEW.type OR
      json_extract(NEW.directive_json,'$.expectedCaseVersion')!=NEW.expected_case_version OR
      json_extract(NEW.directive_json,'$.expectedSourceRunVersion')!=NEW.expected_source_run_version OR
      json(json_extract(NEW.directive_json,'$.selectedBlockers'))!=json(NEW.selected_blockers_json) OR
      json_extract(NEW.directive_json,'$.budget.maxCostMicrousd') IS NOT NEW.budget_max_cost_microusd OR
      json_extract(NEW.directive_json,'$.budget.maxTokens') IS NOT NEW.budget_max_tokens OR
      json_extract(NEW.directive_json,'$.budget.maxActiveSeconds') IS NOT NEW.budget_max_active_seconds OR
      json_extract(NEW.directive_json,'$.budget.pricingPolicyDigest') IS NOT NEW.budget_pricing_policy_digest OR
      json_extract(NEW.directive_json,'$.ttlSeconds')!=NEW.ttl_seconds OR
      json_extract(NEW.directive_json,'$.createdAt')!=NEW.created_at OR
      json_extract(NEW.directive_json,'$.expiresAt')!=NEW.expires_at
      THEN RAISE(ABORT,'resolution directive JSON projection mismatch') END;
  END;
  CREATE TRIGGER prevent_resolution_directive_update_v31 BEFORE UPDATE ON resolution_directives BEGIN SELECT RAISE(ABORT,'resolution directives are immutable'); END;
  CREATE TRIGGER prevent_resolution_directive_delete_v31 BEFORE DELETE ON resolution_directives BEGIN SELECT RAISE(ABORT,'resolution directives are immutable'); END;

  CREATE TABLE resolution_events (
    id TEXT PRIMARY KEY NOT NULL CHECK(length(id)=71 AND substr(id,1,7)='sha256:' AND substr(id,8) NOT GLOB '*[^0-9a-f]*'),
    event_hash TEXT NOT NULL UNIQUE CHECK(length(event_hash)=71 AND substr(event_hash,1,7)='sha256:' AND substr(event_hash,8) NOT GLOB '*[^0-9a-f]*'),
    schema_version INTEGER NOT NULL CHECK(schema_version=1),
    policy_version TEXT NOT NULL CHECK(policy_version='engineer-resolution-event-v1'),
    case_id TEXT NOT NULL REFERENCES resolution_cases(id) ON DELETE RESTRICT,
    sequence INTEGER NOT NULL CHECK(sequence>0),
    previous_event_hash TEXT CHECK(previous_event_hash IS NULL OR (length(previous_event_hash)=71 AND substr(previous_event_hash,1,7)='sha256:' AND substr(previous_event_hash,8) NOT GLOB '*[^0-9a-f]*')),
    event_type TEXT NOT NULL CHECK(event_type IN ('CASE_OPENED','DIRECTIVE_ISSUED','REPLACEMENT_PREPARING','REPLACEMENT_READY','REPLACEMENT_FAILED','CASE_RESOLVED','CASE_REJECTED')),
    case_version INTEGER NOT NULL CHECK(case_version>=0),
    directive_id TEXT REFERENCES resolution_directives(id) ON DELETE RESTRICT,
    actor_type TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    payload_json TEXT NOT NULL CHECK(json_valid(payload_json)=1),
    created_at TEXT NOT NULL,
    UNIQUE(case_id,sequence),
    UNIQUE(case_id,case_version),
    CHECK((sequence=1)=(previous_event_hash IS NULL))
  );
  CREATE INDEX idx_resolution_events_case_sequence_v31 ON resolution_events(case_id,sequence);
  CREATE TRIGGER require_resolution_event_chain_v31 BEFORE INSERT ON resolution_events BEGIN
    SELECT CASE WHEN NEW.sequence=1 THEN NULL WHEN NOT EXISTS(SELECT 1 FROM resolution_events e
      WHERE e.case_id=NEW.case_id AND e.sequence=NEW.sequence-1 AND e.event_hash=NEW.previous_event_hash)
      THEN RAISE(ABORT,'resolution event chain mismatch') END;
    SELECT CASE WHEN json_extract(NEW.payload_json,'$.eventId')!=NEW.id OR
      json_extract(NEW.payload_json,'$.eventHash')!=NEW.event_hash OR
      json_extract(NEW.payload_json,'$.caseId')!=NEW.case_id OR
      json_extract(NEW.payload_json,'$.sequence')!=NEW.sequence OR
      json_extract(NEW.payload_json,'$.previousEventHash') IS NOT NEW.previous_event_hash OR
      json_extract(NEW.payload_json,'$.eventType')!=NEW.event_type OR
      json_extract(NEW.payload_json,'$.caseVersion')!=NEW.case_version
      THEN RAISE(ABORT,'resolution event projection mismatch') END;
  END;
  CREATE TRIGGER prevent_resolution_event_update_v31 BEFORE UPDATE ON resolution_events BEGIN SELECT RAISE(ABORT,'resolution events are immutable'); END;
  CREATE TRIGGER prevent_resolution_event_delete_v31 BEFORE DELETE ON resolution_events BEGIN SELECT RAISE(ABORT,'resolution events are immutable'); END;

  CREATE TABLE resolution_replacements (
    id TEXT PRIMARY KEY NOT NULL CHECK(length(id)=71 AND substr(id,1,7)='sha256:' AND substr(id,8) NOT GLOB '*[^0-9a-f]*'),
    replacement_hash TEXT NOT NULL UNIQUE CHECK(length(replacement_hash)=71 AND substr(replacement_hash,1,7)='sha256:' AND substr(replacement_hash,8) NOT GLOB '*[^0-9a-f]*'),
    schema_version INTEGER NOT NULL CHECK(schema_version=1),
    policy_version TEXT NOT NULL CHECK(policy_version='engineer-resolution-replacement-v1'),
    case_id TEXT NOT NULL UNIQUE REFERENCES resolution_cases(id) ON DELETE RESTRICT,
    directive_id TEXT NOT NULL UNIQUE REFERENCES resolution_directives(id) ON DELETE RESTRICT,
    directive_hash TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('CORRECTED','REVERIFY')),
    replacement_run_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('PREPARING','READY','FAILED')),
    budget_max_cost_microusd INTEGER NOT NULL CHECK(budget_max_cost_microusd>=0),
    budget_max_tokens INTEGER NOT NULL CHECK(budget_max_tokens>=0),
    budget_max_active_seconds INTEGER NOT NULL CHECK(budget_max_active_seconds>0),
    budget_pricing_policy_digest TEXT NOT NULL CHECK(length(budget_pricing_policy_digest)=71 AND substr(budget_pricing_policy_digest,1,7)='sha256:' AND substr(budget_pricing_policy_digest,8) NOT GLOB '*[^0-9a-f]*'),
    replacement_json TEXT NOT NULL CHECK(json_valid(replacement_json)=1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(replacement_run_id),
    FOREIGN KEY(directive_id,directive_hash) REFERENCES resolution_directives(id,directive_hash) ON DELETE RESTRICT
  );
  CREATE INDEX idx_resolution_replacements_state_v31 ON resolution_replacements(state,created_at,id);
  CREATE TRIGGER require_resolution_replacement_binding_v31 BEFORE INSERT ON resolution_replacements BEGIN
    SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM resolution_directives d WHERE d.id=NEW.directive_id AND d.directive_hash=NEW.directive_hash
      AND d.case_id=NEW.case_id AND NEW.kind=CASE d.type WHEN 'CREATE_CORRECTED_RUN' THEN 'CORRECTED' WHEN 'CREATE_REVERIFY_RUN' THEN 'REVERIFY' ELSE 'INVALID' END)
      THEN RAISE(ABORT,'resolution replacement directive binding mismatch') END;
    SELECT CASE WHEN NEW.state!='PREPARING' THEN RAISE(ABORT,'resolution replacement must scaffold in PREPARING') END;
    SELECT CASE WHEN json_extract(NEW.replacement_json,'$.replacementId')!=NEW.id OR
      json_extract(NEW.replacement_json,'$.caseId')!=NEW.case_id OR
      json_extract(NEW.replacement_json,'$.directiveId')!=NEW.directive_id OR
      json_extract(NEW.replacement_json,'$.kind')!=NEW.kind OR
      json_extract(NEW.replacement_json,'$.replacementRunId')!=NEW.replacement_run_id OR
      json_extract(NEW.replacement_json,'$.budget.maxCostMicrousd')!=NEW.budget_max_cost_microusd OR
      json_extract(NEW.replacement_json,'$.budget.maxTokens')!=NEW.budget_max_tokens OR
      json_extract(NEW.replacement_json,'$.budget.maxActiveSeconds')!=NEW.budget_max_active_seconds OR
      json_extract(NEW.replacement_json,'$.budget.pricingPolicyDigest')!=NEW.budget_pricing_policy_digest
      THEN RAISE(ABORT,'resolution replacement projection mismatch') END;
  END;
  CREATE TRIGGER fence_resolution_replacement_update_v31 BEFORE UPDATE ON resolution_replacements BEGIN
    SELECT CASE WHEN OLD.id IS NOT NEW.id OR OLD.replacement_hash IS NOT NEW.replacement_hash OR OLD.case_id IS NOT NEW.case_id OR
      OLD.directive_id IS NOT NEW.directive_id OR OLD.directive_hash IS NOT NEW.directive_hash OR OLD.kind IS NOT NEW.kind OR
      OLD.replacement_run_id IS NOT NEW.replacement_run_id OR OLD.budget_max_cost_microusd IS NOT NEW.budget_max_cost_microusd OR
      OLD.budget_max_tokens IS NOT NEW.budget_max_tokens OR OLD.budget_max_active_seconds IS NOT NEW.budget_max_active_seconds OR
      OLD.budget_pricing_policy_digest IS NOT NEW.budget_pricing_policy_digest OR OLD.replacement_json IS NOT NEW.replacement_json OR
      OLD.created_at IS NOT NEW.created_at
      THEN RAISE(ABORT,'resolution replacement scaffold is immutable') END;
    SELECT CASE WHEN NOT (OLD.state='PREPARING' AND NEW.state IN ('READY','FAILED') AND NEW.updated_at>=OLD.updated_at)
      THEN RAISE(ABORT,'resolution replacement fence mismatch') END;
  END;
  CREATE TRIGGER prevent_resolution_replacement_delete_v31 BEFORE DELETE ON resolution_replacements BEGIN SELECT RAISE(ABORT,'resolution replacements are durable'); END;

  CREATE TRIGGER freeze_source_engineer_run_update_v31 BEFORE UPDATE ON engineer_runs
    WHEN EXISTS(SELECT 1 FROM resolution_cases c WHERE c.source_run_id=OLD.id)
    BEGIN SELECT RAISE(ABORT,'source run is frozen by a resolution case'); END;
  CREATE TRIGGER freeze_source_run_state_event_v31 BEFORE INSERT ON run_state_events
    WHEN EXISTS(SELECT 1 FROM resolution_cases c WHERE c.source_run_id=NEW.run_id)
    BEGIN SELECT RAISE(ABORT,'source run is frozen by a resolution case'); END;
  CREATE TRIGGER freeze_source_budget_event_v31 BEFORE INSERT ON budget_events
    WHEN EXISTS(SELECT 1 FROM resolution_cases c WHERE c.source_run_id=NEW.run_id)
    BEGIN SELECT RAISE(ABORT,'source run budget is frozen by a resolution case'); END;
  CREATE TRIGGER freeze_source_approval_request_v31 BEFORE INSERT ON approval_requests
    WHEN EXISTS(SELECT 1 FROM resolution_cases c WHERE c.source_run_id=NEW.run_id)
    BEGIN SELECT RAISE(ABORT,'source run approval is frozen by a resolution case'); END;
  CREATE TRIGGER freeze_source_approval_decision_v31 BEFORE INSERT ON approval_decisions
    WHEN EXISTS(SELECT 1 FROM resolution_cases c JOIN approval_requests r ON r.run_id=c.source_run_id WHERE r.id=NEW.approval_request_id)
    BEGIN SELECT RAISE(ABORT,'source run approval is frozen by a resolution case'); END;
  CREATE TRIGGER freeze_source_git_operation_v31 BEFORE INSERT ON git_operations
    WHEN EXISTS(SELECT 1 FROM resolution_cases c WHERE c.source_run_id=NEW.run_id)
    BEGIN SELECT RAISE(ABORT,'source run publication is frozen by a resolution case'); END;
  CREATE TRIGGER freeze_source_builder_dispatch_v31 BEFORE INSERT ON builder_dispatch_claims
    WHEN EXISTS(SELECT 1 FROM resolution_cases c WHERE c.source_run_id=NEW.run_id)
    BEGIN SELECT RAISE(ABORT,'source run dispatch is frozen by a resolution case'); END;
  CREATE TRIGGER freeze_source_hardening_lineage_v31 BEFORE INSERT ON engineer_run_lineage
    WHEN NEW.relation='OPTIONAL_HARDENING' AND EXISTS(SELECT 1 FROM resolution_cases c WHERE c.source_run_id=NEW.parent_run_id)
    BEGIN SELECT RAISE(ABORT,'source run hardening is frozen by a resolution case'); END;
`;
