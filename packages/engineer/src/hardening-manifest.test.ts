import { describe, expect, test } from "bun:test";
import {
  createEngineerRunLineage,
  createOptionalHardeningChildAuthority,
  hardeningChildRunId,
} from "./advisory-hardening-contracts.js";
import { TaskManifestSchema, type TaskManifestContent } from "./contracts.js";
import {
  OptionalHardeningContextAuthoritySchema,
  OptionalHardeningManifestBuildResultSchema,
  buildOptionalHardeningManifest,
} from "./hardening-manifest.js";
import { canonicalJson, sha256 } from "./hash.js";

const at = "2026-07-18T15:00:00.000Z";
const h = (label: string) => sha256(label);

function fixture() {
  const parentContent: TaskManifestContent = {
    manifestVersion: 7,
    runId: "parent-run",
    repository: {
      repositoryId: "repo-1",
      provider: "github",
      owner: "trustphoneapp",
      name: "zintus",
      url: "https://github.com/trustphoneapp/zintus.git",
      baseBranch: "main",
      baseCommitSha: "a".repeat(40),
    },
    request: { original: "Parent request", normalized: "Parent request" },
    acceptanceCriteria: [{
      criterionId: "parent-c1",
      statement: "Parent behavior works.",
      verificationMethod: "Run parent tests.",
      priority: "MUST",
    }],
    testPlan: [{
      testId: "parent-unit",
      criterionIds: ["parent-c1"],
      type: "UNIT",
      description: "Run focused unit tests.",
      command: "bun test packages/engineer/src/focused.test.ts",
    }, {
      testId: "parent-review",
      criterionIds: ["parent-c1"],
      type: "SECURITY",
      description: "Review trusted evidence without an extra command.",
    }],
    allowedPaths: ["packages/engineer/src/**"],
    deniedPaths: [".env*", ".git/**"],
    allowedCommands: ["bun test packages/engineer/src/focused.test.ts", "bun run typecheck"],
    prohibitedCommands: ["git push"],
    riskTier: "HIGH",
    humanGateRequired: true,
    retryBudgets: {
      sameFailureAttempts: 2,
      builderRepairAttempts: 4,
      reviewerFixAttempts: 2,
      plannerRestarts: 1,
      sandboxProvisioningAttempts: 3,
      transientModelAttempts: 3,
    },
    timeBudgetSeconds: 3_600,
    tokenBudget: 20_000,
    costBudgetUsd: 6,
    createdAt: "2026-07-18T12:00:00.000Z",
  };
  const parentManifest = TaskManifestSchema.parse({ ...parentContent, manifestHash: sha256(parentContent) });
  const consentHash = h("consent");
  const childRunId = hardeningChildRunId(consentHash);
  const authority = createOptionalHardeningChildAuthority({
    schemaVersion: 1,
    policyVersion: "engineer-hardening-child-request-v1",
    rootRunId: "parent-run",
    parentRunId: "parent-run",
    childRunId,
    requesterUserId: "user-1",
    repositoryId: "repo-1",
    parentCheckpointId: h("checkpoint-id"),
    parentCheckpointHash: h("checkpoint-hash"),
    quoteId: h("quote-id"),
    quoteHash: h("quote-hash"),
    consentId: h("consent-id"),
    consentHash,
    advisoryIds: [h("advisory-a"), h("advisory-b")].sort(),
    requiredChanges: [{
      advisoryId: h("advisory-a"),
      requiredChange: "Reject stale signatures before replay claiming.",
      file: "packages/engineer/src/zeta.ts",
      lineStart: 10,
      lineEnd: 20,
    }, {
      advisoryId: h("advisory-b"),
      requiredChange: "Make concurrent claims atomic.",
      file: "packages/engineer/src/alpha.ts",
      lineStart: null,
      lineEnd: null,
    }].sort((left, right) => left.advisoryId < right.advisoryId ? -1 : 1),
    selectionHash: sha256([h("advisory-a"), h("advisory-b")].sort()),
    seedResultCommitSha: "b".repeat(40),
    createdAt: at,
  });
  const budget = { costMicrousd: 425_000, tokens: 8_000, timeSeconds: 900 };
  const lineage = createEngineerRunLineage({
    schemaVersion: 1,
    policyVersion: "engineer-hardening-lineage-v1",
    relation: "OPTIONAL_HARDENING",
    rootRunId: authority.rootRunId,
    parentRunId: authority.parentRunId,
    childRunId,
    requesterUserId: authority.requesterUserId,
    repositoryId: authority.repositoryId,
    parentCheckpointId: authority.parentCheckpointId,
    parentCheckpointHash: authority.parentCheckpointHash,
    parentBaseCommitSha: parentManifest.repository.baseCommitSha,
    seedResultCommitSha: authority.seedResultCommitSha,
    quoteId: authority.quoteId,
    quoteHash: authority.quoteHash,
    consentId: authority.consentId,
    consentHash: authority.consentHash,
    selectionHash: authority.selectionHash,
    budget,
    createdAt: at,
  });
  return {
    authority,
    lineage,
    parentManifest,
    child: { riskTier: "HIGH" as const, humanGateRequired: true as const, budget, createdAt: at },
  };
}

describe("optional hardening deterministic manifest", () => {
  test("builds a golden planner-free manifest with exact scope, command, retry, and budget bounds", () => {
    const input = fixture();
    const first = buildOptionalHardeningManifest(input);
    const second = buildOptionalHardeningManifest(structuredClone(input));
    expect(first).toEqual(second);
    expect(first.status).toBe("READY");
    if (first.status !== "READY") throw new Error("expected ready manifest");

    expect(first.manifest.acceptanceCriteria).toHaveLength(2);
    expect(first.manifest.acceptanceCriteria.map((criterion) => [criterion.statement, criterion.priority])).toEqual(
      input.authority.requiredChanges.map((change) => [change.requiredChange, "MUST"]),
    );
    expect(new Set(first.manifest.acceptanceCriteria.map((criterion) => criterion.criterionId)).size).toBe(2);
    expect(first.manifest.allowedPaths).toEqual([
      "packages/engineer/src/alpha.ts",
      "packages/engineer/src/zeta.ts",
    ]);
    expect(first.manifest.deniedPaths).toEqual(input.parentManifest.deniedPaths);
    expect(first.manifest.allowedCommands).toEqual(input.parentManifest.allowedCommands);
    expect(first.manifest.prohibitedCommands).toEqual(input.parentManifest.prohibitedCommands);
    expect(first.manifest.testPlan.map((item) => item.command ?? null)).toEqual(
      input.parentManifest.testPlan.map((item) => item.command ?? null),
    );
    expect(first.manifest.retryBudgets).toEqual({
      sameFailureAttempts: 0,
      builderRepairAttempts: 0,
      reviewerFixAttempts: 0,
      plannerRestarts: 0,
      sandboxProvisioningAttempts: 0,
      transientModelAttempts: 0,
    });
    expect(first.manifest.repository).toEqual(input.parentManifest.repository);
    expect(first.contextAuthority.seedResultCommitSha).toBe(input.lineage.seedResultCommitSha);
    expect(first.manifest.request.original).toBe(canonicalJson(input.authority));
    expect(first.manifest.request.normalized).toBe(first.manifest.request.original);
    expect({
      cost: first.manifest.costBudgetUsd,
      tokens: first.manifest.tokenBudget,
      time: first.manifest.timeBudgetSeconds,
      risk: first.manifest.riskTier,
      gate: first.manifest.humanGateRequired,
      createdAt: first.manifest.createdAt,
    }).toEqual({ cost: 0.425, tokens: 8_000, time: 900, risk: "HIGH", gate: true, createdAt: at });
    expect(first.contextAuthority.manifestHash).toBe(first.manifest.manifestHash);
    expect({
      plannerCalls: first.contextAuthority.plannerCalls,
      automaticRepairCalls: first.contextAuthority.automaticRepairCalls,
    }).toEqual({ plannerCalls: 0, automaticRepairCalls: 0 });
    expect(OptionalHardeningManifestBuildResultSchema.parse(first)).toEqual(first);

    // Golden hashes make accidental policy drift visible in review.
    expect(first.manifest.manifestHash).toBe("sha256:fa6b54eb16dec0bd7c7d69c58658c59602eb5977b7e5f8448eab3e88c6234c60");
    expect(first.contextAuthority.contextAuthorityHash).toBe("sha256:e6d1c8dff8968a45b1677abca10933d5d92d065d716a8df755fef965e8d8af0a");
  });

  test("returns an explicit environment block before Builder when no inherited test command is executable", () => {
    const input = fixture();
    const content = { ...input.parentManifest };
    const { manifestHash: _hash, ...parent } = content;
    const parentContent = {
      ...parent,
      testPlan: parent.testPlan.map(({ command: _command, ...item }) => item),
      allowedCommands: [],
    };
    const parentManifest = TaskManifestSchema.parse({ ...parentContent, manifestHash: sha256(parentContent) });
    const blocked = buildOptionalHardeningManifest({ ...input, parentManifest });
    expect(blocked).toEqual({
      status: "ENVIRONMENT_BLOCKED",
      reasonCode: "NO_EXECUTABLE_INHERITED_TEST_COMMAND",
      contextAuthority: expect.objectContaining({ outcome: "ENVIRONMENT_BLOCKED", manifestHash: null }),
    });
  });

  test("fails closed on hash tampering, cross-authority mismatches, and scope expansion", () => {
    const input = fixture();
    expect(() => buildOptionalHardeningManifest({
      ...input,
      authority: { ...input.authority, requestHash: h("tampered") },
    })).toThrow();
    expect(() => buildOptionalHardeningManifest({
      ...input,
      lineage: { ...input.lineage, lineageHash: h("tampered") },
    })).toThrow();
    expect(() => buildOptionalHardeningManifest({
      ...input,
      parentManifest: { ...input.parentManifest, manifestHash: h("tampered") },
    })).toThrow();
    expect(() => buildOptionalHardeningManifest({
      ...input,
      child: { ...input.child, budget: { ...input.child.budget, tokens: input.child.budget.tokens + 1 } },
    })).toThrow("budget");

    const { requestHash: _requestHash, ...authorityContent } = input.authority;
    const expandedAuthority = createOptionalHardeningChildAuthority({
      ...authorityContent,
      requiredChanges: input.authority.requiredChanges.map((change, index) => index === 0
        ? { ...change, file: "apps/gateway/src/expanded.ts" }
        : change),
    });
    expect(() => buildOptionalHardeningManifest({ ...input, authority: expandedAuthority }))
      .toThrow("expands");
    expect(() => buildOptionalHardeningManifest({ ...input, injectedPlannerOutput: {} })).toThrow();
  });

  test("rejects tampered context hashes and unknown output fields", () => {
    const result = buildOptionalHardeningManifest(fixture());
    expect(result.status).toBe("READY");
    expect(() => OptionalHardeningContextAuthoritySchema.parse({
      ...result.contextAuthority,
      contextAuthorityHash: h("tampered"),
    })).toThrow("hash mismatch");
    expect(() => OptionalHardeningManifestBuildResultSchema.parse({ ...result, plannerCalls: 1 })).toThrow();
  });
});
