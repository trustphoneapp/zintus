import {
  type AdvisoryBacklogItem,
  createOptionalHardeningChildAuthority,
  hardeningChildRunId,
} from "./advisory-hardening-contracts.js";
import { builderInputTokenCountRequest } from "./codex-builder.js";
import { TaskManifestContentSchema, TaskManifestSchema, type TaskManifest } from "./contracts.js";
import { canonicalJson, sha256 } from "./hash.js";
import type { DeterministicHardeningEstimateV2 } from "./hardening-estimator.js";
import { DEFAULT_MODEL_BY_TIER } from "./model-routing.js";

const PLACEHOLDER_HASH = `sha256:${"f".repeat(64)}`;
const SIZING_INSTANT = "9999-12-31T23:59:59.999Z";

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function criterionId(advisoryId: string): string {
  return `hardening-criterion-${sha256({
    namespace: "engineer-hardening-criterion-v1",
    advisoryId,
  }).slice("sha256:".length)}`;
}

/**
 * Builds a deterministic, conservative first-Builder request before consent.
 * Unknown future hashes use equal-width values, the quote maximum budget is
 * used, and the longest risk label is selected. The measured request includes
 * the exact production Builder instructions and tool schema.
 */
export function hardeningBuilderSizingTemplate(input: {
  parentManifest: TaskManifest;
  advisories: readonly AdvisoryBacklogItem[];
  parentRunId: string;
  rootRunId: string;
  requesterUserId: string;
  repositoryId: string;
  parentCheckpointId: string;
  parentCheckpointHash: string;
  seedResultCommitSha: string;
  estimate: DeterministicHardeningEstimateV2;
}): { manifest: TaskManifest; request: Record<string, unknown> } {
  const advisories = [...input.advisories].sort((left, right) => codeUnitCompare(left.advisoryId, right.advisoryId));
  const consentHash = PLACEHOLDER_HASH;
  const childRunId = hardeningChildRunId(consentHash);
  const authority = createOptionalHardeningChildAuthority({
    schemaVersion: 1,
    policyVersion: "engineer-hardening-child-request-v1",
    rootRunId: input.rootRunId,
    parentRunId: input.parentRunId,
    childRunId,
    requesterUserId: input.requesterUserId,
    repositoryId: input.repositoryId,
    parentCheckpointId: input.parentCheckpointId,
    parentCheckpointHash: input.parentCheckpointHash,
    quoteId: PLACEHOLDER_HASH,
    quoteHash: PLACEHOLDER_HASH,
    consentId: PLACEHOLDER_HASH,
    consentHash,
    advisoryIds: advisories.map((item) => item.advisoryId),
    requiredChanges: advisories.map((item) => ({
      advisoryId: item.advisoryId,
      requiredChange: item.requiredChange,
      file: item.file!,
      lineStart: item.lineStart,
      lineEnd: item.lineEnd,
    })),
    selectionHash: sha256(advisories.map((item) => item.advisoryId)),
    seedResultCommitSha: input.seedResultCommitSha,
    createdAt: SIZING_INSTANT,
  });
  const requestBytes = canonicalJson(authority);
  const criterionIds = advisories.map((item) => criterionId(item.advisoryId));
  const manifestContent = TaskManifestContentSchema.parse({
    manifestVersion: 1,
    runId: childRunId,
    repository: input.parentManifest.repository,
    request: { original: requestBytes, normalized: requestBytes },
    acceptanceCriteria: advisories.map((item, index) => ({
      criterionId: criterionIds[index]!,
      statement: item.requiredChange,
      verificationMethod: "Verify with the inherited frozen test plan and trusted evidence.",
      priority: "MUST" as const,
    })),
    testPlan: input.parentManifest.testPlan.map((item) => ({ ...item, criterionIds })),
    allowedPaths: [...new Set(advisories.map((item) => item.file!))].sort(codeUnitCompare),
    deniedPaths: input.parentManifest.deniedPaths,
    allowedCommands: input.parentManifest.allowedCommands,
    prohibitedCommands: input.parentManifest.prohibitedCommands,
    riskTier: "CRITICAL" as const,
    humanGateRequired: true,
    retryBudgets: {
      sameFailureAttempts: 0, builderRepairAttempts: 0, reviewerFixAttempts: 0,
      plannerRestarts: 0, sandboxProvisioningAttempts: 0, transientModelAttempts: 0,
    },
    timeBudgetSeconds: input.estimate.estimate.maxTimeSeconds,
    tokenBudget: input.estimate.estimate.maxTokens,
    costBudgetUsd: input.estimate.estimate.maxCostMicrousd / 1_000_000,
    createdAt: SIZING_INSTANT,
  });
  const manifest = TaskManifestSchema.parse({ ...manifestContent, manifestHash: sha256(manifestContent) });
  return {
    manifest,
    request: builderInputTokenCountRequest({
      manifest,
      model: DEFAULT_MODEL_BY_TIER["GPT-5.6_TERRA"],
    }),
  };
}
