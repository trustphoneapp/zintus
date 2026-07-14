import type { LogicalModelTier, ModelRole } from "./contracts.js";

export const MODEL_ROUTING_POLICY_VERSION = "engineer-model-routing-v1";

/** Current fixed OpenAI tier IDs. Overrides are explicit; there is no fallback across tiers. */
export const DEFAULT_MODEL_BY_TIER: Readonly<Record<LogicalModelTier, string>> = {
  "GPT-5.6_SOL": "gpt-5.6-sol",
  "GPT-5.6_TERRA": "gpt-5.6-terra",
  "GPT-5.6_LUNA": "gpt-5.6-luna",
};

export const MODEL_ROLE_TIERS: Readonly<Record<ModelRole, LogicalModelTier>> = {
  PLANNER: "GPT-5.6_TERRA",
  BUILDER: "GPT-5.6_SOL",
  TESTER: "GPT-5.6_TERRA",
  SECURITY: "GPT-5.6_TERRA",
  REVIEWER: "GPT-5.6_SOL",
  ARCHITECTURE_ANALYSIS: "GPT-5.6_TERRA",
  REQUEST_CLASSIFIER: "GPT-5.6_LUNA",
  FAILURE_CLASSIFIER: "GPT-5.6_LUNA",
  RISK_FEATURE_EXTRACTOR: "GPT-5.6_LUNA",
  DOCS: "GPT-5.6_LUNA",
  SYNTHESIS_FORMATTER: "GPT-5.6_LUNA",
};

export function modelTierForRole(role: ModelRole): LogicalModelTier {
  const tier = MODEL_ROLE_TIERS[role];
  if (!tier) throw new TypeError(`unsupported Engineer model role: ${role}`);
  return tier;
}

export interface EngineerModelConfiguration {
  sol?: string;
  terra?: string;
  luna?: string;
}

export interface ResolvedEngineerModel {
  provider: "openai";
  role: ModelRole;
  logicalTier: LogicalModelTier;
  model: string;
  policyVersion: typeof MODEL_ROUTING_POLICY_VERSION;
}

export function resolveEngineerModel(
  role: ModelRole,
  configuration: EngineerModelConfiguration = {},
): ResolvedEngineerModel {
  const logicalTier = modelTierForRole(role);
  const configured = logicalTier === "GPT-5.6_SOL"
    ? configuration.sol
    : logicalTier === "GPT-5.6_TERRA"
      ? configuration.terra
      : configuration.luna;
  const model = configured ?? DEFAULT_MODEL_BY_TIER[logicalTier];
  if (!model.trim()) throw new TypeError(`model for ${logicalTier} must not be empty`);
  return {
    provider: "openai",
    role,
    logicalTier,
    model,
    policyVersion: MODEL_ROUTING_POLICY_VERSION,
  };
}
