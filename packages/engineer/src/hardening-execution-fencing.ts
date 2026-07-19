import { z } from "zod";
import { sha256 } from "./hash.js";

export const HARDENING_START_CLAIM_POLICY_VERSION = "engineer-hardening-start-claim-v1" as const;
export const HARDENING_MODEL_CALL_SLOT_POLICY_VERSION = "engineer-hardening-model-call-slot-v1" as const;

const Identifier = z.string().min(1).max(200);
const Hash = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const Timestamp = z.string().datetime({ offset: false, precision: 3 });

export const HardeningStartClaimIntentSchema = z.object({
  schemaVersion: z.literal(1),
  policyVersion: z.literal(HARDENING_START_CLAIM_POLICY_VERSION),
  requesterUserId: Identifier,
  rootRunId: Identifier,
  parentRunId: Identifier,
  childRunId: Identifier,
  repositoryId: Identifier,
  parentCheckpointId: Hash,
  parentCheckpointHash: Hash,
  lineageId: Hash,
  lineageHash: Hash,
  quoteId: Hash,
  quoteHash: Hash,
  consentId: Hash,
  consentHash: Hash,
  operationId: Hash,
  operationHash: Hash,
  idempotencyKey: Identifier,
}).strict();

export function createHardeningStartClaimIntent(input: Omit<z.input<typeof HardeningStartClaimIntentSchema>, "schemaVersion" | "policyVersion">) {
  const intent = HardeningStartClaimIntentSchema.parse({
    schemaVersion: 1,
    policyVersion: HARDENING_START_CLAIM_POLICY_VERSION,
    ...input,
  });
  const intentHash = sha256(intent);
  return {
    intent,
    intentHash,
    claimId: sha256({ namespace: HARDENING_START_CLAIM_POLICY_VERSION, childRunId: intent.childRunId, intentHash }),
  };
}

export const HardeningStartFenceSchema = z.object({
  claimId: Hash,
  intentHash: Hash,
  childRunId: Identifier,
  status: z.enum(["PREPARING", "FINALIZED"]),
  ownerId: Identifier,
  fenceToken: Hash,
  generation: z.number().int().positive(),
  leaseExpiresAt: Timestamp,
  createdAt: Timestamp,
  updatedAt: Timestamp,
  finalizedOperationId: Hash.nullable(),
  finalizedOperationHash: Hash.nullable(),
  seedAttestationId: Hash.nullable(),
  seedAttestationHash: Hash.nullable(),
  sandboxId: Identifier.nullable(),
}).strict();

export const HardeningPaidModelRoleSchema = z.enum(["BUILDER", "REVIEWER"]);
export const HardeningPaidModelTierSchema = z.enum(["GPT-5.6_TERRA", "GPT-5.6_SOL"]);
export const HardeningModelCallSlotClaimSchema = z.object({
  claimId: Hash,
  childRunId: Identifier,
  role: HardeningPaidModelRoleSchema,
  modelTier: HardeningPaidModelTierSchema,
  status: z.enum(["CLAIMED", "COMPLETED", "FAILED", "AMBIGUOUS"]),
  claimantId: Identifier,
  idempotencyKey: Identifier,
  modelCallId: Identifier.nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
}).strict().superRefine((claim, context) => {
  if ((claim.role === "BUILDER") !== (claim.modelTier === "GPT-5.6_TERRA")) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "hardening paid-call role/tier graph mismatch", path: ["modelTier"] });
  }
});

export type HardeningStartClaimIntent = z.infer<typeof HardeningStartClaimIntentSchema>;
export type HardeningStartFence = z.infer<typeof HardeningStartFenceSchema>;
export type HardeningPaidModelRole = z.infer<typeof HardeningPaidModelRoleSchema>;
export type HardeningPaidModelTier = z.infer<typeof HardeningPaidModelTierSchema>;
export type HardeningModelCallSlotClaim = z.infer<typeof HardeningModelCallSlotClaimSchema>;

export class HardeningStartClaimBusyError extends Error {
  readonly code = "HARDENING_START_CLAIM_BUSY";
  constructor() { super("optional-hardening start is owned by a live fenced worker"); this.name = "HardeningStartClaimBusyError"; }
}
export class HardeningStartFenceStaleError extends Error {
  readonly code = "HARDENING_START_FENCE_STALE";
  constructor() { super("optional-hardening start fence is stale"); this.name = "HardeningStartFenceStaleError"; }
}
export class HardeningPaidCallSlotConsumedError extends Error {
  readonly code = "HARDENING_PAID_CALL_SLOT_CONSUMED";
  constructor() { super("optional-hardening paid model-call slot is already consumed"); this.name = "HardeningPaidCallSlotConsumedError"; }
}
