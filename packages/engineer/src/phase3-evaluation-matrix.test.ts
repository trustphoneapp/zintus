import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { MANDATORY_PHASE3_EVALUATION_MATRIX, Phase3EvaluationMatrixSchema } from "./phase3-evaluation-matrix.js";

describe("Phase 3 mandatory evaluation matrix", () => {
  test("is hash-bound and every mandatory scenario names an executable test", () => {
    expect(Phase3EvaluationMatrixSchema.parse(MANDATORY_PHASE3_EVALUATION_MATRIX))
      .toEqual(MANDATORY_PHASE3_EVALUATION_MATRIX);
    const source = readFileSync(new URL("./verification.test.ts", import.meta.url), "utf8");
    for (const scenario of MANDATORY_PHASE3_EVALUATION_MATRIX.scenarios) {
      expect(source).toContain(`test("${scenario.testName}"`);
    }
    expect(new Set(MANDATORY_PHASE3_EVALUATION_MATRIX.scenarios.map((scenario) => scenario.scenarioId)).size)
      .toBe(MANDATORY_PHASE3_EVALUATION_MATRIX.scenarios.length);
  });
});
