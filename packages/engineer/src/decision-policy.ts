export const DECISION_POLICY_VERSION = "decision-policy-v1" as const;

export type DecisionClassification = "ASK_NOW" | "DEFER" | "AUTO";

export interface DecisionFactorSet {
  affectsMustCriterion: boolean;
  changesScope: boolean;
  affectsAuthentication: boolean;
  affectsAuthorization: boolean;
  handlesSecrets: boolean;
  requiresMigration: boolean;
  changesPublicApi: boolean;
  destructiveAction: boolean;
  externalSideEffect: boolean;
  changesBudget: boolean;
  noSafeDefault: boolean;
  safeDocumentedDefault: boolean;
  reversible: boolean;
  withinFrozenScope: boolean;
  raisesRisk: boolean;
  riskFloorRequiresHuman: boolean;
}

export const DECISION_REASON_CODES = [
  "MUST_CRITERION",
  "SCOPE_CHANGE",
  "AUTHENTICATION",
  "AUTHORIZATION",
  "SECRETS",
  "MIGRATION",
  "PUBLIC_API",
  "DESTRUCTIVE_ACTION",
  "EXTERNAL_SIDE_EFFECT",
  "BUDGET_CHANGE",
  "NO_SAFE_DEFAULT",
  "RISK_FLOOR",
  "RISK_INCREASE",
  "SAFE_DOCUMENTED_DEFAULT",
  "DEFERRED_NON_BLOCKING",
] as const;

export type DecisionReasonCode = typeof DECISION_REASON_CODES[number];

const ASK_NOW_FLOORS: ReadonlyArray<readonly [keyof DecisionFactorSet, DecisionReasonCode]> = [
  ["affectsMustCriterion", "MUST_CRITERION"],
  ["changesScope", "SCOPE_CHANGE"],
  ["affectsAuthentication", "AUTHENTICATION"],
  ["affectsAuthorization", "AUTHORIZATION"],
  ["handlesSecrets", "SECRETS"],
  ["requiresMigration", "MIGRATION"],
  ["changesPublicApi", "PUBLIC_API"],
  ["destructiveAction", "DESTRUCTIVE_ACTION"],
  ["externalSideEffect", "EXTERNAL_SIDE_EFFECT"],
  ["changesBudget", "BUDGET_CHANGE"],
  ["noSafeDefault", "NO_SAFE_DEFAULT"],
  ["riskFloorRequiresHuman", "RISK_FLOOR"],
  ["raisesRisk", "RISK_INCREASE"],
];

export function classifyDecisionFactors(factors: DecisionFactorSet): {
  classification: DecisionClassification;
  reasonCodes: DecisionReasonCode[];
} {
  const floors = ASK_NOW_FLOORS.filter(([factor]) => factors[factor]).map(([, reason]) => reason);
  if (floors.length > 0) return { classification: "ASK_NOW", reasonCodes: floors };

  const safeAuto = factors.safeDocumentedDefault && factors.reversible && factors.withinFrozenScope &&
    !factors.raisesRisk && !factors.externalSideEffect && !factors.affectsMustCriterion && !factors.changesScope;
  if (safeAuto) return { classification: "AUTO", reasonCodes: ["SAFE_DOCUMENTED_DEFAULT"] };

  return { classification: "DEFER", reasonCodes: ["DEFERRED_NON_BLOCKING"] };
}
