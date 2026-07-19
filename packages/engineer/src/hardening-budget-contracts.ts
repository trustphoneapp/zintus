import { z } from "zod";
import { canonicalJson, sha256 } from "./hash.js";
import {
  DEFAULT_HARDENING_ESTIMATION_AUTHORITY_V2,
  HardeningEstimationAuthorityV2Schema,
} from "./hardening-estimator.js";
import {
  HardeningPaidModelRoleSchema,
  HardeningPaidModelTierSchema,
} from "./hardening-execution-fencing.js";
import {
  HardeningPromptCacheDescriptorSchema,
} from "./hardening-prompt-cache.js";

export const HARDENING_BUDGET_POLICY_VERSION = "engineer-hardening-child-budget-v1" as const;
export const HARDENING_BUDGET_RESERVATION_POLICY_VERSION = "engineer-hardening-child-model-reservation-v1" as const;
export const HARDENING_BUDGET_RECONCILIATION_POLICY_VERSION = "engineer-hardening-budget-reconciliation-v1" as const;
export const HARDENING_INVALID_RECEIPT_OBSERVATION_POLICY_VERSION = "engineer-hardening-invalid-receipt-observation-v1" as const;

const Hash = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const Identifier = z.string().min(1).max(200);
const Timestamp = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine((value) => Number.isFinite(Date.parse(value)), "timestamp must be a real UTC millisecond instant");
const SafeTokens = z.number().int().nonnegative().safe();
const PositiveTokens = z.number().int().positive().safe();
const SafeMicrousd = z.number().int().nonnegative().safe();

export const HardeningBudgetStopReasonSchema = z.enum([
  "COST_CAP_REACHED",
  "TOKEN_CAP_REACHED",
  "BUILDER_INPUT_CAP_REACHED",
  "REVIEWER_INPUT_CAP_REACHED",
  "ACTIVE_TIME_CAP_REACHED",
  "BUILDER_CALL_CAP_REACHED",
  "REVIEWER_CALL_CAP_REACHED",
  "MODEL_USAGE_AMBIGUOUS",
  "MODEL_USAGE_BOUND_VIOLATION",
  "MODEL_DISPATCH_NOT_STARTED",
  "TOOL_CALL_CAP_REACHED",
  "MUTATION_CAP_REACHED",
  "COMMAND_CALL_CAP_REACHED",
  "COMMAND_TIME_CAP_REACHED",
  "NO_PROGRESS",
  "CANCELLED",
  "SECURITY_BLOCKED",
  "ENVIRONMENT_BLOCKED",
  "LEGACY_BUDGET_AUTHORITY_MISSING",
  "FAILED",
]);

const HardeningBudgetAuthorityContentSchema = z.object({
  schemaVersion: z.literal(1),
  policyVersion: z.literal(HARDENING_BUDGET_POLICY_VERSION),
  childRunId: Identifier,
  lineageId: Hash,
  lineageHash: Hash,
  quoteId: Hash,
  quoteHash: Hash,
  consentId: Hash,
  consentHash: Hash,
  costLimitMicrousd: z.number().int().positive().max(100_000_000),
  tokenLimit: z.number().int().positive().max(1_000_000),
  activeTimeLimitMs: z.number().int().min(1_000).max(86_400_000),
  estimationAuthority: HardeningEstimationAuthorityV2Schema,
  paidGraph: z.object({
    plannerCalls: z.literal(0),
    builderCalls: z.literal(1),
    reviewerCalls: z.literal(1),
    automaticRepairCalls: z.literal(0),
  }).strict(),
  toolLimits: z.object({
    maxToolCalls: z.literal(8), maxMutations: z.literal(8), maxCommandCalls: z.literal(8),
    maxToolArgumentBytes: z.literal(131_072), maxFileBytes: z.literal(1_048_576),
    maxToolResultBytes: z.literal(32_768), maxSearchBytes: z.literal(8_388_608),
    maxSearchResults: z.literal(100), maxRangeLines: z.literal(400),
  }).strict(),
  transportLimits: z.object({
    builderInputCap: z.number().int().positive().max(40_000), builderOutputCeiling: z.literal(6_000),
    reviewerInputCap: z.literal(40_000), reviewerOutputCeiling: z.literal(12_000),
    modelTimeoutMs: z.literal(120_000),
  }).strict(),
  createdAt: Timestamp,
}).strict();

export const HardeningBudgetAuthoritySchema = HardeningBudgetAuthorityContentSchema.extend({
  budgetAuthorityHash: Hash,
  budgetAuthorityId: Hash,
}).strict().superRefine((authority, context) => {
  const { budgetAuthorityHash, budgetAuthorityId, ...content } = authority;
  if (sha256(content) !== budgetAuthorityHash) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["budgetAuthorityHash"], message: "hardening budget authority hash mismatch" });
  }
  if (sha256({ namespace: HARDENING_BUDGET_POLICY_VERSION, childRunId: authority.childRunId,
    lineageHash: authority.lineageHash, quoteHash: authority.quoteHash, consentHash: authority.consentHash }) !== budgetAuthorityId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["budgetAuthorityId"], message: "hardening budget authority id mismatch" });
  }
});

export function createHardeningBudgetAuthority(input: z.input<typeof HardeningBudgetAuthorityContentSchema>) {
  const content = HardeningBudgetAuthorityContentSchema.parse(input);
  const budgetAuthorityHash = sha256(content);
  return HardeningBudgetAuthoritySchema.parse({
    ...content,
    budgetAuthorityHash,
    budgetAuthorityId: sha256({ namespace: HARDENING_BUDGET_POLICY_VERSION, childRunId: content.childRunId,
      lineageHash: content.lineageHash, quoteHash: content.quoteHash, consentHash: content.consentHash }),
  });
}

const HardeningBudgetReservationContentObject = z.object({
  schemaVersion: z.literal(1),
  policyVersion: z.literal(HARDENING_BUDGET_RESERVATION_POLICY_VERSION),
  childRunId: Identifier,
  budgetAuthorityId: Hash,
  budgetAuthorityHash: Hash,
  paidCallSlotId: Hash,
  role: HardeningPaidModelRoleSchema,
  modelTier: HardeningPaidModelTierSchema,
  resolvedModel: Identifier,
  pricingVersion: Identifier,
  agentExecutionId: Identifier,
  routingDecisionId: Identifier,
  claimantId: Identifier,
  /** Immutable run authority captured before the provider side effect. */
  expectedRunState: z.enum(["IMPLEMENTING","REVIEWING"]),
  expectedStateVersion: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  /** Hash of the canonical semantic Responses request, not a provider wire-byte claim. */
  requestHash: Hash,
  /** Deterministic local correlation identifier. It is not provider idempotency authority. */
  clientRequestId: z.string().uuid(),
  inputTokenUpperBound: SafeTokens,
  outputTokenCeiling: PositiveTokens,
  ...HardeningPromptCacheDescriptorSchema.shape,
  reservedCacheWriteInputTokens: SafeTokens,
  reservedCachedInputTokens: z.literal(0),
  uncachedInputMicrousdPerMillion: PositiveTokens,
  cachedInputMicrousdPerMillion: PositiveTokens,
  cacheWriteInputMicrousdPerMillion: PositiveTokens,
  outputMicrousdPerMillion: PositiveTokens,
  reservedTokens: PositiveTokens,
  reservedCostMicrousd: SafeMicrousd,
  createdAt: Timestamp,
}).strict();
function validateReservation(
  reservation: z.infer<typeof HardeningBudgetReservationContentObject>,
  context: z.RefinementCtx,
) {
  if (reservation.reservedTokens !== reservation.inputTokenUpperBound + reservation.outputTokenCeiling) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["reservedTokens"], message: "reserved tokens must equal input upper bound plus output ceiling" });
  }
  if (reservation.reservedCacheWriteInputTokens !== reservation.inputTokenUpperBound) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["reservedCacheWriteInputTokens"], message: "hardening reservation must retain the full cache-write input liability" });
  }
  const expectedTier = reservation.role === "BUILDER" ? "GPT-5.6_TERRA" : "GPT-5.6_SOL";
  if (reservation.modelTier !== expectedTier) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["modelTier"], message: "hardening budget role and model tier mismatch" });
  }
  const expectedState=reservation.role==="BUILDER"?"IMPLEMENTING":"REVIEWING";
  if(reservation.expectedRunState!==expectedState){
    context.addIssue({code:z.ZodIssueCode.custom,path:["expectedRunState"],message:"hardening reservation role and run state mismatch"});
  }
}
const HardeningBudgetReservationContentSchema = HardeningBudgetReservationContentObject.superRefine(validateReservation);

export const HardeningBudgetReservationSchema = HardeningBudgetReservationContentObject.extend({
  reservationHash: Hash,
  reservationId: Hash,
}).strict().superRefine((reservation, context) => {
  validateReservation(reservation, context);
  const { reservationHash, reservationId, ...content } = reservation;
  if (sha256(content) !== reservationHash) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["reservationHash"], message: "hardening reservation hash mismatch" });
  }
  if (sha256({ namespace: HARDENING_BUDGET_RESERVATION_POLICY_VERSION, childRunId: reservation.childRunId,
    role: reservation.role, paidCallSlotId: reservation.paidCallSlotId }) !== reservationId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["reservationId"], message: "hardening reservation id mismatch" });
  }
});

export function createHardeningBudgetReservation(input: z.input<typeof HardeningBudgetReservationContentSchema>) {
  const content = HardeningBudgetReservationContentSchema.parse(input);
  const reservationHash = sha256(content);
  return HardeningBudgetReservationSchema.parse({
    ...content,
    reservationHash,
    reservationId: sha256({ namespace: HARDENING_BUDGET_RESERVATION_POLICY_VERSION, childRunId: content.childRunId,
      role: content.role, paidCallSlotId: content.paidCallSlotId }),
  });
}

/**
 * Stable UUID-shaped correlation identifier for one reserved provider dispatch.
 * The value is intentionally local evidence only: callers must never infer that
 * a provider deduplicates Responses API requests from this identifier.
 */
export function hardeningClientRequestId(input: {
  childRunId: string;
  role: z.infer<typeof HardeningPaidModelRoleSchema>;
  reservationIdempotencyKey: string;
}): string {
  const digest = sha256({
    namespace: `${HARDENING_BUDGET_RESERVATION_POLICY_VERSION}:client-request`,
    childRunId: input.childRunId,
    role: input.role,
    reservationIdempotencyKey: input.reservationIdempotencyKey,
  }).slice(7);
  const variant = ["8", "9", "a", "b"][Number.parseInt(digest[16]!, 16) & 3]!;
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-${variant}${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

const HardeningInvalidReceiptObservationContentObject=z.object({
  schemaVersion:z.literal(1),policyVersion:z.literal(HARDENING_INVALID_RECEIPT_OBSERVATION_POLICY_VERSION),
  childRunId:Identifier,reservationId:Hash,reservationHash:Hash,recoveryGeneration:z.number().int().positive().safe(),
  recoveryOwnerId:Identifier,recoveryIdempotencyKey:Identifier,recoveryIdempotencyKeyHash:Hash,recoveryTokenHash:Hash,
  recoveryClaimedAtMs:SafeTokens,recoveryExpiresAtMs:PositiveTokens,observedAtMs:SafeTokens,
  responseRecordedModelCallId:Identifier,recordedModelCallRowHash:Hash.nullable(),
  modelCallId:Identifier,modelCallHash:Hash,modelCallKind:z.literal("ORIGINAL_SUCCEEDED"),
  observedModelCallCount:z.literal(1),observedReservationModelCallCount:z.literal(1),providerResponseId:Identifier,
  providerResponseArtifactId:Identifier,artifactSha256:Hash,artifactSizeBytes:SafeTokens,
  artifactStorageReferenceHash:Hash,artifactType:z.literal("MODEL_PROVIDER_RESPONSE"),
  artifactTrusted:z.literal(true),artifactProducerType:z.literal("SYSTEM"),
  artifactProducerId:z.literal("engineer-provider-response-recorder"),
  failureCode:z.enum(["FILE_MISSING","NOT_REGULAR_FILE","SIZE_MISMATCH","SHA256_MISMATCH",
    "INVALID_JSON","PROVIDER_ID_MISMATCH","USAGE_MISMATCH"]),
  observedSha256:Hash.nullable(),observedSizeBytes:SafeTokens.nullable(),
}).strict();
function validateInvalidReceiptObservation(value:z.infer<typeof HardeningInvalidReceiptObservationContentObject>,context:z.RefinementCtx){
  if(value.recoveryExpiresAtMs<=value.recoveryClaimedAtMs)
    context.addIssue({code:z.ZodIssueCode.custom,path:["recoveryExpiresAtMs"],message:"invalid receipt recovery expiry must follow its claim"});
  if(value.observedAtMs<value.recoveryClaimedAtMs||value.observedAtMs>=value.recoveryExpiresAtMs)
    context.addIssue({code:z.ZodIssueCode.custom,path:["observedAtMs"],message:"invalid receipt observation must occur within its recovery lease"});
  if(sha256(value.recoveryIdempotencyKey)!==value.recoveryIdempotencyKeyHash)
    context.addIssue({code:z.ZodIssueCode.custom,path:["recoveryIdempotencyKeyHash"],message:"invalid receipt recovery key hash mismatch"});
  if((value.observedSha256===null)!==(value.observedSizeBytes===null))
    context.addIssue({code:z.ZodIssueCode.custom,path:["observedSha256"],message:"observed receipt bytes require both size and hash"});
  if(["SIZE_MISMATCH","SHA256_MISMATCH","INVALID_JSON","PROVIDER_ID_MISMATCH","USAGE_MISMATCH"].includes(value.failureCode)&&
    value.observedSha256===null)
    context.addIssue({code:z.ZodIssueCode.custom,path:["observedSha256"],message:"byte-level receipt failures require the observed byte hash and size"});
  if(value.modelCallKind==="ORIGINAL_SUCCEEDED"&&value.modelCallId!==value.responseRecordedModelCallId)
    context.addIssue({code:z.ZodIssueCode.custom,path:["modelCallId"],message:"the original receipt call must retain its recorded identity"});
}
const HardeningInvalidReceiptObservationContentSchema=HardeningInvalidReceiptObservationContentObject.superRefine(
  validateInvalidReceiptObservation);
export const HardeningInvalidReceiptObservationSchema=HardeningInvalidReceiptObservationContentObject.extend({
  observationHash:Hash,
}).strict().superRefine((value,context)=>{
  validateInvalidReceiptObservation(value,context);
  const {observationHash,...content}=value;
  if(sha256(content)!==observationHash)
    context.addIssue({code:z.ZodIssueCode.custom,path:["observationHash"],message:"invalid receipt observation hash mismatch"});
});
export function createHardeningInvalidReceiptObservation(input:z.input<typeof HardeningInvalidReceiptObservationContentObject>){
  const content=HardeningInvalidReceiptObservationContentSchema.parse(input);
  return HardeningInvalidReceiptObservationSchema.parse({...content,observationHash:sha256(content)});
}

const HardeningBudgetReconciliationContentObject = z.object({
  schemaVersion: z.literal(1),
  policyVersion: z.literal(HARDENING_BUDGET_RECONCILIATION_POLICY_VERSION),
  childRunId: Identifier,
  reservationId: Hash,
  reservationHash: Hash,
  status: z.enum(["SETTLED", "AMBIGUOUS", "VOID_UNSENT"]),
  providerResponseId: Identifier.nullable(),
  modelCallId: Identifier.nullable(),
  actualInputTokens: SafeTokens.nullable(),
  actualOutputTokens: SafeTokens.nullable(),
  actualCachedInputTokens: SafeTokens.nullable(),
  actualCacheWriteInputTokens: SafeTokens.nullable(),
  cacheObservation: z.enum(["MISS", "HIT", "WRITE", "MIXED", "UNKNOWN"]),
  actualCostMicrousd: SafeMicrousd.nullable(),
  invalidReceiptObservation:HardeningInvalidReceiptObservationSchema.optional(),
  createdAt: Timestamp,
}).strict();
function validateReconciliation(
  reconciliation: z.infer<typeof HardeningBudgetReconciliationContentObject>,
  context: z.RefinementCtx,
) {
  const usage = [reconciliation.providerResponseId, reconciliation.actualInputTokens,
    reconciliation.actualOutputTokens, reconciliation.actualCachedInputTokens,
    reconciliation.actualCacheWriteInputTokens, reconciliation.actualCostMicrousd];
  if (reconciliation.status === "SETTLED" && (reconciliation.modelCallId === null || usage.some((value) => value === null))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "settled hardening usage must be complete" });
  }
  if (reconciliation.status === "AMBIGUOUS" && (reconciliation.modelCallId === null || usage.some((value) => value !== null))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "ambiguous hardening usage retains the complete reservation without partial usage" });
  }
  if (reconciliation.status === "VOID_UNSENT" && (reconciliation.modelCallId !== null || usage.some((value) => value !== null))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "unsent hardening calls cannot carry model or provider usage" });
  }
  if (reconciliation.status !== "SETTLED" && reconciliation.cacheObservation !== "UNKNOWN") {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["cacheObservation"], message: "unsettled hardening usage has an unknown cache observation" });
  }
  if(reconciliation.invalidReceiptObservation!==undefined&&reconciliation.status!=="AMBIGUOUS"){
    context.addIssue({code:z.ZodIssueCode.custom,path:["invalidReceiptObservation"],message:"invalid receipt observations require an ambiguous reconciliation"});
  }
  if (reconciliation.status === "SETTLED") {
    const cached = reconciliation.actualCachedInputTokens!;
    const cacheWrite = reconciliation.actualCacheWriteInputTokens!;
    const input = reconciliation.actualInputTokens!;
    if (cached + cacheWrite > input) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["actualCachedInputTokens"], message: "cached and cache-write input tokens cannot exceed total input tokens" });
    }
    const expectedObservation = cached > 0 && cacheWrite > 0 ? "MIXED"
      : cached > 0 ? "HIT" : cacheWrite > 0 ? "WRITE" : "MISS";
    if (reconciliation.cacheObservation !== expectedObservation) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["cacheObservation"], message: "cache observation does not match authenticated usage" });
    }
  }
}
const HardeningBudgetReconciliationContentSchema = HardeningBudgetReconciliationContentObject.superRefine(validateReconciliation);

export const HardeningBudgetReconciliationSchema = HardeningBudgetReconciliationContentObject.extend({
  reconciliationHash: Hash,
  reconciliationId: Hash,
}).strict().superRefine((reconciliation, context) => {
  validateReconciliation(reconciliation, context);
  const { reconciliationHash, reconciliationId, ...content } = reconciliation;
  if (sha256(content) !== reconciliationHash) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["reconciliationHash"], message: "hardening reconciliation hash mismatch" });
  }
  if (sha256({ namespace: HARDENING_BUDGET_RECONCILIATION_POLICY_VERSION, reconciliationHash }) !== reconciliationId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["reconciliationId"], message: "hardening reconciliation id mismatch" });
  }
});

export function createHardeningBudgetReconciliation(input: z.input<typeof HardeningBudgetReconciliationContentSchema>) {
  const content = HardeningBudgetReconciliationContentSchema.parse(input);
  const reconciliationHash = sha256(content);
  return HardeningBudgetReconciliationSchema.parse({
    ...content,
    reconciliationHash,
    reconciliationId: sha256({ namespace: HARDENING_BUDGET_RECONCILIATION_POLICY_VERSION, reconciliationHash }),
  });
}

function ceilingDivision(numerator: bigint, denominator: bigint): number {
  const result = Number((numerator + denominator - 1n) / denominator);
  if (!Number.isSafeInteger(result)) throw new RangeError("hardening model cost exceeds the safe integer range");
  return result;
}

/** Exact independent-ceiling settlement for authenticated I/C/W/O usage. */
export function hardeningModelPartitionedCostMicrousd(
  role: z.infer<typeof HardeningPaidModelRoleSchema>,
  inputTokens: number,
  cachedInputTokens: number,
  cacheWriteInputTokens: number,
  outputTokens: number,
  authority = DEFAULT_HARDENING_ESTIMATION_AUTHORITY_V2,
): number {
  const parsedAuthority = HardeningEstimationAuthorityV2Schema.parse(authority);
  const input = SafeTokens.parse(inputTokens);
  const cached = SafeTokens.parse(cachedInputTokens);
  const cacheWrite = SafeTokens.parse(cacheWriteInputTokens);
  const output = SafeTokens.parse(outputTokens);
  if (cached + cacheWrite > input) throw new TypeError("cached and cache-write input tokens cannot exceed total input tokens");
  const price = role === "BUILDER" ? parsedAuthority.roles.builder : parsedAuthority.roles.reviewer;
  return hardeningPartitionedCostFromRatesMicrousd(input, cached, cacheWrite, output, {
    uncachedInputMicrousdPerMillion: price.uncachedInputMicrousdPerMillion,
    cachedInputMicrousdPerMillion: price.cachedInputMicrousdPerMillion,
    cacheWriteInputMicrousdPerMillion: price.cacheWriteInputMicrousdPerMillion,
    outputMicrousdPerMillion: price.outputMicrousdPerMillion,
  });
}

/** Settlement primitive used with the immutable rates copied into a reservation row. */
export function hardeningPartitionedCostFromRatesMicrousd(
  inputTokens: number,
  cachedInputTokens: number,
  cacheWriteInputTokens: number,
  outputTokens: number,
  rates: {
    uncachedInputMicrousdPerMillion: number;
    cachedInputMicrousdPerMillion: number;
    cacheWriteInputMicrousdPerMillion: number;
    outputMicrousdPerMillion: number;
  },
): number {
  const input = SafeTokens.parse(inputTokens);
  const cached = SafeTokens.parse(cachedInputTokens);
  const cacheWrite = SafeTokens.parse(cacheWriteInputTokens);
  const output = SafeTokens.parse(outputTokens);
  if (cached + cacheWrite > input) throw new TypeError("cached and cache-write input tokens cannot exceed total input tokens");
  const parsedRates = z.object({
    uncachedInputMicrousdPerMillion: PositiveTokens,
    cachedInputMicrousdPerMillion: PositiveTokens,
    cacheWriteInputMicrousdPerMillion: PositiveTokens,
    outputMicrousdPerMillion: PositiveTokens,
  }).strict().parse(rates);
  const uncached = input - cached - cacheWrite;
  return ceilingDivision(BigInt(uncached) * BigInt(parsedRates.uncachedInputMicrousdPerMillion), 1_000_000n)
    + ceilingDivision(BigInt(cached) * BigInt(parsedRates.cachedInputMicrousdPerMillion), 1_000_000n)
    + ceilingDivision(BigInt(cacheWrite) * BigInt(parsedRates.cacheWriteInputMicrousdPerMillion), 1_000_000n)
    + ceilingDivision(BigInt(output) * BigInt(parsedRates.outputMicrousdPerMillion), 1_000_000n);
}

/** Conservative reservation: every input token carries cache-write liability. */
export function hardeningModelCostMicrousd(
  role: z.infer<typeof HardeningPaidModelRoleSchema>,
  inputTokens: number,
  outputTokens: number,
  authority = DEFAULT_HARDENING_ESTIMATION_AUTHORITY_V2,
): number {
  return hardeningModelPartitionedCostMicrousd(role, inputTokens, 0, inputTokens, outputTokens, authority);
}

export function assertHardeningReservationCost(
  reservation: z.infer<typeof HardeningBudgetReservationSchema>,
  authority = DEFAULT_HARDENING_ESTIMATION_AUTHORITY_V2,
): void {
  const expected = hardeningModelCostMicrousd(
    reservation.role,
    reservation.inputTokenUpperBound,
    reservation.outputTokenCeiling,
    authority,
  );
  if (reservation.reservedCostMicrousd !== expected) throw new TypeError("hardening reservation cost does not match frozen pricing");
  const role = reservation.role === "BUILDER" ? authority.roles.builder : authority.roles.reviewer;
  if (reservation.resolvedModel !== role.model || reservation.pricingVersion !== authority.pricingVersion) {
    throw new TypeError("hardening reservation route does not match frozen pricing authority");
  }
  if (reservation.uncachedInputMicrousdPerMillion !== role.uncachedInputMicrousdPerMillion ||
      reservation.cachedInputMicrousdPerMillion !== role.cachedInputMicrousdPerMillion ||
      reservation.cacheWriteInputMicrousdPerMillion !== role.cacheWriteInputMicrousdPerMillion ||
      reservation.outputMicrousdPerMillion !== role.outputMicrousdPerMillion) {
    throw new TypeError("hardening reservation rate projection does not match frozen pricing authority");
  }
}

export function sameHardeningReconciliation(left: unknown, right: unknown): boolean {
  return canonicalJson(HardeningBudgetReconciliationSchema.parse(left)) === canonicalJson(HardeningBudgetReconciliationSchema.parse(right));
}

export type HardeningBudgetAuthority = z.infer<typeof HardeningBudgetAuthoritySchema>;
export type HardeningBudgetReservation = z.infer<typeof HardeningBudgetReservationSchema>;
export type HardeningBudgetReconciliation = z.infer<typeof HardeningBudgetReconciliationSchema>;
export type HardeningInvalidReceiptObservation = z.infer<typeof HardeningInvalidReceiptObservationSchema>;
export type HardeningBudgetStopReason = z.infer<typeof HardeningBudgetStopReasonSchema>;

export class HardeningBudgetExhaustedError extends Error {
  readonly code = "HARDENING_BUDGET_EXHAUSTED";
  constructor(readonly reason: "COST_CAP_REACHED" | "TOKEN_CAP_REACHED" | "ACTIVE_TIME_CAP_REACHED") {
    super(`Optional hardening stopped at its signed ${reason.toLowerCase().replaceAll("_", " ")}.`);
    this.name = "HardeningBudgetExhaustedError";
  }
}

export class HardeningBudgetExtensionRequiresNewRunError extends Error {
  readonly code = "HARDENING_BUDGET_EXTENSION_REQUIRES_NEW_RUN";
  constructor() {
    super("Optional hardening budgets cannot be extended or resumed; create a new quote, consent, and child run.");
    this.name = "HardeningBudgetExtensionRequiresNewRunError";
  }
}

export class HardeningUsageAmbiguousError extends Error {
  readonly code = "HARDENING_MODEL_USAGE_AMBIGUOUS";
  constructor() {
    super("Optional hardening stopped because authenticated provider usage was unavailable or invalid; the worst-case reservation remains consumed.");
    this.name = "HardeningUsageAmbiguousError";
  }
}

export class HardeningBudgetAuthorityInvalidError extends Error {
  readonly code = "HARDENING_BUDGET_AUTHORITY_INVALID";
  constructor() { super("Optional-hardening budget authority is missing, stale, or invalid."); this.name = "HardeningBudgetAuthorityInvalidError"; }
}

export class HardeningBudgetStoppedError extends Error {
  readonly code = "HARDENING_BUDGET_STOPPED";
  constructor(readonly reason: HardeningBudgetStopReason) { super(`Optional hardening stopped: ${reason}.`); this.name = "HardeningBudgetStoppedError"; }
}

export class HardeningExecutionFenceStaleError extends Error {
  readonly code = "HARDENING_EXECUTION_FENCE_STALE";
  constructor() { super("Optional-hardening execution fence is stale or expired."); this.name = "HardeningExecutionFenceStaleError"; }
}

export class HardeningReservationConflictError extends Error {
  readonly code = "HARDENING_RESERVATION_CONFLICT";
  constructor() { super("Optional-hardening reservation conflicts with durable paid-call authority."); this.name = "HardeningReservationConflictError"; }
}
