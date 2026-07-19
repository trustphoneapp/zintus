import { z } from "zod";
import { TaskManifestSchema, type TaskManifest } from "./contracts.js";
import { canonicalJson, sha256 } from "./hash.js";
import { isManifestPathAllowed } from "./manifest-files.js";
import { IN_TOTO_STATEMENT_TYPE, type CheckpointAttestor } from "./verified-candidate-checkpoint.js";
import { MODEL_ROUTING_POLICY_VERSION } from "./model-routing.js";
import { OPENAI_GPT56_PRICING_2026_07_14 } from "./runtime-budget.js";
import {
  CODEX_BUILDER_PROMPT_VERSION,
  estimateResponseInputTokens,
  inputTokenCountRequest,
} from "./codex-builder.js";
import { REVIEWER_POLICY_VERSION } from "./isolated-reviewer.js";
import { HARDENING_CACHE_ACCOUNTING_VERSION, HARDENING_PROMPT_CACHE_POLICY_VERSION } from "./required-lane-policy-versions.js";
export { HARDENING_CACHE_ACCOUNTING_VERSION, HARDENING_PROMPT_CACHE_POLICY_VERSION } from "./required-lane-policy-versions.js";

export const ADVISORY_BACKLOG_POLICY_VERSION = "engineer-advisory-backlog-v1";
export const HARDENING_ESTIMATE_POLICY_VERSION = "engineer-hardening-estimate-v1";
export const HARDENING_ESTIMATE_POLICY_VERSION_V2 = "engineer-hardening-estimate-v2";
export const HARDENING_CONSENT_POLICY_VERSION = "engineer-hardening-consent-v1";
export const HARDENING_LINEAGE_POLICY_VERSION = "engineer-hardening-lineage-v1";
export const CANDIDATE_LINEAGE_POLICY_VERSION = "engineer-candidate-lineage-v1";
export const PUBLICATION_SELECTION_POLICY_VERSION = "engineer-publication-selection-v1";
export const HARDENING_ESTIMATOR_VERSION = "deterministic-hardening-estimator-v1";
export const HARDENING_ESTIMATOR_VERSION_V2 = "deterministic-hardening-estimator-v2";
export const HARDENING_QUOTE_SIZING_POLICY_VERSION = "engineer-hardening-quote-sizing-authority-v1";
export const HARDENING_LOCAL_INPUT_COUNTER_VERSION = "response-input-byte-upper-bound-v1";
export const CANDIDATE_LINEAGE_PREDICATE_TYPE = "https://zintus.dev/attestations/candidate-lineage/v1";

const IdentifierSchema = z.string().min(1).max(200);
const HashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const CommitSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const TimestampSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine((value) => Number.isFinite(Date.parse(value)), "timestamp must be a real UTC millisecond instant");
const MoneySchema = z.number().int().min(0).max(100_000_000);
const PositiveMoneySchema = z.number().int().min(1).max(100_000_000);
const TokenSchema = z.number().int().min(0).max(1_000_000);
const PositiveTokenSchema = z.number().int().min(1).max(1_000_000);
const TimeSchema = z.number().int().min(1).max(86_400);
const AdvisoryActionabilitySchema = z.enum(["ACTIONABLE", "AUDIT_ONLY"]);
const CandidateKindSchema = z.enum(["PARENT", "HARDENED_CHILD"]);
const codeUnitCompare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;

function sortedUnique(values: readonly string[], context: z.RefinementCtx, path: string): void {
  const sorted = [...values].sort(codeUnitCompare);
  if (values.length !== new Set(values).size || values.some((value, index) => value !== sorted[index])) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: `${path} must be code-unit sorted and unique`, path: [path] });
  }
}

function hashEntity<T extends object, H extends string, I extends string>(content: T, hashName: H, idName: I, namespace: string): T & Record<H | I, string> {
  const entityHash = sha256(content);
  const entityId = sha256({ namespace, [hashName]: entityHash });
  return { ...content, [hashName]: entityHash, [idName]: entityId } as T & Record<H | I, string>;
}

function verifyEntityHash(value: Record<string, unknown>, hashName: string, idName: string, namespace: string, context: z.RefinementCtx): void {
  const { [hashName]: entityHash, [idName]: entityId, ...content } = value;
  if (sha256(content) !== entityHash) context.addIssue({ code: z.ZodIssueCode.custom, message: `${hashName} does not match canonical content`, path: [hashName] });
  if (sha256({ namespace, [hashName]: entityHash }) !== entityId) context.addIssue({ code: z.ZodIssueCode.custom, message: `${idName} does not match ${hashName}`, path: [idName] });
}

const CheckpointPairFields = {
  parentCheckpointId: HashSchema,
  parentCheckpointHash: HashSchema,
} as const;

const AdvisoryBacklogItemContentObject = z.object({
  schemaVersion: z.literal(1), policyVersion: z.literal(ADVISORY_BACKLOG_POLICY_VERSION),
  parentRunId: IdentifierSchema, requesterUserId: IdentifierSchema, repositoryId: IdentifierSchema,
  ...CheckpointPairFields,
  requiredLaneContractHash: HashSchema, classificationHash: HashSchema,
  reviewerSessionId: IdentifierSchema, findingId: IdentifierSchema, findingFingerprint: HashSchema,
  sourceClassificationHash: HashSchema, disposition: z.literal("ADVISORY"),
  reasonCode: z.literal("OUTSIDE_FROZEN_REQUIRED_SCOPE"), authority: z.literal("NONE"),
  reportedSeverity: z.enum(["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"]),
  category: z.string().min(1).max(200), description: z.string().min(1).max(20_000),
  requiredChange: z.string().min(1).max(20_000), file: z.string().min(1).max(2_000).nullable(),
  lineStart: z.number().int().nonnegative().nullable(), lineEnd: z.number().int().nonnegative().nullable(),
  criterionIds: z.array(IdentifierSchema).max(30), evidenceIds: z.array(IdentifierSchema).max(100),
  actionability: AdvisoryActionabilitySchema, createdAt: TimestampSchema,
}).strict();
function validateAdvisoryBacklogItem(item: z.infer<typeof AdvisoryBacklogItemContentObject>, context: z.RefinementCtx) {
  sortedUnique(item.criterionIds, context, "criterionIds");
  sortedUnique(item.evidenceIds, context, "evidenceIds");
  if ((item.lineStart === null) !== (item.lineEnd === null) || (item.lineStart !== null && item.lineEnd! < item.lineStart)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "line bounds must be paired and ordered", path: ["lineStart"] });
  }
  if (item.actionability === "ACTIONABLE" && item.file === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "actionable advisories require a file", path: ["file"] });
  }
}
const AdvisoryBacklogItemContentSchema = AdvisoryBacklogItemContentObject.superRefine(validateAdvisoryBacklogItem);

export const AdvisoryBacklogItemSchema = AdvisoryBacklogItemContentObject.extend({
  advisoryHash: HashSchema, advisoryId: HashSchema,
}).strict().superRefine((item, context) => { validateAdvisoryBacklogItem(item, context); verifyEntityHash(item, "advisoryHash", "advisoryId", ADVISORY_BACKLOG_POLICY_VERSION, context); });

export function advisoryActionability(manifest: TaskManifest, file: string | null): z.infer<typeof AdvisoryActionabilitySchema> {
  try {
    const parsedManifest = TaskManifestSchema.parse(manifest);
    if (file === null || file.length === 0 || file.trim() !== file || file.includes("\0") || file.includes("\\") ||
        file.startsWith("/") || /^[A-Za-z]:[\\/]/.test(file)) return "AUDIT_ONLY";
    const segments = file.split("/");
    if (segments.some((segment) => segment === "" || segment === "." || segment === ".." || segment === ".git")) return "AUDIT_ONLY";
    return isManifestPathAllowed(file, parsedManifest) ? "ACTIONABLE" : "AUDIT_ONLY";
  } catch {
    return "AUDIT_ONLY";
  }
}

export function createAdvisoryBacklogItem(input: z.input<typeof AdvisoryBacklogItemContentSchema>, manifest: TaskManifest) {
  const content = AdvisoryBacklogItemContentSchema.parse(input);
  if (content.actionability !== advisoryActionability(manifest, content.file)) throw new TypeError("advisory actionability does not match the frozen manifest");
  return AdvisoryBacklogItemSchema.parse(hashEntity(content, "advisoryHash", "advisoryId", ADVISORY_BACKLOG_POLICY_VERSION));
}

const AdvisoryBacklogEventContentObject = z.object({
  schemaVersion: z.literal(1), policyVersion: z.literal(ADVISORY_BACKLOG_POLICY_VERSION),
  advisoryId: HashSchema, parentRunId: IdentifierSchema, ...CheckpointPairFields,
  eventType: z.enum(["SELECTED", "DEFERRED", "DISMISSED", "REOPENED", "HARDENING_STARTED", "HARDENING_VERIFIED", "HARDENING_STOPPED"]),
  revision: z.number().int().positive(), expectedRevision: z.number().int().nonnegative(),
  actorType: z.enum(["USER", "SYSTEM"]), actorId: IdentifierSchema,
  operationId: IdentifierSchema, idempotencyKey: IdentifierSchema,
  quoteId: HashSchema.nullable(), consentId: HashSchema.nullable(), hardeningLineageId: HashSchema.nullable(),
  childRunId: IdentifierSchema.nullable(), childCheckpointId: HashSchema.nullable(), childCheckpointHash: HashSchema.nullable(),
  stopReason: z.enum(["FAILED", "CANCELLED", "BUDGET_EXHAUSTED", "TIMED_OUT", "SECURITY_BLOCKED", "ENVIRONMENT_BLOCKED"]).nullable(),
  rationale: z.string().max(4_000).nullable(), createdAt: TimestampSchema,
}).strict();
function validateAdvisoryBacklogEvent(event: z.infer<typeof AdvisoryBacklogEventContentObject>, context: z.RefinementCtx) {
  if (event.revision !== event.expectedRevision + 1) context.addIssue({ code: z.ZodIssueCode.custom, message: "revision must equal expectedRevision + 1", path: ["revision"] });
  const hardeningRefs = [event.quoteId, event.consentId, event.hardeningLineageId, event.childRunId, event.childCheckpointId, event.childCheckpointHash, event.stopReason];
  if (event.eventType === "SELECTED" && (event.quoteId === null || hardeningRefs.slice(1).some((value) => value !== null))) context.addIssue({ code: z.ZodIssueCode.custom, message: "SELECTED requires only quoteId" });
  if (["DEFERRED", "DISMISSED", "REOPENED"].includes(event.eventType) && hardeningRefs.some((value) => value !== null)) context.addIssue({ code: z.ZodIssueCode.custom, message: `${event.eventType} cannot carry hardening references` });
  if (event.eventType === "HARDENING_STARTED" && ([event.quoteId, event.consentId, event.hardeningLineageId, event.childRunId].some((value) => value === null) || [event.childCheckpointId, event.childCheckpointHash, event.stopReason].some((value) => value !== null))) context.addIssue({ code: z.ZodIssueCode.custom, message: "HARDENING_STARTED has invalid references" });
  if (event.eventType === "HARDENING_VERIFIED" && ([event.quoteId, event.consentId, event.hardeningLineageId, event.childRunId, event.childCheckpointId, event.childCheckpointHash].some((value) => value === null) || event.stopReason !== null)) context.addIssue({ code: z.ZodIssueCode.custom, message: "HARDENING_VERIFIED has invalid references" });
  if (event.eventType === "HARDENING_STOPPED" && ([event.hardeningLineageId, event.childRunId, event.stopReason].some((value) => value === null) || [event.childCheckpointId, event.childCheckpointHash].some((value) => value !== null))) context.addIssue({ code: z.ZodIssueCode.custom, message: "HARDENING_STOPPED has invalid references" });
}
const AdvisoryBacklogEventContentSchema = AdvisoryBacklogEventContentObject.superRefine(validateAdvisoryBacklogEvent);

export const AdvisoryBacklogEventSchema = AdvisoryBacklogEventContentObject.extend({ eventHash: HashSchema, eventId: HashSchema }).strict()
  .superRefine((event, context) => { validateAdvisoryBacklogEvent(event, context); verifyEntityHash(event, "eventHash", "eventId", ADVISORY_BACKLOG_POLICY_VERSION, context); });
export function createAdvisoryBacklogEvent(input: z.input<typeof AdvisoryBacklogEventContentSchema>) {
  const content = AdvisoryBacklogEventContentSchema.parse(input);
  return AdvisoryBacklogEventSchema.parse(hashEntity(content, "eventHash", "eventId", ADVISORY_BACKLOG_POLICY_VERSION));
}

export const HardeningQuoteInputCapsSchema = z.object({
  builderInputTokens: z.number().int().positive().max(40_000),
  builderOutputTokens: z.literal(6_000),
  reviewerInputTokens: z.literal(40_000),
  reviewerOutputTokens: z.literal(12_000),
}).strict();
export const CacheWriteInputMultiplierSchema = z.object({ numerator: z.literal(5), denominator: z.literal(4) }).strict();
const HardeningEstimateV2Schema = z.object({
  maxCostMicrousd: MoneySchema, maxTokens: TokenSchema, maxTimeSeconds: TimeSchema,
  maxPlannerCalls: z.literal(0), maxBuilderCalls: z.literal(1), maxReviewerCalls: z.literal(1), automaticRepairCalls: z.literal(0),
  inputCaps: HardeningQuoteInputCapsSchema,
}).strict().superRefine((estimate, context) => {
  if (estimate.maxTokens !== Object.values(estimate.inputCaps).reduce((sum, value) => sum + value, 0)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "maxTokens must equal the four role caps", path: ["maxTokens"] });
  }
});
const HardeningEstimateAssumptionsV2Schema = z.tuple([
  z.literal("ESTIMATE_IS_HARD_CAP"), z.literal("NO_AUTOMATIC_REPAIR"), z.literal("NO_PARENT_BUDGET_TRANSFER"),
  z.literal("CACHE_HIT_NOT_ASSUMED"), z.literal("CACHE_WRITE_WORST_CASE"), z.literal("CACHE_DOES_NOT_REDUCE_TPM"),
]);

const HardeningAdvisorySizingProjectionSchema = z.object({
  advisoryId: HashSchema,
  advisoryHash: HashSchema,
  requiredChange: z.string().min(1).max(20_000),
  file: z.string().min(1).max(2_000).nullable(),
}).strict();

const HardeningQuoteSizingAuthorityContentObject = z.object({
  schemaVersion: z.literal(1),
  policyVersion: z.literal(HARDENING_QUOTE_SIZING_POLICY_VERSION),
  estimatorVersion: z.literal(HARDENING_ESTIMATOR_VERSION_V2),
  localInputCounterVersion: z.literal(HARDENING_LOCAL_INPUT_COUNTER_VERSION),
  builderPromptVersion: z.literal(CODEX_BUILDER_PROMPT_VERSION),
  reviewerPolicyVersion: z.literal(REVIEWER_POLICY_VERSION),
  cachePolicyVersion: z.literal(HARDENING_PROMPT_CACHE_POLICY_VERSION),
  cacheAccountingVersion: z.literal(HARDENING_CACHE_ACCOUNTING_VERSION),
  cacheWriteInputMultiplier: CacheWriteInputMultiplierSchema,
  parentRunId: IdentifierSchema,
  requesterUserId: IdentifierSchema,
  repositoryId: IdentifierSchema,
  ...CheckpointPairFields,
  parentManifestHash: HashSchema,
  selectionHash: HashSchema,
  advisoryIds: z.array(HashSchema).min(1).max(20),
  advisoryProjectionHash: HashSchema,
  advisoryCount: z.number().int().min(1).max(20),
  uniqueFileCount: z.number().int().min(0).max(20),
  builderSizingTemplateHash: HashSchema,
  builderSizingInputTokenUpperBound: PositiveTokenSchema,
  inputCaps: HardeningQuoteInputCapsSchema,
}).strict();

function validateHardeningQuoteSizingAuthority(
  authority: z.infer<typeof HardeningQuoteSizingAuthorityContentObject>,
  context: z.RefinementCtx,
): void {
  sortedUnique(authority.advisoryIds, context, "advisoryIds");
  if (authority.advisoryCount !== authority.advisoryIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "advisoryCount does not match advisoryIds", path: ["advisoryCount"] });
  }
  if (sha256(authority.advisoryIds) !== authority.selectionHash) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "selectionHash does not match advisoryIds", path: ["selectionHash"] });
  }
}

const HardeningQuoteSizingAuthorityContentSchema = HardeningQuoteSizingAuthorityContentObject
  .superRefine(validateHardeningQuoteSizingAuthority);

export const HardeningQuoteSizingAuthoritySchema = HardeningQuoteSizingAuthorityContentObject.extend({
  sizingAuthorityHash: HashSchema,
  sizingAuthorityId: HashSchema,
}).strict().superRefine((authority, context) => {
  validateHardeningQuoteSizingAuthority(authority, context);
  verifyEntityHash(authority, "sizingAuthorityHash", "sizingAuthorityId", HARDENING_QUOTE_SIZING_POLICY_VERSION, context);
});

export function hardeningAdvisorySizingProjection(
  advisories: readonly z.infer<typeof AdvisoryBacklogItemSchema>[],
) {
  return advisories.map((raw) => AdvisoryBacklogItemSchema.parse(raw))
    .sort((left, right) => codeUnitCompare(left.advisoryId, right.advisoryId))
    .map(({ advisoryId, advisoryHash, requiredChange, file }) =>
      HardeningAdvisorySizingProjectionSchema.parse({ advisoryId, advisoryHash, requiredChange, file }));
}

export function createHardeningQuoteSizingAuthority(
  rawInput: Omit<z.input<typeof HardeningQuoteSizingAuthorityContentSchema>,
    "advisoryProjectionHash" | "advisoryCount" | "uniqueFileCount" |
    "builderSizingTemplateHash" | "builderSizingInputTokenUpperBound">,
  advisories: readonly z.infer<typeof AdvisoryBacklogItemSchema>[],
  builderSizingTemplate: Record<string, unknown>,
) {
  const projection = hardeningAdvisorySizingProjection(advisories);
  const request = inputTokenCountRequest(builderSizingTemplate);
  const content = HardeningQuoteSizingAuthorityContentSchema.parse({
    ...rawInput,
    advisoryProjectionHash: sha256({ namespace: "engineer-hardening-quote-advisory-sizing-v1", advisories: projection }),
    advisoryCount: projection.length,
    uniqueFileCount: new Set(projection.flatMap((item) => item.file === null ? [] : [item.file])).size,
    builderSizingTemplateHash: sha256({ namespace: "engineer-hardening-builder-sizing-template-v1", request }),
    builderSizingInputTokenUpperBound: estimateResponseInputTokens(builderSizingTemplate),
  });
  if (canonicalJson(content.advisoryIds) !== canonicalJson(projection.map((item) => item.advisoryId))) {
    throw new TypeError("hardening sizing authority requires the exact advisory projection");
  }
  return HardeningQuoteSizingAuthoritySchema.parse(
    hashEntity(content, "sizingAuthorityHash", "sizingAuthorityId", HARDENING_QUOTE_SIZING_POLICY_VERSION),
  );
}

const HardeningQuoteV1ContentObject = z.object({
  schemaVersion: z.literal(1), policyVersion: z.literal(HARDENING_ESTIMATE_POLICY_VERSION), estimatorVersion: z.literal(HARDENING_ESTIMATOR_VERSION),
  parentRunId: IdentifierSchema, requesterUserId: IdentifierSchema, repositoryId: IdentifierSchema,
  ...CheckpointPairFields, parentStateVersion: z.number().int().nonnegative(),
  advisoryIds: z.array(HashSchema).min(1).max(20), selectionHash: HashSchema,
  routingPolicyVersion: z.literal(MODEL_ROUTING_POLICY_VERSION), pricingVersion: z.literal(OPENAI_GPT56_PRICING_2026_07_14.version),
  estimate: z.object({ maxCostMicrousd: MoneySchema, maxTokens: TokenSchema, maxTimeSeconds: TimeSchema,
    maxPlannerCalls: z.literal(0), maxBuilderCalls: z.literal(1), maxReviewerCalls: z.literal(1), automaticRepairCalls: z.literal(0) }).strict(),
  assumptions: z.tuple([z.literal("ESTIMATE_IS_HARD_CAP"), z.literal("NO_AUTOMATIC_REPAIR"), z.literal("NO_PARENT_BUDGET_TRANSFER")]),
  createdAt: TimestampSchema, expiresAt: TimestampSchema,
}).strict();
const HardeningQuoteV2ContentObject = z.object({
  schemaVersion: z.literal(2), policyVersion: z.literal(HARDENING_ESTIMATE_POLICY_VERSION_V2), estimatorVersion: z.literal(HARDENING_ESTIMATOR_VERSION_V2),
  parentRunId: IdentifierSchema, requesterUserId: IdentifierSchema, repositoryId: IdentifierSchema,
  ...CheckpointPairFields, parentStateVersion: z.number().int().nonnegative(),
  advisoryIds: z.array(HashSchema).min(1).max(20), selectionHash: HashSchema,
  routingPolicyVersion: z.literal(MODEL_ROUTING_POLICY_VERSION), pricingVersion: z.literal(OPENAI_GPT56_PRICING_2026_07_14.version),
  estimate: HardeningEstimateV2Schema,
  assumptions: HardeningEstimateAssumptionsV2Schema,
  sizingAuthorityId: HashSchema, sizingAuthorityHash: HashSchema,
  localInputCounterVersion: z.literal(HARDENING_LOCAL_INPUT_COUNTER_VERSION),
  builderPromptVersion: z.literal(CODEX_BUILDER_PROMPT_VERSION),
  reviewerPolicyVersion: z.literal(REVIEWER_POLICY_VERSION),
  cachePolicyVersion: z.literal(HARDENING_PROMPT_CACHE_POLICY_VERSION),
  cacheAccountingVersion: z.literal(HARDENING_CACHE_ACCOUNTING_VERSION),
  cacheWriteInputMultiplier: CacheWriteInputMultiplierSchema,
  inputCaps: HardeningQuoteInputCapsSchema,
  createdAt: TimestampSchema, expiresAt: TimestampSchema,
}).strict();

type HardeningQuoteCommon = {
  advisoryIds: string[]; selectionHash: string; createdAt: string; expiresAt: string;
};
function validateHardeningQuote(quote: HardeningQuoteCommon, context: z.RefinementCtx) {
  sortedUnique(quote.advisoryIds, context, "advisoryIds");
  if (sha256(quote.advisoryIds) !== quote.selectionHash) context.addIssue({ code: z.ZodIssueCode.custom, message: "selectionHash does not match advisoryIds", path: ["selectionHash"] });
  const duration = Date.parse(quote.expiresAt) - Date.parse(quote.createdAt);
  if (duration !== 15 * 60_000) context.addIssue({ code: z.ZodIssueCode.custom, message: "quote expiry must be exactly 15 minutes after creation", path: ["expiresAt"] });
}
const HardeningQuoteV1ContentSchema = HardeningQuoteV1ContentObject.superRefine(validateHardeningQuote);
const HardeningQuoteV2ContentSchema = HardeningQuoteV2ContentObject.superRefine(validateHardeningQuote);
export const HardeningQuoteV1Schema = HardeningQuoteV1ContentObject.extend({ quoteHash: HashSchema, quoteId: HashSchema }).strict()
  .superRefine((quote, context) => { validateHardeningQuote(quote, context); verifyEntityHash(quote, "quoteHash", "quoteId", HARDENING_ESTIMATE_POLICY_VERSION, context); });
export const HardeningQuoteV2Schema = HardeningQuoteV2ContentObject.extend({ quoteHash: HashSchema, quoteId: HashSchema }).strict()
  .superRefine((quote, context) => { validateHardeningQuote(quote, context); verifyEntityHash(quote, "quoteHash", "quoteId", HARDENING_ESTIMATE_POLICY_VERSION_V2, context); });
export const HardeningQuoteSchema = z.union([HardeningQuoteV1Schema, HardeningQuoteV2Schema]);
export function createHardeningQuote(
  input: z.input<typeof HardeningQuoteV1ContentSchema>,
  advisories: readonly z.infer<typeof AdvisoryBacklogItemSchema>[],
) {
  const content = HardeningQuoteV1ContentSchema.parse(input);
  const boundAdvisories = advisories.map((advisory) => AdvisoryBacklogItemSchema.parse(advisory));
  const boundIds = boundAdvisories.map((advisory) => advisory.advisoryId).sort(codeUnitCompare);
  if (boundAdvisories.some((advisory) => advisory.actionability !== "ACTIONABLE" ||
      advisory.parentRunId !== content.parentRunId || advisory.requesterUserId !== content.requesterUserId ||
      advisory.repositoryId !== content.repositoryId || advisory.parentCheckpointId !== content.parentCheckpointId ||
      advisory.parentCheckpointHash !== content.parentCheckpointHash) ||
      canonicalJson(boundIds) !== canonicalJson(content.advisoryIds)) {
    throw new TypeError("hardening quote requires the exact actionable advisory selection");
  }
  return HardeningQuoteV1Schema.parse(hashEntity(content, "quoteHash", "quoteId", HARDENING_ESTIMATE_POLICY_VERSION));
}

export function createHardeningQuoteV2(
  input: z.input<typeof HardeningQuoteV2ContentSchema>,
  advisories: readonly z.infer<typeof AdvisoryBacklogItemSchema>[],
  rawSizingAuthority: z.infer<typeof HardeningQuoteSizingAuthoritySchema>,
) {
  const content = HardeningQuoteV2ContentSchema.parse(input);
  const sizingAuthority = HardeningQuoteSizingAuthoritySchema.parse(rawSizingAuthority);
  const boundAdvisories = advisories.map((advisory) => AdvisoryBacklogItemSchema.parse(advisory));
  const boundIds = boundAdvisories.map((advisory) => advisory.advisoryId).sort(codeUnitCompare);
  if (boundAdvisories.some((advisory) => advisory.actionability !== "ACTIONABLE" ||
      advisory.parentRunId !== content.parentRunId || advisory.requesterUserId !== content.requesterUserId ||
      advisory.repositoryId !== content.repositoryId || advisory.parentCheckpointId !== content.parentCheckpointId ||
      advisory.parentCheckpointHash !== content.parentCheckpointHash) ||
      canonicalJson(boundIds) !== canonicalJson(content.advisoryIds)) {
    throw new TypeError("hardening quote requires the exact actionable advisory selection");
  }
  if (content.sizingAuthorityId !== sizingAuthority.sizingAuthorityId ||
      content.sizingAuthorityHash !== sizingAuthority.sizingAuthorityHash ||
      content.parentRunId !== sizingAuthority.parentRunId ||
      content.requesterUserId !== sizingAuthority.requesterUserId ||
      content.repositoryId !== sizingAuthority.repositoryId ||
      content.parentCheckpointId !== sizingAuthority.parentCheckpointId ||
      content.parentCheckpointHash !== sizingAuthority.parentCheckpointHash ||
      content.selectionHash !== sizingAuthority.selectionHash ||
      content.localInputCounterVersion !== sizingAuthority.localInputCounterVersion ||
      content.builderPromptVersion !== sizingAuthority.builderPromptVersion ||
      content.reviewerPolicyVersion !== sizingAuthority.reviewerPolicyVersion ||
      content.cachePolicyVersion !== sizingAuthority.cachePolicyVersion ||
      content.cacheAccountingVersion !== sizingAuthority.cacheAccountingVersion ||
      canonicalJson(content.cacheWriteInputMultiplier) !== canonicalJson(sizingAuthority.cacheWriteInputMultiplier) ||
      canonicalJson(content.inputCaps) !== canonicalJson(sizingAuthority.inputCaps) ||
      content.estimate.maxTokens !== Object.values(content.inputCaps).reduce((sum, value) => sum + value, 0)) {
    throw new TypeError("hardening quote does not bind the exact sizing authority");
  }
  return HardeningQuoteV2Schema.parse(hashEntity(content, "quoteHash", "quoteId", HARDENING_ESTIMATE_POLICY_VERSION_V2));
}

const HardeningConsentContentObject = z.object({
  schemaVersion: z.literal(1), policyVersion: z.literal(HARDENING_CONSENT_POLICY_VERSION),
  quoteId: HashSchema, quoteHash: HashSchema, parentRunId: IdentifierSchema, ...CheckpointPairFields,
  parentStateVersion: z.number().int().nonnegative(), selectionHash: HashSchema,
  requesterUserId: IdentifierSchema, actorId: IdentifierSchema,
  authorizedBudget: z.object({ costMicrousd: PositiveMoneySchema, tokens: PositiveTokenSchema, timeSeconds: TimeSchema }).strict(),
  acknowledgements: z.object({ separateRun: z.literal(true), parentCandidateUnchanged: z.literal(true), noAutomaticRepair: z.literal(true), noOverages: z.literal(true) }).strict(),
  idempotencyKey: IdentifierSchema, acceptedAt: TimestampSchema, quoteExpiresAt: TimestampSchema,
}).strict();
function validateHardeningConsent(consent: z.infer<typeof HardeningConsentContentObject>, context: z.RefinementCtx) {
  if (consent.actorId !== consent.requesterUserId) context.addIssue({ code: z.ZodIssueCode.custom, message: "consent actor must be owner", path: ["actorId"] });
  if (Date.parse(consent.acceptedAt) > Date.parse(consent.quoteExpiresAt)) context.addIssue({ code: z.ZodIssueCode.custom, message: "consent cannot follow quote expiry", path: ["acceptedAt"] });
}
const HardeningConsentContentSchema = HardeningConsentContentObject.superRefine(validateHardeningConsent);
export const HardeningConsentSchema = HardeningConsentContentObject.extend({ consentHash: HashSchema, consentId: HashSchema }).strict()
  .superRefine((consent, context) => { validateHardeningConsent(consent, context); verifyEntityHash(consent, "consentHash", "consentId", HARDENING_CONSENT_POLICY_VERSION, context); });
export function createHardeningConsent(input: z.input<typeof HardeningConsentContentSchema>, quote: HardeningQuote) {
  const authenticQuote = HardeningQuoteSchema.parse(quote);
  const content = HardeningConsentContentSchema.parse(input);
  if (content.quoteId !== authenticQuote.quoteId || content.quoteHash !== authenticQuote.quoteHash || content.selectionHash !== authenticQuote.selectionHash ||
      content.parentRunId !== authenticQuote.parentRunId || content.parentCheckpointId !== authenticQuote.parentCheckpointId ||
      content.parentCheckpointHash !== authenticQuote.parentCheckpointHash || content.parentStateVersion !== authenticQuote.parentStateVersion ||
      content.requesterUserId !== authenticQuote.requesterUserId || content.quoteExpiresAt !== authenticQuote.expiresAt) throw new TypeError("consent does not bind the exact quote authority");
  if (Date.parse(content.acceptedAt) < Date.parse(authenticQuote.createdAt)) throw new TypeError("consent cannot precede quote creation");
  if (content.authorizedBudget.costMicrousd > authenticQuote.estimate.maxCostMicrousd || content.authorizedBudget.tokens > authenticQuote.estimate.maxTokens || content.authorizedBudget.timeSeconds > authenticQuote.estimate.maxTimeSeconds) throw new TypeError("consent budget exceeds the quote hard caps");
  return HardeningConsentSchema.parse(hashEntity(content, "consentHash", "consentId", HARDENING_CONSENT_POLICY_VERSION));
}

const BudgetSchema = z.object({ costMicrousd: PositiveMoneySchema, tokens: PositiveTokenSchema, timeSeconds: TimeSchema }).strict();
const EngineerRunLineageContentObject = z.object({
  schemaVersion: z.literal(1), policyVersion: z.literal(HARDENING_LINEAGE_POLICY_VERSION), relation: z.literal("OPTIONAL_HARDENING"),
  rootRunId: IdentifierSchema, parentRunId: IdentifierSchema, childRunId: IdentifierSchema,
  requesterUserId: IdentifierSchema, repositoryId: IdentifierSchema, ...CheckpointPairFields,
  parentBaseCommitSha: CommitSchema, seedResultCommitSha: CommitSchema,
  quoteId: HashSchema, quoteHash: HashSchema, consentId: HashSchema, consentHash: HashSchema,
  selectionHash: HashSchema, budget: BudgetSchema, createdAt: TimestampSchema,
}).strict();
function validateEngineerRunLineage(lineage: z.infer<typeof EngineerRunLineageContentObject>, context: z.RefinementCtx) {
  const expected = `hardening-${sha256({ namespace: "engineer-hardening-child-v1", consentHash: lineage.consentHash }).slice(7)}`;
  if (lineage.childRunId !== expected) context.addIssue({ code: z.ZodIssueCode.custom, message: "childRunId is not deterministic", path: ["childRunId"] });
  if (lineage.parentRunId === lineage.childRunId) context.addIssue({ code: z.ZodIssueCode.custom, message: "child run must differ from parent", path: ["childRunId"] });
}
const EngineerRunLineageContentSchema = EngineerRunLineageContentObject.superRefine(validateEngineerRunLineage);
export const EngineerRunLineageSchema = EngineerRunLineageContentObject.extend({ lineageHash: HashSchema, lineageId: HashSchema }).strict()
  .superRefine((lineage, context) => { validateEngineerRunLineage(lineage, context); verifyEntityHash(lineage, "lineageHash", "lineageId", HARDENING_LINEAGE_POLICY_VERSION, context); });
export function hardeningChildRunId(consentHash: string): string { return `hardening-${sha256({ namespace: "engineer-hardening-child-v1", consentHash }).slice(7)}`; }
export function createEngineerRunLineage(input: z.input<typeof EngineerRunLineageContentSchema>) {
  const content = EngineerRunLineageContentSchema.parse(input);
  return EngineerRunLineageSchema.parse(hashEntity(content, "lineageHash", "lineageId", HARDENING_LINEAGE_POLICY_VERSION));
}

export const OptionalHardeningChildRequestSchema = z.object({
  consentId: HashSchema,
  consentHash: HashSchema,
}).strict();

const OptionalHardeningRequiredChangeSchema = z.object({
  advisoryId: HashSchema,
  requiredChange: z.string().min(1).max(20_000),
  file: z.string().min(1).max(2_000),
  lineStart: z.number().int().nonnegative().nullable(),
  lineEnd: z.number().int().nonnegative().nullable(),
}).strict().superRefine((change, context) => {
  if ((change.lineStart === null) !== (change.lineEnd === null) ||
      (change.lineStart !== null && change.lineEnd! < change.lineStart)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "child request line bounds must be paired and ordered", path: ["lineStart"] });
  }
});

const OptionalHardeningChildRequestContentObject = z.object({
  schemaVersion: z.literal(1),
  policyVersion: z.literal("engineer-hardening-child-request-v1"),
  rootRunId: IdentifierSchema,
  parentRunId: IdentifierSchema,
  childRunId: IdentifierSchema,
  requesterUserId: IdentifierSchema,
  repositoryId: IdentifierSchema,
  ...CheckpointPairFields,
  quoteId: HashSchema,
  quoteHash: HashSchema,
  consentId: HashSchema,
  consentHash: HashSchema,
  advisoryIds: z.array(HashSchema).min(1).max(20),
  requiredChanges: z.array(OptionalHardeningRequiredChangeSchema).min(1).max(20),
  selectionHash: HashSchema,
  seedResultCommitSha: CommitSchema,
  createdAt: TimestampSchema,
}).strict();
function validateOptionalHardeningChildRequest(request: z.infer<typeof OptionalHardeningChildRequestContentObject>, context: z.RefinementCtx) {
  sortedUnique(request.advisoryIds, context, "advisoryIds");
  const changeIds = request.requiredChanges.map((change) => change.advisoryId);
  sortedUnique(changeIds, context, "requiredChanges");
  if (canonicalJson(changeIds) !== canonicalJson(request.advisoryIds)) context.addIssue({ code: z.ZodIssueCode.custom, message: "required changes must exactly match advisoryIds" });
  if (sha256(request.advisoryIds) !== request.selectionHash) context.addIssue({ code: z.ZodIssueCode.custom, message: "child request selectionHash mismatch", path: ["selectionHash"] });
  if (request.childRunId !== hardeningChildRunId(request.consentHash)) context.addIssue({ code: z.ZodIssueCode.custom, message: "child request deterministic identity mismatch", path: ["childRunId"] });
}
const OptionalHardeningChildRequestContentSchema = OptionalHardeningChildRequestContentObject.superRefine(validateOptionalHardeningChildRequest);
export const OptionalHardeningChildAuthoritySchema = OptionalHardeningChildRequestContentObject.extend({ requestHash: HashSchema }).strict()
  .superRefine((request, context) => {
    validateOptionalHardeningChildRequest(request, context);
    const { requestHash, ...content } = request;
    if (sha256(content) !== requestHash) context.addIssue({ code: z.ZodIssueCode.custom, message: "child requestHash does not match canonical content", path: ["requestHash"] });
  });
export function createOptionalHardeningChildAuthority(input: z.input<typeof OptionalHardeningChildRequestContentSchema>) {
  const content = OptionalHardeningChildRequestContentSchema.parse(input);
  return OptionalHardeningChildAuthoritySchema.parse({ ...content, requestHash: sha256(content) });
}

export const OptionalHardeningChildViewSchema = z.object({
  schemaVersion: z.literal(1),
  parentRunId: IdentifierSchema,
  rootRunId: IdentifierSchema,
  childRunId: IdentifierSchema,
  lineageId: HashSchema,
  lineageHash: HashSchema,
  state: z.literal("REQUEST_RECEIVED"),
  stateVersion: z.literal(0),
  riskTier: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
  humanGateRequired: z.literal(true),
  budget: BudgetSchema,
  createdAt: TimestampSchema,
}).strict();

export const PublicEngineerRunLineageV1Schema = z.object({
  schemaVersion: z.literal(1),
  policyVersion: z.literal(HARDENING_LINEAGE_POLICY_VERSION),
  relation: z.literal("OPTIONAL_HARDENING"),
  lineageId: HashSchema,
  lineageHash: HashSchema,
  rootRunId: IdentifierSchema,
  parentRunId: IdentifierSchema,
  childRunId: IdentifierSchema,
  ...CheckpointPairFields,
  parentBaseCommitSha: CommitSchema,
  seedResultCommitSha: CommitSchema,
  quoteId: HashSchema,
  quoteHash: HashSchema,
  consentId: HashSchema,
  consentHash: HashSchema,
  selectionHash: HashSchema,
  budget: BudgetSchema,
  createdAt: TimestampSchema,
}).strict();

export const OptionalHardeningChildCreationSchema = z.object({
  child: OptionalHardeningChildViewSchema,
  lineage: PublicEngineerRunLineageV1Schema,
}).strict().superRefine((value, context) => {
  for (const field of ["lineageId", "lineageHash", "rootRunId", "parentRunId", "childRunId", "createdAt"] as const) {
    if (value.child[field] !== value.lineage[field]) context.addIssue({ code: z.ZodIssueCode.custom, message: `child/lineage ${field} mismatch`, path: [field] });
  }
  if (canonicalJson(value.child.budget) !== canonicalJson(value.lineage.budget)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "child/lineage budget mismatch", path: ["budget"] });
  }
});

const CandidateLineageAttestationContentSchema = z.object({
  schemaVersion: z.literal(1), policyVersion: z.literal(CANDIDATE_LINEAGE_POLICY_VERSION), relation: z.literal("OPTIONAL_HARDENING"),
  lineageId: HashSchema, lineageHash: HashSchema, rootRunId: IdentifierSchema, parentRunId: IdentifierSchema, childRunId: IdentifierSchema,
  requesterUserId: IdentifierSchema, repositoryId: IdentifierSchema, ...CheckpointPairFields,
  parentResultCommitSha: CommitSchema, childCheckpointId: HashSchema, childCheckpointHash: HashSchema,
  childResultCommitSha: CommitSchema, parentBaseCommitSha: CommitSchema, selectionHash: HashSchema,
  quoteHash: HashSchema, consentHash: HashSchema, createdAt: TimestampSchema,
}).strict();
export const CandidateLineageAttestationSchema = CandidateLineageAttestationContentSchema.extend({ lineageAttestationHash: HashSchema, lineageAttestationId: HashSchema }).strict()
  .superRefine((attestation, context) => verifyEntityHash(attestation, "lineageAttestationHash", "lineageAttestationId", CANDIDATE_LINEAGE_POLICY_VERSION, context));
export const CandidateLineageStatementSchema = z.object({
  _type: z.literal(IN_TOTO_STATEMENT_TYPE),
  subject: z.tuple([z.object({ name: IdentifierSchema, digest: z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict() }).strict()]),
  predicateType: z.literal(CANDIDATE_LINEAGE_PREDICATE_TYPE), predicate: CandidateLineageAttestationSchema,
}).strict().superRefine((statement, context) => {
  if (statement.subject[0].name !== `zintus-engineer-candidate/${statement.predicate.repositoryId}/${statement.predicate.childResultCommitSha}` || statement.subject[0].digest.sha256 !== statement.predicate.childCheckpointHash.slice(7)) context.addIssue({ code: z.ZodIssueCode.custom, message: "lineage statement subject does not match child checkpoint" });
});
export const SignedCandidateLineageAttestationSchema = z.object({
  attestation: CandidateLineageAttestationSchema, statement: CandidateLineageStatementSchema,
  statementJson: z.string().min(1), statementHash: HashSchema, algorithm: IdentifierSchema, keyId: IdentifierSchema, signature: z.string().min(1).max(20_000),
}).strict().superRefine((signed, context) => {
  if (signed.statement.predicate.lineageAttestationId !== signed.attestation.lineageAttestationId) context.addIssue({ code: z.ZodIssueCode.custom, message: "statement predicate does not match attestation" });
  if (canonicalJson(signed.statement) !== signed.statementJson) context.addIssue({ code: z.ZodIssueCode.custom, message: "statementJson is not canonical", path: ["statementJson"] });
  if (sha256(Buffer.from(signed.statementJson, "utf8")) !== signed.statementHash) context.addIssue({ code: z.ZodIssueCode.custom, message: "statementHash does not match statement bytes", path: ["statementHash"] });
});
export async function createSignedCandidateLineageAttestation(input: z.input<typeof CandidateLineageAttestationContentSchema>, signer: CheckpointAttestor) {
  const content = CandidateLineageAttestationContentSchema.parse(input);
  const attestation = CandidateLineageAttestationSchema.parse(hashEntity(content, "lineageAttestationHash", "lineageAttestationId", CANDIDATE_LINEAGE_POLICY_VERSION));
  const statement = CandidateLineageStatementSchema.parse({ _type: IN_TOTO_STATEMENT_TYPE, subject: [{ name: `zintus-engineer-candidate/${attestation.repositoryId}/${attestation.childResultCommitSha}`, digest: { sha256: attestation.childCheckpointHash.slice(7) } }], predicateType: CANDIDATE_LINEAGE_PREDICATE_TYPE, predicate: attestation });
  const statementJson = canonicalJson(statement);
  const statementHash = sha256(Buffer.from(statementJson, "utf8"));
  const signature = await signer.sign(Buffer.from(statementJson, "utf8"));
  return SignedCandidateLineageAttestationSchema.parse({ attestation, statement, statementJson, statementHash, algorithm: signer.algorithm, keyId: signer.keyId, signature });
}
export async function verifySignedCandidateLineageAttestation(input: unknown, verifier: CheckpointAttestor) {
  const signed = SignedCandidateLineageAttestationSchema.parse(input);
  if (signed.algorithm !== verifier.algorithm || signed.keyId !== verifier.keyId || !await verifier.verify(Buffer.from(signed.statementJson, "utf8"), signed.signature)) throw new TypeError("candidate lineage signature verification failed");
  return signed;
}

const PublicationSelectionContentObject = z.object({
  schemaVersion: z.literal(1), policyVersion: z.literal(PUBLICATION_SELECTION_POLICY_VERSION),
  rootRunId: IdentifierSchema, candidateRunId: IdentifierSchema, requesterUserId: IdentifierSchema, repositoryId: IdentifierSchema,
  candidateKind: CandidateKindSchema, selectedCheckpointId: HashSchema, selectedCheckpointHash: HashSchema,
  selectedResultCommitSha: CommitSchema, candidateLineageAttestationId: HashSchema.nullable(), candidateLineageAttestationHash: HashSchema.nullable(),
  revision: z.number().int().positive(), expectedRevision: z.number().int().nonnegative(), previousSelectionId: HashSchema.nullable(),
  reasonCode: z.enum(["USER_SELECTED_PARENT", "USER_SELECTED_HARDENED_CHILD"]), actorId: IdentifierSchema,
  idempotencyKey: IdentifierSchema, selectedAt: TimestampSchema,
}).strict();
function validatePublicationSelection(selection: z.infer<typeof PublicationSelectionContentObject>, context: z.RefinementCtx) {
  if (selection.revision !== selection.expectedRevision + 1) context.addIssue({ code: z.ZodIssueCode.custom, message: "revision must equal expectedRevision + 1", path: ["revision"] });
  if ((selection.revision === 1) !== (selection.previousSelectionId === null)) context.addIssue({ code: z.ZodIssueCode.custom, message: "previousSelectionId must be null only for revision 1", path: ["previousSelectionId"] });
  if (selection.actorId !== selection.requesterUserId) context.addIssue({ code: z.ZodIssueCode.custom, message: "selection actor must be owner", path: ["actorId"] });
  const child = selection.candidateKind === "HARDENED_CHILD";
  if (child !== (selection.candidateLineageAttestationId !== null && selection.candidateLineageAttestationHash !== null)) context.addIssue({ code: z.ZodIssueCode.custom, message: "only hardened children require a complete lineage attestation pair" });
  if ((selection.reasonCode === "USER_SELECTED_HARDENED_CHILD") !== child) context.addIssue({ code: z.ZodIssueCode.custom, message: "selection reason does not match candidate kind", path: ["reasonCode"] });
  if (!child && selection.candidateRunId !== selection.rootRunId) context.addIssue({ code: z.ZodIssueCode.custom, message: "parent candidate must be the root run", path: ["candidateRunId"] });
}
const PublicationSelectionContentSchema = PublicationSelectionContentObject.superRefine(validatePublicationSelection);
export const PublicationCandidateSelectionSchema = PublicationSelectionContentObject.extend({ selectionHash: HashSchema, selectionId: HashSchema }).strict()
  .superRefine((selection, context) => { validatePublicationSelection(selection, context); verifyEntityHash(selection, "selectionHash", "selectionId", PUBLICATION_SELECTION_POLICY_VERSION, context); });
export function createPublicationCandidateSelection(input: z.input<typeof PublicationSelectionContentSchema>) {
  const content = PublicationSelectionContentSchema.parse(input);
  return PublicationCandidateSelectionSchema.parse(hashEntity(content, "selectionHash", "selectionId", PUBLICATION_SELECTION_POLICY_VERSION));
}

export const AdvisoryBacklogViewSchema = z.object({
  advisoryId: HashSchema, severity: z.enum(["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"]),
  category: z.string(), description: z.string(), recommendedChange: z.string(),
  file: z.string().nullable(), lineStart: z.number().int().nonnegative().nullable(), lineEnd: z.number().int().nonnegative().nullable(),
  actionability: AdvisoryActionabilitySchema, status: z.enum(["OPEN", "DEFERRED", "DISMISSED"]),
  revision: z.number().int().nonnegative(), createdAt: TimestampSchema, updatedAt: TimestampSchema,
}).strict();
export const AdvisoryBacklogPageSchema = z.object({ schemaVersion: z.literal(1),
  materializationStatus: z.enum(["COMPLETE", "LEGACY_UNAVAILABLE"]), items: z.array(AdvisoryBacklogViewSchema), nextCursor: z.string().nullable() }).strict();
export const AdvisoryOwnerCommandSchema = z.object({ expectedRevision: z.number().int().nonnegative(),
  idempotencyKey: IdentifierSchema, rationale: z.string().max(4_000).nullable() }).strict();

export const HardeningQuoteRequestSchema = z.object({
  runId: IdentifierSchema,
  advisoryIds: z.array(HashSchema).min(1).max(20),
  expectedParentStateVersion: z.number().int().nonnegative(),
  idempotencyKey: IdentifierSchema,
}).strict().superRefine((request, context) => sortedUnique(request.advisoryIds, context, "advisoryIds"));

export const HardeningConsentRequestSchema = z.object({
  quoteId: HashSchema,
  quoteHash: HashSchema,
  authorizedBudget: z.object({ costMicrousd: PositiveMoneySchema, tokens: PositiveTokenSchema, timeSeconds: TimeSchema }).strict(),
  acknowledgements: z.object({ separateRun: z.literal(true), parentCandidateUnchanged: z.literal(true), noAutomaticRepair: z.literal(true), noOverages: z.literal(true) }).strict(),
  expectedParentStateVersion: z.number().int().nonnegative(),
  idempotencyKey: IdentifierSchema,
}).strict();

const HardeningQuoteV1ViewSchema = z.object({
  schemaVersion: z.literal(1),
  policyVersion: z.literal(HARDENING_ESTIMATE_POLICY_VERSION),
  quoteId: HashSchema,
  quoteHash: HashSchema,
  parentRunId: IdentifierSchema,
  requesterUserId: IdentifierSchema,
  repositoryId: IdentifierSchema,
  parentCheckpointId: HashSchema,
  parentCheckpointHash: HashSchema,
  parentStateVersion: z.number().int().nonnegative(),
  advisoryIds: z.array(HashSchema).min(1).max(20),
  selectionHash: HashSchema,
  estimatorVersion: z.literal(HARDENING_ESTIMATOR_VERSION),
  routingPolicyVersion: z.literal(MODEL_ROUTING_POLICY_VERSION),
  pricingVersion: z.literal(OPENAI_GPT56_PRICING_2026_07_14.version),
  estimate: HardeningQuoteV1ContentObject.shape.estimate,
  assumptions: HardeningQuoteV1ContentObject.shape.assumptions,
  createdAt: TimestampSchema,
  expiresAt: TimestampSchema,
  status: z.enum(["ACTIVE", "EXPIRED"]),
}).strict().superRefine((quote, context) => {
  sortedUnique(quote.advisoryIds, context, "advisoryIds");
  if (sha256(quote.advisoryIds) !== quote.selectionHash) context.addIssue({ code: z.ZodIssueCode.custom, message: "selectionHash does not match advisoryIds", path: ["selectionHash"] });
});

const HardeningQuoteV2ViewSchema = z.object({
  ...HardeningQuoteV2ContentObject.shape,
  quoteId: HashSchema,
  quoteHash: HashSchema,
  status: z.enum(["ACTIVE", "EXPIRED"]),
}).strict().superRefine((quote, context) => {
  validateHardeningQuote(quote, context);
});

export const HardeningQuoteViewSchema = z.union([HardeningQuoteV1ViewSchema, HardeningQuoteV2ViewSchema]);

export type AdvisoryBacklogItem = z.infer<typeof AdvisoryBacklogItemSchema>;
export type AdvisoryBacklogEvent = z.infer<typeof AdvisoryBacklogEventSchema>;
export type HardeningQuote = z.infer<typeof HardeningQuoteSchema>;
export type HardeningQuoteV1 = z.infer<typeof HardeningQuoteV1Schema>;
export type HardeningQuoteV2 = z.infer<typeof HardeningQuoteV2Schema>;
export type HardeningQuoteSizingAuthority = z.infer<typeof HardeningQuoteSizingAuthoritySchema>;
export type HardeningConsent = z.infer<typeof HardeningConsentSchema>;
export type EngineerRunLineage = z.infer<typeof EngineerRunLineageSchema>;
export type CandidateLineageAttestation = z.infer<typeof CandidateLineageAttestationSchema>;
export type SignedCandidateLineageAttestation = z.infer<typeof SignedCandidateLineageAttestationSchema>;
export type PublicationCandidateSelection = z.infer<typeof PublicationCandidateSelectionSchema>;
export type AdvisoryBacklogView = z.infer<typeof AdvisoryBacklogViewSchema>;
export type AdvisoryBacklogPage = z.infer<typeof AdvisoryBacklogPageSchema>;
export type AdvisoryOwnerCommand = z.infer<typeof AdvisoryOwnerCommandSchema>;
export type HardeningQuoteRequest = z.infer<typeof HardeningQuoteRequestSchema>;
export type HardeningConsentRequest = z.infer<typeof HardeningConsentRequestSchema>;
export type HardeningQuoteView = z.infer<typeof HardeningQuoteViewSchema>;
export type OptionalHardeningChildRequest = z.infer<typeof OptionalHardeningChildRequestSchema>;
export type OptionalHardeningChildAuthority = z.infer<typeof OptionalHardeningChildAuthoritySchema>;
export type OptionalHardeningChildView = z.infer<typeof OptionalHardeningChildViewSchema>;
export type PublicEngineerRunLineageV1 = z.infer<typeof PublicEngineerRunLineageV1Schema>;
export type OptionalHardeningChildCreation = z.infer<typeof OptionalHardeningChildCreationSchema>;
