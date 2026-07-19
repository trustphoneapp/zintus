import { describe, expect, test } from "bun:test";
import { DEFAULT_HARDENING_ESTIMATION_AUTHORITY_V2 } from "./hardening-estimator.js";
import { sha256 } from "./hash.js";
import {
  createHardeningBudgetAuthority,
  createHardeningBudgetReconciliation,
  createHardeningBudgetReservation,
  hardeningModelCostMicrousd,
  hardeningModelPartitionedCostMicrousd,
  hardeningPartitionedCostFromRatesMicrousd,
  assertHardeningReservationCost,
} from "./hardening-budget-contracts.js";
import { createHardeningPromptCacheMaterial } from "./hardening-prompt-cache.js";
import { builderStaticRequestPrefix } from "./codex-builder.js";

const at = "2026-07-18T12:00:00.000Z";
const hash = (value: string) => sha256(value);

describe("optional-hardening hard budget contracts", () => {
  test("binds the exact consent allowance and frozen 0/1/1 paid graph", () => {
    const authority = createHardeningBudgetAuthority({
      schemaVersion: 1,
      policyVersion: "engineer-hardening-child-budget-v1",
      childRunId: "child",
      lineageId: hash("lineage-id"), lineageHash: hash("lineage-hash"),
      quoteId: hash("quote-id"), quoteHash: hash("quote-hash"),
      consentId: hash("consent-id"), consentHash: hash("consent-hash"),
      costLimitMicrousd: 1_000_000, tokenLimit: 50_000, activeTimeLimitMs: 120_000,
      estimationAuthority: DEFAULT_HARDENING_ESTIMATION_AUTHORITY_V2,
      paidGraph: { plannerCalls: 0, builderCalls: 1, reviewerCalls: 1, automaticRepairCalls: 0 },
      toolLimits: { maxToolCalls:8,maxMutations:8,maxCommandCalls:8,maxToolArgumentBytes:131_072,maxFileBytes:1_048_576,
        maxToolResultBytes:32_768,maxSearchBytes:8_388_608,maxSearchResults:100,maxRangeLines:400 },
      transportLimits:{builderInputCap:40_000,builderOutputCeiling:6_000,reviewerInputCap:40_000,reviewerOutputCeiling:12_000,modelTimeoutMs:120_000},
      createdAt: at,
    });
    expect(authority.budgetAuthorityId).toStartWith("sha256:");
    expect(() => createHardeningBudgetAuthority({ ...authority, automaticRepairCalls: 1 } as never)).toThrow();
  });

  test("uses integer ceiling arithmetic and rejects a stale or under-priced reservation", () => {
    expect(hardeningModelCostMicrousd("BUILDER", 1, 1)).toBe(19);
    expect(hardeningModelCostMicrousd("REVIEWER", 1, 1)).toBe(37);
    expect(hardeningModelPartitionedCostMicrousd("BUILDER",1,0,0,1)).toBe(18);
    expect(hardeningModelPartitionedCostMicrousd("REVIEWER",1,0,0,1)).toBe(35);
    expect(hardeningModelPartitionedCostMicrousd("BUILDER",1,1,0,1)).toBe(16);
    expect(hardeningModelPartitionedCostMicrousd("REVIEWER",1,1,0,1)).toBe(31);
    expect(hardeningModelPartitionedCostMicrousd("BUILDER",1,0,1,1)).toBe(19);
    expect(hardeningModelPartitionedCostMicrousd("REVIEWER",1,0,1,1)).toBe(37);
    expect(hardeningModelPartitionedCostMicrousd("BUILDER",100,40,20,10)).toBe(323);
    expect(hardeningModelPartitionedCostMicrousd("REVIEWER",100,40,20,10)).toBe(645);
    expect(hardeningModelPartitionedCostMicrousd("BUILDER",2,1,1,0)).toBe(5);
    expect(() => hardeningModelPartitionedCostMicrousd("BUILDER",1,1,1,0)).toThrow("cannot exceed");
    expect(() => hardeningModelPartitionedCostMicrousd("BUILDER",Number.MAX_SAFE_INTEGER+1,0,0,0)).toThrow();
    expect(() => hardeningPartitionedCostFromRatesMicrousd(1,0,0,0,{
      uncachedInputMicrousdPerMillion:0,cachedInputMicrousdPerMillion:1,cacheWriteInputMicrousdPerMillion:1,
      outputMicrousdPerMillion:1})).toThrow();
    const builderPrefix=builderStaticRequestPrefix("gpt-5.6-terra");
    const cache = createHardeningPromptCacheMaterial({secret:"budget-contract-cache-secret-000000000000",requesterUserId:"user",childRunId:"child",
      role:"BUILDER",resolvedModel:"gpt-5.6-terra",promptOrReviewerPolicyVersion:"engineer-codex-builder-v3",
      staticPrefix:builderPrefix,toolSchema:builderPrefix.tools}).descriptor;
    const price=DEFAULT_HARDENING_ESTIMATION_AUTHORITY_V2.roles.builder;
    const reservation = createHardeningBudgetReservation({
      schemaVersion: 1, policyVersion: "engineer-hardening-child-model-reservation-v1",
      childRunId: "child", budgetAuthorityId: hash("authority-id"), budgetAuthorityHash: hash("authority-hash"),
      paidCallSlotId: hash("slot"), role: "BUILDER", modelTier: "GPT-5.6_TERRA",
      resolvedModel: price.model,
      pricingVersion: DEFAULT_HARDENING_ESTIMATION_AUTHORITY_V2.pricingVersion,
      agentExecutionId: "agent", routingDecisionId: "route", claimantId: "agent",
      expectedRunState:"IMPLEMENTING",expectedStateVersion:7,
      requestHash: hash("canonical-request"), clientRequestId: "00000000-0000-4000-8000-000000000000",
      inputTokenUpperBound: 10, outputTokenCeiling: 20, reservedTokens: 30,
      ...cache,reservedCacheWriteInputTokens:10,reservedCachedInputTokens:0,
      uncachedInputMicrousdPerMillion:price.uncachedInputMicrousdPerMillion,cachedInputMicrousdPerMillion:price.cachedInputMicrousdPerMillion,
      cacheWriteInputMicrousdPerMillion:price.cacheWriteInputMicrousdPerMillion,outputMicrousdPerMillion:price.outputMicrousdPerMillion,
      reservedCostMicrousd: hardeningModelCostMicrousd("BUILDER", 10, 20), createdAt: at,
    });
    expect(() => assertHardeningReservationCost(reservation)).not.toThrow();
    expect(() => assertHardeningReservationCost({ ...reservation, reservedCostMicrousd: reservation.reservedCostMicrousd - 1 })).toThrow();
    expect(() => createHardeningBudgetReservation({ ...reservation, reservedTokens: 29 } as never)).toThrow();
    expect(hardeningModelPartitionedCostMicrousd("BUILDER",4,1,1,1)).toBe(25);
  });

  test("settles only complete usage and otherwise retains the entire reservation as ambiguous", () => {
    const common = {
      schemaVersion: 1 as const, policyVersion: "engineer-hardening-budget-reconciliation-v1" as const,
      childRunId: "child", reservationId: hash("reservation-id"), reservationHash: hash("reservation-hash"),
      modelCallId: "call", createdAt: at,
    };
    expect(createHardeningBudgetReconciliation({ ...common, status: "SETTLED", providerResponseId: "response",
      actualInputTokens: 3, actualOutputTokens: 4,actualCachedInputTokens:1,actualCacheWriteInputTokens:1,
      cacheObservation:"MIXED", actualCostMicrousd: 68 }).status).toBe("SETTLED");
    expect(createHardeningBudgetReconciliation({ ...common, status: "AMBIGUOUS", providerResponseId: null,
      actualInputTokens: null, actualOutputTokens: null,actualCachedInputTokens:null,actualCacheWriteInputTokens:null,
      cacheObservation:"UNKNOWN", actualCostMicrousd: null }).status).toBe("AMBIGUOUS");
    expect(() => createHardeningBudgetReconciliation({ ...common, status: "AMBIGUOUS", providerResponseId: "partial",
      actualInputTokens: null, actualOutputTokens: null,actualCachedInputTokens:null,actualCacheWriteInputTokens:null,
      cacheObservation:"UNKNOWN", actualCostMicrousd: null })).toThrow();
  });
});
