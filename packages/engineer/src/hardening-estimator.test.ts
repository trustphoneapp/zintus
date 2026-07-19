import { describe, expect, test } from "bun:test";
import {
  HardeningConsentRequestSchema,
  HardeningQuoteRequestSchema,
  HardeningQuoteViewSchema,
  createAdvisoryBacklogItem,
} from "./advisory-hardening-contracts.js";
import {
  DEFAULT_HARDENING_ESTIMATION_AUTHORITY,
  HARDENING_ESTIMATE_ASSUMPTIONS,
  HARDENING_ESTIMATE_ASSUMPTIONS_V2,
  deterministicHardeningEstimate,
  deterministicHardeningEstimateV2,
} from "./hardening-estimator.js";
import { TaskManifestSchema } from "./contracts.js";
import { sha256 } from "./hash.js";

const createdAt = "2026-07-18T12:00:00.000Z";
const manifestContent = {
  manifestVersion: 1,
  runId: "parent-run",
  repository: { repositoryId: "repo", provider: "local" as const, owner: "owner", name: "repo", baseBranch: "main", baseCommitSha: "a".repeat(40) },
  request: { original: "harden advisories", normalized: "harden advisories" },
  acceptanceCriteria: [{ criterionId: "must", statement: "Preserve behavior", verificationMethod: "bun test", priority: "MUST" as const }],
  testPlan: [{ testId: "test", criterionIds: ["must"], type: "UNIT" as const, description: "test", command: "bun test" }],
  allowedPaths: ["src/**"], deniedPaths: ["src/private/**"], allowedCommands: ["bun test"], prohibitedCommands: [],
  riskTier: "LOW" as const, humanGateRequired: false,
  retryBudgets: { sameFailureAttempts: 1, builderRepairAttempts: 1, reviewerFixAttempts: 1, plannerRestarts: 1, sandboxProvisioningAttempts: 1, transientModelAttempts: 1 },
  timeBudgetSeconds: 600, tokenBudget: 10_000, costBudgetUsd: 1, createdAt,
};
const manifest = TaskManifestSchema.parse({ ...manifestContent, manifestHash: sha256(manifestContent) });

function advisory(index: number, file = `src/file-${index}.ts`) {
  return createAdvisoryBacklogItem({
    schemaVersion: 1, policyVersion: "engineer-advisory-backlog-v1", parentRunId: "parent-run",
    requesterUserId: "user", repositoryId: "repo", parentCheckpointId: sha256("parent-id"),
    parentCheckpointHash: sha256("parent-hash"), requiredLaneContractHash: sha256("contract"),
    classificationHash: sha256("classification"), reviewerSessionId: "reviewer", findingId: `finding-${index}`,
    findingFingerprint: sha256(`fingerprint-${index}`), sourceClassificationHash: sha256(`source-${index}`),
    disposition: "ADVISORY", reasonCode: "OUTSIDE_FROZEN_REQUIRED_SCOPE", authority: "NONE",
    reportedSeverity: "MEDIUM", category: "hardening", description: "Optional improvement",
    requiredChange: "Add defense", file, lineStart: 1, lineEnd: 1, criterionIds: ["must"], evidenceIds: ["evidence"],
    actionability: file.startsWith("src/private/") ? "AUDIT_ONLY" : "ACTIONABLE", createdAt,
  }, manifest);
}

describe("deterministic optional-hardening estimator", () => {
  test("uses the exact one-advisory formulas, frozen roles, and required assumptions", () => {
    expect(deterministicHardeningEstimate([advisory(1)])).toEqual({
      estimatorVersion: "deterministic-hardening-estimator-v1",
      routingPolicyVersion: "engineer-model-routing-v2",
      pricingVersion: "openai-gpt56-pricing-2026-07-14",
      estimate: {
        maxCostMicrousd: 660_000,
        maxTokens: 28_500,
        maxTimeSeconds: 480,
        maxPlannerCalls: 0,
        maxBuilderCalls: 1,
        maxReviewerCalls: 1,
        automaticRepairCalls: 0,
      },
      assumptions: [...HARDENING_ESTIMATE_ASSUMPTIONS],
    });
  });

  test("counts unique non-null files and is independent of advisory order", () => {
    const first = advisory(1, "src/shared.ts");
    const second = advisory(2, "src/shared.ts");
    const forward = deterministicHardeningEstimate([first, second]);
    const reversed = deterministicHardeningEstimate([second, first]);
    expect(forward).toEqual(reversed);
    expect(forward.estimate).toEqual({
      maxCostMicrousd: 720_000, maxTokens: 31_500, maxTimeSeconds: 600,
      maxPlannerCalls: 0, maxBuilderCalls: 1, maxReviewerCalls: 1, automaticRepairCalls: 0,
    });
  });

  test("enforces the 20-advisory selection limit and token ceilings", () => {
    const advisories = Array.from({ length: 20 }, (_, index) => advisory(index));
    expect(deterministicHardeningEstimate(advisories).estimate).toEqual({
      maxCostMicrousd: 1_650_000, maxTokens: 78_000, maxTimeSeconds: 3_900,
      maxPlannerCalls: 0, maxBuilderCalls: 1, maxReviewerCalls: 1, automaticRepairCalls: 0,
    });
    expect(() => deterministicHardeningEstimate([...advisories, advisory(21)])).toThrow();
    expect(() => deterministicHardeningEstimate([])).toThrow();
  });

  test("v2 signs independent role input and output caps without changing v1", () => {
    const one = deterministicHardeningEstimateV2([advisory(1)]);
    expect(one).toEqual({
      estimatorVersion: "deterministic-hardening-estimator-v2",
      routingPolicyVersion: "engineer-model-routing-v2",
      pricingVersion: "openai-gpt56-pricing-2026-07-14",
      cachePolicyVersion: "engineer-hardening-prompt-cache-v1",
      cacheAccountingVersion: "openai-prompt-cache-accounting-v1",
      cacheWriteInputMultiplier: { numerator: 5, denominator: 4 },
      estimate: {
        maxCostMicrousd: 746_875,
        maxTokens: 73_000,
        maxTimeSeconds: 480,
        maxPlannerCalls: 0,
        maxBuilderCalls: 1,
        maxReviewerCalls: 1,
        automaticRepairCalls: 0,
        inputCaps: {
          builderInputTokens: 15_000,
          builderOutputTokens: 6_000,
          reviewerInputTokens: 40_000,
          reviewerOutputTokens: 12_000,
        },
      },
      assumptions: [...HARDENING_ESTIMATE_ASSUMPTIONS_V2],
    });
    expect(deterministicHardeningEstimateV2([advisory(1), advisory(2, "src/file-1.ts")]).estimate)
      .toEqual({
        maxCostMicrousd: 753_125, maxTokens: 75_000, maxTimeSeconds: 600,
        maxPlannerCalls: 0, maxBuilderCalls: 1, maxReviewerCalls: 1, automaticRepairCalls: 0,
        inputCaps: { builderInputTokens: 17_000, builderOutputTokens: 6_000, reviewerInputTokens: 40_000, reviewerOutputTokens: 12_000 },
      });
    const maximum = Array.from({ length: 20 }, (_, index) => advisory(index));
    expect(deterministicHardeningEstimateV2(maximum).estimate).toEqual({
      maxCostMicrousd: 825_000, maxTokens: 98_000, maxTimeSeconds: 3_900,
      maxPlannerCalls: 0, maxBuilderCalls: 1, maxReviewerCalls: 1, automaticRepairCalls: 0,
      inputCaps: { builderInputTokens: 40_000, builderOutputTokens: 6_000, reviewerInputTokens: 40_000, reviewerOutputTokens: 12_000 },
    });
  });

  test("fails closed for non-actionable, duplicate, missing, zero, altered, or stale authority", () => {
    const item = advisory(1);
    expect(() => deterministicHardeningEstimate([advisory(2, "src/private/key.ts")])).toThrow("actionable advisories");
    expect(() => deterministicHardeningEstimate([item, item])).toThrow("unique advisories");
    expect(() => deterministicHardeningEstimate([item], {} as never)).toThrow();
    expect(() => deterministicHardeningEstimate([item], {
      ...DEFAULT_HARDENING_ESTIMATION_AUTHORITY,
      roles: { ...DEFAULT_HARDENING_ESTIMATION_AUTHORITY.roles, builder: { ...DEFAULT_HARDENING_ESTIMATION_AUTHORITY.roles.builder, outputMicrousdPerMillion: 0 } },
    })).toThrow();
    expect(() => deterministicHardeningEstimate([item], {
      ...DEFAULT_HARDENING_ESTIMATION_AUTHORITY,
      roles: { ...DEFAULT_HARDENING_ESTIMATION_AUTHORITY.roles, reviewer: { ...DEFAULT_HARDENING_ESTIMATION_AUTHORITY.roles.reviewer, model: "stale-reviewer" } },
    })).toThrow("stale");
    expect(() => deterministicHardeningEstimate([item], {
      ...DEFAULT_HARDENING_ESTIMATION_AUTHORITY,
      pricingVersion: "old-pricing",
    } as never)).toThrow();
  });

  test("strictly validates public quote and consent owner input", () => {
    const ids = [advisory(1).advisoryId, advisory(2).advisoryId].sort();
    const request = { runId: "parent-run", advisoryIds: ids, expectedParentStateVersion: 12, idempotencyKey: "quote-op" };
    expect(HardeningQuoteRequestSchema.parse(request)).toEqual(request);
    expect(() => HardeningQuoteRequestSchema.parse({ ...request, advisoryIds: [...ids].reverse() })).toThrow();
    expect(() => HardeningQuoteRequestSchema.parse({ ...request, advisoryIds: [ids[0], ids[0]] })).toThrow();
    expect(() => HardeningQuoteRequestSchema.parse({ ...request, actorId: "spoofed" })).toThrow();

    const consent = {
      quoteId: sha256("quote-id"), quoteHash: sha256("quote-hash"),
      authorizedBudget: { costMicrousd: 210_000, tokens: 10_500, timeSeconds: 480 },
      acknowledgements: { separateRun: true, parentCandidateUnchanged: true, noAutomaticRepair: true, noOverages: true },
      expectedParentStateVersion: 12, idempotencyKey: "consent-op",
    } as const;
    expect(HardeningConsentRequestSchema.parse(consent)).toEqual(consent);
    expect(() => HardeningConsentRequestSchema.parse({ ...consent, acknowledgements: { ...consent.acknowledgements, noOverages: false } })).toThrow();
    expect(() => HardeningConsentRequestSchema.parse({ ...consent, actorId: "spoofed" })).toThrow();

    const result = deterministicHardeningEstimate([advisory(1)]);
    const view = {
      schemaVersion: 1, policyVersion: "engineer-hardening-estimate-v1",
      quoteId: sha256("quote-id"), quoteHash: sha256("quote-hash"), parentRunId: "parent-run",
      requesterUserId: "user", repositoryId: "repo", parentCheckpointId: sha256("parent-id"),
      parentCheckpointHash: sha256("parent-hash"), parentStateVersion: 12, advisoryIds: [advisory(1).advisoryId],
      selectionHash: sha256([advisory(1).advisoryId]), estimatorVersion: result.estimatorVersion,
      routingPolicyVersion: result.routingPolicyVersion, pricingVersion: result.pricingVersion,
      estimate: result.estimate, assumptions: result.assumptions, createdAt,
      expiresAt: "2026-07-18T12:15:00.000Z", status: "ACTIVE",
    } as const;
    const parsedView = HardeningQuoteViewSchema.parse(view);
    expect(parsedView.quoteId).toBe(view.quoteId);
    expect(parsedView.status).toBe("ACTIVE");
    expect(() => HardeningQuoteViewSchema.parse({ ...view, idempotencyKey: "must-not-leak" })).toThrow();
  });
});
