import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ENGINEER_DATABASE_BASE_SCHEMA_VERSION,
  ENGINEER_DATABASE_MIGRATION_15_SQL,
  ENGINEER_DATABASE_MIGRATION_16_SQL,
  ENGINEER_DATABASE_MIGRATION_17_SQL,
  ENGINEER_DATABASE_MIGRATION_18_SQL,
  ENGINEER_DATABASE_MIGRATION_19_SQL,
  ENGINEER_DATABASE_MIGRATION_20_SQL,
  ENGINEER_DATABASE_MIGRATION_21_SQL,
  ENGINEER_DATABASE_MIGRATION_22_SQL,
  ENGINEER_DATABASE_MIGRATION_23_SQL,
  ENGINEER_DATABASE_MIGRATION_24_SQL,
  ENGINEER_DATABASE_MIGRATION_25_SQL,
  ENGINEER_DATABASE_MIGRATION_26_SQL,
  ENGINEER_DATABASE_MIGRATION_27_SQL,
  ENGINEER_DATABASE_SCHEMA_SQL,
  ENGINEER_DATABASE_SCHEMA_VERSION,
} from "./database-schema.js";
import { migrateEngineerDatabase } from "./database-migrations.js";
import { TaskManifestSchema, type TaskManifestContent } from "./contracts.js";
import { canonicalJson, sha256 } from "./hash.js";
import { EngineerLedger } from "./ledger.js";
import { RequiredLaneContractSchema } from "./required-lane-contracts.js";
import {
  createAdvisoryBacklogEvent, createAdvisoryBacklogItem, createEngineerRunLineage,
  createHardeningConsent, createHardeningQuote, createPublicationCandidateSelection,
  createSignedCandidateLineageAttestation, hardeningChildRunId,
} from "./advisory-hardening-contracts.js";

function checkpointBindingFixture(batchResult: string, bundleOverrides: Record<string, unknown> = {}, includeAdvisory = false) {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(ENGINEER_DATABASE_SCHEMA_SQL);
  db.query("INSERT INTO schema_migrations(version, applied_at) VALUES (14, ?)").run("2026-07-17T12:00:00.000Z");
  migrateEngineerDatabase(db, "2026-07-17T12:00:00.000Z");
  const at = "2026-07-17T12:00:00.000Z";
  const manifestContent: TaskManifestContent = {
    manifestVersion: 1, runId: "checkpoint-run",
    repository: { repositoryId: "checkpoint-repo", provider: "local", owner: "local", name: "checkpoint", baseBranch: "main", baseCommitSha: "a".repeat(40) },
    request: { original: "request", normalized: "request" },
    acceptanceCriteria: [{ criterionId: "must", statement: "Preserve behavior", verificationMethod: "bun test", priority: "MUST" }],
    testPlan: [{ testId: "unit", criterionIds: ["must"], type: "UNIT", description: "test", command: "bun test" }],
    allowedPaths: ["src/**"], deniedPaths: ["src/secret/**"], allowedCommands: ["bun test"], prohibitedCommands: [],
    riskTier: "LOW", humanGateRequired: true,
    retryBudgets: { sameFailureAttempts: 1, builderRepairAttempts: 1, reviewerFixAttempts: 1, plannerRestarts: 1, sandboxProvisioningAttempts: 1, transientModelAttempts: 1 },
    timeBudgetSeconds: 600, tokenBudget: 10_000, costBudgetUsd: 1, createdAt: at,
  };
  const manifest = TaskManifestSchema.parse({ ...manifestContent, manifestHash: sha256(manifestContent) });
  const manifestHash = manifest.manifestHash;
  const contractHash = sha256("checkpoint-contract");
  const classificationHash = sha256(`checkpoint-classification-${batchResult}`);
  const evidenceBundleHash = sha256(`checkpoint-evidence-${batchResult}`);
  db.query("INSERT INTO users(id, created_at, updated_at) VALUES ('checkpoint-user', ?, ?)").run(at, at);
  db.query(`INSERT INTO repository_connections
    (id, user_id, provider, owner, name, created_at, updated_at)
    VALUES ('checkpoint-repo', 'checkpoint-user', 'local', 'local', 'checkpoint', ?, ?)`).run(at, at);
  db.query(`INSERT INTO engineer_runs
    (id, user_id, repository_id, base_branch, base_commit_sha, request_original, request_normalized,
     state, state_version, manifest_hash, risk_tier, human_gate_required, created_at, updated_at)
    VALUES ('checkpoint-run', 'checkpoint-user', 'checkpoint-repo', 'main', ?, 'request', 'request',
      'REVIEW_APPROVED', 1, ?, 'LOW', 1, ?, ?)`).run("a".repeat(40), manifestHash, at, at);
  db.query(`INSERT INTO task_manifest_versions
    (id, run_id, version, manifest_hash, manifest_json, created_at)
    VALUES ('checkpoint-manifest-id', 'checkpoint-run', 1, ?, ?, ?)`).run(manifestHash, canonicalJson(manifest), at);
  db.query(`INSERT INTO required_lane_contracts
    (contract_hash, run_id, manifest_hash, schema_version, contract_json, created_at)
    VALUES (?, 'checkpoint-run', ?, 2, '{}', ?)`).run(contractHash, manifestHash, at);
  db.query(`INSERT INTO artifacts
    (id, run_id, type, sha256, producer_type, producer_id, storage_reference, size_bytes, trusted, created_at)
    VALUES ('checkpoint-raw-output', 'checkpoint-run', 'REVIEWER_RAW_OUTPUT', ?, 'SYSTEM', 'reviewer', '/tmp/raw', 1, 1, ?)`).run(sha256("raw"), at);
  db.query(`INSERT INTO reviewer_sessions
    (id, run_id, attempt, model_tier, resolved_model, input_hash, manifest_hash, diff_hash,
     evidence_bundle_hash, policy_version, cache_key, cache_hit, cache_observed, started_at, completed_at,
     decision, isolation_verified)
    VALUES ('checkpoint-reviewer', 'checkpoint-run', 1, 'GPT-5.6_SOL', 'gpt-5.6', ?, ?, ?, ?,
      'review-v1', ?, 0, 1, ?, ?, 'APPROVE', 1)`).run(
        sha256("input"), manifestHash, sha256("diff"), sha256("reviewer-input-evidence"), sha256("cache"), at, at,
      );
  if (includeAdvisory) {
    db.query(`INSERT INTO review_findings
      (id,reviewer_session_id,fingerprint,severity,category,file,line_start,line_end,description,required_change,
       criterion_ids_json,evidence_ids_json,status)
      VALUES ('checkpoint-finding','checkpoint-reviewer',?,'MEDIUM','hardening','src/index.ts',1,2,
       'Optional improvement','Add defense','["must"]','["evidence"]','OPEN')`).run(sha256("checkpoint-finding-fingerprint"));
    db.exec("BEGIN IMMEDIATE");
    db.query(`INSERT INTO review_finding_classifications
      (classification_hash,batch_hash,reviewer_session_id,finding_id,finding_fingerprint,disposition,authority,reason_code,classification_json)
      VALUES (?,?, 'checkpoint-reviewer','checkpoint-finding',?,'ADVISORY','NONE','OUTSIDE_FROZEN_REQUIRED_SCOPE','{}')`).run(
        sha256("checkpoint-source-classification"), classificationHash, sha256("checkpoint-finding-fingerprint"),
      );
  }
  db.query(`INSERT INTO review_classification_batches
    (classification_hash, reviewer_session_id, run_id, contract_hash, schema_version, policy_version,
     raw_output_artifact_id, raw_output_hash, normalized_output_hash, normalized_session_hash,
     normalized_findings_hash, reviewer_input_json, normalized_output_json, batch_json, created_at)
    VALUES (?, 'checkpoint-reviewer', 'checkpoint-run', ?, 1, 'mapping-v1', 'checkpoint-raw-output', ?, ?, ?, ?, '{}', '{}', ?, ?)`)
    .run(classificationHash, contractHash, sha256("raw"), sha256("normalized"), sha256("session"), sha256("findings"), JSON.stringify({ result: batchResult }), at);
  if (includeAdvisory) db.exec("COMMIT");
  const bundle = {
    bundleVersion: 2, reviewerSessionId: "checkpoint-reviewer", classificationHash,
    classificationResult: batchResult, ...bundleOverrides,
  };
  db.query(`INSERT INTO evidence_bundles
    (id, run_id, manifest_hash, bundle_hash, base_commit_sha, result_commit_sha, environment_digest,
     manifest_json, final_decision, created_at)
    VALUES ('checkpoint-bundle', 'checkpoint-run', ?, ?, ?, ?, ?, ?, 'APPROVE', ?)`).run(
      manifestHash, evidenceBundleHash, "a".repeat(40), "b".repeat(40), sha256("environment"), JSON.stringify(bundle), at,
    );
  return {
    db, at, manifestHash, contractHash, classificationHash, evidenceBundleHash,
    manifest, checkpointId: sha256("checkpoint-id"), checkpointHash: sha256("checkpoint-hash"),
  };
}

function insertCheckpointFixture(
  fixture: ReturnType<typeof checkpointBindingFixture>,
  classificationResult: "READY" | "READY_WITH_ADVISORIES",
) {
  fixture.db.query(`INSERT INTO verified_candidate_checkpoints
    (id, checkpoint_hash, parent_checkpoint_id, run_id, requester_user_id, repository_id,
     required_lane_contract_hash, manifest_hash, base_commit_sha, result_commit_sha, diff_hash,
     reviewer_session_id, classification_hash, classification_result, evidence_bundle_id,
     evidence_bundle_hash, environment_digest, checkpoint_json, statement_json, statement_hash,
     signature_algorithm, signature_key_id, signature, created_at)
    VALUES (?, ?, NULL, 'checkpoint-run', 'checkpoint-user', 'checkpoint-repo', ?, ?, ?, ?, ?,
      'checkpoint-reviewer', ?, ?, 'checkpoint-bundle', ?, ?, ?, '{}', ?, 'test', 'key', 'signature', ?)`)
    .run(sha256("checkpoint-id"), sha256("checkpoint-hash"), fixture.contractHash, fixture.manifestHash,
      "a".repeat(40), "b".repeat(40), sha256("diff"), fixture.classificationHash, classificationResult,
      fixture.evidenceBundleHash, sha256("environment"), canonicalJson({
        schemaVersion:1,policyVersion:"verified-candidate-checkpoint-v1",parentCheckpointId:null,
      }), sha256("statement"), fixture.at);
}

function insertParentPublicationSelection(fixture: ReturnType<typeof checkpointBindingFixture>, revision: number, previousSelectionId: string | null) {
  const selection = createPublicationCandidateSelection({
    schemaVersion: 1, policyVersion: "engineer-publication-selection-v1", rootRunId: "checkpoint-run",
    candidateRunId: "checkpoint-run", requesterUserId: "checkpoint-user", repositoryId: "checkpoint-repo",
    candidateKind: "PARENT", selectedCheckpointId: fixture.checkpointId, selectedCheckpointHash: fixture.checkpointHash,
    selectedResultCommitSha: "b".repeat(40), candidateLineageAttestationId: null, candidateLineageAttestationHash: null,
    revision, expectedRevision: revision - 1, previousSelectionId, reasonCode: "USER_SELECTED_PARENT",
    actorId: "checkpoint-user", idempotencyKey: `selection-${revision}`,
    selectedAt: new Date(Date.parse(fixture.at) + revision * 1_000).toISOString(),
  });
  fixture.db.query(`INSERT INTO publication_candidate_selections
    (id,selection_hash,schema_version,policy_version,root_run_id,candidate_run_id,requester_user_id,
     repository_id,candidate_kind,selected_checkpoint_id,selected_checkpoint_hash,selected_result_commit_sha,
     candidate_lineage_attestation_id,candidate_lineage_attestation_hash,revision,expected_revision,previous_selection_id,reason_code,
     actor_id,idempotency_key,selection_json,selected_at)
    VALUES (?,?,1,?,?,?,?,?,'PARENT',?,?,?,NULL,NULL,?,?,?,'USER_SELECTED_PARENT',?,?,?,?)`).run(
      selection.selectionId, selection.selectionHash, selection.policyVersion, selection.rootRunId,
      selection.candidateRunId, selection.requesterUserId, selection.repositoryId, selection.selectedCheckpointId,
      selection.selectedCheckpointHash, selection.selectedResultCommitSha, selection.revision,
      selection.expectedRevision, selection.previousSelectionId, selection.actorId, selection.idempotencyKey,
      canonicalJson(selection), selection.selectedAt,
    );
  return selection;
}

function restoreLegacyCheckpointTable(db: Database): void {
  const hasV27 = (db.query("PRAGMA table_info(verified_candidate_checkpoints)").all() as Array<{name:string}>)
    .some((column) => column.name === "parent_checkpoint_hash");
  if (hasV27) {
    const legacyTable = ENGINEER_DATABASE_MIGRATION_21_SQL.match(
      /CREATE TABLE verified_candidate_checkpoints[\s\S]*?;\s*(?=CREATE INDEX idx_verified_candidate_checkpoints_run_created)/,
    )?.[0];
    const legacyObjects = ENGINEER_DATABASE_MIGRATION_21_SQL.match(
      /CREATE INDEX idx_verified_candidate_checkpoints_run_created[\s\S]*?(?=ALTER TABLE approval_requests)/,
    )?.[0];
    if (!legacyTable || !legacyObjects) throw new Error("test fixture cannot restore the v21 checkpoint table");
    db.exec(legacyTable.replace("CREATE TABLE verified_candidate_checkpoints", "CREATE TABLE verified_candidate_checkpoints_legacy"));
    db.exec(`INSERT INTO verified_candidate_checkpoints_legacy
      (id,checkpoint_hash,parent_checkpoint_id,run_id,requester_user_id,repository_id,required_lane_contract_hash,
       manifest_hash,base_commit_sha,result_commit_sha,diff_hash,reviewer_session_id,classification_hash,
       classification_result,evidence_bundle_id,evidence_bundle_hash,environment_digest,checkpoint_json,
       statement_json,statement_hash,signature_algorithm,signature_key_id,signature,created_at)
      SELECT id,checkpoint_hash,parent_checkpoint_id,run_id,requester_user_id,repository_id,required_lane_contract_hash,
       manifest_hash,base_commit_sha,result_commit_sha,diff_hash,reviewer_session_id,classification_hash,
       classification_result,evidence_bundle_id,evidence_bundle_hash,environment_digest,checkpoint_json,
       statement_json,statement_hash,signature_algorithm,signature_key_id,signature,created_at
      FROM verified_candidate_checkpoints;
      DROP TABLE verified_candidate_checkpoints;
      ALTER TABLE verified_candidate_checkpoints_legacy RENAME TO verified_candidate_checkpoints;`);
    db.exec(legacyObjects);
    db.exec("DROP INDEX IF EXISTS uq_hardening_seed_attestation_pair_v27");
  }
}

function removeV28Schema(db: Database): void {
  const quoteColumns = new Set(
    (db.query("PRAGMA table_info(hardening_quotes)").all() as Array<{ name: string }>).map((column) => column.name),
  );
  db.exec(`
    PRAGMA foreign_keys=OFF;
    DELETE FROM schema_migrations WHERE version=32;
    ALTER TABLE failure_records DROP COLUMN underlying_cause;
    DELETE FROM schema_migrations WHERE version=31;
    DROP TRIGGER IF EXISTS freeze_source_hardening_lineage_v31;
    DROP TRIGGER IF EXISTS freeze_source_builder_dispatch_v31;
    DROP TRIGGER IF EXISTS freeze_source_git_operation_v31;
    DROP TRIGGER IF EXISTS freeze_source_approval_decision_v31;
    DROP TRIGGER IF EXISTS freeze_source_approval_request_v31;
    DROP TRIGGER IF EXISTS freeze_source_budget_event_v31;
    DROP TRIGGER IF EXISTS freeze_source_run_state_event_v31;
    DROP TRIGGER IF EXISTS freeze_source_engineer_run_update_v31;
    DROP TABLE IF EXISTS resolution_replacements;
    DROP TABLE IF EXISTS resolution_events;
    DROP TABLE IF EXISTS resolution_directives;
    DROP TABLE IF EXISTS resolution_cases;
    DELETE FROM schema_migrations WHERE version=30;
    DROP TRIGGER IF EXISTS prevent_hardening_recovery_worker_fence_delete_v30;
    DROP TRIGGER IF EXISTS fence_hardening_recovery_worker_fence_update_v30;
    DROP TRIGGER IF EXISTS require_hardening_recovery_worker_fence_child_v30;
    DROP INDEX IF EXISTS idx_hardening_recovery_worker_fence_generation_v30;
    DROP TABLE IF EXISTS hardening_recovery_worker_fences;
    DROP TRIGGER IF EXISTS prevent_hardening_child_budget_topup_event_v29;
    DROP TRIGGER IF EXISTS prevent_hardening_child_budget_limit_update_v29;
    DROP TRIGGER IF EXISTS prevent_hardening_paid_call_finalization_delete_v29;
    DROP TRIGGER IF EXISTS fence_hardening_paid_call_finalization_update_v29;
    DROP TRIGGER IF EXISTS require_hardening_paid_call_finalization_binding_v29;
    DROP INDEX IF EXISTS idx_hardening_paid_call_finalization_status_v29;
    DROP TABLE IF EXISTS hardening_paid_call_finalizations;
    DROP TABLE IF EXISTS hardening_child_tool_actions;
    DROP TABLE IF EXISTS hardening_child_model_reservations;
    DROP TABLE IF EXISTS hardening_child_budget_authorities;
    DROP INDEX IF EXISTS uq_hardening_model_call_slot_binding_v29;
    DROP INDEX IF EXISTS uq_hardening_consent_pair_v29;
    DROP INDEX IF EXISTS uq_hardening_quote_pair_v29;
    DELETE FROM schema_migrations WHERE version=29;
    DROP TABLE IF EXISTS hardening_model_call_slots;
    DROP TABLE IF EXISTS hardening_start_claims;
    DELETE FROM schema_migrations WHERE version=28;
  `);
  if (quoteColumns.has("sizing_authority_id")) {
    const legacyQuoteTable = ENGINEER_DATABASE_MIGRATION_23_SQL.match(
      /CREATE TABLE hardening_quotes \([\s\S]*?\n  \);/,
    )?.[0];
    const legacyQuoteObjects = [
      /CREATE INDEX idx_hardening_quotes_checkpoint_created_v23[\s\S]*?;/,
      /CREATE INDEX idx_hardening_quotes_user_expiry_v23[\s\S]*?;/,
      /CREATE TRIGGER require_quote_binding_v23[\s\S]*?\n  END;/,
      /CREATE TRIGGER prevent_hardening_quotes_update_v23[\s\S]*?END;/,
      /CREATE TRIGGER prevent_hardening_quotes_delete_v23[\s\S]*?END;/,
    ].map((pattern) => ENGINEER_DATABASE_MIGRATION_23_SQL.match(pattern)?.[0]);
    if (!legacyQuoteTable || legacyQuoteObjects.some((statement) => !statement)) {
      throw new Error("test fixture cannot restore the v23 hardening quote table");
    }
    db.exec(`
      DROP TRIGGER IF EXISTS require_quote_binding_v23;
      DROP TRIGGER IF EXISTS require_hardening_quote_version_projection_v29;
      DROP TRIGGER IF EXISTS prevent_hardening_quotes_update_v23;
      DROP TRIGGER IF EXISTS prevent_hardening_quotes_delete_v23;
      DROP INDEX IF EXISTS idx_hardening_quotes_checkpoint_created_v23;
      DROP INDEX IF EXISTS idx_hardening_quotes_user_expiry_v23;
      DROP INDEX IF EXISTS idx_hardening_quotes_sizing_v29;
      ${legacyQuoteTable.replace("CREATE TABLE hardening_quotes", "CREATE TABLE hardening_quotes_v28")}
      INSERT INTO hardening_quotes_v28
        (id,quote_hash,schema_version,policy_version,estimator_version,parent_run_id,requester_user_id,
         repository_id,parent_checkpoint_id,parent_checkpoint_hash,parent_state_version,selection_hash,advisory_count,
         routing_policy_version,pricing_version,max_cost_microusd,max_tokens,max_time_seconds,max_planner_calls,
         max_builder_calls,max_reviewer_calls,automatic_repair_calls,quote_json,created_at,expires_at)
      SELECT id,quote_hash,schema_version,policy_version,estimator_version,parent_run_id,requester_user_id,
         repository_id,parent_checkpoint_id,parent_checkpoint_hash,parent_state_version,selection_hash,advisory_count,
         routing_policy_version,pricing_version,max_cost_microusd,max_tokens,max_time_seconds,max_planner_calls,
         max_builder_calls,max_reviewer_calls,automatic_repair_calls,quote_json,created_at,expires_at
      FROM hardening_quotes WHERE schema_version=1;
      DROP TABLE hardening_quotes;
      ALTER TABLE hardening_quotes_v28 RENAME TO hardening_quotes;
      ${legacyQuoteObjects.join("\n")}
    `);
  }
  db.exec(`
    DROP TRIGGER IF EXISTS require_hardening_quote_sizing_authority_projection_v29;
    DROP TRIGGER IF EXISTS prevent_hardening_quote_sizing_authority_update_v29;
    DROP TRIGGER IF EXISTS prevent_hardening_quote_sizing_authority_delete_v29;
    DROP INDEX IF EXISTS uq_hardening_quote_sizing_authority_pair_v29;
    DROP INDEX IF EXISTS idx_hardening_quote_sizing_checkpoint_v29;
    DROP TABLE IF EXISTS hardening_quote_sizing_authorities;
  `);
}

function removeV23Schema(db: Database): void {
  removeV28Schema(db);
  db.exec("PRAGMA foreign_keys=OFF");
  restoreLegacyCheckpointTable(db);
  db.exec(`
    DELETE FROM schema_migrations WHERE version=27;
    DELETE FROM schema_migrations WHERE version=26;
    DROP TRIGGER IF EXISTS require_hardening_start_operation_binding_v26;
    DROP TRIGGER IF EXISTS require_hardening_seed_attestation_binding_v26;
    DROP TRIGGER IF EXISTS prevent_hardening_start_operations_update_v26;
    DROP TRIGGER IF EXISTS prevent_hardening_start_operations_delete_v26;
    DROP TRIGGER IF EXISTS prevent_hardening_seed_attestations_update_v26;
    DROP TRIGGER IF EXISTS prevent_hardening_seed_attestations_delete_v26;
    DROP TABLE IF EXISTS hardening_seed_attestations;
    DROP TABLE IF EXISTS hardening_start_operations;
    DROP INDEX IF EXISTS uq_engineer_run_lineage_pair_v26;
    DROP INDEX IF EXISTS uq_verified_candidate_checkpoint_pair_v26;
    DELETE FROM schema_migrations WHERE version=25;
    DROP TRIGGER IF EXISTS require_hardening_quote_request_binding_v24;
    DROP TRIGGER IF EXISTS prevent_hardening_quote_requests_update_v24;
    DROP TRIGGER IF EXISTS prevent_hardening_quote_requests_delete_v24;
    DROP INDEX IF EXISTS idx_hardening_quote_requests_run_created_v24;
    DROP TABLE IF EXISTS hardening_quote_requests;
    DELETE FROM schema_migrations WHERE version=24;
  `);
  const triggers = db.query("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE '%_v23'").all() as Array<{ name: string }>;
  for (const { name } of triggers) db.exec(`DROP TRIGGER ${JSON.stringify(name)}`);
  db.exec(`
    DROP INDEX IF EXISTS idx_approval_selection_pair_v23;
    DROP INDEX IF EXISTS idx_git_selection_pair_v23;
    ALTER TABLE approval_requests DROP COLUMN publication_selection_id;
    ALTER TABLE approval_requests DROP COLUMN publication_selection_hash;
    ALTER TABLE git_operations DROP COLUMN publication_selection_id;
    ALTER TABLE git_operations DROP COLUMN publication_selection_hash;
  `);
  for (const table of ["publication_candidate_selections", "candidate_lineage_attestations", "advisory_backlog_events", "engineer_run_lineage", "hardening_consents", "hardening_quotes", "hardening_quote_advisories", "advisory_backlog_items"]) db.exec(`DROP TABLE ${table}`);
  db.exec(`
    DELETE FROM schema_migrations WHERE version=23;
    PRAGMA foreign_keys=ON;
  `);
}

describe("Engineer database schema", () => {
  test("keeps the v14 bootstrap stable while Required Lane migrations remain ordered", () => {
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
    expect(ENGINEER_DATABASE_BASE_SCHEMA_VERSION).toBe(14);
    expect(ENGINEER_DATABASE_SCHEMA_VERSION).toBe(32);
    expect(tables.has("required_lane_contracts")).toBe(false);
    db.close();
  });

  test("installs the exact empty v23 optional-hardening foundation without backfill", () => {
    const db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys=ON");
    db.exec(ENGINEER_DATABASE_SCHEMA_SQL);
    db.query("INSERT INTO schema_migrations(version, applied_at) VALUES (14, ?)").run("2026-07-18T12:00:00.000Z");
    migrateEngineerDatabase(db, "2026-07-18T12:00:00.000Z");
    const tables = ["advisory_backlog_items", "hardening_quote_advisories", "hardening_quotes", "hardening_consents", "engineer_run_lineage", "advisory_backlog_events", "candidate_lineage_attestations", "publication_candidate_selections"];
    for (const table of tables) expect(db.query(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    const objects = new Set((db.query("SELECT name FROM sqlite_master WHERE sql IS NOT NULL").all() as Array<{ name: string }>).map((row) => row.name));
    for (const name of [
      "idx_advisory_backlog_parent_run_v23", "idx_hardening_quotes_checkpoint_created_v23",
      "idx_hardening_consents_checkpoint_accepted_v23", "idx_run_lineage_root_created_v23",
      "idx_advisory_events_revision_v23", "idx_candidate_lineage_child_v23",
      "idx_publication_selection_root_revision_v23", "require_advisory_binding_v23",
      "require_publication_selection_binding_v23", "prevent_publication_candidate_selections_delete_v23",
    ]) expect(objects.has(name)).toBe(true);
    const partialIndexes = db.query("SELECT name FROM pragma_index_list('publication_candidate_selections') WHERE partial=1").all();
    expect(partialIndexes).toEqual([]);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.query("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 32 });
    db.close();
  });

  test("installs an exact immutable v24 quote-request idempotency authority and rejects ancestry or shape drift", () => {
    expect(ENGINEER_DATABASE_MIGRATION_24_SQL).not.toContain("INSERT INTO hardening_quote_requests");
    const timestamp="2026-07-18T12:00:00.000Z";
    const db=new Database(":memory:");db.exec("PRAGMA foreign_keys=ON");db.exec(ENGINEER_DATABASE_SCHEMA_SQL);
    db.query("INSERT INTO schema_migrations(version,applied_at) VALUES(14,?)").run(timestamp);migrateEngineerDatabase(db,timestamp);
    expect(db.query("SELECT COUNT(*) AS count FROM hardening_quote_requests").get()).toEqual({count:0});
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    db.exec("DROP TRIGGER prevent_hardening_quote_requests_update_v24; CREATE TRIGGER prevent_hardening_quote_requests_update_v24 BEFORE UPDATE ON hardening_quote_requests BEGIN SELECT 1; END;");
    expect(()=>migrateEngineerDatabase(db,timestamp)).toThrow("invalid prevent_hardening_quote_requests_update_v24");db.close();

    const gap=new Database(":memory:");gap.exec(ENGINEER_DATABASE_SCHEMA_SQL);
    for(const version of [14,15,16,17,18,19,20,21,22,24])gap.query("INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)").run(version,timestamp);
    expect(()=>migrateEngineerDatabase(gap,timestamp)).toThrow("v24 is missing required migration ancestry");gap.close();
  });

  test("installs the minimal v25 revision-zero child-budget authority and rejects counterfeit shape or ancestry", () => {
    expect(ENGINEER_DATABASE_MIGRATION_25_SQL).toContain("CHECK(revision >= 0)");
    const at="2026-07-18T12:00:00.000Z";
    const initialize=(db:Database)=>{db.exec("PRAGMA foreign_keys=ON");db.exec(ENGINEER_DATABASE_SCHEMA_SQL);
      db.query("INSERT INTO schema_migrations(version,applied_at) VALUES(14,?)").run(at);migrateEngineerDatabase(db,at);};
    const initializeV24=(db:Database)=>{db.exec("PRAGMA foreign_keys=ON");db.exec(ENGINEER_DATABASE_SCHEMA_SQL);
      db.query("INSERT INTO schema_migrations(version,applied_at) VALUES(14,?)").run(at);
      for(const [version,sql] of [[15,ENGINEER_DATABASE_MIGRATION_15_SQL],[16,ENGINEER_DATABASE_MIGRATION_16_SQL],
        [17,ENGINEER_DATABASE_MIGRATION_17_SQL],[18,ENGINEER_DATABASE_MIGRATION_18_SQL],[19,ENGINEER_DATABASE_MIGRATION_19_SQL],
        [20,ENGINEER_DATABASE_MIGRATION_20_SQL],[21,ENGINEER_DATABASE_MIGRATION_21_SQL],[22,ENGINEER_DATABASE_MIGRATION_22_SQL],
        [23,ENGINEER_DATABASE_MIGRATION_23_SQL],[24,ENGINEER_DATABASE_MIGRATION_24_SQL]] as const){db.exec(sql);db.query("INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)").run(version,at);}};
    const db=new Database(":memory:");initialize(db);
    expect(db.query("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({version:32});
    expect(()=>db.query(`INSERT INTO run_budgets(run_id,cost_limit_usd,token_limit,time_limit_seconds,lifetime_cost_limit_usd,lifetime_token_limit,
      lifetime_time_limit_seconds,status,revision,created_at,updated_at) VALUES('missing',1,1,1,1,1,1,'ACTIVE',-1,?,?)`).run(at,at)).toThrow();
    const gap=new Database(":memory:");initialize(gap);gap.query("DELETE FROM schema_migrations WHERE version=24").run();
    expect(()=>migrateEngineerDatabase(gap,at)).toThrow("v25 is missing required migration ancestry");gap.close();db.close();

    const populated=new Database(":memory:");initializeV24(populated);
    populated.query("INSERT INTO users(id,created_at,updated_at) VALUES('v25-user',?,?)").run(at,at);
    populated.query("INSERT INTO repository_connections(id,user_id,provider,owner,name,created_at,updated_at) VALUES('v25-repo','v25-user','local','local','repo',?,?)").run(at,at);
    populated.query(`INSERT INTO engineer_runs(id,user_id,repository_id,base_branch,base_commit_sha,request_original,request_normalized,state,state_version,risk_tier,human_gate_required,created_at,updated_at)
      VALUES('v25-run','v25-user','v25-repo','main',?,'request','request','REQUEST_RECEIVED',0,'MEDIUM',1,?,?)`).run("a".repeat(40),at,at);
    populated.query(`INSERT INTO run_budgets(run_id,cost_limit_usd,token_limit,time_limit_seconds,lifetime_cost_limit_usd,lifetime_token_limit,lifetime_time_limit_seconds,
      used_cost_usd,used_tokens,used_time_seconds,reserved_cost_usd,reserved_tokens,ambiguous_cost_usd,ambiguous_tokens,status,pause_reason,resume_state,warning_threshold,revision,active_since,created_at,updated_at)
      VALUES('v25-run',1.25,123,456,2.5,246,912,0.25,12,34,0.5,23,0.75,34,'WARNING',NULL,NULL,0.9,7,?,?,?)`).run(at,at,at);
    const before=populated.query("SELECT * FROM run_budgets WHERE run_id='v25-run'").get();
    const priorObjects=populated.query("SELECT type,name,sql FROM sqlite_master WHERE tbl_name='run_budgets' AND type IN('index','trigger') AND name NOT LIKE '%_v29' ORDER BY type,name").all();
    const priorForeignKeys=populated.query("PRAGMA foreign_key_list(run_budgets)").all();migrateEngineerDatabase(populated,at);
    expect(populated.query("SELECT * FROM run_budgets WHERE run_id='v25-run'").get()).toEqual(before);
    expect(populated.query("SELECT type,name,sql FROM sqlite_master WHERE tbl_name='run_budgets' AND type IN('index','trigger') AND name NOT LIKE '%_v29' ORDER BY type,name").all()).toEqual(priorObjects);
    expect(populated.query("PRAGMA foreign_key_list(run_budgets)").all()).toEqual(priorForeignKeys);populated.close();

    const counterfeit=new Database(":memory:");initializeV24(counterfeit);
    counterfeit.exec(ENGINEER_DATABASE_MIGRATION_25_SQL.replace("CHECK(revision >= 0)","CHECK(revision >= -1)"));
    counterfeit.query("INSERT INTO schema_migrations(version,applied_at) VALUES(25,?)").run(at);
    expect(()=>migrateEngineerDatabase(counterfeit,at)).toThrow("invalid run_budgets authority");counterfeit.close();

    const counterfeitOtherColumn=new Database(":memory:");initializeV24(counterfeitOtherColumn);
    counterfeitOtherColumn.exec(ENGINEER_DATABASE_MIGRATION_25_SQL.replace("CHECK(cost_limit_usd >= 0)","CHECK(cost_limit_usd >= -1)"));
    counterfeitOtherColumn.query("INSERT INTO schema_migrations(version,applied_at) VALUES(25,?)").run(at);
    expect(()=>migrateEngineerDatabase(counterfeitOtherColumn,at)).toThrow("invalid run_budgets authority");counterfeitOtherColumn.close();

    for(const [name,mutated] of [
      ["default",ENGINEER_DATABASE_MIGRATION_25_SQL.replace("DEFAULT 0.8 CHECK(warning_threshold", "DEFAULT 0.7 CHECK(warning_threshold")],
      ["column",ENGINEER_DATABASE_MIGRATION_25_SQL.replace("token_limit INTEGER NOT NULL", "token_limit REAL NOT NULL")],
      ["order",ENGINEER_DATABASE_MIGRATION_25_SQL.replace("pause_reason TEXT, resume_state TEXT", "resume_state TEXT, pause_reason TEXT")],
      ["foreign-key",ENGINEER_DATABASE_MIGRATION_25_SQL.replace("REFERENCES engineer_runs(id) ON DELETE RESTRICT", "REFERENCES engineer_runs(id) ON DELETE CASCADE")],
    ] as const){const counterfeitShape=new Database(":memory:");initializeV24(counterfeitShape);counterfeitShape.exec(mutated);
      counterfeitShape.query("INSERT INTO schema_migrations(version,applied_at) VALUES(25,?)").run(at);
      expect(()=>migrateEngineerDatabase(counterfeitShape,at),name).toThrow("invalid run_budgets authority");counterfeitShape.close();}
  });

  test("installs empty exact immutable v26 hardening-start authority without rewriting v25 data", () => {
    expect(ENGINEER_DATABASE_MIGRATION_26_SQL).not.toContain("INSERT INTO hardening_start_operations");
    expect(ENGINEER_DATABASE_MIGRATION_26_SQL).not.toContain("INSERT INTO hardening_seed_attestations");
    const at="2026-07-18T12:00:00.000Z";
    const initializeV25=(db:Database)=>{db.exec("PRAGMA foreign_keys=ON");db.exec(ENGINEER_DATABASE_SCHEMA_SQL);
      db.query("INSERT INTO schema_migrations(version,applied_at) VALUES(14,?)").run(at);
      for(const [version,sql] of [[15,ENGINEER_DATABASE_MIGRATION_15_SQL],[16,ENGINEER_DATABASE_MIGRATION_16_SQL],
        [17,ENGINEER_DATABASE_MIGRATION_17_SQL],[18,ENGINEER_DATABASE_MIGRATION_18_SQL],[19,ENGINEER_DATABASE_MIGRATION_19_SQL],
        [20,ENGINEER_DATABASE_MIGRATION_20_SQL],[21,ENGINEER_DATABASE_MIGRATION_21_SQL],[22,ENGINEER_DATABASE_MIGRATION_22_SQL],
        [23,ENGINEER_DATABASE_MIGRATION_23_SQL],[24,ENGINEER_DATABASE_MIGRATION_24_SQL],[25,ENGINEER_DATABASE_MIGRATION_25_SQL]] as const){
        db.exec(sql);db.query("INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)").run(version,at);
      }};
    const db=new Database(":memory:");initializeV25(db);
    db.query("INSERT INTO users(id,created_at,updated_at) VALUES('preserved-user',?,?)").run(at,at);
    db.query("INSERT INTO repository_connections(id,user_id,provider,owner,name,created_at,updated_at) VALUES('preserved-repo','preserved-user','local','local','repo',?,?)").run(at,at);
    db.query(`INSERT INTO engineer_runs(id,user_id,repository_id,base_branch,base_commit_sha,request_original,request_normalized,state,state_version,risk_tier,human_gate_required,created_at,updated_at)
      VALUES('old-p4-child','preserved-user','preserved-repo','main',?,'hardening','hardening','REQUEST_RECEIVED',0,'HIGH',1,?,?)`).run("a".repeat(40),at,at);
    db.query(`INSERT INTO run_budgets(run_id,cost_limit_usd,token_limit,time_limit_seconds,lifetime_cost_limit_usd,lifetime_token_limit,lifetime_time_limit_seconds,status,revision,created_at,updated_at)
      VALUES('old-p4-child',1,100,60,1,100,60,'ACTIVE',0,?,?)`).run(at,at);
    const runBefore=db.query("SELECT * FROM engineer_runs WHERE id='old-p4-child'").get();
    const budgetBefore=db.query("SELECT * FROM run_budgets WHERE run_id='old-p4-child'").get();
    const priorSql=db.query("SELECT type,name,sql FROM sqlite_master WHERE name LIKE '%_v23' OR name LIKE '%_v24' OR name LIKE '%_v25' ORDER BY type,name").all();
    migrateEngineerDatabase(db,at);
    expect(db.query("SELECT * FROM engineer_runs WHERE id='old-p4-child'").get()).toEqual(runBefore);
    expect(db.query("SELECT * FROM run_budgets WHERE run_id='old-p4-child'").get()).toEqual(budgetBefore);
    expect(db.query("SELECT type,name,sql FROM sqlite_master WHERE name LIKE '%_v23' OR name LIKE '%_v24' OR name LIKE '%_v25' ORDER BY type,name").all()).toEqual(priorSql);
    expect(db.query("SELECT COUNT(*) AS count FROM hardening_start_operations").get()).toEqual({count:0});
    expect(db.query("SELECT COUNT(*) AS count FROM hardening_seed_attestations").get()).toEqual({count:0});
    expect(db.query("SELECT state,state_version FROM engineer_runs WHERE id='old-p4-child'").get()).toEqual({state:"REQUEST_RECEIVED",state_version:0});
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);db.close();

    const gap=new Database(":memory:");initializeV25(gap);gap.query("DELETE FROM schema_migrations WHERE version=25").run();
    gap.exec(ENGINEER_DATABASE_MIGRATION_26_SQL);gap.query("INSERT INTO schema_migrations(version,applied_at) VALUES(26,?)").run(at);
    expect(()=>migrateEngineerDatabase(gap,at)).toThrow("v26 is missing required migration ancestry");gap.close();

    for(const [label,sql] of [
      ["table",ENGINEER_DATABASE_MIGRATION_26_SQL.replace("CHECK(expected_child_state_version=0)","CHECK(expected_child_state_version>=0)")],
      ["index",ENGINEER_DATABASE_MIGRATION_26_SQL.replace("(child_run_id,created_at,id)","(created_at,child_run_id,id)")],
      ["trigger",ENGINEER_DATABASE_MIGRATION_26_SQL.replace("hardening start operations are immutable","counterfeit")],
      ["foreign-key",ENGINEER_DATABASE_MIGRATION_26_SQL.replace("REFERENCES engineer_run_lineage(id,lineage_hash) ON DELETE RESTRICT","REFERENCES engineer_run_lineage(id,lineage_hash) ON DELETE CASCADE")],
    ] as const){const counterfeit=new Database(":memory:");initializeV25(counterfeit);counterfeit.exec(sql);
      counterfeit.query("INSERT INTO schema_migrations(version,applied_at) VALUES(26,?)").run(at);
      expect(()=>migrateEngineerDatabase(counterfeit,at),label).toThrow("Engineer schema v26 has invalid");counterfeit.close();}
  });

  test("migrates v1 checkpoint bytes and signatures exactly into strict v27 versioned authority", () => {
    expect(ENGINEER_DATABASE_MIGRATION_27_SQL).toContain("verified-hardening-candidate-checkpoint-v2");
    const fixture=checkpointBindingFixture("READY");
    insertCheckpointFixture(fixture,"READY");
    fixture.db.exec("PRAGMA foreign_keys=OFF");
    removeV28Schema(fixture.db);
    restoreLegacyCheckpointTable(fixture.db);
    fixture.db.exec("CREATE UNIQUE INDEX uq_verified_candidate_checkpoint_pair_v26 ON verified_candidate_checkpoints(id,checkpoint_hash)");
    fixture.db.query("DELETE FROM schema_migrations WHERE version=27").run();
    fixture.db.exec("PRAGMA foreign_keys=ON");
    const legacyColumns=["id","checkpoint_hash","parent_checkpoint_id","run_id","requester_user_id","repository_id",
      "required_lane_contract_hash","manifest_hash","base_commit_sha","result_commit_sha","diff_hash","reviewer_session_id",
      "classification_hash","classification_result","evidence_bundle_id","evidence_bundle_hash","environment_digest",
      "checkpoint_json","statement_json","statement_hash","signature_algorithm","signature_key_id","signature","created_at"];
    const before=fixture.db.query(`SELECT ${legacyColumns.join(",")} FROM verified_candidate_checkpoints`).get();
    migrateEngineerDatabase(fixture.db,fixture.at);
    expect(fixture.db.query(`SELECT ${legacyColumns.join(",")} FROM verified_candidate_checkpoints`).get()).toEqual(before);
    expect(fixture.db.query(`SELECT parent_checkpoint_hash,hardening_lineage_id,hardening_lineage_hash,
      seed_attestation_id,seed_attestation_hash FROM verified_candidate_checkpoints`).get()).toEqual({
        parent_checkpoint_hash:null,hardening_lineage_id:null,hardening_lineage_hash:null,
        seed_attestation_id:null,seed_attestation_hash:null,
      });
    expect(fixture.db.query("SELECT checkpoint_json,statement_json,statement_hash,signature FROM verified_candidate_checkpoints").get())
      .toEqual({checkpoint_json:canonicalJson({schemaVersion:1,policyVersion:"verified-candidate-checkpoint-v1",parentCheckpointId:null}),
        statement_json:"{}",statement_hash:sha256("statement"),signature:"signature"});
    expect(fixture.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(()=>fixture.db.query("UPDATE verified_candidate_checkpoints SET signature=signature").run()).toThrow("immutable");
    fixture.db.close();

    const ancestry=checkpointBindingFixture("READY");
    ancestry.db.query("DELETE FROM schema_migrations WHERE version=26").run();
    expect(()=>migrateEngineerDatabase(ancestry.db,ancestry.at)).toThrow("v27 is missing required migration ancestry");
    ancestry.db.close();

    for(const [label,mutation] of [
      ["check",(sql:string)=>sql.replace("seed_attestation_hash IS NOT NULL)","seed_attestation_hash IS NULL)")],
      ["foreign-key",(sql:string)=>sql.replace(
        "REFERENCES hardening_seed_attestations(id,seed_attestation_hash) ON DELETE RESTRICT",
        "REFERENCES hardening_seed_attestations(id,seed_attestation_hash) ON DELETE CASCADE")],
      ["trigger",(sql:string)=>sql.replace("verified candidate checkpoints are immutable","counterfeit")],
    ] as const){
      const counterfeit=checkpointBindingFixture("READY");
      counterfeit.db.exec("PRAGMA foreign_keys=OFF");restoreLegacyCheckpointTable(counterfeit.db);
      counterfeit.db.query("DELETE FROM schema_migrations WHERE version=27").run();
      counterfeit.db.exec(mutation(ENGINEER_DATABASE_MIGRATION_27_SQL));
      counterfeit.db.query("INSERT INTO schema_migrations(version,applied_at) VALUES(27,?)").run(counterfeit.at);
      counterfeit.db.exec("PRAGMA foreign_keys=ON");
      expect(()=>migrateEngineerDatabase(counterfeit.db,counterfeit.at),label).toThrow("Engineer schema");
      counterfeit.db.close();
    }
  });

  test("persists one fully paired v2 checkpoint and rejects relational or projection tampering", () => {
    const fixture=checkpointBindingFixture("READY");insertCheckpointFixture(fixture,"READY");
    const db=fixture.db;const at="2026-07-18T13:00:00.000Z";
    const childRun="v27-child";const childManifestHash=sha256("v27-child-manifest");
    const childContractHash=sha256("v27-child-contract");const childDiffHash=sha256("v27-child-diff");
    const childClassificationHash=sha256("v27-child-classification");const childBundleHash=sha256("v27-child-bundle");
    const lineageId=sha256("v27-lineage-id");const lineageHash=sha256("v27-lineage-hash");
    const quoteId=sha256("v27-quote-id");const quoteHash=sha256("v27-quote-hash");
    const consentId=sha256("v27-consent-id");const consentHash=sha256("v27-consent-hash");
    const operationId=sha256("v27-operation-id");const operationHash=sha256("v27-operation-hash");
    const seedId=sha256("v27-seed-id");const seedHash=sha256("v27-seed-hash");
    for(const trigger of ["require_quote_binding_v23","require_consent_binding_v23","require_lineage_binding_v23",
      "require_hardening_start_operation_binding_v26","require_hardening_seed_attestation_binding_v26"]){
      db.exec(`DROP TRIGGER ${trigger}`);
    }
    db.query(`INSERT INTO engineer_runs(id,user_id,repository_id,base_branch,base_commit_sha,request_original,
      request_normalized,state,state_version,manifest_hash,risk_tier,human_gate_required,created_at,updated_at)
      VALUES(?,'checkpoint-user','checkpoint-repo','main',?,'hardening','hardening','REVIEWING',1,?,'HIGH',1,?,?)`)
      .run(childRun,"a".repeat(40),childManifestHash,at,at);
    const childManifest=canonicalJson({manifestVersion:1,runId:childRun,repository:{repositoryId:"checkpoint-repo",
      provider:"local",owner:"local",name:"checkpoint",baseBranch:"main",baseCommitSha:"a".repeat(40)},
      request:{original:"hardening",normalized:"hardening"},acceptanceCriteria:[],testPlan:[],allowedPaths:[],deniedPaths:[],
      allowedCommands:[],prohibitedCommands:[],riskTier:"HIGH",humanGateRequired:true,retryBudgets:{sameFailureAttempts:1,
        builderRepairAttempts:1,reviewerFixAttempts:1,plannerRestarts:1,sandboxProvisioningAttempts:1,transientModelAttempts:1},
      timeBudgetSeconds:60,tokenBudget:100,costBudgetUsd:1,createdAt:at,manifestHash:childManifestHash});
    db.query(`INSERT INTO task_manifest_versions(id,run_id,version,manifest_hash,manifest_json,created_at)
      VALUES('v27-child-manifest-id',?,1,?,?,?)`).run(childRun,childManifestHash,childManifest,at);
    db.query(`INSERT INTO required_lane_contracts(contract_hash,run_id,manifest_hash,schema_version,contract_json,created_at)
      VALUES(?,?,?,2,'{}',?)`).run(childContractHash,childRun,childManifestHash,at);
    db.query(`INSERT INTO artifacts(id,run_id,type,sha256,producer_type,producer_id,storage_reference,size_bytes,trusted,created_at)
      VALUES('v27-child-raw',?,'REVIEWER_RAW_OUTPUT',?,'SYSTEM','reviewer','/tmp/v27',1,1,?)`)
      .run(childRun,sha256("v27-child-raw"),at);
    db.query(`INSERT INTO reviewer_sessions(id,run_id,attempt,model_tier,resolved_model,input_hash,manifest_hash,diff_hash,
      evidence_bundle_hash,policy_version,cache_key,cache_hit,cache_observed,started_at,completed_at,decision,isolation_verified)
      VALUES('v27-child-reviewer',?,1,'GPT-5.6_SOL','gpt-5.6',?,?,?,?, 'review-v1',?,0,1,?,?,'APPROVE',1)`)
      .run(childRun,sha256("v27-input"),childManifestHash,childDiffHash,sha256("v27-review-evidence"),sha256("v27-cache"),at,at);
    db.query(`INSERT INTO review_classification_batches(classification_hash,reviewer_session_id,run_id,contract_hash,
      schema_version,policy_version,raw_output_artifact_id,raw_output_hash,normalized_output_hash,normalized_session_hash,
      normalized_findings_hash,reviewer_input_json,normalized_output_json,batch_json,created_at)
      VALUES(?,'v27-child-reviewer',?,?,1,'mapping-v1','v27-child-raw',?,?,?,?, '{}','{}',?,?)`)
      .run(childClassificationHash,childRun,childContractHash,sha256("v27-child-raw"),sha256("v27-normalized"),
        sha256("v27-session"),sha256("v27-findings"),JSON.stringify({result:"READY"}),at);
    db.query(`INSERT INTO evidence_bundles(id,run_id,manifest_hash,bundle_hash,base_commit_sha,result_commit_sha,
      environment_digest,manifest_json,final_decision,created_at) VALUES('v27-child-bundle',?,?,?,?,?,?,?,'APPROVE',?)`)
      .run(childRun,childManifestHash,childBundleHash,"a".repeat(40),"c".repeat(40),sha256("v27-environment"),
        JSON.stringify({bundleVersion:2,reviewerSessionId:"v27-child-reviewer",classificationHash:childClassificationHash,
          classificationResult:"READY"}),at);
    db.query(`INSERT INTO hardening_quotes(id,quote_hash,schema_version,policy_version,estimator_version,parent_run_id,
      requester_user_id,repository_id,parent_checkpoint_id,parent_checkpoint_hash,parent_state_version,selection_hash,
      advisory_count,routing_policy_version,pricing_version,max_cost_microusd,max_tokens,max_time_seconds,max_planner_calls,
      max_builder_calls,max_reviewer_calls,automatic_repair_calls,quote_json,created_at,expires_at)
      VALUES(?,?,1,'engineer-hardening-estimate-v1','deterministic-hardening-estimator-v1','checkpoint-run','checkpoint-user',
      'checkpoint-repo',?,?,1,?,1,'engineer-model-routing-v2','openai-gpt56-pricing-2026-07-14',1000000,100,60,0,1,1,0,'{}',?,?)`)
      .run(quoteId,quoteHash,fixture.checkpointId,fixture.checkpointHash,sha256("v27-selection"),fixture.at,at);
    db.query(`INSERT INTO hardening_consents(id,consent_hash,schema_version,policy_version,quote_id,quote_hash,parent_run_id,
      parent_checkpoint_id,parent_checkpoint_hash,parent_state_version,selection_hash,requester_user_id,actor_id,cost_microusd,
      tokens,time_seconds,acknowledge_separate_run,acknowledge_parent_unchanged,acknowledge_no_automatic_repair,
      acknowledge_no_overages,idempotency_key,consent_json,accepted_at,quote_expires_at)
      VALUES(?,?,1,'engineer-hardening-consent-v1',?,?,'checkpoint-run',?,?,1,?,'checkpoint-user','checkpoint-user',
      1000000,100,60,1,1,1,1,'v27-consent','{}',?,?)`)
      .run(consentId,consentHash,quoteId,quoteHash,fixture.checkpointId,fixture.checkpointHash,sha256("v27-selection"),fixture.at,at);
    db.query(`INSERT INTO engineer_run_lineage(id,lineage_hash,schema_version,policy_version,relation,root_run_id,parent_run_id,
      child_run_id,requester_user_id,repository_id,parent_checkpoint_id,parent_checkpoint_hash,parent_base_commit_sha,
      seed_result_commit_sha,quote_id,quote_hash,consent_id,consent_hash,selection_hash,cost_microusd,tokens,time_seconds,
      lineage_json,created_at) VALUES(?,?,1,'engineer-hardening-lineage-v1','OPTIONAL_HARDENING','checkpoint-run',
      'checkpoint-run',?,'checkpoint-user','checkpoint-repo',?,?,?,?,?,?,?,?,?,1000000,100,60,'{}',?)`)
      .run(lineageId,lineageHash,childRun,fixture.checkpointId,fixture.checkpointHash,"a".repeat(40),"b".repeat(40),
        quoteId,quoteHash,consentId,consentHash,sha256("v27-selection"),at);
    db.query(`INSERT INTO hardening_start_operations(id,operation_hash,schema_version,policy_version,requester_user_id,
      child_run_id,expected_child_state_version,lineage_id,lineage_hash,idempotency_key,operation_json,created_at)
      VALUES(?,?,1,'engineer-hardening-start-operation-v1','checkpoint-user',?,0,?,?,'v27-start','{}',?)`)
      .run(operationId,operationHash,childRun,lineageId,lineageHash,at);
    db.query(`INSERT INTO hardening_seed_attestations(id,seed_attestation_hash,schema_version,policy_version,attestation_type,
      operation_id,operation_hash,root_run_id,parent_run_id,child_run_id,requester_user_id,repository_id,lineage_id,
      lineage_hash,parent_checkpoint_id,parent_checkpoint_hash,base_commit_sha,seed_result_commit_sha,seed_tree_hash,
      seed_diff_hash,image_digest,environment_digest,dependency_hash,attestation_json,statement_json,statement_hash,
      signature_algorithm,signature_key_id,signature,created_at)
      VALUES(?,?,1,'engineer-hardening-seed-attestation-v1','HARDENING_SEED_VERIFIED',?,?,'checkpoint-run','checkpoint-run',?,
      'checkpoint-user','checkpoint-repo',?,?,?,?,?,?,?,?,?,?,?,'{}','{}',?,'test','key','signature',?)`)
      .run(seedId,seedHash,operationId,operationHash,childRun,lineageId,lineageHash,fixture.checkpointId,fixture.checkpointHash,
        "a".repeat(40),"b".repeat(40),sha256("v27-tree"),sha256("v27-seed-diff"),sha256("v27-image"),
        sha256("v27-seed-environment"),sha256("v27-dependencies"),sha256("v27-seed-statement"),at);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    const authority={parent_checkpoint_id:fixture.checkpointId,parent_checkpoint_hash:fixture.checkpointHash,
      hardening_lineage_id:lineageId,hardening_lineage_hash:lineageHash,seed_attestation_id:seedId,seed_attestation_hash:seedHash};
    const insert=(overrides:Record<string,string|null>={},jsonOverrides:Record<string,unknown>={})=>{
      const a={...authority,...overrides};const checkpointJson=canonicalJson({schemaVersion:2,
        policyVersion:"verified-hardening-candidate-checkpoint-v2",parentCheckpointId:a.parent_checkpoint_id,
        parentCheckpointHash:a.parent_checkpoint_hash,hardeningLineageId:a.hardening_lineage_id,
        hardeningLineageHash:a.hardening_lineage_hash,seedAttestationId:a.seed_attestation_id,
        seedAttestationHash:a.seed_attestation_hash,...jsonOverrides});
      return db.query(`INSERT INTO verified_candidate_checkpoints(id,checkpoint_hash,parent_checkpoint_id,
        parent_checkpoint_hash,hardening_lineage_id,hardening_lineage_hash,seed_attestation_id,seed_attestation_hash,
        run_id,requester_user_id,repository_id,required_lane_contract_hash,manifest_hash,base_commit_sha,result_commit_sha,
        diff_hash,reviewer_session_id,classification_hash,classification_result,evidence_bundle_id,evidence_bundle_hash,
        environment_digest,checkpoint_json,statement_json,statement_hash,signature_algorithm,signature_key_id,signature,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,'checkpoint-user','checkpoint-repo',?,?,?,?,?,'v27-child-reviewer',?,'READY',
        'v27-child-bundle',?,?,?,'{}',?,'test','key','signature',?)`).run(sha256("v27-child-checkpoint-id"),
          sha256("v27-child-checkpoint-hash"),a.parent_checkpoint_id,a.parent_checkpoint_hash,a.hardening_lineage_id,
          a.hardening_lineage_hash,a.seed_attestation_id,a.seed_attestation_hash,childRun,childContractHash,childManifestHash,
          "a".repeat(40),"c".repeat(40),childDiffHash,childClassificationHash,childBundleHash,sha256("v27-environment"),
          checkpointJson,sha256("v27-child-statement"),at);
    };
    expect(()=>insert({parent_checkpoint_hash:null})).toThrow();
    expect(()=>insert({parent_checkpoint_hash:sha256("wrong-parent")})).toThrow("FOREIGN KEY");
    expect(()=>insert({hardening_lineage_hash:sha256("wrong-lineage")})).toThrow("FOREIGN KEY");
    expect(()=>insert({seed_attestation_hash:sha256("wrong-seed")})).toThrow("FOREIGN KEY");
    expect(()=>insert({}, {seedAttestationHash:sha256("projection-tamper")})).toThrow("version binding mismatch");
    insert();
    expect(db.query(`SELECT parent_checkpoint_id,parent_checkpoint_hash,hardening_lineage_id,hardening_lineage_hash,
      seed_attestation_id,seed_attestation_hash FROM verified_candidate_checkpoints WHERE run_id=?`).get(childRun)).toEqual(authority);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);db.close();
  });

  test("installs exact v28 start fences and paid-call slots and rejects counterfeit recovery authority", () => {
    const root=mkdtempSync(join(tmpdir(),"zintus-engineer-v28-fencing-"));const dbPath=join(root,"engineer.sqlite");
    new EngineerLedger(dbPath).close();const db=new Database(dbPath);expect(db.query("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({version:32});
    for(const name of ["hardening_start_claims","hardening_model_call_slots","require_hardening_start_claim_binding_v28",
      "fence_hardening_start_claim_update_v28","require_hardening_model_call_slot_child_v28","fence_hardening_model_call_slot_update_v28"]){
      expect(db.query("SELECT name FROM sqlite_master WHERE name=?").get(name)).toEqual({name});}
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);db.exec("DROP TRIGGER fence_hardening_start_claim_update_v28");
    db.exec("CREATE TRIGGER fence_hardening_start_claim_update_v28 BEFORE UPDATE ON hardening_start_claims BEGIN SELECT 1; END;");db.close();
    expect(()=>new EngineerLedger(dbPath)).toThrow("schema v28 has invalid fence_hardening_start_claim_update_v28");
    rmSync(root,{recursive:true,force:true});
  });

  test("v30 forward-installs paid-call finalization authority for an already-recorded draft v29", () => {
    const timestamp="2026-07-18T12:00:00.000Z";
    const db=new Database(":memory:");db.exec("PRAGMA foreign_keys=ON");db.exec(ENGINEER_DATABASE_SCHEMA_SQL);
    db.query("INSERT INTO schema_migrations(version,applied_at) VALUES(14,?)").run(timestamp);
    migrateEngineerDatabase(db,timestamp);
    db.exec(`
      DELETE FROM schema_migrations WHERE version=32;
      ALTER TABLE failure_records DROP COLUMN underlying_cause;
      DELETE FROM schema_migrations WHERE version=31;
      DROP TRIGGER freeze_source_hardening_lineage_v31;
      DROP TRIGGER freeze_source_builder_dispatch_v31;
      DROP TRIGGER freeze_source_git_operation_v31;
      DROP TRIGGER freeze_source_approval_decision_v31;
      DROP TRIGGER freeze_source_approval_request_v31;
      DROP TRIGGER freeze_source_budget_event_v31;
      DROP TRIGGER freeze_source_run_state_event_v31;
      DROP TRIGGER freeze_source_engineer_run_update_v31;
      DROP TABLE resolution_replacements;
      DROP TABLE resolution_events;
      DROP TABLE resolution_directives;
      DROP TABLE resolution_cases;
      DELETE FROM schema_migrations WHERE version=30;
      DROP TRIGGER prevent_hardening_recovery_worker_fence_delete_v30;
      DROP TRIGGER fence_hardening_recovery_worker_fence_update_v30;
      DROP TRIGGER require_hardening_recovery_worker_fence_child_v30;
      DROP INDEX idx_hardening_recovery_worker_fence_generation_v30;
      DROP TABLE hardening_recovery_worker_fences;
      DROP TRIGGER prevent_hardening_paid_call_finalization_delete_v29;
      DROP TRIGGER fence_hardening_paid_call_finalization_update_v29;
      DROP TRIGGER require_hardening_paid_call_finalization_binding_v29;
      DROP INDEX idx_hardening_paid_call_finalization_status_v29;
      DROP TABLE hardening_paid_call_finalizations;
    `);
    expect(db.query("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({version:29});
    migrateEngineerDatabase(db,timestamp);
    expect(db.query("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({version:32});
    for(const name of ["hardening_paid_call_finalizations","idx_hardening_paid_call_finalization_status_v29",
      "require_hardening_paid_call_finalization_binding_v29","fence_hardening_paid_call_finalization_update_v29",
      "prevent_hardening_paid_call_finalization_delete_v29","hardening_recovery_worker_fences",
      "idx_hardening_recovery_worker_fence_generation_v30","require_hardening_recovery_worker_fence_child_v30",
      "fence_hardening_recovery_worker_fence_update_v30","prevent_hardening_recovery_worker_fence_delete_v30"]){
      expect(db.query("SELECT name FROM sqlite_master WHERE name=?").get(name)).toEqual({name});
    }
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    db.exec("DELETE FROM schema_migrations WHERE version=29");
    expect(()=>migrateEngineerDatabase(db,timestamp)).toThrow("v30 is missing required migration ancestry");
    db.close();
  });

  test("rejects v23 ancestry gaps and counterfeit exact index or trigger bodies", () => {
    const timestamp = "2026-07-18T12:00:00.000Z";
    const gap = new Database(":memory:");
    gap.exec(ENGINEER_DATABASE_SCHEMA_SQL);
    for (const version of [14, 15, 16, 17, 18, 19, 20, 21, 23]) gap.query("INSERT INTO schema_migrations(version,applied_at) VALUES (?,?)").run(version, timestamp);
    const before = gap.query("SELECT version,applied_at FROM schema_migrations ORDER BY version").all();
    expect(() => migrateEngineerDatabase(gap)).toThrow("v23 is missing required migration ancestry");
    expect(gap.query("SELECT version,applied_at FROM schema_migrations ORDER BY version").all()).toEqual(before);
    gap.close();

    for (const mutation of [
      "DROP TRIGGER require_publication_selection_binding_v23; CREATE TRIGGER require_publication_selection_binding_v23 BEFORE INSERT ON publication_candidate_selections BEGIN SELECT 1; END;",
      "DROP INDEX idx_publication_selection_root_revision_v23; CREATE INDEX idx_publication_selection_root_revision_v23 ON publication_candidate_selections(candidate_run_id);",
    ]) {
      const db = new Database(":memory:");
      db.exec("PRAGMA foreign_keys=ON"); db.exec(ENGINEER_DATABASE_SCHEMA_SQL);
      db.query("INSERT INTO schema_migrations(version,applied_at) VALUES (14,?)").run(timestamp);
      migrateEngineerDatabase(db, timestamp); db.exec(mutation);
      expect(() => migrateEngineerDatabase(db, timestamp)).toThrow(/invalid (trigger|index)/);
      db.close();
    }
    const historical = [
      ENGINEER_DATABASE_MIGRATION_15_SQL, ENGINEER_DATABASE_MIGRATION_16_SQL,
      ENGINEER_DATABASE_MIGRATION_17_SQL, ENGINEER_DATABASE_MIGRATION_18_SQL,
      ENGINEER_DATABASE_MIGRATION_19_SQL, ENGINEER_DATABASE_MIGRATION_20_SQL,
      ENGINEER_DATABASE_MIGRATION_21_SQL, ENGINEER_DATABASE_MIGRATION_22_SQL,
    ];
    for (const counterfeit of [
      ENGINEER_DATABASE_MIGRATION_23_SQL.replace(
        "selection_hash TEXT NOT NULL UNIQUE CHECK(length(selection_hash)=71 AND substr(selection_hash,1,7)='sha256:' AND substr(selection_hash,8) NOT GLOB '*[^0-9a-f]*'),",
        "selection_hash TEXT NOT NULL UNIQUE,",
      ),
      ENGINEER_DATABASE_MIGRATION_23_SQL.replace(
        "statement_hash TEXT NOT NULL CHECK(length(statement_hash)=71 AND substr(statement_hash,1,7)='sha256:' AND substr(statement_hash,8) NOT GLOB '*[^0-9a-f]*'),",
        "statement_hash TEXT NOT NULL,",
      ),
    ]) {
      const db = new Database(":memory:");
      db.exec("PRAGMA foreign_keys=ON"); db.exec(ENGINEER_DATABASE_SCHEMA_SQL);
      db.query("INSERT INTO schema_migrations(version,applied_at) VALUES (14,?)").run(timestamp);
      historical.forEach((sql, index) => {
        db.exec(sql);
        db.query("INSERT INTO schema_migrations(version,applied_at) VALUES (?,?)").run(index + 15, timestamp);
      });
      db.exec(counterfeit);
      db.query("INSERT INTO schema_migrations(version,applied_at) VALUES (23,?)").run(timestamp);
      expect(() => migrateEngineerDatabase(db, timestamp)).toThrow("invalid table");
      db.close();
    }
    expect(ENGINEER_DATABASE_MIGRATION_23_SQL).not.toContain("INSERT INTO advisory_backlog_items");
  });

  test("binds approval to the latest supplied publication selection and detects relational JSON drift", () => {
    const fixture = checkpointBindingFixture("READY");
    insertCheckpointFixture(fixture, "READY");
    const first = insertParentPublicationSelection(fixture, 1, null);
    const second = insertParentPublicationSelection(fixture, 2, first.selectionId);
    const insertApproval = (id: string, selectionId: string | null, selectionHash: string | null) => fixture.db.query(`INSERT INTO approval_requests
      (id,run_id,risk_tier,assigned_reviewer_id,requested_at,deadline_at,reminder_schedule_json,timeout_action,
       manifest_hash,diff_hash,evidence_bundle_hash,status,reviewer_session_id,classification_hash,classification_result,
       verified_checkpoint_id,verified_checkpoint_hash,publication_selection_id,publication_selection_hash)
      VALUES (?,'checkpoint-run','LOW',NULL,?,?,'[]','PAUSE',?,?,?,'PENDING','checkpoint-reviewer',?,'READY',?,?,?,?)`).run(
        id, fixture.at, fixture.at, fixture.manifestHash, sha256("diff"), fixture.evidenceBundleHash,
        fixture.classificationHash, fixture.checkpointId, fixture.checkpointHash, selectionId, selectionHash,
      );
    expect(() => insertApproval("stale-selection", first.selectionId, first.selectionHash)).toThrow("selection binding mismatch");
    expect(insertApproval("latest-selection", second.selectionId, second.selectionHash).changes).toBe(1);
    expect(() => insertApproval("half-selection", second.selectionId, null)).toThrow("selection binding mismatch");

    fixture.db.exec(`
      DROP TRIGGER prevent_publication_candidate_selections_update_v23;
      UPDATE publication_candidate_selections SET actor_id='counterfeit-actor' WHERE id='${second.selectionId}';
      CREATE TRIGGER prevent_publication_candidate_selections_update_v23 BEFORE UPDATE ON publication_candidate_selections BEGIN SELECT RAISE(ABORT,'publication candidate selections are immutable'); END;
    `);
    expect(() => migrateEngineerDatabase(fixture.db, fixture.at)).toThrow("actor_id projection mismatch");
    fixture.db.close();
  });

  test("persists and rehydrates the complete actionable advisory hardening authority graph", async () => {
    const fixture = checkpointBindingFixture("READY_WITH_ADVISORIES", {}, true);
    insertCheckpointFixture(fixture, "READY_WITH_ADVISORIES");
    const advisory = createAdvisoryBacklogItem({
      schemaVersion: 1, policyVersion: "engineer-advisory-backlog-v1", parentRunId: "checkpoint-run",
      requesterUserId: "checkpoint-user", repositoryId: "checkpoint-repo",
      parentCheckpointId: fixture.checkpointId, parentCheckpointHash: fixture.checkpointHash,
      requiredLaneContractHash: fixture.contractHash, classificationHash: fixture.classificationHash,
      reviewerSessionId: "checkpoint-reviewer", findingId: "checkpoint-finding",
      findingFingerprint: sha256("checkpoint-finding-fingerprint"),
      sourceClassificationHash: sha256("checkpoint-source-classification"), disposition: "ADVISORY",
      reasonCode: "OUTSIDE_FROZEN_REQUIRED_SCOPE", authority: "NONE", reportedSeverity: "MEDIUM",
      category: "hardening", description: "Optional improvement", requiredChange: "Add defense",
      file: "src/index.ts", lineStart: 1, lineEnd: 2, criterionIds: ["must"], evidenceIds: ["evidence"],
      actionability: "ACTIONABLE", createdAt: fixture.at,
    }, fixture.manifest);
    fixture.db.query(`INSERT INTO advisory_backlog_items
      (id,advisory_hash,schema_version,policy_version,parent_run_id,requester_user_id,repository_id,
       parent_checkpoint_id,parent_checkpoint_hash,required_lane_contract_hash,classification_hash,
       reviewer_session_id,finding_id,finding_fingerprint,source_classification_hash,reported_severity,
       reason_code,category,file,line_start,line_end,actionability,item_json,created_at)
      VALUES (?,?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        advisory.advisoryId, advisory.advisoryHash, advisory.policyVersion, advisory.parentRunId,
        advisory.requesterUserId, advisory.repositoryId, advisory.parentCheckpointId, advisory.parentCheckpointHash,
        advisory.requiredLaneContractHash, advisory.classificationHash, advisory.reviewerSessionId,
        advisory.findingId, advisory.findingFingerprint, advisory.sourceClassificationHash,
        advisory.reportedSeverity, advisory.reasonCode, advisory.category, advisory.file, advisory.lineStart, advisory.lineEnd,
        advisory.actionability, canonicalJson(advisory), advisory.createdAt,
      );

    const quote = createHardeningQuote({
      schemaVersion: 1, policyVersion: "engineer-hardening-estimate-v1",
      estimatorVersion: "deterministic-hardening-estimator-v1", parentRunId: "checkpoint-run",
      requesterUserId: "checkpoint-user", repositoryId: "checkpoint-repo",
      parentCheckpointId: fixture.checkpointId, parentCheckpointHash: fixture.checkpointHash,
      parentStateVersion: 1, advisoryIds: [advisory.advisoryId], selectionHash: sha256([advisory.advisoryId]),
      routingPolicyVersion: "engineer-model-routing-v2", pricingVersion: "openai-gpt56-pricing-2026-07-14",
      estimate: { maxCostMicrousd: 500_000, maxTokens: 20_000, maxTimeSeconds: 600,
        maxPlannerCalls: 0, maxBuilderCalls: 1, maxReviewerCalls: 1, automaticRepairCalls: 0 },
      assumptions: ["ESTIMATE_IS_HARD_CAP", "NO_AUTOMATIC_REPAIR", "NO_PARENT_BUDGET_TRANSFER"],
      createdAt: fixture.at, expiresAt: "2026-07-17T12:15:00.000Z",
    }, [advisory]);
    fixture.db.exec("BEGIN IMMEDIATE");
    fixture.db.query("INSERT INTO hardening_quote_advisories(quote_id,ordinal,advisory_id) VALUES (?,0,?)")
      .run(quote.quoteId, advisory.advisoryId);
    fixture.db.query(`INSERT INTO hardening_quotes
      (id,quote_hash,schema_version,policy_version,estimator_version,parent_run_id,requester_user_id,
       repository_id,parent_checkpoint_id,parent_checkpoint_hash,parent_state_version,selection_hash,advisory_count,
       routing_policy_version,pricing_version,max_cost_microusd,max_tokens,max_time_seconds,
       max_planner_calls,max_builder_calls,max_reviewer_calls,automatic_repair_calls,quote_json,created_at,expires_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        quote.quoteId, quote.quoteHash, quote.schemaVersion, quote.policyVersion, quote.estimatorVersion, quote.parentRunId,
        quote.requesterUserId, quote.repositoryId, quote.parentCheckpointId, quote.parentCheckpointHash,
        quote.parentStateVersion, quote.selectionHash, quote.advisoryIds.length, quote.routingPolicyVersion, quote.pricingVersion,
        quote.estimate.maxCostMicrousd, quote.estimate.maxTokens, quote.estimate.maxTimeSeconds,
        quote.estimate.maxPlannerCalls, quote.estimate.maxBuilderCalls, quote.estimate.maxReviewerCalls,
        quote.estimate.automaticRepairCalls, canonicalJson(quote), quote.createdAt, quote.expiresAt,
      );
    fixture.db.exec("COMMIT");

    const consent = createHardeningConsent({
      schemaVersion: 1, policyVersion: "engineer-hardening-consent-v1", quoteId: quote.quoteId,
      quoteHash: quote.quoteHash, parentRunId: quote.parentRunId, parentCheckpointId: quote.parentCheckpointId,
      parentCheckpointHash: quote.parentCheckpointHash, parentStateVersion: quote.parentStateVersion,
      selectionHash: quote.selectionHash, requesterUserId: quote.requesterUserId, actorId: quote.requesterUserId,
      authorizedBudget: { costMicrousd: 400_000, tokens: 15_000, timeSeconds: 500 },
      acknowledgements: { separateRun: true, parentCandidateUnchanged: true, noAutomaticRepair: true, noOverages: true },
      idempotencyKey: "consent-op", acceptedAt: "2026-07-17T12:10:00.000Z", quoteExpiresAt: quote.expiresAt,
    }, quote);
    const insertConsent = (acceptedAt = consent.acceptedAt) => fixture.db.query(`INSERT INTO hardening_consents
      (id,consent_hash,schema_version,policy_version,quote_id,quote_hash,parent_run_id,parent_checkpoint_id,
       parent_checkpoint_hash,parent_state_version,selection_hash,requester_user_id,actor_id,cost_microusd,tokens,
       time_seconds,acknowledge_separate_run,acknowledge_parent_unchanged,acknowledge_no_automatic_repair,
       acknowledge_no_overages,idempotency_key,consent_json,accepted_at,quote_expires_at)
      VALUES (?,?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,1,1,1,1,?,?,?,?)`).run(
        consent.consentId, consent.consentHash, consent.policyVersion, consent.quoteId, consent.quoteHash,
        consent.parentRunId, consent.parentCheckpointId, consent.parentCheckpointHash, consent.parentStateVersion,
        consent.selectionHash, consent.requesterUserId, consent.actorId, consent.authorizedBudget.costMicrousd,
        consent.authorizedBudget.tokens, consent.authorizedBudget.timeSeconds, consent.idempotencyKey,
        canonicalJson(consent), acceptedAt, consent.quoteExpiresAt,
      );
    expect(() => insertConsent("2026-07-17T11:59:59.999Z")).toThrow("hardening consent quote binding mismatch");
    fixture.db.query("UPDATE engineer_runs SET state_version=2 WHERE id='checkpoint-run'").run();
    expect(insertConsent).toThrow("hardening consent quote binding mismatch");
    fixture.db.query("UPDATE engineer_runs SET state_version=1 WHERE id='checkpoint-run'").run();
    expect(insertConsent().changes).toBe(1);

    const childRunId = hardeningChildRunId(consent.consentHash);
    const childAt = "2026-07-17T12:11:00.000Z";
    const childManifestContent: TaskManifestContent = { ...fixture.manifest, runId: childRunId,
      request: { original: "optional hardening", normalized: "optional hardening" }, createdAt: childAt };
    delete (childManifestContent as Partial<TaskManifestContent> & { manifestHash?: string }).manifestHash;
    const childManifest = TaskManifestSchema.parse({ ...childManifestContent, manifestHash: sha256(childManifestContent) });
    const childContractHash = sha256("child-contract");
    const childClassificationHash = sha256("child-classification");
    const childDiffHash = sha256("child-diff");
    const childCheckpointId = sha256("child-checkpoint-id");
    const childCheckpointHash = sha256("child-checkpoint-hash");
    fixture.db.query(`INSERT INTO engineer_runs
      (id,user_id,repository_id,base_branch,base_commit_sha,request_original,request_normalized,state,state_version,
       manifest_hash,risk_tier,human_gate_required,created_at,updated_at)
      VALUES (?,'checkpoint-user','checkpoint-repo','main',?,'optional hardening','optional hardening','REVIEW_APPROVED',1,?,'LOW',1,?,?)`)
      .run(childRunId, "a".repeat(40), childManifest.manifestHash, childAt, childAt);
    fixture.db.query("INSERT INTO task_manifest_versions(id,run_id,version,manifest_hash,manifest_json,created_at) VALUES (?,?,1,?,?,?)")
      .run("child-manifest-id", childRunId, childManifest.manifestHash, canonicalJson(childManifest), childAt);
    fixture.db.query("INSERT INTO required_lane_contracts(contract_hash,run_id,manifest_hash,schema_version,contract_json,created_at) VALUES (?,?,?,2,'{}',?)")
      .run(childContractHash, childRunId, childManifest.manifestHash, childAt);
    fixture.db.query("INSERT INTO artifacts(id,run_id,type,sha256,producer_type,producer_id,storage_reference,size_bytes,trusted,created_at) VALUES ('child-raw',?,'REVIEWER_RAW_OUTPUT',?,'SYSTEM','reviewer','/tmp/child',1,1,?)")
      .run(childRunId, sha256("child-raw"), childAt);
    fixture.db.query(`INSERT INTO reviewer_sessions
      (id,run_id,attempt,model_tier,resolved_model,input_hash,manifest_hash,diff_hash,evidence_bundle_hash,policy_version,
       cache_key,cache_hit,cache_observed,started_at,completed_at,decision,isolation_verified)
      VALUES ('child-reviewer',?,1,'GPT-5.6_SOL','gpt-5.6',?,?,?,?, 'review-v1',?,0,1,?,?,'APPROVE',1)`)
      .run(childRunId, sha256("child-input"), childManifest.manifestHash, childDiffHash, sha256("child-input-evidence"), sha256("child-cache"), childAt, childAt);
    fixture.db.query(`INSERT INTO review_classification_batches
      (classification_hash,reviewer_session_id,run_id,contract_hash,schema_version,policy_version,raw_output_artifact_id,
       raw_output_hash,normalized_output_hash,normalized_session_hash,normalized_findings_hash,reviewer_input_json,
       normalized_output_json,batch_json,created_at)
      VALUES (?,'child-reviewer',?,?,1,'mapping-v1','child-raw',?,?,?,?, '{}','{}',?,?)`).run(
        childClassificationHash, childRunId, childContractHash, sha256("child-raw"), sha256("child-normalized"),
        sha256("child-session"), sha256("child-findings"), JSON.stringify({ result: "READY" }), childAt,
      );
    const childBundleHash = sha256("child-bundle");
    const childEnvironment = sha256("child-environment");
    fixture.db.query(`INSERT INTO evidence_bundles
      (id,run_id,manifest_hash,bundle_hash,base_commit_sha,result_commit_sha,environment_digest,manifest_json,final_decision,created_at)
      VALUES ('child-bundle',?,?,?,?,?,?,?,'APPROVE',?)`).run(
        childRunId, childManifest.manifestHash, childBundleHash, "a".repeat(40), "c".repeat(40), childEnvironment,
        JSON.stringify({ bundleVersion: 2, reviewerSessionId: "child-reviewer", classificationHash: childClassificationHash, classificationResult: "READY" }), childAt,
      );
    fixture.db.query(`INSERT INTO verified_candidate_checkpoints
      (id,checkpoint_hash,parent_checkpoint_id,run_id,requester_user_id,repository_id,required_lane_contract_hash,
       manifest_hash,base_commit_sha,result_commit_sha,diff_hash,reviewer_session_id,classification_hash,
       classification_result,evidence_bundle_id,evidence_bundle_hash,environment_digest,checkpoint_json,
       statement_json,statement_hash,signature_algorithm,signature_key_id,signature,created_at)
      VALUES (?,?,NULL,?,'checkpoint-user','checkpoint-repo',?,?,?,?,?,'child-reviewer',?,'READY','child-bundle',?,?,?,'{}',?,'test','key','signature',?)`).run(
        childCheckpointId, childCheckpointHash, childRunId, childContractHash, childManifest.manifestHash,
        "a".repeat(40), "c".repeat(40), childDiffHash, childClassificationHash, childBundleHash,
        childEnvironment, canonicalJson({schemaVersion:1,policyVersion:"verified-candidate-checkpoint-v1",parentCheckpointId:null}),
        sha256("child-statement"), childAt,
      );

    const lineage = createEngineerRunLineage({
      schemaVersion: 1, policyVersion: "engineer-hardening-lineage-v1", relation: "OPTIONAL_HARDENING",
      rootRunId: "checkpoint-run", parentRunId: "checkpoint-run", childRunId,
      requesterUserId: "checkpoint-user", repositoryId: "checkpoint-repo",
      parentCheckpointId: fixture.checkpointId, parentCheckpointHash: fixture.checkpointHash,
      parentBaseCommitSha: "a".repeat(40), seedResultCommitSha: "b".repeat(40), quoteId: quote.quoteId,
      quoteHash: quote.quoteHash, consentId: consent.consentId, consentHash: consent.consentHash,
      selectionHash: quote.selectionHash, budget: consent.authorizedBudget, createdAt: childAt,
    });
    fixture.db.query(`INSERT INTO engineer_run_lineage
      (id,lineage_hash,schema_version,policy_version,relation,root_run_id,parent_run_id,child_run_id,requester_user_id,
       repository_id,parent_checkpoint_id,parent_checkpoint_hash,parent_base_commit_sha,seed_result_commit_sha,
       quote_id,quote_hash,consent_id,consent_hash,selection_hash,cost_microusd,tokens,time_seconds,lineage_json,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        lineage.lineageId, lineage.lineageHash, lineage.schemaVersion, lineage.policyVersion, lineage.relation, lineage.rootRunId,
        lineage.parentRunId, lineage.childRunId, lineage.requesterUserId, lineage.repositoryId,
        lineage.parentCheckpointId, lineage.parentCheckpointHash, lineage.parentBaseCommitSha,
        lineage.seedResultCommitSha, lineage.quoteId, lineage.quoteHash, lineage.consentId, lineage.consentHash,
        lineage.selectionHash, lineage.budget.costMicrousd, lineage.budget.tokens, lineage.budget.timeSeconds,
        canonicalJson(lineage), lineage.createdAt,
      );

    const signer = {
      algorithm: "HMAC-SHA256", keyId: "test-key",
      sign(payload: Uint8Array) { return createHmac("sha256", "test-only-key").update(payload).digest("hex"); },
      verify(payload: Uint8Array, signature: string) {
        const expected = Buffer.from(this.sign(payload), "hex"); const actual = Buffer.from(signature, "hex");
        return expected.length === actual.length && timingSafeEqual(expected, actual);
      },
    };
    const signed = await createSignedCandidateLineageAttestation({
      schemaVersion: 1, policyVersion: "engineer-candidate-lineage-v1", relation: "OPTIONAL_HARDENING",
      lineageId: lineage.lineageId, lineageHash: lineage.lineageHash, rootRunId: lineage.rootRunId,
      parentRunId: lineage.parentRunId, childRunId, requesterUserId: lineage.requesterUserId,
      repositoryId: lineage.repositoryId, parentCheckpointId: fixture.checkpointId,
      parentCheckpointHash: fixture.checkpointHash, parentResultCommitSha: "b".repeat(40),
      childCheckpointId, childCheckpointHash, childResultCommitSha: "c".repeat(40),
      parentBaseCommitSha: "a".repeat(40), selectionHash: quote.selectionHash,
      quoteHash: quote.quoteHash, consentHash: consent.consentHash, createdAt: childAt,
    }, signer);
    const attestation = signed.attestation;
    fixture.db.query(`INSERT INTO candidate_lineage_attestations
      (lineage_attestation_id,lineage_attestation_hash,schema_version,policy_version,relation,lineage_id,lineage_hash,root_run_id,parent_run_id,
       child_run_id,requester_user_id,repository_id,parent_checkpoint_id,parent_checkpoint_hash,parent_result_commit_sha,
       child_checkpoint_id,child_checkpoint_hash,child_result_commit_sha,parent_base_commit_sha,selection_hash,quote_hash,
       consent_hash,attestation_json,statement_json,statement_hash,signature_algorithm,signature_key_id,signature,created_at)
      VALUES (?,?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        attestation.lineageAttestationId, attestation.lineageAttestationHash, attestation.policyVersion, attestation.relation,
        attestation.lineageId, attestation.lineageHash, attestation.rootRunId, attestation.parentRunId,
        attestation.childRunId, attestation.requesterUserId, attestation.repositoryId, attestation.parentCheckpointId,
        attestation.parentCheckpointHash, attestation.parentResultCommitSha, attestation.childCheckpointId,
        attestation.childCheckpointHash, attestation.childResultCommitSha, attestation.parentBaseCommitSha,
        attestation.selectionHash, attestation.quoteHash, attestation.consentHash, canonicalJson(attestation),
        signed.statementJson, signed.statementHash, signed.algorithm, signed.keyId, signed.signature, attestation.createdAt,
      );
    expect(() => fixture.db.query(`INSERT INTO candidate_lineage_attestations
      (lineage_attestation_id,lineage_attestation_hash,schema_version,policy_version,relation,lineage_id,lineage_hash,
       root_run_id,parent_run_id,child_run_id,requester_user_id,repository_id,parent_checkpoint_id,parent_checkpoint_hash,
       parent_result_commit_sha,child_checkpoint_id,child_checkpoint_hash,child_result_commit_sha,parent_base_commit_sha,
       selection_hash,quote_hash,consent_hash,attestation_json,statement_json,statement_hash,signature_algorithm,
       signature_key_id,signature,created_at)
      SELECT ?,?,schema_version,policy_version,relation,lineage_id,lineage_hash,root_run_id,parent_run_id,child_run_id,
       requester_user_id,repository_id,child_checkpoint_id,child_checkpoint_hash,parent_result_commit_sha,
       child_checkpoint_id,child_checkpoint_hash,child_result_commit_sha,parent_base_commit_sha,selection_hash,quote_hash,
       consent_hash,attestation_json,statement_json,statement_hash,signature_algorithm,signature_key_id,signature,created_at
      FROM candidate_lineage_attestations WHERE lineage_attestation_id=?`).run(
        sha256("cross-checkpoint-id"), sha256("cross-checkpoint-hash"), attestation.lineageAttestationId,
      )).toThrow("candidate lineage binding mismatch");
    const selection = createPublicationCandidateSelection({
      schemaVersion: 1, policyVersion: "engineer-publication-selection-v1", rootRunId: "checkpoint-run",
      candidateRunId: childRunId, requesterUserId: "checkpoint-user", repositoryId: "checkpoint-repo",
      candidateKind: "HARDENED_CHILD", selectedCheckpointId: childCheckpointId,
      selectedCheckpointHash: childCheckpointHash, selectedResultCommitSha: "c".repeat(40),
      candidateLineageAttestationId: attestation.lineageAttestationId, candidateLineageAttestationHash: attestation.lineageAttestationHash,
      revision: 1, expectedRevision: 0, previousSelectionId: null, reasonCode: "USER_SELECTED_HARDENED_CHILD",
      actorId: "checkpoint-user", idempotencyKey: "child-selection", selectedAt: childAt,
    });
    fixture.db.query(`INSERT INTO publication_candidate_selections
      (id,selection_hash,schema_version,policy_version,root_run_id,candidate_run_id,requester_user_id,repository_id,
       candidate_kind,selected_checkpoint_id,selected_checkpoint_hash,selected_result_commit_sha,candidate_lineage_attestation_id,
       candidate_lineage_attestation_hash,revision,expected_revision,previous_selection_id,reason_code,actor_id,idempotency_key,selection_json,selected_at)
      VALUES (?,?,1,?,?,?,?,?,'HARDENED_CHILD',?,?,?,?,?,1,0,NULL,'USER_SELECTED_HARDENED_CHILD',?,?,?,?)`).run(
        selection.selectionId, selection.selectionHash, selection.policyVersion, selection.rootRunId,
        selection.candidateRunId, selection.requesterUserId, selection.repositoryId, selection.selectedCheckpointId,
        selection.selectedCheckpointHash, selection.selectedResultCommitSha, selection.candidateLineageAttestationId,
        selection.candidateLineageAttestationHash, selection.actorId, selection.idempotencyKey, canonicalJson(selection), selection.selectedAt,
      );

    const event = createAdvisoryBacklogEvent({
      schemaVersion: 1, policyVersion: "engineer-advisory-backlog-v1", advisoryId: advisory.advisoryId,
      parentRunId: "checkpoint-run", parentCheckpointId: fixture.checkpointId,
      parentCheckpointHash: fixture.checkpointHash, eventType: "SELECTED", revision: 1, expectedRevision: 0,
      actorType: "USER", actorId: "checkpoint-user", operationId: "select-op", idempotencyKey: "select-key",
      quoteId: quote.quoteId, consentId: null, hardeningLineageId: null, childRunId: null,
      childCheckpointId: null, childCheckpointHash: null, stopReason: null, rationale: null, createdAt: fixture.at,
    });
    fixture.db.query(`INSERT INTO advisory_backlog_events
      (id,event_hash,schema_version,policy_version,advisory_id,parent_run_id,parent_checkpoint_id,parent_checkpoint_hash,
       event_type,revision,expected_revision,actor_type,actor_id,operation_id,idempotency_key,quote_id,consent_id,
       hardening_lineage_id,child_run_id,child_checkpoint_id,child_checkpoint_hash,stop_reason,rationale,event_json,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        event.eventId, event.eventHash, event.schemaVersion, event.policyVersion, event.advisoryId, event.parentRunId,
        event.parentCheckpointId, event.parentCheckpointHash, event.eventType, event.revision, event.expectedRevision,
        event.actorType, event.actorId, event.operationId, event.idempotencyKey, event.quoteId, event.consentId,
        event.hardeningLineageId, event.childRunId, event.childCheckpointId, event.childCheckpointHash,
        event.stopReason, event.rationale, canonicalJson(event), event.createdAt,
      );
    expect(() => migrateEngineerDatabase(fixture.db, childAt)).not.toThrow();
    expect(fixture.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(fixture.db.query("SELECT COUNT(*) AS count FROM publication_candidate_selections").get()).toEqual({ count: 1 });
    fixture.db.close();
  });

  test("transactionally migrates a v14 database without rewriting legacy manifests", () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-engineer-schema-v15-"));
    const dbPath = join(root, "engineer.db");
    const legacy = new Database(dbPath, { create: true });
    legacy.exec(ENGINEER_DATABASE_SCHEMA_SQL);
    const timestamp = "2026-07-17T12:00:00.000Z";
    const legacyContent: TaskManifestContent = {
      manifestVersion: 1,
      runId: "run-legacy",
      repository: {
        repositoryId: "repository-legacy", provider: "local", owner: "local", name: "legacy",
        baseBranch: "main", baseCommitSha: "b".repeat(40),
      },
      request: { original: "legacy request", normalized: "legacy request" },
      acceptanceCriteria: [{
        criterionId: "legacy-criterion", statement: "Legacy behavior remains readable.",
        verificationMethod: "Read the historical manifest.", priority: "MUST",
      }],
      testPlan: [{
        testId: "legacy-test", criterionIds: ["legacy-criterion"], type: "UNIT",
        description: "Read legacy data.", command: "bun test",
      }],
      allowedPaths: ["src/**"], deniedPaths: [".env*"],
      allowedCommands: ["bun test"], prohibitedCommands: [],
      riskTier: "LOW", humanGateRequired: false,
      retryBudgets: {
        sameFailureAttempts: 2, builderRepairAttempts: 4, reviewerFixAttempts: 2,
        plannerRestarts: 1, sandboxProvisioningAttempts: 3, transientModelAttempts: 3,
      },
      timeBudgetSeconds: 600, tokenBudget: 10_000, costBudgetUsd: 1,
      createdAt: timestamp,
    };
    const legacyManifest = TaskManifestSchema.parse({ ...legacyContent, manifestHash: sha256(legacyContent) });
    const manifestHash = legacyManifest.manifestHash;
    const manifestJson = JSON.stringify(legacyManifest);
    legacy.query("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
      .run(ENGINEER_DATABASE_BASE_SCHEMA_VERSION, timestamp);
    legacy.query("INSERT INTO users(id, created_at, updated_at) VALUES (?, ?, ?)")
      .run("user-legacy", timestamp, timestamp);
    legacy.query(`INSERT INTO repository_connections
      (id, user_id, provider, owner, name, url, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`).run(
        "repository-legacy", "user-legacy", "local", "local", "legacy", timestamp, timestamp,
      );
    legacy.query(`INSERT INTO engineer_runs
      (id, user_id, repository_id, base_branch, base_commit_sha, request_original,
       request_normalized, state, state_version, manifest_hash, risk_tier,
       human_gate_required, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        "run-legacy", "user-legacy", "repository-legacy", "main", "b".repeat(40),
        "legacy request", "legacy request", "PLAN_FROZEN", 1, manifestHash,
        "LOW", 0, timestamp, timestamp,
      );
    legacy.query(`INSERT INTO task_manifest_versions
      (id, run_id, version, manifest_hash, manifest_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(
        "manifest-legacy", "run-legacy", 1, manifestHash, manifestJson, timestamp,
      );
    legacy.query(`INSERT INTO approval_requests
      (id, run_id, risk_tier, assigned_reviewer_id, requested_at, deadline_at,
       reminder_schedule_json, timeout_action, manifest_hash, diff_hash, evidence_bundle_hash, status)
      VALUES (?, ?, 'LOW', NULL, ?, ?, '[]', 'PAUSE', ?, ?, ?, 'PENDING')`)
      .run("approval-legacy", "run-legacy", timestamp, "2026-07-18T12:00:00.000Z", manifestHash, sha256("legacy-diff"), sha256("legacy-bundle"));
    legacy.query(`INSERT INTO git_operations
      (id, run_id, operation_type, requested_by, idempotency_key, expected_base_commit_sha,
       result_commit_sha, approval_id, evidence_bundle_hash, status, remote_reference, started_at,
       completed_at, error_code)
      VALUES (?, ?, 'INSPECT_BASE', 'SUPERVISOR', ?, ?, NULL, ?, ?, 'FAILED', NULL, ?, ?, 'LEGACY')`)
      .run("git-legacy", "run-legacy", "legacy-git", "b".repeat(40), "approval-legacy", sha256("legacy-bundle"), timestamp, timestamp);
    legacy.query(`INSERT INTO approval_decisions
      (id, approval_request_id, actor_id, decision, reason, decided_at)
      VALUES ('decision-legacy', 'approval-legacy', 'human-legacy', 'REJECT', 'legacy decision', ?)`)
      .run(timestamp);
    legacy.close();

    const ledger = new EngineerLedger(dbPath);
    expect(ledger.getManifest("run-legacy")).toEqual(legacyManifest);
    expect(ledger.getRequiredLaneContract("run-legacy")).toBeNull();
    expect(ledger.latestApprovalRequest("run-legacy")).toMatchObject({
      approvalRequestId: "approval-legacy", verifiedCheckpointId: null, verifiedCheckpointHash: null,
    });
    expect(ledger.listGitOperations("run-legacy")).toContainEqual(expect.objectContaining({
      gitOperationId: "git-legacy", verifiedCheckpointId: null, verifiedCheckpointHash: null,
    }));
    expect(ledger.exportRunRecords("run-legacy").approval_decisions?.[0]).toMatchObject({
      id: "decision-legacy", expected_verified_checkpoint_id: null, expected_verified_checkpoint_hash: null,
    });
    expect(ledger.exportRunRecords("run-legacy").task_manifest_versions?.[0]?.manifest_json)
      .toBe(manifestJson);
    ledger.close();

    const migrated = new Database(dbPath);
    expect(migrated.query("SELECT MAX(version) AS version FROM schema_migrations").get())
      .toEqual({ version: 32 });
    const approvalColumns = new Set((migrated.query("PRAGMA table_info(approval_requests)").all() as Array<{ name: string }>)
      .map((column) => column.name));
    expect(approvalColumns.has("reviewer_session_id")).toBe(true);
    expect(approvalColumns.has("classification_hash")).toBe(true);
    expect(approvalColumns.has("classification_result")).toBe(true);
    expect(approvalColumns.has("verified_checkpoint_id")).toBe(true);
    expect(approvalColumns.has("verified_checkpoint_hash")).toBe(true);
    expect(migrated.query("SELECT COUNT(*) AS count FROM verified_candidate_checkpoints").get()).toEqual({ count: 0 });
    expect(migrated.query("SELECT verified_checkpoint_id, verified_checkpoint_hash FROM approval_requests WHERE id = 'approval-legacy'").get())
      .toEqual({ verified_checkpoint_id: null, verified_checkpoint_hash: null });
    expect(migrated.query("SELECT verified_checkpoint_id, verified_checkpoint_hash FROM git_operations WHERE id = 'git-legacy'").get())
      .toEqual({ verified_checkpoint_id: null, verified_checkpoint_hash: null });
    expect(migrated.query(`SELECT expected_verified_checkpoint_id, expected_verified_checkpoint_hash
      FROM approval_decisions WHERE id = 'decision-legacy'`).get())
      .toEqual({ expected_verified_checkpoint_id: null, expected_verified_checkpoint_hash: null });
    expect(migrated.query("UPDATE approval_requests SET status = status WHERE id = 'approval-legacy'").run().changes).toBe(1);
    expect(() => migrated.query("UPDATE approval_requests SET verified_checkpoint_id = ? WHERE id = 'approval-legacy'")
      .run(sha256("missing-checkpoint"))).toThrow("immutable");
    expect(() => migrated.query("UPDATE approval_requests SET verified_checkpoint_id = ?, verified_checkpoint_hash = ? WHERE id = 'approval-legacy'")
      .run(sha256("missing-checkpoint"), sha256("missing-checkpoint-hash"))).toThrow("immutable");
    expect(() => migrated.query("UPDATE git_operations SET verified_checkpoint_hash = ? WHERE id = 'git-legacy'")
      .run(sha256("missing-checkpoint-hash"))).toThrow("immutable");
    expect(migrated.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'review_classification_batches'").get())
      .toEqual({ name: "review_classification_batches" });
    expect(migrated.query("PRAGMA table_info(required_lane_contracts)").all())
      .toContainEqual(expect.objectContaining({ name: "contract_hash", notnull: 1, pk: 1 }));
    expect(migrated.query("SELECT manifest_json FROM task_manifest_versions WHERE id = ?").get("manifest-legacy"))
      .toEqual({ manifest_json: manifestJson });
    expect(migrated.query("SELECT COUNT(*) AS count FROM required_lane_contracts").get())
      .toEqual({ count: 0 });
    expect(migrated.query("PRAGMA foreign_key_check").all()).toEqual([]);
    migrated.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("rolls back v15 and fails closed when a recorded schema is missing its table", () => {
    const blocked = new Database(":memory:");
    blocked.exec(ENGINEER_DATABASE_SCHEMA_SQL);
    blocked.query("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
      .run(14, "2026-07-17T12:00:00.000Z");
    blocked.exec("CREATE VIEW required_lane_contracts AS SELECT 1 AS invalid");
    expect(() => migrateEngineerDatabase(blocked, "2026-07-17T12:01:00.000Z")).toThrow();
    expect(blocked.query("SELECT MAX(version) AS version FROM schema_migrations").get())
      .toEqual({ version: 14 });
    blocked.close();

    const corrupt = new Database(":memory:");
    corrupt.exec(ENGINEER_DATABASE_SCHEMA_SQL);
    corrupt.query("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
      .run(14, "2026-07-17T11:59:00.000Z");
    corrupt.query("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
      .run(15, "2026-07-17T12:00:00.000Z");
    expect(() => migrateEngineerDatabase(corrupt)).toThrow("missing required_lane_contracts");
    corrupt.close();
  });

  test("rejects a database from a newer Engineer before applying local migrations", () => {
    const future = new Database(":memory:");
    future.exec(ENGINEER_DATABASE_SCHEMA_SQL);
    future.query("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
      .run(99, "2026-07-17T12:00:00.000Z");
    expect(() => migrateEngineerDatabase(future)).toThrow("newer than supported");
    expect(future.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'required_lane_contracts'").get())
      .toBeNull();
    future.close();
  });

  test("rejects recorded v15 history that omits the required v14 base", () => {
    for (const versions of [[15], [13, 15]]) {
      const gap = new Database(":memory:");
      gap.exec(ENGINEER_DATABASE_SCHEMA_SQL);
      gap.exec(`CREATE TABLE required_lane_contracts (
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
      CREATE INDEX idx_required_lane_contracts_run ON required_lane_contracts(run_id, created_at);`);
      for (const version of versions) {
        gap.query("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
          .run(version, "2026-07-17T12:00:00.000Z");
      }
      expect(() => migrateEngineerDatabase(gap)).toThrow("missing required v14 migration ancestry");
      gap.close();
    }
  });

  test("rejects recorded v16 history that omits any required ancestor without mutation", () => {
    for (const versions of [[16], [14, 16], [13, 15, 16]]) {
      const gap = new Database(":memory:");
      gap.exec(ENGINEER_DATABASE_SCHEMA_SQL);
      for (const version of versions) {
        gap.query("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
          .run(version, "2026-07-17T12:00:00.000Z");
      }
      const before = gap.query("SELECT version, applied_at FROM schema_migrations ORDER BY version").all();
      expect(() => migrateEngineerDatabase(gap)).toThrow("missing required");
      expect(gap.query("SELECT version, applied_at FROM schema_migrations ORDER BY version").all()).toEqual(before);
      expect(gap.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'required_lane_contracts'").get())
        .toBeNull();
      gap.close();
    }
  });

  test("rejects recorded v17 history that omits any required ancestor without mutation", () => {
    for (const versions of [[17], [14, 15, 17], [14, 16, 17]]) {
      const gap = new Database(":memory:");
      gap.exec(ENGINEER_DATABASE_SCHEMA_SQL);
      for (const version of versions) {
        gap.query("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
          .run(version, "2026-07-17T12:00:00.000Z");
      }
      const before = gap.query("SELECT version, applied_at FROM schema_migrations ORDER BY version").all();
      expect(() => migrateEngineerDatabase(gap)).toThrow("missing required");
      expect(gap.query("SELECT version, applied_at FROM schema_migrations ORDER BY version").all()).toEqual(before);
      gap.close();
    }
  });

  test("rejects recorded v18 history that omits any required ancestor without mutation", () => {
    for (const versions of [[18], [14, 15, 16, 18], [14, 15, 17, 18]]) {
      const gap = new Database(":memory:");
      gap.exec(ENGINEER_DATABASE_SCHEMA_SQL);
      for (const version of versions) {
        gap.query("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
          .run(version, "2026-07-17T12:00:00.000Z");
      }
      const before = gap.query("SELECT version, applied_at FROM schema_migrations ORDER BY version").all();
      expect(() => migrateEngineerDatabase(gap)).toThrow("missing required migration ancestry");
      expect(gap.query("SELECT version, applied_at FROM schema_migrations ORDER BY version").all()).toEqual(before);
      gap.close();
    }
  });

  test("rejects recorded v19 history without complete ancestry or its exact approval binding shape", () => {
    for (const versions of [[19], [14, 15, 16, 17, 19]]) {
      const gap = new Database(":memory:");
      gap.exec(ENGINEER_DATABASE_SCHEMA_SQL);
      for (const version of versions) gap.query("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
        .run(version, "2026-07-17T12:00:00.000Z");
      expect(() => migrateEngineerDatabase(gap)).toThrow("missing required migration ancestry");
      gap.close();
    }
  });

  test("rejects recorded v20 history without complete ancestry or an exact immutable dispatch-claim shape", () => {
    for (const versions of [[20], [14, 15, 16, 17, 18, 20]]) {
      const gap = new Database(":memory:");
      gap.exec(ENGINEER_DATABASE_SCHEMA_SQL);
      for (const version of versions) gap.query("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
        .run(version, "2026-07-17T12:00:00.000Z");
      expect(() => migrateEngineerDatabase(gap)).toThrow("missing required migration ancestry");
      gap.close();
    }

    const root = mkdtempSync(join(tmpdir(), "zintus-engineer-counterfeit-v20-"));
    const dbPath = join(root, "engineer.db");
    const ledger = new EngineerLedger(dbPath);
    ledger.close();
    const counterfeit = new Database(dbPath);
    counterfeit.exec("DROP TRIGGER prevent_builder_dispatch_claims_update_v20");
    counterfeit.exec(`CREATE TRIGGER prevent_builder_dispatch_claims_update_v20
      BEFORE UPDATE ON builder_dispatch_claims BEGIN SELECT 1; END;`);
    expect(() => migrateEngineerDatabase(counterfeit)).toThrow("invalid immutable trigger");
    counterfeit.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("rejects recorded v21 history without complete ancestry or its exact immutable checkpoint shape", () => {
    for (const versions of [[21], [14, 15, 16, 17, 18, 19, 21]]) {
      const gap = new Database(":memory:");
      gap.exec(ENGINEER_DATABASE_SCHEMA_SQL);
      for (const version of versions) gap.query("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
        .run(version, "2026-07-17T12:00:00.000Z");
      expect(() => migrateEngineerDatabase(gap)).toThrow("missing required migration ancestry");
      gap.close();
    }

    const root = mkdtempSync(join(tmpdir(), "zintus-engineer-counterfeit-v21-"));
    const dbPath = join(root, "engineer.db");
    const ledger = new EngineerLedger(dbPath);
    ledger.close();
    const counterfeit = new Database(dbPath);
    counterfeit.exec("DROP TRIGGER require_verified_candidate_checkpoint_bindings_v21");
    counterfeit.exec(`CREATE TRIGGER require_verified_candidate_checkpoint_bindings_v21
      BEFORE INSERT ON verified_candidate_checkpoints BEGIN SELECT 1; END;`);
    expect(() => migrateEngineerDatabase(counterfeit)).toThrow("invalid trigger");
    counterfeit.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("rejects recorded v22 history without complete ancestry or exact columns, foreign keys, indexes, and triggers", () => {
    for (const versions of [[22], [14, 15, 16, 17, 18, 19, 20, 22]]) {
      const gap = new Database(":memory:");
      gap.exec(ENGINEER_DATABASE_SCHEMA_SQL);
      for (const version of versions) gap.query("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
        .run(version, "2026-07-17T12:00:00.000Z");
      expect(() => migrateEngineerDatabase(gap)).toThrow("v22 is missing required migration ancestry");
      gap.close();
    }

    for (const mode of ["COLUMN", "INDEX", "TRIGGER"] as const) {
      const root = mkdtempSync(join(tmpdir(), `zintus-engineer-counterfeit-v22-${mode.toLowerCase()}-`));
      const dbPath = join(root, "engineer.db");
      new EngineerLedger(dbPath).close();
      const db = new Database(dbPath);
      if (mode === "COLUMN") {
        db.exec(`
          DROP TRIGGER require_new_approval_decision_checkpoint_v22;
          DROP TRIGGER require_approval_decision_checkpoint_pair_update_v22;
          DROP TRIGGER require_approval_decision_checkpoint_match_v22;
          DROP TRIGGER require_approval_decision_checkpoint_match_update_v22;
          DROP TRIGGER prevent_approval_decision_checkpoint_rebinding_v22;
          DROP INDEX idx_approval_decisions_checkpoint_v22;
          ALTER TABLE approval_decisions DROP COLUMN expected_verified_checkpoint_hash;
        `);
        expect(() => migrateEngineerDatabase(db)).toThrow("invalid approval_decisions.expected_verified_checkpoint_hash");
      } else if (mode === "INDEX") {
        db.exec(`DROP INDEX idx_approval_decisions_checkpoint_v22;
          CREATE INDEX idx_approval_decisions_checkpoint_v22 ON approval_decisions(actor_id);`);
        expect(() => migrateEngineerDatabase(db)).toThrow("exact approval decision checkpoint index");
      } else {
        db.exec(`DROP TRIGGER require_approval_decision_checkpoint_match_v22;
          CREATE TRIGGER require_approval_decision_checkpoint_match_v22
          BEFORE INSERT ON approval_decisions BEGIN SELECT 1; END;`);
        expect(() => migrateEngineerDatabase(db)).toThrow("invalid trigger");
      }
      db.close();
      rmSync(root, { recursive: true, force: true });
    }

    for (const [tableName, constraint] of [
      ["approval_requests", "CHECK(approval_revision >= 0)"],
      ["approval_decisions", "CHECK(expected_approval_revision IS NULL OR expected_approval_revision >= 0)"],
    ] as const) {
      const root = mkdtempSync(join(tmpdir(), `zintus-engineer-counterfeit-v22-${tableName}-check-`));
      const dbPath = join(root, "engineer.db");
      new EngineerLedger(dbPath).close();
      const db = new Database(dbPath);
      const original = (db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(tableName) as { sql: string }).sql;
      const counterfeit = original.replace(constraint, "");
      expect(counterfeit).not.toBe(original);
      const dependentSql = db.query(`SELECT type, name, sql FROM sqlite_master
        WHERE tbl_name = ? AND type IN ('index', 'trigger') AND sql IS NOT NULL ORDER BY type, name`)
        .all(tableName) as Array<{ type: "index" | "trigger"; name: string; sql: string }>;
      db.exec("PRAGMA foreign_keys = OFF; PRAGMA legacy_alter_table = ON;");
      for (const dependent of dependentSql) db.exec(`DROP ${dependent.type.toUpperCase()} ${dependent.name}`);
      db.exec(`ALTER TABLE ${tableName} RENAME TO ${tableName}_counterfeit_old`);
      db.exec(counterfeit);
      db.exec(`DROP TABLE ${tableName}_counterfeit_old`);
      for (const dependent of dependentSql) db.exec(dependent.sql);
      db.exec("PRAGMA legacy_alter_table = OFF; PRAGMA foreign_keys = ON;");
      expect(() => migrateEngineerDatabase(db)).toThrow("revision constraint");
      db.close();
      rmSync(root, { recursive: true, force: true });
    }

    const root = mkdtempSync(join(tmpdir(), "zintus-engineer-counterfeit-v22-fk-"));
    const dbPath = join(root, "engineer.db");
    new EngineerLedger(dbPath).close();
    const db = new Database(dbPath);
    removeV23Schema(db);
    db.exec(`
      DROP TRIGGER require_new_approval_checkpoint_v22;
      DROP TRIGGER require_new_git_checkpoint_v22;
      DROP TRIGGER require_new_approval_decision_checkpoint_v22;
      DROP TRIGGER require_approval_decision_checkpoint_pair_update_v22;
      DROP TRIGGER require_approval_decision_checkpoint_match_v22;
      DROP TRIGGER require_approval_decision_checkpoint_match_update_v22;
      DROP TRIGGER prevent_approval_decision_checkpoint_rebinding_v22;
      DROP INDEX idx_approval_decisions_checkpoint_v22;
      ALTER TABLE approval_decisions DROP COLUMN expected_verified_checkpoint_id;
      ALTER TABLE approval_decisions DROP COLUMN expected_verified_checkpoint_hash;
      ALTER TABLE approval_decisions DROP COLUMN expected_approval_revision;
      ALTER TABLE approval_requests DROP COLUMN approval_revision;
      DELETE FROM schema_migrations WHERE version = 22;
    `);
    const withoutForeignKeys = ENGINEER_DATABASE_MIGRATION_22_SQL.replace(
      /\s+REFERENCES verified_candidate_checkpoints\([^)]*\) ON DELETE RESTRICT/g, "",
    );
    db.exec(withoutForeignKeys);
    db.query("INSERT INTO schema_migrations(version, applied_at) VALUES (22, ?)")
      .run("2026-07-17T12:00:00.000Z");
    expect(() => migrateEngineerDatabase(db)).toThrow("foreign key");
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("binds checkpoint authority to the exact classification and v2 evidence identity", () => {
    for (const result of ["READY", "READY_WITH_ADVISORIES"] as const) {
      const fixture = checkpointBindingFixture(result);
      insertCheckpointFixture(fixture, result);
      expect(fixture.db.query("SELECT classification_result FROM verified_candidate_checkpoints").get())
        .toEqual({ classification_result: result });
      expect(() => fixture.db.query("UPDATE verified_candidate_checkpoints SET signature = signature").run())
        .toThrow("immutable");
      expect(() => fixture.db.query("DELETE FROM verified_candidate_checkpoints").run())
        .toThrow("immutable");
      fixture.db.close();
    }

    for (const [batchResult, checkpointResult] of [
      ["READY", "READY_WITH_ADVISORIES"],
      ["READY_WITH_ADVISORIES", "READY"],
      ["BLOCKED", "READY"],
      ["REPAIR_REQUIRED", "READY"],
    ] as const) {
      const fixture = checkpointBindingFixture(batchResult);
      expect(() => insertCheckpointFixture(fixture, checkpointResult))
        .toThrow("checkpoint classification binding mismatch");
      expect(fixture.db.query("SELECT COUNT(*) AS count FROM verified_candidate_checkpoints").get())
        .toEqual({ count: 0 });
      fixture.db.close();
    }

    for (const overrides of [
      { bundleVersion: 1 },
      { reviewerSessionId: "different-reviewer" },
      { classificationHash: sha256("different-classification") },
      { classificationResult: "READY_WITH_ADVISORIES" },
    ]) {
      const fixture = checkpointBindingFixture("READY", overrides);
      expect(() => insertCheckpointFixture(fixture, "READY"))
        .toThrow("checkpoint evidence bundle binding mismatch");
      expect(fixture.db.query("SELECT COUNT(*) AS count FROM verified_candidate_checkpoints").get())
        .toEqual({ count: 0 });
      fixture.db.close();
    }
  });

  test("keeps linked approval and Git checkpoint identities immutable", () => {
    const fixture = checkpointBindingFixture("READY");
    insertCheckpointFixture(fixture, "READY");
    fixture.db.query(`INSERT INTO approval_requests
      (id, run_id, risk_tier, assigned_reviewer_id, requested_at, deadline_at,
       reminder_schedule_json, timeout_action, manifest_hash, diff_hash, evidence_bundle_hash,
       status, reviewer_session_id, classification_hash, classification_result,
       verified_checkpoint_id, verified_checkpoint_hash)
      VALUES ('checkpoint-approval', 'checkpoint-run', 'LOW', NULL, ?, ?, '[]', 'PAUSE', ?, ?, ?,
        'PENDING', 'checkpoint-reviewer', ?, 'READY', ?, ?)`).run(
          fixture.at, fixture.at, fixture.manifestHash, sha256("diff"), fixture.evidenceBundleHash,
          fixture.classificationHash, fixture.checkpointId, fixture.checkpointHash,
        );
    expect(fixture.db.query("UPDATE approval_requests SET status = 'APPROVED' WHERE id = 'checkpoint-approval'").run().changes)
      .toBe(1);
    expect(() => fixture.db.query(`UPDATE approval_requests
      SET verified_checkpoint_id = ?, verified_checkpoint_hash = ? WHERE id = 'checkpoint-approval'`)
      .run(sha256("other-id"), sha256("other-hash"))).toThrow("immutable");

    fixture.db.query(`INSERT INTO git_operations
      (id, run_id, operation_type, requested_by, idempotency_key, expected_base_commit_sha,
       result_commit_sha, approval_id, evidence_bundle_hash, status, remote_reference, started_at,
       completed_at, error_code, verified_checkpoint_id, verified_checkpoint_hash)
      VALUES ('checkpoint-git', 'checkpoint-run', 'CREATE_COMMIT', 'SUPERVISOR', 'checkpoint-git-key', ?,
       ?, 'checkpoint-approval', ?, 'PENDING', NULL, ?, NULL, NULL, ?, ?)`).run(
         "a".repeat(40), "b".repeat(40), fixture.evidenceBundleHash, fixture.at,
         fixture.checkpointId, fixture.checkpointHash,
       );
    expect(fixture.db.query("UPDATE git_operations SET status = 'SUCCEEDED' WHERE id = 'checkpoint-git'").run().changes)
      .toBe(1);
    expect(() => fixture.db.query(`UPDATE git_operations
      SET verified_checkpoint_id = ?, verified_checkpoint_hash = ? WHERE id = 'checkpoint-git'`)
      .run(sha256("other-id"), sha256("other-hash"))).toThrow("immutable");
    expect(fixture.db.query(`SELECT verified_checkpoint_id, verified_checkpoint_hash
      FROM approval_requests WHERE id = 'checkpoint-approval'`).get()).toEqual({
        verified_checkpoint_id: fixture.checkpointId,
        verified_checkpoint_hash: fixture.checkpointHash,
      });
    expect(fixture.db.query(`SELECT verified_checkpoint_id, verified_checkpoint_hash
      FROM git_operations WHERE id = 'checkpoint-git'`).get()).toEqual({
        verified_checkpoint_id: fixture.checkpointId,
        verified_checkpoint_hash: fixture.checkpointHash,
      });
    fixture.db.close();
  });

  test("requires exact checkpoint authority for every new approval, decision, and Git row", () => {
    const fixture = checkpointBindingFixture("READY");
    insertCheckpointFixture(fixture, "READY");
    const approvalInsert = (columns: string, values: string, bindings: string[] = []) => fixture.db.query(`INSERT INTO approval_requests
      (id, run_id, risk_tier, assigned_reviewer_id, requested_at, deadline_at,
       reminder_schedule_json, timeout_action, manifest_hash, diff_hash, evidence_bundle_hash,
       status, reviewer_session_id, classification_hash, classification_result${columns})
      VALUES ('v22-approval', 'checkpoint-run', 'LOW', NULL, ?, ?, '[]', 'PAUSE', ?, ?, ?,
       'PENDING', 'checkpoint-reviewer', ?, 'READY'${values})`).run(
        fixture.at, fixture.at, fixture.manifestHash, sha256("diff"), fixture.evidenceBundleHash,
        fixture.classificationHash, ...bindings,
      );
    expect(() => approvalInsert("", "")).toThrow("requires verified checkpoint authority");
    expect(() => approvalInsert(", verified_checkpoint_id", ", ?", [fixture.checkpointId]))
      .toThrow();
    approvalInsert(", verified_checkpoint_id, verified_checkpoint_hash", ", ?, ?", [fixture.checkpointId, fixture.checkpointHash]);

    for (const [index, decision] of ["APPROVE", "REQUEST_CHANGES", "REJECT", "EXTEND"].entries()) {
      const base = `INSERT INTO approval_decisions
        (id, approval_request_id, actor_id, decision, reason, decided_at`;
      expect(() => fixture.db.query(`${base}) VALUES (?, 'v22-approval', ?, ?, 'reason', ?)`).run(
        `v22-decision-missing-${index}`, `human-${index}`, decision, new Date(Date.parse(fixture.at) + index * 1_000).toISOString(),
      )).toThrow("requires verified checkpoint authority");
      expect(() => fixture.db.query(`${base}, expected_verified_checkpoint_id)
        VALUES (?, 'v22-approval', ?, ?, 'reason', ?, ?)`).run(
          `v22-decision-single-${index}`, `human-${index}`, decision,
          new Date(Date.parse(fixture.at) + index * 1_000).toISOString(), fixture.checkpointId,
        )).toThrow();
      fixture.db.query(`${base}, expected_verified_checkpoint_id, expected_verified_checkpoint_hash, expected_approval_revision)
        VALUES (?, 'v22-approval', ?, ?, 'reason', ?, ?, ?, 0)`).run(
          `v22-decision-${index}`, `human-${index}`, decision,
          new Date(Date.parse(fixture.at) + index * 1_000).toISOString(), fixture.checkpointId, fixture.checkpointHash,
        );
    }

    expect(() => fixture.db.query(`INSERT INTO git_operations
      (id, run_id, operation_type, requested_by, idempotency_key, expected_base_commit_sha,
       result_commit_sha, approval_id, evidence_bundle_hash, status, remote_reference, started_at,
       completed_at, error_code)
      VALUES ('v22-git-missing', 'checkpoint-run', 'INSPECT_BASE', 'SUPERVISOR', 'v22-git-missing', ?,
       NULL, 'v22-approval', ?, 'STARTED', NULL, ?, NULL, NULL)`).run(
        "a".repeat(40), fixture.evidenceBundleHash, fixture.at,
      )).toThrow("requires verified checkpoint authority");
    fixture.db.query(`INSERT INTO git_operations
      (id, run_id, operation_type, requested_by, idempotency_key, expected_base_commit_sha,
       result_commit_sha, approval_id, evidence_bundle_hash, status, remote_reference, started_at,
       completed_at, error_code, verified_checkpoint_id, verified_checkpoint_hash)
      VALUES ('v22-git', 'checkpoint-run', 'INSPECT_BASE', 'SUPERVISOR', 'v22-git', ?,
       NULL, 'v22-approval', ?, 'STARTED', NULL, ?, NULL, NULL, ?, ?)`).run(
        "a".repeat(40), fixture.evidenceBundleHash, fixture.at, fixture.checkpointId, fixture.checkpointHash,
      );
    expect(fixture.db.query("SELECT COUNT(*) AS count FROM approval_decisions").get()).toEqual({ count: 4 });
    expect(fixture.db.query("SELECT COUNT(*) AS count FROM git_operations").get()).toEqual({ count: 1 });
    fixture.db.close();
  });

  test("migrates populated v21 publication rows to v22 without backfilling checkpoint decisions", () => {
    const fixture = checkpointBindingFixture("READY");
    insertCheckpointFixture(fixture, "READY");
    removeV23Schema(fixture.db);
    fixture.db.exec(`
      DROP TRIGGER require_new_approval_checkpoint_v22;
      DROP TRIGGER require_new_git_checkpoint_v22;
      DROP TRIGGER require_new_approval_decision_checkpoint_v22;
      DROP TRIGGER require_approval_decision_checkpoint_pair_update_v22;
      DROP TRIGGER require_approval_decision_checkpoint_match_v22;
      DROP TRIGGER require_approval_decision_checkpoint_match_update_v22;
      DROP TRIGGER prevent_approval_decision_checkpoint_rebinding_v22;
      DROP INDEX idx_approval_decisions_checkpoint_v22;
      ALTER TABLE approval_decisions DROP COLUMN expected_verified_checkpoint_id;
      ALTER TABLE approval_decisions DROP COLUMN expected_verified_checkpoint_hash;
      ALTER TABLE approval_decisions DROP COLUMN expected_approval_revision;
      ALTER TABLE approval_requests DROP COLUMN approval_revision;
      DELETE FROM schema_migrations WHERE version = 22;
    `);
    fixture.db.query(`INSERT INTO approval_requests
      (id, run_id, risk_tier, assigned_reviewer_id, requested_at, deadline_at,
       reminder_schedule_json, timeout_action, manifest_hash, diff_hash, evidence_bundle_hash,
       status, reviewer_session_id, classification_hash, classification_result)
      VALUES ('v21-approval', 'checkpoint-run', 'LOW', NULL, ?, ?, '[]', 'PAUSE', ?, ?, ?,
       'PENDING', 'checkpoint-reviewer', ?, 'READY')`).run(
        fixture.at, fixture.at, fixture.manifestHash, sha256("diff"), fixture.evidenceBundleHash, fixture.classificationHash,
      );
    fixture.db.query(`INSERT INTO approval_decisions
      (id, approval_request_id, actor_id, decision, reason, decided_at)
      VALUES ('v21-decision', 'v21-approval', 'human-v21', 'APPROVE', 'legacy v21 decision', ?)`)
      .run(fixture.at);
    fixture.db.query(`INSERT INTO git_operations
      (id, run_id, operation_type, requested_by, idempotency_key, expected_base_commit_sha,
       result_commit_sha, approval_id, evidence_bundle_hash, status, remote_reference, started_at,
       completed_at, error_code)
      VALUES ('v21-git', 'checkpoint-run', 'INSPECT_BASE', 'SUPERVISOR', 'v21-git', ?,
       NULL, 'v21-approval', ?, 'FAILED', NULL, ?, ?, 'LEGACY')`).run(
        "a".repeat(40), fixture.evidenceBundleHash, fixture.at, fixture.at,
      );
    migrateEngineerDatabase(fixture.db, fixture.at);
    expect(fixture.db.query(`SELECT verified_checkpoint_id, verified_checkpoint_hash, approval_revision
      FROM approval_requests WHERE id = 'v21-approval'`).get())
      .toEqual({ verified_checkpoint_id: null, verified_checkpoint_hash: null, approval_revision: 0 });
    expect(fixture.db.query(`SELECT expected_verified_checkpoint_id, expected_verified_checkpoint_hash, expected_approval_revision
      FROM approval_decisions WHERE id = 'v21-decision'`).get())
      .toEqual({ expected_verified_checkpoint_id: null, expected_verified_checkpoint_hash: null, expected_approval_revision: null });
    expect(fixture.db.query(`SELECT verified_checkpoint_id, verified_checkpoint_hash
      FROM git_operations WHERE id = 'v21-git'`).get())
      .toEqual({ verified_checkpoint_id: null, verified_checkpoint_hash: null });
    expect(fixture.db.query("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 32 });
    expect(fixture.db.query("SELECT COUNT(*) AS count FROM publication_candidate_selections").get()).toEqual({ count: 0 });
    fixture.db.close();
  });

  test("rejects counterfeit v21 checkpoint uniqueness and column definitions", () => {
    for (const [label, checkpointHash, classificationHash, evidenceBundleId, extra] of [
      ["missing-checkpoint-unique", "TEXT NOT NULL", "TEXT NOT NULL UNIQUE", "TEXT NOT NULL UNIQUE", ""],
      ["wrong-classification-unique", "TEXT NOT NULL UNIQUE", "TEXT NOT NULL", "TEXT NOT NULL UNIQUE", "UNIQUE(diff_hash)"],
      ["partial-evidence-unique", "TEXT NOT NULL UNIQUE", "TEXT NOT NULL UNIQUE", "TEXT NOT NULL", ""],
    ] as const) {
      const root = mkdtempSync(join(tmpdir(), `zintus-engineer-counterfeit-v21-${label}-`));
      const dbPath = join(root, "engineer.db");
      const ledger = new EngineerLedger(dbPath);
      ledger.close();
      const db = new Database(dbPath);
      db.exec("PRAGMA foreign_keys=OFF; DROP TABLE verified_candidate_checkpoints;");
      db.exec(`CREATE TABLE verified_candidate_checkpoints (
        id TEXT PRIMARY KEY,
        checkpoint_hash ${checkpointHash},
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
        classification_hash ${classificationHash} REFERENCES review_classification_batches(classification_hash) ON DELETE RESTRICT,
        classification_result TEXT NOT NULL CHECK(classification_result IN ('READY', 'READY_WITH_ADVISORIES')),
        evidence_bundle_id ${evidenceBundleId} REFERENCES evidence_bundles(id) ON DELETE RESTRICT,
        evidence_bundle_hash TEXT NOT NULL,
        environment_digest TEXT NOT NULL,
        checkpoint_json TEXT NOT NULL,
        statement_json TEXT NOT NULL,
        statement_hash TEXT NOT NULL,
        signature_algorithm TEXT NOT NULL,
        signature_key_id TEXT NOT NULL,
        signature TEXT NOT NULL,
        created_at TEXT NOT NULL,
        ${extra ? `${extra},` : ""}
        FOREIGN KEY(run_id, manifest_hash) REFERENCES task_manifest_versions(run_id, manifest_hash) ON DELETE RESTRICT
      );
      ${label === "partial-evidence-unique" ? "CREATE UNIQUE INDEX counterfeit_evidence_unique ON verified_candidate_checkpoints(evidence_bundle_id) WHERE evidence_bundle_id IS NOT NULL;" : ""}
      PRAGMA foreign_keys=ON;`);
      expect(() => migrateEngineerDatabase(db)).toThrow("exact unique");
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects missing or counterfeit v21 run-event immutability triggers", () => {
    for (const mode of ["missing", "counterfeit"] as const) {
      const root = mkdtempSync(join(tmpdir(), `zintus-engineer-v21-event-trigger-${mode}-`));
      const dbPath = join(root, "engineer.db");
      const ledger = new EngineerLedger(dbPath);
      ledger.close();
      const db = new Database(dbPath);
      db.exec("DROP TRIGGER prevent_run_state_events_update_v21");
      if (mode === "counterfeit") {
        db.exec(`CREATE TRIGGER prevent_run_state_events_update_v21
          BEFORE UPDATE ON run_state_events BEGIN SELECT CASE WHEN 0 THEN RAISE(ABORT, 'run state events are immutable') END; END;`);
      }
      expect(() => migrateEngineerDatabase(db)).toThrow(mode === "missing" ? "missing trigger" : "invalid trigger");
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects omitted, wrong-target, and wrong-delete checkpoint link foreign keys", () => {
    for (const tableName of ["approval_requests", "git_operations"] as const) {
      for (const variant of ["omitted", "wrong-target", "wrong-delete"] as const) {
        const root = mkdtempSync(join(tmpdir(), `zintus-engineer-v21-${tableName}-${variant}-`));
        const dbPath = join(root, "engineer.db");
        const ledger = new EngineerLedger(dbPath);
        ledger.close();
        const db = new Database(dbPath);
        const original = (db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName) as { sql: string }).sql;
        let counterfeit = original;
        if (variant === "omitted") {
          counterfeit = counterfeit.replace(
            /verified_checkpoint_id\s+TEXT\s+REFERENCES\s+verified_candidate_checkpoints\(id\)\s+ON DELETE RESTRICT/,
            "verified_checkpoint_id TEXT",
          );
        } else if (variant === "wrong-target") {
          counterfeit = counterfeit.replace(
            /verified_checkpoint_id\s+TEXT\s+REFERENCES\s+verified_candidate_checkpoints\(id\)\s+ON DELETE RESTRICT/,
            "verified_checkpoint_id TEXT REFERENCES verified_candidate_checkpoints(checkpoint_hash) ON DELETE RESTRICT",
          );
        } else {
          counterfeit = counterfeit.replace(
            /verified_checkpoint_hash\s+TEXT\s+REFERENCES\s+verified_candidate_checkpoints\(checkpoint_hash\)\s+ON DELETE RESTRICT/,
            "verified_checkpoint_hash TEXT REFERENCES verified_candidate_checkpoints(checkpoint_hash) ON DELETE CASCADE",
          );
        }
        expect(counterfeit).not.toBe(original);
        db.exec(`PRAGMA foreign_keys=OFF; DROP TABLE ${tableName}; ${counterfeit}; PRAGMA foreign_keys=ON;`);
        expect(() => migrateEngineerDatabase(db)).toThrow(`invalid ${tableName}.verified_checkpoint_`);
        db.close();
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test("migrates legacy duplicate Builder input hashes without fabricating dispatch claims", () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-engineer-v20-legacy-builders-"));
    const dbPath = join(root, "engineer.db");
    const ledger = new EngineerLedger(dbPath);
    ledger.close();
    const db = new Database(dbPath);
    removeV23Schema(db);
    db.exec(`
      DROP TRIGGER require_new_approval_checkpoint_v22;
      DROP TRIGGER require_new_git_checkpoint_v22;
      DROP TRIGGER require_new_approval_decision_checkpoint_v22;
      DROP TRIGGER require_approval_decision_checkpoint_pair_update_v22;
      DROP TRIGGER require_approval_decision_checkpoint_match_v22;
      DROP TRIGGER require_approval_decision_checkpoint_match_update_v22;
      DROP TRIGGER prevent_approval_decision_checkpoint_rebinding_v22;
      DROP INDEX idx_approval_decisions_checkpoint_v22;
      ALTER TABLE approval_decisions DROP COLUMN expected_verified_checkpoint_id;
      ALTER TABLE approval_decisions DROP COLUMN expected_verified_checkpoint_hash;
      ALTER TABLE approval_decisions DROP COLUMN expected_approval_revision;
      ALTER TABLE approval_requests DROP COLUMN approval_revision;
      DROP TRIGGER prevent_run_state_events_update_v21;
      DROP TRIGGER prevent_run_state_events_delete_v21;
      DROP TRIGGER prevent_verified_candidate_checkpoints_update_v21;
      DROP TRIGGER prevent_verified_candidate_checkpoints_delete_v21;
      DROP TRIGGER require_verified_candidate_checkpoint_bindings_v21;
      DROP TRIGGER require_approval_checkpoint_pair_v21;
      DROP TRIGGER require_approval_checkpoint_pair_update_v21;
      DROP TRIGGER require_approval_checkpoint_match_v21;
      DROP TRIGGER require_approval_checkpoint_match_update_v21;
      DROP TRIGGER prevent_approval_checkpoint_rebinding_v21;
      DROP TRIGGER require_git_checkpoint_pair_v21;
      DROP TRIGGER require_git_checkpoint_pair_update_v21;
      DROP TRIGGER require_git_checkpoint_match_v21;
      DROP TRIGGER require_git_checkpoint_match_update_v21;
      DROP TRIGGER prevent_git_checkpoint_rebinding_v21;
      DROP TABLE verified_candidate_checkpoints;
      ALTER TABLE approval_requests DROP COLUMN verified_checkpoint_id;
      ALTER TABLE approval_requests DROP COLUMN verified_checkpoint_hash;
      ALTER TABLE git_operations DROP COLUMN verified_checkpoint_id;
      ALTER TABLE git_operations DROP COLUMN verified_checkpoint_hash;
      DROP TRIGGER require_valid_builder_dispatch_claim_v20;
      DROP TRIGGER prevent_builder_dispatch_claims_update_v20;
      DROP TRIGGER prevent_builder_dispatch_claims_delete_v20;
      DROP TABLE builder_dispatch_claims;
      DELETE FROM schema_migrations WHERE version IN (20, 21, 22);
    `);
    const timestamp = "2026-07-17T12:00:00.000Z";
    db.query("INSERT INTO users(id, created_at, updated_at) VALUES (?, ?, ?)").run("user-v20", timestamp, timestamp);
    db.query(`INSERT INTO repository_connections
      (id, user_id, provider, owner, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run("repo-v20", "user-v20", "local", "local", "repo", timestamp, timestamp);
    db.query(`INSERT INTO engineer_runs
      (id, user_id, repository_id, base_branch, base_commit_sha, request_original, request_normalized,
       state, state_version, manifest_hash, risk_tier, human_gate_required, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`)
      .run("run-v20", "user-v20", "repo-v20", "main", "a".repeat(40), "request", "request",
        "IMPLEMENTING", 1, "MEDIUM", 1, timestamp, timestamp);
    const inputHash = sha256("legacy-duplicate");
    for (const [id, status] of [["legacy-builder-1", "FAILED"], ["legacy-builder-2", "PAUSED"]] as const) {
      db.query(`INSERT INTO agent_executions
        (id, run_id, role, model_tier, status, input_hash, output_artifact_id, started_at, completed_at)
        VALUES (?, ?, 'BUILDER', 'GPT-5.6_TERRA', ?, ?, NULL, ?, ?)`)
        .run(id, "run-v20", status, inputHash, timestamp, timestamp);
    }
    migrateEngineerDatabase(db, timestamp);
    expect(db.query("SELECT COUNT(*) AS count FROM agent_executions WHERE run_id = ? AND input_hash = ?").get("run-v20", inputHash))
      .toEqual({ count: 2 });
    expect(db.query("SELECT COUNT(*) AS count FROM builder_dispatch_claims").get()).toEqual({ count: 0 });
    expect(db.query("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 32 });
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("rejects omitted, wrong-column, and partial substitutes for the v20 agent uniqueness constraint", () => {
    for (const [label, substitute] of [
      ["omitted", ""],
      ["wrong-column", "CREATE UNIQUE INDEX counterfeit_builder_unique ON builder_dispatch_claims(worker_owner_id);"],
      ["partial", "CREATE UNIQUE INDEX counterfeit_builder_unique ON builder_dispatch_claims(agent_execution_id) WHERE worker_owner_id IS NOT NULL;"],
    ] as const) {
      const root = mkdtempSync(join(tmpdir(), `zintus-engineer-v20-${label}-`));
      const dbPath = join(root, "engineer.db");
      const ledger = new EngineerLedger(dbPath);
      ledger.close();
      const db = new Database(dbPath);
      db.exec("DROP TABLE builder_dispatch_claims");
      db.exec(`CREATE TABLE builder_dispatch_claims (
        run_id TEXT NOT NULL REFERENCES engineer_runs(id) ON DELETE RESTRICT,
        input_hash TEXT NOT NULL,
        agent_execution_id TEXT NOT NULL REFERENCES agent_executions(id) ON DELETE RESTRICT,
        model_tier TEXT NOT NULL CHECK(model_tier = 'GPT-5.6_TERRA'),
        worker_owner_id TEXT,
        worker_fencing_token INTEGER CHECK(worker_fencing_token IS NULL OR worker_fencing_token > 0),
        claimed_at TEXT NOT NULL,
        CHECK((worker_owner_id IS NULL AND worker_fencing_token IS NULL) OR
              (worker_owner_id IS NOT NULL AND worker_fencing_token IS NOT NULL)),
        PRIMARY KEY(run_id, input_hash)
      );
      CREATE INDEX idx_builder_dispatch_claims_agent ON builder_dispatch_claims(agent_execution_id);
      ${substitute}`);
      expect(() => migrateEngineerDatabase(db)).toThrow("exact unique Builder claim agent binding");
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("upgrades a genuine populated draft-v15 contract through v17 without rewriting it", () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-engineer-populated-v15-"));
    const dbPath = join(root, "engineer.db");
    const db = new Database(dbPath, { create: true });
    db.exec("PRAGMA foreign_keys=ON");
    db.exec(ENGINEER_DATABASE_SCHEMA_SQL);
    const timestamp = "2026-07-17T12:00:00.000Z";
    const content: TaskManifestContent = {
      manifestVersion: 1,
      runId: "run-v15",
      repository: {
        repositoryId: "repo-v15", provider: "local", owner: "local", name: "v15",
        baseBranch: "main", baseCommitSha: "c".repeat(40),
      },
      request: { original: "request", normalized: "request" },
      acceptanceCriteria: [{
        criterionId: "criterion-v15", statement: "Preserve the v15 contract.",
        verificationMethod: "Reopen and read it.", priority: "MUST",
      }],
      testPlan: [{
        testId: "test-v15", criterionIds: ["criterion-v15"], type: "UNIT",
        description: "Read the migrated contract.", command: "bun test",
      }],
      allowedPaths: ["src/**"], deniedPaths: [".env*"],
      allowedCommands: ["bun test"], prohibitedCommands: [],
      riskTier: "LOW", humanGateRequired: false,
      retryBudgets: {
        sameFailureAttempts: 2, builderRepairAttempts: 4, reviewerFixAttempts: 2,
        plannerRestarts: 1, sandboxProvisioningAttempts: 3, transientModelAttempts: 3,
      },
      timeBudgetSeconds: 600, tokenBudget: 10_000, costBudgetUsd: 1,
      createdAt: timestamp,
    };
    const manifest = TaskManifestSchema.parse({ ...content, manifestHash: sha256(content) });
    expect(manifest.manifestHash).toBe("sha256:637b61fe47051965c9d6fb94a20ae146abd6407a6c88b79621289a482622a50b");
    const contractJson = '{"contractHash":"sha256:34b7ec3e88ba9d2565af10e9b9ef3735b4d7d3e080a3cab1df0635abf84b0fb4","createdAt":"2026-07-17T12:00:00.000Z","manifestHash":"sha256:637b61fe47051965c9d6fb94a20ae146abd6407a6c88b79621289a482622a50b","planningBinding":{"contextManifestHash":null,"planProposalHash":null},"policyBindings":{"reviewerMappingPolicyVersion":"engineer-reviewer-mapping-v1","securityPolicyVersion":"engineer-security-v1","verificationPolicyVersion":"engineer-verification-v1"},"policyVersion":"engineer-required-lane-v1","repositoryBinding":{"baseBranch":"main","baseCommitSha":"cccccccccccccccccccccccccccccccccccccccc","repositoryId":"repo-v15"},"requestBinding":{"normalizedHash":"sha256:8869ad22943e917a9e5aae887407895ca2687608588cb6f5e154e6cc4c617642","originalHash":"sha256:8869ad22943e917a9e5aae887407895ca2687608588cb6f5e154e6cc4c617642"},"requiredCriterionIds":["criterion-v15"],"requiredTestIds":["test-v15"],"runId":"run-v15","schemaVersion":1,"scopeBinding":{"allowedCommandsHash":"sha256:367bb912355f9bbc1ea21f64fc58e2a9db620f4172897a029d5deb3e37d8ee2a","allowedPathsHash":"sha256:d090e8a6c94f86b9646229a18fec95aa793bab78e7976b0733fd7d0e6c440012","deniedPathsHash":"sha256:c368fff2b711ab1be30c3fd46ecc12e7ecca55caddc98bea76b24bbae2bc11d8","prohibitedCommandsHash":"sha256:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945"}}';
    const contract = RequiredLaneContractSchema.parse(JSON.parse(contractJson));
    const manifestJson = JSON.stringify(manifest);
    db.query("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(14, timestamp);
    db.exec(ENGINEER_DATABASE_MIGRATION_15_SQL);
    db.query("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(15, timestamp);
    db.query("INSERT INTO users(id, created_at, updated_at) VALUES (?, ?, ?)")
      .run("user-v15", timestamp, timestamp);
    db.query(`INSERT INTO repository_connections
      (id, user_id, provider, owner, name, url, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`).run(
        "repo-v15", "user-v15", "local", "local", "v15", timestamp, timestamp,
      );
    db.query(`INSERT INTO engineer_runs
      (id, user_id, repository_id, base_branch, base_commit_sha, request_original,
       request_normalized, state, state_version, manifest_hash, risk_tier,
       human_gate_required, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        "run-v15", "user-v15", "repo-v15", "main", "c".repeat(40), "request", "request",
        "PLAN_FROZEN", 1, manifest.manifestHash, "LOW", 0, timestamp, timestamp,
      );
    db.query(`INSERT INTO task_manifest_versions
      (id, run_id, version, manifest_hash, manifest_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run("manifest-v15", "run-v15", 1, manifest.manifestHash, manifestJson, timestamp);
    db.query(`INSERT INTO required_lane_contracts
      (contract_hash, run_id, manifest_hash, schema_version, contract_json, created_at)
      VALUES (?, ?, ?, 1, ?, ?)`).run(contract.contractHash, "run-v15", manifest.manifestHash, contractJson, timestamp);

    migrateEngineerDatabase(db, "2026-07-17T12:01:00.000Z");

    expect(db.query("SELECT contract_hash, run_id, manifest_hash FROM required_lane_contracts").get())
      .toEqual({ contract_hash: contract.contractHash, run_id: "run-v15", manifest_hash: manifest.manifestHash });
    expect(db.query("SELECT contract_json FROM required_lane_contracts").get())
      .toEqual({ contract_json: contractJson });
    expect(db.query("PRAGMA table_info(required_lane_contracts)").all())
      .toContainEqual(expect.objectContaining({ name: "contract_hash", notnull: 1, pk: 1 }));
    expect((db.query("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: number }>)
      .map((row) => row.version)).toEqual([14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32]);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    db.close();

    const reopened = new EngineerLedger(dbPath);
    expect(reopened.getRequiredLaneContract("run-v15")).toEqual(contract);
    expect(reopened.getRequiredLaneContract("run-v15")).toMatchObject({
      schemaVersion: 1, policyVersion: "engineer-required-lane-v1",
    });
    expect("commandPolicyVersion" in contract.policyBindings).toBe(false);
    expect(reopened.exportRunRecords("run-v15").required_lane_contracts?.[0]?.contract_json)
      .toBe(contractJson);
    reopened.close();
    const finalDb = new Database(dbPath);
    expect(() => finalDb.query(`INSERT INTO required_lane_contracts
      (contract_hash, run_id, manifest_hash, schema_version, contract_json, created_at)
      VALUES (NULL, ?, ?, 1, ?, ?)`).run("run-v15", manifest.manifestHash, contractJson, timestamp)).toThrow();
    finalDb.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("concurrent v15 startup migrators both converge on one valid current schema", async () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-engineer-concurrent-current-"));
    const dbPath = join(root, "engineer.db");
    const setup = new Database(dbPath, { create: true });
    setup.exec(ENGINEER_DATABASE_SCHEMA_SQL);
    setup.query("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
      .run(14, "2026-07-17T11:59:00.000Z");
    setup.exec(ENGINEER_DATABASE_MIGRATION_15_SQL);
    setup.query("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
      .run(15, "2026-07-17T12:00:00.000Z");
    setup.close();

    const ledgerModule = new URL("./ledger.ts", import.meta.url).href;
    const script = `
      import { EngineerLedger } from ${JSON.stringify(ledgerModule)};
      const ledger = new EngineerLedger(process.env.ENGINEER_CONCURRENT_DB);
      ledger.close();
    `;
    const processes = Array.from({ length: 2 }, () => Bun.spawn({
      cmd: [process.execPath, "-e", script],
      env: { ...process.env, ENGINEER_CONCURRENT_DB: dbPath },
      stdout: "pipe",
      stderr: "pipe",
    }));
    const exits = await Promise.all(processes.map(async (child) => ({
      code: await child.exited,
      stderr: await new Response(child.stderr).text(),
    })));
    expect(exits).toEqual([{ code: 0, stderr: "" }, { code: 0, stderr: "" }]);

    const migrated = new Database(dbPath);
    expect((migrated.query("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: number }>)
      .map((row) => row.version)).toEqual([14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32]);
    expect(migrated.query("PRAGMA table_info(required_lane_contracts)").all())
      .toContainEqual(expect.objectContaining({ name: "contract_hash", notnull: 1, pk: 1 }));
    migrated.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("concurrent historical-v14 shape repairs recheck missing columns under one write lock", async () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-engineer-concurrent-v14-repair-"));
    const dbPath = join(root, "engineer.db");
    const setup = new Database(dbPath, { create: true });
    setup.exec(ENGINEER_DATABASE_SCHEMA_SQL);
    setup.exec("ALTER TABLE engineer_runs DROP COLUMN last_error");
    setup.query("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
      .run(14, "2026-07-17T12:00:00.000Z");
    setup.close();

    const ledgerModule = new URL("./ledger.ts", import.meta.url).href;
    const script = `
      import { EngineerLedger } from ${JSON.stringify(ledgerModule)};
      const ledger = new EngineerLedger(process.env.ENGINEER_CONCURRENT_DB);
      ledger.close();
    `;
    const processes = Array.from({ length: 2 }, () => Bun.spawn({
      cmd: [process.execPath, "-e", script],
      env: { ...process.env, ENGINEER_CONCURRENT_DB: dbPath },
      stdout: "pipe",
      stderr: "pipe",
    }));
    const exits = await Promise.all(processes.map(async (child) => ({
      code: await child.exited,
      stderr: await new Response(child.stderr).text(),
    })));
    expect(exits).toEqual([{ code: 0, stderr: "" }, { code: 0, stderr: "" }]);

    const migrated = new Database(dbPath);
    const runColumns = migrated.query("PRAGMA table_info(engineer_runs)").all() as Array<{ name: string }>;
    expect(runColumns.filter((column) => column.name === "last_error")).toHaveLength(1);
    expect((migrated.query("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: number }>)
      .map((row) => row.version)).toEqual([14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32]);
    migrated.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("rejects a counterfeit v15 table with matching names but missing constraints", () => {
    const counterfeit = new Database(":memory:");
    counterfeit.exec(ENGINEER_DATABASE_SCHEMA_SQL);
    counterfeit.exec(`CREATE TABLE required_lane_contracts (
      contract_hash TEXT,
      run_id TEXT,
      manifest_hash TEXT,
      schema_version INTEGER,
      contract_json TEXT,
      created_at TEXT
    );
    CREATE INDEX idx_required_lane_contracts_run ON required_lane_contracts(created_at, run_id);`);
    counterfeit.query("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
      .run(14, "2026-07-17T11:59:00.000Z");
    counterfeit.query("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
      .run(15, "2026-07-17T12:00:00.000Z");
    expect(() => migrateEngineerDatabase(counterfeit)).toThrow("invalid required_lane_contracts.contract_hash");
    counterfeit.close();
  });

  test("rejects a partial counterfeit index as the required run-manifest uniqueness constraint", () => {
    const counterfeit = new Database(":memory:");
    counterfeit.exec(ENGINEER_DATABASE_SCHEMA_SQL);
    counterfeit.exec(`CREATE TABLE required_lane_contracts (
      contract_hash TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      manifest_hash TEXT NOT NULL,
      schema_version INTEGER NOT NULL CHECK(schema_version = 1),
      contract_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(run_id, manifest_hash)
        REFERENCES task_manifest_versions(run_id, manifest_hash) ON DELETE RESTRICT
    );
    CREATE INDEX idx_required_lane_contracts_run ON required_lane_contracts(run_id, created_at);
    CREATE UNIQUE INDEX counterfeit_partial_binding
      ON required_lane_contracts(run_id, manifest_hash) WHERE schema_version = 2;`);
    counterfeit.query("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
      .run(14, "2026-07-17T11:59:00.000Z");
    counterfeit.query("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
      .run(15, "2026-07-17T12:00:00.000Z");
    expect(() => migrateEngineerDatabase(counterfeit)).toThrow("unique run/manifest binding");
    expect(counterfeit.query("SELECT MAX(version) AS version FROM schema_migrations").get())
      .toEqual({ version: 15 });
    counterfeit.close();
  });

  test("rejects counterfeit v18 review indexes and trigger bodies", () => {
    const counterfeitIndex = new Database(":memory:");
    counterfeitIndex.exec(ENGINEER_DATABASE_SCHEMA_SQL);
    counterfeitIndex.query("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
      .run(14, "2026-07-17T12:00:00.000Z");
    migrateEngineerDatabase(counterfeitIndex);
    counterfeitIndex.exec(`DROP INDEX idx_review_classification_batches_run;
      CREATE INDEX idx_review_classification_batches_run
        ON review_classification_batches(created_at, run_id);`);
    expect(() => migrateEngineerDatabase(counterfeitIndex)).toThrow("idx_review_classification_batches_run");
    counterfeitIndex.close();

    const counterfeitTrigger = new Database(":memory:");
    counterfeitTrigger.exec(ENGINEER_DATABASE_SCHEMA_SQL);
    counterfeitTrigger.query("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
      .run(14, "2026-07-17T12:00:00.000Z");
    migrateEngineerDatabase(counterfeitTrigger);
    counterfeitTrigger.exec(`DROP TRIGGER prevent_review_findings_update_v18;
      CREATE TRIGGER prevent_review_findings_update_v18
        BEFORE UPDATE ON review_findings BEGIN
          SELECT CASE WHEN 0 THEN RAISE(ABORT, 'review_findings are immutable') END;
        END;`);
    expect(() => migrateEngineerDatabase(counterfeitTrigger)).toThrow("invalid trigger prevent_review_findings_update_v18");
    counterfeitTrigger.close();
  });

  test("records the repaired v14 base before applying Required Lane migrations to older history", () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-engineer-schema-v13-"));
    const dbPath = join(root, "engineer.db");
    const older = new Database(dbPath, { create: true });
    older.exec(ENGINEER_DATABASE_SCHEMA_SQL);
    older.query("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
      .run(13, "2026-07-17T12:00:00.000Z");
    older.close();
    const ledger = new EngineerLedger(dbPath);
    ledger.close();
    const migrated = new Database(dbPath);
    const versions = migrated.query("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: number }>;
    expect(versions.map((row) => row.version)).toEqual([13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32]);
    migrated.close();
    rmSync(root, { recursive: true, force: true });
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
