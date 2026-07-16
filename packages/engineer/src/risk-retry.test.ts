import { describe, expect, test } from "bun:test";
import { RetryBudgetsSchema, RiskFeaturesSchema } from "./contracts.js";
import { assessRisk } from "./risk.js";
import { evaluateRetry, type RetryHistoryItem } from "./retry.js";

describe("deterministic risk engine", () => {
  test("a model cannot soften auth or critical risk", () => {
    const high = assessRisk(RiskFeaturesSchema.parse({
      touchesAuthentication: true,
      requiredChecksPassed: true,
      testCoveragePercent: 100,
    }), { autoApproveLowRisk: true });
    expect(high.riskTier).toBe("HIGH");
    expect(high.humanGateRequired).toBe(true);
    expect(high.matchedRules).toContain("AUTHENTICATION_CHANGE");

    const critical = assessRisk(RiskFeaturesSchema.parse({
      exposesSecrets: true,
      documentationOnly: true,
      requiredChecksPassed: true,
    }), { autoApproveLowRisk: true });
    expect(critical.riskTier).toBe("CRITICAL");
    expect(critical.humanGateRequired).toBe(true);
  });

  test("only explicit, checked, non-functional work is low-risk auto-eligible", () => {
    const manual = assessRisk(RiskFeaturesSchema.parse({
      documentationOnly: true,
      requiredChecksPassed: true,
    }));
    expect(manual.riskTier).toBe("LOW");
    expect(manual.humanGateRequired).toBe(true);

    const automatic = assessRisk(RiskFeaturesSchema.parse({
      documentationOnly: true,
      requiredChecksPassed: true,
    }), { autoApproveLowRisk: true });
    expect(automatic.riskTier).toBe("LOW");
    expect(automatic.humanGateRequired).toBe(false);
  });

  test("a generated-code majority is a visible medium-risk factor", () => {
    const result = assessRisk(RiskFeaturesSchema.parse({
      generatedCodePercent: 75,
      diffLines: 100,
      testCoveragePercent: 90,
      requiredChecksPassed: true,
    }));
    expect(result.riskTier).toBe("MEDIUM");
    expect(result.matchedRules).toContain("GENERATED_CODE_MAJORITY");
  });
});

describe("bounded retry policy", () => {
  const budgets = RetryBudgetsSchema.parse({});

  test("same failure cannot be reworded into an infinite retry", () => {
    const history: RetryHistoryItem[] = [
      { kind: "BUILDER_REPAIR", failureFingerprint: "failure-a", patchHash: "patch-1", allowed: true },
      { kind: "BUILDER_REPAIR", failureFingerprint: "failure-a", patchHash: "patch-2", allowed: true },
    ];
    const result = evaluateRetry({
      kind: "BUILDER_REPAIR",
      failureFingerprint: "failure-a",
      patchHash: "patch-3",
    }, history, budgets);
    expect(result.allowed).toBe(false);
    expect(result.reasonCode).toBe("SAME_FAILURE_LIMIT_REACHED");
  });

  test("identical patches stop the same failure but permit a newly fingerprinted finding", () => {
    const history: RetryHistoryItem[] = [{
      kind: "REVIEWER_FIX",
      failureFingerprint: "finding-a",
      patchHash: "same-patch",
      progressMetric: 4,
      allowed: true,
    }];
    expect(evaluateRetry({
      kind: "REVIEWER_FIX",
      failureFingerprint: "finding-b",
      patchHash: "same-patch",
      progressMetric: 5,
    }, history, budgets).reasonCode).toBe("RETRY_ALLOWED");
    expect(evaluateRetry({
      kind: "REVIEWER_FIX",
      failureFingerprint: "finding-a",
      patchHash: "same-patch",
      progressMetric: 5,
    }, history, budgets).reasonCode).toBe("IDENTICAL_PATCH_REPEATED");
    expect(evaluateRetry({
      kind: "REVIEWER_FIX",
      failureFingerprint: "finding-a",
      patchHash: "new-patch",
      progressMetric: 4,
    }, history, budgets).reasonCode).toBe("NO_MEASURABLE_PROGRESS");
  });

  test("Reviewer fixes consume the total Builder budget", () => {
    const history: RetryHistoryItem[] = [
      { kind: "REVIEWER_FIX", failureFingerprint: "r1", allowed: true },
      { kind: "REVIEWER_FIX", failureFingerprint: "r2", allowed: true },
      { kind: "BUILDER_REPAIR", failureFingerprint: "b1", allowed: true },
      { kind: "BUILDER_REPAIR", failureFingerprint: "b2", allowed: true },
    ];
    const result = evaluateRetry({ kind: "BUILDER_REPAIR", failureFingerprint: "b3" }, history, budgets);
    expect(result.allowed).toBe(false);
    expect(result.reasonCode).toBe("TOTAL_BUILDER_BUDGET_EXHAUSTED");
  });
});
