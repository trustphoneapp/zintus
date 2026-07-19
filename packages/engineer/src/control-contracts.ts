import { z } from "zod";
import {
  FailureClassSchema, LegacySupervisorPrCommandSchema, RiskTierSchema, SupervisorPrCommandSchema,
} from "./contracts.js";

const IdentifierSchema = z.string().min(1).max(200);
const HashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const ShaSchema = z.string().regex(/^[a-f0-9]{40}$|^[a-f0-9]{64}$/i);
const TimestampSchema = z.string().datetime({ offset: true });

const ApprovalRequestBaseSchema = z.object({
  approvalRequestId: IdentifierSchema,
  runId: IdentifierSchema,
  riskTier: RiskTierSchema,
  assignedReviewerId: IdentifierSchema.nullable(),
  requestedAt: TimestampSchema,
  deadlineAt: TimestampSchema,
  reminderSchedule: z.array(TimestampSchema),
  timeoutAction: z.enum(["PAUSE", "HUMAN_REVIEW_REQUIRED", "REJECT", "SECURITY_ESCALATION"]),
  manifestHash: HashSchema,
  diffHash: HashSchema,
  evidenceBundleHash: HashSchema,
  reviewerSessionId: IdentifierSchema.nullable().optional(),
  classificationHash: HashSchema.nullable().optional(),
  classificationResult: z.enum(["READY_WITH_ADVISORIES", "READY"]).nullable().optional(),
  status: z.enum(["PENDING", "APPROVED", "CHANGES_REQUESTED", "REJECTED", "EXPIRED", "CANCELLED"]),
  approvalRevision: z.number().int().nonnegative(),
}).strict();

/** Write contract for every v22+ approval request. */
export const ApprovalRequestRecordSchema = ApprovalRequestBaseSchema.extend({
  status: z.literal("PENDING"),
  approvalRevision: z.literal(0),
  verifiedCheckpointId: HashSchema,
  verifiedCheckpointHash: HashSchema,
}).strict();

const CheckpointBoundApprovalRequestReadRecordSchema = ApprovalRequestBaseSchema.extend({
  verifiedCheckpointId: HashSchema,
  verifiedCheckpointHash: HashSchema,
}).strict();

/** Read-only compatibility for rows created before checkpoint binding existed. */
export const LegacyApprovalRequestRecordSchema = ApprovalRequestBaseSchema.extend({
  verifiedCheckpointId: z.null().optional(),
  verifiedCheckpointHash: z.null().optional(),
}).strict();
export const ApprovalRequestReadRecordSchema = z.union([
  CheckpointBoundApprovalRequestReadRecordSchema, LegacyApprovalRequestRecordSchema,
]);

const ApprovalDecisionBaseSchema = z.object({
  approvalDecisionId: IdentifierSchema,
  approvalRequestId: IdentifierSchema,
  actorId: IdentifierSchema,
  decision: z.enum(["APPROVE", "REQUEST_CHANGES", "REJECT", "EXTEND"]),
  reason: z.string().max(10_000),
  decidedAt: TimestampSchema,
}).strict();

/** Human decisions remain separate records but bind the exact reviewed checkpoint. */
export const ApprovalDecisionRecordSchema = ApprovalDecisionBaseSchema.extend({
  expectedApprovalRevision: z.number().int().nonnegative(),
  expectedVerifiedCheckpointId: HashSchema,
  expectedVerifiedCheckpointHash: HashSchema,
}).strict();

/** Browser/server compare-and-swap authority captured from the displayed approval. */
export const ApprovalAuthorityExpectationSchema = z.object({
  expectedVerifiedCheckpointId: HashSchema,
  expectedVerifiedCheckpointHash: HashSchema,
  expectedApprovalRevision: z.number().int().nonnegative(),
}).strict();
export const LegacyApprovalDecisionRecordSchema = ApprovalDecisionBaseSchema.extend({
  expectedApprovalRevision: z.null().optional(),
  expectedVerifiedCheckpointId: z.null().optional(),
  expectedVerifiedCheckpointHash: z.null().optional(),
}).strict();
export const ApprovalDecisionReadRecordSchema = z.union([
  ApprovalDecisionRecordSchema, LegacyApprovalDecisionRecordSchema,
]);

export const GitOperationStatusSchema = z.enum(["STARTED", "SUCCEEDED", "FAILED", "STALE"]);

export type GitOperationStatus = z.infer<typeof GitOperationStatusSchema>;

/** Durable operation fencing: STARTED is an exclusive claim, not replayable. */
export function canTransitionGitOperationStatus(current: GitOperationStatus, next: GitOperationStatus): boolean {
  if (current === "STARTED") return next === "SUCCEEDED" || next === "FAILED" || next === "STALE";
  if (current === "FAILED") return next === "STARTED" || next === "FAILED";
  if (current === "STALE") return next === "STALE";
  return current === "SUCCEEDED" && next === "SUCCEEDED";
}

const GitOperationBaseSchema = z.object({
  gitOperationId: IdentifierSchema,
  runId: IdentifierSchema,
  operationType: z.enum(["CREATE_BRANCH", "PUSH_COMMIT", "CREATE_PR", "INSPECT_BASE", "REBASE_CANDIDATE"]),
  requestedBy: z.literal("SUPERVISOR"),
  idempotencyKey: z.string().min(1).max(500),
  expectedBaseCommitSha: ShaSchema,
  resultCommitSha: ShaSchema.nullable(),
  approvalId: IdentifierSchema.nullable(),
  evidenceBundleHash: HashSchema.nullable(),
  status: GitOperationStatusSchema,
  remoteReference: z.string().max(4_000).nullable(),
  startedAt: TimestampSchema,
  completedAt: TimestampSchema.nullable(),
  errorCode: z.string().max(200).nullable(),
}).strict();

/** Write contract for every v22+ credentialed Git operation. */
export const GitOperationRecordSchema = GitOperationBaseSchema.extend({
  verifiedCheckpointId: HashSchema,
  verifiedCheckpointHash: HashSchema,
}).strict();
export const LegacyGitOperationRecordSchema = GitOperationBaseSchema.extend({
  verifiedCheckpointId: z.null().optional(),
  verifiedCheckpointHash: z.null().optional(),
}).strict();
export const GitOperationReadRecordSchema = z.union([
  GitOperationRecordSchema, LegacyGitOperationRecordSchema,
]);

export function hasUnreconciledRemotePublication(operations: readonly GitOperationRecord[]): boolean {
  return operations.some((operation) =>
    operation.operationType === "CREATE_BRANCH" ||
    operation.operationType === "PUSH_COMMIT" ||
    operation.operationType === "CREATE_PR");
}

export const FailureRecordSchema = z.object({
  failureId: IdentifierSchema,
  runId: IdentifierSchema,
  failureClass: FailureClassSchema,
  reasonCode: z.string().regex(/^[A-Z][A-Z0-9_]{1,127}$/),
  fingerprint: HashSchema,
  evidenceIds: z.array(IdentifierSchema),
  retryable: z.boolean(),
  createdAt: TimestampSchema,
}).strict();

export const SignedSupervisorPrCommandSchema = z.object({
  command: SupervisorPrCommandSchema,
  signature: z.string().regex(/^hmac-sha256:[a-f0-9]{64}$/),
}).strict();
export const LegacySignedSupervisorPrCommandSchema = z.object({
  command: LegacySupervisorPrCommandSchema,
  signature: z.string().regex(/^hmac-sha256:[a-f0-9]{64}$/),
}).strict();

export const PublicationEvidenceSchema = z.object({
  runId: IdentifierSchema,
  reviewerSessionId: IdentifierSchema,
  reviewerDecision: z.enum(["APPROVE", "REQUEST_CHANGES", "REJECT", "HUMAN_REVIEW_REQUIRED"]),
  classificationHash: HashSchema,
  classificationResult: z.enum(["READY_WITH_ADVISORIES", "READY"]),
  reviewerDiffHash: HashSchema,
  reviewerEvidenceBundleHash: HashSchema,
  reviewerIsolationVerified: z.literal(true),
  evidenceBundleId: IdentifierSchema,
  evidenceBundleHash: HashSchema,
  resultCommitSha: ShaSchema,
  allRequiredChecksPassed: z.boolean(),
  openCriticalSecurityFindings: z.number().int().nonnegative(),
}).strict();

export const TestExecutionViewSchema = z.object({
  testExecutionId: IdentifierSchema,
  runId: IdentifierSchema,
  commandExecutionId: IdentifierSchema,
  type: z.string().min(1).max(100),
  status: z.enum(["PASSED", "FAILED", "TIMED_OUT", "BLOCKED"]),
  startedAt: TimestampSchema,
  completedAt: TimestampSchema,
}).strict();

export type ApprovalRequestRecord = z.infer<typeof ApprovalRequestReadRecordSchema>;
export type NewApprovalRequestRecord = z.infer<typeof ApprovalRequestRecordSchema>;
export type ApprovalDecisionRecord = z.infer<typeof ApprovalDecisionReadRecordSchema>;
export type NewApprovalDecisionRecord = z.infer<typeof ApprovalDecisionRecordSchema>;
export type ApprovalAuthorityExpectation = z.infer<typeof ApprovalAuthorityExpectationSchema>;
export type GitOperationRecord = z.infer<typeof GitOperationReadRecordSchema>;
export type NewGitOperationRecord = z.infer<typeof GitOperationRecordSchema>;
export type FailureRecord = z.infer<typeof FailureRecordSchema>;
export type SignedSupervisorPrCommand = z.infer<typeof SignedSupervisorPrCommandSchema>;
export type LegacySignedSupervisorPrCommand = z.infer<typeof LegacySignedSupervisorPrCommandSchema>;
export type PublicationEvidence = z.infer<typeof PublicationEvidenceSchema>;
export type TestExecutionView = z.infer<typeof TestExecutionViewSchema>;
