import type { LogicalModelTier } from "./contracts.js";

export const ENGINEER_PRICING_VERSION = "openai-5.6-routing-2026-07-15";

/** USD per one million tokens. Kept central so reservations and settlement cannot disagree. */
export const ENGINEER_MODEL_PRICING: Readonly<Record<LogicalModelTier, { input: number; output: number }>> = {
  "GPT-5.6_SOL": { input: 5, output: 30 },
  "GPT-5.6_TERRA": { input: 2.5, output: 15 },
  "GPT-5.6_LUNA": { input: 1, output: 6 },
};

export function estimateModelCostUsd(tier: LogicalModelTier, inputTokens: number, outputTokens: number): number {
  const price = ENGINEER_MODEL_PRICING[tier];
  const value = (Math.max(0, inputTokens) * price.input + Math.max(0, outputTokens) * price.output) / 1_000_000;
  return Number(value.toFixed(8));
}
