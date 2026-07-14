import type { FailureRecord } from "./control-contracts.js";

export const OPERATIONAL_FAILURE_POLICY_VERSION = "operational-failure-v1" as const;

export type OperationalFailureDomain =
  | "EXECUTION"
  | "DEPENDENCY"
  | "GIT"
  | "PUBLICATION"
  | "TIMEOUT"
  | "CANCELLATION";

const POLICY: Record<OperationalFailureDomain, Pick<FailureRecord, "failureClass" | "reasonCode" | "retryable">> = {
  EXECUTION: { failureClass: "IMPLEMENTATION_FAILURE", reasonCode: "EXECUTION_FAILED", retryable: true },
  DEPENDENCY: { failureClass: "DEPENDENCY_FAILURE", reasonCode: "DEPENDENCY_UNAVAILABLE", retryable: true },
  GIT: { failureClass: "GIT_FAILURE", reasonCode: "GIT_OPERATION_FAILED", retryable: true },
  PUBLICATION: { failureClass: "WORKFLOW_FAILURE", reasonCode: "PUBLICATION_FAILED", retryable: true },
  TIMEOUT: { failureClass: "HUMAN_GATE_FAILURE", reasonCode: "HUMAN_APPROVAL_TIMEOUT", retryable: false },
  CANCELLATION: { failureClass: "WORKFLOW_FAILURE", reasonCode: "CANCELLATION_CLEANUP_FAILED", retryable: false },
};

/** Deterministic floor; error text is evidence for fingerprinting, never classification authority. */
export function operationalFailurePolicy(domain: OperationalFailureDomain):
  Pick<FailureRecord, "failureClass" | "reasonCode" | "retryable"> {
  return { ...POLICY[domain] };
}

export function executionFailureDomain(_state: string, error: unknown): "EXECUTION" | "DEPENDENCY" {
  const message = error instanceof Error ? error.message : String(error);
  if (/\b(?:dependency|dependencies|module not found|cannot find module|lockfile|install|package manager)\b/i.test(message)) {
    return "DEPENDENCY";
  }
  return "EXECUTION";
}
