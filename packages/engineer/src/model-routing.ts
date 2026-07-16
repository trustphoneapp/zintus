import type { LogicalModelTier, ModelRole } from "./contracts.js";

export const MODEL_ROUTING_POLICY_VERSION = "engineer-model-routing-v2";

/** Current fixed OpenAI tier IDs. Overrides are explicit; there is no fallback across tiers. */
export const DEFAULT_MODEL_BY_TIER: Readonly<Record<LogicalModelTier, string>> = {
  "GPT-5.6_SOL": "gpt-5.6-sol",
  "GPT-5.6_TERRA": "gpt-5.6-terra",
  "GPT-5.6_LUNA": "gpt-5.6-luna",
};

/** Versioned planning metadata used to explain routing and estimate spend. */
export const MODEL_TIER_PROFILE: Readonly<Record<LogicalModelTier, { inputUsdPerMillion: number; outputUsdPerMillion: number; purpose: string }>> = {
  "GPT-5.6_SOL": { inputUsdPerMillion: 5, outputUsdPerMillion: 30, purpose: "isolated final review and explicit high-risk escalation" },
  "GPT-5.6_TERRA": { inputUsdPerMillion: 2.5, outputUsdPerMillion: 15, purpose: "planning, implementation, architecture, and security analysis" },
  "GPT-5.6_LUNA": { inputUsdPerMillion: 1, outputUsdPerMillion: 6, purpose: "high-volume classification and routine checks" },
};

export const MODEL_ROLE_TIERS: Readonly<Record<ModelRole, LogicalModelTier>> = {
  PLANNER: "GPT-5.6_TERRA",
  // Implementation begins on Terra. Deterministic executor evidence and the
  // isolated Sol Reviewer remain the authority; routine read/edit/test loops
  // must not pay Sol prices by default.
  BUILDER: "GPT-5.6_TERRA",
  // Test execution is deterministic and the model only summarizes structured
  // results; keep this high-volume role on the cost-sensitive tier.
  TESTER: "GPT-5.6_LUNA",
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

export function routingPurposeForRole(role: ModelRole): string {
  return MODEL_TIER_PROFILE[modelTierForRole(role)].purpose;
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
