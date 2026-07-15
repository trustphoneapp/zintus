import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { MANDATORY_PHASE56_EVALUATION_MATRIX, Phase56EvaluationMatrixSchema } from "./phase56-evaluation-matrix.js";

describe("Phase 5/6 mandatory evaluation harness", () => {
  test("is hash-bound and maps every hardening scenario to an executable test", () => {
    expect(Phase56EvaluationMatrixSchema.parse(MANDATORY_PHASE56_EVALUATION_MATRIX)).toEqual(MANDATORY_PHASE56_EVALUATION_MATRIX);
    for (const scenario of MANDATORY_PHASE56_EVALUATION_MATRIX.scenarios) {
      const gatewayTest = scenario.testFile === "engineer.test.ts" || scenario.testFile === "handler.test.ts";
      const source = readFileSync(new URL(gatewayTest ? `../../../apps/gateway/src/${scenario.testFile}` : `./${scenario.testFile}`, import.meta.url), "utf8");
      expect(source).toContain(`test("${scenario.testName}"`);
    }
  });
});
