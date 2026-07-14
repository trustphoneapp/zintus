import { z } from "zod";
import { PlanningAnalysisSchema } from "./contracts.js";
import { ContextWarningSchema } from "./context-contracts.js";
import { DecisionFactorsSchema, type DecisionFactors } from "./decision-contracts.js";
import { sha256 } from "./hash.js";

export const DECISION_FEATURE_POLICY_VERSION = "decision-feature-policy-v1" as const;

const IdentifierSchema = z.string().min(1).max(200);
const HashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

const FACTOR_NAMES = [
  "affectsMustCriterion", "changesScope", "affectsAuthentication", "affectsAuthorization",
  "handlesSecrets", "requiresMigration", "changesPublicApi", "destructiveAction",
  "externalSideEffect", "changesBudget", "noSafeDefault", "safeDocumentedDefault",
  "reversible", "withinFrozenScope", "raisesRisk", "riskFloorRequiresHuman",
] as const;

const MATCH_RULES = [
  "MUST_IMPACT", "SCOPE_BOUNDARY", "AUTHENTICATION", "AUTHORIZATION", "SECRETS",
  "MIGRATION", "PUBLIC_API", "DESTRUCTIVE_ACTION", "EXTERNAL_SIDE_EFFECT", "BUDGET",
  "NO_SAFE_DEFAULT_TEXT", "NONREVERSIBLE_ASSUMPTION", "LOW_CONFIDENCE_ASSUMPTION",
  "UNRESOLVED_QUESTION", "PROMPT_INJECTION_WARNING", "CONTEXT_INCOMPLETE_WARNING",
] as const;

const DecisionFactorNameSchema = z.enum(FACTOR_NAMES);
const DecisionFeatureRuleSchema = z.enum(MATCH_RULES);

const DecisionFeatureInputSchema = z.object({
  runId: IdentifierSchema,
  planningAnalysis: PlanningAnalysisSchema,
  contextWarnings: z.array(ContextWarningSchema).max(2_010),
}).strict().superRefine((input, context) => {
  if (input.contextWarnings.some((warning) => warning.runId !== input.runId)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "cross-run context warning rejected", path: ["contextWarnings"] });
  }
});

const DecisionFeatureMatchSchema = z.object({
  sourceId: IdentifierSchema,
  sourceKind: z.enum(["PLANNER_ASSUMPTION", "PLANNER_QUESTION", "CONTEXT_WARNING"]),
  sourceTrust: z.enum(["UNTRUSTED_MODEL_OUTPUT", "UNTRUSTED_REPOSITORY", "TRUSTED_GIT_METADATA"]),
  sourceHash: HashSchema,
  rules: z.array(DecisionFeatureRuleSchema).min(1).max(MATCH_RULES.length),
  raisedFactors: z.array(DecisionFactorNameSchema).max(FACTOR_NAMES.length),
}).strict();

const ExtractionContentObject = z.object({
  policyVersion: z.literal(DECISION_FEATURE_POLICY_VERSION),
  runId: IdentifierSchema,
  factors: DecisionFactorsSchema,
  matches: z.array(DecisionFeatureMatchSchema).max(2_100),
  repositoryCanGrantAuto: z.literal(false),
  trustedPolicyEvidenceRequiredForAuto: z.literal(true),
}).strict();

export const DecisionFeatureExtractionSchema = ExtractionContentObject.extend({
  extractionHash: HashSchema,
}).superRefine((record, context) => {
  const { extractionHash, ...content } = record;
  if (sha256(content) !== extractionHash) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "decision feature extraction hash mismatch", path: ["extractionHash"] });
  }
  // These fields are authority boundaries, not model predictions.
  if (record.factors.safeDocumentedDefault || record.factors.withinFrozenScope) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "untrusted planning/context input cannot grant AUTO authority", path: ["factors"] });
  }
});

export type DecisionFeatureExtraction = z.infer<typeof DecisionFeatureExtractionSchema>;

interface MutableMatch {
  sourceId: string;
  sourceKind: "PLANNER_ASSUMPTION" | "PLANNER_QUESTION" | "CONTEXT_WARNING";
  sourceTrust: "UNTRUSTED_MODEL_OUTPUT" | "UNTRUSTED_REPOSITORY" | "TRUSTED_GIT_METADATA";
  sourceHash: string;
  rules: Set<typeof MATCH_RULES[number]>;
  raisedFactors: Set<typeof FACTOR_NAMES[number]>;
}

interface TextRule {
  rule: typeof MATCH_RULES[number];
  factor: keyof DecisionFactors;
  pattern: RegExp;
  alsoRaisesRisk?: boolean;
}

const TEXT_RULES: TextRule[] = [
  { rule: "MUST_IMPACT", factor: "affectsMustCriterion", pattern: /\b(?:must|required acceptance|acceptance criterion|mandatory)\b/i },
  { rule: "SCOPE_BOUNDARY", factor: "changesScope", pattern: /\b(?:out[- ]of[- ]scope|scope change|expand(?:s|ing)? scope|new (?:service|package|component|application))\b/i },
  { rule: "AUTHENTICATION", factor: "affectsAuthentication", pattern: /\b(?:authentication|authenticate|login|log-in|sign-in|oauth|passkey|session cookie)\b/i, alsoRaisesRisk: true },
  { rule: "AUTHORIZATION", factor: "affectsAuthorization", pattern: /\b(?:authorization|authorise|authorize|permission|access control|rbac|role boundary)\b/i, alsoRaisesRisk: true },
  { rule: "SECRETS", factor: "handlesSecrets", pattern: /\b(?:secret|credential|api key|private key|access token|refresh token|\.env)\b/i, alsoRaisesRisk: true },
  { rule: "MIGRATION", factor: "requiresMigration", pattern: /\b(?:migration|migrate|database schema|schema change|backfill|new (?:table|column)|alter table)\b/i, alsoRaisesRisk: true },
  { rule: "PUBLIC_API", factor: "changesPublicApi", pattern: /\b(?:public api|api contract|breaking change|public endpoint|sdk interface|webhook contract)\b/i, alsoRaisesRisk: true },
  { rule: "DESTRUCTIVE_ACTION", factor: "destructiveAction", pattern: /\b(?:drop table|truncate|delete (?:all|data|records)|destroy|purge|overwrite|irreversible)\b/i, alsoRaisesRisk: true },
  { rule: "EXTERNAL_SIDE_EFFECT", factor: "externalSideEffect", pattern: /\b(?:deploy|publish|send (?:email|message)|third[- ]party|external service|network call|create (?:a )?(?:pr|pull request)|push to|production)\b/i, alsoRaisesRisk: true },
  { rule: "BUDGET", factor: "changesBudget", pattern: /\b(?:budget|cost cap|spend limit|token limit|time limit|billing)\b/i },
  { rule: "NO_SAFE_DEFAULT_TEXT", factor: "noSafeDefault", pattern: /\b(?:no safe default|cannot proceed|blocking decision|requires? (?:the )?user|need(?:s)? clarification|must ask)\b/i },
];

const INCOMPLETE_WARNING_CODES = new Set([
  "SOURCE_FILE_CAP_REACHED", "RELEVANT_FILE_CAP_REACHED", "EXCERPT_CAP_REACHED",
  "SYMLINK_SKIPPED", "OVERSIZED_FILE_SKIPPED", "BINARY_FILE_SKIPPED", "UNSAFE_PATH_SKIPPED",
  "SCRIPT_CAP_REACHED", "DETECTION_CAP_REACHED",
]);

function emptyFactors(): DecisionFactors {
  return DecisionFactorsSchema.parse({
    affectsMustCriterion: false,
    changesScope: false,
    affectsAuthentication: false,
    affectsAuthorization: false,
    handlesSecrets: false,
    requiresMigration: false,
    changesPublicApi: false,
    destructiveAction: false,
    externalSideEffect: false,
    changesBudget: false,
    noSafeDefault: false,
    // Untrusted Planner/repository data can only raise floors. These two AUTO
    // prerequisites must come later from an authoritative policy/default store.
    safeDocumentedDefault: false,
    reversible: false,
    withinFrozenScope: false,
    raisesRisk: false,
    riskFloorRequiresHuman: false,
  });
}

function applyTextRules(match: MutableMatch, text: string, factors: DecisionFactors): void {
  for (const candidate of TEXT_RULES) {
    if (!candidate.pattern.test(text)) continue;
    match.rules.add(candidate.rule);
    match.raisedFactors.add(candidate.factor);
    factors[candidate.factor] = true;
    if (candidate.alsoRaisesRisk) {
      factors.raisesRisk = true;
      match.raisedFactors.add("raisesRisk");
    }
  }
}

function finalizeMatch(match: MutableMatch) {
  return DecisionFeatureMatchSchema.parse({
    ...match,
    rules: [...match.rules].sort(),
    raisedFactors: [...match.raisedFactors].sort(),
  });
}

export function extractDecisionFactors(rawInput: z.input<typeof DecisionFeatureInputSchema>): DecisionFeatureExtraction {
  const input = DecisionFeatureInputSchema.parse(rawInput);
  const factors = emptyFactors();
  const matches: Array<z.infer<typeof DecisionFeatureMatchSchema>> = [];

  for (const assumption of [...input.planningAnalysis.assumptions].sort((a, b) => a.assumptionId.localeCompare(b.assumptionId, "en"))) {
    const match: MutableMatch = {
      sourceId: assumption.assumptionId,
      sourceKind: "PLANNER_ASSUMPTION",
      sourceTrust: "UNTRUSTED_MODEL_OUTPUT",
      sourceHash: sha256({ statement: assumption.statement, sourceRefs: assumption.sourceRefs, confidence: assumption.confidence, reversible: assumption.reversible }),
      rules: new Set(),
      raisedFactors: new Set(),
    };
    applyTextRules(match, assumption.statement, factors);
    if (!assumption.reversible) {
      match.rules.add("NONREVERSIBLE_ASSUMPTION");
      match.raisedFactors.add("noSafeDefault");
      factors.noSafeDefault = true;
    }
    if (assumption.confidence < 0.8) match.rules.add("LOW_CONFIDENCE_ASSUMPTION");
    if (match.rules.size > 0) matches.push(finalizeMatch(match));
  }

  for (const question of [...input.planningAnalysis.unresolvedQuestions].sort((a, b) => a.questionId.localeCompare(b.questionId, "en"))) {
    const match: MutableMatch = {
      sourceId: question.questionId,
      sourceKind: "PLANNER_QUESTION",
      sourceTrust: "UNTRUSTED_MODEL_OUTPUT",
      sourceHash: sha256({ question: question.question, impact: question.impact, sourceRefs: question.sourceRefs }),
      rules: new Set(["UNRESOLVED_QUESTION"]),
      raisedFactors: new Set(),
    };
    applyTextRules(match, `${question.question}\n${question.impact}`, factors);
    matches.push(finalizeMatch(match));
  }

  for (const warning of [...input.contextWarnings].sort((a, b) => a.warningId.localeCompare(b.warningId, "en"))) {
    const match: MutableMatch = {
      sourceId: warning.warningId,
      sourceKind: "CONTEXT_WARNING",
      sourceTrust: warning.trust === "UNTRUSTED_REPOSITORY_CONTENT" ? "UNTRUSTED_REPOSITORY" : "TRUSTED_GIT_METADATA",
      sourceHash: sha256({ code: warning.code, path: warning.path, sourceId: warning.sourceId, trust: warning.trust, message: warning.message }),
      rules: new Set(),
      raisedFactors: new Set(),
    };
    if (warning.code === "PROMPT_INJECTION_SUSPECTED") {
      match.rules.add("PROMPT_INJECTION_WARNING");
      match.raisedFactors.add("raisesRisk");
      match.raisedFactors.add("riskFloorRequiresHuman");
      factors.raisesRisk = true;
      factors.riskFloorRequiresHuman = true;
    } else if (INCOMPLETE_WARNING_CODES.has(warning.code)) {
      match.rules.add("CONTEXT_INCOMPLETE_WARNING");
      match.raisedFactors.add("noSafeDefault");
      factors.noSafeDefault = true;
    }
    if (match.rules.size > 0) matches.push(finalizeMatch(match));
  }

  const content = ExtractionContentObject.parse({
    policyVersion: DECISION_FEATURE_POLICY_VERSION,
    runId: input.runId,
    factors,
    matches: matches.sort((a, b) => a.sourceKind.localeCompare(b.sourceKind, "en") || a.sourceId.localeCompare(b.sourceId, "en")),
    repositoryCanGrantAuto: false,
    trustedPolicyEvidenceRequiredForAuto: true,
  });
  return DecisionFeatureExtractionSchema.parse({ ...content, extractionHash: sha256(content) });
}
