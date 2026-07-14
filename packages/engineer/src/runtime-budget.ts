import { z } from "zod";
import type { TaskManifest } from "./contracts.js";

export const RUNTIME_BUDGET_POLICY_VERSION = "runtime-budget-v1" as const;
export const BUDGET_WARNING_RATIO = 0.8;
export const DEFAULT_RUN_ARTIFACT_BUDGET_BYTES = 50_000_000;

/** Official OpenAI list pricing captured 2026-07-14; versioned so old cost evidence remains reproducible. */
export const OPENAI_GPT56_PRICING_2026_07_14 = {
  version: "openai-gpt56-pricing-2026-07-14",
  currency: "USD",
  longContextThresholdInputTokens: 272_000,
  longContextInputMultiplier: 2,
  longContextOutputMultiplier: 1.5,
  cacheWriteInputMultiplier: 1.25,
  perMillionTokens: {
    "gpt-5.6-sol": { input: 5, cachedInput: 0.5, output: 30 },
    "gpt-5.6-terra": { input: 2.5, cachedInput: 0.25, output: 15 },
    "gpt-5.6-luna": { input: 1, cachedInput: 0.1, output: 6 },
  },
} as const;

export function estimateGpt56CostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
  details: { cachedInputTokens?: number; cacheWriteInputTokens?: number } = {},
): number {
  const cachedInputTokens = details.cachedInputTokens ?? 0;
  const cacheWriteInputTokens = details.cacheWriteInputTokens ?? 0;
  if ([inputTokens, outputTokens, cachedInputTokens, cacheWriteInputTokens].some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new TypeError("model token usage must be non-negative safe integers");
  }
  if (cachedInputTokens + cacheWriteInputTokens > inputTokens) {
    throw new TypeError("cached and cache-write tokens cannot exceed total input tokens");
  }
  const price = OPENAI_GPT56_PRICING_2026_07_14.perMillionTokens[
    model as keyof typeof OPENAI_GPT56_PRICING_2026_07_14.perMillionTokens
  ];
  if (!price) throw new Error(`no versioned model price for ${model}`);
  const uncachedInputTokens = inputTokens - cachedInputTokens - cacheWriteInputTokens;
  const inputCost = uncachedInputTokens * price.input + cachedInputTokens * price.cachedInput +
    cacheWriteInputTokens * price.input * OPENAI_GPT56_PRICING_2026_07_14.cacheWriteInputMultiplier;
  const longContext = inputTokens > OPENAI_GPT56_PRICING_2026_07_14.longContextThresholdInputTokens;
  return (
    inputCost * (longContext ? OPENAI_GPT56_PRICING_2026_07_14.longContextInputMultiplier : 1) +
    outputTokens * price.output * (longContext ? OPENAI_GPT56_PRICING_2026_07_14.longContextOutputMultiplier : 1)
  ) / 1_000_000;
}

export const RunBudgetUsageSchema = z.object({
  elapsedSeconds: z.number().nonnegative(),
  modelCalls: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  estimatedCostUsd: z.number().nonnegative(),
  costKnown: z.boolean(),
  longestCommandSeconds: z.number().nonnegative(),
  diffLines: z.number().int().nonnegative(),
  artifactBytes: z.number().int().nonnegative(),
  activeAgents: z.number().int().nonnegative(),
}).strict();

export type RunBudgetUsage = z.infer<typeof RunBudgetUsageSchema>;

export const RuntimeResourceLimitsSchema = z.object({
  commandTimeBudgetSeconds: z.number().int().positive().max(86_400).default(600),
  diffBudgetLines: z.number().int().positive().max(1_000_000).default(2_000),
  artifactBudgetBytes: z.number().int().positive().max(10_000_000_000).default(DEFAULT_RUN_ARTIFACT_BUDGET_BYTES),
  maxConcurrentAgents: z.number().int().positive().max(32).default(2),
}).strict();
export type RuntimeResourceLimits = z.input<typeof RuntimeResourceLimitsSchema>;

export const RunBudgetDecisionSchema = z.object({
  policyVersion: z.literal(RUNTIME_BUDGET_POLICY_VERSION),
  status: z.enum(["WITHIN_BUDGET", "WARNING", "HARD_LIMIT"]),
  hardLimitReasons: z.array(z.string()),
  warningReasons: z.array(z.string()),
  totalTokens: z.number().int().nonnegative(),
  remainingTokens: z.number().int().nonnegative(),
  remainingCostUsd: z.number().nonnegative().nullable(),
  remainingTimeSeconds: z.number().nonnegative(),
}).strict();

export type RunBudgetDecision = z.infer<typeof RunBudgetDecisionSchema>;

export class RuntimeBudgetExhaustedError extends Error {
  readonly decision: RunBudgetDecision;

  constructor(decision: RunBudgetDecision) {
    super(`Engineer runtime budget exhausted: ${decision.hardLimitReasons.join(",")}`);
    this.name = "RuntimeBudgetExhaustedError";
    this.decision = decision;
  }
}

function ratio(used: number, limit: number): number {
  if (limit === 0) return used === 0 ? 0 : Number.POSITIVE_INFINITY;
  return used / limit;
}

/** Pure, deterministic authority check. Unknown model pricing fails closed after the first model call. */
export function evaluateRunBudget(
  manifest: Pick<TaskManifest, "timeBudgetSeconds" | "tokenBudget" | "costBudgetUsd">,
  rawUsage: RunBudgetUsage,
  rawLimits: RuntimeResourceLimits = {},
): RunBudgetDecision {
  const usage = RunBudgetUsageSchema.parse(rawUsage);
  const limits = RuntimeResourceLimitsSchema.parse(rawLimits);
  const hardLimitReasons: string[] = [];
  const warningReasons: string[] = [];
  const totalTokens = usage.inputTokens + usage.outputTokens;
  const checks: Array<{ code: string; used: number; limit: number }> = [
    { code: "RUN_TIME", used: usage.elapsedSeconds, limit: manifest.timeBudgetSeconds },
    { code: "MODEL_TOKENS", used: totalTokens, limit: manifest.tokenBudget },
    { code: "COMMAND_TIME", used: usage.longestCommandSeconds, limit: limits.commandTimeBudgetSeconds },
    { code: "DIFF_LINES", used: usage.diffLines, limit: limits.diffBudgetLines },
    { code: "ARTIFACT_BYTES", used: usage.artifactBytes, limit: limits.artifactBudgetBytes },
    { code: "CONCURRENT_AGENTS", used: usage.activeAgents, limit: limits.maxConcurrentAgents },
  ];
  for (const check of checks) {
    const consumed = ratio(check.used, check.limit);
    const exhausted = check.code === "CONCURRENT_AGENTS" ? check.used > check.limit : consumed >= 1;
    if (exhausted) hardLimitReasons.push(`${check.code}_BUDGET_EXHAUSTED`);
    else if (consumed >= BUDGET_WARNING_RATIO) warningReasons.push(`${check.code}_BUDGET_NEAR_EXHAUSTION`);
  }
  if (!usage.costKnown && usage.modelCalls > 0) {
    hardLimitReasons.push("MODEL_COST_ACCOUNTING_UNAVAILABLE");
  } else if (usage.costKnown) {
    const costRatio = ratio(usage.estimatedCostUsd, manifest.costBudgetUsd);
    if (costRatio >= 1) hardLimitReasons.push("MODEL_COST_BUDGET_EXHAUSTED");
    else if (costRatio >= BUDGET_WARNING_RATIO) warningReasons.push("MODEL_COST_BUDGET_NEAR_EXHAUSTION");
  }
  return RunBudgetDecisionSchema.parse({
    policyVersion: RUNTIME_BUDGET_POLICY_VERSION,
    status: hardLimitReasons.length ? "HARD_LIMIT" : warningReasons.length ? "WARNING" : "WITHIN_BUDGET",
    hardLimitReasons,
    warningReasons,
    totalTokens,
    remainingTokens: Math.max(0, manifest.tokenBudget - totalTokens),
    remainingCostUsd: usage.costKnown ? Math.max(0, manifest.costBudgetUsd - usage.estimatedCostUsd) : null,
    remainingTimeSeconds: Math.max(0, manifest.timeBudgetSeconds - usage.elapsedSeconds),
  });
}

export function assertRunBudget(
  manifest: Pick<TaskManifest, "timeBudgetSeconds" | "tokenBudget" | "costBudgetUsd">,
  usage: RunBudgetUsage,
  limits: RuntimeResourceLimits = {},
): RunBudgetDecision {
  const decision = evaluateRunBudget(manifest, usage, limits);
  if (decision.status === "HARD_LIMIT") {
    throw new RuntimeBudgetExhaustedError(decision);
  }
  return decision;
}
