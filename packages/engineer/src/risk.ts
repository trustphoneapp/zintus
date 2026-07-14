import {
  RiskFeaturesSchema,
  type RiskFeatures,
  type RiskTier,
} from "./contracts.js";

export const RISK_POLICY_VERSION = "risk-policy-v1";

export interface RiskPolicyOptions {
  autoApproveLowRisk: boolean;
  minimumCoveragePercent: number;
  largeDiffLines: number;
}

export interface RiskDecision {
  riskTier: RiskTier;
  humanGateRequired: boolean;
  ruleVersion: typeof RISK_POLICY_VERSION;
  matchedRules: string[];
  features: RiskFeatures;
}

const tierRank: Record<RiskTier, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };

export function assessRisk(
  input: RiskFeatures,
  options: Partial<RiskPolicyOptions> = {},
): RiskDecision {
  const features = RiskFeaturesSchema.parse(input);
  const policy: RiskPolicyOptions = {
    autoApproveLowRisk: options.autoApproveLowRisk ?? false,
    minimumCoveragePercent: options.minimumCoveragePercent ?? 70,
    largeDiffLines: options.largeDiffLines ?? 500,
  };
  const matches: Array<{ tier: RiskTier; rule: string }> = [];
  const add = (tier: RiskTier, rule: string, when: boolean) => {
    if (when) matches.push({ tier, rule });
  };

  add("CRITICAL", "SECRET_EXPOSURE", features.exposesSecrets);
  add("CRITICAL", "RUNNER_COMPROMISE", features.suspectedRunnerCompromise);
  add("CRITICAL", "CRITICAL_SECURITY_FINDING", features.highestSecuritySeverity === "CRITICAL");
  add("CRITICAL", "DESTRUCTIVE_PRODUCTION_OPERATION", features.destructiveProductionOperation);
  add("CRITICAL", "PRIVILEGE_ESCALATION", features.privilegeEscalation);

  add("HIGH", "AUTHENTICATION_CHANGE", features.touchesAuthentication);
  add("HIGH", "AUTHORIZATION_CHANGE", features.touchesAuthorization);
  add("HIGH", "PAYMENT_CHANGE", features.touchesPayments);
  add("HIGH", "DATABASE_MIGRATION", features.changesDatabaseSchema);
  add("HIGH", "INFRASTRUCTURE_CHANGE", features.changesInfrastructure);
  add("HIGH", "SECRET_ACCESS", features.accessesSecrets);
  add("HIGH", "HIGH_SECURITY_FINDING", features.highestSecuritySeverity === "HIGH");
  add("HIGH", "SENSITIVE_FILES", features.sensitiveFilesChanged);

  add("MEDIUM", "FUNCTIONAL_CODE_CHANGE", !features.documentationOnly && features.diffLines > 0);
  add("MEDIUM", "DEPENDENCY_CHANGE", features.changesDependencies);
  add("MEDIUM", "PUBLIC_API_CHANGE", features.changesPublicApi);
  add("MEDIUM", "EXTERNAL_SERVICE_DEPENDENCY", features.dependsOnExternalService);
  add("MEDIUM", "OPEN_WARNINGS", features.unresolvedWarnings > 0);
  add("MEDIUM", "REVIEWER_DISAGREEMENT", features.reviewerDisagreement);
  add("MEDIUM", "RETRIED_CHANGE", features.retryCount > 0);
  add("MEDIUM", "LARGE_DIFF", features.diffLines >= policy.largeDiffLines);
  add("MEDIUM", "GENERATED_CODE_MAJORITY", features.generatedCodePercent > 50);
  add("MEDIUM", "UNVERIFIED_COVERAGE", !features.documentationOnly && features.testCoveragePercent === null);
  add(
    "MEDIUM",
    "LOW_COVERAGE",
    features.testCoveragePercent !== null && features.testCoveragePercent < policy.minimumCoveragePercent,
  );
  add("MEDIUM", "MEDIUM_SECURITY_FINDING", features.highestSecuritySeverity === "MEDIUM");

  if (matches.length === 0) matches.push({ tier: "LOW", rule: "LOW_RISK_NON_FUNCTIONAL_CHANGE" });
  const riskTier = matches.reduce<RiskTier>(
    (highest, match) => (tierRank[match.tier]! > tierRank[highest]! ? match.tier : highest),
    "LOW",
  );
  const lowAutoApprovalEligible =
    riskTier === "LOW" &&
    policy.autoApproveLowRisk &&
    features.documentationOnly &&
    features.requiredChecksPassed &&
    features.unresolvedWarnings === 0 &&
    features.highestSecuritySeverity === "NONE";

  return {
    riskTier,
    humanGateRequired: !lowAutoApprovalEligible,
    ruleVersion: RISK_POLICY_VERSION,
    matchedRules: matches.map((match) => match.rule),
    features,
  };
}
