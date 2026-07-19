import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FailureRecordSchema } from "./control-contracts.js";
import { sha256 } from "./hash.js";
import { EngineerLedger } from "./ledger.js";
import {
  type CanonicalBlocker,
  classifyPhase3UnderlyingCause,
  evaluateReverifyEligibility,
  reverifyBlockerReasonCode,
} from "./resolution-case.js";

let root: string;
let ledger: EngineerLedger;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "zintus-typed-cause-"));
  ledger = new EngineerLedger(join(root, "engineer.db"));
});
afterEach(() => {
  ledger.close();
  rmSync(root, { recursive: true, force: true });
});

function createRun(runId: string): void {
  ledger.createRun({
    runId, userId: "user-1",
    repository: { repositoryId: "repo-1", provider: "local", owner: "local", name: "repo", baseBranch: "main", baseCommitSha: "a".repeat(40) },
    requestOriginal: "build", riskTier: "MEDIUM", humanGateRequired: true, now: "2026-07-19T00:00:00.000Z",
    budget: { costBudgetUsd: 1, tokenBudget: 1000, timeBudgetSeconds: 600, lifetimeCostBudgetUsd: 1, lifetimeTokenBudget: 1000, lifetimeTimeBudgetSeconds: 600 },
  });
}

describe("migration 32 typed underlying-cause slot", () => {
  test("the failure_records.underlying_cause column exists and is nullable", () => {
    // A fresh ledger runs migrate + assertFailureUnderlyingCauseShape at construction.
    // Recording a failure with no typed cause leaves it absent on the round-trip.
    createRun("run-1");
    const record = FailureRecordSchema.parse({
      failureId: sha256({ f: 1 }), runId: "run-1", failureClass: "WORKFLOW_FAILURE", reasonCode: "PHASE3_UNEXPECTED_FAILURE",
      fingerprint: sha256({ fp: 1 }), evidenceIds: [], retryable: false, createdAt: "2026-07-19T00:00:00.000Z",
    });
    ledger.recordFailure(record);
    const [read] = ledger.listFailures("run-1");
    expect(read).toEqual(record);
    expect(read).not.toHaveProperty("underlyingCause");
  });

  test("a typed underlying cause survives the durable round-trip", () => {
    createRun("run-2");
    const record = FailureRecordSchema.parse({
      failureId: sha256({ f: 2 }), runId: "run-2", failureClass: "WORKFLOW_FAILURE", reasonCode: "PHASE3_UNEXPECTED_FAILURE",
      fingerprint: sha256({ fp: 2 }), evidenceIds: [], retryable: false, underlyingCause: "PROVIDER_REQUEST_TIMEOUT",
      createdAt: "2026-07-19T00:00:00.000Z",
    });
    ledger.recordFailure(record);
    expect(ledger.listFailures("run-2")).toEqual([record]);
  });
});

describe("Phase-3 typed cause end-to-end reverify consumption", () => {
  const candidate = { preVerificationCandidatePresent: true, sourceClassExcluded: false };
  const blocker = (reasonCode: string): CanonicalBlocker => ({ blockerId: "b-1", kind: "BLOCKING", reasonCode, description: "erased phase-3 failure" });

  test("an erased provider-timeout message types and flips reverify eligible", () => {
    // The classifier types the message the erasure site would otherwise hash away.
    const typed = classifyPhase3UnderlyingCause("upstream provider request timed out after 60s");
    expect(typed).toBe("PROVIDER_REQUEST_TIMEOUT");
    // The consumption bridge surfaces the typed cause as the blocker reasonCode.
    const reasonCode = reverifyBlockerReasonCode({ reasonCode: "PHASE3_UNEXPECTED_FAILURE", underlyingCause: typed! });
    expect(reasonCode).toBe("PROVIDER_REQUEST_TIMEOUT");
    expect(evaluateReverifyEligibility({ blockers: [blocker(reasonCode)], ...candidate }))
      .toEqual({ eligible: true, reason: "PROVIDER_REQUEST_TIMEOUT" });
  });

  test("an untyped Phase-3 failure stays reverify-ineligible (PHASE3_CAUSE_UNTYPED)", () => {
    const typed = classifyPhase3UnderlyingCause("something unexpected happened");
    expect(typed).toBeNull();
    const reasonCode = reverifyBlockerReasonCode({ reasonCode: "PHASE3_UNEXPECTED_FAILURE", underlyingCause: undefined });
    expect(reasonCode).toBe("PHASE3_UNEXPECTED_FAILURE");
    expect(evaluateReverifyEligibility({ blockers: [blocker(reasonCode)], ...candidate }))
      .toEqual({ eligible: false, reason: "PHASE3_CAUSE_UNTYPED" });
  });

  test("a non-allowlisted underlying cause is not honored — stays untyped and refused", () => {
    const reasonCode = reverifyBlockerReasonCode({ reasonCode: "PHASE3_UNEXPECTED_FAILURE", underlyingCause: "SOME_UNAPPROVED_CAUSE" });
    expect(reasonCode).toBe("PHASE3_UNEXPECTED_FAILURE");
    expect(evaluateReverifyEligibility({ blockers: [blocker(reasonCode)], ...candidate }))
      .toEqual({ eligible: false, reason: "PHASE3_CAUSE_UNTYPED" });
  });

  test("a typed cause but no retained candidate is still refused", () => {
    const reasonCode = reverifyBlockerReasonCode({ reasonCode: "PHASE3_UNEXPECTED_FAILURE", underlyingCause: "SANDBOX_PROVISION_TIMEOUT" });
    expect(evaluateReverifyEligibility({ blockers: [blocker(reasonCode)], preVerificationCandidatePresent: false, sourceClassExcluded: false }))
      .toEqual({ eligible: false, reason: "NO_PRE_VERIFICATION_CANDIDATE" });
  });

  test("the bridge never downgrades a real defect (non-Phase-3 passes through)", () => {
    expect(reverifyBlockerReasonCode({ reasonCode: "REQUIRED_TEST_FAILED", underlyingCause: "PROVIDER_REQUEST_TIMEOUT" })).toBe("REQUIRED_TEST_FAILED");
  });
});
