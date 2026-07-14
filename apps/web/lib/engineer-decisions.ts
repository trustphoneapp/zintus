export type EngineerDecisionClassification = "ASK_NOW" | "DEFER" | "AUTO";
export type EngineerDecisionRiskTier = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type EngineerDecisionReversibility = "REVERSIBLE" | "PARTIALLY_REVERSIBLE" | "IRREVERSIBLE";

export interface EngineerDecisionOption {
  optionId: string;
  label: string;
  impact: string;
  reversibility: EngineerDecisionReversibility;
  riskTier: EngineerDecisionRiskTier;
  recommended: boolean;
}

export interface EngineerDecisionItem {
  decisionId: string;
  question: string;
  classification: EngineerDecisionClassification;
  reasonCodes: string[];
  options: EngineerDecisionOption[];
  recommendedOptionId: string;
  status: "OPEN" | "RESOLVED";
  selectedOptionId?: string | null;
  createdAt: string;
  /**
   * This field is an explicit assertion from the trusted decision projection.
   * Missing metadata is treated as exclusive so the UI never infers that
   * independently authored choices can safely be combined.
   */
  selectionMode?: "EXCLUSIVE" | "COMBINABLE";
}

export interface PresentedDecisionOption extends EngineerDecisionOption {
  synthetic?: "ALL_OF_THE_ABOVE";
}

export const ALL_OF_THE_ABOVE_OPTION_ID = "__all_compatible_options__";

const PRESENTATION: Record<EngineerDecisionClassification, {
  label: string;
  summary: string;
  tone: "blocking" | "deferred" | "automatic";
}> = {
  ASK_NOW: {
    label: "Needs your answer now",
    summary: "Work is paused until a human resolves this decision.",
    tone: "blocking",
  },
  DEFER: {
    label: "Saved for final review",
    summary: "Work can continue, but this remains a human task at the end of the run.",
    tone: "deferred",
  },
  AUTO: {
    label: "Applied automatically",
    summary: "The Supervisor selected the documented, reversible, in-scope default.",
    tone: "automatic",
  },
};

export function getDecisionPresentation(classification: EngineerDecisionClassification) {
  return PRESENTATION[classification];
}

/**
 * "All of the above" is fail-closed. It appears only when the decision
 * projection explicitly says the options are compatible, every choice is
 * reversible, and adding it keeps the presentation within the 2–3 option UX.
 */
export function canSelectAllOptions(decision: EngineerDecisionItem): boolean {
  return decision.selectionMode === "COMBINABLE"
    && decision.classification !== "AUTO"
    && decision.options.length === 2
    && new Set(decision.options.map((option) => option.optionId)).size === decision.options.length
    && decision.options.every((option) => option.reversibility !== "IRREVERSIBLE");
}

export function getPresentedDecisionOptions(decision: EngineerDecisionItem): PresentedDecisionOption[] {
  if (!canSelectAllOptions(decision)) return decision.options;

  return [...decision.options, {
    optionId: ALL_OF_THE_ABOVE_OPTION_ID,
    label: "All of the above",
    impact: decision.options.map((option) => option.impact).join(" "),
    reversibility: decision.options.some((option) => option.reversibility === "PARTIALLY_REVERSIBLE")
      ? "PARTIALLY_REVERSIBLE"
      : "REVERSIBLE",
    riskTier: highestRiskTier(decision.options.map((option) => option.riskTier)),
    recommended: false,
    synthetic: "ALL_OF_THE_ABOVE",
  }];
}

export function validateDecisionForPresentation(decision: EngineerDecisionItem): EngineerDecisionItem {
  if (!decision.decisionId.trim() || !decision.question.trim()) throw new Error("decision identity and question are required");
  if (decision.options.length < 2 || decision.options.length > 3) throw new Error("decisions must contain 2–3 options");

  const optionIds = decision.options.map((option) => option.optionId);
  if (optionIds.some((optionId) => !optionId.trim()) || new Set(optionIds).size !== optionIds.length) {
    throw new Error("decision option IDs must be non-empty and unique");
  }
  if (decision.options.some((option) => !option.label.trim() || !option.impact.trim())) {
    throw new Error("decision options require concise labels and impacts");
  }

  const recommended = decision.options.filter((option) => option.recommended);
  if (recommended.length !== 1 || recommended[0]?.optionId !== decision.recommendedOptionId) {
    throw new Error("decision must identify exactly one matching recommended option");
  }

  if (decision.selectedOptionId
    && decision.selectedOptionId !== ALL_OF_THE_ABOVE_OPTION_ID
    && !optionIds.includes(decision.selectedOptionId)) {
    throw new Error("selected decision option is not present");
  }
  if (decision.selectedOptionId === ALL_OF_THE_ABOVE_OPTION_ID && !canSelectAllOptions(decision)) {
    throw new Error("all-of-the-above selection is not semantically valid");
  }
  return decision;
}

export function getDeferredHumanTaskSummary(decisions: EngineerDecisionItem[]) {
  const tasks = decisions
    .filter((decision) => decision.classification === "DEFER" && decision.status === "OPEN")
    .map((decision) => ({
      decisionId: decision.decisionId,
      question: decision.question,
      recommendedOption: decision.options.find((option) => option.optionId === decision.recommendedOptionId)?.label ?? "Review required",
    }));

  return { count: tasks.length, tasks };
}

function highestRiskTier(riskTiers: EngineerDecisionRiskTier[]): EngineerDecisionRiskTier {
  const rank: Record<EngineerDecisionRiskTier, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };
  return riskTiers.reduce((highest, current) => rank[current] > rank[highest] ? current : highest, "LOW");
}
