import { describe, expect, test } from "bun:test";
import {
  DecisionRecordContentSchema,
  DecisionRecordSchema,
  type DecisionEvidenceReference,
  type DecisionFactors,
  type DecisionOption,
} from "./decision-contracts.js";
import { DECISION_POLICY_VERSION, classifyDecisionFactors } from "./decision-policy.js";
import { IdempotencyConflictError } from "./errors.js";
import { sha256 } from "./hash.js";
import { EngineerSupervisor } from "./supervisor.js";

const repository = {
  repositoryId: "repo-1",
  provider: "local" as const,
  owner: "local",
  name: "fixture",
  baseBranch: "main",
  baseCommitSha: "a".repeat(40),
};

const baseFactors = (overrides: Partial<DecisionFactors> = {}): DecisionFactors => ({
  affectsMustCriterion: false,
  changesScope: false,
  affectsAuthentication: false,
  affectsAuthorization: false,
  handlesSecrets: false,
  requiresMigration: false,
  changesPublicApi: false,
  destructiveAction: false,
  externalSideEffect: false,
  changesBudget: false,
  noSafeDefault: false,
  safeDocumentedDefault: false,
  reversible: true,
  withinFrozenScope: true,
  raisesRisk: false,
  riskFloorRequiresHuman: false,
  ...overrides,
});

const evidence = (runId: string, evidenceId = "request-1", sourceType: DecisionEvidenceReference["sourceType"] = "USER_REQUEST"): DecisionEvidenceReference => ({
  evidenceId,
  runId,
  sourceType,
  trust: sourceType === "HUMAN_RESPONSE" ? "TRUSTED_HUMAN" : "TRUSTED_SYSTEM",
  summary: "Bounded source evidence for this decision.",
});

const options = (evidenceId = "request-1"): DecisionOption[] => [
  {
    optionId: "safe",
    label: "Use the bounded default",
    impact: "Keeps the change inside the documented scope.",
    reversibility: "REVERSIBLE",
    riskTier: "LOW",
    sourceEvidenceIds: [evidenceId],
    recommended: true,
  },
  {
    optionId: "custom",
    label: "Choose a custom behavior",
    impact: "Requires explicit user direction before work continues.",
    reversibility: "PARTIALLY_REVERSIBLE",
    riskTier: "MEDIUM",
    sourceEvidenceIds: [evidenceId],
    recommended: false,
  },
];

function normalizedRun(supervisor: EngineerSupervisor, runId: string, initialRiskFeatures = {}) {
  let run = supervisor.receiveRequest({
    runId,
    userId: "user-1",
    repository: { ...repository, repositoryId: `${runId}-repo`, name: `${runId}-fixture` },
    request: "Implement the bounded change",
    initialRiskFeatures,
  });
  run = supervisor.normalizeRequest({
    runId,
    expectedStateVersion: run.stateVersion,
    normalizedRequest: "Implement the bounded change.",
    idempotencyKey: `${runId}:normalize`,
  }).run;
  return run;
}

describe("deterministic decision policy", () => {
  test("every security, scope, external, budget, and no-default floor forces ASK_NOW", () => {
    const floors: Array<keyof DecisionFactors> = [
      "affectsMustCriterion", "changesScope", "affectsAuthentication", "affectsAuthorization",
      "handlesSecrets", "requiresMigration", "changesPublicApi", "destructiveAction",
      "externalSideEffect", "changesBudget", "noSafeDefault", "riskFloorRequiresHuman", "raisesRisk",
    ];
    for (const floor of floors) {
      const decision = classifyDecisionFactors(baseFactors({ [floor]: true, safeDocumentedDefault: floor === "noSafeDefault" ? false : true }));
      expect(decision.classification).toBe("ASK_NOW");
    }
  });

  test("AUTO is possible only for a reversible within-scope documented default", () => {
    const keys: Array<keyof Pick<DecisionFactors, "safeDocumentedDefault" | "reversible" | "withinFrozenScope" | "raisesRisk" | "externalSideEffect" | "affectsMustCriterion" | "changesScope">> =
      ["safeDocumentedDefault", "reversible", "withinFrozenScope", "raisesRisk", "externalSideEffect", "affectsMustCriterion", "changesScope"];
    for (let mask = 0; mask < 2 ** keys.length; mask += 1) {
      const values = Object.fromEntries(keys.map((key, index) => [key, Boolean(mask & (1 << index))])) as Partial<DecisionFactors>;
      const factors = baseFactors(values);
      const result = classifyDecisionFactors(factors);
      if (result.classification === "AUTO") {
        expect(factors.safeDocumentedDefault && factors.reversible && factors.withinFrozenScope).toBe(true);
        expect(factors.raisesRisk || factors.externalSideEffect || factors.affectsMustCriterion || factors.changesScope).toBe(false);
      }
    }
  });

  test("runtime contracts reject policy override, bad option cardinality, cross-run evidence, and hash tampering", () => {
    const factors = baseFactors({ affectsAuthentication: true });
    const policy = classifyDecisionFactors(factors);
    const content = {
      decisionId: "decision-1",
      runId: "run-1",
      question: "Which authentication behavior is authorized?",
      classification: policy.classification,
      reasonCodes: policy.reasonCodes,
      factors,
      options: options(),
      recommendedOptionId: "safe",
      sourceEvidence: [evidence("run-1")],
      policyVersion: DECISION_POLICY_VERSION,
      requestedState: "REQUEST_NORMALIZED",
      resumeAction: "PLAN" as const,
      status: "OPEN" as const,
      idempotencyKey: "decision:create",
      createdAt: "2026-07-14T20:00:00.000Z",
    };
    const parsed = DecisionRecordContentSchema.parse(content);
    const record = DecisionRecordSchema.parse({ ...parsed, decisionHash: sha256(parsed) });
    expect(() => DecisionRecordSchema.parse({ ...record, classification: "AUTO" })).toThrow("deterministic policy");
    expect(() => DecisionRecordSchema.parse({ ...record, decisionHash: `sha256:${"0".repeat(64)}` })).toThrow("hash mismatch");
    expect(() => DecisionRecordContentSchema.parse({ ...content, options: options().slice(0, 1) })).toThrow();
    expect(() => DecisionRecordContentSchema.parse({ ...content, sourceEvidence: [evidence("other-run")] })).toThrow("cross-run");
  });
});

describe("decision ledger and clarification lifecycle", () => {
  test("unanswered decisions cannot prevent cancellation cleanup or cleanup failure", () => {
    for (const terminalState of ["CANCELLED", "FAILED"] as const) {
      const supervisor = new EngineerSupervisor({ dbPath: ":memory:" });
      const run = normalizedRun(supervisor, `cancel-open-${terminalState.toLowerCase()}`);
      supervisor.createDecision({
        runId: run.runId,
        expectedStateVersion: run.stateVersion,
        question: "Which behavior should be used if execution continues?",
        factors: baseFactors({ noSafeDefault: true }),
        options: options(),
        recommendedOptionId: "safe",
        sourceEvidence: [evidence(run.runId)],
        idempotencyKey: `${run.runId}:decision`,
      });
      let current = supervisor.getRun(run.runId);
      expect(current.state).toBe("CLARIFICATION_REQUIRED");
      expect(supervisor.listOpenDecisions(run.runId)).toHaveLength(1);
      current = supervisor.transition({
        runId: current.runId,
        expectedStateVersion: current.stateVersion,
        nextState: "CANCELLATION_PENDING",
        reasonCode: "USER_CANCELLATION_REQUESTED",
        actorType: "HUMAN",
        actorId: "user-1",
        idempotencyKey: `${run.runId}:cancel-pending`,
      }).run;
      current = supervisor.transition({
        runId: current.runId,
        expectedStateVersion: current.stateVersion,
        nextState: terminalState,
        reasonCode: terminalState === "CANCELLED" ? "RUN_CLEANUP_COMPLETE" : "RUN_CLEANUP_FAILED",
        idempotencyKey: `${run.runId}:cancel-terminal`,
      }).run;
      expect(current.state).toBe(terminalState);
      expect(current.terminalAt).not.toBeNull();
      supervisor.close();
    }
  });

  test("ASK_NOW pauses, persists the human resolution, then starts a fresh plan", () => {
    const supervisor = new EngineerSupervisor({ dbPath: ":memory:", now: () => new Date("2026-07-14T20:00:00.000Z") });
    const run = normalizedRun(supervisor, "ask-run");
    const decision = supervisor.createDecision({
      runId: run.runId,
      expectedStateVersion: run.stateVersion,
      question: "Which authorization boundary should apply?",
      factors: baseFactors({ affectsAuthorization: true }),
      options: options(),
      recommendedOptionId: "safe",
      sourceEvidence: [evidence(run.runId)],
      idempotencyKey: "ask:create",
    });
    expect(decision.classification).toBe("ASK_NOW");
    expect(supervisor.getRun(run.runId).state).toBe("CLARIFICATION_REQUIRED");
    expect(supervisor.listOpenDecisions(run.runId)).toHaveLength(1);

    const paused = supervisor.getRun(run.runId);
    const resolution = supervisor.resolveDecision({
      runId: run.runId,
      decisionId: decision.decisionId,
      expectedStateVersion: paused.stateVersion,
      selectedOptionId: "safe",
      actorId: "user-1",
      rationale: "Keep the existing authorization boundary.",
      sourceEvidence: [evidence(run.runId, "human-1", "HUMAN_RESPONSE")],
      idempotencyKey: "ask:resolve",
    });
    expect(resolution.actorType).toBe("HUMAN");
    expect(supervisor.getRun(run.runId).state).toBe("PLANNING");
    expect(supervisor.listOpenDecisions(run.runId)).toHaveLength(0);
    expect(supervisor.listEvents(run.runId).map((event) => event.reasonCode)).toContain("DECISION_RESOLVED_PLAN");
    supervisor.close();
  });

  test("batches ASK_NOW decisions and resumes only after the final human answer", () => {
    const supervisor = new EngineerSupervisor({ dbPath: ":memory:", now: () => new Date("2026-07-14T20:00:00.000Z") });
    const run = normalizedRun(supervisor, "ask-batch-run");
    const first = supervisor.createDecision({
      runId: run.runId, expectedStateVersion: run.stateVersion,
      question: "Which authorization boundary should apply?", factors: baseFactors({ affectsAuthorization: true }),
      options: options(), recommendedOptionId: "safe", sourceEvidence: [evidence(run.runId)], idempotencyKey: "ask-batch:first",
    });
    const paused = supervisor.getRun(run.runId);
    const second = supervisor.createDecision({
      runId: run.runId, expectedStateVersion: paused.stateVersion,
      question: "Should failures deny access?", factors: baseFactors({ affectsAuthorization: true }),
      options: options(), recommendedOptionId: "safe", sourceEvidence: [evidence(run.runId)], idempotencyKey: "ask-batch:second",
    });
    expect(supervisor.listOpenDecisions(run.runId)).toHaveLength(2);
    supervisor.resolveDecision({
      runId: run.runId, decisionId: first.decisionId, expectedStateVersion: paused.stateVersion,
      selectedOptionId: "safe", actorId: "user-1", rationale: "Use the existing boundary.",
      sourceEvidence: [evidence(run.runId, "human-batch-1", "HUMAN_RESPONSE")], idempotencyKey: "ask-batch:resolve-first",
    });
    expect(supervisor.getRun(run.runId).state).toBe("CLARIFICATION_REQUIRED");
    supervisor.resolveDecision({
      runId: run.runId, decisionId: second.decisionId, expectedStateVersion: paused.stateVersion,
      selectedOptionId: "safe", actorId: "user-1", rationale: "Fail closed.",
      sourceEvidence: [evidence(run.runId, "human-batch-2", "HUMAN_RESPONSE")], idempotencyKey: "ask-batch:resolve-second",
    });
    expect(supervisor.getRun(run.runId).state).toBe("PLANNING");
    expect(supervisor.listOpenDecisions(run.runId)).toHaveLength(0);
    supervisor.close();
  });

  test("AUTO resolves only the recommended safe option; DEFER remains a human task without pausing", () => {
    const supervisor = new EngineerSupervisor({ dbPath: ":memory:" });
    const autoRun = normalizedRun(supervisor, "auto-run", { documentationOnly: true });
    const automatic = supervisor.createDecision({
      runId: autoRun.runId,
      expectedStateVersion: autoRun.stateVersion,
      question: "Use the documented formatter default?",
      factors: baseFactors({ safeDocumentedDefault: true }),
      options: options("decision-policy-v1"),
      recommendedOptionId: "safe",
      sourceEvidence: [evidence(autoRun.runId, "decision-policy-v1", "POLICY")],
      idempotencyKey: "auto:create",
    });
    expect(automatic.classification).toBe("AUTO");
    expect(supervisor.getDecisionResolution(autoRun.runId, automatic.decisionId)?.selectedOptionId).toBe("safe");
    expect(supervisor.getRun(autoRun.runId).state).toBe("REQUEST_NORMALIZED");

    const deferRun = normalizedRun(supervisor, "defer-run", { documentationOnly: true });
    const deferred = supervisor.createDecision({
      runId: deferRun.runId,
      expectedStateVersion: deferRun.stateVersion,
      question: "Which optional comment style is preferred?",
      factors: baseFactors({ reversible: false }),
      options: options(),
      recommendedOptionId: "safe",
      sourceEvidence: [evidence(deferRun.runId)],
      idempotencyKey: "defer:create",
    });
    expect(deferred.classification).toBe("DEFER");
    expect(supervisor.getRun(deferRun.runId).state).toBe("REQUEST_NORMALIZED");
    expect(supervisor.listOpenDecisions(deferRun.runId)).toHaveLength(1);
    supervisor.close();
  });

  test("risk floor blocks AUTO and conflicting or non-idempotent resolution replays fail", () => {
    const supervisor = new EngineerSupervisor({ dbPath: ":memory:" });
    const highRun = normalizedRun(supervisor, "risk-run", { touchesAuthentication: true });
    const decision = supervisor.createDecision({
      runId: highRun.runId,
      expectedStateVersion: highRun.stateVersion,
      question: "Use the apparent default despite the run risk?",
      factors: baseFactors({ safeDocumentedDefault: true }),
      options: options(),
      recommendedOptionId: "safe",
      sourceEvidence: [evidence(highRun.runId)],
      idempotencyKey: "risk:create",
    });
    expect(decision.classification).toBe("ASK_NOW");
    expect(decision.reasonCodes).toContain("RISK_FLOOR");
    const paused = supervisor.getRun(highRun.runId);
    supervisor.resolveDecision({
      runId: highRun.runId,
      decisionId: decision.decisionId,
      expectedStateVersion: paused.stateVersion,
      selectedOptionId: "safe",
      actorId: "user-1",
      rationale: "Explicitly accept the bounded option.",
      sourceEvidence: [evidence(highRun.runId, "human-risk", "HUMAN_RESPONSE")],
      idempotencyKey: "risk:resolve",
    });
    const current = supervisor.getRun(highRun.runId);
    expect(() => supervisor.resolveDecision({
      runId: highRun.runId,
      decisionId: decision.decisionId,
      expectedStateVersion: current.stateVersion,
      selectedOptionId: "custom",
      actorId: "user-1",
      rationale: "Conflicting choice.",
      sourceEvidence: [evidence(highRun.runId, "human-risk", "HUMAN_RESPONSE")],
      idempotencyKey: "risk:resolve",
    })).toThrow(IdempotencyConflictError);
    expect(() => supervisor.resolveDecision({
      runId: highRun.runId,
      decisionId: decision.decisionId,
      expectedStateVersion: current.stateVersion,
      selectedOptionId: "safe",
      actorId: "user-1",
      rationale: "Explicitly accept the bounded option.",
      sourceEvidence: [evidence(highRun.runId, "human-risk", "HUMAN_RESPONSE")],
      idempotencyKey: "risk:resolve:new-key",
    })).toThrow(IdempotencyConflictError);
    supervisor.close();
  });
});
