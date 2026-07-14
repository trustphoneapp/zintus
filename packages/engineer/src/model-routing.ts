import type { LogicalModelTier, ModelRole } from "./contracts.js";

export const MODEL_ROUTING_POLICY_VERSION = "engineer-model-routing-v1";

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
