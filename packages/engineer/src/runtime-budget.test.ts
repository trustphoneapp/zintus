import { describe, expect, test } from "bun:test";
import { TaskManifestContentSchema, TaskManifestSchema } from "./contracts.js";
import { sha256 } from "./hash.js";
import { assertRunBudget, estimateGpt56CostUsd, evaluateRunBudget, OPENAI_GPT56_PRICING_2026_07_14 } from "./runtime-budget.js";

const content = TaskManifestContentSchema.parse({
    manifestVersion: 1, runId: "budget-run",
    repository: { repositoryId: "repo", provider: "local", owner: "o", name: "n", baseBranch: "main", baseCommitSha: "a".repeat(40) },
    request: { original: "change", normalized: "change" },
    acceptanceCriteria: [{ criterionId: "c1", statement: "works", verificationMethod: "test", priority: "MUST" }],
    testPlan: [{ testId: "t1", criterionIds: ["c1"], type: "UNIT", description: "test", command: "bun test" }],
    allowedPaths: ["src/**"], deniedPaths: [".git/**"], allowedCommands: ["bun test"], prohibitedCommands: [],
    riskTier: "MEDIUM", humanGateRequired: true, retryBudgets: {}, timeBudgetSeconds: 100,
    tokenBudget: 1_000, costBudgetUsd: 2, createdAt: "2026-07-14T00:00:00.000Z",
});
const manifest = TaskManifestSchema.parse({
  ...content,
  manifestHash: sha256(content),
});
const limits = { commandTimeBudgetSeconds: 20, diffBudgetLines: 100, artifactBudgetBytes: 1_000, maxConcurrentAgents: 2 };

const usage = (overrides = {}) => ({
  elapsedSeconds: 10, modelCalls: 0, inputTokens: 100, outputTokens: 100,
  estimatedCostUsd: 0, costKnown: true, longestCommandSeconds: 2, diffLines: 10,
  artifactBytes: 100, activeAgents: 1, ...overrides,
});

describe("authoritative runtime budgets", () => {
  test("reports every remaining budget while safely within limits", () => {
    expect(evaluateRunBudget(manifest, usage(), limits)).toMatchObject({
      status: "WITHIN_BUDGET", totalTokens: 200, remainingTokens: 800,
      remainingCostUsd: 2, remainingTimeSeconds: 90,
    });
  });

  test("warns at eighty percent without silently stopping", () => {
    expect(evaluateRunBudget(manifest, usage({ elapsedSeconds: 80, inputTokens: 400, outputTokens: 400 }), limits)).toMatchObject({
      status: "WARNING", warningReasons: expect.arrayContaining(["RUN_TIME_BUDGET_NEAR_EXHAUSTION", "MODEL_TOKENS_BUDGET_NEAR_EXHAUSTION"]),
    });
  });

  test("hard-stops each bounded resource independently", () => {
    for (const [field, value, reason] of [
      ["elapsedSeconds", 100, "RUN_TIME_BUDGET_EXHAUSTED"], ["inputTokens", 1_000, "MODEL_TOKENS_BUDGET_EXHAUSTED"],
      ["longestCommandSeconds", 20, "COMMAND_TIME_BUDGET_EXHAUSTED"], ["diffLines", 100, "DIFF_LINES_BUDGET_EXHAUSTED"],
      ["artifactBytes", 1_000, "ARTIFACT_BYTES_BUDGET_EXHAUSTED"], ["activeAgents", 3, "CONCURRENT_AGENTS_BUDGET_EXHAUSTED"],
    ] as const) {
      const decision = evaluateRunBudget(manifest, usage({ [field]: value }), limits);
      expect(decision.hardLimitReasons).toContain(reason);
      expect(() => assertRunBudget(manifest, usage({ [field]: value }), limits)).toThrow("runtime budget exhausted");
    }
  });

  test("allows the configured concurrent-agent maximum but rejects the next agent", () => {
    expect(evaluateRunBudget(manifest, usage({ activeAgents: 2 }), limits).hardLimitReasons).not.toContain("CONCURRENT_AGENTS_BUDGET_EXHAUSTED");
    expect(evaluateRunBudget(manifest, usage({ activeAgents: 3 }), limits).hardLimitReasons).toContain("CONCURRENT_AGENTS_BUDGET_EXHAUSTED");
  });

  test("unknown pricing fails closed after a model call and known cost is bounded", () => {
    expect(evaluateRunBudget(manifest, usage({ modelCalls: 1, costKnown: false }), limits).hardLimitReasons)
      .toContain("MODEL_COST_ACCOUNTING_UNAVAILABLE");
    expect(evaluateRunBudget(manifest, usage({ modelCalls: 1, estimatedCostUsd: 2 }), limits).hardLimitReasons)
      .toContain("MODEL_COST_BUDGET_EXHAUSTED");
  });

  test("uses the versioned SOL/TERRA/LUNA catalog and rejects unknown or malformed usage", () => {
    expect(OPENAI_GPT56_PRICING_2026_07_14.version).toBe("openai-gpt56-pricing-2026-07-14");
    expect(estimateGpt56CostUsd("gpt-5.6-sol", 1_000_000, 1_000_000)).toBe(55);
    expect(estimateGpt56CostUsd("gpt-5.6-terra", 1_000_000, 1_000_000)).toBe(27.5);
    expect(estimateGpt56CostUsd("gpt-5.6-luna", 1_000_000, 1_000_000)).toBe(11);
    expect(estimateGpt56CostUsd("gpt-5.6-sol", 1_000_000, 0, { cachedInputTokens: 1_000_000 })).toBe(1);
    expect(estimateGpt56CostUsd("gpt-5.6-luna", 1_000, 0, { cacheWriteInputTokens: 1_000 })).toBe(0.00125);
    expect(estimateGpt56CostUsd("gpt-5.6-luna", 272_001, 100)).toBeCloseTo((272_001 * 2 + 100 * 6 * 1.5) / 1_000_000, 8);
    expect(() => estimateGpt56CostUsd("gpt-5.6-luna", 1, 1, { cachedInputTokens: 2 })).toThrow("cannot exceed");
    expect(() => estimateGpt56CostUsd("unknown", 1, 1)).toThrow("no versioned model price");
    expect(() => estimateGpt56CostUsd("gpt-5.6-luna", -1, 1)).toThrow("non-negative safe integers");
  });
});
