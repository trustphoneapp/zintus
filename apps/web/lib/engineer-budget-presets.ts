import type { EngineerBudgetLimits } from "./engineer";

export interface EngineerBudgetPreset {
  id: "small" | "recommended" | "standard" | "refactor" | "extended" | "maximum";
  label: string;
  tickLabel: string;
  limits: EngineerBudgetLimits;
}

/**
 * Presets stay inside the Supervisor's initial/lifetime contract: $100,
 * 1,000,000 tokens, and 24 hours. Tokens deliberately do not scale linearly
 * with dollars; recent local runs were context-heavy but inexpensive.
 */
export const ENGINEER_BUDGET_PRESETS: readonly EngineerBudgetPreset[] = Object.freeze([
  { id: "small", label: "Small task", tickLabel: "$1", limits: { costBudgetUsd: 1, tokenBudget: 40_000, timeBudgetSeconds: 600 } },
  { id: "recommended", label: "Lean task", tickLabel: "$2", limits: { costBudgetUsd: 2, tokenBudget: 75_000, timeBudgetSeconds: 900 } },
  { id: "standard", label: "Recommended", tickLabel: "$5", limits: { costBudgetUsd: 5, tokenBudget: 300_000, timeBudgetSeconds: 3_600 } },
  { id: "refactor", label: "Large refactor", tickLabel: "$15", limits: { costBudgetUsd: 15, tokenBudget: 600_000, timeBudgetSeconds: 5_400 } },
  { id: "extended", label: "Extended", tickLabel: "$50", limits: { costBudgetUsd: 50, tokenBudget: 900_000, timeBudgetSeconds: 9_000 } },
  { id: "maximum", label: "Maximum local", tickLabel: "$100", limits: { costBudgetUsd: 100, tokenBudget: 1_000_000, timeBudgetSeconds: 14_400 } },
]);

export const ENGINEER_BUDGET_CHIPS = Object.freeze([
  { label: "Small task", presetIndex: 0 },
  { label: "Recommended", presetIndex: 2 },
  { label: "Large refactor", presetIndex: 3 },
  { label: "Maximum local", presetIndex: 5 },
]);

export function engineerBudgetPreset(index: number): EngineerBudgetPreset {
  const bounded = Math.min(ENGINEER_BUDGET_PRESETS.length - 1, Math.max(0, Math.round(index)));
  return ENGINEER_BUDGET_PRESETS[bounded]!;
}

export function recommendedEngineerBudgetPresetIndex(request: string): number {
  const riskTerms = /\b(auth|security|crypt|migration|database|distributed|architecture|payment|permission|webhook)\b/gi;
  const riskMatches = request.match(riskTerms)?.length ?? 0;
  if (request.length > 2_000 || riskMatches >= 3) return 3;
  if (request.length < 500 && riskMatches === 0) return 1;
  return 2;
}

export function formatEngineerTokenLimit(tokens: number): string {
  if (tokens >= 1_000_000) return `${tokens / 1_000_000}M`;
  return `${Math.round(tokens / 1_000)}k`;
}
