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
    expect(budget.ambiguous).toEqual({ costUsd: 0, tokens: 0 });
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

  test("replays one top-up operation but rejects payload changes under the same key", () => {
    const sup = supervisor();
    const run = sup.receiveRequest({
      runId: "run-idempotent-top-up", userId: "owner", repository, request: "bounded task",
      budget: { tokenBudget: 100, lifetimeTokenBudget: 1_000 },
    });
    const budget = sup.getBudget(run.runId);
    const first = sup.topUpBudget({
      runId: run.runId, expectedRevision: budget.revision,
      topUp: { addCostBudgetUsd: 0, addTokenBudget: 100, addTimeBudgetSeconds: 0 },
      actorId: "owner", idempotencyKey: "one-logical-click",
    });
    const replay = sup.topUpBudget({
      runId: run.runId, expectedRevision: budget.revision,
      topUp: { addCostBudgetUsd: 0, addTokenBudget: 100, addTimeBudgetSeconds: 0 },
      actorId: "owner", idempotencyKey: "one-logical-click",
    });
    expect(replay.limits.tokens).toBe(first.limits.tokens);
    expect(() => sup.topUpBudget({
      runId: run.runId, expectedRevision: first.revision,
      topUp: { addCostBudgetUsd: 0, addTokenBudget: 200, addTimeBudgetSeconds: 0 },
      actorId: "owner", idempotencyKey: "one-logical-click",
    })).toThrow("reused with different allowance values");
  });

  test("does not consume execution time while paused and resumes accumulation once", () => {
    let now = Date.parse("2026-07-15T12:00:00.000Z");
    const sup = new EngineerSupervisor({
      dbPath: ":memory:",
      now: () => new Date(now),
      idFactory: (() => { let id = 0; return () => `pause-clock-${++id}`; })(),
    });
    const run = sup.receiveRequest({
      runId: "run-paused-clock", userId: "owner", repository, request: "bounded task",
      budget: { tokenBudget: 0, lifetimeTokenBudget: 1_000, timeBudgetSeconds: 600, lifetimeTimeBudgetSeconds: 1_200 },
    });

    now += 30_000;
    sup.reconcileBudget(run.runId);
    const paused = sup.getRun(run.runId);
    const beforeWait = sup.getBudget(run.runId);
    expect(beforeWait.used.timeSeconds).toBe(30);

    now += 24 * 60 * 60_000;
    const afterWait = sup.getBudget(run.runId);
    expect(afterWait.used.timeSeconds).toBe(30);
    expect(afterWait.remaining.timeSeconds).toBe(570);

    const topped = sup.topUpBudget({
      runId: run.runId, expectedRevision: afterWait.revision,
      topUp: { addTokenBudget: 200, addCostBudgetUsd: 0, addTimeBudgetSeconds: 0 },
      actorId: "owner", idempotencyKey: "paused-clock-top-up",
    });
    sup.resumeBudget({
      runId: run.runId, expectedStateVersion: paused.stateVersion,
      expectedBudgetRevision: topped.revision, actorId: "owner", idempotencyKey: "paused-clock-resume",
    });

    now += 15_000;
    expect(sup.getBudget(run.runId).used.timeSeconds).toBe(45);
    expect(sup.getBudget(run.runId).used.timeSeconds).toBe(45);
    sup.close();
  });

  test("does not charge execution time while waiting for a human answer", () => {
    let now = Date.parse("2026-07-15T12:00:00.000Z");
    const sup = new EngineerSupervisor({ dbPath: ":memory:", now: () => new Date(now) });
    let run = sup.receiveRequest({
      runId: "run-human-clock", userId: "owner", repository, request: "ask before changing behavior",
      budget: { timeBudgetSeconds: 600, lifetimeTimeBudgetSeconds: 1_200 },
    });
    now += 30_000;
    run = sup.normalizeRequest({
      runId: run.runId, expectedStateVersion: run.stateVersion,
      normalizedRequest: "Ask before changing behavior.", idempotencyKey: "human-clock-normalize",
    }).run;
    run = sup.transition({
      runId: run.runId, expectedStateVersion: run.stateVersion, nextState: "CLARIFICATION_REQUIRED",
      reasonCode: "HUMAN_INPUT_REQUIRED", idempotencyKey: "human-clock-wait",
    }).run;
    expect(sup.getBudget(run.runId).used.timeSeconds).toBe(30);

    now += 24 * 60 * 60_000;
    expect(sup.getBudget(run.runId).used.timeSeconds).toBe(30);
    run = sup.transition({
      runId: run.runId, expectedStateVersion: run.stateVersion, nextState: "PLANNING",
      reasonCode: "HUMAN_INPUT_RECEIVED", idempotencyKey: "human-clock-resume",
    }).run;
    now += 15_000;
    expect(sup.getBudget(run.runId).used.timeSeconds).toBe(45);
    sup.close();
  });
});
