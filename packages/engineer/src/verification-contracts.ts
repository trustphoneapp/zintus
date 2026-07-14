import { z } from "zod";
import { EvidenceBundleSchema, ReviewerOutputSchema } from "./contracts.js";

const IdentifierSchema = z.string().min(1).max(200);
const HashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const IsoTimestampSchema = z.string().datetime({ offset: true });

export const VerificationExecutionRecordSchema = z.object({
  verificationExecutionId: IdentifierSchema,
  runId: IdentifierSchema,
  testId: IdentifierSchema,
  commandExecutionId: IdentifierSchema,
  criterionIds: z.array(IdentifierSchema).min(1),
  type: z.enum(["FORMAT", "LINT", "TYPECHECK", "BUILD", "UNIT", "INTEGRATION", "E2E", "SECURITY", "MIGRATION", "REGRESSION"]),
  randomSeed: z.string().max(500).nullable(),
  status: z.enum(["PASSED", "FAILED", "TIMED_OUT", "BLOCKED"]),
  startedAt: IsoTimestampSchema,
  completedAt: IsoTimestampSchema,
}).strict();

export const SecurityFindingRecordSchema = z.object({
  securityFindingId: IdentifierSchema,
  runId: IdentifierSchema,
  severity: z.enum(["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"]),
  category: z.string().min(1).max(200),
  description: z.string().min(1).max(10_000),
  file: z.string().max(2_000).nullable(),
  lineStart: z.number().int().nonnegative().nullable(),
  lineEnd: z.number().int().nonnegative().nullable(),
  evidenceIds: z.array(IdentifierSchema),
  status: z.enum(["OPEN", "RESOLVED", "ACCEPTED_RISK"]),
  createdAt: IsoTimestampSchema,
}).strict().refine((finding) => finding.lineStart === null || finding.lineEnd === null || finding.lineEnd >= finding.lineStart, {
  message: "lineEnd must be greater than or equal to lineStart",
  path: ["lineEnd"],
});

export const ReviewerSessionRecordSchema = z.object({
  reviewerSessionId: IdentifierSchema,
  runId: IdentifierSchema,
  attempt: z.number().int().positive(),
  modelTier: z.literal("GPT-5.6_SOL"),
  resolvedModel: z.string().min(1).max(500),
  inputHash: HashSchema,
  manifestHash: HashSchema,
  diffHash: HashSchema,
  evidenceBundleHash: HashSchema,
  policyVersion: z.string().min(1).max(200),
  cacheKey: HashSchema,
  cacheHit: z.boolean().nullable(),
  startedAt: IsoTimestampSchema,
  completedAt: IsoTimestampSchema,
  decision: z.enum(["APPROVE", "REQUEST_CHANGES", "REJECT", "HUMAN_REVIEW_REQUIRED"]),
  isolationVerified: z.boolean(),
  output: ReviewerOutputSchema,
}).strict();

export const ReviewFindingRecordSchema = z.object({
  reviewerSessionId: IdentifierSchema,
  findingId: IdentifierSchema,
  fingerprint: HashSchema,
  severity: z.enum(["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"]),
  category: z.string().min(1).max(200),
  file: z.string().max(2_000),
  lineStart: z.number().int().nonnegative(),
  lineEnd: z.number().int().nonnegative(),
  description: z.string().min(1).max(10_000),
  requiredChange: z.string().min(1).max(10_000),
  criterionIds: z.array(IdentifierSchema),
  evidenceIds: z.array(IdentifierSchema),
  status: z.enum(["OPEN", "RESOLVED", "REJECTED"]),
}).strict();

export const ClaimEvidenceRecordSchema = z.object({
  claimId: IdentifierSchema,
  claim: z.string().min(1).max(10_000),
  status: z.enum([
    "VERIFIED", "PARTIALLY_VERIFIED", "FAILED", "UNVERIFIED",
    "BLOCKED_BY_INFRASTRUCTURE", "BLOCKED_BY_EXTERNAL_DEPENDENCY", "HUMAN_REVIEW_REQUIRED",
  ]),
  evidenceIds: z.array(IdentifierSchema),
  notes: z.string().max(10_000),
  runId: IdentifierSchema,
  criterionId: IdentifierSchema.nullable(),
  createdAt: IsoTimestampSchema,
}).strict().superRefine((claim, context) => {
  if (claim.status === "VERIFIED" && claim.evidenceIds.length === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "VERIFIED claims require evidence", path: ["evidenceIds"] });
  }
});

export const EvidenceBundleRecordSchema = z.object({
  evidenceBundleId: IdentifierSchema,
  bundle: EvidenceBundleSchema,
  bundleHash: HashSchema,
}).strict();

export const VerificationResultSchema = z.object({
  runId: IdentifierSchema,
  verificationExecutions: z.array(VerificationExecutionRecordSchema),
  securityFindings: z.array(SecurityFindingRecordSchema),
  reviewerSession: ReviewerSessionRecordSchema,
  claims: z.array(ClaimEvidenceRecordSchema),
  evidenceBundle: EvidenceBundleRecordSchema,
}).strict();

export type VerificationExecutionRecord = z.infer<typeof VerificationExecutionRecordSchema>;
export type SecurityFindingRecord = z.infer<typeof SecurityFindingRecordSchema>;
export type ReviewerSessionRecord = z.infer<typeof ReviewerSessionRecordSchema>;
export type ReviewFindingRecord = z.infer<typeof ReviewFindingRecordSchema>;
export type ClaimEvidenceRecord = z.infer<typeof ClaimEvidenceRecordSchema>;
export type EvidenceBundleRecord = z.infer<typeof EvidenceBundleRecordSchema>;
export type VerificationResult = z.infer<typeof VerificationResultSchema>;
