import { z } from "zod";
import { AcceptanceCriterionSchema, TestPlanItemSchema } from "./contracts.js";
import { sha256 } from "./hash.js";

export const CORRECTED_RUN_POLICY_VERSION = "engineer-corrected-run-v1" as const;

export const SafeCorrectionCodeSchema = z.enum([
  "GENERATE_NON_SECRET_TEST_FIXTURES",
  "REMOVE_UNAUTHORIZED_PATH_CHANGES",
  "RESTORE_TEST_BASELINE_INTEGRITY",
  "REPAIR_FAILED_VERIFICATION",
  "ADDRESS_RECORDED_SECURITY_FINDING",
]);

export type SafeCorrectionCode = z.infer<typeof SafeCorrectionCodeSchema>;

export const SafeCorrectionActionSchema = z.object({
  code: SafeCorrectionCodeSchema,
  sourceRecordIds: z.array(z.string().min(1).max(200)).min(1).max(100),
  file: z.string().min(1).max(2_000).nullable(),
  lineStart: z.number().int().nonnegative().nullable(),
  lineEnd: z.number().int().nonnegative().nullable(),
}).strict().refine((action) => action.lineStart === null || action.lineEnd === null || action.lineEnd >= action.lineStart, {
  message: "correction lineEnd must be greater than or equal to lineStart",
  path: ["lineEnd"],
});

const CorrectedRunDirectiveContentShape = {
  policyVersion: z.literal(CORRECTED_RUN_POLICY_VERSION),
  sourceRunId: z.string().min(1).max(200),
  replacementRunId: z.string().min(1).max(200),
  sourceManifestHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  requestOriginalHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  requestNormalized: z.string().min(1).max(100_000),
  acceptanceCriteria: z.array(AcceptanceCriterionSchema).min(1).max(30),
  acceptanceCriteriaHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  testPlan: z.array(TestPlanItemSchema).min(1).max(50),
  allowedPaths: z.array(z.string().min(1).max(2_000)).min(1).max(100),
  deniedPaths: z.array(z.string().min(1).max(2_000)).max(100),
  allowedCommands: z.array(z.string().min(1).max(1_000)).max(100),
  actions: z.array(SafeCorrectionActionSchema).min(1).max(100),
  createdAt: z.string().datetime({ offset: true }),
} as const;

const CorrectedRunDirectiveContentSchema = z.object(CorrectedRunDirectiveContentShape).strict().superRefine((directive, context) => {
  if (sha256(directive.acceptanceCriteria) !== directive.acceptanceCriteriaHash) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "corrected-run acceptance criteria hash mismatch", path: ["acceptanceCriteriaHash"] });
  }
  const actionKeys = directive.actions.map((action) => sha256(action));
  if (new Set(actionKeys).size !== actionKeys.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "corrected-run actions must be unique", path: ["actions"] });
  }
});

export const CorrectedRunDirectiveSchema = z.object({
  ...CorrectedRunDirectiveContentShape,
  directiveHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
}).strict().superRefine((directive, context) => {
  const { directiveHash, ...content } = directive;
  const parsed = CorrectedRunDirectiveContentSchema.safeParse(content);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) context.addIssue(issue);
    return;
  }
  if (sha256(parsed.data) !== directiveHash) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "corrected-run directive hash mismatch", path: ["directiveHash"] });
  }
});

export type CorrectedRunDirective = z.infer<typeof CorrectedRunDirectiveSchema>;
export type SafeCorrectionAction = z.infer<typeof SafeCorrectionActionSchema>;

export function createCorrectedRunDirective(
  content: z.input<typeof CorrectedRunDirectiveContentSchema>,
): CorrectedRunDirective {
  const parsed = CorrectedRunDirectiveContentSchema.parse(content);
  return CorrectedRunDirectiveSchema.parse({ ...parsed, directiveHash: sha256(parsed) });
}

/** Fixed, non-user-authored instructions for the Planner/Builder trust boundary. */
export const SAFE_CORRECTION_DESCRIPTIONS: Readonly<Record<SafeCorrectionCode, string>> = Object.freeze({
  GENERATE_NON_SECRET_TEST_FIXTURES: "Replace credential-like literal test data with deterministic runtime-generated non-secret bytes while preserving test behavior.",
  REMOVE_UNAUTHORIZED_PATH_CHANGES: "Keep the candidate diff within the original manifest allowlist and remove changes outside it.",
  RESTORE_TEST_BASELINE_INTEGRITY: "Restore immutable baseline tests and add coverage only through paths authorized by the original manifest.",
  REPAIR_FAILED_VERIFICATION: "Repair the implementation until the original executable verification plan passes without weakening its assertions.",
  ADDRESS_RECORDED_SECURITY_FINDING: "Address the recorded security finding at its bounded source location without weakening security checks or acceptance criteria.",
});
