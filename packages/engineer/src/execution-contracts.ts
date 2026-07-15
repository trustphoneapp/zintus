import { z } from "zod";
import { LogicalModelTierSchema, ModelRoleSchema } from "./contracts.js";
import { modelTierForRole } from "./model-routing.js";
import { sha256 } from "./hash.js";

const IdentifierSchema = z.string().min(1).max(200);
const HashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const ShaSchema = z.string().regex(/^[a-f0-9]{40}$|^[a-f0-9]{64}$/i);
const IsoTimestampSchema = z.string().datetime({ offset: true });

export const ArtifactRecordSchema = z.object({
  artifactId: IdentifierSchema,
  runId: IdentifierSchema,
  type: z.string().min(1).max(100),
  sha256: HashSchema,
  producerType: z.enum(["EXECUTOR", "SYSTEM"]),
  producerId: IdentifierSchema,
  storageReference: z.string().min(1).max(4_000),
  sizeBytes: z.number().int().nonnegative(),
  trusted: z.boolean(),
  createdAt: IsoTimestampSchema,
}).strict();

export const WorkspaceRecordSchema = z.object({
  workspaceIdentity: IdentifierSchema,
  runId: IdentifierSchema,
  repositoryRoot: z.string().min(1).max(4_000),
  workspaceRoot: z.string().min(1).max(4_000),
  branchName: z.string().min(1).max(250),
  baseCommitSha: ShaSchema,
  originUrl: z.string().max(4_000).nullable(),
  createdAt: IsoTimestampSchema,
}).strict();

export const SandboxRecordSchema = z.object({
  sandboxId: IdentifierSchema,
  runId: IdentifierSchema,
  workspaceIdentity: IdentifierSchema,
  imageReference: z.string().min(1).max(1_000),
  imageDigest: HashSchema,
  environmentDigest: HashSchema,
  networkPolicyVersion: z.string().min(1).max(100),
  sandboxPolicyVersion: z.string().min(1).max(100),
  status: z.enum(["READY", "DESTROYED", "FAILED"]),
  source: z.enum(["COLD", "WARM"]),
  createdAt: IsoTimestampSchema,
  destroyedAt: IsoTimestampSchema.nullable(),
}).strict();

export const SandboxWorkspaceCheckpointSchema = z.object({
  checkpointVersion: z.literal(1),
  runId: IdentifierSchema,
  manifestHash: HashSchema,
  workspace: WorkspaceRecordSchema,
  sandbox: SandboxRecordSchema,
  createdAt: IsoTimestampSchema,
  checkpointHash: HashSchema,
}).strict().superRefine((checkpoint, context) => {
  if (checkpoint.workspace.runId !== checkpoint.runId || checkpoint.sandbox.runId !== checkpoint.runId) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "sandbox checkpoint run binding mismatch", path: ["runId"] });
  }
  if (checkpoint.sandbox.workspaceIdentity !== checkpoint.workspace.workspaceIdentity) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "sandbox checkpoint workspace binding mismatch", path: ["sandbox", "workspaceIdentity"] });
  }
  const { checkpointHash, ...content } = checkpoint;
  if (sha256(content) !== checkpointHash) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "sandbox checkpoint hash mismatch", path: ["checkpointHash"] });
  }
});

export const CommandExecutionRecordSchema = z.object({
  commandExecutionId: IdentifierSchema,
  runId: IdentifierSchema,
  sandboxId: IdentifierSchema,
  command: z.string().min(1).max(1_000),
  executorId: IdentifierSchema,
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean(),
  startedAt: IsoTimestampSchema,
  finishedAt: IsoTimestampSchema,
  stdoutArtifact: ArtifactRecordSchema,
  stderrArtifact: ArtifactRecordSchema,
  environmentDigest: HashSchema,
  commitSha: ShaSchema,
  status: z.enum(["SUCCEEDED", "FAILED", "TIMED_OUT", "SPAWN_FAILED"]),
  idempotencyKey: IdentifierSchema,
}).strict();

export const BuilderResultSchema = z.object({
  runId: IdentifierSchema,
  manifestHash: HashSchema,
  model: z.string().min(1).max(500),
  responseIds: z.array(IdentifierSchema).min(1),
  changedFiles: z.array(z.string().min(1).max(2_000)),
  diff: z.string().max(5_000_000),
  diffHash: HashSchema,
  requestedCommands: z.array(z.string().min(1).max(1_000)),
  commandExecutionIds: z.array(IdentifierSchema),
  implementationSummary: z.string().max(100_000),
  unresolvedLimitations: z.array(z.string().min(1).max(10_000)),
  completedAt: IsoTimestampSchema,
}).strict();

export const AgentExecutionRecordSchema = z.object({
  agentExecutionId: IdentifierSchema,
  runId: IdentifierSchema,
  role: ModelRoleSchema,
  modelTier: LogicalModelTierSchema,
  status: z.enum(["RUNNING", "SUCCEEDED", "FAILED"]),
  inputHash: HashSchema,
  outputArtifactId: IdentifierSchema.nullable(),
  startedAt: IsoTimestampSchema,
  completedAt: IsoTimestampSchema.nullable(),
}).strict().superRefine((record, context) => {
  if (modelTierForRole(record.role) !== record.modelTier) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "agent role/model tier violates central routing policy", path: ["modelTier"] });
  }
});

export const ModelCallRecordSchema = z.object({
  modelCallId: IdentifierSchema,
  runId: IdentifierSchema,
  agentExecutionId: IdentifierSchema,
  logicalTier: LogicalModelTierSchema,
  resolvedModel: z.string().min(1).max(500),
  promptTemplateVersion: z.string().min(1).max(200),
  inputContextRefs: z.array(z.string().min(1).max(2_000)),
  outputSchemaVersion: z.string().max(200).nullable(),
  cacheKey: HashSchema,
  cacheHit: z.boolean().nullable(),
  latencyMs: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  retryCount: z.number().int().nonnegative(),
  status: z.enum(["SUCCEEDED", "FAILED"]),
  createdAt: IsoTimestampSchema,
}).strict();

export type ArtifactRecord = z.infer<typeof ArtifactRecordSchema>;
export type WorkspaceRecord = z.infer<typeof WorkspaceRecordSchema>;
export type SandboxRecord = z.infer<typeof SandboxRecordSchema>;
export type SandboxWorkspaceCheckpoint = z.infer<typeof SandboxWorkspaceCheckpointSchema>;
export type CommandExecutionRecord = z.infer<typeof CommandExecutionRecordSchema>;
export type BuilderResult = z.infer<typeof BuilderResultSchema>;
export type AgentExecutionRecord = z.infer<typeof AgentExecutionRecordSchema>;
export type ModelCallRecord = z.infer<typeof ModelCallRecordSchema>;
