import { z } from "zod";
import { TaskManifestSchema, type TaskManifest } from "./contracts.js";
import { sha256 } from "./hash.js";
import { parseTrustedCommand, TRUSTED_COMMAND_POLICY_VERSION } from "./trusted-executor.js";

export const LEGACY_REQUIRED_LANE_CONTRACT_POLICY_VERSION = "engineer-required-lane-v1";
export const REQUIRED_LANE_CONTRACT_POLICY_VERSION = "engineer-required-lane-v2";

const IdentifierSchema = z.string().min(1).max(200);
const HashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const ShaSchema = z.string().regex(/^[a-f0-9]{40}$|^[a-f0-9]{64}$/i);
const TimestampSchema = z.string().datetime({ offset: true });
const PolicyVersionSchema = z.string().min(1).max(200);

const RepositoryBindingSchema = z.object({
  repositoryId: IdentifierSchema,
  baseBranch: z.string().min(1).max(250),
  baseCommitSha: ShaSchema,
}).strict();

const RequestBindingSchema = z.object({
  originalHash: HashSchema,
  normalizedHash: HashSchema,
}).strict();

const PlanningBindingSchema = z.object({
  contextManifestHash: HashSchema.nullable(),
  planProposalHash: HashSchema.nullable(),
}).strict();

const ScopeBindingSchema = z.object({
  allowedPathsHash: HashSchema,
  deniedPathsHash: HashSchema,
  allowedCommandsHash: HashSchema,
  prohibitedCommandsHash: HashSchema,
}).strict();

const LegacyPolicyBindingsSchema = z.object({
  verificationPolicyVersion: PolicyVersionSchema,
  securityPolicyVersion: PolicyVersionSchema,
  reviewerMappingPolicyVersion: PolicyVersionSchema,
}).strict();

const PolicyBindingsSchema = LegacyPolicyBindingsSchema.extend({
  commandPolicyVersion: z.literal(TRUSTED_COMMAND_POLICY_VERSION),
}).strict();

const RequiredLaneCommonFields = {
  runId: IdentifierSchema,
  manifestHash: HashSchema,
  repositoryBinding: RepositoryBindingSchema,
  requestBinding: RequestBindingSchema,
  planningBinding: PlanningBindingSchema,
  requiredCriterionIds: z.array(IdentifierSchema).min(1),
  requiredTestIds: z.array(IdentifierSchema).min(1),
  scopeBinding: ScopeBindingSchema,
  createdAt: TimestampSchema,
} as const;

const LegacyRequiredLaneContractContentObject = z.object({
  schemaVersion: z.literal(1),
  policyVersion: z.literal(LEGACY_REQUIRED_LANE_CONTRACT_POLICY_VERSION),
  ...RequiredLaneCommonFields,
  policyBindings: LegacyPolicyBindingsSchema,
}).strict();

const RequiredLaneContractContentObject = z.object({
  schemaVersion: z.literal(2),
  policyVersion: z.literal(REQUIRED_LANE_CONTRACT_POLICY_VERSION),
  ...RequiredLaneCommonFields,
  policyBindings: PolicyBindingsSchema,
}).strict();

function requireSortedUnique(values: readonly string[], context: z.RefinementCtx, path: string): void {
  const sorted = [...values].sort();
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: `${path} must be unique`, path: [path] });
  }
  if (values.some((value, index) => value !== sorted[index])) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: `${path} must be sorted`, path: [path] });
  }
}

function validateOrderedIds(
  contract: { requiredCriterionIds: readonly string[]; requiredTestIds: readonly string[] },
  context: z.RefinementCtx,
): void {
  requireSortedUnique(contract.requiredCriterionIds, context, "requiredCriterionIds");
  requireSortedUnique(contract.requiredTestIds, context, "requiredTestIds");
}

export const RequiredLaneContractContentSchema = RequiredLaneContractContentObject
  .superRefine(validateOrderedIds);

const LegacyRequiredLaneContractSchema = LegacyRequiredLaneContractContentObject.extend({
  contractHash: HashSchema,
}).strict().superRefine((contract, context) => {
  validateOrderedIds(contract, context);
  const { contractHash, ...content } = contract;
  if (sha256(content) !== contractHash) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "contractHash does not match canonical contract content", path: ["contractHash"] });
  }
});

const CurrentRequiredLaneContractSchema = RequiredLaneContractContentObject.extend({
  contractHash: HashSchema,
}).strict().superRefine((contract, context) => {
  validateOrderedIds(contract, context);
  const { contractHash, ...content } = contract;
  if (sha256(content) !== contractHash) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "contractHash does not match canonical contract content", path: ["contractHash"] });
  }
});

export const RequiredLaneContractSchema = z.union([
  LegacyRequiredLaneContractSchema,
  CurrentRequiredLaneContractSchema,
]);

export interface CreateRequiredLaneContractInput {
  manifest: TaskManifest;
  contextManifestHash: string | null;
  planProposalHash: string | null;
  policyBindings: z.input<typeof PolicyBindingsSchema>;
}

export interface RequiredLaneContractAuthority {
  planningBinding: z.input<typeof PlanningBindingSchema>;
  policyBindings: z.input<typeof PolicyBindingsSchema>;
}

function sorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

export function createRequiredLaneContract(input: CreateRequiredLaneContractInput): RequiredLaneContract {
  const manifest = TaskManifestSchema.parse(input.manifest);
  const requiredCriterionIds = sorted(manifest.acceptanceCriteria
    .filter((criterion) => criterion.priority === "MUST")
    .map((criterion) => criterion.criterionId));
  if (requiredCriterionIds.length === 0) throw new TypeError("Required Lane contracts require at least one MUST criterion");
  const requiredCriterionSet = new Set(requiredCriterionIds);
  const coveredRequiredCriteria = new Set(manifest.testPlan
    .flatMap((test) => test.criterionIds)
    .filter((criterionId) => requiredCriterionSet.has(criterionId)));
  const uncoveredRequiredCriteria = requiredCriterionIds.filter((criterionId) => !coveredRequiredCriteria.has(criterionId));
  if (uncoveredRequiredCriteria.length > 0) {
    throw new TypeError(`Required Lane contracts require tests for every MUST criterion: ${uncoveredRequiredCriteria.join(", ")}`);
  }
  const requiredTestIds = sorted(manifest.testPlan
    .filter((test) => test.criterionIds.some((criterionId) => requiredCriterionSet.has(criterionId)))
    .map((test) => test.testId));
  if (requiredTestIds.length === 0) throw new TypeError("Required Lane contracts require tests for MUST criteria");
  const requiredTests = manifest.testPlan.filter((test) => requiredTestIds.includes(test.testId));
  const prohibitedCommands = new Set(manifest.prohibitedCommands);
  const nonExecutable = requiredTests.filter((test) => {
    if (!test.command || !manifest.allowedCommands.includes(test.command) || prohibitedCommands.has(test.command)) {
      return true;
    }
    try {
      parseTrustedCommand(test.command);
      return false;
    } catch {
      return true;
    }
  });
  if (nonExecutable.length > 0) {
    throw new TypeError(`Required Lane tests require an executable allowed command: ${nonExecutable.map((test) => test.testId).join(", ")}`);
  }

  const content = RequiredLaneContractContentSchema.parse({
    schemaVersion: 2,
    policyVersion: REQUIRED_LANE_CONTRACT_POLICY_VERSION,
    runId: manifest.runId,
    manifestHash: manifest.manifestHash,
    repositoryBinding: {
      repositoryId: manifest.repository.repositoryId,
      baseBranch: manifest.repository.baseBranch,
      baseCommitSha: manifest.repository.baseCommitSha,
    },
    requestBinding: {
      originalHash: sha256(manifest.request.original),
      normalizedHash: sha256(manifest.request.normalized),
    },
    planningBinding: {
      contextManifestHash: input.contextManifestHash,
      planProposalHash: input.planProposalHash,
    },
    requiredCriterionIds,
    requiredTestIds,
    scopeBinding: {
      allowedPathsHash: sha256(manifest.allowedPaths),
      deniedPathsHash: sha256(manifest.deniedPaths),
      allowedCommandsHash: sha256(manifest.allowedCommands),
      prohibitedCommandsHash: sha256(manifest.prohibitedCommands),
    },
    policyBindings: input.policyBindings,
    createdAt: manifest.createdAt,
  });
  return CurrentRequiredLaneContractSchema.parse({ ...content, contractHash: sha256(content) });
}

export function assertRequiredLaneContractMatchesManifest(
  contract: RequiredLaneContract,
  manifest: TaskManifest,
  authority: RequiredLaneContractAuthority,
): RequiredLaneContract {
  const parsed = RequiredLaneContractSchema.parse(contract);
  if (parsed.schemaVersion !== 2) {
    throw new TypeError("legacy Required Lane contracts cannot authorize a new freeze");
  }
  const planningBinding = PlanningBindingSchema.parse(authority.planningBinding);
  const policyBindings = PolicyBindingsSchema.parse(authority.policyBindings);
  const rebuilt = createRequiredLaneContract({
    manifest,
    contextManifestHash: planningBinding.contextManifestHash,
    planProposalHash: planningBinding.planProposalHash,
    policyBindings,
  });
  if (rebuilt.contractHash !== parsed.contractHash) {
    throw new TypeError("Required Lane contract does not match the frozen manifest");
  }
  return parsed;
}

export type RequiredLaneContractContent = z.infer<typeof RequiredLaneContractContentSchema>;
export type RequiredLaneContract = z.infer<typeof RequiredLaneContractSchema>;
export type RequiredLanePolicyBindings = z.infer<typeof PolicyBindingsSchema>;
