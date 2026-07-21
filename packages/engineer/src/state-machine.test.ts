import { describe, expect, test } from "bun:test";
import {
  RUN_STATES,
  TERMINAL_STATES,
  type RunState,
} from "./contracts.js";
import {
  STATE_RUNTIME_POLICIES,
  STATE_TRANSITIONS,
  canTransition,
  isCancellationAllowed,
  isTerminalState,
} from "./state-machine.js";

describe("Engineer state machine", () => {
  test("every interrupted Phase 2 worker state has bounded requeue and exhaustion exits", () => {
    for (const state of [
      "SANDBOX_WARM_CLAIMING", "SANDBOX_WARM_VALIDATING", "SANDBOX_WARM_CLAIMED",
      "SANDBOX_COLD_PROVISIONING", "SANDBOX_PREWARM_INVALID", "SANDBOX_PROVISIONING",
      "SANDBOX_PREFLIGHT", "SANDBOX_READY", "CONTEXT_BUILDING", "IMPLEMENTING",
    ] as const) {
      expect(canTransition(state, "QUEUED")).toBe(true);
      expect(canTransition(state, "RETRY_BUDGET_EXHAUSTED")).toBe(true);
    }
  });
  test("mandatory corrected flows are explicit", () => {
    expect(canTransition("REVIEWING", "REVIEW_CHANGES_REQUESTED")).toBe(true);
    expect(canTransition("REVIEW_CHANGES_REQUESTED", "REVIEW_FIX_PREPARING")).toBe(true);
    expect(canTransition("REVIEW_FIX_PREPARING", "IMPLEMENTING")).toBe(true);
    expect(canTransition("REVIEW_APPROVED", "HUMAN_APPROVAL_PENDING")).toBe(true);
    expect(canTransition("HUMAN_REVIEW_REQUIRED", "REVIEW_APPROVED")).toBe(false);
    expect(canTransition("HUMAN_REVIEW_REQUIRED", "REJECTED")).toBe(true);
    expect(canTransition("HUMAN_APPROVED", "PR_PREFLIGHT")).toBe(true);
    expect(canTransition("PR_CREATED", "COMPLETED")).toBe(true);
    expect(canTransition("IMPLEMENTING", "PR_CREATING")).toBe(false);
    expect(canTransition("UNIT_TESTING", "PR_CREATING")).toBe(false);
  });

  test("no generic state-machine edge can enter REVIEW_APPROVED", () => {
    for (const state of RUN_STATES) expect(canTransition(state, "REVIEW_APPROVED")).toBe(false);
  });

  test("unrecoverable execution evidence can fail closed from every verification stage", () => {
    for (const state of ["IMPLEMENTING","FAST_CHECKS","UNIT_TESTING","INTEGRATION_TESTING","E2E_TESTING",
      "FLAKE_QUARANTINE","SECURITY_REVIEW","CODE_REVIEW","EVIDENCE_SYNTHESIS","REVIEWING","HUMAN_REVIEW_REQUIRED"] as const) {
      expect(canTransition(state,"FAILED")).toBe(true);
    }
  });

  test("provider timeout recovery is human-bounded and remains cancellable", () => {
    expect(canTransition("IMPLEMENTING", "MODEL_PROVIDER_RETRY_PENDING")).toBe(true);
    expect(canTransition("MODEL_PROVIDER_RETRY_PENDING", "QUEUED")).toBe(true);
    expect(canTransition("MODEL_PROVIDER_RETRY_PENDING", "HUMAN_REVIEW_REQUIRED")).toBe(true);
    expect(canTransition("MODEL_PROVIDER_RETRY_PENDING", "CANCELLATION_PENDING")).toBe(true);
    expect(canTransition("MODEL_PROVIDER_RETRY_PENDING", "FAST_CHECKS")).toBe(false);
    expect(isTerminalState("MODEL_PROVIDER_RETRY_PENDING")).toBe(false);
  });

  test("terminal states have no outgoing transitions", () => {
    for (const state of TERMINAL_STATES) {
      expect(isTerminalState(state)).toBe(true);
      expect(STATE_TRANSITIONS[state]).toEqual([]);
      expect(STATE_RUNTIME_POLICIES[state].cancellationState).toBeNull();
    }
  });

  test("publication states are fenced from cancellation until durable remote cleanup exists", () => {
    for (const state of ["PR_PREFLIGHT", "PR_CREATING", "PR_CREATED", "PR_CREATION_FAILED", "BASE_BRANCH_STALE"] as const) {
      expect(canTransition(state, "CANCELLATION_PENDING")).toBe(false);
      expect(canTransition(state, "PAUSED_BUDGET")).toBe(false);
      expect(isCancellationAllowed(state)).toBe(false);
      expect(STATE_RUNTIME_POLICIES[state].cancellationState).toBeNull();
    }
    expect(isCancellationAllowed("HUMAN_APPROVED")).toBe(true);
    expect(canTransition("PR_PREFLIGHT", "FAILED")).toBe(true);
    expect(canTransition("PR_CREATING", "HUMAN_REVIEW_REQUIRED")).toBe(true);
  });

  test("every non-terminal state has a path to a terminal state and a timeout policy", () => {
    const terminals = new Set<RunState>(TERMINAL_STATES);
    const reachesTerminal = (start: RunState): boolean => {
      const queue: RunState[] = [start];
      const seen = new Set<RunState>();
      while (queue.length > 0) {
        const state = queue.shift();
        if (!state || seen.has(state)) continue;
        if (terminals.has(state)) return true;
        seen.add(state);
        queue.push(...STATE_TRANSITIONS[state]);
      }
      return false;
    };

    for (const state of RUN_STATES) {
      expect(STATE_RUNTIME_POLICIES[state]).toBeDefined();
      if (!terminals.has(state)) {
        expect(STATE_RUNTIME_POLICIES[state].maxDurationSeconds).toBeGreaterThan(0);
        expect(reachesTerminal(state)).toBe(true);
      }
    }
  });
});
