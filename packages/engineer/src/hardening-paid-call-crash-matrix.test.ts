import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { CodexBuilder, builderStaticRequestPrefix } from "./codex-builder.js";
import { TaskManifestContentSchema, TaskManifestSchema } from "./contracts.js";
import { LocalArtifactStore } from "./artifact-store.js";
import { createHardeningBudgetAuthority } from "./hardening-budget-contracts.js";
import { createHardeningPromptCacheMaterial } from "./hardening-prompt-cache.js";
import { canonicalJson, sha256, sha256Bytes } from "./hash.js";
import { EngineerLedger } from "./ledger.js";
import { DatabaseIntegrityCorruptionError } from "./errors.js";
import { createEngineerSupervisor } from "./supervisor.js";
import { createEngineerRunLineage, hardeningChildRunId } from "./advisory-hardening-contracts.js";
import { createHardeningStartOperation } from "./hardening-start-contracts.js";
import {
  EngineerWorkerLeaseManager,
  StaleWorkerLeaseError,
  WorkerLeaseConflictError,
} from "./worker-lease.js";
import { DEFAULT_HARDENING_ESTIMATION_AUTHORITY_V2 } from "./hardening-estimator.js";

const NOW_MS = Date.parse("2026-07-18T12:00:00.000Z");
const PROMPT_CACHE_SECRET = "hardening-crash-matrix-prompt-cache-secret-000000000000";
const WORKER_LEASE_SECRET = "hardening-crash-matrix-worker-lease-secret-000000000000";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function manifest(runId: string) {
  const content = TaskManifestContentSchema.parse({
    manifestVersion: 1,
    runId,
    repository: {
      repositoryId: "hardening-crash-matrix-repository",
      provider: "local",
      owner: "local",
      name: "hardening-crash-matrix",
      baseBranch: "main",
      baseCommitSha: "a".repeat(40),
    },
    request: { original: "Implement the requested change", normalized: "Implement the requested change" },
    acceptanceCriteria: [{
      criterionId: "must-1",
      statement: "The requested change is implemented",
      verificationMethod: "Run the unit test",
      priority: "MUST",
    }],
    testPlan: [{
      testId: "test-1",
      criterionIds: ["must-1"],
      type: "UNIT",
      description: "Run the unit test",
      command: "bun test",
    }],
    allowedPaths: ["src/**"],
    deniedPaths: [".env*"],
    allowedCommands: ["bun test"],
    prohibitedCommands: [],
    riskTier: "MEDIUM",
    humanGateRequired: true,
    retryBudgets: {
      sameFailureAttempts: 2,
      builderRepairAttempts: 4,
      reviewerFixAttempts: 2,
      plannerRestarts: 1,
      sandboxProvisioningAttempts: 3,
      transientModelAttempts: 3,
    },
    timeBudgetSeconds: 600,
    tokenBudget: 100_000,
    costBudgetUsd: 2,
    createdAt: new Date(NOW_MS).toISOString(),
  });
  return TaskManifestSchema.parse({ ...content, manifestHash: sha256(content) });
}

type CrashState = "RESERVED_UNSENT" | "DISPATCHING" | "RESPONSE_RECORDED";

function paidCallFixture(tag: string, state: CrashState) {
  const root = mkdtempSync(join(tmpdir(), `zintus-hardening-crash-${tag}-`));
  roots.push(root);
  const dbPath = join(root, "engineer.db");
  const consentHash = sha256(`${tag}:consent-hash`);
  const runId = hardeningChildRunId(consentHash);
  const principal = {ownerId:`owner-${tag}`,reviewerId:`reviewer-${tag}`,sessionId:`session-${tag}`,
    safetyIdentifier:`safety-${tag}`};
  const userId = principal.ownerId;
  const supervisor = createEngineerSupervisor({
    dbPath,
    now: () => new Date(NOW_MS),
    hardeningPromptCacheSecret: PROMPT_CACHE_SECRET,
  });
  const artifactStore = new LocalArtifactStore({
    root: join(root, "artifacts"),
    now: () => new Date(NOW_MS),
  });
  supervisor.configureArtifactReadAuthority(artifactStore);
  supervisor.receiveRequest({
    runId,
    userId,
    repository: manifest(runId).repository,
    request: "Implement the requested change",
  });

  // Open both process-local ledger connections while the canonical schema is
  // still pristine. The second connection represents a provider-free recovery
  // worker taking over after the first process disappears.
  const ledger = new EngineerLedger(dbPath, () => new Date(NOW_MS), PROMPT_CACHE_SECRET);
  const recoveryLedger = new EngineerLedger(dbPath, () => new Date(NOW_MS + 1_001), PROMPT_CACHE_SECRET);
  const strictRead = (artifact: Parameters<LocalArtifactStore["readVerifiedExact"]>[0]) =>
    artifactStore.readVerifiedExact(artifact);
  ledger.configureHardeningArtifactReader(strictRead);
  recoveryLedger.configureHardeningArtifactReader(strictRead);

  const quoteId = sha256(`${tag}:quote-id`);
  const quoteHash = sha256(`${tag}:quote-hash`);
  const consentId = sha256(`${tag}:consent-id`);
  const lineage=createEngineerRunLineage({schemaVersion:1,policyVersion:"engineer-hardening-lineage-v1",relation:"OPTIONAL_HARDENING",
    rootRunId:`root-${tag}`,parentRunId:`parent-${tag}`,childRunId:runId,requesterUserId:userId,
    repositoryId:"hardening-crash-matrix-repository",parentCheckpointId:sha256(`${tag}:checkpoint-id`),
    parentCheckpointHash:sha256(`${tag}:checkpoint-hash`),parentBaseCommitSha:"a".repeat(40),seedResultCommitSha:"b".repeat(40),
    quoteId,quoteHash,consentId,consentHash,selectionHash:sha256(`${tag}:selection`),
    budget:{costMicrousd:2_000_000,tokens:100_000,timeSeconds:600},createdAt:new Date(NOW_MS).toISOString()});
  const {lineageId,lineageHash}=lineage;
  const authority = createHardeningBudgetAuthority({
    schemaVersion: 1,
    policyVersion: "engineer-hardening-child-budget-v1",
    childRunId: runId,
    lineageId,
    lineageHash,
    quoteId,
    quoteHash,
    consentId,
    consentHash,
    costLimitMicrousd: 2_000_000,
    tokenLimit: 100_000,
    activeTimeLimitMs: 600_000,
    estimationAuthority: DEFAULT_HARDENING_ESTIMATION_AUTHORITY_V2,
    paidGraph: { plannerCalls: 0, builderCalls: 1, reviewerCalls: 1, automaticRepairCalls: 0 },
    toolLimits: {
      maxToolCalls: 8,
      maxMutations: 8,
      maxCommandCalls: 8,
      maxToolArgumentBytes: 131_072,
      maxFileBytes: 1_048_576,
      maxToolResultBytes: 32_768,
      maxSearchBytes: 8_388_608,
      maxSearchResults: 100,
      maxRangeLines: 400,
    },
    transportLimits: {
      builderInputCap: 40_000,
      builderOutputCeiling: 6_000,
      reviewerInputCap: 40_000,
      reviewerOutputCeiling: 12_000,
      modelTimeoutMs: 120_000,
    },
    createdAt: new Date(NOW_MS).toISOString(),
  });

  // This fixture deliberately seeds only the authority boundary needed by
  // the paid-call ledger. The production lineage/start gates are covered by
  // their own end-to-end suite and remain enabled in production databases.
  const seed = new Database(dbPath);
  seed.exec("PRAGMA foreign_keys=OFF");
  const bypassedTriggerNames=["require_hardening_child_budget_authority_v29","require_hardening_model_call_slot_child_v28",
    "require_lineage_binding_v23","require_hardening_start_operation_binding_v26"] as const;
  const bypassedTriggers=bypassedTriggerNames.map((name)=>{
    const row=seed.query("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(name) as {sql:string}|null;
    if(!row?.sql)throw new Error(`missing crash-fixture trigger ${name}`);
    return row.sql;
  });
  for(const name of bypassedTriggerNames)seed.exec(`DROP TRIGGER ${name}`);
  seed.query("UPDATE engineer_runs SET state='IMPLEMENTING',state_version=7,manifest_hash=? WHERE id=?")
    .run(sha256(`${tag}:manifest`),runId);
  seed.query(`INSERT INTO hardening_child_budget_authorities(
    id,authority_hash,schema_version,policy_version,child_run_id,lineage_id,lineage_hash,quote_id,quote_hash,consent_id,consent_hash,
    cost_limit_microusd,token_limit,active_time_limit_ms,max_builder_calls,max_reviewer_calls,max_tool_calls,max_mutations,
    max_command_calls,max_tool_argument_bytes,max_file_bytes,max_tool_result_bytes,max_search_bytes,max_search_results,max_range_lines,
    builder_input_token_cap,builder_output_ceiling,reviewer_input_token_cap,reviewer_output_ceiling,model_timeout_ms,automatic_repair_calls,
    used_cost_microusd,used_tokens,reserved_cost_microusd,reserved_tokens,ambiguous_cost_microusd,ambiguous_tokens,used_active_ms,
    active_since_ms,fence_owner_id,fence_token_hash,fence_generation,fence_expires_at_ms,status,stop_reason,revision,created_at_ms,updated_at_ms)
    VALUES(${Array.from({ length: 48 }, () => "?").join(",")})`).run(
    authority.budgetAuthorityId,
    authority.budgetAuthorityHash,
    1,
    authority.policyVersion,
    runId,
    lineageId,
    lineageHash,
    quoteId,
    quoteHash,
    consentId,
    consentHash,
    authority.costLimitMicrousd,
    authority.tokenLimit,
    authority.activeTimeLimitMs,
    1,
    1,
    8,
    8,
    8,
    131_072,
    1_048_576,
    32_768,
    8_388_608,
    100,
    400,
    40_000,
    6_000,
    40_000,
    12_000,
    120_000,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    NOW_MS,
    null,
    null,
    0,
    null,
    "ACTIVE",
    null,
    1,
    NOW_MS,
    NOW_MS,
  );
  // Minimal immutable lineage/start identity makes this a real optional-
  // hardening child for the Supervisor and Gateway cancellation path. Foreign
  // keys are intentionally disabled in this narrow crash fixture because the
  // quote/consent/start authority creation flow has separate end-to-end tests.
  const startOperation=createHardeningStartOperation({schemaVersion:1,policyVersion:"engineer-hardening-start-operation-v1",
    requesterUserId:userId,childRunId:runId,expectedChildStateVersion:0,lineageId,lineageHash,
    idempotencyKey:`start-${tag}`,createdAt:new Date(NOW_MS).toISOString()});
  seed.query(`INSERT INTO engineer_run_lineage(id,lineage_hash,schema_version,policy_version,relation,root_run_id,parent_run_id,
    child_run_id,requester_user_id,repository_id,parent_checkpoint_id,parent_checkpoint_hash,parent_base_commit_sha,
    seed_result_commit_sha,quote_id,quote_hash,consent_id,consent_hash,selection_hash,cost_microusd,tokens,time_seconds,
    lineage_json,created_at) VALUES(${Array.from({length:24},()=>"?").join(",")})`).run(
    lineageId,lineageHash,1,"engineer-hardening-lineage-v1","OPTIONAL_HARDENING",`root-${tag}`,`parent-${tag}`,runId,
    userId,"hardening-crash-matrix-repository",lineage.parentCheckpointId,lineage.parentCheckpointHash,
    lineage.parentBaseCommitSha,lineage.seedResultCommitSha,quoteId,quoteHash,consentId,consentHash,lineage.selectionHash,
    2_000_000,100_000,600,canonicalJson(lineage),new Date(NOW_MS).toISOString());
  seed.query(`INSERT INTO hardening_start_operations(id,operation_hash,schema_version,policy_version,requester_user_id,
    child_run_id,expected_child_state_version,lineage_id,lineage_hash,idempotency_key,operation_json,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(startOperation.operationId,startOperation.operationHash,1,"engineer-hardening-start-operation-v1",
    userId,runId,0,lineageId,lineageHash,`start-${tag}`,canonicalJson(startOperation),new Date(NOW_MS).toISOString());
  seed.close();

  const agentExecutionId = `builder-${tag}`;
  const routingDecisionId = `route-${tag}`;
  expect(ledger.claimBuilderDispatch({
    agentExecutionId,
    runId,
    role: "BUILDER",
    modelTier: "GPT-5.6_TERRA",
    status: "RUNNING",
    inputHash: sha256(`${tag}:builder-input`),
    outputArtifactId: null,
    startedAt: new Date(NOW_MS).toISOString(),
    completedAt: null,
  }).won).toBe(true);
  ledger.recordModelRouting({
    routingDecisionId,
    runId,
    agentExecutionId,
    agentRole: "BUILDER",
    logicalTier: "GPT-5.6_TERRA",
    resolvedModel: "gpt-5.6-terra",
    routingPolicyVersion: "engineer-model-routing-v2",
    fallbackUsed: false,
    fallbackReason: null,
    cacheKey: null,
    timestamp: new Date(NOW_MS).toISOString(),
  });
  const fence = ledger.acquireHardeningExecutionFence({
    childRunId: runId,
    ownerId: `worker-${tag}`,
    ttlMs: 1_000,
    nowMs: NOW_MS,
    idempotencyKey: `fence-${tag}`,
  });
  const staticPrefix = builderStaticRequestPrefix("gpt-5.6-terra");
  const requestHash = sha256(`${tag}:canonical-request`);
  const reservation = ledger.reserveHardeningPaidCall({
    childRunId: runId,
    role: "BUILDER",
    modelTier: "GPT-5.6_TERRA",
    resolvedModel: "gpt-5.6-terra",
    routingDecisionId,
    agentExecutionId,
    inputTokenUpperBound: 100,
    outputTokenCeiling: 6_000,
    reservationIdempotencyKey: `reservation-${tag}`,
    requestHash,
    cacheDescriptor: createHardeningPromptCacheMaterial({
      secret: PROMPT_CACHE_SECRET,
      requesterUserId: userId,
      childRunId: runId,
      role: "BUILDER",
      resolvedModel: "gpt-5.6-terra",
      promptOrReviewerPolicyVersion: "engineer-codex-builder-v3",
      staticPrefix,
      toolSchema: staticPrefix.tools,
    }).descriptor,
    fenceOwnerId: fence.ownerId,
    fenceGeneration: fence.fenceGeneration,
    rawFenceToken: fence.rawFenceToken,
    nowMs: NOW_MS,
  }).reservation;

  if (state !== "RESERVED_UNSENT") {
    ledger.markHardeningPaidCallDispatching({
      childRunId: runId,
      reservationId: reservation.reservationId,
      requestHash: reservation.requestHash,
      clientRequestId: reservation.clientRequestId,
      fenceOwnerId: fence.ownerId,
      fenceGeneration: fence.fenceGeneration,
      rawFenceToken: fence.rawFenceToken,
      nowMs: NOW_MS,
    });
  }
  if (state === "RESPONSE_RECORDED") {
    const providerResponseId = `response-${tag}`;
    const providerResponse = {
      id: providerResponseId,
      usage: {
        input_tokens: 10,
        output_tokens: 4,
        input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      },
    };
    const artifact = ledger.recordArtifact(artifactStore.put({
      runId,
      type: "MODEL_PROVIDER_RESPONSE",
      bytes: JSON.stringify(providerResponse),
      producerType: "SYSTEM",
      producerId: "engineer-provider-response-recorder",
      trusted: true,
    }));
    ledger.recordHardeningPaidCallResponse({
      childRunId: runId,
      reservationId: reservation.reservationId,
      requestHash: reservation.requestHash,
      clientRequestId: reservation.clientRequestId,
      modelCall: {
        modelCallId: `model-call-${tag}`,
        runId,
        agentExecutionId,
        logicalTier: "GPT-5.6_TERRA",
        resolvedModel: "gpt-5.6-terra",
        promptTemplateVersion: "engineer-codex-builder-v3",
        inputContextRefs: [ledger.getRun(runId).manifestHash!, sha256(`${tag}:provider-input`),
          reservation.requestHash, reservation.clientRequestId, providerResponseId],
        outputSchemaVersion: null,
        cacheKey: reservation.promptCacheKeyHash,
        cacheHit: false,
        latencyMs: 1,
        inputTokens: 10,
        outputTokens: 4,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        retryCount: 0,
        status: "SUCCEEDED",
        createdAt: new Date(NOW_MS).toISOString(),
      },
      providerResponseId,
      providerResponseArtifactId: artifact.artifactId,
      fenceOwnerId: fence.ownerId,
      fenceGeneration: fence.fenceGeneration,
      rawFenceToken: fence.rawFenceToken,
      nowMs: NOW_MS,
    });
  }

  // Restore the canonical schema before a new Supervisor process opens the
  // database. Production integrity checks must remain active in the actual
  // cancellation path under test.
  const restore=new Database(dbPath);
  for(const sql of bypassedTriggers)restore.exec(sql);
  restore.close();

  return { root, dbPath, runId, principal, supervisor, ledger, recoveryLedger, reservation, artifactStore };
}

function reservationProjection(dbPath: string, reservationId: string) {
  const db = new Database(dbPath, { readonly: true });
  const reservation = db.query(`SELECT status,dispatch_status,recovery_generation,model_call_id,
    provider_response_id,reconciliation_id FROM hardening_child_model_reservations WHERE id=?`).get(reservationId);
  const budget = db.query(`SELECT status,stop_reason,used_cost_microusd,used_tokens,reserved_cost_microusd,
    reserved_tokens,ambiguous_cost_microusd,ambiguous_tokens FROM hardening_child_budget_authorities`).get();
  const finalization = db.query(`SELECT status,outcome,reconciliation_id FROM hardening_paid_call_finalizations
    WHERE reservation_id=?`).get(reservationId);
  db.close();
  return { reservation, budget, finalization };
}

describe("hardening paid-call crash matrix", () => {
  test("D user cancellation reconciles every dispatch state before one terminal CANCELLED transition", async () => {
    // Keep the package test project acyclic while exercising the real Gateway
    // facade at runtime; the Gateway already has a project reference to this
    // package, never the reverse.
    const gatewayModulePath="../../../apps/gateway/src/engineer.js";
    const {EngineerRunManager}=await import(gatewayModulePath);
    const expectations:Record<CrashState,{outcome:string;stopReason:string;usedTokens:number;ambiguousTokens:"RESERVED"|0}>={
      RESERVED_UNSENT:{outcome:"VOID_UNSENT",stopReason:"MODEL_DISPATCH_NOT_STARTED",usedTokens:0,ambiguousTokens:0},
      DISPATCHING:{outcome:"AMBIGUOUS",stopReason:"MODEL_USAGE_AMBIGUOUS",usedTokens:0,ambiguousTokens:"RESERVED"},
      RESPONSE_RECORDED:{outcome:"SETTLED_RECOVERED",stopReason:"CANCELLED",usedTokens:14,ambiguousTokens:0},
    };
    for(const state of ["RESERVED_UNSENT","DISPATCHING","RESPONSE_RECORDED"] as const){
      const item=paidCallFixture(`cancel-${state.toLowerCase()}`,state);
      item.ledger.close();item.recoveryLedger.close();
      let clock=NOW_MS+1_001,cleanupCalls=0;
      const supervisor=item.supervisor;
      expect(supervisor.hasOutstandingHardeningPaidCallRecoveryWork(item.runId)).toBe(true);
      const leaseManager=new EngineerWorkerLeaseManager({dbPath:join(item.root,"worker-leases.db"),tokenSecret:WORKER_LEASE_SECRET,
        maxConcurrentLeases:2,now:()=>new Date(clock),recoverExpiredLease:()=>undefined});
      supervisor.configureRecoveryWorkerLeaseAuthority(leaseManager);
      const manager=new EngineerRunManager({supervisor,principal:item.principal,preflight:{} as never,
        leaseManager,leaseTtlMs:1_000,now:()=>new Date(clock),
        artifactStore:item.artifactStore,
        cleanupRun:()=>{cleanupCalls+=1;}});
      await manager.cancel(item.principal,item.runId,"Stop optional hardening safely.");
      await manager.cancel(item.principal,item.runId,"Duplicate stop request.");
      const projection=reservationProjection(item.dbPath,item.reservation.reservationId);
      const expected=expectations[state];
      expect(supervisor.getRun(item.runId).state).toBe("CANCELLED");
      expect(supervisor.listEvents(item.runId).map((event)=>event.nextState)).toEqual(["CANCELLATION_PENDING","CANCELLED"]);
      expect(supervisor.listArtifacts(item.runId).filter((artifact)=>artifact.type==="CANCELLATION_REQUEST")).toHaveLength(1);
      expect(cleanupCalls).toBe(1);
      expect(projection.reservation).toMatchObject({status:state==="RESERVED_UNSENT"?"VOID_UNSENT":
        state==="DISPATCHING"?"AMBIGUOUS":"SETTLED",dispatch_status:state==="RESERVED_UNSENT"?"VOID_UNSENT":
        state==="DISPATCHING"?"AMBIGUOUS":"SETTLED",recovery_generation:1});
      expect(projection.finalization).toMatchObject({status:"APPLIED",outcome:expected.outcome});
      expect(projection.budget).toMatchObject({status:"STOPPED",stop_reason:expected.stopReason,used_tokens:expected.usedTokens,
        reserved_cost_microusd:0,reserved_tokens:0,ambiguous_tokens:expected.ambiguousTokens==="RESERVED"
          ?item.reservation.reservedTokens:0});
      expect(supervisor.hasOutstandingHardeningPaidCallRecoveryWork(item.runId)).toBe(false);
      leaseManager.close();supervisor.close();
      clock+=1;
    }
  });

  test("A RESERVED_UNSENT restart voids without a provider call and releases all reserved liability", () => {
    const item = paidCallFixture("reserved-unsent", "RESERVED_UNSENT");
    item.ledger.close();
    const recovered = item.recoveryLedger;
    const result = recovered.recoverHardeningPaidCall({
      childRunId: item.runId,
      reservationId: item.reservation.reservationId,
      recoveryOwnerId: "recovery-a",
      recoveryIdempotencyKey: "recover-reserved-unsent",
      rawRecoveryToken: "recovery-token-a",
      nowMs: NOW_MS + 1_001,
    });
    expect(result.outcome).toBe("VOID_UNSENT");
    expect(reservationProjection(item.dbPath, item.reservation.reservationId)).toEqual({
      reservation: {
        status: "VOID_UNSENT",
        dispatch_status: "VOID_UNSENT",
        recovery_generation: 1,
        model_call_id: null,
        provider_response_id: null,
        reconciliation_id: result.reconciliation.reconciliationId,
      },
      budget: {
        status: "STOPPED",
        stop_reason: "MODEL_DISPATCH_NOT_STARTED",
        used_cost_microusd: 0,
        used_tokens: 0,
        reserved_cost_microusd: 0,
        reserved_tokens: 0,
        ambiguous_cost_microusd: 0,
        ambiguous_tokens: 0,
      },
      finalization: {
        status: "PENDING",
        outcome: "VOID_UNSENT",
        reconciliation_id: result.reconciliation.reconciliationId,
      },
    });
    recovered.close();
    item.supervisor.close();
  });

  test("B DISPATCHING restart never replays and converts the full reservation to ambiguity", () => {
    const item = paidCallFixture("dispatching", "DISPATCHING");
    item.ledger.close();
    const recovered = item.recoveryLedger;
    const result = recovered.recoverHardeningPaidCall({
      childRunId: item.runId,
      reservationId: item.reservation.reservationId,
      recoveryOwnerId: "recovery-b",
      recoveryIdempotencyKey: "recover-dispatching",
      rawRecoveryToken: "recovery-token-b",
      nowMs: NOW_MS + 1_001,
    });
    expect(result.outcome).toBe("AMBIGUOUS");
    const projection = reservationProjection(item.dbPath, item.reservation.reservationId);
    expect(projection.reservation).toMatchObject({
      status: "AMBIGUOUS",
      dispatch_status: "AMBIGUOUS",
      recovery_generation: 1,
      provider_response_id: null,
      reconciliation_id: result.reconciliation.reconciliationId,
    });
    expect(projection.reservation).toEqual(expect.objectContaining({ model_call_id: expect.any(String) }));
    expect(projection.budget).toEqual({
      status: "STOPPED",
      stop_reason: "MODEL_USAGE_AMBIGUOUS",
      used_cost_microusd: 0,
      used_tokens: 0,
      reserved_cost_microusd: 0,
      reserved_tokens: 0,
      ambiguous_cost_microusd: item.reservation.reservedCostMicrousd,
      ambiguous_tokens: item.reservation.reservedTokens,
    });
    expect(projection.finalization).toEqual({
      status: "PENDING",
      outcome: "AMBIGUOUS",
      reconciliation_id: result.reconciliation.reconciliationId,
    });
    recovered.close();
    item.supervisor.close();
  });

  test("recovered VOID and AMBIGUOUS finalizations reject every authority drift before claim and then apply once", () => {
    for(const [tag,state] of [["void-finalization","RESERVED_UNSENT"],["ambiguous-finalization","DISPATCHING"]] as const){
      const item=paidCallFixture(tag,state);
      item.ledger.close();
      const recoveryKey=`recover-${tag}`;
      const result=item.recoveryLedger.recoverHardeningPaidCall({childRunId:item.runId,
        reservationId:item.reservation.reservationId,recoveryOwnerId:`owner-${tag}`,
        recoveryIdempotencyKey:recoveryKey,rawRecoveryToken:`token-${tag}`,nowMs:NOW_MS+1_001});
      expect(result.outcome).toBe(state==="RESERVED_UNSENT"?"VOID_UNSENT":"AMBIGUOUS");
      item.recoveryLedger.finalizeRunningAgentExecutions(item.runId,"FAILED",new Date(NOW_MS+1_002).toISOString(),
        "HARDENING_PAID_CALL_RECOVERY_TERMINAL");
      const current=item.supervisor.getRun(item.runId);
      item.supervisor.transition({runId:item.runId,expectedStateVersion:current.stateVersion,nextState:"CANCELLATION_PENDING",
        reasonCode:"HARDENING_PAID_CALL_RECOVERY_TERMINAL",manifestHash:current.manifestHash,
        idempotencyKey:`${tag}:cancellation-pending`});
      const finalization=item.supervisor.listPendingHardeningPaidCallFinalizations(item.runId)[0]!;
      const consume={finalizationId:finalization.id,ownerId:`consumer-${tag}`,rawToken:`consumer-token-${tag}`,
        idempotencyKey:`consumer-${tag}`,nowMs:NOW_MS+1_003,expectedSuccessor:"RECOVERY_TERMINAL" as const};
      const assertRejectedAndRolledBack=()=>{
        expect(()=>item.supervisor.consumeHardeningPaidCallFinalization(consume)).toThrow();
        const check=new Database(item.dbPath,{readonly:true});
        expect(check.query(`SELECT status,claim_owner_id,claim_generation FROM hardening_paid_call_finalizations
          WHERE id=?`).get(finalization.id)).toEqual({status:"PENDING",claim_owner_id:null,claim_generation:0});
        check.close();
      };
      const tamper=new Database(item.dbPath);
      tamper.exec("PRAGMA foreign_keys=OFF");
      const reservationTrigger=tamper.query(`SELECT sql FROM sqlite_master WHERE type='trigger'
        AND name='fence_hardening_child_model_reservation_update_v29'`).get() as {sql:string}|null;
      const finalizationTrigger=tamper.query(`SELECT sql FROM sqlite_master WHERE type='trigger'
        AND name='fence_hardening_paid_call_finalization_update_v29'`).get() as {sql:string}|null;
      if(!reservationTrigger?.sql||!finalizationTrigger?.sql)throw new Error("hardening finalization triggers are missing");
      const original=tamper.query("SELECT * FROM hardening_child_model_reservations WHERE id=?")
        .get(item.reservation.reservationId) as Record<string,unknown>;
      tamper.exec("DROP TRIGGER fence_hardening_child_model_reservation_update_v29");
      const reservationDrifts=[
        {sql:"UPDATE hardening_child_model_reservations SET settlement_input_hash=? WHERE id=?",
          value:sha256(`${tag}:settlement-drift`),restore:"settlement_input_hash"},
        {sql:"UPDATE hardening_child_model_reservations SET settlement_idempotency_key=? WHERE id=?",
          value:`${recoveryKey}-drift`,restore:"settlement_idempotency_key"},
        {sql:"UPDATE hardening_child_model_reservations SET reconciliation_json='{}' WHERE id=?",
          value:null,restore:"reconciliation_json"},
        {sql:"UPDATE hardening_child_model_reservations SET reconciliation_hash=? WHERE id=?",
          value:sha256(`${tag}:reconciliation-drift`),restore:"reconciliation_hash"},
      ] as const;
      for(const drift of reservationDrifts){
        if(drift.value===null)tamper.query(drift.sql).run(item.reservation.reservationId);
        else tamper.query(drift.sql).run(drift.value,item.reservation.reservationId);
        assertRejectedAndRolledBack();
        tamper.query(`UPDATE hardening_child_model_reservations SET ${drift.restore}=? WHERE id=?`)
          .run(String(original[drift.restore]),item.reservation.reservationId);
      }
      tamper.query(`UPDATE hardening_child_model_reservations SET recovery_generation=0,recovery_owner_id=NULL,
        recovery_token_hash=NULL,recovery_idempotency_key=NULL,recovery_claimed_at_ms=NULL,recovery_expires_at_ms=NULL WHERE id=?`)
        .run(item.reservation.reservationId);
      assertRejectedAndRolledBack();
      tamper.query(`UPDATE hardening_child_model_reservations SET recovery_generation=?,recovery_owner_id=?,
        recovery_token_hash=?,recovery_idempotency_key=?,recovery_claimed_at_ms=?,recovery_expires_at_ms=? WHERE id=?`).run(
          Number(original.recovery_generation),String(original.recovery_owner_id),String(original.recovery_token_hash),
          String(original.recovery_idempotency_key),Number(original.recovery_claimed_at_ms),Number(original.recovery_expires_at_ms),
          item.reservation.reservationId);
      tamper.exec(reservationTrigger.sql);
      tamper.exec("DROP TRIGGER fence_hardening_paid_call_finalization_update_v29");
      tamper.query("UPDATE hardening_paid_call_finalizations SET outcome=? WHERE id=?")
        .run(state==="RESERVED_UNSENT"?"AMBIGUOUS":"VOID_UNSENT",finalization.id);
      assertRejectedAndRolledBack();
      tamper.query("UPDATE hardening_paid_call_finalizations SET outcome=? WHERE id=?").run(finalization.outcome,finalization.id);
      tamper.exec(finalizationTrigger.sql);tamper.close();
      expect(item.supervisor.consumeHardeningPaidCallFinalization(consume)).toMatchObject({status:"APPLIED",outcome:finalization.outcome});
      expect(item.supervisor.consumeHardeningPaidCallFinalization(consume)).toMatchObject({status:"APPLIED",outcome:finalization.outcome});
      item.supervisor.close();
    }
  });

  test("C RESPONSE_RECORDED restart revalidates the durable receipt and settles exact observed usage", () => {
    const item = paidCallFixture("response-recorded", "RESPONSE_RECORDED");
    item.ledger.close();
    const recovered = item.recoveryLedger;
    const result = recovered.recoverHardeningPaidCall({
      childRunId: item.runId,
      reservationId: item.reservation.reservationId,
      recoveryOwnerId: "recovery-c",
      recoveryIdempotencyKey: "recover-response-recorded",
      rawRecoveryToken: "recovery-token-c",
      nowMs: NOW_MS + 1_001,
    });
    expect(result.outcome).toBe("SETTLED_RECOVERED");
    const projection = reservationProjection(item.dbPath, item.reservation.reservationId);
    expect(projection.reservation).toMatchObject({
      status: "SETTLED",
      dispatch_status: "SETTLED",
      recovery_generation: 1,
      provider_response_id: "response-response-recorded",
      reconciliation_id: result.reconciliation.reconciliationId,
    });
    expect(projection.budget).toEqual({
      status: "ACTIVE",
      stop_reason: null,
      used_cost_microusd: 85,
      used_tokens: 14,
      reserved_cost_microusd: 0,
      reserved_tokens: 0,
      ambiguous_cost_microusd: 0,
      ambiguous_tokens: 0,
    });
    expect(projection.finalization).toEqual({
      status: "PENDING",
      outcome: "SETTLED_RECOVERED",
      reconciliation_id: result.reconciliation.reconciliationId,
    });
    recovered.close();
    item.supervisor.close();
  });

  test("C corrupt or missing provider-response bytes retain the receipt identity but charge full ambiguity exactly once", () => {
    for (const mode of ["CORRUPT","MISSING"] as const) {
      const item=paidCallFixture(`response-${mode.toLowerCase()}`,"RESPONSE_RECORDED");
      const db=new Database(item.dbPath,{readonly:true});
      const artifact=db.query(`SELECT a.storage_reference FROM artifacts a
        JOIN hardening_child_model_reservations r ON r.provider_response_artifact_id=a.id
        WHERE r.id=?`).get(item.reservation.reservationId) as {storage_reference:string};
      db.close();
      const originalBytes=readFileSync(artifact.storage_reference);
      if(mode==="CORRUPT")writeFileSync(artifact.storage_reference,"corrupt-provider-response");
      else rmSync(artifact.storage_reference,{force:true});
      item.ledger.close();
      const result=item.recoveryLedger.recoverHardeningPaidCall({childRunId:item.runId,
        reservationId:item.reservation.reservationId,recoveryOwnerId:`recovery-c-${mode.toLowerCase()}`,
        recoveryIdempotencyKey:`recover-response-${mode.toLowerCase()}`,
        rawRecoveryToken:`recovery-token-c-${mode.toLowerCase()}`,nowMs:NOW_MS+1_001});
      expect(result.outcome).toBe("AMBIGUOUS");
      const projection=reservationProjection(item.dbPath,item.reservation.reservationId);
      expect(projection.reservation).toMatchObject({status:"AMBIGUOUS",dispatch_status:"AMBIGUOUS",
        recovery_generation:1,provider_response_id:`response-response-${mode.toLowerCase()}`,
        reconciliation_id:result.reconciliation.reconciliationId});
      expect(projection.budget).toEqual({status:"STOPPED",stop_reason:"MODEL_USAGE_AMBIGUOUS",
        used_cost_microusd:0,used_tokens:0,reserved_cost_microusd:0,reserved_tokens:0,
        ambiguous_cost_microusd:item.reservation.reservedCostMicrousd,ambiguous_tokens:item.reservation.reservedTokens});
      expect(projection.finalization).toEqual({status:"PENDING",outcome:"AMBIGUOUS",
        reconciliation_id:result.reconciliation.reconciliationId});
      expect(result.reconciliation.invalidReceiptObservation?.failureCode).toBe(mode==="CORRUPT"?"SIZE_MISMATCH":"FILE_MISSING");

      // The observation is historical authority: restoring bytes after the
      // recovery decision must not change or strand the already-bound outcome.
      if(mode==="CORRUPT")writeFileSync(artifact.storage_reference,originalBytes);
      item.recoveryLedger.finalizeRunningAgentExecutions(item.runId,"FAILED",new Date(NOW_MS+1_002).toISOString(),
        "HARDENING_PAID_CALL_RECOVERY_TERMINAL");
      const current=item.supervisor.getRun(item.runId);
      item.supervisor.transition({runId:item.runId,expectedStateVersion:current.stateVersion,nextState:"CANCELLATION_PENDING",
        reasonCode:"HARDENING_PAID_CALL_RECOVERY_TERMINAL",manifestHash:current.manifestHash,
        idempotencyKey:`invalid-receipt-${mode}:cancellation-pending`});
      const finalization=item.supervisor.listPendingHardeningPaidCallFinalizations(item.runId)[0]!;
      const consume={finalizationId:finalization.id,ownerId:`invalid-receipt-consumer-${mode}`,
        rawToken:`invalid-receipt-consumer-token-${mode}`,idempotencyKey:`invalid-receipt-consume-${mode}`,
        nowMs:NOW_MS+1_003,expectedSuccessor:"RECOVERY_TERMINAL" as const};
      const tamper=new Database(item.dbPath);
      const reservationTrigger=tamper.query(`SELECT sql FROM sqlite_master WHERE type='trigger'
        AND name='fence_hardening_child_model_reservation_update_v29'`).get() as {sql:string}|null;
      if(!reservationTrigger?.sql)throw new Error("hardening reservation trigger is missing");
      const originalReconciliation=tamper.query("SELECT reconciliation_json FROM hardening_child_model_reservations WHERE id=?")
        .get(item.reservation.reservationId) as {reconciliation_json:string};
      const changedObservation=JSON.parse(originalReconciliation.reconciliation_json) as Record<string,unknown>&{
        invalidReceiptObservation:Record<string,unknown>};
      changedObservation.invalidReceiptObservation.observedAtMs=NOW_MS+999;
      tamper.exec("DROP TRIGGER fence_hardening_child_model_reservation_update_v29");
      tamper.query("UPDATE hardening_child_model_reservations SET reconciliation_json=? WHERE id=?")
        .run(canonicalJson(changedObservation),item.reservation.reservationId);
      expect(()=>item.supervisor.consumeHardeningPaidCallFinalization(consume)).toThrow();
      expect(tamper.query(`SELECT status,claim_owner_id,claim_generation FROM hardening_paid_call_finalizations WHERE id=?`)
        .get(finalization.id)).toEqual({status:"PENDING",claim_owner_id:null,claim_generation:0});
      tamper.query("UPDATE hardening_child_model_reservations SET reconciliation_json=? WHERE id=?")
        .run(originalReconciliation.reconciliation_json,item.reservation.reservationId);
      tamper.exec(reservationTrigger.sql);

      // A post-recovery extra call cannot be hidden under either the same
      // agent or the same reservation. Claim/apply rolls back atomically.
      const selected=tamper.query("SELECT model_call_id FROM hardening_child_model_reservations WHERE id=?")
        .get(item.reservation.reservationId) as {model_call_id:string};
      tamper.query(`INSERT INTO model_calls(id,run_id,agent_execution_id,logical_tier,resolved_model,prompt_template_version,
        input_context_refs_json,output_schema_version,cache_key,cache_hit,latency_ms,input_tokens,output_tokens,cached_input_tokens,
        cache_write_input_tokens,retry_count,budget_reservation_id,status,created_at)
        SELECT ?,run_id,agent_execution_id,logical_tier,resolved_model,prompt_template_version,input_context_refs_json,
        output_schema_version,cache_key,cache_hit,latency_ms,input_tokens,output_tokens,cached_input_tokens,
        cache_write_input_tokens,retry_count,budget_reservation_id,status,created_at FROM model_calls WHERE id=?`)
        .run(`extra-invalid-receipt-${mode}`,selected.model_call_id);
      expect(()=>item.supervisor.consumeHardeningPaidCallFinalization(consume)).toThrow();
      expect(tamper.query(`SELECT status,claim_owner_id,claim_generation FROM hardening_paid_call_finalizations WHERE id=?`)
        .get(finalization.id)).toEqual({status:"PENDING",claim_owner_id:null,claim_generation:0});
      tamper.query("DELETE FROM model_calls WHERE id=?").run(`extra-invalid-receipt-${mode}`);
      tamper.close();
      expect(item.supervisor.consumeHardeningPaidCallFinalization(consume)).toMatchObject({status:"APPLIED",outcome:"AMBIGUOUS"});
      expect(item.supervisor.consumeHardeningPaidCallFinalization(consume)).toMatchObject({status:"APPLIED",outcome:"AMBIGUOUS"});
      item.recoveryLedger.close();
      item.supervisor.close();
    }
  });

  test("C invalid durable response evidence is classified without replaying a provider call", () => {
    for(const mode of ["NOT_REGULAR_FILE","SYMLINK","SHA256_MISMATCH","INVALID_JSON","PROVIDER_ID_MISMATCH","USAGE_MISMATCH"] as const){
      const tag=`classified-${mode.toLowerCase()}`;
      const item=paidCallFixture(tag,"RESPONSE_RECORDED");
      const mutation=new Database(item.dbPath);
      const receipt=mutation.query(`SELECT r.model_call_id,r.provider_response_id,a.id AS artifact_id,a.storage_reference
        FROM hardening_child_model_reservations r JOIN artifacts a ON a.id=r.provider_response_artifact_id WHERE r.id=?`)
        .get(item.reservation.reservationId) as {model_call_id:string;provider_response_id:string;artifact_id:string;storage_reference:string};
      const originalBytes=readFileSync(receipt.storage_reference);
      const replaceAndBind=(bytes:Buffer)=>{
        writeFileSync(receipt.storage_reference,bytes);
        mutation.query("UPDATE artifacts SET sha256=?,size_bytes=? WHERE id=?")
          .run(sha256Bytes(bytes),bytes.byteLength,receipt.artifact_id);
      };
      if(mode==="NOT_REGULAR_FILE"){
        rmSync(receipt.storage_reference,{force:true});mkdirSync(receipt.storage_reference);
      }else if(mode==="SYMLINK"){
        const target=`${receipt.storage_reference}.target`;writeFileSync(target,originalBytes);
        rmSync(receipt.storage_reference,{force:true});symlinkSync(target,receipt.storage_reference);
      }else if(mode==="SHA256_MISMATCH"){
        const changed=Buffer.from(originalBytes);changed[0]=changed[0]===123?91:123;writeFileSync(receipt.storage_reference,changed);
      }else if(mode==="INVALID_JSON")replaceAndBind(Buffer.from("not-json"));
      else if(mode==="PROVIDER_ID_MISMATCH")replaceAndBind(Buffer.from(JSON.stringify({id:"different-provider-response",
        usage:{input_tokens:10,output_tokens:4,input_tokens_details:{cached_tokens:0,cache_write_tokens:0}}})));
      else if(mode==="USAGE_MISMATCH")replaceAndBind(Buffer.from(JSON.stringify({id:receipt.provider_response_id,
        usage:{input_tokens:11,output_tokens:4,input_tokens_details:{cached_tokens:0,cache_write_tokens:0}}})));
      mutation.close();item.ledger.close();
      const result=item.recoveryLedger.recoverHardeningPaidCall({childRunId:item.runId,
        reservationId:item.reservation.reservationId,recoveryOwnerId:`${tag}-owner`,
        recoveryIdempotencyKey:`${tag}-recovery`,rawRecoveryToken:`${tag}-token`,nowMs:NOW_MS+1_001});
      expect(result.outcome).toBe("AMBIGUOUS");
      expect(result.reconciliation.invalidReceiptObservation).toMatchObject({failureCode:mode==="SYMLINK"?"NOT_REGULAR_FILE":mode,
        modelCallKind:"ORIGINAL_SUCCEEDED"});
      expect(item.supervisor.listPendingHardeningPaidCallFinalizations(item.runId)).toHaveLength(1);
      item.recoveryLedger.finalizeRunningAgentExecutions(item.runId,"FAILED",new Date(NOW_MS+1_002).toISOString(),
        "HARDENING_PAID_CALL_RECOVERY_TERMINAL");
      const current=item.supervisor.getRun(item.runId);
      item.supervisor.transition({runId:item.runId,expectedStateVersion:current.stateVersion,nextState:"CANCELLATION_PENDING",
        reasonCode:"HARDENING_PAID_CALL_RECOVERY_TERMINAL",manifestHash:current.manifestHash,
        idempotencyKey:`${tag}:cancellation-pending`});
      const finalization=item.supervisor.listPendingHardeningPaidCallFinalizations(item.runId)[0]!;
      const consume={finalizationId:finalization.id,ownerId:`${tag}-consumer`,rawToken:`${tag}-consumer-token`,
        idempotencyKey:`${tag}-consume`,nowMs:NOW_MS+1_003,expectedSuccessor:"RECOVERY_TERMINAL" as const};
      if(mode==="PROVIDER_ID_MISMATCH"){
        const postObservation=new Database(item.dbPath);
        const metadata=postObservation.query("SELECT size_bytes FROM artifacts WHERE id=?").get(receipt.artifact_id) as {size_bytes:number};
        postObservation.query("UPDATE artifacts SET size_bytes=? WHERE id=?").run(metadata.size_bytes+1,receipt.artifact_id);
        expect(()=>item.supervisor.consumeHardeningPaidCallFinalization(consume)).toThrow();
        expect(postObservation.query(`SELECT status,claim_owner_id,claim_generation FROM hardening_paid_call_finalizations WHERE id=?`)
          .get(finalization.id)).toEqual({status:"PENDING",claim_owner_id:null,claim_generation:0});
        postObservation.query("UPDATE artifacts SET size_bytes=? WHERE id=?").run(metadata.size_bytes,receipt.artifact_id);
        postObservation.close();
      }
      expect(item.supervisor.consumeHardeningPaidCallFinalization(consume)).toMatchObject({status:"APPLIED",outcome:"AMBIGUOUS"});
      expect(item.supervisor.consumeHardeningPaidCallFinalization(consume)).toMatchObject({status:"APPLIED",outcome:"AMBIGUOUS"});
      item.recoveryLedger.close();item.supervisor.close();
    }
  });

  test("C missing provider-response artifact row is fatal database corruption with zero recovery mutation", () => {
    const item=paidCallFixture("artifact-row-fatal","RESPONSE_RECORDED");
    const mutation=new Database(item.dbPath);
    mutation.exec("PRAGMA foreign_keys=OFF");
    const reservationBefore=mutation.query("SELECT * FROM hardening_child_model_reservations WHERE id=?")
      .get(item.reservation.reservationId);
    const budgetBefore=mutation.query("SELECT * FROM hardening_child_budget_authorities WHERE child_run_id=?").get(item.runId);
    const slotBefore=mutation.query("SELECT * FROM hardening_model_call_slots WHERE child_run_id=?").get(item.runId);
    const finalizationBefore=mutation.query("SELECT * FROM hardening_paid_call_finalizations WHERE child_run_id=?").get(item.runId);
    const callsBefore=mutation.query("SELECT COUNT(*) AS count FROM model_calls WHERE run_id=?").get(item.runId);
    const artifact=mutation.query("SELECT provider_response_artifact_id FROM hardening_child_model_reservations WHERE id=?")
      .get(item.reservation.reservationId) as {provider_response_artifact_id:string};
    mutation.query("DELETE FROM artifacts WHERE id=?").run(artifact.provider_response_artifact_id);
    mutation.close();item.ledger.close();
    const recover=()=>item.recoveryLedger.recoverHardeningPaidCall({childRunId:item.runId,
      reservationId:item.reservation.reservationId,recoveryOwnerId:"artifact-row-fatal-owner",
      recoveryIdempotencyKey:"artifact-row-fatal-recovery",rawRecoveryToken:"artifact-row-fatal-token",nowMs:NOW_MS+1_001});
    let failure:unknown;
    try{recover();}catch(error){failure=error;}
    expect(failure).toBeInstanceOf(DatabaseIntegrityCorruptionError);
    expect(failure).toMatchObject({code:"DATABASE_INTEGRITY_CORRUPTION",retryable:false});
    expect(recover).toThrow(DatabaseIntegrityCorruptionError);
    const verify=new Database(item.dbPath,{readonly:true});
    expect(verify.query("SELECT * FROM hardening_child_model_reservations WHERE id=?").get(item.reservation.reservationId))
      .toEqual(reservationBefore);
    expect(verify.query("SELECT * FROM hardening_child_budget_authorities WHERE child_run_id=?").get(item.runId)).toEqual(budgetBefore);
    expect(verify.query("SELECT * FROM hardening_model_call_slots WHERE child_run_id=?").get(item.runId)).toEqual(slotBefore);
    expect(verify.query("SELECT * FROM hardening_paid_call_finalizations WHERE child_run_id=?").get(item.runId)).toEqual(finalizationBefore);
    expect(verify.query("SELECT COUNT(*) AS count FROM model_calls WHERE run_id=?").get(item.runId)).toEqual(callsBefore);
    verify.close();item.recoveryLedger.close();item.supervisor.close();
  });

  test("C model-call and artifact tuple corruption is fatal before the recovery claim", () => {
    for(const mode of ["MODEL_REFS","MODEL_ROUTE","MODEL_ROW_MISSING","ARTIFACT_TYPE","ARTIFACT_TRUST",
      "ARTIFACT_PRODUCER"] as const){
      const tag=`fatal-${mode.toLowerCase()}`,item=paidCallFixture(tag,"RESPONSE_RECORDED");
      const mutation=new Database(item.dbPath);mutation.exec("PRAGMA foreign_keys=OFF");
      const target=mutation.query(`SELECT r.model_call_id,r.provider_response_artifact_id,m.input_context_refs_json
        FROM hardening_child_model_reservations r JOIN model_calls m ON m.id=r.model_call_id WHERE r.id=?`)
        .get(item.reservation.reservationId) as {model_call_id:string;provider_response_artifact_id:string;input_context_refs_json:string};
      const reservationBefore=mutation.query("SELECT * FROM hardening_child_model_reservations WHERE id=?")
        .get(item.reservation.reservationId);
      const budgetBefore=mutation.query("SELECT * FROM hardening_child_budget_authorities WHERE child_run_id=?").get(item.runId);
      const slotBefore=mutation.query("SELECT * FROM hardening_model_call_slots WHERE child_run_id=?").get(item.runId);
      if(mode==="MODEL_REFS")mutation.query("UPDATE model_calls SET input_context_refs_json=? WHERE id=?")
        .run(canonicalJson([...(JSON.parse(target.input_context_refs_json) as string[]),sha256(`${tag}:extra`)]),target.model_call_id);
      else if(mode==="MODEL_ROUTE")mutation.query("UPDATE model_calls SET resolved_model='gpt-5.6-terra-drift' WHERE id=?")
        .run(target.model_call_id);
      else if(mode==="MODEL_ROW_MISSING")mutation.query("DELETE FROM model_calls WHERE id=?").run(target.model_call_id);
      else if(mode==="ARTIFACT_TYPE")mutation.query("UPDATE artifacts SET type='MODEL_PROVIDER_RESPONSE_DRIFT' WHERE id=?")
        .run(target.provider_response_artifact_id);
      else if(mode==="ARTIFACT_TRUST")mutation.query("UPDATE artifacts SET trusted=0 WHERE id=?").run(target.provider_response_artifact_id);
      else mutation.query("UPDATE artifacts SET producer_id='untrusted-producer' WHERE id=?").run(target.provider_response_artifact_id);
      mutation.close();item.ledger.close();
      const recover=()=>item.recoveryLedger.recoverHardeningPaidCall({childRunId:item.runId,
        reservationId:item.reservation.reservationId,recoveryOwnerId:`${tag}-owner`,recoveryIdempotencyKey:`${tag}-recovery`,
        rawRecoveryToken:`${tag}-token`,nowMs:NOW_MS+1_001});
      let failure:unknown;try{recover();}catch(error){failure=error;}
      expect(failure).toMatchObject({code:"DATABASE_INTEGRITY_CORRUPTION",retryable:false});
      expect(recover).toThrow(DatabaseIntegrityCorruptionError);
      const verify=new Database(item.dbPath,{readonly:true});
      expect(verify.query("SELECT * FROM hardening_child_model_reservations WHERE id=?").get(item.reservation.reservationId))
        .toEqual(reservationBefore);
      expect(verify.query("SELECT * FROM hardening_child_budget_authorities WHERE child_run_id=?").get(item.runId)).toEqual(budgetBefore);
      expect(verify.query("SELECT * FROM hardening_model_call_slots WHERE child_run_id=?").get(item.runId)).toEqual(slotBefore);
      expect(verify.query("SELECT COUNT(*) AS count FROM hardening_paid_call_finalizations WHERE child_run_id=?").get(item.runId))
        .toEqual({count:0});
      verify.close();item.recoveryLedger.close();item.supervisor.close();
    }
  });

  test("F1 failed pre-dispatch callback remains unsent and invokes the deterministic void hook", async () => {
    const runId = "hardening-crash-cas-before-await";
    const events: string[] = [];
    let providerCalls = 0;
    const task = manifest(runId);
    const builder = new CodexBuilder({
      manifest: task,
      workspace: { runId } as never,
      workspaceManager: { diffAsync: async () => "" } as never,
      executor: {} as never,
      conservativeLocalInputAccounting: true,
      transport: {
        async create() {
          providerCalls += 1;
          events.push("provider");
          return { id: "must-not-send", output: [] };
        },
      },
      reserveModelCall() {
        events.push("reserve");
        return {
          reservationId: "reservation-cas-before-await",
          dispatchAllowed: true,
          clientRequestId: "00000000-0000-4000-8000-000000000001",
        };
      },
      async beforeModelDispatch() {
        events.push("cas-dispatching");
        throw new Error("crash after durable dispatch CAS");
      },
      async onModelResponseReceived() {
        throw new Error("no response can be recorded");
      },
      async onReservedUnsentFailure() {
        events.push("unsafe-unsent-void");
      },
    });
    await expect(builder.run()).rejects.toThrow("crash after durable dispatch CAS");
    expect(events).toEqual(["reserve", "cas-dispatching", "unsafe-unsent-void"]);
    expect(providerCalls).toBe(0);
  });

  test("F2-F3 same-run worker lease race has one winner and stale authority cannot survive replacement", async () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-hardening-worker-race-"));
    roots.push(root);
    const dbPath = join(root, "worker.db");
    let clock = NOW_MS;
    let id = 0;
    const create = () => new EngineerWorkerLeaseManager({
      dbPath,
      tokenSecret: WORKER_LEASE_SECRET,
      maxConcurrentLeases: 2,
      now: () => new Date(clock),
      idFactory: () => `lease-${++id}`,
      recoverExpiredLease: () => undefined,
    });
    const first = create();
    const second = create();
    const attempts = await Promise.allSettled([
      Promise.resolve().then(() => first.acquire({
        resourceKey: "hardening-child-run",
        ownerId: "worker-a",
        ttlMs: 1_000,
        idempotencyKey: "acquire-a",
      })),
      Promise.resolve().then(() => second.acquire({
        resourceKey: "hardening-child-run",
        ownerId: "worker-b",
        ttlMs: 1_000,
        idempotencyKey: "acquire-b",
      })),
    ]);
    const fulfilled = attempts.filter((attempt) => attempt.status === "fulfilled");
    const rejected = attempts.filter((attempt) => attempt.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(WorkerLeaseConflictError);
    const winner = (fulfilled[0] as PromiseFulfilledResult<ReturnType<typeof first.acquire>>).value;
    const winnerManager = winner.lease.ownerId === "worker-a" ? first : second;
    clock += 1_001;
    expect(() => winnerManager.assertActive({
      leaseId: winner.lease.leaseId,
      ownerId: winner.lease.ownerId,
      fencingToken: winner.lease.fencingToken,
      leaseToken: winner.leaseToken,
    })).toThrow(StaleWorkerLeaseError);
    const replacement = second.acquire({
      resourceKey: "hardening-child-run",
      ownerId: "recovery-worker",
      ttlMs: 1_000,
      idempotencyKey: "replacement",
    });
    expect(replacement.lease.fencingToken).toBe(winner.lease.fencingToken + 1);
    first.close();
    second.close();
  });
});
