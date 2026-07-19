import { createHmac } from "node:crypto";
import { z } from "zod";
import { providerPromptCacheKey, sha256 } from "./hash.js";

export const HARDENING_PROMPT_CACHE_POLICY_VERSION = "engineer-hardening-prompt-cache-v1" as const;
export const HARDENING_PROMPT_CACHE_ACCOUNTING_VERSION = "openai-prompt-cache-accounting-v1" as const;
export const HARDENING_PROMPT_CACHE_TTL_SECONDS = 1_800 as const;
export const HARDENING_PROMPT_CACHE_BREAKPOINT_COUNT = 1 as const;

const Hash = z.string().regex(/^sha256:[a-f0-9]{64}$/);

export const HardeningPromptCacheDescriptorSchema = z.object({
  cachePolicyVersion: z.literal(HARDENING_PROMPT_CACHE_POLICY_VERSION),
  cacheAccountingVersion: z.literal(HARDENING_PROMPT_CACHE_ACCOUNTING_VERSION),
  staticPrefixHash: Hash,
  toolSchemaHash: Hash,
  promptCacheKeyHash: Hash,
  cacheShard: z.number().int().min(0).max(3),
  cacheTtlSeconds: z.literal(HARDENING_PROMPT_CACHE_TTL_SECONDS),
  cacheBreakpointCount: z.literal(HARDENING_PROMPT_CACHE_BREAKPOINT_COUNT),
}).strict();

export type HardeningPromptCacheDescriptor = z.infer<typeof HardeningPromptCacheDescriptorSchema>;

export interface HardeningPromptCacheMaterial {
  descriptor: HardeningPromptCacheDescriptor;
  /** Provider-facing value. It is never written to durable storage. */
  providerPromptCacheKey: string;
}

const CANONICAL_HARDENING_CACHE_LAYOUTS = {
  BUILDER: {
    resolvedModel: "gpt-5.6-terra",
    promptOrReviewerPolicyVersion: "engineer-codex-builder-v3",
    staticPrefixHash: "sha256:46103ef13dc30de366aa72958a2fc460d86a4da0fb1bda4f0b96a8b57cd2b392",
    toolSchemaHash: "sha256:be90c1de245b388734d99e8159e37bed3f17cf5806d603c473c7fb234dc62cf4",
  },
  REVIEWER: {
    resolvedModel: "gpt-5.6-sol",
    promptOrReviewerPolicyVersion: "engineer-isolated-reviewer-v6",
    staticPrefixHash: "sha256:a51545419c7e6c80cf19cee1f4116a9c33ffe39c8aafebede02aab85bc10004f",
    toolSchemaHash: "sha256:dcf5dda91b5352eb1dcd664cd1c19a44a9760f754f86b7f4ea96607d7814f719",
  },
} as const;

function canonicalLayout(role: "BUILDER" | "REVIEWER", resolvedModel: string) {
  const layout = CANONICAL_HARDENING_CACHE_LAYOUTS[role];
  if (resolvedModel !== layout.resolvedModel) throw new TypeError("hardening prompt-cache model does not match the canonical role layout");
  return layout;
}

/**
 * P6 deliberately uses one tenant/role/layout key. The durable 0..3 field is
 * reserved for a future measured high-RPM policy; speculative child sharding
 * would fragment low-volume warmup without improving correctness.
 */
function hardeningCacheShard(): 0 { return 0; }

function tenantCacheScope(secret: string, requesterUserId: string): string {
  if (secret.length < 32) throw new TypeError("hardening prompt-cache secret must contain at least 32 characters");
  return createHmac("sha256", secret).update(requesterUserId, "utf8").digest("hex");
}

/**
 * Build the tenant-scoped default-shard prompt-cache identity without exposing
 * a tenant, repository, run, diff, or credential identifier to the provider.
 * Dynamic request data is intentionally absent from the derivation.
 */
export function createHardeningPromptCacheMaterial(input: {
  secret: string;
  requesterUserId: string;
  childRunId: string;
  role: "BUILDER" | "REVIEWER";
  resolvedModel: string;
  promptOrReviewerPolicyVersion: string;
  /** Exact provider-request prefix returned by the shared role layout builder. */
  staticPrefix: unknown;
  toolSchema: unknown;
}): HardeningPromptCacheMaterial {
  if (!input.requesterUserId || !input.childRunId || !input.resolvedModel || !input.promptOrReviewerPolicyVersion) {
    throw new TypeError("hardening prompt-cache identity is incomplete");
  }
  const layout = canonicalLayout(input.role, input.resolvedModel);
  if (input.promptOrReviewerPolicyVersion !== layout.promptOrReviewerPolicyVersion) {
    throw new TypeError("hardening prompt-cache policy version does not match the canonical role layout");
  }
  const staticPrefixHash = sha256(input.staticPrefix);
  const toolSchemaHash = sha256(input.toolSchema);
  if (staticPrefixHash !== layout.staticPrefixHash || toolSchemaHash !== layout.toolSchemaHash) {
    throw new TypeError("hardening prompt-cache request layout is not the frozen production layout");
  }
  const tenantScope = tenantCacheScope(input.secret, input.requesterUserId);
  const cacheShard = hardeningCacheShard();
  const providerKeyHash = sha256({
    namespace: "engineer-hardening-prompt-cache-key-v1",
    tenantCacheScope: tenantScope,
    role: input.role,
    resolvedModel: input.resolvedModel,
    staticPrefixHash,
    promptOrReviewerPolicyVersion: input.promptOrReviewerPolicyVersion,
    toolSchemaHash,
    cachePolicyVersion: HARDENING_PROMPT_CACHE_POLICY_VERSION,
    cacheShard,
  });
  const providerKey = providerPromptCacheKey(providerKeyHash);
  const descriptor = HardeningPromptCacheDescriptorSchema.parse({
    cachePolicyVersion: HARDENING_PROMPT_CACHE_POLICY_VERSION,
    cacheAccountingVersion: HARDENING_PROMPT_CACHE_ACCOUNTING_VERSION,
    staticPrefixHash,
    toolSchemaHash,
    promptCacheKeyHash: sha256(providerKey),
    cacheShard,
    cacheTtlSeconds: HARDENING_PROMPT_CACHE_TTL_SECONDS,
    cacheBreakpointCount: HARDENING_PROMPT_CACHE_BREAKPOINT_COUNT,
  });
  return { descriptor, providerPromptCacheKey: providerKey };
}

/**
 * Reconstruct the only descriptor admission will accept. This shares no
 * provider-facing module with the ledger and authenticates the tenant-scoped
 * key using the machine-local cache secret.
 */
export function canonicalHardeningPromptCacheMaterial(input: {
  secret: string;
  requesterUserId: string;
  childRunId: string;
  role: "BUILDER" | "REVIEWER";
  resolvedModel: string;
}): HardeningPromptCacheMaterial {
  if (!input.requesterUserId || !input.childRunId) {
    throw new TypeError("hardening prompt-cache identity is incomplete");
  }
  const layout = canonicalLayout(input.role, input.resolvedModel);
  const tenantScope = tenantCacheScope(input.secret, input.requesterUserId);
  const cacheShard = hardeningCacheShard();
  const providerKeyHash = sha256({
    namespace: "engineer-hardening-prompt-cache-key-v1",
    tenantCacheScope: tenantScope,
    role: input.role,
    resolvedModel: input.resolvedModel,
    staticPrefixHash: layout.staticPrefixHash,
    promptOrReviewerPolicyVersion: layout.promptOrReviewerPolicyVersion,
    toolSchemaHash: layout.toolSchemaHash,
    cachePolicyVersion: HARDENING_PROMPT_CACHE_POLICY_VERSION,
    cacheShard,
  });
  const providerKey = providerPromptCacheKey(providerKeyHash);
  return {
    descriptor: HardeningPromptCacheDescriptorSchema.parse({
      cachePolicyVersion: HARDENING_PROMPT_CACHE_POLICY_VERSION,
      cacheAccountingVersion: HARDENING_PROMPT_CACHE_ACCOUNTING_VERSION,
      staticPrefixHash: layout.staticPrefixHash,
      toolSchemaHash: layout.toolSchemaHash,
      promptCacheKeyHash: sha256(providerKey),
      cacheShard,
      cacheTtlSeconds: HARDENING_PROMPT_CACHE_TTL_SECONDS,
      cacheBreakpointCount: HARDENING_PROMPT_CACHE_BREAKPOINT_COUNT,
    }),
    providerPromptCacheKey: providerKey,
  };
}
