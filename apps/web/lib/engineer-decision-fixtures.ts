import type { EngineerDecisionItem } from "./engineer-decisions";

const createdAt = "2026-07-14T12:00:00.000Z";

export const ASK_NOW_DECISION_FIXTURE: EngineerDecisionItem = {
  decisionId: "decision-auth-storage",
  question: "Where should the new provider credential be stored?",
  classification: "ASK_NOW",
  reasonCodes: ["SECRETS_HANDLING", "NO_SAFE_DEFAULT"],
  selectionMode: "EXCLUSIVE",
  options: [
    { optionId: "managed-vault", label: "Managed vault", impact: "Stores the credential in the managed secrets boundary.", reversibility: "REVERSIBLE", riskTier: "MEDIUM", recommended: true },
    { optionId: "local-keychain", label: "Local keychain", impact: "Limits use to this workstation and its signed-in user.", reversibility: "REVERSIBLE", riskTier: "MEDIUM", recommended: false },
  ],
  recommendedOptionId: "managed-vault",
  status: "OPEN",
  createdAt,
};

export const DEFER_DECISION_FIXTURE: EngineerDecisionItem = {
  decisionId: "decision-follow-up-docs",
  question: "Which non-blocking follow-up material should be included?",
  classification: "DEFER",
  reasonCodes: ["NON_BLOCKING_PRODUCT_CHOICE"],
  selectionMode: "COMBINABLE",
  options: [
    { optionId: "runbook", label: "Operations runbook", impact: "Adds recovery and support guidance for operators.", reversibility: "REVERSIBLE", riskTier: "LOW", recommended: true },
    { optionId: "release-notes", label: "Release notes", impact: "Adds a concise customer-facing behavior summary.", reversibility: "REVERSIBLE", riskTier: "LOW", recommended: false },
  ],
  recommendedOptionId: "runbook",
  status: "OPEN",
  createdAt,
};

export const AUTO_DECISION_FIXTURE: EngineerDecisionItem = {
  decisionId: "decision-test-reporter",
  question: "Which existing test reporter should this run use?",
  classification: "AUTO",
  reasonCodes: ["SAFE_DOCUMENTED_DEFAULT", "REVERSIBLE_WITHIN_SCOPE"],
  selectionMode: "EXCLUSIVE",
  options: [
    { optionId: "repository-default", label: "Repository default", impact: "Uses the reporter already documented by the repository.", reversibility: "REVERSIBLE", riskTier: "LOW", recommended: true },
    { optionId: "verbose", label: "Verbose reporter", impact: "Produces more output without changing test behavior.", reversibility: "REVERSIBLE", riskTier: "LOW", recommended: false },
  ],
  recommendedOptionId: "repository-default",
  status: "RESOLVED",
  selectedOptionId: "repository-default",
  createdAt,
};

export const ENGINEER_DECISION_FIXTURES = [
  ASK_NOW_DECISION_FIXTURE,
  DEFER_DECISION_FIXTURE,
  AUTO_DECISION_FIXTURE,
] as const;
