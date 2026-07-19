import { z } from "zod";
import {
  RiskTierSchema,
  TaskManifestContentSchema,
  TaskManifestSchema,
  type TaskManifest,
  type TaskManifestContent,
} from "./contracts.js";
import {
  EngineerRunLineageSchema,
  OptionalHardeningChildAuthoritySchema,
} from "./advisory-hardening-contracts.js";
import { canonicalJson, sha256 } from "./hash.js";
import { isManifestPathAllowed } from "./manifest-files.js";
import { parseTrustedCommand } from "./trusted-executor.js";

export const OPTIONAL_HARDENING_MANIFEST_POLICY_VERSION = "engineer-hardening-manifest-v1";

const HashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const BudgetSchema = z.object({
  costMicrousd: z.number().int().positive(),
  tokens: z.number().int().positive(),
  timeSeconds: z.number().int().positive(),
}).strict();

export const OptionalHardeningManifestInputSchema = z.object({
  authority: OptionalHardeningChildAuthoritySchema,
  lineage: EngineerRunLineageSchema,
  parentManifest: TaskManifestSchema,
  child: z.object({
    riskTier: RiskTierSchema,
    humanGateRequired: z.literal(true),
    budget: BudgetSchema,
    createdAt: z.string().datetime({ offset: true }),
  }).strict(),
}).strict();

const OptionalHardeningContextAuthorityContentSchema = z.object({
  schemaVersion: z.literal(1),
  policyVersion: z.literal(OPTIONAL_HARDENING_MANIFEST_POLICY_VERSION),
  outcome: z.enum(["READY", "ENVIRONMENT_BLOCKED"]),
  childRunId: z.string().min(1).max(200),
  repositoryId: z.string().min(1).max(200),
  requestHash: HashSchema,
  parentManifestHash: HashSchema,
  lineageId: HashSchema,
  lineageHash: HashSchema,
  seedResultCommitSha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  selectionHash: HashSchema,
  allowedPathsHash: HashSchema,
  inheritedCommandsHash: HashSchema,
  budget: BudgetSchema,
  riskTier: RiskTierSchema,
  humanGateRequired: z.literal(true),
  plannerCalls: z.literal(0),
  automaticRepairCalls: z.literal(0),
  createdAt: z.string().datetime({ offset: true }),
  manifestHash: HashSchema.nullable(),
}).strict();

export const OptionalHardeningContextAuthoritySchema = OptionalHardeningContextAuthorityContentSchema.extend({
  contextAuthorityHash: HashSchema,
}).strict().superRefine((authority, context) => {
  const { contextAuthorityHash, ...content } = authority;
  if (sha256(content) !== contextAuthorityHash) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "hardening context authority hash mismatch",
      path: ["contextAuthorityHash"],
    });
  }
  if ((authority.outcome === "READY") !== (authority.manifestHash !== null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "only ready hardening context may bind a manifest",
      path: ["manifestHash"],
    });
  }
});

export const OptionalHardeningManifestReadySchema = z.object({
  status: z.literal("READY"),
  manifest: TaskManifestSchema,
  contextAuthority: OptionalHardeningContextAuthoritySchema,
}).strict().superRefine((result, context) => {
  if (result.contextAuthority.outcome !== "READY" ||
      result.contextAuthority.manifestHash !== result.manifest.manifestHash) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "context authority does not bind the manifest" });
  }
});

export const OptionalHardeningManifestBlockedSchema = z.object({
  status: z.literal("ENVIRONMENT_BLOCKED"),
  reasonCode: z.literal("NO_EXECUTABLE_INHERITED_TEST_COMMAND"),
  contextAuthority: OptionalHardeningContextAuthoritySchema,
}).strict().superRefine((result, context) => {
  if (result.contextAuthority.outcome !== "ENVIRONMENT_BLOCKED" || result.contextAuthority.manifestHash !== null) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "blocked context authority cannot bind a manifest" });
  }
});

export const OptionalHardeningManifestBuildResultSchema = z.union([
  OptionalHardeningManifestReadySchema,
  OptionalHardeningManifestBlockedSchema,
]);

function assertInputRelations(input: z.infer<typeof OptionalHardeningManifestInputSchema>): void {
  const { authority, lineage, parentManifest, child } = input;
  if (authority.rootRunId !== lineage.rootRunId || authority.parentRunId !== lineage.parentRunId ||
      authority.childRunId !== lineage.childRunId || authority.requesterUserId !== lineage.requesterUserId ||
      authority.repositoryId !== lineage.repositoryId || authority.parentCheckpointId !== lineage.parentCheckpointId ||
      authority.parentCheckpointHash !== lineage.parentCheckpointHash || authority.quoteId !== lineage.quoteId ||
      authority.quoteHash !== lineage.quoteHash || authority.consentId !== lineage.consentId ||
      authority.consentHash !== lineage.consentHash || authority.selectionHash !== lineage.selectionHash ||
      authority.seedResultCommitSha !== lineage.seedResultCommitSha || authority.createdAt !== lineage.createdAt) {
    throw new TypeError("hardening manifest authority does not match exact lineage");
  }
  if (parentManifest.runId !== lineage.parentRunId ||
      parentManifest.repository.repositoryId !== lineage.repositoryId ||
      parentManifest.repository.baseCommitSha !== lineage.parentBaseCommitSha) {
    throw new TypeError("hardening parent manifest does not match exact lineage repository authority");
  }
  if (canonicalJson(child.budget) !== canonicalJson(lineage.budget) || child.createdAt !== lineage.createdAt) {
    throw new TypeError("hardening child budget or creation instant does not match lineage");
  }
  for (const change of authority.requiredChanges) {
    if (!isManifestPathAllowed(change.file, parentManifest)) {
      throw new TypeError("hardening selected file expands the parent manifest scope");
    }
  }
}

function criterionId(advisoryId: string): string {
  return `hardening-criterion-${sha256({
    namespace: "engineer-hardening-criterion-v1",
    advisoryId,
  }).slice("sha256:".length)}`;
}

function executableInheritedTestCommands(parent: TaskManifest): string[] {
  const allowed = new Set(parent.allowedCommands);
  const prohibited = new Set(parent.prohibitedCommands);
  const commands: string[] = [];
  for (const item of parent.testPlan) {
    if (!item.command || !allowed.has(item.command) || prohibited.has(item.command)) continue;
    try {
      parseTrustedCommand(item.command);
      commands.push(item.command);
    } catch {
      // A planner-free child cannot repair or reinterpret a non-executable command.
    }
  }
  return commands;
}

function contextAuthority(
  input: z.infer<typeof OptionalHardeningManifestInputSchema>,
  outcome: "READY" | "ENVIRONMENT_BLOCKED",
  allowedPaths: string[],
  manifestHash: string | null,
) {
  const content = OptionalHardeningContextAuthorityContentSchema.parse({
    schemaVersion: 1,
    policyVersion: OPTIONAL_HARDENING_MANIFEST_POLICY_VERSION,
    outcome,
    childRunId: input.authority.childRunId,
    repositoryId: input.authority.repositoryId,
    requestHash: input.authority.requestHash,
    parentManifestHash: input.parentManifest.manifestHash,
    lineageId: input.lineage.lineageId,
    lineageHash: input.lineage.lineageHash,
    seedResultCommitSha: input.lineage.seedResultCommitSha,
    selectionHash: input.lineage.selectionHash,
    allowedPathsHash: sha256(allowedPaths),
    inheritedCommandsHash: sha256({
      allowedCommands: input.parentManifest.allowedCommands,
      prohibitedCommands: input.parentManifest.prohibitedCommands,
      testPlanCommands: input.parentManifest.testPlan.map((item) => item.command ?? null),
    }),
    budget: input.child.budget,
    riskTier: input.child.riskTier,
    humanGateRequired: true,
    plannerCalls: 0,
    automaticRepairCalls: 0,
    createdAt: input.child.createdAt,
    manifestHash,
  });
  return OptionalHardeningContextAuthoritySchema.parse({
    ...content,
    contextAuthorityHash: sha256(content),
  });
}

/**
 * Pure, planner-free P5 builder. It derives every mutable field from durable P4
 * authority and the parent's already-frozen manifest; it never calls a model.
 */
export function buildOptionalHardeningManifest(rawInput: unknown) {
  const input = OptionalHardeningManifestInputSchema.parse(rawInput);
  assertInputRelations(input);

  const allowedPaths = [...new Set(input.authority.requiredChanges.map((change) => change.file))]
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  if (executableInheritedTestCommands(input.parentManifest).length === 0) {
    return OptionalHardeningManifestBuildResultSchema.parse({
      status: "ENVIRONMENT_BLOCKED",
      reasonCode: "NO_EXECUTABLE_INHERITED_TEST_COMMAND",
      contextAuthority: contextAuthority(input, "ENVIRONMENT_BLOCKED", allowedPaths, null),
    });
  }

  const acceptanceCriteria = input.authority.requiredChanges.map((change) => ({
    criterionId: criterionId(change.advisoryId),
    statement: change.requiredChange,
    verificationMethod: "Verify with the inherited frozen test plan and trusted evidence.",
    priority: "MUST" as const,
  }));
  const criterionIds = acceptanceCriteria.map((criterion) => criterion.criterionId);
  const requestBytes = canonicalJson(input.authority);
  const manifestContent: TaskManifestContent = TaskManifestContentSchema.parse({
    manifestVersion: 1,
    runId: input.authority.childRunId,
    // The manifest must match the persisted child run repository snapshot.
    // seedResultCommitSha remains a separate, hash-bound sandbox seed authority.
    repository: input.parentManifest.repository,
    request: { original: requestBytes, normalized: requestBytes },
    acceptanceCriteria,
    testPlan: input.parentManifest.testPlan.map((item) => ({ ...item, criterionIds })),
    allowedPaths,
    deniedPaths: input.parentManifest.deniedPaths,
    allowedCommands: input.parentManifest.allowedCommands,
    prohibitedCommands: input.parentManifest.prohibitedCommands,
    riskTier: input.child.riskTier,
    humanGateRequired: true,
    retryBudgets: {
      sameFailureAttempts: 0,
      builderRepairAttempts: 0,
      reviewerFixAttempts: 0,
      plannerRestarts: 0,
      sandboxProvisioningAttempts: 0,
      transientModelAttempts: 0,
    },
    timeBudgetSeconds: input.child.budget.timeSeconds,
    tokenBudget: input.child.budget.tokens,
    costBudgetUsd: input.child.budget.costMicrousd / 1_000_000,
    createdAt: input.child.createdAt,
  });
  const manifest = TaskManifestSchema.parse({ ...manifestContent, manifestHash: sha256(manifestContent) });
  return OptionalHardeningManifestBuildResultSchema.parse({
    status: "READY",
    manifest,
    contextAuthority: contextAuthority(input, "READY", allowedPaths, manifest.manifestHash),
  });
}

export type OptionalHardeningContextAuthority = z.infer<typeof OptionalHardeningContextAuthoritySchema>;
export type OptionalHardeningManifestBuildResult = z.infer<typeof OptionalHardeningManifestBuildResultSchema>;
