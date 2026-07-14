import { describe, expect, test } from "bun:test";
import {
  IdempotencyConflictError,
  InvalidTransitionError,
  ManifestIntegrityError,
  StateVersionConflictError,
} from "./errors.js";
import { createEngineerSupervisor, type EngineerSupervisor } from "./supervisor.js";
import type { RepositoryReference, TaskManifestContent } from "./contracts.js";
import { RiskFeaturesSchema } from "./contracts.js";
import { sha256 } from "./hash.js";
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
    if (fetched) fetched.acceptanceCriteria[0]!.statement = "tampered in caller memory";
    expect(supervisor.getManifest("run-1")?.acceptanceCriteria[0]?.statement).toBe(
      "Every state promotion is recorded.",
    );
    supervisor.close();
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

  test("enforces Reviewer evidence, human gate, and supervisor-owned PR preflight", () => {
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
    expect(() => supervisor.transition({
      runId: run.runId,
      expectedStateVersion: run.stateVersion,
      nextState: "REVIEW_APPROVED",
      reasonCode: "REVIEW_APPROVED",
      manifestHash: run.manifestHash,
      idempotencyKey: "run-1:review-no-proof",
    })).toThrow(InvalidTransitionError);
    run = supervisor.transition({
      runId: run.runId,
      expectedStateVersion: run.stateVersion,
      nextState: "REVIEW_APPROVED",
      reasonCode: "REVIEW_APPROVED",
      evidenceIds: ["review-decision-1"],
      manifestHash: run.manifestHash,
      facts: { reviewerDecisionValid: true, freshReviewerSession: true },
      idempotencyKey: "run-1:review-approved",
    }).run;
    expect(() => supervisor.transition({
      runId: run.runId,
      expectedStateVersion: run.stateVersion,
      nextState: "PR_PREFLIGHT",
      reasonCode: "BYPASS_HUMAN",
      evidenceIds: ["bundle-1"],
      manifestHash: run.manifestHash,
      facts: {
        reviewerDecisionValid: true,
        allRequiredChecksPassed: true,
        noCriticalSecurityFindings: true,
        evidenceBundleComplete: true,
        baseBranchCurrent: true,
      },
      idempotencyKey: "run-1:bypass",
    })).toThrow("only policy-approved low-risk work");
    run = supervisor.transition({
      runId: run.runId,
      expectedStateVersion: run.stateVersion,
      nextState: "HUMAN_APPROVAL_PENDING",
      reasonCode: "HUMAN_GATE_REQUIRED",
      manifestHash: run.manifestHash,
      idempotencyKey: "run-1:human-pending",
    }).run;
    expect(() => supervisor.transition({
      runId: run.runId,
      expectedStateVersion: run.stateVersion,
      nextState: "HUMAN_APPROVED",
      reasonCode: "HUMAN_APPROVED",
      actorType: "SUPERVISOR",
      evidenceIds: ["approval-1"],
      manifestHash: run.manifestHash,
      facts: { humanApprovalValid: true },
      idempotencyKey: "run-1:fake-human",
    })).toThrow("human actor");
    run = supervisor.transition({
      runId: run.runId,
      expectedStateVersion: run.stateVersion,
      nextState: "HUMAN_APPROVED",
      reasonCode: "HUMAN_APPROVED",
      actorType: "HUMAN",
      actorId: "reviewer-user",
      evidenceIds: ["approval-1"],
      manifestHash: run.manifestHash,
      facts: { humanApprovalValid: true },
      idempotencyKey: "run-1:human-approved",
    }).run;
    run = supervisor.transition({
      runId: run.runId,
      expectedStateVersion: run.stateVersion,
      nextState: "PR_PREFLIGHT",
      reasonCode: "PR_PREFLIGHT_PASSED",
      evidenceIds: ["bundle-1", "approval-1", "review-decision-1"],
      manifestHash: run.manifestHash,
      facts: {
        reviewerDecisionValid: true,
        humanApprovalValid: true,
        allRequiredChecksPassed: true,
        noCriticalSecurityFindings: true,
        evidenceBundleComplete: true,
        baseBranchCurrent: true,
      },
      idempotencyKey: "run-1:pr-preflight",
    }).run;
    expect(run.state).toBe("PR_PREFLIGHT");
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
    })).toThrow("MODEL_TOKENS_BUDGET_EXHAUSTED");
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
      retryCount: 0,
      status: "SUCCEEDED",
      createdAt: "2026-07-14T12:00:03.000Z",
    }, reservationId);
    expect(supervisor.exportRunRecords(run.runId).cost_records).toMatchObject([{
      source_type: "MODEL_CALL",
      source_id: "planner-budget-call",
      input_tokens: 100,
      output_tokens: 50,
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
});
