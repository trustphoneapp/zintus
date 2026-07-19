import { z } from "zod";
import { canonicalJson, sha256 } from "./hash.js";
import { CanonicalBlockerSchema } from "./resolution-case.js";

export const RESOLUTION_PLANNING_CONTEXT_POLICY_VERSION = "engineer-resolution-planning-context-v1" as const;

const ResolutionPlanningContextContentSchema = z.object({
  policyVersion: z.literal(RESOLUTION_PLANNING_CONTEXT_POLICY_VERSION),
  replacementRunId: z.string().min(1).max(200),
  sourceRunId: z.string().min(1).max(200),
  caseId: z.string().min(1).max(200),
  directiveId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  directiveHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  kind: z.enum(["CORRECTED", "REVERIFY"]),
  sourceManifestHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  sourceRequiredLaneContractHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  blockers: z.array(CanonicalBlockerSchema).max(100),
  createdAt: z.string().datetime({ offset: true }),
}).strict();

export const ResolutionPlanningContextSchema = ResolutionPlanningContextContentSchema.extend({
  contextHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
}).strict().superRefine((context, refinement) => {
  const { contextHash, ...content } = context;
  if (sha256(content) !== contextHash) {
    refinement.addIssue({ code: z.ZodIssueCode.custom, message: "resolution planning context hash mismatch", path: ["contextHash"] });
  }
});

export type ResolutionPlanningContext = z.infer<typeof ResolutionPlanningContextSchema>;

export function createResolutionPlanningContext(
  input: z.input<typeof ResolutionPlanningContextContentSchema>,
): ResolutionPlanningContext {
  const content = ResolutionPlanningContextContentSchema.parse(input);
  return ResolutionPlanningContextSchema.parse({ ...content, contextHash: sha256(content) });
}

export function resolutionPlanningContextJson(context: ResolutionPlanningContext): string {
  return canonicalJson(ResolutionPlanningContextSchema.parse(context));
}
