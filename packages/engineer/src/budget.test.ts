import { describe, expect, test } from "bun:test";
import { EngineerSupervisor } from "./supervisor.js";

const repository = {
  repositoryId: "repo-budget",
  provider: "local" as const,
  owner: "local",
  name: "budget-fixture",
  baseBranch: "main",
  baseCommitSha: "a".repeat(40),
};

function supervisor() {
  let milliseconds = Date.parse("2026-07-15T12:00:00.000Z");
  return new EngineerSupervisor({
    dbPath: ":memory:",
    now: () => new Date(milliseconds++),
    idFactory: (() => { let id = 0; return () => `budget-id-${++id}`; })(),
  });
}

describe("durable Engineer budgets", () => {
  test("persists user-selected initial and lifetime limits", () => {
    const sup = supervisor();
    const run = sup.receiveRequest({
      runId: "run-selection", userId: "user-1", repository, request: "bounded task",
      budget: {
        costBudgetUsd: 2, tokenBudget: 50_000, timeBudgetSeconds: 900,
        lifetimeCostBudgetUsd: 8, lifetimeTokenBudget: 200_000, lifetimeTimeBudgetSeconds: 3_600,
      },
    });
    const budget = sup.getBudget(run.runId);
    expect(budget.limits).toEqual({ costUsd: 2, tokens: 50_000, timeSeconds: 900 });
    expect(budget.lifetimeLimits).toEqual({ costUsd: 8, tokens: 200_000, timeSeconds: 3_600 });
    expect(budget.status).toBe("ACTIVE");
  });

  test("pauses before an unaffordable call, top-ups within the lifetime cap, and resumes exactly", () => {
    const sup = supervisor();
    const run = sup.receiveRequest({
      runId: "run-pause", userId: "user-1", repository, request: "bounded task",
      budget: { tokenBudget: 0, lifetimeTokenBudget: 1_000 },
    });
    sup.reconcileBudget(run.runId);

    const paused = sup.getRun(run.runId);
    const pausedBudget = sup.getBudget(run.runId);
    expect(paused.state).toBe("PAUSED_BUDGET");
    expect(pausedBudget.pauseReason).toBe("TOKEN_LIMIT_REACHED");
    expect(pausedBudget.resumeState).toBe("REQUEST_RECEIVED");

    const topped = sup.topUpBudget({
      runId: run.runId, expectedRevision: pausedBudget.revision,
      topUp: { addTokenBudget: 200, addCostBudgetUsd: 0, addTimeBudgetSeconds: 0 },
      actorId: "user-1", idempotencyKey: "top-up-1",
    });
    expect(topped.limits.tokens).toBe(200);
    const resumed = sup.resumeBudget({
      runId: run.runId, expectedStateVersion: paused.stateVersion,
      expectedBudgetRevision: topped.revision, actorId: "user-1", idempotencyKey: "resume-1",
    });
    expect(resumed.run.state).toBe("REQUEST_RECEIVED");
    expect(sup.getBudget(run.runId).status).toBe("ACTIVE");
  });

  test("rejects ownership bypass and lifetime-cap escape", () => {
    const sup = supervisor();
    const run = sup.receiveRequest({
      runId: "run-cap", userId: "owner", repository, request: "bounded task",
      budget: { costBudgetUsd: 1, lifetimeCostBudgetUsd: 2 },
    });
    const budget = sup.getBudget(run.runId);
    expect(() => sup.topUpBudget({
      runId: run.runId, expectedRevision: budget.revision,
      topUp: { addCostBudgetUsd: 0.5, addTokenBudget: 0, addTimeBudgetSeconds: 0 },
      actorId: "attacker", idempotencyKey: "owner-bypass",
    })).toThrow("does not own");
    expect(() => sup.topUpBudget({
      runId: run.runId, expectedRevision: budget.revision,
      topUp: { addCostBudgetUsd: 2, addTokenBudget: 0, addTimeBudgetSeconds: 0 },
      actorId: "owner", idempotencyKey: "cap-bypass",
    })).toThrow("lifetime budget cap");
  });
});
