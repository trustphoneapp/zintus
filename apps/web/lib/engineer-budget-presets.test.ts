import { describe, expect, test } from "bun:test";
import {
  ENGINEER_BUDGET_CHIPS,
  ENGINEER_BUDGET_PRESETS,
  engineerBudgetPreset,
  formatEngineerTokenLimit,
  recommendedEngineerBudgetPresetIndex,
} from "./engineer-budget-presets";

describe("Engineer compact budget presets", () => {
  test("maps every slider position to an independently scaled valid server budget", () => {
    expect(ENGINEER_BUDGET_PRESETS.map((preset) => preset.limits)).toEqual([
      { costBudgetUsd: 1, tokenBudget: 40_000, timeBudgetSeconds: 600 },
      { costBudgetUsd: 2, tokenBudget: 75_000, timeBudgetSeconds: 900 },
      { costBudgetUsd: 5, tokenBudget: 300_000, timeBudgetSeconds: 3_600 },
      { costBudgetUsd: 15, tokenBudget: 600_000, timeBudgetSeconds: 5_400 },
      { costBudgetUsd: 50, tokenBudget: 900_000, timeBudgetSeconds: 9_000 },
      { costBudgetUsd: 100, tokenBudget: 1_000_000, timeBudgetSeconds: 14_400 },
    ]);
    expect(ENGINEER_BUDGET_PRESETS.every((preset) => preset.limits.costBudgetUsd <= 100)).toBe(true);
    expect(ENGINEER_BUDGET_PRESETS.every((preset) => preset.limits.tokenBudget <= 1_000_000)).toBe(true);
    expect(ENGINEER_BUDGET_PRESETS.every((preset) => preset.limits.timeBudgetSeconds <= 86_400)).toBe(true);
  });

  test("keeps chips, clamping, recommendations, and readouts deterministic", () => {
    expect(ENGINEER_BUDGET_CHIPS.map((chip) => engineerBudgetPreset(chip.presetIndex).label)).toEqual([
      "Small task", "Recommended", "Large refactor", "Maximum local",
    ]);
    expect(engineerBudgetPreset(-20).limits.costBudgetUsd).toBe(1);
    expect(engineerBudgetPreset(20).limits.costBudgetUsd).toBe(100);
    expect(recommendedEngineerBudgetPresetIndex("small copy fix")).toBe(1);
    expect(recommendedEngineerBudgetPresetIndex("security auth database webhook migration")).toBe(3);
    expect(formatEngineerTokenLimit(75_000)).toBe("75k");
    expect(formatEngineerTokenLimit(1_000_000)).toBe("1M");
  });
});
