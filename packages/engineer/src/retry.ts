import type { RetryBudgets, RetryKind } from "./contracts.js";

export const RETRY_POLICY_VERSION = "retry-policy-v2";

export interface RetryHistoryItem {
  kind: RetryKind;
  failureFingerprint: string;
  patchHash?: string | null;
  progressMetric?: number | null;
  allowed: boolean;
}

export interface RetryRequest {
  kind: RetryKind;
  failureFingerprint: string;
  patchHash?: string | null;
  progressMetric?: number | null;
}

export interface RetryDecision {
  allowed: boolean;
  reasonCode:
    | "RETRY_ALLOWED"
    | "KIND_BUDGET_EXHAUSTED"
    | "TOTAL_BUILDER_BUDGET_EXHAUSTED"
    | "SAME_FAILURE_LIMIT_REACHED"
    | "IDENTICAL_PATCH_REPEATED"
    | "NO_MEASURABLE_PROGRESS";
  attemptNumber: number;
  remainingKindAttempts: number;
  policyVersion: typeof RETRY_POLICY_VERSION;
}

function kindBudget(kind: RetryKind, budgets: RetryBudgets): number {
  switch (kind) {
    case "BUILDER_REPAIR": return budgets.builderRepairAttempts;
    case "REVIEWER_FIX": return budgets.reviewerFixAttempts;
    case "PLANNER_RESTART": return budgets.plannerRestarts;
    case "SANDBOX_PROVISIONING": return budgets.sandboxProvisioningAttempts;
    case "TRANSIENT_MODEL": return budgets.transientModelAttempts;
  }
  throw new TypeError(`unsupported retry kind: ${kind satisfies never}`);
}

export function evaluateRetry(
  request: RetryRequest,
  history: readonly RetryHistoryItem[],
  budgets: RetryBudgets,
): RetryDecision {
  const priorKind = history.filter((item) => item.allowed && item.kind === request.kind);
  const attemptNumber = priorKind.length + 1;
  const budget = kindBudget(request.kind, budgets);
  const result = (allowed: boolean, reasonCode: RetryDecision["reasonCode"]): RetryDecision => ({
    allowed,
    reasonCode,
    attemptNumber,
    remainingKindAttempts: Math.max(0, budget - (allowed ? attemptNumber : priorKind.length)),
    policyVersion: RETRY_POLICY_VERSION,
  });

  if (priorKind.length >= budget) return result(false, "KIND_BUDGET_EXHAUSTED");

  if (request.kind === "BUILDER_REPAIR" || request.kind === "REVIEWER_FIX") {
    const totalBuilderAttempts = history.filter(
      (item) => item.allowed && (item.kind === "BUILDER_REPAIR" || item.kind === "REVIEWER_FIX"),
    ).length;
    if (totalBuilderAttempts >= budgets.builderRepairAttempts) {
      return result(false, "TOTAL_BUILDER_BUDGET_EXHAUSTED");
    }
  }

  const sameFailure = history.filter(
    (item) => item.allowed && item.failureFingerprint === request.failureFingerprint,
  );
  if (sameFailure.length >= budgets.sameFailureAttempts) {
    return result(false, "SAME_FAILURE_LIMIT_REACHED");
  }

  const last = [...history].reverse().find((item) => item.allowed);
  // An unchanged patch is conclusive no-progress evidence only when the same
  // failure recurs. A later isolated review may legitimately discover a new,
  // independently fingerprinted defect in the same candidate snapshot.
  if (request.patchHash && last?.patchHash === request.patchHash &&
      last.failureFingerprint === request.failureFingerprint) {
    return result(false, "IDENTICAL_PATCH_REPEATED");
  }
  if (
    request.progressMetric !== null &&
    request.progressMetric !== undefined &&
    last?.progressMetric !== null &&
    last?.progressMetric !== undefined &&
    request.progressMetric <= last.progressMetric &&
    last.failureFingerprint === request.failureFingerprint
  ) {
    return result(false, "NO_MEASURABLE_PROGRESS");
  }

  return result(true, "RETRY_ALLOWED");
}
