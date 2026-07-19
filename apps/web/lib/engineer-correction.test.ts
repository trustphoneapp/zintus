import { describe, expect, test } from "bun:test";
import { engineerCorrectionRecovery } from "./engineer-correction";

describe("Engineer corrected-run presentation", () => {
  test("offers a corrected run only for gateway-derivable structured evidence", () => {
    expect(engineerCorrectionRecovery("FAILED", [{ status: "OPEN" }], [])).toBe("corrected-run");
    expect(engineerCorrectionRecovery("FAILED", [], [{ failureClass: "TEST_FAILURE", reasonCode: "STABLE_REQUIRED_TEST_FAILED" }])).toBe("corrected-run");
    expect(engineerCorrectionRecovery("VERIFICATION_INCOMPLETE", [], [{ failureClass: "WORKFLOW_FAILURE", reasonCode: "VERIFICATION_EVIDENCE_MISSING" }])).toBe("corrected-run");
  });

  test("routes unstructured terminal failures to a bounded new request", () => {
    expect(engineerCorrectionRecovery("FAILED", [], [{ failureClass: "DEPENDENCY_FAILURE", reasonCode: "BUILDER_NO_PROGRESS" }])).toBe("new-bounded-run");
    expect(engineerCorrectionRecovery("FAILED", [{ status: "CLOSED" }], [])).toBe("new-bounded-run");
  });

  test("does not offer recovery actions for unrelated states", () => {
    expect(engineerCorrectionRecovery("COMPLETED", [{ status: "OPEN" }], [])).toBeNull();
    expect(engineerCorrectionRecovery("IMPLEMENTING", [], [{ failureClass: "TEST_FAILURE" }])).toBeNull();
  });
});
