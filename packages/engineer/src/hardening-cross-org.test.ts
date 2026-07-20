/**
 * R8-5 BK5 (hardening machinery) cross-tenant isolation — RED-first proofs.
 *
 * Every assertion here targets a public EngineerLedger method whose SOLE
 * cross-tenant protection is the org-scoping predicate this bucket added (none
 * of these methods is gated by an org-scoped getRun(); the budget-authority
 * read/CAS surface is reached directly by childRunId). Using the shared
 * createTwoOrgFixture (contract §5/§9) we plant an org-A hardening budget row on
 * a shared DB and prove org B's ledger can neither READ nor CAS it, and that a
 * cross-org id is byte-indistinguishable from a genuinely-absent id
 * (anti-oracle, contract §2).
 *
 * Planting: raw seed inserts default org_id to the ledger default org (= org A,
 * the v34 additive column DEFAULT), which is exactly the adversarial setup — a
 * legitimate org-A row that org B must never observe or mutate. Both ledgers are
 * constructed on the clean schema BEFORE planting (migration — and its
 * foreign-key check — runs only in the constructor), so the narrow budget-only
 * seed row is never re-validated.
 *
 * These RED on the pre-conversion (fe43eb1c) ledger — without the predicate org
 * B reads org A's authority object and can acquire a fence on org A's budget —
 * and GREEN after this bucket's conversion.
 */
import { describe, expect, test } from "bun:test";
import { createTwoOrgFixture } from "./test-support/two-org-fixture.js";
import {
  createHardeningBudgetAuthority,
  HardeningBudgetAuthorityInvalidError,
} from "./hardening-budget-contracts.js";
import { DEFAULT_HARDENING_ESTIMATION_AUTHORITY_V2 } from "./hardening-estimator.js";
import { sha256 } from "./hash.js";

const NOW = "2026-07-20T00:00:00.000Z";
const NOW_MS = Date.parse(NOW);

const BUDGET_TRIGGER = "require_hardening_child_budget_authority_v29";

function buildAuthority(childRunId: string) {
  return createHardeningBudgetAuthority({
    schemaVersion: 1,
    policyVersion: "engineer-hardening-child-budget-v1",
    childRunId,
    lineageId: sha256(`${childRunId}:lineage-id`),
    lineageHash: sha256(`${childRunId}:lineage-hash`),
    quoteId: sha256(`${childRunId}:quote-id`),
    quoteHash: sha256(`${childRunId}:quote-hash`),
    consentId: sha256(`${childRunId}:consent-id`),
    consentHash: sha256(`${childRunId}:consent-hash`),
    costLimitMicrousd: 2_000_000,
    tokenLimit: 100_000,
    activeTimeLimitMs: 600_000,
    estimationAuthority: DEFAULT_HARDENING_ESTIMATION_AUTHORITY_V2,
    paidGraph: { plannerCalls: 0, builderCalls: 1, reviewerCalls: 1, automaticRepairCalls: 0 },
    toolLimits: {
      maxToolCalls: 8, maxMutations: 8, maxCommandCalls: 8, maxToolArgumentBytes: 131_072,
      maxFileBytes: 1_048_576, maxToolResultBytes: 32_768, maxSearchBytes: 8_388_608,
      maxSearchResults: 100, maxRangeLines: 400,
    },
    transportLimits: {
      builderInputCap: 40_000, builderOutputCeiling: 6_000, reviewerInputCap: 40_000,
      reviewerOutputCeiling: 12_000, modelTimeoutMs: 120_000,
    },
    createdAt: NOW,
  });
}

/** Plant an ACTIVE org-A budget authority (org_id defaults to the default org). */
function plantOrgABudget(fixture: ReturnType<typeof createTwoOrgFixture>, childRunId: string) {
  const authority = buildAuthority(childRunId);
  const seed = fixture.seed();
  try {
    seed.exec(`DROP TRIGGER IF EXISTS ${BUDGET_TRIGGER}`);
    seed.query(`INSERT INTO hardening_child_budget_authorities(
      id,authority_hash,schema_version,policy_version,child_run_id,lineage_id,lineage_hash,quote_id,quote_hash,consent_id,consent_hash,
      cost_limit_microusd,token_limit,active_time_limit_ms,max_builder_calls,max_reviewer_calls,max_tool_calls,max_mutations,
      max_command_calls,max_tool_argument_bytes,max_file_bytes,max_tool_result_bytes,max_search_bytes,max_search_results,max_range_lines,
      builder_input_token_cap,builder_output_ceiling,reviewer_input_token_cap,reviewer_output_ceiling,model_timeout_ms,automatic_repair_calls,
      used_cost_microusd,used_tokens,reserved_cost_microusd,reserved_tokens,ambiguous_cost_microusd,ambiguous_tokens,used_active_ms,
      active_since_ms,fence_owner_id,fence_token_hash,fence_generation,fence_expires_at_ms,status,stop_reason,revision,created_at_ms,updated_at_ms)
      VALUES(${Array.from({ length: 48 }, () => "?").join(",")})`).run(
      authority.budgetAuthorityId, authority.budgetAuthorityHash, 1, authority.policyVersion, childRunId,
      authority.lineageId, authority.lineageHash, authority.quoteId, authority.quoteHash, authority.consentId, authority.consentHash,
      authority.costLimitMicrousd, authority.tokenLimit, authority.activeTimeLimitMs, 1, 1, 8, 8, 8,
      131_072, 1_048_576, 32_768, 8_388_608, 100, 400, 40_000, 6_000, 40_000, 12_000, 120_000, 0,
      0, 0, 0, 0, 0, 0, 0, NOW_MS, null, null, 0, null, "ACTIVE", null, 1, NOW_MS, NOW_MS,
    );
  } finally {
    seed.close();
  }
  return authority;
}

function budgetFenceOwner(fixture: ReturnType<typeof createTwoOrgFixture>, childRunId: string): unknown {
  const db = fixture.seed();
  try {
    const row = db.query("SELECT fence_owner_id FROM hardening_child_budget_authorities WHERE child_run_id=?")
      .get(childRunId) as { fence_owner_id: unknown } | null;
    return row?.fence_owner_id ?? null;
  } finally {
    db.close();
  }
}

describe("R8-5 BK5 hardening budget-authority cross-tenant isolation", () => {
  test("getHardeningChildBudgetAuthority: org B cannot read org A's authority (identical null to absent)", () => {
    const fixture = createTwoOrgFixture({ now: NOW });
    try {
      // Construct both ledgers on the pristine schema before planting.
      fixture.ledgerA(); fixture.ledgerB();
      const childRunId = sha256("bk5:read:child");
      plantOrgABudget(fixture, childRunId);

      // Org A (owner) sees its own authority.
      const ownView = fixture.ledgerA().getHardeningChildBudgetAuthority(childRunId);
      expect(ownView).not.toBeNull();
      expect(ownView!.childRunId).toBe(childRunId);

      // Org B: the cross-org row is INDISTINGUISHABLE from a genuinely-absent one.
      const crossOrg = fixture.ledgerB().getHardeningChildBudgetAuthority(childRunId);
      const trulyAbsent = fixture.ledgerB().getHardeningChildBudgetAuthority(sha256("bk5:absent"));
      expect(crossOrg).toBeNull();
      expect(trulyAbsent).toBeNull();
      expect(crossOrg).toEqual(trulyAbsent);
    } finally {
      fixture.cleanup();
    }
  });

  test("hardeningPaidCallRecoveryReady: org B cannot observe org A's authority state", () => {
    const fixture = createTwoOrgFixture({ now: NOW });
    try {
      // Construct both ledgers on the pristine schema before planting.
      fixture.ledgerA(); fixture.ledgerB();
      const childRunId = sha256("bk5:recovery:child");
      plantOrgABudget(fixture, childRunId);

      // Org A observes real ACTIVE state (no live fence -> ready).
      expect(fixture.ledgerA().hardeningPaidCallRecoveryReady(childRunId, NOW_MS)).toBe(true);

      // Org B sees no such row -> false, identical to a genuinely-absent child.
      expect(fixture.ledgerB().hardeningPaidCallRecoveryReady(childRunId, NOW_MS)).toBe(false);
      expect(fixture.ledgerB().hardeningPaidCallRecoveryReady(sha256("bk5:absent2"), NOW_MS)).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  test("acquireHardeningExecutionFence: org B cannot CAS a fence onto org A's budget", () => {
    const fixture = createTwoOrgFixture({ now: NOW });
    try {
      // Construct both ledgers on the pristine schema before planting.
      fixture.ledgerA(); fixture.ledgerB();
      const childRunId = sha256("bk5:fence:child");
      plantOrgABudget(fixture, childRunId);
      expect(budgetFenceOwner(fixture, childRunId)).toBeNull();

      // Org B attempt on org A's childRunId: same NotFound-shaped result as a
      // truly-absent child (anti-oracle), and NO write to org A's row.
      let crossErr: unknown;
      try {
        fixture.ledgerB().acquireHardeningExecutionFence({
          childRunId, ownerId: "org-b-worker", ttlMs: 1_000, nowMs: NOW_MS, idempotencyKey: "org-b-key",
        });
      } catch (e) { crossErr = e; }
      let absentErr: unknown;
      try {
        fixture.ledgerB().acquireHardeningExecutionFence({
          childRunId: sha256("bk5:absent3"), ownerId: "org-b-worker", ttlMs: 1_000, nowMs: NOW_MS, idempotencyKey: "org-b-key2",
        });
      } catch (e) { absentErr = e; }

      expect(crossErr).toBeInstanceOf(HardeningBudgetAuthorityInvalidError);
      expect(absentErr).toBeInstanceOf(HardeningBudgetAuthorityInvalidError);
      // org A's authority is untouched — org B's CAS never reached it.
      expect(budgetFenceOwner(fixture, childRunId)).toBeNull();

      // Org A CAN legitimately acquire its own fence (control).
      const fence = fixture.ledgerA().acquireHardeningExecutionFence({
        childRunId, ownerId: "org-a-worker", ttlMs: 1_000, nowMs: NOW_MS, idempotencyKey: "org-a-key",
      });
      expect(fence.childRunId).toBe(childRunId);
      expect(budgetFenceOwner(fixture, childRunId)).toBe("org-a-worker");
    } finally {
      fixture.cleanup();
    }
  });
});
