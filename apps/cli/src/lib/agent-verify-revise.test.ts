// B3 — the deterministic test-gated verify→revise controller.
//
// The gate fires ONLY on a real exit code: after edits, run the project verify command;
// on FAILURE feed the failure back and let the model revise, BOUNDED by MAX_REVISE; on a
// passing verify, do not revise; on exhaustion surface an HONEST failure (never claim a
// success). It is off when no edits were made (the same shape as "off without --allow-run",
// which the CLI additionally gates on). These tests drive the controller with injected,
// deterministic verify + revise functions — no process is spawned and no model is routed.

import { describe, expect, it } from "bun:test";
import type { ChatMessage } from "@zintus/types";
import {
  MAX_REVISE,
  type VerifyOutcome,
  runVerifyReviseController,
} from "./agent-tools.js";

const baseConvo: ChatMessage[] = [{ role: "user", content: "task" }];

function failOutcome(): VerifyOutcome {
  return { pass: false, command: "bun run test", code: 1, stdout: "", stderr: "1 fail" };
}
function passOutcome(): VerifyOutcome {
  return { pass: true, command: "bun run test", code: 0, stdout: "ok", stderr: "" };
}

describe("runVerifyReviseController", () => {
  it("edits + a persistently FAILING verify drives a BOUNDED revise loop and surfaces an honest failure", async () => {
    let verifyCalls = 0;
    let reviseCalls = 0;
    const reviseAttempts: number[] = [];
    let exhausted: { revisions: number } | null = null;

    const result = await runVerifyReviseController(baseConvo, {
      editsMade: () => true,
      runVerify: async () => {
        verifyCalls += 1;
        return failOutcome();
      },
      revise: async (convo) => {
        reviseCalls += 1;
        return { convo, rounds: 2 };
      },
      onRevise: (attempt) => reviseAttempts.push(attempt),
      onExhausted: (_o, revisions) => {
        exhausted = { revisions };
      },
    });

    // Bounded: exactly MAX_REVISE revises, and a verify before each + one final.
    expect(reviseCalls).toBe(MAX_REVISE);
    expect(verifyCalls).toBe(MAX_REVISE + 1);
    expect(reviseAttempts).toEqual([1, 2]);
    // Honest: never claims success; exhaustion surfaced.
    expect(result.verified).toBe(false);
    expect(result.revisions).toBe(MAX_REVISE);
    expect(exhausted).not.toBeNull();
    expect(exhausted!.revisions).toBe(MAX_REVISE);
    // reviseRounds accumulates the writer rounds consumed by revises.
    expect(result.reviseRounds).toBe(2 * MAX_REVISE);
  });

  it("a PASSING verify does not revise", async () => {
    let reviseCalls = 0;
    const result = await runVerifyReviseController(baseConvo, {
      editsMade: () => true,
      runVerify: async () => passOutcome(),
      revise: async (convo) => {
        reviseCalls += 1;
        return { convo, rounds: 1 };
      },
    });
    expect(reviseCalls).toBe(0);
    expect(result.verified).toBe(true);
    expect(result.revisions).toBe(0);
  });

  it("a failure that the revise FIXES stops as soon as verify passes (verified, bounded)", async () => {
    let verifyCalls = 0;
    let reviseCalls = 0;
    const result = await runVerifyReviseController(baseConvo, {
      editsMade: () => true,
      runVerify: async () => {
        verifyCalls += 1;
        return verifyCalls === 1 ? failOutcome() : passOutcome();
      },
      revise: async (convo) => {
        reviseCalls += 1;
        return { convo, rounds: 3 };
      },
    });
    expect(reviseCalls).toBe(1);
    expect(verifyCalls).toBe(2);
    expect(result.verified).toBe(true);
    expect(result.revisions).toBe(1);
    expect(result.reviseRounds).toBe(3);
  });

  it("is OFF when no edits were made (mirrors --allow-run absent): never verifies, claims nothing", async () => {
    let verifyCalls = 0;
    const result = await runVerifyReviseController(baseConvo, {
      editsMade: () => false,
      runVerify: async () => {
        verifyCalls += 1;
        return failOutcome();
      },
      revise: async (convo) => ({ convo, rounds: 1 }),
    });
    expect(verifyCalls).toBe(0);
    expect(result.verified).toBeNull();
    expect(result.revisions).toBe(0);
  });

  it("treats a could-not-run verify (disabled/declined/budget) as a SKIP, never a pass", async () => {
    let reviseCalls = 0;
    const result = await runVerifyReviseController(baseConvo, {
      editsMade: () => true,
      runVerify: async () => null,
      revise: async (convo) => {
        reviseCalls += 1;
        return { convo, rounds: 1 };
      },
    });
    expect(reviseCalls).toBe(0);
    expect(result.verified).toBeNull();
  });
});
