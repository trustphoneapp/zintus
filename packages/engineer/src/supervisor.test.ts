import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  IdempotencyConflictError,
  InvalidTransitionError,
  ManifestIntegrityError,
  StateVersionConflictError,
} from "./errors.js";
import {
  createEngineerSupervisor,
  MAX_BUILDER_MODEL_CALLS_PER_RUN,
  type EngineerSupervisor,
} from "./supervisor.js";
import type { RepositoryReference, TaskManifestContent } from "./contracts.js";
import { RetryBudgetsSchema, RiskFeaturesSchema } from "./contracts.js";
import { MAX_BUILDER_TOOL_ROUNDS } from "./codex-builder.js";
import { sha256 } from "./hash.js";
import { LocalArtifactStore } from "./artifact-store.js";
import { AgentExecutionRecordSchema } from "./execution-contracts.js";
import { EngineerLedger } from "./ledger.js";
import { PlanProposalSchema, planProposalContentHash } from "./planning.js";
import { transitionReplanToPlanReadyForTest, transitionToPlanReadyForTest } from "./test-planning-evidence.js";

const repository: RepositoryReference = {
  repositoryId: "repo-zintus",
  provider: "github",
  owner: "trustphoneapp",
  name: "zintus",
  url: "https://github.com/trustphoneapp/zintus",
  baseBranch: "main",
  baseCommitSha: "a".repeat(40),
};

function createSupervisor(): EngineerSupervisor {
  let id = 0;
  let seconds = 0;
  return createEngineerSupervisor({
    dbPath: ":memory:",
    idFactory: () => `generated-${++id}`,
    now: () => new Date(Date.UTC(2026, 6, 14, 12, 0, seconds++)),
  });
}

function receiveAndPlan(supervisor: EngineerSupervisor, runId = "run-1") {
  const received = supervisor.receiveRequest({
    runId,
    userId: "user-1",
    repository,
    request: "Add evidence-bound Engineer workflow",
  });
  return transitionToPlanReadyForTest({
    supervisor,
    received,
    normalizedRequest: "Add an evidence-bound Engineer workflow.",
    manifest: manifestFor(runId),
    key: runId,
  });
}

function manifestFor(runId: string, version = 1, overrides: Partial<TaskManifestContent> = {}): TaskManifestContent {
  return {
    manifestVersion: version,
    runId,
    repository,
    request: {
      original: "Add evidence-bound Engineer workflow",
      normalized: "Add an evidence-bound Engineer workflow.",
    },
    acceptanceCriteria: [{
      criterionId: "criterion-1",
      statement: "Every state promotion is recorded.",
      verificationMethod: "Inspect the append-only ledger test.",
      priority: "MUST",
    }],
    testPlan: [{
      testId: "test-1",
      criterionIds: ["criterion-1"],
      type: "UNIT",
      description: "Reject stale and invalid transitions.",
      command: "bun test packages/engineer/src/",
    }],
    allowedPaths: ["packages/engineer/**"],
    deniedPaths: [".env*"],
    allowedCommands: ["bun test packages/engineer/src/"],
    prohibitedCommands: ["git push", "gh pr create"],
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
    timeBudgetSeconds: 3_600,
    tokenBudget: 200_000,
    costBudgetUsd: 20,
    createdAt: "2026-07-14T12:00:00.000Z",
    ...overrides,
  };
}

function freeze(supervisor: EngineerSupervisor, runId = "run-1") {
  const run = supervisor.getRun(runId);
  return supervisor.freezePlan({
    runId,
    expectedStateVersion: run.stateVersion,
    manifest: manifestFor(runId),
    actorId: "planner-supervisor",
    idempotencyKey: `${runId}:freeze`,
  });
}

describe("Engineer Supervisor foundation", () => {
  test("does not expose legacy raw Reviewer persistence or recovery authority", () => {
    const supervisor = createSupervisor() as unknown as Record<string, unknown>;
    for (const name of [
      "recordReviewerSession", "reviewerPersistenceRecoveryCandidate",
      "recoverReviewerSession", "recordedReviewerOutput",
    ]) expect(name in supervisor).toBe(false);
    (supervisor as unknown as EngineerSupervisor).close();
  });

  test("the durable Builder-call backstop covers the default bounded workflow", () => {
    const retries = RetryBudgetsSchema.parse({});
    const completeWorkflowEnvelope =
      (1 + retries.builderRepairAttempts) * MAX_BUILDER_TOOL_ROUNDS
      + retries.transientModelAttempts;
    expect(MAX_BUILDER_MODEL_CALLS_PER_RUN).toBeGreaterThanOrEqual(completeWorkflowEnvelope);
  });

  test("atomically elects one immutable Builder dispatch winner and rejects counterfeit or stale rewrites", () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-builder-dispatch-claim-"));
    const dbPath = join(root, "engineer.db");
    const supervisor = createEngineerSupervisor({ dbPath, now: () => new Date("2026-07-17T12:00:00.000Z") });
    receiveAndPlan(supervisor, "run-builder-claim");
    const firstLedger = new EngineerLedger(dbPath);
    const secondLedger = new EngineerLedger(dbPath);
    const inputHash = sha256("same-repair-authority");
    const firstRecord = {
      agentExecutionId: "builder-winner", runId: "run-builder-claim", role: "BUILDER" as const,
      modelTier: "GPT-5.6_TERRA" as const, status: "RUNNING" as const, inputHash,
      outputArtifactId: null, startedAt: "2026-07-17T12:00:01.000Z", completedAt: null,
    };
    const secondRecord = { ...firstRecord, agentExecutionId: "builder-loser", startedAt: "2026-07-17T12:00:02.000Z" };
    for (const malformed of [
      { ...firstRecord, outputArtifactId: "unexpected-output" },
      { ...firstRecord, status: "SUCCEEDED", completedAt: null },
      { ...firstRecord, status: "FAILED", outputArtifactId: "unexpected-output", completedAt: "2026-07-17T12:00:03.000Z" },
      { ...firstRecord, status: "PAUSED", completedAt: null },
    ]) expect(() => AgentExecutionRecordSchema.parse(malformed)).toThrow();
    expect(() => firstLedger.recordAgentExecution({
      ...firstRecord, agentExecutionId: "terminal-without-running", status: "FAILED", completedAt: "2026-07-17T12:00:01.000Z",
    })).toThrow("missing-running-origin");
    const winner = firstLedger.claimBuilderDispatch(firstRecord, { ownerId: "worker-old", fencingToken: 1 });
    const loser = secondLedger.claimBuilderDispatch(secondRecord, { ownerId: "worker-new", fencingToken: 2 });
    expect(winner).toMatchObject({ won: true, claim: { agentExecutionId: "builder-winner", workerOwnerId: "worker-old", workerFencingToken: 1 } });
    expect(loser).toMatchObject({ won: false, claim: { agentExecutionId: "builder-winner" }, execution: { agentExecutionId: "builder-winner" } });
    expect(secondLedger.builderRepairExecutions("run-builder-claim", inputHash)).toHaveLength(1);

    const store = new LocalArtifactStore({ root: join(root, "artifacts") });
    const output = supervisor.recordArtifact(store.put({
      runId: "run-builder-claim", type: "BUILDER_REPAIR_RESULT", bytes: "{}",
      producerType: "SYSTEM", producerId: "builder-winner", trusted: false,
    }));
    firstLedger.recordAgentExecution({ ...firstRecord, status: "SUCCEEDED", outputArtifactId: output.artifactId, completedAt: "2026-07-17T12:00:03.000Z" });
    expect(() => secondLedger.recordAgentExecution(firstRecord)).toThrow(IdempotencyConflictError);
    expect(() => secondLedger.recordAgentExecution({
      ...firstRecord, status: "SUCCEEDED", outputArtifactId: "counterfeit-output", completedAt: "2026-07-17T12:00:03.000Z",
    })).toThrow(IdempotencyConflictError);

    const counterfeit = new Database(dbPath);
    expect(() => counterfeit.query(`INSERT INTO builder_dispatch_claims
      (run_id, input_hash, agent_execution_id, model_tier, worker_owner_id, worker_fencing_token, claimed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      "run-builder-claim", sha256("counterfeit"), "builder-winner", "GPT-5.6_TERRA", null, null, "2026-07-17T12:00:04.000Z",
    )).toThrow();
    expect(() => counterfeit.query("UPDATE builder_dispatch_claims SET claimed_at = ? WHERE run_id = ? AND input_hash = ?")
      .run("2026-07-17T12:00:05.000Z", "run-builder-claim", inputHash)).toThrow("immutable");
    counterfeit.close();
    firstLedger.close();
    secondLedger.close();
    supervisor.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("rejects invalid intake before it can poison the durable ledger", () => {
    const supervisor = createSupervisor();
    expect(() => supervisor.receiveRequest({
      runId: "oversized-run", userId: "user-1", repository,
      request: "x".repeat(100_001),
    })).toThrow();
    expect(supervisor.listRuns()).toEqual([]);
    supervisor.close();
  });

  test("rejects relationally invalid manifest contracts before persistence", () => {
    const supervisor = createSupervisor();
    const run = receiveAndPlan(supervisor);
    expect(() => supervisor.freezePlan({
      runId: run.runId,
      expectedStateVersion: run.stateVersion,
      manifest: manifestFor(run.runId, 1, {
        testPlan: [{
          testId: "test-unknown-criterion",
          criterionIds: ["criterion-does-not-exist"],
          type: "UNIT",
          description: "This reference must fail validation.",
        }],
      }),
      actorId: "planner-supervisor",
      idempotencyKey: "invalid-manifest",
    })).toThrow("unknown criterion");
    expect(supervisor.listManifestVersions(run.runId)).toHaveLength(0);
    supervisor.close();
  });

  test("cannot downgrade the Supervisor risk tier or remove its human gate at freeze", () => {
    const supervisor = createSupervisor();
    let run = supervisor.receiveRequest({
      runId: "risk-floor-run", userId: "user-1", repository,
      request: "Change authentication enforcement",
      initialRiskFeatures: { touchesAuthentication: true },
    });
    run = transitionToPlanReadyForTest({
      supervisor,
      received: run,
      normalizedRequest: "Change authentication enforcement.",
      manifest: manifestFor(run.runId, 1, {
        request: { original: "Change authentication enforcement", normalized: "Change authentication enforcement." },
        riskTier: "HIGH", humanGateRequired: true,
      }),
      key: "risk",
    });
    expect(run.riskTier).toBe("HIGH");
    expect(() => supervisor.freezePlan({
      runId: run.runId, expectedStateVersion: run.stateVersion,
      manifest: manifestFor(run.runId, 1, {
        request: { original: "Change authentication enforcement", normalized: "Change authentication enforcement." },
        riskTier: "LOW", humanGateRequired: false,
      }),
      actorId: "malicious-client", idempotencyKey: "risk:downgrade",
    })).toThrow("must match the Supervisor decision");
    expect(supervisor.getRun(run.runId)).toMatchObject({ riskTier: "HIGH", humanGateRequired: true, state: "PLAN_READY" });
    supervisor.close();
  });

  test("allows a provisional medium intake to become low-risk before freeze only after deterministic eligibility checks", () => {
    const supervisor = createSupervisor();
    let run = supervisor.receiveRequest({ runId: "low-risk-run", userId: "user-1", repository, request: "Correct a documentation typo" });
    run = supervisor.normalizeRequest({ runId: run.runId, expectedStateVersion: run.stateVersion, normalizedRequest: "Correct a documentation typo.", idempotencyKey: "low:normalize" }).run;
    run = supervisor.transition({ runId: run.runId, expectedStateVersion: run.stateVersion, nextState: "PLANNING", reasonCode: "PLANNING_STARTED", idempotencyKey: "low:planning" }).run;
    const risk = supervisor.assessRunRisk(run.runId, run.stateVersion, RiskFeaturesSchema.parse({
      documentationOnly: true, requiredChecksPassed: true, testCoveragePercent: 100,
    }), { autoApproveLowRisk: true });
    expect(risk).toMatchObject({ riskTier: "LOW", humanGateRequired: false });
    supervisor.close();
  });

  test("freezes a hash-bound immutable manifest and replays duplicate delivery", () => {
    const supervisor = createSupervisor();
    receiveAndPlan(supervisor);
    const first = freeze(supervisor);
    expect(first.applied).toBe(true);
    expect(first.run.state).toBe("PLAN_FROZEN");
    expect(first.run.manifestHash).toMatch(/^sha256:[a-f0-9]{64}$/);

    const replay = supervisor.freezePlan({
      runId: "run-1",
      expectedStateVersion: 3,
      manifest: manifestFor("run-1"),
      actorId: "planner-supervisor",
      idempotencyKey: "run-1:freeze",
    });
    expect(replay.applied).toBe(false);
    expect(replay.event.eventId).toBe(first.event.eventId);
    expect(supervisor.listEvents("run-1")).toHaveLength(4);

    const fetched = supervisor.getManifest("run-1");
    expect(fetched?.acceptanceCriteria[0]?.statement).toBe("Every state promotion is recorded.");
    const contract = supervisor.getRequiredLaneContract("run-1");
    expect(contract).toMatchObject({
      runId: "run-1",
      manifestHash: first.run.manifestHash,
      requiredCriterionIds: ["criterion-1"],
      requiredTestIds: ["test-1"],
    });
    expect(contract?.planningBinding.contextManifestHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    if (fetched) fetched.acceptanceCriteria[0]!.statement = "tampered in caller memory";
    expect(supervisor.getManifest("run-1")?.acceptanceCriteria[0]?.statement).toBe(
      "Every state promotion is recorded.",
    );
    supervisor.close();
  });

  test("never tightens the budget for a rejected or conflicting freeze", () => {
    const supervisor = createSupervisor();
    const planned = receiveAndPlan(supervisor, "run-budget-freeze");
    const before = supervisor.getBudget(planned.runId);
    const tighter = manifestFor(planned.runId, 1, { costBudgetUsd: 1, tokenBudget: 1_000 });

    expect(() => supervisor.freezePlan({
      runId: planned.runId,
      expectedStateVersion: planned.stateVersion,
      manifest: tighter,
      actorId: "planner-supervisor",
      idempotencyKey: "rejected-tight-budget",
    })).toThrow("persisted plan proposal");
    expect(supervisor.getBudget(planned.runId)).toMatchObject({ limits: before.limits, revision: before.revision });
    expect(supervisor.listManifestVersions(planned.runId)).toEqual([]);
    expect(supervisor.getRequiredLaneContract(planned.runId)).toBeNull();

    const frozen = freeze(supervisor, planned.runId);
    const afterFreeze = supervisor.getBudget(planned.runId);
    expect(() => supervisor.freezePlan({
      runId: planned.runId,
      expectedStateVersion: frozen.run.stateVersion,
      manifest: tighter,
      actorId: "planner-supervisor",
      idempotencyKey: `${planned.runId}:freeze`,
    })).toThrow();
    expect(supervisor.getBudget(planned.runId)).toMatchObject({
      limits: afterFreeze.limits,
      revision: afterFreeze.revision,
    });
    expect(supervisor.listManifestVersions(planned.runId)).toHaveLength(1);
    supervisor.close();
  });

  test("rolls back the entire freeze when Required Lane contract persistence fails", () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-required-lane-freeze-"));
    const dbPath = join(root, "engineer.db");
    let id = 0;
    const supervisor = createEngineerSupervisor({
      dbPath,
      idFactory: () => `atomic-${++id}`,
      now: () => new Date("2026-07-17T12:00:00.000Z"),
    });
    const planned = receiveAndPlan(supervisor, "run-atomic-freeze");
    const fault = new Database(dbPath);
    fault.exec(`CREATE TRIGGER reject_required_lane_contract
      BEFORE INSERT ON required_lane_contracts
      BEGIN SELECT RAISE(ABORT, 'injected contract persistence failure'); END;`);

    expect(() => supervisor.freezePlan({
      runId: planned.runId,
      expectedStateVersion: planned.stateVersion,
      manifest: manifestFor(planned.runId),
      actorId: "planner-supervisor",
      idempotencyKey: "atomic-freeze",
    })).toThrow("injected contract persistence failure");
    expect(supervisor.getRun(planned.runId)).toMatchObject({ state: "PLAN_READY", manifestHash: null });
    expect(supervisor.listManifestVersions(planned.runId)).toEqual([]);
    expect(supervisor.getRequiredLaneContract(planned.runId)).toBeNull();
    expect(supervisor.listEvents(planned.runId).at(-1)?.nextState).toBe("PLAN_READY");

    fault.close();
    supervisor.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("rolls back a tightened budget when state promotion fails after the budget update", () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-required-lane-budget-rollback-"));
    const dbPath = join(root, "engineer.db");
    let id = 0;
    const supervisor = createEngineerSupervisor({
      dbPath,
      idFactory: () => `budget-atomic-${++id}`,
      now: () => new Date("2026-07-17T12:00:00.000Z"),
    });
    const runId = "run-budget-atomic-freeze";
    const received = supervisor.receiveRequest({
      runId, userId: "user-1", repository, request: "Add evidence-bound Engineer workflow",
    });
    const tighter = manifestFor(runId, 1, { costBudgetUsd: 1, tokenBudget: 1_000, timeBudgetSeconds: 300 });
    const planned = transitionToPlanReadyForTest({
      supervisor,
      received,
      normalizedRequest: "Add an evidence-bound Engineer workflow.",
      manifest: tighter,
      key: "budget-atomic",
    });
    const before = supervisor.getBudget(runId);
    const beforeEvents = supervisor.listEvents(runId).length;
    const fault = new Database(dbPath);
    fault.exec(`CREATE TRIGGER reject_plan_frozen_event
      BEFORE INSERT ON run_state_events
      WHEN NEW.next_state = 'PLAN_FROZEN'
      BEGIN SELECT RAISE(ABORT, 'injected state promotion failure'); END;`);

    expect(() => supervisor.freezePlan({
      runId,
      expectedStateVersion: planned.stateVersion,
      manifest: tighter,
      actorId: "planner-supervisor",
      idempotencyKey: "budget-atomic-freeze",
    })).toThrow("injected state promotion failure");
    expect(supervisor.getBudget(runId)).toMatchObject({ limits: before.limits, revision: before.revision });
    expect(supervisor.getRun(runId)).toMatchObject({ state: "PLAN_READY", manifestHash: null });
    expect(supervisor.listManifestVersions(runId)).toEqual([]);
    expect(supervisor.getRequiredLaneContract(runId)).toBeNull();
    expect(supervisor.listEvents(runId)).toHaveLength(beforeEvents);
    for (const table of ["task_manifest_versions", "required_lane_contracts", "acceptance_criteria"] as const) {
      expect(fault.query(`SELECT COUNT(*) AS count FROM ${table} WHERE run_id = ?`).get(runId))
        .toEqual({ count: 0 });
    }

    fault.close();
    supervisor.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("rejects a plan proposal writer that lost the planning state race", () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-plan-proposal-race-"));
    const dbPath = join(root, "engineer.db");
    let id = 0;
    const supervisor = createEngineerSupervisor({
      dbPath,
      idFactory: () => `proposal-race-${++id}`,
      now: () => new Date("2026-07-17T12:00:00.000Z"),
    });
    const planned = receiveAndPlan(supervisor, "run-proposal-race");
    const original = supervisor.latestPlanProposal(planned.runId)!;
    const planningAnalysis = { ...original.planningAnalysis, architectureSummary: "Late competing proposal" };
    const proposalHash = planProposalContentHash({
      manifest: original.manifest,
      planningAnalysis,
      contextManifestHash: original.contextManifestHash,
    });
    const artifactStore = new LocalArtifactStore({ root: join(root, "late-artifacts") });
    const artifact = supervisor.recordArtifact(artifactStore.put({
      runId: planned.runId,
      type: "PLAN_PROPOSAL",
      bytes: JSON.stringify({
        proposalSchemaVersion: original.proposalSchemaVersion,
        plannerPolicyVersion: original.plannerPolicyVersion,
        manifest: original.manifest,
        planningAnalysis,
        contextManifestHash: original.contextManifestHash,
      }),
      producerType: "SYSTEM",
      producerId: "race-fixture",
      trusted: true,
    }));
    const lateProposal = PlanProposalSchema.parse({
      ...original,
      planProposalId: "late-proposal",
      planningAnalysis,
      proposalHash,
      artifactId: artifact.artifactId,
    });
    const stalePlanningVersion = planned.stateVersion - 1;
    const competingLedger = new EngineerLedger(dbPath);

    expect(() => competingLedger.recordPlanProposal(lateProposal, stalePlanningVersion))
      .toThrow(StateVersionConflictError);
    expect(supervisor.latestPlanProposal(planned.runId)?.proposalHash).toBe(original.proposalHash);

    competingLedger.close();
    supervisor.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("detects swapped Required Lane JSON instead of trusting relational metadata", () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-required-lane-binding-"));
    const dbPath = join(root, "engineer.db");
    let id = 0;
    const supervisor = createEngineerSupervisor({
      dbPath,
      idFactory: () => `binding-${++id}`,
      now: () => new Date("2026-07-17T12:00:00.000Z"),
    });
    receiveAndPlan(supervisor, "run-binding-one");
    freeze(supervisor, "run-binding-one");
    receiveAndPlan(supervisor, "run-binding-two");
    freeze(supervisor, "run-binding-two");

    const tamper = new Database(dbPath);
    const other = tamper.query("SELECT contract_json FROM required_lane_contracts WHERE run_id = ?")
      .get("run-binding-two") as { contract_json: string };
    tamper.query("UPDATE required_lane_contracts SET contract_json = ? WHERE run_id = ?")
      .run(other.contract_json, "run-binding-one");
    expect(() => supervisor.getRequiredLaneContract("run-binding-one"))
      .toThrow("does not match its relational binding");

    tamper.close();
    supervisor.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("rejects stale writers, illegal transitions, and semantic idempotency-key reuse", () => {
    const supervisor = createSupervisor();
    const run = receiveAndPlan(supervisor);
    expect(() => supervisor.transition({
      runId: run.runId,
      expectedStateVersion: run.stateVersion - 1,
      nextState: "PLAN_FROZEN",
      reasonCode: "BAD",
      idempotencyKey: "bad-version",
    })).toThrow(StateVersionConflictError);
    expect(() => supervisor.transition({
      runId: run.runId,
      expectedStateVersion: run.stateVersion,
      nextState: "IMPLEMENTING",
      reasonCode: "SKIP_MANIFEST",
      idempotencyKey: "illegal",
    })).toThrow(InvalidTransitionError);

    const first = supervisor.transition({
      runId: run.runId,
      expectedStateVersion: run.stateVersion,
      nextState: "REPLANNING",
      reasonCode: "PLAN_NEEDS_WORK",
      idempotencyKey: "same-key",
    });
    const replay = supervisor.transition({
      runId: run.runId,
      expectedStateVersion: run.stateVersion,
      nextState: "REPLANNING",
      reasonCode: "PLAN_NEEDS_WORK",
      idempotencyKey: "same-key",
    });
    expect(first.applied).toBe(true);
    expect(replay.applied).toBe(false);
    expect(() => supervisor.transition({
      runId: run.runId,
      expectedStateVersion: run.stateVersion,
      nextState: "REPLANNING",
      reasonCode: "DIFFERENT_MEANING",
      idempotencyKey: "same-key",
    })).toThrow(IdempotencyConflictError);
    supervisor.close();
  });

  test("requires new immutable manifest versions after replanning", () => {
    const supervisor = createSupervisor();
    receiveAndPlan(supervisor);
    let run = freeze(supervisor).run;
    for (const [nextState, reason] of [
      ["SANDBOX_COLD_PROVISIONING", "COLD_SANDBOX"],
      ["SANDBOX_PREFLIGHT", "PREFLIGHT"],
      ["SANDBOX_READY", "READY"],
      ["IMPLEMENTING", "BUILDING"],
      ["REPLANNING", "SCOPE_CHANGE"],
    ] as const) {
      run = supervisor.transition({
        runId: run.runId,
        expectedStateVersion: run.stateVersion,
        nextState,
        reasonCode: reason,
        manifestHash: run.manifestHash,
        idempotencyKey: `run-1:${reason}`,
      }).run;
    }
    run = transitionReplanToPlanReadyForTest({
      supervisor,
      replanning: run,
      manifest: manifestFor(run.runId, 2, {
        acceptanceCriteria: [{
          criterionId: "criterion-1",
          statement: "Every revised state promotion is recorded.",
          verificationMethod: "Inspect the versioned ledger test.",
          priority: "MUST",
        }],
      }),
      key: "run-1:replan",
    });
    expect(() => supervisor.freezePlan({
      runId: run.runId,
      expectedStateVersion: run.stateVersion,
      manifest: manifestFor(run.runId, 1),
      actorId: "planner-supervisor",
      idempotencyKey: "run-1:freeze-v1-again",
    })).toThrow(ManifestIntegrityError);
    const second = supervisor.freezePlan({
      runId: run.runId,
      expectedStateVersion: run.stateVersion,
      manifest: manifestFor(run.runId, 2, {
        acceptanceCriteria: [{
          criterionId: "criterion-1",
          statement: "Every revised state promotion is recorded.",
          verificationMethod: "Inspect the versioned ledger test.",
          priority: "MUST",
        }],
      }),
      actorId: "planner-supervisor",
      idempotencyKey: "run-1:freeze-v2",
    });
    expect(second.run.manifestHash).not.toBe(supervisor.getManifest("run-1", 1)?.manifestHash);
    expect(supervisor.listManifestVersions("run-1")).toHaveLength(2);
    supervisor.close();
  });

  test("reserves REVIEW_APPROVED exclusively for verified-candidate promotion", () => {
    const supervisor = createSupervisor();
    receiveAndPlan(supervisor);
    let run = freeze(supervisor).run;
    const path = [
      "SANDBOX_COLD_PROVISIONING",
      "SANDBOX_PREFLIGHT",
      "SANDBOX_READY",
      "IMPLEMENTING",
      "FAST_CHECKS",
      "UNIT_TESTING",
      "INTEGRATION_TESTING",
      "SECURITY_REVIEW",
      "REVIEWING",
    ] as const;
    for (const nextState of path) {
      run = supervisor.transition({
        runId: run.runId,
        expectedStateVersion: run.stateVersion,
        nextState,
        reasonCode: `ENTER_${nextState}`,
        manifestHash: run.manifestHash,
        idempotencyKey: `run-1:${nextState}`,
      }).run;
    }
    for (const actorType of ["HUMAN", "SUPERVISOR"] as const) {
      expect(() => supervisor.transition({
        runId: run.runId,
        expectedStateVersion: run.stateVersion,
        nextState: "REVIEW_APPROVED",
        reasonCode: "REVIEW_APPROVED",
        actorType,
        actorId: `${actorType.toLowerCase()}-actor`,
        manifestHash: run.manifestHash,
        idempotencyKey: `run-1:review-no-proof:${actorType}`,
      })).toThrow("verified-candidate promotion");
    }
    expect(() => supervisor.transition({
      runId: run.runId,
      expectedStateVersion: run.stateVersion,
      nextState: "REVIEW_APPROVED",
      reasonCode: "REVIEW_APPROVED",
      evidenceIds: ["review-decision-1"],
      actorType: "SUPERVISOR",
      manifestHash: run.manifestHash,
      facts: { reviewerDecisionValid: true, freshReviewerSession: true },
      idempotencyKey: "run-1:review-approved",
    })).toThrow("verified-candidate promotion");
    expect(supervisor.getRun(run.runId)).toMatchObject({ state: "REVIEWING", stateVersion: run.stateVersion });
    expect(supervisor.listEvents(run.runId).filter((event) => event.nextState === "REVIEW_APPROVED")).toHaveLength(0);
    supervisor.close();
  });

  test("requires explicit human authority and failure evidence for Reviewer recovery", () => {
    const supervisor = createSupervisor();
    receiveAndPlan(supervisor);
    let run = freeze(supervisor).run;
    for (const nextState of [
      "SANDBOX_COLD_PROVISIONING", "SANDBOX_PREFLIGHT", "SANDBOX_READY", "IMPLEMENTING",
      "FAST_CHECKS", "UNIT_TESTING", "INTEGRATION_TESTING", "SECURITY_REVIEW", "REVIEWING",
      "HUMAN_REVIEW_REQUIRED",
    ] as const) {
      run = supervisor.transition({
        runId: run.runId, expectedStateVersion: run.stateVersion, nextState,
        reasonCode: `ENTER_${nextState}`, manifestHash: run.manifestHash,
        idempotencyKey: `reviewer-recovery:${nextState}`,
      }).run;
    }
    expect(() => supervisor.transition({
      runId: run.runId, expectedStateVersion: run.stateVersion, nextState: "VERIFICATION_RECOVERY",
      reasonCode: "HUMAN_RETRY_FAILED_REVIEWER", actorType: "HUMAN", actorId: "reviewer-user",
      evidenceIds: ["reviewer-failure"], manifestHash: run.manifestHash,
      idempotencyKey: "reviewer-recovery:no-fact",
    })).toThrow("reviewerRetryAuthorized");
    run = supervisor.transition({
      runId: run.runId, expectedStateVersion: run.stateVersion, nextState: "VERIFICATION_RECOVERY",
      reasonCode: "HUMAN_RETRY_FAILED_REVIEWER", actorType: "HUMAN", actorId: "reviewer-user",
      evidenceIds: ["reviewer-failure"], manifestHash: run.manifestHash,
      facts: { reviewerRetryAuthorized: true }, idempotencyKey: "reviewer-recovery:authorized",
    }).run;
    expect(run.state).toBe("VERIFICATION_RECOVERY");
    supervisor.close();
  });

  test("terminal states reject all further execution", () => {
    const supervisor = createSupervisor();
    let run = supervisor.receiveRequest({
      runId: "run-terminal",
      userId: "user-1",
      repository,
      request: "Cancel this run",
    });
    run = supervisor.transition({
      runId: run.runId,
      expectedStateVersion: run.stateVersion,
      nextState: "CANCELLATION_PENDING",
      reasonCode: "USER_CANCELLED",
      actorType: "USER",
      actorId: "user-1",
      idempotencyKey: "cancel-pending",
    }).run;
    run = supervisor.transition({
      runId: run.runId,
      expectedStateVersion: run.stateVersion,
      nextState: "CANCELLED",
      reasonCode: "CANCELLATION_COMPLETE",
      idempotencyKey: "cancelled",
    }).run;
    expect(run.terminalAt).not.toBeNull();
    expect(() => supervisor.transition({
      runId: run.runId,
      expectedStateVersion: run.stateVersion,
      nextState: "PLANNING",
      reasonCode: "RESURRECT",
      idempotencyKey: "resurrect",
    })).toThrow("terminal state");
    supervisor.close();
  });

  test("durable Git operations reject new unbound publication claims at the v22 storage boundary", () => {
    const supervisor = createSupervisor();
    supervisor.receiveRequest({ runId: "run-git-fence", userId: "user-1", repository, request: "Publish safely" });
    const started = {
      gitOperationId: "git-op-1", runId: "run-git-fence", operationType: "CREATE_BRANCH" as const,
      requestedBy: "SUPERVISOR" as const, idempotencyKey: "git:branch:run-git-fence",
      expectedBaseCommitSha: repository.baseCommitSha, resultCommitSha: "b".repeat(40),
      approvalId: null, evidenceBundleHash: `sha256:${"c".repeat(64)}`,
      status: "STARTED" as const, remoteReference: null,
      startedAt: "2026-07-15T12:00:00.000Z", completedAt: null, errorCode: null,
    };
    expect(() => supervisor.recordGitOperation(started as never)).toThrow();
    expect(supervisor.findGitOperation("run-git-fence", started.idempotencyKey)).toBeNull();
    supervisor.close();
  });

  test("agent and executor actor labels cannot directly mutate state at runtime", () => {
    const supervisor = createSupervisor();
    const run = supervisor.receiveRequest({
      runId: "run-agent-boundary",
      userId: "user-1",
      repository,
      request: "Prove agents cannot promote themselves",
    });
    for (const actorType of ["AGENT", "EXECUTOR"] as const) {
      expect(() => supervisor.transition({
        runId: run.runId,
        expectedStateVersion: run.stateVersion,
        nextState: "CANCELLATION_PENDING",
        reasonCode: "UNAUTHORIZED_PROMOTION",
        // Exercise the runtime boundary in addition to the compile-time exclusion.
        actorType: actorType as never,
        actorId: "untrusted-actor",
        idempotencyKey: `unauthorized:${actorType}`,
      })).toThrow("cannot directly mutate authoritative workflow state");
    }
    expect(supervisor.getRun(run.runId).stateVersion).toBe(0);
    supervisor.close();
  });

  test("risk reassessment is monotonic after manifest freeze", () => {
    const supervisor = createSupervisor();
    receiveAndPlan(supervisor, "run-risk-floor");
    const frozen = freeze(supervisor, "run-risk-floor").run;
    const assessment = supervisor.assessRunRisk(
      frozen.runId,
      frozen.stateVersion,
      {
        documentationOnly: true,
        sensitiveFilesChanged: false,
        touchesAuthentication: false,
        touchesAuthorization: false,
        touchesPayments: false,
        changesDatabaseSchema: false,
        destructiveProductionOperation: false,
        privilegeEscalation: false,
        changesInfrastructure: false,
        accessesSecrets: false,
        exposesSecrets: false,
        changesDependencies: false,
        changesPublicApi: false,
        requiredChecksPassed: true,
        testCoveragePercent: null,
        unresolvedWarnings: 0,
        highestSecuritySeverity: "NONE",
        retryCount: 0,
        dependsOnExternalService: false,
        diffLines: 0,
        generatedCodePercent: 0,
        reviewerDisagreement: false,
        suspectedRunnerCompromise: false,
      },
      { autoApproveLowRisk: true },
    );
    expect(assessment.riskTier).toBe("MEDIUM");
    expect(assessment.humanGateRequired).toBe(true);
    expect(assessment.matchedRules).toContain("PRIOR_RISK_TIER_FLOOR");
    expect(supervisor.getRun(frozen.runId).riskTier).toBe("MEDIUM");
    supervisor.close();
  });

  test("atomically reserves worst-case model spend and reconciles it to actual usage", () => {
    const supervisor = createSupervisor();
    const run = supervisor.receiveRequest({
      runId: "run-model-budget",
      userId: "user-1",
      repository,
      request: "Plan within the runtime budget",
    });
    supervisor.recordAgentExecution({
      agentExecutionId: "planner-budget-agent",
      runId: run.runId,
      role: "PLANNER",
      modelTier: "GPT-5.6_TERRA",
      status: "RUNNING",
      inputHash: sha256("planner-input"),
      outputArtifactId: null,
      startedAt: "2026-07-14T12:00:02.000Z",
      completedAt: null,
    });
    supervisor.recordModelRouting({
      routingDecisionId: "planner-budget-route",
      runId: run.runId,
      agentExecutionId: "planner-budget-agent",
      agentRole: "PLANNER",
      logicalTier: "GPT-5.6_TERRA",
      resolvedModel: "gpt-5.6-terra",
      routingPolicyVersion: "test-routing-v1",
      fallbackUsed: false,
      fallbackReason: null,
      cacheKey: null,
      timestamp: "2026-07-14T12:00:02.000Z",
    });

    expect(() => supervisor.reserveModelBudget({
      runId: run.runId,
      reservationId: "wrong-model-reservation",
      agentExecutionId: "planner-budget-agent",
      model: "gpt-5.6-luna",
      inputTokenUpperBound: 10,
      maxOutputTokens: 10,
    })).toThrow("recorded route");
    expect(() => supervisor.recordModelCall({
      modelCallId: "wrong-tier-call", runId: run.runId, agentExecutionId: "planner-budget-agent",
      logicalTier: "GPT-5.6_LUNA", resolvedModel: "gpt-5.6-luna",
      promptTemplateVersion: "test-v1", inputContextRefs: [sha256("planner-input")],
      outputSchemaVersion: "test-v1", cacheKey: sha256("wrong-cache"), cacheHit: null,
      latencyMs: 1, inputTokens: 1, outputTokens: 1, retryCount: 0, status: "SUCCEEDED",
      createdAt: "2026-07-14T12:00:02.000Z",
    })).toThrow("pre-admitted budget reservation");

    expect(() => supervisor.reserveModelBudget({
      runId: run.runId,
      reservationId: "oversized-reservation",
      agentExecutionId: "planner-budget-agent",
      model: "gpt-5.6-terra",
      inputTokenUpperBound: 200_000,
      maxOutputTokens: 1,
    })).toThrow("paused safely");
    const paused = supervisor.getRun(run.runId);
    const pausedBudget = supervisor.getBudget(run.runId);
    expect(paused.state).toBe("PAUSED_BUDGET");
    const topped = supervisor.topUpBudget({
      runId: run.runId, expectedRevision: pausedBudget.revision,
      topUp: { addCostBudgetUsd: 0, addTokenBudget: 1_000, addTimeBudgetSeconds: 0 },
      actorId: "user-1", idempotencyKey: "supervisor-budget-top-up",
    });
    supervisor.resumeBudget({
      runId: run.runId, expectedStateVersion: paused.stateVersion, expectedBudgetRevision: topped.revision,
      actorId: "user-1", idempotencyKey: "supervisor-budget-resume",
    });
    expect(supervisor.exportRunRecords(run.runId).cost_records).toEqual([]);

    const reservationId = supervisor.reserveModelBudget({
      runId: run.runId,
      reservationId: "planner-reservation",
      agentExecutionId: "planner-budget-agent",
      model: "gpt-5.6-terra",
      inputTokenUpperBound: 1_000,
      maxOutputTokens: 500,
    });
    expect(supervisor.exportRunRecords(run.runId).cost_records).toMatchObject([{
      source_type: "MODEL_RESERVATION",
      source_id: reservationId,
      input_tokens: 1_000,
      output_tokens: 500,
    }]);

    supervisor.recordModelCall({
      modelCallId: "planner-budget-call",
      runId: run.runId,
      agentExecutionId: "planner-budget-agent",
      logicalTier: "GPT-5.6_TERRA",
      resolvedModel: "gpt-5.6-terra",
      promptTemplateVersion: "test-v1",
      inputContextRefs: [sha256("planner-input")],
      outputSchemaVersion: "test-v1",
      cacheKey: sha256("planner-cache"),
      cacheHit: false,
      latencyMs: 10,
      inputTokens: 100,
      outputTokens: 50,
      cachedInputTokens: 40,
      cacheWriteInputTokens: 10,
      retryCount: 0,
      status: "SUCCEEDED",
      createdAt: "2026-07-14T12:00:03.000Z",
    }, reservationId);
    expect(supervisor.exportRunRecords(run.runId).cost_records).toMatchObject([{
      source_type: "MODEL_CALL",
      source_id: "planner-budget-call",
      input_tokens: 100,
      output_tokens: 50,
      cached_input_tokens: 40,
      cache_write_input_tokens: 10,
    }]);
    expect(supervisor.assertRuntimeBudget(run.runId)).toMatchObject({ status: "WITHIN_BUDGET", totalTokens: 150 });

    const staleRouteReservation = supervisor.reserveModelBudget({
      runId: run.runId,
      reservationId: "stale-route-reservation",
      agentExecutionId: "planner-budget-agent",
      model: "gpt-5.6-terra",
      inputTokenUpperBound: 100,
      maxOutputTokens: 50,
    });
    supervisor.recordModelRouting({
      routingDecisionId: "planner-budget-route-2",
      runId: run.runId,
      agentExecutionId: "planner-budget-agent",
      agentRole: "PLANNER",
      logicalTier: "GPT-5.6_TERRA",
      resolvedModel: "gpt-5.6-terra",
      routingPolicyVersion: "test-routing-v2",
      fallbackUsed: false,
      fallbackReason: null,
      cacheKey: null,
      timestamp: "2026-07-14T12:00:04.000Z",
    });
    expect(() => supervisor.recordModelCall({
      modelCallId: "stale-route-call", runId: run.runId, agentExecutionId: "planner-budget-agent",
      logicalTier: "GPT-5.6_TERRA", resolvedModel: "gpt-5.6-terra",
      promptTemplateVersion: "test-v1", inputContextRefs: [sha256("planner-input")],
      outputSchemaVersion: "test-v1", cacheKey: sha256("planner-cache"), cacheHit: false,
      latencyMs: 1, inputTokens: 10, outputTokens: 5, retryCount: 0, status: "SUCCEEDED",
      createdAt: "2026-07-14T12:00:05.000Z",
    }, staleRouteReservation)).toThrow("route changed");
    supervisor.close();
  });

  test("enforces one durable Builder call ceiling across agent executions and reservations", () => {
    let id = 0;
    const supervisor = createEngineerSupervisor({
      dbPath: ":memory:",
      idFactory: () => `builder-limit-${++id}`,
      now: () => new Date("2026-07-14T12:00:00.000Z"),
      builderModelCallLimit: 2,
    });
    const run = supervisor.receiveRequest({
      runId: "run-builder-limit", userId: "user-1", repository, request: "Bound Builder calls",
    });
    supervisor.recordAgentExecution({
      agentExecutionId: "builder-limit-agent", runId: run.runId, role: "BUILDER", modelTier: "GPT-5.6_TERRA",
      status: "RUNNING", inputHash: sha256("builder-limit-input"), outputArtifactId: null,
      startedAt: "2026-07-14T12:00:00.000Z", completedAt: null,
    });
    supervisor.recordModelRouting({
      routingDecisionId: "builder-limit-route", runId: run.runId, agentExecutionId: "builder-limit-agent",
      agentRole: "BUILDER", logicalTier: "GPT-5.6_TERRA", resolvedModel: "gpt-5.6-terra",
      routingPolicyVersion: "test-routing-v2", fallbackUsed: false, fallbackReason: null, cacheKey: null,
      timestamp: "2026-07-14T12:00:00.000Z",
    });
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const reservationId = supervisor.reserveModelBudget({
        runId: run.runId, reservationId: `builder-limit-reservation-${attempt}`,
        agentExecutionId: "builder-limit-agent", model: "gpt-5.6-terra",
        inputTokenUpperBound: 10, maxOutputTokens: 10,
      });
      supervisor.recordModelCall({
        modelCallId: `builder-limit-call-${attempt}`, runId: run.runId, agentExecutionId: "builder-limit-agent",
        logicalTier: "GPT-5.6_TERRA", resolvedModel: "gpt-5.6-terra", promptTemplateVersion: "test-v1",
        inputContextRefs: [sha256(`builder-limit-${attempt}`)], outputSchemaVersion: null,
        cacheKey: sha256("builder-limit-cache"), cacheHit: null, latencyMs: 1, inputTokens: 1, outputTokens: 1,
        retryCount: 0, status: "SUCCEEDED", createdAt: "2026-07-14T12:00:00.000Z",
      }, reservationId);
    }
    expect(supervisor.modelCallCountForRole(run.runId, "BUILDER")).toBe(2);
    expect(() => supervisor.reserveModelBudget({
      runId: run.runId, reservationId: "builder-limit-reservation-3",
      agentExecutionId: "builder-limit-agent", model: "gpt-5.6-terra",
      inputTokenUpperBound: 10, maxOutputTokens: 10,
    })).toThrow("durable Builder model-call limit of 2");
    expect(supervisor.exportRunRecords(run.runId).cost_records).toHaveLength(2);
    supervisor.close();
  });

  test("permits failed-agent finalization after the runtime budget has expired", () => {
    let clock = new Date("2026-07-14T12:00:00.000Z");
    const supervisor = createEngineerSupervisor({ dbPath: ":memory:", now: () => clock });
    const run = supervisor.receiveRequest({
      runId: "run-expired-agent", userId: "user-1", repository, request: "Run bounded work",
    });
    const startedAt = clock.toISOString();
    supervisor.recordAgentExecution({
      agentExecutionId: "expired-agent", runId: run.runId, role: "PLANNER", modelTier: "GPT-5.6_TERRA",
      status: "RUNNING", inputHash: sha256("expired-agent-input"), outputArtifactId: null,
      startedAt, completedAt: null,
    });
    clock = new Date("2026-07-14T14:00:00.000Z");
    expect(() => supervisor.recordAgentExecution({
      agentExecutionId: "expired-agent", runId: run.runId, role: "PLANNER", modelTier: "GPT-5.6_TERRA",
      status: "FAILED", inputHash: sha256("expired-agent-input"), outputArtifactId: null,
      startedAt, completedAt: clock.toISOString(),
    })).not.toThrow();
    expect(supervisor.exportRunRecords(run.runId).agent_executions).toMatchObject([{ status: "FAILED" }]);
    supervisor.close();
  });

  test("finalizes orphaned RUNNING agents once before restart recovery", () => {
    const supervisor = createEngineerSupervisor({ dbPath: ":memory:" });
    const run = supervisor.receiveRequest({
      runId: "run-orphan-agent", userId: "user-1", repository, request: "Recover an interrupted agent",
    });
    supervisor.recordAgentExecution({
      agentExecutionId: "orphan-planner", runId: run.runId, role: "PLANNER", modelTier: "GPT-5.6_TERRA",
      status: "RUNNING", inputHash: sha256("orphan-input"), outputArtifactId: null,
      startedAt: "2026-07-14T12:00:00.000Z", completedAt: null,
    });

    expect(supervisor.finalizeRunningAgentExecutions(
      run.runId, "FAILED", "PROCESS_RESTART", "2026-07-14T12:01:00.000Z",
    )).toBe(1);
    expect(supervisor.finalizeRunningAgentExecutions(
      run.runId, "FAILED", "PROCESS_RESTART", "2026-07-14T12:02:00.000Z",
    )).toBe(0);
    expect(supervisor.exportRunRecords(run.runId).agent_executions).toMatchObject([{
      id: "orphan-planner",
      status: "FAILED",
      completed_at: "2026-07-14T12:01:00.000Z",
    }]);
    supervisor.close();
  });
});
