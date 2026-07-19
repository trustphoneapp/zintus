import { describe, expect, test } from "bun:test";
import {
  HardeningModelCallSlotClaimSchema,
  createHardeningStartClaimIntent,
} from "./hardening-execution-fencing.js";
import { sha256 } from "./hash.js";

describe("Day 2A P5 v28 execution fencing contracts", () => {
  test("binds the complete pre-side-effect intent and derives a deterministic claim identity", () => {
    const input={requesterUserId:"owner",rootRunId:"root",parentRunId:"parent",childRunId:"child",repositoryId:"repository",
      parentCheckpointId:sha256("checkpoint-id"),parentCheckpointHash:sha256("checkpoint"),lineageId:sha256("lineage-id"),
      lineageHash:sha256("lineage"),quoteId:sha256("quote-id"),quoteHash:sha256("quote"),consentId:sha256("consent-id"),
      consentHash:sha256("consent"),operationId:sha256("operation-id"),operationHash:sha256("operation"),idempotencyKey:"start"};
    expect(createHardeningStartClaimIntent(input)).toEqual(createHardeningStartClaimIntent(input));
    expect(createHardeningStartClaimIntent({...input,consentHash:sha256("other")})).not.toEqual(createHardeningStartClaimIntent(input));
  });

  test("allows only the frozen Builder/Terra and Reviewer/Sol paid-call graph", () => {
    const base={claimId:sha256("claim"),childRunId:"child",status:"CLAIMED" as const,claimantId:"worker",idempotencyKey:"call",
      modelCallId:null,createdAt:"2026-07-18T00:00:00.000Z",updatedAt:"2026-07-18T00:00:00.000Z"};
    expect(HardeningModelCallSlotClaimSchema.parse({...base,role:"BUILDER",modelTier:"GPT-5.6_TERRA"}).role).toBe("BUILDER");
    expect(HardeningModelCallSlotClaimSchema.parse({...base,role:"REVIEWER",modelTier:"GPT-5.6_SOL"}).role).toBe("REVIEWER");
    expect(()=>HardeningModelCallSlotClaimSchema.parse({...base,role:"PLANNER",modelTier:"GPT-5.6_TERRA"})).toThrow();
    expect(()=>HardeningModelCallSlotClaimSchema.parse({...base,role:"BUILDER",modelTier:"GPT-5.6_SOL"})).toThrow();
    expect(()=>HardeningModelCallSlotClaimSchema.parse({...base,role:"REVIEWER",modelTier:"GPT-5.6_TERRA"})).toThrow();
  });
});
