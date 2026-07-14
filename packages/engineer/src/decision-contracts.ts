import { z } from "zod";
import { RiskTierSchema } from "./contracts.js";
import {
  DECISION_POLICY_VERSION,
  DECISION_REASON_CODES,
  classifyDecisionFactors,
} from "./decision-policy.js";
import { sha256 } from "./hash.js";

const IdentifierSchema = z.string().min(1).max(200);
const HashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const TimestampSchema = z.string().datetime({ offset: true });

export const DecisionClassificationSchema = z.enum(["ASK_NOW", "DEFER", "AUTO"]);
export const DecisionReasonCodeSchema = z.enum(DECISION_REASON_CODES);

export const DecisionFactorsSchema = z.object({
  affectsMustCriterion: z.boolean(),
  changesScope: z.boolean(),
  affectsAuthentication: z.boolean(),
  affectsAuthorization: z.boolean(),
  handlesSecrets: z.boolean(),
  requiresMigration: z.boolean(),
  changesPublicApi: z.boolean(),
  destructiveAction: z.boolean(),
  externalSideEffect: z.boolean(),
  changesBudget: z.boolean(),
  noSafeDefault: z.boolean(),
  safeDocumentedDefault: z.boolean(),
  reversible: z.boolean(),
  withinFrozenScope: z.boolean(),
  raisesRisk: z.boolean(),
  riskFloorRequiresHuman: z.boolean(),
}).strict().superRefine((factors, context) => {
  if (factors.noSafeDefault && factors.safeDocumentedDefault) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "a decision cannot both lack and have a safe documented default" });
  }
});

export const DecisionEvidenceReferenceSchema = z.object({
  evidenceId: IdentifierSchema,
  runId: IdentifierSchema,
  sourceType: z.enum(["USER_REQUEST", "CONTEXT_SOURCE", "POLICY", "RISK_ASSESSMENT", "ARTIFACT", "HUMAN_RESPONSE"]),
  trust: z.enum(["TRUSTED_SYSTEM", "TRUSTED_HUMAN", "UNTRUSTED_REPOSITORY"]),
  summary: z.string().min(1).max(2_000),
}).strict();

export const DecisionOptionSchema = z.object({
  optionId: IdentifierSchema,
  label: z.string().min(1).max(500),
  impact: z.string().min(1).max(4_000),
  reversibility: z.enum(["REVERSIBLE", "PARTIALLY_REVERSIBLE", "IRREVERSIBLE"]),
  riskTier: RiskTierSchema,
  sourceEvidenceIds: z.array(IdentifierSchema).min(1).max(20),
  recommended: z.boolean(),
}).strict();

const DecisionRecordContentObject = z.object({
  decisionId: IdentifierSchema,
  runId: IdentifierSchema,
  question: z.string().min(1).max(4_000),
  classification: DecisionClassificationSchema,
  reasonCodes: z.array(DecisionReasonCodeSchema).min(1).max(DECISION_REASON_CODES.length),
  factors: DecisionFactorsSchema,
  options: z.array(DecisionOptionSchema).min(2).max(3),
  recommendedOptionId: IdentifierSchema,
  sourceEvidence: z.array(DecisionEvidenceReferenceSchema).min(1).max(50),
  policyVersion: z.literal(DECISION_POLICY_VERSION),
  requestedState: z.string().min(1).max(100),
  resumeAction: z.enum(["NONE", "PLAN", "REPLAN"]),
  status: z.literal("OPEN"),
  idempotencyKey: z.string().min(1).max(500),
  createdAt: TimestampSchema,
}).strict();

function validateDecisionContent(
  record: z.infer<typeof DecisionRecordContentObject>,
  context: z.RefinementCtx,
): void {
  const expected = classifyDecisionFactors(record.factors);
  if (record.classification !== expected.classification) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "decision classification violates deterministic policy", path: ["classification"] });
  }
  if (JSON.stringify(record.reasonCodes) !== JSON.stringify(expected.reasonCodes)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "decision reason codes violate deterministic policy", path: ["reasonCodes"] });
  }
  const optionIds = new Set(record.options.map((option) => option.optionId));
  if (optionIds.size !== record.options.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "decision option IDs must be unique", path: ["options"] });
  }
  const recommended = record.options.filter((option) => option.recommended);
  if (recommended.length !== 1 || recommended[0]?.optionId !== record.recommendedOptionId) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "exactly one option must be recommended and match recommendedOptionId", path: ["recommendedOptionId"] });
  }
  const evidenceIds = new Set(record.sourceEvidence.map((evidence) => evidence.evidenceId));
  if (evidenceIds.size !== record.sourceEvidence.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "decision evidence IDs must be unique", path: ["sourceEvidence"] });
  }
  for (const evidence of record.sourceEvidence) {
    if (evidence.runId !== record.runId) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "cross-run decision evidence rejected", path: ["sourceEvidence"] });
    }
  }
  for (const option of record.options) {
    if (option.sourceEvidenceIds.some((id) => !evidenceIds.has(id))) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "decision option references unknown evidence", path: ["options"] });
    }
  }
  if (record.classification === "ASK_NOW" && record.resumeAction === "NONE") {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "ASK_NOW requires a plan or replan resume action", path: ["resumeAction"] });
  }
  if (record.classification !== "ASK_NOW" && record.resumeAction !== "NONE") {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "only ASK_NOW may interrupt planning", path: ["resumeAction"] });
  }
  if (record.classification === "AUTO") {
    const option = record.options.find((candidate) => candidate.optionId === record.recommendedOptionId);
    if (option?.riskTier !== "LOW" || option.reversibility !== "REVERSIBLE") {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "AUTO requires a LOW-risk reversible recommended option", path: ["recommendedOptionId"] });
    }
    const policyEvidence = record.sourceEvidence.some((evidence) =>
      evidence.sourceType === "POLICY" && evidence.trust === "TRUSTED_SYSTEM");
    if (!policyEvidence) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "AUTO requires trusted documented policy evidence", path: ["sourceEvidence"] });
    }
    if (record.sourceEvidence.some((evidence) => evidence.trust === "UNTRUSTED_REPOSITORY")) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "untrusted repository evidence cannot authorize AUTO", path: ["sourceEvidence"] });
    }
  }
}

export const DecisionRecordContentSchema = DecisionRecordContentObject.superRefine(validateDecisionContent);

export const DecisionRecordSchema = DecisionRecordContentObject.extend({
  decisionHash: HashSchema,
}).superRefine((record, context) => {
  const { decisionHash, ...content } = record;
  validateDecisionContent(content, context);
  if (sha256(content) !== decisionHash) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "decision hash mismatch", path: ["decisionHash"] });
  }
});

const DecisionResolutionContentObject = z.object({
  resolutionId: IdentifierSchema,
  decisionId: IdentifierSchema,
  runId: IdentifierSchema,
  selectedOptionId: IdentifierSchema,
  actorType: z.enum(["HUMAN", "SUPERVISOR"]),
  actorId: IdentifierSchema,
  rationale: z.string().min(1).max(10_000),
  sourceEvidence: z.array(DecisionEvidenceReferenceSchema).min(1).max(50),
  policyVersion: z.literal(DECISION_POLICY_VERSION),
  status: z.literal("RESOLVED"),
  idempotencyKey: z.string().min(1).max(500),
  resolvedAt: TimestampSchema,
}).strict();

export const DecisionResolutionContentSchema = DecisionResolutionContentObject.superRefine((resolution, context) => {
  for (const evidence of resolution.sourceEvidence) {
    if (evidence.runId !== resolution.runId) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "cross-run resolution evidence rejected", path: ["sourceEvidence"] });
    }
  }
});

export const DecisionResolutionSchema = DecisionResolutionContentObject.extend({
  resolutionHash: HashSchema,
}).superRefine((resolution, context) => {
  const { resolutionHash, ...content } = resolution;
  const parsed = DecisionResolutionContentSchema.safeParse(content);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) context.addIssue(issue);
  }
  if (sha256(content) !== resolutionHash) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "resolution hash mismatch", path: ["resolutionHash"] });
  }
});

export type DecisionFactors = z.infer<typeof DecisionFactorsSchema>;
export type DecisionEvidenceReference = z.infer<typeof DecisionEvidenceReferenceSchema>;
export type DecisionOption = z.infer<typeof DecisionOptionSchema>;
export type DecisionRecordContent = z.infer<typeof DecisionRecordContentSchema>;
export type DecisionRecord = z.infer<typeof DecisionRecordSchema>;
export type DecisionResolutionContent = z.infer<typeof DecisionResolutionContentSchema>;
export type DecisionResolution = z.infer<typeof DecisionResolutionSchema>;
