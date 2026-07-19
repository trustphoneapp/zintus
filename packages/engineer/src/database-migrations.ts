import type { Database } from "bun:sqlite";
import {
  AdvisoryBacklogEventSchema, AdvisoryBacklogItemSchema, CandidateLineageAttestationSchema,
  EngineerRunLineageSchema, HardeningConsentSchema, HardeningQuoteSchema, PublicationCandidateSelectionSchema,
  SignedCandidateLineageAttestationSchema, advisoryActionability,
} from "./advisory-hardening-contracts.js";
import { TaskManifestSchema } from "./contracts.js";
import { canonicalJson } from "./hash.js";
import {
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
  ENGINEER_DATABASE_MIGRATION_28_SQL,
  ENGINEER_DATABASE_MIGRATION_29_SQL,
  ENGINEER_DATABASE_MIGRATION_30_SQL,
  ENGINEER_DATABASE_MIGRATION_31_SQL,
  ENGINEER_DATABASE_MIGRATION_32_SQL,
  ENGINEER_DATABASE_MIGRATION_33_SQL,
  ENGINEER_DATABASE_SCHEMA_VERSION,
} from "./database-schema.js";

interface Migration {
  version: number;
  sql: string;
}

const MIGRATIONS: readonly Migration[] = [
  { version: 15, sql: ENGINEER_DATABASE_MIGRATION_15_SQL },
  { version: 16, sql: ENGINEER_DATABASE_MIGRATION_16_SQL },
  { version: 17, sql: ENGINEER_DATABASE_MIGRATION_17_SQL },
  { version: 18, sql: ENGINEER_DATABASE_MIGRATION_18_SQL },
  { version: 19, sql: ENGINEER_DATABASE_MIGRATION_19_SQL },
  { version: 20, sql: ENGINEER_DATABASE_MIGRATION_20_SQL },
  { version: 21, sql: ENGINEER_DATABASE_MIGRATION_21_SQL },
  { version: 22, sql: ENGINEER_DATABASE_MIGRATION_22_SQL },
  { version: 23, sql: ENGINEER_DATABASE_MIGRATION_23_SQL },
  { version: 24, sql: ENGINEER_DATABASE_MIGRATION_24_SQL },
  { version: 25, sql: ENGINEER_DATABASE_MIGRATION_25_SQL },
  { version: 26, sql: ENGINEER_DATABASE_MIGRATION_26_SQL },
  { version: 27, sql: ENGINEER_DATABASE_MIGRATION_27_SQL },
  { version: 28, sql: ENGINEER_DATABASE_MIGRATION_28_SQL },
  { version: 29, sql: ENGINEER_DATABASE_MIGRATION_29_SQL },
  { version: 30, sql: ENGINEER_DATABASE_MIGRATION_30_SQL },
  { version: 31, sql: ENGINEER_DATABASE_MIGRATION_31_SQL },
  { version: 32, sql: ENGINEER_DATABASE_MIGRATION_32_SQL },
  { version: 33, sql: ENGINEER_DATABASE_MIGRATION_33_SQL },
];

function assertHardeningBudgetShape(db: Database): void {
  const expected = new Map<string, string>();
  const pattern = /CREATE (?:UNIQUE )?(?:TABLE|INDEX|TRIGGER)\s+([A-Za-z0-9_]+)[\s\S]*?;\s*(?=CREATE |$)/g;
  for (const match of ENGINEER_DATABASE_MIGRATION_29_SQL.matchAll(pattern)) expected.set(match[1]!, normalizeSchemaSql(match[0]!));
  const rebuiltQuote = ENGINEER_DATABASE_MIGRATION_29_SQL.match(/CREATE TABLE hardening_quotes_v29[\s\S]*?;\s*(?=INSERT)/)?.[0];
  if (rebuiltQuote) expected.set("hardening_quotes", normalizeSchemaSql(rebuiltQuote).replaceAll("HARDENING_QUOTES_V29", "HARDENING_QUOTES"));
  const names = [
    "hardening_quote_sizing_authorities", "uq_hardening_quote_sizing_authority_pair_v29",
    "idx_hardening_quote_sizing_checkpoint_v29", "require_hardening_quote_sizing_authority_projection_v29",
    "prevent_hardening_quote_sizing_authority_update_v29", "prevent_hardening_quote_sizing_authority_delete_v29",
    "hardening_quotes", "idx_hardening_quotes_sizing_v29", "require_hardening_quote_version_projection_v29",
    "uq_hardening_quote_pair_v29", "uq_hardening_consent_pair_v29", "uq_hardening_model_call_slot_binding_v29",
    "hardening_child_budget_authorities", "uq_hardening_child_budget_authority_pair_v29",
    "idx_hardening_child_budget_status_deadline_v29", "idx_hardening_child_budget_fence_expiry_v29",
    "require_hardening_child_budget_authority_v29", "fence_hardening_child_budget_authority_update_v29",
    "prevent_hardening_child_budget_authority_delete_v29", "hardening_child_model_reservations",
    "uq_hardening_child_model_call_v29", "uq_hardening_child_model_settlement_v29",
    "idx_hardening_child_model_reservation_status_v29", "require_hardening_child_model_reservation_binding_v29",
    "fence_hardening_child_model_reservation_update_v29", "prevent_hardening_child_model_reservation_delete_v29",
    "hardening_paid_call_finalizations", "idx_hardening_paid_call_finalization_status_v29",
    "require_hardening_paid_call_finalization_binding_v29", "fence_hardening_paid_call_finalization_update_v29",
    "prevent_hardening_paid_call_finalization_delete_v29",
    "hardening_child_tool_actions", "idx_hardening_child_tool_actions_run_status_v29",
    "require_hardening_child_tool_action_binding_v29", "fence_hardening_child_tool_action_update_v29",
    "prevent_hardening_child_tool_action_delete_v29", "prevent_hardening_child_budget_limit_update_v29",
    "prevent_hardening_child_budget_topup_event_v29",
  ];
  for (const name of names) {
    const actual = db.query("SELECT sql FROM sqlite_master WHERE name=? AND type IN('table','index','trigger')").get(name) as { sql: string } | null;
    if (!actual?.sql || normalizeSchemaSql(actual.sql).replaceAll('"', '') !== expected.get(name)?.replaceAll('"', '')) throw new Error(`Engineer schema v29 has invalid ${name}`);
  }
  assertForeignKeys(db);
}

function assertHardeningRecoveryWorkerFenceShape(db: Database): void {
  const expected = new Map<string, string>();
  const pattern = /CREATE (?:UNIQUE )?(?:TABLE|INDEX|TRIGGER)\s+([A-Za-z0-9_]+)[\s\S]*?;\s*(?=CREATE |$)/g;
  for (const match of ENGINEER_DATABASE_MIGRATION_30_SQL.matchAll(pattern)) expected.set(match[1]!, normalizeSchemaSql(match[0]!));
  for (const name of ["hardening_recovery_worker_fences","idx_hardening_recovery_worker_fence_generation_v30",
    "require_hardening_recovery_worker_fence_child_v30","fence_hardening_recovery_worker_fence_update_v30",
    "prevent_hardening_recovery_worker_fence_delete_v30"]){
    const actual=db.query("SELECT sql FROM sqlite_master WHERE name=? AND type IN('table','index','trigger')").get(name) as {sql:string}|null;
    if(!actual?.sql||normalizeSchemaSql(actual.sql)!==expected.get(name))throw new Error(`Engineer schema v30 has invalid ${name}`);
  }
  assertForeignKeys(db);
}

function assertHardeningExecutionFencingShape(db: Database): void {
  const expected = new Map<string, string>();
  const pattern = /CREATE (?:UNIQUE )?(?:TABLE|INDEX|TRIGGER)\s+([A-Za-z0-9_]+)[\s\S]*?;\s*(?=CREATE |$)/g;
  for (const match of ENGINEER_DATABASE_MIGRATION_28_SQL.matchAll(pattern)) expected.set(match[1]!, normalizeSchemaSql(match[0]!));
  const names = [
    "hardening_start_claims", "idx_hardening_start_claims_recovery_v28",
    "require_hardening_start_claim_binding_v28", "fence_hardening_start_claim_update_v28",
    "prevent_hardening_start_claim_delete_v28", "hardening_model_call_slots",
    "idx_hardening_model_call_slots_child_v28", "require_hardening_model_call_slot_child_v28",
    "fence_hardening_model_call_slot_update_v28", "prevent_hardening_model_call_slot_delete_v28",
  ];
  if (expected.size !== names.length) throw new Error("Engineer schema v28 validator is missing exact definitions");
  for (const name of names) {
    const actual = db.query("SELECT sql FROM sqlite_master WHERE name=? AND type IN('table','index','trigger')").get(name) as { sql: string } | null;
    if (!actual?.sql || normalizeSchemaSql(actual.sql) !== expected.get(name)) throw new Error(`Engineer schema v28 has invalid ${name}`);
  }
  assertForeignKeys(db);
}

function assertVerifiedHardeningCandidateCheckpointShape(db: Database): void {
  const actual = db.query("SELECT sql FROM sqlite_master WHERE type='table' AND name='verified_candidate_checkpoints'")
    .get() as { sql: string } | null;
  const expected = ENGINEER_DATABASE_MIGRATION_27_SQL.match(
    /CREATE TABLE verified_candidate_checkpoints_v27[\s\S]*?;\s*(?=INSERT)/,
  )?.[0];
  const normalizeTable = (sql: string): string => normalizeSchemaSql(sql)
    .replaceAll('"', "")
    .replaceAll("VERIFIED_CANDIDATE_CHECKPOINTS_V27", "VERIFIED_CANDIDATE_CHECKPOINTS");
  if (!actual?.sql || !expected || normalizeTable(actual.sql) !== normalizeTable(expected)) {
    throw new Error("Engineer schema v27 has invalid verified_candidate_checkpoints authority");
  }
  const expectedObjects = [
    "idx_verified_candidate_checkpoints_run_created", "uq_verified_candidate_checkpoint_pair_v26",
    "uq_hardening_seed_attestation_pair_v27", "prevent_verified_candidate_checkpoints_update_v21",
    "prevent_verified_candidate_checkpoints_delete_v21", "require_verified_candidate_checkpoint_bindings_v21",
    "require_verified_candidate_checkpoint_version_v27",
  ];
  for (const name of expectedObjects) {
    const object = db.query("SELECT sql FROM sqlite_master WHERE name=? AND type IN ('index','trigger')").get(name) as { sql: string } | null;
    const definition = ENGINEER_DATABASE_MIGRATION_27_SQL.match(
      new RegExp(`CREATE (?:UNIQUE )?(?:INDEX|TRIGGER) ${name}[\\s\\S]*?;\\s*(?=CREATE |$)`),
    )?.[0];
    if (!object?.sql || !definition || normalizeSchemaSql(object.sql) !== normalizeSchemaSql(definition)) {
      throw new Error(`Engineer schema v27 has invalid ${name}`);
    }
  }
  const foreignKeys = db.query("PRAGMA foreign_key_list(verified_candidate_checkpoints)").all() as Array<{
    id: number; seq: number; table: string; from: string; to: string; on_delete: string;
  }>;
  const requirePair = (table: string, pairs: readonly (readonly [string, string])[]): void => {
    const matches = foreignKeys.filter((row) => row.table === table && row.on_delete === "RESTRICT");
    const grouped = new Map<number, typeof matches>();
    for (const row of matches) grouped.set(row.id, [...(grouped.get(row.id) ?? []), row]);
    if (![...grouped.values()].some((rows) => {
      const ordered = [...rows].sort((left, right) => left.seq - right.seq);
      return ordered.length === pairs.length && ordered.every((row, index) =>
        row.from === pairs[index]![0] && row.to === pairs[index]![1]);
    })) throw new Error(`Engineer schema v27 has invalid ${table} pair authority`);
  };
  requirePair("verified_candidate_checkpoints", [["parent_checkpoint_id", "id"], ["parent_checkpoint_hash", "checkpoint_hash"]]);
  requirePair("engineer_run_lineage", [["hardening_lineage_id", "id"], ["hardening_lineage_hash", "lineage_hash"]]);
  requirePair("hardening_seed_attestations", [["seed_attestation_id", "id"], ["seed_attestation_hash", "seed_attestation_hash"]]);
  const rows = db.query(`SELECT parent_checkpoint_id,parent_checkpoint_hash,hardening_lineage_id,
    hardening_lineage_hash,seed_attestation_id,seed_attestation_hash,checkpoint_json
    FROM verified_candidate_checkpoints`).all() as Array<Record<string, string | null>>;
  for (const row of rows) {
    const values = [row.parent_checkpoint_id, row.parent_checkpoint_hash, row.hardening_lineage_id,
      row.hardening_lineage_hash, row.seed_attestation_id, row.seed_attestation_hash];
    if (values.every((value) => value === null)) continue;
    if (!values.every((value) => value !== null)) throw new Error("Engineer schema v27 contains a partial hardening authority");
    let checkpoint: Record<string, unknown>;
    try { checkpoint = JSON.parse(String(row.checkpoint_json)) as Record<string, unknown>; }
    catch { throw new Error("Engineer schema v27 contains invalid hardening checkpoint JSON"); }
    for (const [jsonKey, column] of [
      ["parentCheckpointId", "parent_checkpoint_id"], ["parentCheckpointHash", "parent_checkpoint_hash"],
      ["hardeningLineageId", "hardening_lineage_id"], ["hardeningLineageHash", "hardening_lineage_hash"],
      ["seedAttestationId", "seed_attestation_id"], ["seedAttestationHash", "seed_attestation_hash"],
    ] as const) if (checkpoint[jsonKey] !== row[column]) throw new Error(`Engineer schema v27 ${column} projection mismatch`);
    if (checkpoint.schemaVersion !== 2 || checkpoint.policyVersion !== "verified-hardening-candidate-checkpoint-v2") {
      throw new Error("Engineer schema v27 contains invalid hardening checkpoint version");
    }
  }
  assertForeignKeys(db);
}

function assertHardeningStartShape(db: Database): void {
  const definitions = new Map<string, string>();
  const pattern = /CREATE (?:UNIQUE )?(?:TABLE|INDEX|TRIGGER)\s+([A-Za-z0-9_]+)[\s\S]*?;\s*(?=CREATE |$)/g;
  for (const match of ENGINEER_DATABASE_MIGRATION_26_SQL.matchAll(pattern)) definitions.set(match[1]!, normalizeSchemaSql(match[0]!));
  const required = [
    "uq_engineer_run_lineage_pair_v26", "uq_verified_candidate_checkpoint_pair_v26",
    "hardening_start_operations", "uq_hardening_start_operation_pair_v26", "idx_hardening_start_operations_child_created_v26",
    "hardening_seed_attestations", "idx_hardening_seed_attestations_child_created_v26",
    "require_hardening_start_operation_binding_v26", "require_hardening_seed_attestation_binding_v26",
    "prevent_hardening_start_operations_update_v26", "prevent_hardening_start_operations_delete_v26",
    "prevent_hardening_seed_attestations_update_v26", "prevent_hardening_seed_attestations_delete_v26",
  ];
  if (definitions.size !== required.length) throw new Error("Engineer schema v26 validator is missing exact definitions");
  for (const name of required) {
    const actual = db.query("SELECT sql FROM sqlite_master WHERE name=? AND type IN('table','index','trigger')").get(name) as {sql:string}|null;
    if (!actual?.sql || normalizeSchemaSql(actual.sql) !== definitions.get(name)) throw new Error(`Engineer schema v26 has invalid ${name}`);
  }
  const foreignKeys = db.query("PRAGMA foreign_key_check").all();
  if (foreignKeys.length !== 0) throw new Error("Engineer schema v26 has invalid foreign keys");
}

function assertHardeningChildBudgetShape(db: Database): void {
  const table=db.query("SELECT sql FROM sqlite_master WHERE type='table' AND name='run_budgets'").get() as {sql:string}|null;
  const expected=ENGINEER_DATABASE_MIGRATION_25_SQL.match(/CREATE TABLE run_budgets_v25[\s\S]*?;\s*(?=INSERT)/)?.[0];
  const actualSql=table?.sql?normalizeSchemaSql(table.sql).replace('CREATE TABLE "RUN_BUDGETS"','CREATE TABLE RUN_BUDGETS'):null;
  const expectedSql=expected?normalizeSchemaSql(expected).replace("CREATE TABLE RUN_BUDGETS_V25","CREATE TABLE RUN_BUDGETS"):null;
  if(!actualSql||!expectedSql||actualSql!==expectedSql) throw new Error("Engineer schema v25 has invalid run_budgets authority");
  const columns=new Map((db.query("PRAGMA table_info(run_budgets)").all() as Array<{name:string;type:string;notnull:number;pk:number;dflt_value:string|null}>).map((column)=>[column.name,column]));
  const revision=columns.get("revision");if(!revision||revision.type.toUpperCase()!=="INTEGER"||revision.notnull!==1||revision.dflt_value!=="1") throw new Error("Engineer schema v25 has invalid run_budgets.revision");
  assertForeignKeys(db);
}

function assertHardeningQuoteRequestShape(db: Database): void {
  const table = db.query("SELECT sql FROM sqlite_master WHERE type='table' AND name='hardening_quote_requests'").get() as { sql: string } | null;
  const expectedTable=ENGINEER_DATABASE_MIGRATION_24_SQL.match(/CREATE TABLE hardening_quote_requests[\s\S]*?;\s*(?=CREATE )/)?.[0];
  if (!table?.sql||!expectedTable||normalizeSchemaSql(table.sql)!==normalizeSchemaSql(expectedTable)) throw new Error("Engineer schema v24 has invalid hardening_quote_requests");
  const columns = new Map((db.query("PRAGMA table_info(hardening_quote_requests)").all() as Array<{name:string;type:string;notnull:number;pk:number}>).map((column)=>[column.name,column]));
  for (const name of ["id","request_hash","requester_user_id","parent_run_id","idempotency_key","quote_id","quote_hash","request_json","created_at"]) {
    const column=columns.get(name); if(!column||column.type.toUpperCase()!=="TEXT"||column.notnull!==1) throw new Error(`Engineer schema v24 has invalid hardening_quote_requests.${name}`);
  }
  for (const name of ["require_hardening_quote_request_binding_v24","prevent_hardening_quote_requests_update_v24","prevent_hardening_quote_requests_delete_v24"]) {
    const actual=db.query("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(name) as {sql:string}|null;
    const expected=ENGINEER_DATABASE_MIGRATION_24_SQL.match(new RegExp(`CREATE TRIGGER ${name}[\\s\\S]*?;\\s*(?=CREATE |$)`))?.[0];
    if(!actual?.sql||!expected||normalizeSchemaSql(actual.sql)!==normalizeSchemaSql(expected)) throw new Error(`Engineer schema v24 has invalid ${name}`);
  }
  const actualIndex=db.query("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_hardening_quote_requests_run_created_v24'").get() as {sql:string}|null;
  const expectedIndex=ENGINEER_DATABASE_MIGRATION_24_SQL.match(/CREATE INDEX idx_hardening_quote_requests_run_created_v24[\s\S]*?;/)?.[0];
  if(!actualIndex?.sql||!expectedIndex||normalizeSchemaSql(actualIndex.sql)!==normalizeSchemaSql(expectedIndex)) throw new Error("Engineer schema v24 has invalid quote request index");
  assertForeignKeys(db);
}

function normalizeSchemaSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim().replace(/;$/, "").toUpperCase();
}

function expectedV23Objects(type: "table" | "index" | "trigger"): Map<string, string> {
  const keyword = type === "table" ? "TABLE" : type === "index" ? "(?:UNIQUE )?INDEX" : "TRIGGER";
  const pattern = new RegExp(`CREATE ${keyword}\\s+([A-Za-z0-9_]+)[\\s\\S]*?;\\s*(?=CREATE |ALTER TABLE|$)`, "g");
  const result = new Map<string, string>();
  for (const match of ENGINEER_DATABASE_MIGRATION_23_SQL.matchAll(pattern)) result.set(match[1]!, normalizeSchemaSql(match[0]!));
  return result;
}

function assertAdvisoryHardeningShape(db: Database): void {
  const quoteV29 = Boolean(db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='hardening_quote_sizing_authorities'").get());
  const expectedTables = expectedV23Objects("table");
  const expectedIndexes = expectedV23Objects("index");
  const expectedTriggers = expectedV23Objects("trigger");
  const expectedTableNames = [
    "advisory_backlog_items", "hardening_quote_advisories", "hardening_quotes", "hardening_consents",
    "engineer_run_lineage", "advisory_backlog_events", "candidate_lineage_attestations",
    "publication_candidate_selections",
  ];
  if (expectedTables.size !== expectedTableNames.length) throw new Error("Engineer schema v23 validator is missing table definitions");
  for (const name of expectedTableNames) {
    const actual = db.query("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name) as { sql: string } | null;
    if (name === "hardening_quotes" && quoteV29) {
      if (!actual?.sql || !normalizeSchemaSql(actual.sql).includes("SCHEMA_VERSION IN (1,2)")) throw new Error("Engineer schema v29 has invalid hardening quote union");
      continue;
    }
    if (!actual?.sql || normalizeSchemaSql(actual.sql) !== expectedTables.get(name)) throw new Error(`Engineer schema v23 has invalid table ${name}`);
  }
  for (const [name, expected] of expectedIndexes) {
    const actual = db.query("SELECT sql FROM sqlite_master WHERE type='index' AND name=?").get(name) as { sql: string } | null;
    if (!actual?.sql || normalizeSchemaSql(actual.sql) !== expected) throw new Error(`Engineer schema v23 has invalid index ${name}`);
  }
  for (const [name, expected] of expectedTriggers) {
    const actual = db.query("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(name) as { sql: string } | null;
    if (!actual?.sql || normalizeSchemaSql(actual.sql) !== expected) throw new Error(`Engineer schema v23 has invalid trigger ${name}`);
  }
  for (const tableName of ["approval_requests", "git_operations"]) {
    const columns = new Map((db.query(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string; type: string; notnull: number; pk: number; dflt_value: string | null }>).map((column) => [column.name, column]));
    for (const name of ["publication_selection_id", "publication_selection_hash"]) {
      const column = columns.get(name);
      if (!column || column.type.toUpperCase() !== "TEXT" || column.notnull !== 0 || column.pk !== 0 || column.dflt_value !== null) throw new Error(`Engineer schema v23 has invalid ${tableName}.${name}`);
    }
    const foreignKeys = db.query(`PRAGMA foreign_key_list(${tableName})`).all() as Array<{ table: string; from: string; to: string; on_delete: string }>;
    for (const [from, to] of [["publication_selection_id", "id"], ["publication_selection_hash", "selection_hash"]] as const) {
      if (!foreignKeys.some((row) => row.table === "publication_candidate_selections" && row.from === from && row.to === to && row.on_delete === "RESTRICT")) throw new Error(`Engineer schema v23 has invalid ${tableName}.${from} foreign key`);
    }
  }
  const authorities = [
    { table: "advisory_backlog_items", json: "item_json", schema: AdvisoryBacklogItemSchema, idKey: "advisoryId", idColumn: "id", hashKey: "advisoryHash", hashColumn: "advisory_hash", projection: { advisoryId: "id", advisoryHash: "advisory_hash", schemaVersion: "schema_version", policyVersion: "policy_version", parentRunId: "parent_run_id", requesterUserId: "requester_user_id", repositoryId: "repository_id", parentCheckpointId: "parent_checkpoint_id", parentCheckpointHash: "parent_checkpoint_hash", requiredLaneContractHash: "required_lane_contract_hash", classificationHash: "classification_hash", reviewerSessionId: "reviewer_session_id", findingId: "finding_id", findingFingerprint: "finding_fingerprint", sourceClassificationHash: "source_classification_hash", reasonCode: "reason_code", reportedSeverity: "reported_severity", category: "category", file: "file", lineStart: "line_start", lineEnd: "line_end", actionability: "actionability", createdAt: "created_at" } },
    { table: "hardening_quotes", json: "quote_json", schema: HardeningQuoteSchema, idKey: "quoteId", idColumn: "id", hashKey: "quoteHash", hashColumn: "quote_hash", projection: { quoteId: "id", quoteHash: "quote_hash", schemaVersion: "schema_version", policyVersion: "policy_version", estimatorVersion: "estimator_version", parentRunId: "parent_run_id", requesterUserId: "requester_user_id", repositoryId: "repository_id", parentCheckpointId: "parent_checkpoint_id", parentCheckpointHash: "parent_checkpoint_hash", parentStateVersion: "parent_state_version", selectionHash: "selection_hash", "advisoryIds.length": "advisory_count", routingPolicyVersion: "routing_policy_version", pricingVersion: "pricing_version", "estimate.maxCostMicrousd": "max_cost_microusd", "estimate.maxTokens": "max_tokens", "estimate.maxTimeSeconds": "max_time_seconds", "estimate.maxPlannerCalls": "max_planner_calls", "estimate.maxBuilderCalls": "max_builder_calls", "estimate.maxReviewerCalls": "max_reviewer_calls", "estimate.automaticRepairCalls": "automatic_repair_calls", createdAt: "created_at", expiresAt: "expires_at" } },
    { table: "hardening_consents", json: "consent_json", schema: HardeningConsentSchema, idKey: "consentId", hashKey: "consentHash", hashColumn: "consent_hash", projection: { consentId: "id", consentHash: "consent_hash", schemaVersion: "schema_version", policyVersion: "policy_version", quoteId: "quote_id", quoteHash: "quote_hash", parentRunId: "parent_run_id", parentCheckpointId: "parent_checkpoint_id", parentCheckpointHash: "parent_checkpoint_hash", parentStateVersion: "parent_state_version", selectionHash: "selection_hash", requesterUserId: "requester_user_id", actorId: "actor_id", "authorizedBudget.costMicrousd": "cost_microusd", "authorizedBudget.tokens": "tokens", "authorizedBudget.timeSeconds": "time_seconds", "acknowledgements.separateRun": "acknowledge_separate_run", "acknowledgements.parentCandidateUnchanged": "acknowledge_parent_unchanged", "acknowledgements.noAutomaticRepair": "acknowledge_no_automatic_repair", "acknowledgements.noOverages": "acknowledge_no_overages", idempotencyKey: "idempotency_key", acceptedAt: "accepted_at", quoteExpiresAt: "quote_expires_at" } },
    { table: "engineer_run_lineage", json: "lineage_json", schema: EngineerRunLineageSchema, idKey: "lineageId", hashKey: "lineageHash", hashColumn: "lineage_hash", projection: { lineageId: "id", lineageHash: "lineage_hash", schemaVersion: "schema_version", policyVersion: "policy_version", relation: "relation", rootRunId: "root_run_id", parentRunId: "parent_run_id", childRunId: "child_run_id", requesterUserId: "requester_user_id", repositoryId: "repository_id", parentCheckpointId: "parent_checkpoint_id", parentCheckpointHash: "parent_checkpoint_hash", parentBaseCommitSha: "parent_base_commit_sha", seedResultCommitSha: "seed_result_commit_sha", quoteId: "quote_id", quoteHash: "quote_hash", consentId: "consent_id", consentHash: "consent_hash", selectionHash: "selection_hash", "budget.costMicrousd": "cost_microusd", "budget.tokens": "tokens", "budget.timeSeconds": "time_seconds", createdAt: "created_at" } },
    { table: "advisory_backlog_events", json: "event_json", schema: AdvisoryBacklogEventSchema, idKey: "eventId", hashKey: "eventHash", hashColumn: "event_hash", projection: { eventId: "id", eventHash: "event_hash", schemaVersion: "schema_version", policyVersion: "policy_version", advisoryId: "advisory_id", parentRunId: "parent_run_id", parentCheckpointId: "parent_checkpoint_id", parentCheckpointHash: "parent_checkpoint_hash", eventType: "event_type", revision: "revision", expectedRevision: "expected_revision", actorType: "actor_type", actorId: "actor_id", operationId: "operation_id", idempotencyKey: "idempotency_key", quoteId: "quote_id", consentId: "consent_id", hardeningLineageId: "hardening_lineage_id", childRunId: "child_run_id", childCheckpointId: "child_checkpoint_id", childCheckpointHash: "child_checkpoint_hash", stopReason: "stop_reason", rationale: "rationale", createdAt: "created_at" } },
    { table: "candidate_lineage_attestations", json: "attestation_json", schema: CandidateLineageAttestationSchema, idKey: "lineageAttestationId", idColumn: "lineage_attestation_id", hashKey: "lineageAttestationHash", hashColumn: "lineage_attestation_hash", projection: { lineageAttestationId: "lineage_attestation_id", lineageAttestationHash: "lineage_attestation_hash", schemaVersion: "schema_version", policyVersion: "policy_version", relation: "relation", lineageId: "lineage_id", lineageHash: "lineage_hash", rootRunId: "root_run_id", parentRunId: "parent_run_id", childRunId: "child_run_id", requesterUserId: "requester_user_id", repositoryId: "repository_id", parentCheckpointId: "parent_checkpoint_id", parentCheckpointHash: "parent_checkpoint_hash", parentResultCommitSha: "parent_result_commit_sha", childCheckpointId: "child_checkpoint_id", childCheckpointHash: "child_checkpoint_hash", childResultCommitSha: "child_result_commit_sha", parentBaseCommitSha: "parent_base_commit_sha", selectionHash: "selection_hash", quoteHash: "quote_hash", consentHash: "consent_hash", createdAt: "created_at" } },
    { table: "publication_candidate_selections", json: "selection_json", schema: PublicationCandidateSelectionSchema, idKey: "selectionId", idColumn: "id", hashKey: "selectionHash", hashColumn: "selection_hash", projection: { selectionId: "id", selectionHash: "selection_hash", schemaVersion: "schema_version", policyVersion: "policy_version", rootRunId: "root_run_id", candidateRunId: "candidate_run_id", requesterUserId: "requester_user_id", repositoryId: "repository_id", candidateKind: "candidate_kind", selectedCheckpointId: "selected_checkpoint_id", selectedCheckpointHash: "selected_checkpoint_hash", selectedResultCommitSha: "selected_result_commit_sha", candidateLineageAttestationId: "candidate_lineage_attestation_id", candidateLineageAttestationHash: "candidate_lineage_attestation_hash", revision: "revision", expectedRevision: "expected_revision", previousSelectionId: "previous_selection_id", reasonCode: "reason_code", actorId: "actor_id", idempotencyKey: "idempotency_key", selectedAt: "selected_at" } },
  ] as const;
  const atPath = (value: unknown, path: string): unknown => path.split(".").reduce<unknown>((current, key) => key === "length" && Array.isArray(current) ? current.length : current && typeof current === "object" ? (current as Record<string, unknown>)[key] : undefined, value);
  for (const authority of authorities) {
    const rows = db.query(`SELECT * FROM ${authority.table}`).all() as Array<Record<string, unknown>>;
    for (const row of rows) {
      let decoded: unknown;
      const entityJson = String(row[authority.json]);
      try { decoded = JSON.parse(entityJson); } catch { throw new Error(`Engineer schema v23 ${authority.table} contains invalid canonical JSON`); }
      const parsed = authority.schema.parse(decoded) as unknown as Record<string, unknown>;
      const idColumn = "idColumn" in authority ? authority.idColumn : "id";
      if (canonicalJson(parsed) !== entityJson || parsed[authority.idKey] !== row[idColumn] || parsed[authority.hashKey] !== row[authority.hashColumn]) throw new Error(`Engineer schema v23 ${authority.table} canonical authority mismatch`);
      for (const [path, column] of Object.entries(authority.projection)) {
        const value = atPath(parsed, path);
        const relational = typeof value === "boolean" ? (value ? 1 : 0) : value;
        if (relational !== row[column]) throw new Error(`Engineer schema v23 ${authority.table}.${column} projection mismatch`);
      }
    }
  }
  const advisoryRows = db.query(`SELECT a.id, a.actionability, a.file, m.manifest_json
    FROM advisory_backlog_items a
    JOIN verified_candidate_checkpoints c ON c.id=a.parent_checkpoint_id AND c.checkpoint_hash=a.parent_checkpoint_hash
    JOIN task_manifest_versions m ON m.run_id=c.run_id AND m.manifest_hash=c.manifest_hash`).all() as Array<{
      id: string; actionability: "ACTIONABLE" | "AUDIT_ONLY"; file: string | null; manifest_json: string;
    }>;
  for (const row of advisoryRows) {
    let manifest: unknown;
    try { manifest = JSON.parse(row.manifest_json); } catch { throw new Error(`Engineer schema v23 advisory ${row.id} has invalid manifest JSON`); }
    if (advisoryActionability(TaskManifestSchema.parse(manifest), row.file) !== row.actionability) {
      throw new Error(`Engineer schema v23 advisory ${row.id} actionability mismatch`);
    }
  }
  const quoteRows = db.query("SELECT id, quote_json, selection_hash FROM hardening_quotes").all() as Array<{
    id: string; quote_json: string; selection_hash: string;
  }>;
  for (const row of quoteRows) {
    const quote = HardeningQuoteSchema.parse(JSON.parse(row.quote_json));
    const mappings = db.query(`SELECT m.advisory_id, a.actionability FROM hardening_quote_advisories m
      JOIN advisory_backlog_items a ON a.id=m.advisory_id WHERE m.quote_id=? ORDER BY m.ordinal`).all(row.id) as Array<{
        advisory_id: string; actionability: string;
      }>;
    if (mappings.some((mapping) => mapping.actionability !== "ACTIONABLE") ||
        canonicalJson(mappings.map((mapping) => mapping.advisory_id)) !== canonicalJson(quote.advisoryIds) ||
        quote.selectionHash !== row.selection_hash) {
      throw new Error(`Engineer schema v23 hardening quote ${row.id} advisory selection mismatch`);
    }
  }
  const invalidConsentChronology = db.query(`SELECT c.id FROM hardening_consents c
    JOIN hardening_quotes q ON q.id=c.quote_id AND q.quote_hash=c.quote_hash
    WHERE c.accepted_at<q.created_at OR c.accepted_at>q.expires_at OR c.quote_expires_at!=q.expires_at LIMIT 1`).get() as { id: string } | null;
  if (invalidConsentChronology) throw new Error(`Engineer schema v23 consent ${invalidConsentChronology.id} chronology mismatch`);
  const signedRows = db.query(`SELECT attestation_json, statement_json, statement_hash,
    signature_algorithm, signature_key_id, signature FROM candidate_lineage_attestations`).all() as Array<{
      attestation_json: string; statement_json: string; statement_hash: string;
      signature_algorithm: string; signature_key_id: string; signature: string;
    }>;
  for (const row of signedRows) {
    let attestation: unknown; let statement: unknown;
    try { attestation = JSON.parse(row.attestation_json); statement = JSON.parse(row.statement_json); } catch {
      throw new Error("Engineer schema v23 candidate lineage contains invalid signed JSON");
    }
    SignedCandidateLineageAttestationSchema.parse({
      attestation, statement, statementJson: row.statement_json, statementHash: row.statement_hash,
      algorithm: row.signature_algorithm, keyId: row.signature_key_id, signature: row.signature,
    });
  }
  assertForeignKeys(db);
  const quick = db.query("PRAGMA quick_check").all() as Array<{ quick_check: string }>;
  if (quick.length !== 1 || quick[0]?.quick_check !== "ok") throw new Error("Engineer database failed v23 quick_check");
}

export function assertEngineerDatabaseVersionSupported(db: Database): void {
  const migrationsTable = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get() as { name: string } | null;
  if (!migrationsTable) return;
  const maximum = maximumAppliedVersion(db);
  if (maximum > ENGINEER_DATABASE_SCHEMA_VERSION) {
    throw new Error(`Engineer database schema ${maximum} is newer than supported ${ENGINEER_DATABASE_SCHEMA_VERSION}`);
  }
}

function maximumAppliedVersion(db: Database): number {
  const row = db.query("SELECT MAX(version) AS version FROM schema_migrations")
    .get() as { version: number | null };
  return row.version ?? 0;
}

function assertRequiredLaneContractShape(
  db: Database,
  contractHashNotNull: number,
  schemaVersionCheck: "V1_ONLY" | "V1_AND_V2",
): void {
  const table = db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'required_lane_contracts'")
    .get() as { sql: string } | null;
  if (!table?.sql) throw new Error("Engineer schema v15 is missing required_lane_contracts");

  const columnRows = db.query("PRAGMA table_info(required_lane_contracts)").all() as Array<{
    name: string; type: string; notnull: number; pk: number;
  }>;
  const columns = new Map(columnRows.map((column) => [column.name, column]));
  for (const [name, expected] of Object.entries({
    contract_hash: { type: "TEXT", notnull: contractHashNotNull, pk: 1 },
    run_id: { type: "TEXT", notnull: 1, pk: 0 },
    manifest_hash: { type: "TEXT", notnull: 1, pk: 0 },
    schema_version: { type: "INTEGER", notnull: 1, pk: 0 },
    contract_json: { type: "TEXT", notnull: 1, pk: 0 },
    created_at: { type: "TEXT", notnull: 1, pk: 0 },
  })) {
    const column = columns.get(name);
    if (!column || column.type.toUpperCase() !== expected.type || column.notnull !== expected.notnull || column.pk !== expected.pk) {
      throw new Error(`Engineer schema v15 has an invalid required_lane_contracts.${name} definition`);
    }
  }
  const normalizedSql = table.sql.replace(/\s+/g, " ").toUpperCase();
  const expectedVersionCheck = schemaVersionCheck === "V1_ONLY"
    ? "CHECK(SCHEMA_VERSION = 1)"
    : "CHECK(SCHEMA_VERSION IN (1, 2))";
  if (!normalizedSql.includes(expectedVersionCheck)) {
    throw new Error("Engineer schema v15 is missing the schema_version check");
  }

  const foreignKeys = db.query("PRAGMA foreign_key_list(required_lane_contracts)").all() as Array<{
    id: number; seq: number; table: string; from: string; to: string; on_delete: string;
  }>;
  const contractForeignKey = foreignKeys
    .filter((row) => row.table === "task_manifest_versions" && row.on_delete === "RESTRICT")
    .sort((left, right) => left.seq - right.seq);
  if (contractForeignKey.length !== 2 || contractForeignKey[0]?.from !== "run_id" || contractForeignKey[0]?.to !== "run_id" ||
      contractForeignKey[1]?.from !== "manifest_hash" || contractForeignKey[1]?.to !== "manifest_hash" ||
      contractForeignKey[0]?.id !== contractForeignKey[1]?.id) {
    throw new Error("Engineer schema v15 has an invalid Required Lane manifest foreign key");
  }

  const indexes = db.query("PRAGMA index_list(required_lane_contracts)").all() as Array<{
    name: string; unique: number; origin: string; partial: number;
  }>;
  const runIndex = indexes.find((index) => index.name === "idx_required_lane_contracts_run");
  if (!runIndex || runIndex.unique !== 0) throw new Error("Engineer schema v15 is missing idx_required_lane_contracts_run");
  const runIndexColumns = (db.query("PRAGMA index_info(idx_required_lane_contracts_run)").all() as Array<{ seqno: number; name: string }>)
    .sort((left, right) => left.seqno - right.seqno).map((column) => column.name);
  if (runIndexColumns.join(",") !== "run_id,created_at") {
    throw new Error("Engineer schema v15 has invalid idx_required_lane_contracts_run columns");
  }
  const uniqueBinding = indexes.some((index) => {
    if (index.unique !== 1 || index.partial !== 0 || index.origin !== "u") return false;
    const names = (db.query(`PRAGMA index_info(${JSON.stringify(index.name)})`).all() as Array<{ seqno: number; name: string }>)
      .sort((left, right) => left.seqno - right.seqno).map((column) => column.name);
    return names.join(",") === "run_id,manifest_hash";
  });
  if (!uniqueBinding) throw new Error("Engineer schema v15 is missing the unique run/manifest binding");

  const quickCheck = db.query("PRAGMA quick_check").all() as Array<{ quick_check: string }>;
  if (quickCheck.length !== 1 || quickCheck[0]?.quick_check !== "ok") {
    throw new Error("Engineer database failed quick_check after migration");
  }
}

function assertForeignKeys(db: Database): void {
  const violations = db.query("PRAGMA foreign_key_check").all();
  if (violations.length > 0) throw new Error("Engineer database migration produced foreign-key violations");
}

function assertReviewClassificationShape(db: Database): void {
  const table = db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'review_classification_batches'")
    .get() as { sql: string } | null;
  if (!table?.sql) throw new Error("Engineer schema v18 is missing review_classification_batches");
  const columns = new Map((db.query("PRAGMA table_info(review_classification_batches)").all() as Array<{
    name: string; type: string; notnull: number; pk: number;
  }>).map((column) => [column.name, column]));
  const expected = {
    classification_hash: { type: "TEXT", notnull: 1, pk: 1 },
    reviewer_session_id: { type: "TEXT", notnull: 1, pk: 0 },
    run_id: { type: "TEXT", notnull: 1, pk: 0 },
    contract_hash: { type: "TEXT", notnull: 1, pk: 0 },
    schema_version: { type: "INTEGER", notnull: 1, pk: 0 },
    policy_version: { type: "TEXT", notnull: 1, pk: 0 },
    raw_output_artifact_id: { type: "TEXT", notnull: 1, pk: 0 },
    raw_output_hash: { type: "TEXT", notnull: 1, pk: 0 },
    normalized_output_hash: { type: "TEXT", notnull: 1, pk: 0 },
    normalized_session_hash: { type: "TEXT", notnull: 1, pk: 0 },
    normalized_findings_hash: { type: "TEXT", notnull: 1, pk: 0 },
    reviewer_input_json: { type: "TEXT", notnull: 1, pk: 0 },
    normalized_output_json: { type: "TEXT", notnull: 1, pk: 0 },
    batch_json: { type: "TEXT", notnull: 1, pk: 0 },
    created_at: { type: "TEXT", notnull: 1, pk: 0 },
  } as const;
  if (columns.size !== Object.keys(expected).length) throw new Error("Engineer schema v18 has unexpected review classification columns");
  for (const [name, definition] of Object.entries(expected)) {
    const column = columns.get(name);
    if (!column || column.type.toUpperCase() !== definition.type || column.notnull !== definition.notnull || column.pk !== definition.pk) {
      throw new Error(`Engineer schema v18 has an invalid review_classification_batches.${name} definition`);
    }
  }
  if (!table.sql.replace(/\s+/g, " ").toUpperCase().includes("CHECK(SCHEMA_VERSION = 1)")) {
    throw new Error("Engineer schema v18 is missing the classification schema version check");
  }
  const foreignKeys = db.query("PRAGMA foreign_key_list(review_classification_batches)").all() as Array<{
    table: string; from: string; to: string; on_delete: string;
  }>;
  for (const expectedForeignKey of [
    { table: "reviewer_sessions", from: "reviewer_session_id", to: "id" },
    { table: "engineer_runs", from: "run_id", to: "id" },
    { table: "required_lane_contracts", from: "contract_hash", to: "contract_hash" },
    { table: "artifacts", from: "raw_output_artifact_id", to: "id" },
  ]) {
    if (!foreignKeys.some((row) => row.table === expectedForeignKey.table && row.from === expectedForeignKey.from &&
        row.to === expectedForeignKey.to && row.on_delete === "RESTRICT")) {
      throw new Error(`Engineer schema v18 has an invalid ${expectedForeignKey.from} foreign key`);
    }
  }
  const indexes = db.query("PRAGMA index_list(review_classification_batches)").all() as Array<{
    name: string; unique: number; origin: string; partial: number;
  }>;
  const runIndex = indexes.find((index) => index.name === "idx_review_classification_batches_run");
  const runIndexColumns = runIndex
    ? (db.query("PRAGMA index_info(idx_review_classification_batches_run)").all() as Array<{ seqno: number; name: string }>)
      .sort((left, right) => left.seqno - right.seqno).map((row) => row.name)
    : [];
  if (!runIndex || runIndex.unique !== 0 || runIndex.origin !== "c" || runIndex.partial !== 0 ||
      runIndexColumns.join(",") !== "run_id,created_at") {
    throw new Error("Engineer schema v18 is missing idx_review_classification_batches_run");
  }
  if (!indexes.some((index) => index.unique === 1 && index.origin === "u" && index.partial === 0 &&
    (db.query(`PRAGMA index_info(${JSON.stringify(index.name)})`).all() as Array<{ name: string }>).map((row) => row.name).join(",") === "reviewer_session_id")) {
    throw new Error("Engineer schema v18 is missing the unique Reviewer session binding");
  }
  const normalizeTriggerSql = (sql: string) => sql.replace(/\s+/g, " ").trim().replace(/;$/, "")
    .replace(/\(\s+/g, "(").replace(/\s+\)/g, ")")
    .replace(/\s*!=\s*/g, "!=").replace(/\s*=\s*/g, "=").toUpperCase();
  const triggerRows = db.query("SELECT name, sql FROM sqlite_master WHERE type = 'trigger'").all() as Array<{ name: string; sql: string }>;
  const triggers = new Map(triggerRows.map((row) => [row.name, normalizeTriggerSql(row.sql)]));
  for (const trigger of [
    "prevent_reviewer_sessions_update_v18", "prevent_reviewer_sessions_delete_v18",
    "prevent_review_findings_update_v18", "prevent_review_findings_delete_v18",
    "prevent_review_classification_batches_update_v18", "prevent_review_classification_batches_delete_v18",
    "prevent_review_finding_classifications_update_v18", "prevent_review_finding_classifications_delete_v18",
    "require_complete_review_classification_batch_v18",
    "prevent_sealed_review_classification_insert_v18",
    "prevent_sealed_review_finding_insert_v18",
  ]) {
    if (!triggers.has(trigger)) throw new Error(`Engineer schema v18 is missing immutable trigger ${trigger}`);
  }
  const expectedTriggers: Record<string, string> = {
    require_complete_review_classification_batch_v18: `CREATE TRIGGER require_complete_review_classification_batch_v18
      BEFORE INSERT ON review_classification_batches BEGIN
        SELECT CASE WHEN
          (SELECT COUNT(*) FROM review_findings WHERE reviewer_session_id = NEW.reviewer_session_id) !=
          (SELECT COUNT(*) FROM review_finding_classifications WHERE batch_hash = NEW.classification_hash)
          OR EXISTS (SELECT 1 FROM review_findings f LEFT JOIN review_finding_classifications c
            ON c.finding_id = f.id AND c.reviewer_session_id = f.reviewer_session_id AND c.batch_hash = NEW.classification_hash
            WHERE f.reviewer_session_id = NEW.reviewer_session_id AND c.finding_id IS NULL)
        THEN RAISE(ABORT, 'review classification mapping is incomplete') END;
      END`,
    prevent_sealed_review_classification_insert_v18: `CREATE TRIGGER prevent_sealed_review_classification_insert_v18
      BEFORE INSERT ON review_finding_classifications
      WHEN EXISTS (SELECT 1 FROM review_classification_batches WHERE classification_hash = NEW.batch_hash) BEGIN
        SELECT RAISE(ABORT, 'sealed review classification batches cannot accept new findings'); END`,
    prevent_sealed_review_finding_insert_v18: `CREATE TRIGGER prevent_sealed_review_finding_insert_v18
      BEFORE INSERT ON review_findings
      WHEN EXISTS (SELECT 1 FROM review_classification_batches WHERE reviewer_session_id = NEW.reviewer_session_id) BEGIN
        SELECT RAISE(ABORT, 'sealed review sessions cannot accept new findings'); END`,
    prevent_reviewer_sessions_update_v18: `CREATE TRIGGER prevent_reviewer_sessions_update_v18 BEFORE UPDATE ON reviewer_sessions BEGIN SELECT RAISE(ABORT, 'reviewer_sessions are immutable'); END`,
    prevent_reviewer_sessions_delete_v18: `CREATE TRIGGER prevent_reviewer_sessions_delete_v18 BEFORE DELETE ON reviewer_sessions BEGIN SELECT RAISE(ABORT, 'reviewer_sessions are immutable'); END`,
    prevent_review_findings_update_v18: `CREATE TRIGGER prevent_review_findings_update_v18 BEFORE UPDATE ON review_findings BEGIN SELECT RAISE(ABORT, 'review_findings are immutable'); END`,
    prevent_review_findings_delete_v18: `CREATE TRIGGER prevent_review_findings_delete_v18 BEFORE DELETE ON review_findings BEGIN SELECT RAISE(ABORT, 'review_findings are immutable'); END`,
    prevent_review_classification_batches_update_v18: `CREATE TRIGGER prevent_review_classification_batches_update_v18 BEFORE UPDATE ON review_classification_batches BEGIN SELECT RAISE(ABORT, 'review classifications are immutable'); END`,
    prevent_review_classification_batches_delete_v18: `CREATE TRIGGER prevent_review_classification_batches_delete_v18 BEFORE DELETE ON review_classification_batches BEGIN SELECT RAISE(ABORT, 'review classifications are immutable'); END`,
    prevent_review_finding_classifications_update_v18: `CREATE TRIGGER prevent_review_finding_classifications_update_v18 BEFORE UPDATE ON review_finding_classifications BEGIN SELECT RAISE(ABORT, 'review finding classifications are immutable'); END`,
    prevent_review_finding_classifications_delete_v18: `CREATE TRIGGER prevent_review_finding_classifications_delete_v18 BEFORE DELETE ON review_finding_classifications BEGIN SELECT RAISE(ABORT, 'review finding classifications are immutable'); END`,
  };
  for (const [name, expectedSql] of Object.entries(expectedTriggers)) {
    if (triggers.get(name) !== normalizeTriggerSql(expectedSql)) {
      throw new Error(`Engineer schema v18 has an invalid trigger ${name}`);
    }
  }
  const itemTable = db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'review_finding_classifications'")
    .get() as { sql: string } | null;
  if (!itemTable?.sql) throw new Error("Engineer schema v18 is missing review_finding_classifications");
  const itemColumns = (db.query("PRAGMA table_info(review_finding_classifications)").all() as Array<{
    name: string; type: string; notnull: number; pk: number;
  }>).map((row) => `${row.name}:${row.type.toUpperCase()}:${row.notnull}:${row.pk}`);
  const expectedItemColumns = [
    "classification_hash:TEXT:1:1", "batch_hash:TEXT:1:0", "reviewer_session_id:TEXT:1:0", "finding_id:TEXT:1:0",
    "finding_fingerprint:TEXT:1:0", "disposition:TEXT:1:0", "authority:TEXT:1:0", "reason_code:TEXT:1:0",
    "classification_json:TEXT:1:0",
  ];
  if (itemColumns.join("|") !== expectedItemColumns.join("|")) {
    throw new Error("Engineer schema v18 has invalid review_finding_classifications columns");
  }
  const itemSql = itemTable.sql.replace(/\s+/g, " ").toUpperCase();
  if (!itemSql.includes("CHECK(DISPOSITION IN ('BLOCKING', 'HUMAN_REQUIRED', 'ADVISORY'))") ||
      !itemSql.includes("DEFERRABLE INITIALLY DEFERRED")) {
    throw new Error("Engineer schema v18 has invalid review classification checks or deferral");
  }
  const itemForeignKeys = db.query("PRAGMA foreign_key_list(review_finding_classifications)").all() as Array<{
    id: number; seq: number; table: string; from: string; to: string; on_delete: string;
  }>;
  const batchForeignKey = itemForeignKeys.find((row) => row.table === "review_classification_batches" &&
    row.from === "batch_hash" && row.to === "classification_hash" && row.on_delete === "RESTRICT");
  const findingForeignKey = itemForeignKeys.filter((row) => row.table === "review_findings" && row.on_delete === "RESTRICT")
    .sort((left, right) => left.seq - right.seq);
  if (!batchForeignKey || findingForeignKey.length !== 2 || findingForeignKey[0]?.from !== "finding_id" ||
      findingForeignKey[0]?.to !== "id" || findingForeignKey[1]?.from !== "reviewer_session_id" ||
      findingForeignKey[1]?.to !== "reviewer_session_id" || findingForeignKey[0]?.id !== findingForeignKey[1]?.id) {
    throw new Error("Engineer schema v18 has invalid review classification foreign keys");
  }
  const itemIndexes = db.query("PRAGMA index_list(review_finding_classifications)").all() as Array<{
    name: string; unique: number; origin: string; partial: number;
  }>;
  const exactUnique = itemIndexes.some((index) => index.unique === 1 && index.origin === "u" && index.partial === 0 &&
    (db.query(`PRAGMA index_info(${JSON.stringify(index.name)})`).all() as Array<{ seqno: number; name: string }>)
      .sort((left, right) => left.seqno - right.seqno).map((row) => row.name).join(",") === "batch_hash,finding_id");
  if (!exactUnique) throw new Error("Engineer schema v18 is missing exact batch/finding uniqueness");
}

function assertApprovalClassificationShape(db: Database): void {
  const table = db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'approval_requests'")
    .get() as { sql: string } | null;
  if (!table?.sql) throw new Error("Engineer schema v19 is missing approval_requests");
  const columns = new Map((db.query("PRAGMA table_info(approval_requests)").all() as Array<{
    name: string; type: string; notnull: number;
  }>).map((column) => [column.name, column]));
  for (const name of ["reviewer_session_id", "classification_hash", "classification_result"]) {
    const column = columns.get(name);
    if (!column || column.type.toUpperCase() !== "TEXT" || column.notnull !== 0) {
      throw new Error(`Engineer schema v19 has an invalid approval_requests.${name} definition`);
    }
  }
  const normalized = table.sql.replace(/\s+/g, " ").toUpperCase();
  if (!normalized.includes("CHECK(CLASSIFICATION_RESULT IN ('READY_WITH_ADVISORIES', 'READY'))")) {
    throw new Error("Engineer schema v19 has an invalid approval classification result check");
  }
  const foreignKeys = db.query("PRAGMA foreign_key_list(approval_requests)").all() as Array<{
    table: string; from: string; to: string; on_delete: string;
  }>;
  for (const expected of [
    { table: "reviewer_sessions", from: "reviewer_session_id", to: "id" },
    { table: "review_classification_batches", from: "classification_hash", to: "classification_hash" },
  ]) {
    if (!foreignKeys.some((row) => row.table === expected.table && row.from === expected.from &&
        row.to === expected.to && row.on_delete === "RESTRICT")) {
      throw new Error(`Engineer schema v19 has an invalid ${expected.from} foreign key`);
    }
  }
}

function assertBuilderDispatchClaimShape(db: Database): void {
  const table = db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'builder_dispatch_claims'")
    .get() as { sql: string } | null;
  if (!table?.sql) throw new Error("Engineer schema v20 is missing builder_dispatch_claims");
  const columns = (db.query("PRAGMA table_info(builder_dispatch_claims)").all() as Array<{
    name: string; type: string; notnull: number; pk: number;
  }>).map((column) => `${column.name}:${column.type.toUpperCase()}:${column.notnull}:${column.pk}`);
  const expected = [
    "run_id:TEXT:1:1", "input_hash:TEXT:1:2", "agent_execution_id:TEXT:1:0", "model_tier:TEXT:1:0",
    "worker_owner_id:TEXT:0:0", "worker_fencing_token:INTEGER:0:0", "claimed_at:TEXT:1:0",
  ];
  if (columns.join("|") !== expected.join("|")) throw new Error("Engineer schema v20 has invalid builder dispatch claim columns");
  const normalized = table.sql.replace(/\s+/g, " ").toUpperCase();
  if (!normalized.includes("CHECK(MODEL_TIER = 'GPT-5.6_TERRA')") ||
      !normalized.includes("WORKER_OWNER_ID IS NULL AND WORKER_FENCING_TOKEN IS NULL") ||
      !normalized.includes("WORKER_OWNER_ID IS NOT NULL AND WORKER_FENCING_TOKEN IS NOT NULL")) {
    throw new Error("Engineer schema v20 has invalid Builder model or worker fencing checks");
  }
  const foreignKeys = db.query("PRAGMA foreign_key_list(builder_dispatch_claims)").all() as Array<{
    table: string; from: string; to: string; on_delete: string;
  }>;
  for (const expectedForeignKey of [
    { table: "engineer_runs", from: "run_id", to: "id" },
    { table: "agent_executions", from: "agent_execution_id", to: "id" },
  ]) {
    if (!foreignKeys.some((row) => row.table === expectedForeignKey.table && row.from === expectedForeignKey.from &&
        row.to === expectedForeignKey.to && row.on_delete === "RESTRICT")) {
      throw new Error(`Engineer schema v20 has invalid ${expectedForeignKey.from} foreign key`);
    }
  }
  const indexes = db.query("PRAGMA index_list(builder_dispatch_claims)").all() as Array<{ name: string; unique: number }>;
  if (!indexes.some((index) => index.name === "idx_builder_dispatch_claims_agent" && index.unique === 0)) {
    throw new Error("Engineer schema v20 is missing the Builder claim agent index");
  }
  const exactAgentUnique = (db.query("PRAGMA index_list(builder_dispatch_claims)").all() as Array<{
    name: string; unique: number; origin: string; partial: number;
  }>).some((index) => index.unique === 1 && index.origin === "u" && index.partial === 0 &&
    (db.query(`PRAGMA index_info(${JSON.stringify(index.name)})`).all() as Array<{ seqno: number; name: string }>)
      .sort((left, right) => left.seqno - right.seqno).map((column) => column.name).join(",") === "agent_execution_id");
  if (!exactAgentUnique) throw new Error("Engineer schema v20 is missing exact unique Builder claim agent binding");
  const normalize = (sql: string) => sql.replace(/\s+/g, " ").trim().replace(/;$/, "").toUpperCase();
  const triggers = new Map((db.query("SELECT name, sql FROM sqlite_master WHERE type = 'trigger'").all() as Array<{ name: string; sql: string }>)
    .map((row) => [row.name, normalize(row.sql)]));
  const expectedTriggers: Record<string, string> = {
    require_valid_builder_dispatch_claim_v20: `CREATE TRIGGER require_valid_builder_dispatch_claim_v20
      BEFORE INSERT ON builder_dispatch_claims BEGIN
        SELECT CASE WHEN NOT EXISTS (
          SELECT 1 FROM agent_executions
          WHERE id = NEW.agent_execution_id AND run_id = NEW.run_id
            AND role = 'BUILDER' AND model_tier = NEW.model_tier
            AND input_hash = NEW.input_hash AND status = 'RUNNING'
            AND output_artifact_id IS NULL
        ) THEN RAISE(ABORT, 'builder dispatch claim does not match its running agent') END;
      END`,
    prevent_builder_dispatch_claims_update_v20: `CREATE TRIGGER prevent_builder_dispatch_claims_update_v20
      BEFORE UPDATE ON builder_dispatch_claims BEGIN
        SELECT RAISE(ABORT, 'builder dispatch claims are immutable');
      END`,
    prevent_builder_dispatch_claims_delete_v20: `CREATE TRIGGER prevent_builder_dispatch_claims_delete_v20
      BEFORE DELETE ON builder_dispatch_claims BEGIN
        SELECT RAISE(ABORT, 'builder dispatch claims are immutable');
      END`,
  };
  for (const [name, sql] of Object.entries(expectedTriggers)) {
    if (triggers.get(name) !== normalize(sql)) throw new Error(`Engineer schema v20 has invalid immutable trigger ${name}`);
  }
}

function assertVerifiedCandidateCheckpointShape(db: Database): void {
  const table = db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'verified_candidate_checkpoints'")
    .get() as { sql: string } | null;
  if (!table?.sql) throw new Error("Engineer schema v21 is missing verified_candidate_checkpoints");
  const columns = (db.query("PRAGMA table_info(verified_candidate_checkpoints)").all() as Array<{
    name: string; type: string; notnull: number; pk: number;
  }>).map((column) => `${column.name}:${column.type.toUpperCase()}:${column.notnull}:${column.pk}`);
  const legacyExpected = [
    "id:TEXT:0:1", "checkpoint_hash:TEXT:1:0", "parent_checkpoint_id:TEXT:0:0", "run_id:TEXT:1:0",
    "requester_user_id:TEXT:1:0", "repository_id:TEXT:1:0", "required_lane_contract_hash:TEXT:1:0",
    "manifest_hash:TEXT:1:0", "base_commit_sha:TEXT:1:0", "result_commit_sha:TEXT:1:0", "diff_hash:TEXT:1:0",
    "reviewer_session_id:TEXT:1:0", "classification_hash:TEXT:1:0", "classification_result:TEXT:1:0",
    "evidence_bundle_id:TEXT:1:0", "evidence_bundle_hash:TEXT:1:0", "environment_digest:TEXT:1:0",
    "checkpoint_json:TEXT:1:0", "statement_json:TEXT:1:0", "statement_hash:TEXT:1:0",
    "signature_algorithm:TEXT:1:0", "signature_key_id:TEXT:1:0", "signature:TEXT:1:0", "created_at:TEXT:1:0",
  ];
  const v27Expected = [
    "id:TEXT:0:1", "checkpoint_hash:TEXT:1:0", "parent_checkpoint_id:TEXT:0:0",
    "parent_checkpoint_hash:TEXT:0:0", "hardening_lineage_id:TEXT:0:0", "hardening_lineage_hash:TEXT:0:0",
    "seed_attestation_id:TEXT:0:0", "seed_attestation_hash:TEXT:0:0",
    ...legacyExpected.slice(3),
  ];
  const isV27 = columns.includes("parent_checkpoint_hash:TEXT:0:0");
  const expected = isV27 ? v27Expected : legacyExpected;
  if (columns.join("|") !== expected.join("|")) throw new Error("Engineer schema v21 has invalid checkpoint columns");
  const normalized = table.sql.replace(/\s+/g, " ").toUpperCase();
  if ((!isV27 && !normalized.includes("CHECK(PARENT_CHECKPOINT_ID IS NULL)")) ||
      !normalized.includes("CHECK(CLASSIFICATION_RESULT IN ('READY', 'READY_WITH_ADVISORIES'))")) {
    throw new Error("Engineer schema v21 has invalid checkpoint checks");
  }
  const foreignKeys = db.query("PRAGMA foreign_key_list(verified_candidate_checkpoints)").all() as Array<{
    id: number; seq: number; table: string; from: string; to: string; on_delete: string;
  }>;
  for (const expectedForeignKey of [
    ["engineer_runs", "run_id", "id"], ["users", "requester_user_id", "id"],
    ["repository_connections", "repository_id", "id"], ["required_lane_contracts", "required_lane_contract_hash", "contract_hash"],
    ["reviewer_sessions", "reviewer_session_id", "id"], ["review_classification_batches", "classification_hash", "classification_hash"],
    ["evidence_bundles", "evidence_bundle_id", "id"],
  ] as const) {
    if (!foreignKeys.some((row) => row.table === expectedForeignKey[0] && row.from === expectedForeignKey[1] &&
        row.to === expectedForeignKey[2] && row.on_delete === "RESTRICT")) {
      throw new Error(`Engineer schema v21 has invalid ${expectedForeignKey[1]} foreign key`);
    }
  }
  const manifestForeignKey = foreignKeys.filter((row) => row.table === "task_manifest_versions" && row.on_delete === "RESTRICT")
    .sort((left, right) => left.seq - right.seq);
  if (manifestForeignKey.length !== 2 || manifestForeignKey[0]?.from !== "run_id" || manifestForeignKey[0]?.to !== "run_id" ||
      manifestForeignKey[1]?.from !== "manifest_hash" || manifestForeignKey[1]?.to !== "manifest_hash" ||
      manifestForeignKey[0]?.id !== manifestForeignKey[1]?.id) {
    throw new Error("Engineer schema v21 has invalid checkpoint manifest foreign key");
  }
  const indexes = db.query("PRAGMA index_list(verified_candidate_checkpoints)").all() as Array<{
    name: string; unique: number; origin: string; partial: number;
  }>;
  for (const uniqueColumn of ["checkpoint_hash", "classification_hash", "evidence_bundle_id"]) {
    const exact = indexes.some((index) => index.unique === 1 && index.origin === "u" && index.partial === 0 &&
      (db.query(`PRAGMA index_info(${JSON.stringify(index.name)})`).all() as Array<{ seqno: number; name: string }>)
        .sort((left, right) => left.seqno - right.seqno).map((row) => row.name).join(",") === uniqueColumn);
    if (!exact) throw new Error(`Engineer schema v21 is missing exact unique ${uniqueColumn}`);
  }
  const runIndex = indexes.find((index) => index.name === "idx_verified_candidate_checkpoints_run_created");
  const runColumns = runIndex ? (db.query("PRAGMA index_info(idx_verified_candidate_checkpoints_run_created)").all() as Array<{ seqno: number; name: string }>)
    .sort((left, right) => left.seqno - right.seqno).map((row) => row.name).join(",") : "";
  if (!runIndex || runIndex.unique !== 0 || runIndex.origin !== "c" || runIndex.partial !== 0 || runColumns !== "run_id,created_at") {
    throw new Error("Engineer schema v21 is missing exact checkpoint run index");
  }
  for (const tableName of ["approval_requests", "git_operations"]) {
    const linkedColumns = new Map((db.query(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string; type: string; notnull: number }>)
      .map((column) => [column.name, column]));
    for (const name of ["verified_checkpoint_id", "verified_checkpoint_hash"]) {
      const column = linkedColumns.get(name);
      if (!column || column.type.toUpperCase() !== "TEXT" || column.notnull !== 0) {
        throw new Error(`Engineer schema v21 has invalid ${tableName}.${name}`);
      }
    }
    const linkForeignKeys = db.query(`PRAGMA foreign_key_list(${tableName})`).all() as Array<{
      table: string; from: string; to: string; on_delete: string;
    }>;
    for (const [from, to] of [["verified_checkpoint_id", "id"], ["verified_checkpoint_hash", "checkpoint_hash"]] as const) {
      if (!linkForeignKeys.some((row) => row.table === "verified_candidate_checkpoints" && row.from === from &&
          row.to === to && row.on_delete === "RESTRICT")) {
        throw new Error(`Engineer schema v21 has invalid ${tableName}.${from} foreign key`);
      }
    }
  }
  const normalize = (sql: string) => sql.replace(/\s+/g, " ").trim().replace(/;$/, "").toUpperCase();
  const triggers = new Map((db.query("SELECT name, sql FROM sqlite_master WHERE type = 'trigger'").all() as Array<{ name: string; sql: string }>)
    .map((row) => [row.name, normalize(row.sql)]));
  const requiredTriggers = [
    "prevent_run_state_events_update_v21", "prevent_run_state_events_delete_v21",
    "prevent_verified_candidate_checkpoints_update_v21", "prevent_verified_candidate_checkpoints_delete_v21",
    "require_verified_candidate_checkpoint_bindings_v21", "require_approval_checkpoint_pair_v21",
    "require_approval_checkpoint_pair_update_v21", "require_approval_checkpoint_match_v21",
    "require_approval_checkpoint_match_update_v21", "prevent_approval_checkpoint_rebinding_v21", "require_git_checkpoint_pair_v21",
    "require_git_checkpoint_pair_update_v21", "require_git_checkpoint_match_v21", "require_git_checkpoint_match_update_v21",
    "prevent_git_checkpoint_rebinding_v21",
  ];
  for (const name of requiredTriggers) if (!triggers.has(name)) throw new Error(`Engineer schema v21 is missing trigger ${name}`);
  const expectedTriggers = new Map<string, string>();
  const triggerPattern = /CREATE TRIGGER\s+([A-Za-z0-9_]+)[\s\S]*?\n\s*END;\s*(?=CREATE TRIGGER|ALTER TABLE|$)/g;
  for (const match of ENGINEER_DATABASE_MIGRATION_21_SQL.matchAll(triggerPattern)) {
    expectedTriggers.set(match[1]!, normalize(match[0]!));
  }
  if (expectedTriggers.size !== requiredTriggers.length) {
    throw new Error("Engineer schema v21 validator is missing expected trigger definitions");
  }
  for (const name of requiredTriggers) {
    if (triggers.get(name) !== expectedTriggers.get(name)) throw new Error(`Engineer schema v21 has invalid trigger ${name}`);
  }
}

function assertApprovalDecisionCheckpointShape(db: Database): void {
  const normalizeTableSql = (sql: string) => sql.replace(/\s+/g, " ").trim().toUpperCase();
  const requestTable = db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'approval_requests'")
    .get() as { sql: string } | null;
  const decisionTable = db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'approval_decisions'")
    .get() as { sql: string } | null;
  if (!requestTable?.sql || !normalizeTableSql(requestTable.sql)
    .includes("APPROVAL_REVISION INTEGER NOT NULL DEFAULT 0 CHECK(APPROVAL_REVISION >= 0)")) {
    throw new Error("Engineer schema v22 has invalid approval_requests.approval_revision constraint");
  }
  if (!decisionTable?.sql || !normalizeTableSql(decisionTable.sql)
    .includes("EXPECTED_APPROVAL_REVISION INTEGER CHECK(EXPECTED_APPROVAL_REVISION IS NULL OR EXPECTED_APPROVAL_REVISION >= 0)")) {
    throw new Error("Engineer schema v22 has invalid approval_decisions.expected_approval_revision constraint");
  }
  const columns = new Map((db.query("PRAGMA table_info(approval_decisions)").all() as Array<{
    name: string; type: string; notnull: number; pk: number;
  }>).map((column) => [column.name, column]));
  for (const name of ["expected_verified_checkpoint_id", "expected_verified_checkpoint_hash"]) {
    const column = columns.get(name);
    if (!column || column.type.toUpperCase() !== "TEXT" || column.notnull !== 0 || column.pk !== 0) {
      throw new Error(`Engineer schema v22 has invalid approval_decisions.${name}`);
    }
  }
  const revision = columns.get("expected_approval_revision");
  if (!revision || revision.type.toUpperCase() !== "INTEGER" || revision.notnull !== 0 || revision.pk !== 0) {
    throw new Error("Engineer schema v22 has invalid approval_decisions.expected_approval_revision");
  }
  const requestColumns = new Map((db.query("PRAGMA table_info(approval_requests)").all() as Array<{
    name: string; type: string; notnull: number; pk: number; dflt_value: string | null;
  }>).map((column) => [column.name, column]));
  const requestRevision = requestColumns.get("approval_revision");
  if (!requestRevision || requestRevision.type.toUpperCase() !== "INTEGER" || requestRevision.notnull !== 1 ||
      requestRevision.pk !== 0 || requestRevision.dflt_value !== "0") {
    throw new Error("Engineer schema v22 has invalid approval_requests.approval_revision");
  }
  const foreignKeys = db.query("PRAGMA foreign_key_list(approval_decisions)").all() as Array<{
    table: string; from: string; to: string; on_delete: string;
  }>;
  for (const [from, to] of [
    ["expected_verified_checkpoint_id", "id"],
    ["expected_verified_checkpoint_hash", "checkpoint_hash"],
  ] as const) {
    if (!foreignKeys.some((row) => row.table === "verified_candidate_checkpoints" && row.from === from &&
        row.to === to && row.on_delete === "RESTRICT")) {
      throw new Error(`Engineer schema v22 has invalid approval_decisions.${from} foreign key`);
    }
  }
  const indexes = db.query("PRAGMA index_list(approval_decisions)").all() as Array<{
    name: string; unique: number; origin: string; partial: number;
  }>;
  const checkpointIndex = indexes.find((index) => index.name === "idx_approval_decisions_checkpoint_v22");
  const checkpointColumns = checkpointIndex
    ? (db.query("PRAGMA index_info(idx_approval_decisions_checkpoint_v22)").all() as Array<{ seqno: number; name: string }>)
      .sort((left, right) => left.seqno - right.seqno).map((row) => row.name).join(",")
    : "";
  if (!checkpointIndex || checkpointIndex.unique !== 0 || checkpointIndex.origin !== "c" ||
      checkpointIndex.partial !== 0 || checkpointColumns !==
      "expected_verified_checkpoint_id,expected_verified_checkpoint_hash") {
    throw new Error("Engineer schema v22 is missing exact approval decision checkpoint index");
  }
  const normalize = (sql: string) => sql.replace(/\s+/g, " ").trim().replace(/;$/, "").toUpperCase();
  const triggers = new Map((db.query("SELECT name, sql FROM sqlite_master WHERE type = 'trigger'").all() as Array<{
    name: string; sql: string;
  }>).map((row) => [row.name, normalize(row.sql)]));
  const requiredTriggers = [
    "require_new_approval_checkpoint_v22", "require_new_git_checkpoint_v22",
    "require_new_approval_decision_checkpoint_v22", "require_approval_decision_checkpoint_pair_update_v22",
    "require_approval_decision_checkpoint_match_v22", "require_approval_decision_checkpoint_match_update_v22",
    "prevent_approval_decision_checkpoint_rebinding_v22",
  ];
  const expectedTriggers = new Map<string, string>();
  const triggerPattern = /CREATE TRIGGER\s+([A-Za-z0-9_]+)[\s\S]*?\n\s*END;\s*(?=CREATE TRIGGER|$)/g;
  for (const match of ENGINEER_DATABASE_MIGRATION_22_SQL.matchAll(triggerPattern)) {
    expectedTriggers.set(match[1]!, normalize(match[0]!));
  }
  if (expectedTriggers.size !== requiredTriggers.length) {
    throw new Error("Engineer schema v22 validator is missing expected trigger definitions");
  }
  for (const name of requiredTriggers) {
    if (triggers.get(name) !== expectedTriggers.get(name)) throw new Error(`Engineer schema v22 has invalid trigger ${name}`);
  }
}

function assertResolutionDeskShape(db: Database): void {
  const expected = new Map<string, string>();
  const pattern = /CREATE (?:UNIQUE )?(?:TABLE|INDEX|TRIGGER)\s+([A-Za-z0-9_]+)[\s\S]*?;\s*(?=CREATE |$)/g;
  for (const match of ENGINEER_DATABASE_MIGRATION_31_SQL.matchAll(pattern)) expected.set(match[1]!, normalizeSchemaSql(match[0]!));
  const names = [
    "resolution_cases", "uq_resolution_case_pair_v31", "idx_resolution_cases_owner_created_v31", "idx_resolution_cases_source_run_v31",
    "require_resolution_case_projection_v31", "fence_resolution_case_update_v31", "prevent_resolution_case_delete_v31",
    "resolution_directives", "uq_resolution_directive_pair_v31", "uq_resolution_directive_case_open_v31",
    "idx_resolution_directives_case_created_v31", "require_resolution_directive_projection_v31",
    "prevent_resolution_directive_update_v31", "prevent_resolution_directive_delete_v31",
    "resolution_events", "idx_resolution_events_case_sequence_v31", "require_resolution_event_chain_v31",
    "prevent_resolution_event_update_v31", "prevent_resolution_event_delete_v31",
    "resolution_replacements", "idx_resolution_replacements_state_v31", "require_resolution_replacement_binding_v31",
    "fence_resolution_replacement_update_v31", "prevent_resolution_replacement_delete_v31",
    "freeze_source_engineer_run_update_v31", "freeze_source_run_state_event_v31", "freeze_source_budget_event_v31",
    "freeze_source_approval_request_v31", "freeze_source_approval_decision_v31", "freeze_source_git_operation_v31",
    "freeze_source_builder_dispatch_v31", "freeze_source_hardening_lineage_v31",
  ];
  if (expected.size !== names.length) throw new Error("Engineer schema v31 validator is missing exact definitions");
  for (const name of names) {
    const actual = db.query("SELECT sql FROM sqlite_master WHERE name=? AND type IN('table','index','trigger')").get(name) as { sql: string } | null;
    if (!actual?.sql || normalizeSchemaSql(actual.sql) !== expected.get(name)) throw new Error(`Engineer schema v31 has invalid ${name}`);
  }
  assertForeignKeys(db);
}

function assertFailureUnderlyingCauseShape(db: Database): void {
  const columns = db.query("PRAGMA table_info(failure_records)").all() as Array<{ name: string; type: string; notnull: number }>;
  const column = columns.find((entry) => entry.name === "underlying_cause");
  if (!column) throw new Error("Engineer schema v32 is missing failure_records.underlying_cause");
  if (column.notnull !== 0) throw new Error("Engineer schema v32 failure_records.underlying_cause must be nullable");
  assertForeignKeys(db);
}

function assertPublicationAuthorityShape(db: Database): void {
  const expected = new Map<string, string>();
  const pattern = /CREATE (?:UNIQUE )?(?:TABLE|INDEX|TRIGGER)\s+([A-Za-z0-9_]+)[\s\S]*?;\s*(?=CREATE |$)/g;
  for (const match of ENGINEER_DATABASE_MIGRATION_33_SQL.matchAll(pattern)) expected.set(match[1]!, normalizeSchemaSql(match[0]!));
  const names = [
    "publication_candidate_selections_v33", "uq_pub_candidate_selection_pair_v33", "idx_pub_candidate_selection_run_v33",
    "require_pub_candidate_selection_projection_v33", "prevent_pub_candidate_selection_update_v33", "prevent_pub_candidate_selection_delete_v33",
    "publication_approvals_v33", "uq_pub_approval_decision_candidate_v33", "idx_pub_approval_run_v33",
    "require_pub_approval_binding_v33", "prevent_pub_approval_update_v33", "prevent_pub_approval_delete_v33",
    "publication_git_operations_v33", "uq_pub_git_operation_idempotency_v33", "uq_pub_git_operation_approval_v33",
    "idx_pub_git_operation_run_v33", "require_pub_git_operation_dispatch_authority_v33", "require_pub_git_operation_transition_v33",
    "require_pub_git_operation_reconcile_resolution_v33", "prevent_pub_git_operation_update_v33", "prevent_pub_git_operation_delete_v33",
    "publication_remote_receipts_v33", "require_pub_remote_receipt_state_v33", "prevent_pub_remote_receipt_update_v33", "prevent_pub_remote_receipt_delete_v33",
    "publication_reconciliations_v33", "require_pub_reconciliation_state_v33", "prevent_pub_reconciliation_update_v33", "prevent_pub_reconciliation_delete_v33",
  ];
  if (expected.size !== names.length) throw new Error("Engineer schema v33 validator is missing exact definitions");
  for (const name of names) {
    const actual = db.query("SELECT sql FROM sqlite_master WHERE name=? AND type IN('table','index','trigger')").get(name) as { sql: string } | null;
    if (!actual?.sql || normalizeSchemaSql(actual.sql) !== expected.get(name)) throw new Error(`Engineer schema v33 has invalid ${name}`);
  }
  assertForeignKeys(db);
}

/** Apply ordered migrations after the legacy bootstrap/shape repairs finish. */
export function migrateEngineerDatabase(db: Database, now = new Date().toISOString()): void {
  assertEngineerDatabaseVersionSupported(db);

  const appliedVersions = new Set((db.query("SELECT version FROM schema_migrations").all() as Array<{ version: number }>)
    .map((row) => row.version));
  if (appliedVersions.has(15) && !appliedVersions.has(14)) {
    throw new Error("Engineer schema v15 is missing required v14 migration ancestry");
  }
  if (appliedVersions.has(16) && (!appliedVersions.has(14) || !appliedVersions.has(15))) {
    throw new Error("Engineer schema v16 is missing required migration ancestry");
  }
  if (appliedVersions.has(17) && (![14, 15, 16].every((version) => appliedVersions.has(version)))) {
    throw new Error("Engineer schema v17 is missing required migration ancestry");
  }
  if (appliedVersions.has(18) && (![14, 15, 16, 17].every((version) => appliedVersions.has(version)))) {
    throw new Error("Engineer schema v18 is missing required migration ancestry");
  }
  if (appliedVersions.has(19) && (![14, 15, 16, 17, 18].every((version) => appliedVersions.has(version)))) {
    throw new Error("Engineer schema v19 is missing required migration ancestry");
  }
  if (appliedVersions.has(20) && (![14, 15, 16, 17, 18, 19].every((version) => appliedVersions.has(version)))) {
    throw new Error("Engineer schema v20 is missing required migration ancestry");
  }
  if (appliedVersions.has(21) && (![14, 15, 16, 17, 18, 19, 20].every((version) => appliedVersions.has(version)))) {
    throw new Error("Engineer schema v21 is missing required migration ancestry");
  }
  if (appliedVersions.has(22) && (![14, 15, 16, 17, 18, 19, 20, 21].every((version) => appliedVersions.has(version)))) {
    throw new Error("Engineer schema v22 is missing required migration ancestry");
  }
  if (appliedVersions.has(23) && (![14, 15, 16, 17, 18, 19, 20, 21, 22].every((version) => appliedVersions.has(version)))) {
    throw new Error("Engineer schema v23 is missing required migration ancestry");
  }
  if (appliedVersions.has(24) && (![14, 15, 16, 17, 18, 19, 20, 21, 22, 23].every((version) => appliedVersions.has(version)))) {
    throw new Error("Engineer schema v24 is missing required migration ancestry");
  }
  if (appliedVersions.has(25) && (![14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24].every((version) => appliedVersions.has(version)))) {
    throw new Error("Engineer schema v25 is missing required migration ancestry");
  }
  if (appliedVersions.has(26) && (![14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25].every((version) => appliedVersions.has(version)))) {
    throw new Error("Engineer schema v26 is missing required migration ancestry");
  }
  if (appliedVersions.has(27) && (![14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26].every((version) => appliedVersions.has(version)))) {
    throw new Error("Engineer schema v27 is missing required migration ancestry");
  }
  if (appliedVersions.has(28) && (![14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27].every((version) => appliedVersions.has(version)))) {
    throw new Error("Engineer schema v28 is missing required migration ancestry");
  }
  if (appliedVersions.has(29) && (![14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28].every((version) => appliedVersions.has(version)))) {
    throw new Error("Engineer schema v29 is missing required migration ancestry");
  }
  if (appliedVersions.has(30) && (![14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29].every((version) => appliedVersions.has(version)))) {
    throw new Error("Engineer schema v30 is missing required migration ancestry");
  }
  if (appliedVersions.has(31) && (![14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30].every((version) => appliedVersions.has(version)))) {
    throw new Error("Engineer schema v31 is missing required migration ancestry");
  }
  if (appliedVersions.has(33) && (![14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32].every((version) => appliedVersions.has(version)))) {
    throw new Error("Engineer schema v33 is missing required migration ancestry");
  }

  for (const migration of MIGRATIONS) {
    if (maximumAppliedVersion(db) >= migration.version) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      // Another process may have completed the migration while this process
      // waited for the write lock. Re-read under the lock before executing DDL.
      if (maximumAppliedVersion(db) >= migration.version) {
        db.exec("COMMIT");
        continue;
      }
      if (migration.version === 16) assertRequiredLaneContractShape(db, 0, "V1_ONLY");
      if (migration.version === 17) assertRequiredLaneContractShape(db, 1, "V1_ONLY");
      if (migration.version === 18) assertRequiredLaneContractShape(db, 1, "V1_AND_V2");
      if (migration.version === 19) assertReviewClassificationShape(db);
      if (migration.version === 20) assertApprovalClassificationShape(db);
      if (migration.version === 21) assertBuilderDispatchClaimShape(db);
      if (migration.version === 22) assertVerifiedCandidateCheckpointShape(db);
      if (migration.version === 23) assertApprovalDecisionCheckpointShape(db);
      if (migration.version === 27) {
        assertVerifiedCandidateCheckpointShape(db);
        assertHardeningStartShape(db);
      }
      db.exec(migration.sql);
      assertForeignKeys(db);
      if (migration.version === 18) assertReviewClassificationShape(db);
      if (migration.version === 19) assertApprovalClassificationShape(db);
      if (migration.version === 20) assertBuilderDispatchClaimShape(db);
      if (migration.version === 21) assertVerifiedCandidateCheckpointShape(db);
      if (migration.version === 22) assertApprovalDecisionCheckpointShape(db);
      if (migration.version === 23) assertAdvisoryHardeningShape(db);
      if (migration.version === 24) assertHardeningQuoteRequestShape(db);
      if (migration.version === 25) assertHardeningChildBudgetShape(db);
      if (migration.version === 26) assertHardeningStartShape(db);
      if (migration.version === 27) assertVerifiedHardeningCandidateCheckpointShape(db);
      if (migration.version === 28) assertHardeningExecutionFencingShape(db);
      if (migration.version === 29) assertHardeningBudgetShape(db);
      if (migration.version === 30) assertHardeningBudgetShape(db);
      if (migration.version === 30) assertHardeningRecoveryWorkerFenceShape(db);
      if (migration.version === 31) assertResolutionDeskShape(db);
      if (migration.version === 32) assertFailureUnderlyingCauseShape(db);
      if (migration.version === 33) assertPublicationAuthorityShape(db);
      db.query("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
        .run(migration.version, now);
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* preserve the migration failure */ }
      throw error;
    }
  }

  const finalVersion = maximumAppliedVersion(db);
  if (finalVersion === 15) assertRequiredLaneContractShape(db, 0, "V1_ONLY");
  if (finalVersion === 16) assertRequiredLaneContractShape(db, 1, "V1_ONLY");
  if (finalVersion === 17) assertRequiredLaneContractShape(db, 1, "V1_AND_V2");
  if (finalVersion >= 18) {
    assertRequiredLaneContractShape(db, 1, "V1_AND_V2");
    assertReviewClassificationShape(db);
  }
  if (finalVersion >= 19) assertApprovalClassificationShape(db);
  if (finalVersion >= 20) assertBuilderDispatchClaimShape(db);
  if (finalVersion >= 21) assertVerifiedCandidateCheckpointShape(db);
  if (finalVersion >= 22) assertApprovalDecisionCheckpointShape(db);
  if (finalVersion >= 23) assertAdvisoryHardeningShape(db);
  if (finalVersion >= 24) assertHardeningQuoteRequestShape(db);
  if (finalVersion >= 25) assertHardeningChildBudgetShape(db);
  if (finalVersion >= 26) assertHardeningStartShape(db);
  if (finalVersion >= 27) assertVerifiedHardeningCandidateCheckpointShape(db);
  if (finalVersion >= 28) assertHardeningExecutionFencingShape(db);
  if (finalVersion >= 29) assertHardeningBudgetShape(db);
  if (finalVersion >= 30) assertHardeningRecoveryWorkerFenceShape(db);
  if (finalVersion >= 31) assertResolutionDeskShape(db);
  if (finalVersion >= 32) assertFailureUnderlyingCauseShape(db);
  if (finalVersion >= 33) assertPublicationAuthorityShape(db);
}
