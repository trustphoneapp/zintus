import { describe, expect, test } from "bun:test";
import { builderStaticRequestPrefix } from "./codex-builder.js";
import { reviewerStaticRequestPrefix } from "./isolated-reviewer.js";
import { canonicalHardeningPromptCacheMaterial, createHardeningPromptCacheMaterial } from "./hardening-prompt-cache.js";
import { encode as encodeO200k } from "gpt-tokenizer/encoding/o200k_base";

const secret = "0123456789abcdef0123456789abcdef";

describe("optional-hardening prompt cache authority", () => {
  test("matches the frozen Builder key vector without exposing tenant or run identity", () => {
    const prefix = builderStaticRequestPrefix("gpt-5.6-terra");
    const material = createHardeningPromptCacheMaterial({
      secret, requesterUserId: "owner-1", childRunId: "child-1", role: "BUILDER",
      resolvedModel: "gpt-5.6-terra", promptOrReviewerPolicyVersion: "engineer-codex-builder-v3",
      staticPrefix: prefix, toolSchema: prefix.tools,
    });
    expect(material).toEqual({
      descriptor: {
        cachePolicyVersion: "engineer-hardening-prompt-cache-v1",
        cacheAccountingVersion: "openai-prompt-cache-accounting-v1",
        staticPrefixHash: "sha256:46103ef13dc30de366aa72958a2fc460d86a4da0fb1bda4f0b96a8b57cd2b392",
        toolSchemaHash: "sha256:be90c1de245b388734d99e8159e37bed3f17cf5806d603c473c7fb234dc62cf4",
        promptCacheKeyHash: "sha256:1dbe6f01ae2e9ad59ab09f0694dfefb63d2520cb6f1a771e919fc4ca0d566953",
        cacheShard: 0, cacheTtlSeconds: 1_800, cacheBreakpointCount: 1,
      },
      providerPromptCacheKey: "fcad388a7845c45c92f949cde6c5c88c5f688cad6ccd2f672d005e0f4346fdc6",
    });
    const durable = JSON.stringify(material.descriptor);
    expect(durable).not.toContain("owner-1");
    expect(durable).not.toContain("child-1");
    expect(durable).not.toContain(secret);
    expect(material.providerPromptCacheKey).toHaveLength(64);
  });

  test("uses one explicit static breakpoint and changes only for frozen cache authority inputs", () => {
    const builder = builderStaticRequestPrefix("gpt-5.6-terra");
    const reviewer = reviewerStaticRequestPrefix("gpt-5.6-sol");
    for (const prefix of [builder, reviewer]) {
      expect(JSON.stringify(prefix).match(/prompt_cache_breakpoint/g)?.length).toBe(1);
      expect(JSON.stringify(prefix)).not.toContain("repositoryId");
      expect(JSON.stringify(prefix)).not.toContain("diffHash");
      expect(encodeO200k(JSON.stringify(prefix)).length).toBeGreaterThanOrEqual(1_200);
    }
    const base = {
      secret, requesterUserId: "owner-1", childRunId: "child-1", role: "BUILDER" as const,
      resolvedModel: "gpt-5.6-terra", promptOrReviewerPolicyVersion: "engineer-codex-builder-v3",
      staticPrefix: builder, toolSchema: builder.tools,
    };
    const current = createHardeningPromptCacheMaterial(base);
    expect(createHardeningPromptCacheMaterial({ ...base }).descriptor).toEqual(current.descriptor);
    expect(canonicalHardeningPromptCacheMaterial({secret,requesterUserId:"owner-1",childRunId:"child-1",
      role:"BUILDER",resolvedModel:"gpt-5.6-terra"})).toEqual(current);
    expect(createHardeningPromptCacheMaterial({ ...base, secret: `${secret}rotated` }).descriptor.promptCacheKeyHash)
      .not.toBe(current.descriptor.promptCacheKeyHash);
    expect(createHardeningPromptCacheMaterial({ ...base, requesterUserId: "owner-2" }).descriptor.promptCacheKeyHash)
      .not.toBe(current.descriptor.promptCacheKeyHash);
    expect(() => createHardeningPromptCacheMaterial({ ...base, resolvedModel: "gpt-5.6-terra-next" })).toThrow("canonical role layout");
    expect(() => createHardeningPromptCacheMaterial({ ...base, promptOrReviewerPolicyVersion: "engineer-codex-builder-v4" }))
      .toThrow("policy version");
    expect(() => createHardeningPromptCacheMaterial({ ...base, staticPrefix: { ...builder, instructions: "changed" } }))
      .toThrow("frozen production layout");
    expect(() => createHardeningPromptCacheMaterial({ ...base, toolSchema: [] })).toThrow("frozen production layout");
    const otherShard = createHardeningPromptCacheMaterial({ ...base, childRunId: "child-2" });
    expect(otherShard).toEqual(current);
    const reviewerMaterial=createHardeningPromptCacheMaterial({secret,requesterUserId:"owner-1",childRunId:"child-1",role:"REVIEWER",
      resolvedModel:"gpt-5.6-sol",promptOrReviewerPolicyVersion:"engineer-isolated-reviewer-v6",
      staticPrefix:reviewer,toolSchema:reviewer.tools});
    expect(reviewerMaterial.descriptor.promptCacheKeyHash).not.toBe(current.descriptor.promptCacheKeyHash);
  });
});
