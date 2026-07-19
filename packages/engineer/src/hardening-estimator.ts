import { z } from "zod";
import {
  AdvisoryBacklogItemSchema,
  HARDENING_ESTIMATOR_VERSION,
  HARDENING_ESTIMATOR_VERSION_V2,
  type AdvisoryBacklogItem,
} from "./advisory-hardening-contracts.js";
import { DEFAULT_MODEL_BY_TIER, MODEL_ROUTING_POLICY_VERSION } from "./model-routing.js";
import { OPENAI_GPT56_PRICING_2026_07_14 } from "./runtime-budget.js";
import { HARDENING_CACHE_ACCOUNTING_VERSION, HARDENING_PROMPT_CACHE_POLICY_VERSION } from "./required-lane-policy-versions.js";
export { HARDENING_CACHE_ACCOUNTING_VERSION, HARDENING_PROMPT_CACHE_POLICY_VERSION } from "./required-lane-policy-versions.js";

export const HARDENING_ESTIMATE_ASSUMPTIONS = [
  "ESTIMATE_IS_HARD_CAP",
  "NO_AUTOMATIC_REPAIR",
  "NO_PARENT_BUDGET_TRANSFER",
] as const;
export const HARDENING_ESTIMATE_ASSUMPTIONS_V2 = [
  "ESTIMATE_IS_HARD_CAP",
  "NO_AUTOMATIC_REPAIR",
  "NO_PARENT_BUDGET_TRANSFER",
  "CACHE_HIT_NOT_ASSUMED",
  "CACHE_WRITE_WORST_CASE",
  "CACHE_DOES_NOT_REDUCE_TPM",
] as const;

const PositiveMicrousdPerMillionSchema = z.number().int().positive().safe();
const FrozenRolePriceSchema = z.object({
  model: z.string().min(1).max(200),
  inputMicrousdPerMillion: PositiveMicrousdPerMillionSchema,
  outputMicrousdPerMillion: PositiveMicrousdPerMillionSchema,
}).strict();

export const HardeningEstimationAuthoritySchema = z.object({
  routingPolicyVersion: z.literal(MODEL_ROUTING_POLICY_VERSION),
  pricingVersion: z.literal(OPENAI_GPT56_PRICING_2026_07_14.version),
  roles: z.object({
    builder: FrozenRolePriceSchema,
    reviewer: FrozenRolePriceSchema,
  }).strict(),
}).strict();

export type HardeningEstimationAuthority = z.infer<typeof HardeningEstimationAuthoritySchema>;

const CacheWriteInputMultiplierSchema = z.object({ numerator: z.literal(5), denominator: z.literal(4) }).strict();
const FrozenCacheRolePriceSchema = z.object({
  model: z.string().min(1).max(200),
  uncachedInputMicrousdPerMillion: PositiveMicrousdPerMillionSchema,
  cachedInputMicrousdPerMillion: PositiveMicrousdPerMillionSchema,
  cacheWriteInputMicrousdPerMillion: PositiveMicrousdPerMillionSchema,
  outputMicrousdPerMillion: PositiveMicrousdPerMillionSchema,
}).strict();

export const HardeningEstimationAuthorityV2Schema = z.object({
  routingPolicyVersion: z.literal(MODEL_ROUTING_POLICY_VERSION),
  pricingVersion: z.literal(OPENAI_GPT56_PRICING_2026_07_14.version),
  cachePolicyVersion: z.literal(HARDENING_PROMPT_CACHE_POLICY_VERSION),
  cacheAccountingVersion: z.literal(HARDENING_CACHE_ACCOUNTING_VERSION),
  cacheWriteInputMultiplier: CacheWriteInputMultiplierSchema,
  roles: z.object({
    builder: FrozenCacheRolePriceSchema,
    reviewer: FrozenCacheRolePriceSchema,
  }).strict(),
}).strict().superRefine((authority, context) => {
  for (const role of ["builder", "reviewer"] as const) {
    const price = authority.roles[role];
    if (!(price.cachedInputMicrousdPerMillion < price.uncachedInputMicrousdPerMillion &&
        price.uncachedInputMicrousdPerMillion < price.cacheWriteInputMicrousdPerMillion)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `${role} cache rates must be strictly ordered`, path: ["roles", role] });
    }
    if (price.cacheWriteInputMicrousdPerMillion * authority.cacheWriteInputMultiplier.denominator !==
        price.uncachedInputMicrousdPerMillion * authority.cacheWriteInputMultiplier.numerator) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `${role} cache-write rate does not match multiplier`, path: ["roles", role] });
    }
  }
});

export type HardeningEstimationAuthorityV2 = z.infer<typeof HardeningEstimationAuthorityV2Schema>;

/**
 * Integer, version-pinned price authority used by the deterministic quote path.
 * Values are micro-USD per one million tokens; no floating-point USD values enter
 * the estimator.
 */
export const DEFAULT_HARDENING_ESTIMATION_AUTHORITY: Readonly<HardeningEstimationAuthority> = Object.freeze({
  routingPolicyVersion: MODEL_ROUTING_POLICY_VERSION,
  pricingVersion: OPENAI_GPT56_PRICING_2026_07_14.version,
  roles: Object.freeze({
    builder: Object.freeze({
      model: DEFAULT_MODEL_BY_TIER["GPT-5.6_TERRA"],
      inputMicrousdPerMillion: 2_500_000,
      outputMicrousdPerMillion: 15_000_000,
    }),
    reviewer: Object.freeze({
      model: DEFAULT_MODEL_BY_TIER["GPT-5.6_SOL"],
      inputMicrousdPerMillion: 5_000_000,
      outputMicrousdPerMillion: 30_000_000,
    }),
  }),
});

export const DEFAULT_HARDENING_ESTIMATION_AUTHORITY_V2: Readonly<HardeningEstimationAuthorityV2> = Object.freeze({
  routingPolicyVersion: MODEL_ROUTING_POLICY_VERSION,
  pricingVersion: OPENAI_GPT56_PRICING_2026_07_14.version,
  cachePolicyVersion: HARDENING_PROMPT_CACHE_POLICY_VERSION,
  cacheAccountingVersion: HARDENING_CACHE_ACCOUNTING_VERSION,
  cacheWriteInputMultiplier: Object.freeze({ numerator: 5, denominator: 4 }),
  roles: Object.freeze({
    builder: Object.freeze({
      model: DEFAULT_MODEL_BY_TIER["GPT-5.6_TERRA"],
      uncachedInputMicrousdPerMillion: 2_500_000,
      cachedInputMicrousdPerMillion: 250_000,
      cacheWriteInputMicrousdPerMillion: 3_125_000,
      outputMicrousdPerMillion: 15_000_000,
    }),
    reviewer: Object.freeze({
      model: DEFAULT_MODEL_BY_TIER["GPT-5.6_SOL"],
      uncachedInputMicrousdPerMillion: 5_000_000,
      cachedInputMicrousdPerMillion: 500_000,
      cacheWriteInputMicrousdPerMillion: 6_250_000,
      outputMicrousdPerMillion: 30_000_000,
    }),
  }),
});

export const HardeningEstimateSchema = z.object({
  maxCostMicrousd: z.number().int().min(0).max(100_000_000),
  maxTokens: z.number().int().min(0).max(1_000_000),
  maxTimeSeconds: z.number().int().min(1).max(86_400),
  maxPlannerCalls: z.literal(0),
  maxBuilderCalls: z.literal(1),
  maxReviewerCalls: z.literal(1),
  automaticRepairCalls: z.literal(0),
}).strict();

export const DeterministicHardeningEstimateSchema = z.object({
  estimatorVersion: z.literal(HARDENING_ESTIMATOR_VERSION),
  routingPolicyVersion: z.literal(MODEL_ROUTING_POLICY_VERSION),
  pricingVersion: z.literal(OPENAI_GPT56_PRICING_2026_07_14.version),
  estimate: HardeningEstimateSchema,
  assumptions: z.tuple([
    z.literal("ESTIMATE_IS_HARD_CAP"),
    z.literal("NO_AUTOMATIC_REPAIR"),
    z.literal("NO_PARENT_BUDGET_TRANSFER"),
  ]),
}).strict();

export type DeterministicHardeningEstimate = z.infer<typeof DeterministicHardeningEstimateSchema>;

export const HardeningRoleTokenCapsSchema = z.object({
  builderInputTokens: z.number().int().positive().max(40_000),
  builderOutputTokens: z.literal(6_000),
  reviewerInputTokens: z.literal(40_000),
  reviewerOutputTokens: z.literal(12_000),
}).strict();

export const HardeningEstimateV2Schema = HardeningEstimateSchema.extend({
  inputCaps: HardeningRoleTokenCapsSchema,
}).strict().superRefine((estimate, context) => {
  const expected = Object.values(estimate.inputCaps).reduce((sum, value) => sum + value, 0);
  if (estimate.maxTokens !== expected) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "maxTokens must equal the four role caps", path: ["maxTokens"] });
  }
});

export const DeterministicHardeningEstimateV2Schema = z.object({
  estimatorVersion: z.literal(HARDENING_ESTIMATOR_VERSION_V2),
  routingPolicyVersion: z.literal(MODEL_ROUTING_POLICY_VERSION),
  pricingVersion: z.literal(OPENAI_GPT56_PRICING_2026_07_14.version),
  cachePolicyVersion: z.literal(HARDENING_PROMPT_CACHE_POLICY_VERSION),
  cacheAccountingVersion: z.literal(HARDENING_CACHE_ACCOUNTING_VERSION),
  cacheWriteInputMultiplier: CacheWriteInputMultiplierSchema,
  estimate: HardeningEstimateV2Schema,
  assumptions: z.tuple([
    z.literal("ESTIMATE_IS_HARD_CAP"),
    z.literal("NO_AUTOMATIC_REPAIR"),
    z.literal("NO_PARENT_BUDGET_TRANSFER"),
    z.literal("CACHE_HIT_NOT_ASSUMED"),
    z.literal("CACHE_WRITE_WORST_CASE"),
    z.literal("CACHE_DOES_NOT_REDUCE_TPM"),
  ]),
}).strict();

export type DeterministicHardeningEstimateV2 = z.infer<typeof DeterministicHardeningEstimateV2Schema>;

const ActionableAdvisoriesSchema = z.array(AdvisoryBacklogItemSchema).min(1).max(20)
  .superRefine((advisories, context) => {
    const seen = new Set<string>();
    for (let index = 0; index < advisories.length; index += 1) {
      const advisory = advisories[index]!;
      if (advisory.actionability !== "ACTIONABLE") {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "hardening estimates require actionable advisories", path: [index, "actionability"] });
      }
      if (seen.has(advisory.advisoryId)) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "hardening estimates require unique advisories", path: [index, "advisoryId"] });
      }
      seen.add(advisory.advisoryId);
    }
  });

function assertCurrentAuthority(rawAuthority: HardeningEstimationAuthority): HardeningEstimationAuthority {
  const authority = HardeningEstimationAuthoritySchema.parse(rawAuthority);
  const expected = DEFAULT_HARDENING_ESTIMATION_AUTHORITY;
  for (const role of ["builder", "reviewer"] as const) {
    const actualRole = authority.roles[role];
    const expectedRole = expected.roles[role];
    if (actualRole.model !== expectedRole.model ||
        actualRole.inputMicrousdPerMillion !== expectedRole.inputMicrousdPerMillion ||
        actualRole.outputMicrousdPerMillion !== expectedRole.outputMicrousdPerMillion) {
      throw new TypeError(`hardening estimation ${role} authority is stale or does not match its frozen price version`);
    }
  }
  return authority;
}

function assertCurrentAuthorityV2(rawAuthority: HardeningEstimationAuthorityV2): HardeningEstimationAuthorityV2 {
  const authority = HardeningEstimationAuthorityV2Schema.parse(rawAuthority);
  const expected = DEFAULT_HARDENING_ESTIMATION_AUTHORITY_V2;
  for (const role of ["builder", "reviewer"] as const) {
    const actualRole = authority.roles[role];
    const expectedRole = expected.roles[role];
    for (const field of ["model", "uncachedInputMicrousdPerMillion", "cachedInputMicrousdPerMillion",
      "cacheWriteInputMicrousdPerMillion", "outputMicrousdPerMillion"] as const) {
      if (actualRole[field] !== expectedRole[field]) {
        throw new TypeError(`hardening estimation ${role} authority is stale or does not match its frozen price version`);
      }
    }
  }
  return authority;
}

function ceilingMicrousd(tokens: number, priceMicrousdPerMillion: number): number {
  const numerator = BigInt(tokens) * BigInt(priceMicrousdPerMillion);
  const value = (numerator + 999_999n) / 1_000_000n;
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new RangeError("hardening estimate exceeds the safe integer range");
  return result;
}

/** Pure and model-free: identical advisories and frozen authority yield identical caps. */
export function estimateOptionalHardening(
  rawAdvisories: readonly AdvisoryBacklogItem[],
  rawAuthority: HardeningEstimationAuthority = DEFAULT_HARDENING_ESTIMATION_AUTHORITY,
): DeterministicHardeningEstimate {
  const advisories = ActionableAdvisoriesSchema.parse(rawAdvisories);
  const authority = assertCurrentAuthority(rawAuthority);
  const advisoryCount = advisories.length;
  const fileCount = new Set(advisories.map((advisory) => advisory.file).filter((file): file is string => file !== null)).size;

  // v1 is immutable compatibility behavior. It priced each role's combined
  // token allowance at that role's maximum input/output rate.
  const builderTokens = Math.min(46_000, 6_000 + 4_000 + (2_000 * advisoryCount) + (1_000 * fileCount));
  const reviewerTokens = Math.min(32_000, 12_000 + 2_000 + (1_000 * advisoryCount) + (500 * fileCount));

  return DeterministicHardeningEstimateSchema.parse({
    estimatorVersion: HARDENING_ESTIMATOR_VERSION,
    routingPolicyVersion: authority.routingPolicyVersion,
    pricingVersion: authority.pricingVersion,
    estimate: {
      maxCostMicrousd:
        ceilingMicrousd(builderTokens, Math.max(authority.roles.builder.inputMicrousdPerMillion, authority.roles.builder.outputMicrousdPerMillion))
        + ceilingMicrousd(reviewerTokens, Math.max(authority.roles.reviewer.inputMicrousdPerMillion, authority.roles.reviewer.outputMicrousdPerMillion)),
      maxTokens: builderTokens + reviewerTokens,
      maxTimeSeconds: Math.min(86_400, 300 + (120 * advisoryCount) + (60 * fileCount)),
      maxPlannerCalls: 0,
      maxBuilderCalls: 1,
      maxReviewerCalls: 1,
      automaticRepairCalls: 0,
    },
    assumptions: [...HARDENING_ESTIMATE_ASSUMPTIONS],
  });
}

/**
 * v2 signs independent input/output ceilings per role. This matches the
 * runtime's conservative local input counter without mutating any v1 quote.
 */
export function estimateOptionalHardeningV2(
  rawAdvisories: readonly AdvisoryBacklogItem[],
  rawAuthority: HardeningEstimationAuthorityV2 = DEFAULT_HARDENING_ESTIMATION_AUTHORITY_V2,
): DeterministicHardeningEstimateV2 {
  const advisories = ActionableAdvisoriesSchema.parse(rawAdvisories);
  const authority = assertCurrentAuthorityV2(rawAuthority);
  const advisoryCount = advisories.length;
  const fileCount = new Set(advisories.map((advisory) => advisory.file).filter((file): file is string => file !== null)).size;
  const roleTokenCaps = {
    builderInputTokens: Math.min(40_000, 12_000 + (2_000 * advisoryCount) + (1_000 * fileCount)),
    builderOutputTokens: 6_000 as const,
    reviewerInputTokens: 40_000 as const,
    reviewerOutputTokens: 12_000 as const,
  };
  return DeterministicHardeningEstimateV2Schema.parse({
    estimatorVersion: HARDENING_ESTIMATOR_VERSION_V2,
    routingPolicyVersion: authority.routingPolicyVersion,
    pricingVersion: authority.pricingVersion,
    cachePolicyVersion: authority.cachePolicyVersion,
    cacheAccountingVersion: authority.cacheAccountingVersion,
    cacheWriteInputMultiplier: authority.cacheWriteInputMultiplier,
    estimate: {
      maxCostMicrousd:
        ceilingMicrousd(roleTokenCaps.builderInputTokens, authority.roles.builder.cacheWriteInputMicrousdPerMillion)
        + ceilingMicrousd(roleTokenCaps.builderOutputTokens, authority.roles.builder.outputMicrousdPerMillion)
        + ceilingMicrousd(roleTokenCaps.reviewerInputTokens, authority.roles.reviewer.cacheWriteInputMicrousdPerMillion)
        + ceilingMicrousd(roleTokenCaps.reviewerOutputTokens, authority.roles.reviewer.outputMicrousdPerMillion),
      maxTokens: roleTokenCaps.builderInputTokens + roleTokenCaps.builderOutputTokens
        + roleTokenCaps.reviewerInputTokens + roleTokenCaps.reviewerOutputTokens,
      maxTimeSeconds: Math.min(86_400, 300 + (120 * advisoryCount) + (60 * fileCount)),
      maxPlannerCalls: 0,
      maxBuilderCalls: 1,
      maxReviewerCalls: 1,
      automaticRepairCalls: 0,
      inputCaps: roleTokenCaps,
    },
    assumptions: [...HARDENING_ESTIMATE_ASSUMPTIONS_V2],
  });
}

/** Canonical public name used by the ledger quote transaction. */
export const deterministicHardeningEstimate = estimateOptionalHardening;
export const deterministicHardeningEstimateV2 = estimateOptionalHardeningV2;
