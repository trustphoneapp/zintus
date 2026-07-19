import { afterEach, describe, expect, test } from "bun:test";
import {
  acceptEngineerHardeningConsent,
  createEngineerOptionalHardeningChild,
  createEngineerHardeningQuote,
  getEngineerHardeningQuote,
  type EngineerHardeningConsent,
  type EngineerHardeningQuote,
  type EngineerOptionalHardeningChild,
  type EngineerOptionalHardeningCreation,
} from "./engineer";

const nativeFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = nativeFetch; });

const quote: EngineerHardeningQuote = {
  schemaVersion: 1, policyVersion: "engineer-hardening-estimate-v1",
  quoteId: `sha256:${"a".repeat(64)}`, quoteHash: `sha256:${"b".repeat(64)}`, parentRunId: "run / 1",
  requesterUserId: "owner-1", repositoryId: "repo-1",
  parentCheckpointId: `sha256:${"c".repeat(64)}`, parentCheckpointHash: `sha256:${"d".repeat(64)}`,
  parentStateVersion: 9, selectionHash: `sha256:${"e".repeat(64)}`, advisoryIds: [`sha256:${"f".repeat(64)}`],
  routingPolicyVersion: "routing-v1", pricingVersion: "pricing-v1", estimatorVersion: "estimator-v1",
  estimate: { maxCostMicrousd: 10_000, maxTokens: 2_000, maxTimeSeconds: 60, maxPlannerCalls: 0, maxBuilderCalls: 1, maxReviewerCalls: 1, automaticRepairCalls: 0 },
  assumptions: ["ESTIMATE_IS_HARD_CAP"], createdAt: "2026-07-18T10:00:00.000Z", expiresAt: "2026-07-18T10:30:00.000Z", status: "ACTIVE",
};
const consent: EngineerHardeningConsent = {
  schemaVersion: 1, policyVersion: "consent-v1", quoteId: quote.quoteId, quoteHash: quote.quoteHash,
  parentRunId: quote.parentRunId, parentCheckpointId: quote.parentCheckpointId, parentCheckpointHash: quote.parentCheckpointHash,
  parentStateVersion: quote.parentStateVersion, selectionHash: quote.selectionHash, requesterUserId: "owner-1", actorId: "owner-1",
  authorizedBudget: { costMicrousd: 10_000, tokens: 2_000, timeSeconds: 60 },
  acknowledgements: { separateRun: true, parentCandidateUnchanged: true, noAutomaticRepair: true, noOverages: true },
  idempotencyKey: "consent-1", acceptedAt: "2026-07-18T10:01:00.000Z", quoteExpiresAt: quote.expiresAt,
  consentHash: `sha256:${"1".repeat(64)}`, consentId: `sha256:${"2".repeat(64)}`,
};
const child: EngineerOptionalHardeningChild = {
  schemaVersion: 1, parentRunId: quote.parentRunId, rootRunId: quote.parentRunId, childRunId: "hardening-child-1",
  lineageId: `sha256:${"3".repeat(64)}`, lineageHash: `sha256:${"4".repeat(64)}`,
  state: "REQUEST_RECEIVED", stateVersion: 0, riskTier: "HIGH", humanGateRequired: true,
  budget: consent.authorizedBudget, createdAt: "2026-07-18T10:02:00.000Z",
};
const creation: EngineerOptionalHardeningCreation = { child, lineage: {
  schemaVersion: 1, policyVersion: "engineer-hardening-lineage-v1", relation: "OPTIONAL_HARDENING",
  lineageId: child.lineageId, lineageHash: child.lineageHash, rootRunId: child.rootRunId, parentRunId: child.parentRunId,
  childRunId: child.childRunId, parentCheckpointId: quote.parentCheckpointId, parentCheckpointHash: quote.parentCheckpointHash,
  parentBaseCommitSha: "a".repeat(40), seedResultCommitSha: "b".repeat(40), quoteId: quote.quoteId, quoteHash: quote.quoteHash,
  consentId: consent.consentId, consentHash: consent.consentHash, selectionHash: quote.selectionHash,
  budget: child.budget, createdAt: child.createdAt,
} };

describe("Engineer hardening web client", () => {
  test("uses nested encoded quote routes and the exact request body", async () => {
    const calls: Array<{ url: string; method?: string; body?: unknown; cache?: RequestCache }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined, cache: init?.cache });
      return new Response(JSON.stringify({ quote }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    const input = { advisoryIds: quote.advisoryIds, expectedParentStateVersion: 9, idempotencyKey: "quote-1" };
    await createEngineerHardeningQuote("run / 1", input);
    await getEngineerHardeningQuote("run / 1", "quote / 1");
    expect(calls).toEqual([
      { url: expect.stringContaining("/runs/run%20%2F%201/hardening/quotes"), method: "POST", body: { runId: "run / 1", ...input }, cache: "no-store" },
      { url: expect.stringContaining("/runs/run%20%2F%201/hardening/quotes/quote%20%2F%201"), method: undefined, body: undefined, cache: "no-store" },
    ]);
  });

  test("sends only consent authority fields", async () => {
    let captured: unknown;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ consent }), { status: 201, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    const input = {
      quoteId: quote.quoteId, quoteHash: quote.quoteHash, authorizedBudget: consent.authorizedBudget,
      acknowledgements: consent.acknowledgements, expectedParentStateVersion: 9, idempotencyKey: "consent-1",
    };
    await expect(acceptEngineerHardeningConsent("run-1", input)).resolves.toEqual(consent);
    expect(captured).toEqual(input);
  });

  test("creates a child through the encoded parent route with only consent hashes", async () => {
    let captured: { url: string; method?: string; body?: unknown; cache?: RequestCache } | undefined;
    globalThis.fetch = (async (requestInput: RequestInfo | URL, init?: RequestInit) => {
      captured = {
        url: String(requestInput), method: init?.method,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        cache: init?.cache,
      };
      return new Response(JSON.stringify(creation), { status: 201, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    const input = { consentId: consent.consentId, consentHash: consent.consentHash };
    await expect(createEngineerOptionalHardeningChild("run / 1", input)).resolves.toEqual(creation);
    expect(captured).toEqual({
      url: expect.stringContaining("/runs/run%20%2F%201/hardening/children"),
      method: "POST", body: input, cache: "no-store",
    });
  });

  test("fails closed on omitted lineage authority or leaked internal lineage fields", async () => {
    for (const responseBody of [
      { child },
      { ...creation, lineage: { ...creation.lineage, requesterUserId: "leaked-owner" } },
    ]) {
      globalThis.fetch = (async () => new Response(JSON.stringify(responseBody), { status: 201, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;
      await expect(createEngineerOptionalHardeningChild("run-1", { consentId: consent.consentId, consentHash: consent.consentHash }))
        .rejects.toThrow("response is invalid");
    }
  });
});
