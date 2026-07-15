import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { MANDATORY_PHASE4_EVALUATION_MATRIX, Phase4EvaluationMatrixSchema } from "./phase4-evaluation-matrix.js";

describe("Phase 4 mandatory evaluation matrix", () => {
  test("is hash-bound and maps every adversarial scenario to an executable test", () => {
    expect(Phase4EvaluationMatrixSchema.parse(MANDATORY_PHASE4_EVALUATION_MATRIX)).toEqual(MANDATORY_PHASE4_EVALUATION_MATRIX);
    for (const scenario of MANDATORY_PHASE4_EVALUATION_MATRIX.scenarios) {
      const gatewayTest = scenario.testFile === "engineer.test.ts" || scenario.testFile === "handler.test.ts";
      const source = readFileSync(new URL(gatewayTest ? `../../../apps/gateway/src/${scenario.testFile}` : `./${scenario.testFile}`, import.meta.url), "utf8");
      expect(source).toContain(`test("${scenario.testName}"`);
    }
  });
});
