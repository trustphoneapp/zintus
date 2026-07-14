import { describe, expect, test } from "bun:test";
import { executionFailureDomain, operationalFailurePolicy } from "./failure-policy.js";

describe("complete operational failure policy", () => {
  test("covers every operational domain with a durable class, reason, and retry decision", () => {
    expect([
      "EXECUTION", "DEPENDENCY", "GIT", "PUBLICATION", "TIMEOUT", "CANCELLATION",
    ].map((domain) => operationalFailurePolicy(domain as Parameters<typeof operationalFailurePolicy>[0]))).toEqual([
      { failureClass: "IMPLEMENTATION_FAILURE", reasonCode: "EXECUTION_FAILED", retryable: true },
      { failureClass: "DEPENDENCY_FAILURE", reasonCode: "DEPENDENCY_UNAVAILABLE", retryable: true },
      { failureClass: "GIT_FAILURE", reasonCode: "GIT_OPERATION_FAILED", retryable: true },
      { failureClass: "WORKFLOW_FAILURE", reasonCode: "PUBLICATION_FAILED", retryable: true },
      { failureClass: "HUMAN_GATE_FAILURE", reasonCode: "HUMAN_APPROVAL_TIMEOUT", retryable: false },
      { failureClass: "WORKFLOW_FAILURE", reasonCode: "CANCELLATION_CLEANUP_FAILED", retryable: false },
    ]);
  });

  test("dependency failures cannot be disguised by workflow stage", () => {
    expect(executionFailureDomain("IMPLEMENTING", new Error("Cannot find module x"))).toBe("DEPENDENCY");
    expect(executionFailureDomain("IMPLEMENTING", new Error("builder rejected patch"))).toBe("EXECUTION");
  });
});
