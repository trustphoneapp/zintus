import { describe, expect, test } from "bun:test";
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  AdvisoryBacklogEventSchema, AdvisoryBacklogItemSchema, CandidateLineageAttestationSchema,
  EngineerRunLineageSchema, HardeningConsentSchema, HardeningQuoteSchema,
  OptionalHardeningChildAuthoritySchema, OptionalHardeningChildRequestSchema,
  PublicationCandidateSelectionSchema, createAdvisoryBacklogEvent, createAdvisoryBacklogItem,
  advisoryActionability,
  createEngineerRunLineage, createHardeningConsent, createHardeningQuote, createOptionalHardeningChildAuthority,
  createPublicationCandidateSelection, createSignedCandidateLineageAttestation,
  hardeningChildRunId, verifySignedCandidateLineageAttestation,
} from "./advisory-hardening-contracts.js";
import { TaskManifestSchema } from "./contracts.js";
import { sha256 } from "./hash.js";

const at = "2026-07-18T12:00:00.000Z";
const later = "2026-07-18T12:15:00.000Z";
const hash = (value: string) => sha256(value);
const manifestContent = {
  manifestVersion: 1, runId: "parent-run",
  repository: { repositoryId: "repo", provider: "local" as const, owner: "owner", name: "repo", baseBranch: "main", baseCommitSha: "a".repeat(40) },
  request: { original: "harden optional advisory", normalized: "harden optional advisory" },
  acceptanceCriteria: [{ criterionId: "must", statement: "Preserve behavior", verificationMethod: "bun test", priority: "MUST" as const }],
  testPlan: [{ testId: "test", criterionIds: ["must"], type: "UNIT" as const, description: "test", command: "bun test" }],
  allowedPaths: ["src/**"], deniedPaths: ["src/secret/**"], allowedCommands: ["bun test"], prohibitedCommands: [],
  riskTier: "LOW" as const, humanGateRequired: false,
  retryBudgets: { sameFailureAttempts: 1, builderRepairAttempts: 1, reviewerFixAttempts: 1, plannerRestarts: 1, sandboxProvisioningAttempts: 1, transientModelAttempts: 1 },
  timeBudgetSeconds: 600, tokenBudget: 10_000, costBudgetUsd: 1, createdAt: at,
};
const manifest = TaskManifestSchema.parse({ ...manifestContent, manifestHash: sha256(manifestContent) });

function advisory(file = "src/index.ts", findingId = "finding") {
  return createAdvisoryBacklogItem({
    schemaVersion: 1, policyVersion: "engineer-advisory-backlog-v1", parentRunId: "parent-run",
    requesterUserId: "user", repositoryId: "repo", parentCheckpointId: hash("parent-id"),
    parentCheckpointHash: hash("parent-hash"), requiredLaneContractHash: hash("contract"),
    classificationHash: hash("batch"), reviewerSessionId: "reviewer", findingId,
    findingFingerprint: hash(`fingerprint-${findingId}`), sourceClassificationHash: hash(`finding-classification-${findingId}`),
    disposition: "ADVISORY", reasonCode: "OUTSIDE_FROZEN_REQUIRED_SCOPE", authority: "NONE",
    reportedSeverity: "MEDIUM", category: "hardening", description: "Optional improvement",
    requiredChange: "Add defense", file, lineStart: 1, lineEnd: 2, criterionIds: ["must"],
    evidenceIds: ["evidence"], actionability: file.startsWith("src/secret/") ? "AUDIT_ONLY" : "ACTIONABLE", createdAt: at,
  }, manifest);
}

function quote(items = [advisory()], advisoryIds = items.map((item) => item.advisoryId).sort()) {
  return createHardeningQuote({
    schemaVersion: 1, policyVersion: "engineer-hardening-estimate-v1", estimatorVersion: "deterministic-hardening-estimator-v1",
    parentRunId: "parent-run", requesterUserId: "user", repositoryId: "repo", parentCheckpointId: hash("parent-id"),
    parentCheckpointHash: hash("parent-hash"), parentStateVersion: 12, advisoryIds, selectionHash: sha256(advisoryIds),
    routingPolicyVersion: "engineer-model-routing-v2", pricingVersion: "openai-gpt56-pricing-2026-07-14",
    estimate: { maxCostMicrousd: 500_000, maxTokens: 20_000, maxTimeSeconds: 600, maxPlannerCalls: 0, maxBuilderCalls: 1, maxReviewerCalls: 1, automaticRepairCalls: 0 },
    assumptions: ["ESTIMATE_IS_HARD_CAP", "NO_AUTOMATIC_REPAIR", "NO_PARENT_BUDGET_TRANSFER"], createdAt: at, expiresAt: later,
  }, items);
}

function consent() {
  const authority = quote();
  return { authority, consent: createHardeningConsent({
    schemaVersion: 1, policyVersion: "engineer-hardening-consent-v1", quoteId: authority.quoteId, quoteHash: authority.quoteHash,
    parentRunId: authority.parentRunId, parentCheckpointId: authority.parentCheckpointId, parentCheckpointHash: authority.parentCheckpointHash,
    parentStateVersion: authority.parentStateVersion, selectionHash: authority.selectionHash, requesterUserId: "user", actorId: "user",
    authorizedBudget: { costMicrousd: 400_000, tokens: 15_000, timeSeconds: 500 },
    acknowledgements: { separateRun: true, parentCandidateUnchanged: true, noAutomaticRepair: true, noOverages: true },
    idempotencyKey: "consent-op", acceptedAt: "2026-07-18T12:10:00.000Z", quoteExpiresAt: authority.expiresAt,
  }, authority) };
}

function lineageFixture() {
  const { authority, consent: accepted } = consent();
  const childRunId = hardeningChildRunId(accepted.consentHash);
  const lineage = createEngineerRunLineage({
    schemaVersion: 1, policyVersion: "engineer-hardening-lineage-v1", relation: "OPTIONAL_HARDENING",
    rootRunId: "parent-run", parentRunId: "parent-run", childRunId, requesterUserId: "user", repositoryId: "repo",
    parentCheckpointId: authority.parentCheckpointId, parentCheckpointHash: authority.parentCheckpointHash,
    parentBaseCommitSha: "a".repeat(40), seedResultCommitSha: "b".repeat(40), quoteId: authority.quoteId,
    quoteHash: authority.quoteHash, consentId: accepted.consentId, consentHash: accepted.consentHash,
    selectionHash: authority.selectionHash, budget: accepted.authorizedBudget, createdAt: at,
  });
  return { authority, accepted, childRunId, lineage };
}

const signer = {
  algorithm: "HMAC-SHA256", keyId: "test-key",
  sign(payload: Uint8Array) { return createHmac("sha256", "test-only-key").update(payload).digest("hex"); },
  verify(payload: Uint8Array, signature: string) {
    const expected = Buffer.from(this.sign(payload), "hex"); const actual = Buffer.from(signature, "hex");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  },
};

describe("Day 2A P1 canonical contracts", () => {
  test("derives deterministic advisory authority and manifest-bound actionability", () => {
    const first = advisory(); const second = advisory();
    expect(first).toEqual(second);
    expect(first.actionability).toBe("ACTIONABLE");
    expect(advisory("src/secret/key.ts").actionability).toBe("AUDIT_ONLY");
    expect(() => AdvisoryBacklogItemSchema.parse({ ...first, description: "tampered" })).toThrow();
    expect(() => createAdvisoryBacklogItem({ ...first, advisoryId: undefined, advisoryHash: undefined, criterionIds: ["z", "a"] } as never, manifest)).toThrow();
    for (const unsafe of ["", "/src/index.ts", "../src/index.ts", "src/../index.ts", ".git/config", "src/.git/config", "src//index.ts", "src\\index.ts", "C:\\src\\index.ts", "src/\0index.ts"]) {
      expect(advisoryActionability(manifest, unsafe)).toBe("AUDIT_ONLY");
    }
    expect(advisoryActionability({} as never, "src/index.ts")).toBe("AUDIT_ONLY");
  });

  test("enforces event revision and exact event-specific reference shapes", () => {
    const item = advisory(); const authority = quote([item]);
    const event = createAdvisoryBacklogEvent({ schemaVersion: 1, policyVersion: "engineer-advisory-backlog-v1",
      advisoryId: item.advisoryId, parentRunId: "parent-run", parentCheckpointId: item.parentCheckpointId,
      parentCheckpointHash: item.parentCheckpointHash, eventType: "SELECTED", revision: 1, expectedRevision: 0,
      actorType: "USER", actorId: "user", operationId: "op", idempotencyKey: "key", quoteId: authority.quoteId,
      consentId: null, hardeningLineageId: null, childRunId: null, childCheckpointId: null, childCheckpointHash: null,
      stopReason: null, rationale: null, createdAt: at });
    expect(AdvisoryBacklogEventSchema.parse(event)).toEqual(event);
    expect([item.advisoryId, event.eventId, authority.quoteId]).toEqual([
      // Fixed cross-runtime vectors for the exact dynamic hash-key ID derivation.
      "sha256:8806d0a4a62dd0936bcf10d172b3ac32c7e47db95250fe090d2b4f6ef5f773b5",
      "sha256:bbc605c92d0af630850f38a102761663c54a1a4cff7f51682e8933356a901e76",
      "sha256:e2cf8ce2078ae3d6b0a0562ceac0a827023f2877651aa07db6b511a4193a1df8",
    ]);
    expect(() => createAdvisoryBacklogEvent({ ...event, eventId: undefined, eventHash: undefined, revision: 2 } as never)).toThrow();
    expect(() => createAdvisoryBacklogEvent({ ...event, eventId: undefined, eventHash: undefined, childRunId: "child" } as never)).toThrow();
  });

  test("rejects reordered or duplicate selections, excess caps, expired consent, and tampering", () => {
    const items = [advisory("src/a.ts", "finding-a"), advisory("src/b.ts", "finding-b")];
    const ids = items.map((item) => item.advisoryId).sort();
    const valid = quote(items, ids);
    expect(HardeningQuoteSchema.parse(valid)).toEqual(valid);
    expect(() => quote(items, [...ids].reverse())).toThrow();
    expect(() => quote(items, [ids[0]!, ids[0]!])).toThrow();
    expect(() => quote([advisory("src/secret/key.ts")])).toThrow("exact actionable advisory selection");
    const { quoteId: _quoteId, quoteHash: _quoteHash, ...quoteContent } = valid;
    const crossAuthority = { ...quoteContent, requesterUserId: "other-user" };
    expect(() => createHardeningQuote(crossAuthority as never, items)).toThrow("exact actionable advisory selection");
    expect(() => createHardeningQuote({ ...quoteContent, routingPolicyVersion: "stale-router" } as never, items)).toThrow();
    expect(() => createHardeningQuote({ ...quoteContent, pricingVersion: "stale-pricing" } as never, items)).toThrow();
    expect(() => createHardeningQuote({ ...quoteContent, expiresAt: "2026-07-18T12:15:00.001Z" } as never, items)).toThrow("exactly 15 minutes");
    expect(() => HardeningQuoteSchema.parse({ ...valid, estimate: { ...valid.estimate, maxTokens: 20_001 } })).toThrow();
    const { authority, consent: accepted } = consent();
    expect(HardeningConsentSchema.parse(accepted)).toEqual(accepted);
    const { consentId: _consentId, consentHash: _consentHash, ...consentContent } = accepted;
    expect(() => createHardeningConsent({ ...consentContent, authorizedBudget: { ...accepted.authorizedBudget, tokens: authority.estimate.maxTokens + 1 } } as never, authority)).toThrow();
    expect(() => createHardeningConsent(consentContent,
      { ...authority, estimate: { ...authority.estimate, maxTokens: 1 } })).toThrow();
    expect(() => createHardeningConsent({ ...consentContent,
      acceptedAt: "2026-07-18T11:59:59.999Z" } as never, authority)).toThrow("precede quote creation");
  });

  test("binds deterministic child lineage and verifies signed parent-to-child authority", async () => {
    const { authority, accepted, childRunId, lineage } = lineageFixture();
    expect(EngineerRunLineageSchema.parse(lineage)).toEqual(lineage);
    expect(() => EngineerRunLineageSchema.parse({ ...lineage, childRunId: "counterfeit" })).toThrow();
    const signed = await createSignedCandidateLineageAttestation({
      schemaVersion: 1, policyVersion: "engineer-candidate-lineage-v1", relation: "OPTIONAL_HARDENING",
      lineageId: lineage.lineageId, lineageHash: lineage.lineageHash, rootRunId: "parent-run", parentRunId: "parent-run",
      childRunId, requesterUserId: "user", repositoryId: "repo", parentCheckpointId: authority.parentCheckpointId,
      parentCheckpointHash: authority.parentCheckpointHash, parentResultCommitSha: "b".repeat(40),
      childCheckpointId: hash("child-id"), childCheckpointHash: hash("child-hash"), childResultCommitSha: "c".repeat(40),
      parentBaseCommitSha: "a".repeat(40), selectionHash: authority.selectionHash, quoteHash: authority.quoteHash,
      consentHash: accepted.consentHash, createdAt: at,
    }, signer);
    expect(await verifySignedCandidateLineageAttestation(signed, signer)).toEqual(signed);
    expect([accepted.consentId, lineage.lineageId, signed.attestation.lineageAttestationId]).toEqual([
      "sha256:d8a31e622e508376945a901be31d85c2fc4a24d23f7751ce79d982e3f13523a4",
      "sha256:e627497844ebadcdfddd70d9ae6b4c570f5826e9108696b10c07f96fd3df1076",
      "sha256:f785028d708c6bcf9a964ff7d2d022822ce753f461045be71a600fc29b2f22d7",
    ]);
    expect(() => CandidateLineageAttestationSchema.parse({ ...signed.attestation, childResultCommitSha: "d".repeat(40) })).toThrow();
    await expect(verifySignedCandidateLineageAttestation({ ...signed, signature: "00" }, signer)).rejects.toThrow();
    await expect(verifySignedCandidateLineageAttestation({ ...signed, signature: "" }, signer)).rejects.toThrow();
  });

  test("derives one strict canonical optional-hardening child request from durable authority only", () => {
    const { authority, consent: accepted }=consent();const item=advisory();const childRunId=hardeningChildRunId(accepted.consentHash);
    const request=createOptionalHardeningChildAuthority({schemaVersion:1,policyVersion:"engineer-hardening-child-request-v1",
      rootRunId:"parent-run",parentRunId:"parent-run",childRunId,requesterUserId:"user",repositoryId:"repo",
      parentCheckpointId:authority.parentCheckpointId,parentCheckpointHash:authority.parentCheckpointHash,
      quoteId:authority.quoteId,quoteHash:authority.quoteHash,consentId:accepted.consentId,consentHash:accepted.consentHash,
      advisoryIds:[item.advisoryId],requiredChanges:[{advisoryId:item.advisoryId,requiredChange:item.requiredChange,file:item.file!,
        lineStart:item.lineStart,lineEnd:item.lineEnd}],selectionHash:sha256([item.advisoryId]),seedResultCommitSha:"b".repeat(40),createdAt:at});
    expect(OptionalHardeningChildAuthoritySchema.parse(request)).toEqual(request);
    expect(OptionalHardeningChildRequestSchema.parse({consentId:accepted.consentId,consentHash:accepted.consentHash})).toEqual({consentId:accepted.consentId,consentHash:accepted.consentHash});
    expect(()=>OptionalHardeningChildRequestSchema.parse({consentId:accepted.consentId,consentHash:accepted.consentHash,request:"attacker"})).toThrow();
    expect(()=>OptionalHardeningChildAuthoritySchema.parse({...request,requiredChanges:[{...request.requiredChanges[0]!,requiredChange:"changed"}]})).toThrow();
    expect(()=>createOptionalHardeningChildAuthority({...request,requestHash:undefined,childRunId:"counterfeit"} as never)).toThrow();
  });

  test("enforces append-only publication selection CAS shape and candidate lineage pairing", () => {
    const parent = createPublicationCandidateSelection({ schemaVersion: 1, policyVersion: "engineer-publication-selection-v1",
      rootRunId: "parent-run", candidateRunId: "parent-run", requesterUserId: "user", repositoryId: "repo",
      candidateKind: "PARENT", selectedCheckpointId: hash("parent-id"), selectedCheckpointHash: hash("parent-hash"),
      selectedResultCommitSha: "b".repeat(40), candidateLineageAttestationId: null, candidateLineageAttestationHash: null,
      revision: 1, expectedRevision: 0, previousSelectionId: null, reasonCode: "USER_SELECTED_PARENT", actorId: "user",
      idempotencyKey: "selection-1", selectedAt: at });
    expect(PublicationCandidateSelectionSchema.parse(parent)).toEqual(parent);
    expect(parent.selectionId).toBe("sha256:d7197de411f73b70180894983162f095def9443bd8be0b823373f789370b8a72");
    expect(() => createPublicationCandidateSelection({ ...parent, selectionId: undefined, selectionHash: undefined, revision: 2 } as never)).toThrow();
    expect(() => createPublicationCandidateSelection({ ...parent, selectionId: undefined, selectionHash: undefined, candidateKind: "HARDENED_CHILD" } as never)).toThrow();
    expect(() => PublicationCandidateSelectionSchema.parse({ ...parent, selectedResultCommitSha: "c".repeat(40) })).toThrow();
  });
});
