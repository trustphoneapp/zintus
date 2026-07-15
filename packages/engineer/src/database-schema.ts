export const ENGINEER_DATABASE_SCHEMA_VERSION = 8;

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
    run_id TEXT NOT NULL UNIQUE REFERENCES engineer_runs(id) ON DELETE RESTRICT,
    workspace_identity TEXT NOT NULL UNIQUE,
    image_digest TEXT NOT NULL,
    environment_digest TEXT,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    destroyed_at TEXT
  );

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
    created_at TEXT NOT NULL
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
  CREATE INDEX IF NOT EXISTS idx_run_state_events_run_sequence ON run_state_events(run_id, sequence);
  CREATE INDEX IF NOT EXISTS idx_artifacts_run_created ON artifacts(run_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_retry_attempts_run_created ON retry_attempts(run_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_failures_run_fingerprint ON failure_records(run_id, fingerprint);
  CREATE INDEX IF NOT EXISTS idx_audit_run_created ON audit_events(run_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_decisions_run_created ON decisions(run_id, created_at);
`;
