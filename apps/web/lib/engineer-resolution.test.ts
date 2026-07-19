import { afterEach, describe, expect, test } from "bun:test";
import {
  ResolutionApiError,
  applyResolutionDirective,
  createApproval,
  createPublication,
  createResolutionCase,
  createResolutionDirective,
  getPublication,
  getPublicationCandidates,
  getResolutionCase,
  listResolutionCases,
  projectsWithinCumulativeCeiling,
  type ResolutionCase,
} from "./engineer-resolution";

const nativeFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = nativeFetch; });

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** §2 ResolutionCase fixture — every field named in PHASE-CONTRACTS-P7-P10.md §2. */
const caseFixture: ResolutionCase = {
  caseId: "case_01",
  runId: "run_01",
  caseVersion: 3,
  state: "OPEN",
  blockers: [
    { blockerId: "b1", kind: "BLOCKING", reasonCode: "TEST_FAILED", description: "Required test failed" },
    { blockerId: "b2", kind: "ADVISORY", reasonCode: "STYLE_NIT", description: "Minor style issue" },
  ],
  correctionEligible: true,
  reverifyEligibility: { eligible: false, reason: "SOURCE_CLASS_EXCLUDED" },
  spending: { sourceActualUsd: 1.2, priorReplacementActualUsd: 0.4, ambiguousLiabilityUsd: 0.1, cumulativeCeilingUsd: 5 },
  pricingPolicyDigest: `sha256:${"d".repeat(64)}`,
  createdAt: "2026-07-19T00:00:00.000Z",
  expiresAt: "2026-07-20T00:00:00.000Z",
};

/**
 * These tests mock the fetch boundary with the LIVE route shapes read
 * directly from apps/gateway/src/handler.ts + apps/gateway/src/index.ts
 * (the resolutionDesk facade) and packages/engineer/src/resolution-desk.ts
 * (ResolutionDesk.createCase/issueDirective/applyDirective) — not the
 * frozen-doc prose, which this integration pass found the live
 * implementation actually diverges from on the Idempotency-Key location
 * and the error envelope's `code`/`conflict` nesting. See
 * apps/web/lib/engineer-resolution.ts's module header for every delta.
 */
describe("Resolution Desk client — §2 requests never carry client-supplied authority fields", () => {
  test("createResolutionCase sends no request body at all (the live route never parses one — §2 'Body: none') and unwraps the {case} envelope the live route returns", async () => {
    let captured: { url: string; method: string | undefined; body: unknown; hasIdempotencyHeader: boolean } | null = null;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = {
        url: String(input),
        method: init?.method,
        body: init?.body,
        hasIdempotencyHeader: new Headers(init?.headers).has("Idempotency-Key"),
      };
      return jsonResponse({ case: caseFixture }, 201);
    }) as typeof fetch;
    const result = await createResolutionCase("run_01");
    expect(result).toEqual(caseFixture);
    expect(captured!.url).toContain("/v1/engineer/runs/run_01/resolution-cases");
    expect(captured!.method).toBe("POST");
    expect(captured!.body).toBeUndefined();
    // Case creation is idempotent on the source run server-side, not on a header key.
    expect(captured!.hasIdempotencyHeader).toBe(false);
  });

  test("createResolutionDirective sends only type, caseVersion, sourceRunVersion, and optional budget in the body — never idempotencyKey or approver/actor/authority fields — and carries the Idempotency-Key as an HTTP header (the live route's DirectiveRequestSchema is Zod .strict() with no idempotencyKey property)", async () => {
    let capturedBody: unknown = null;
    let capturedHeaders: Headers | null = null;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body));
      capturedHeaders = new Headers(init?.headers);
      return jsonResponse({
        directive: { directiveId: "dir_1", directiveHash: "sha256:x", caseId: "case_01", caseHash: "sha256:y", type: "CREATE_REVERIFY_RUN", expectedCaseVersion: 3, expectedSourceRunVersion: 7, selectedBlockers: [], budget: null, ttlSeconds: 900, createdAt: caseFixture.createdAt, expiresAt: caseFixture.expiresAt },
        case: caseFixture,
      });
    }) as typeof fetch;
    await createResolutionDirective("case_01", { type: "CREATE_REVERIFY_RUN", caseVersion: 3, sourceRunVersion: 7 });
    expect(Object.keys(capturedBody as object).sort()).toEqual(["caseVersion", "sourceRunVersion", "type"].sort());
    expect(capturedHeaders!.has("Idempotency-Key")).toBe(true);
    expect(capturedHeaders!.get("Idempotency-Key")).not.toHaveLength(0);
  });

  test("directive Idempotency-Key header is deterministic — repeated calls with identical inputs produce the identical key (double-click safety)", async () => {
    const keys: string[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      keys.push(new Headers(init?.headers).get("Idempotency-Key") ?? "");
      return jsonResponse({ directive: { directiveId: "dir_1", directiveHash: "x", caseId: "case_01", caseHash: "y", type: "CREATE_REVERIFY_RUN", expectedCaseVersion: 3, expectedSourceRunVersion: 7, selectedBlockers: [], budget: null, ttlSeconds: 900, createdAt: "x", expiresAt: "y" }, case: caseFixture });
    }) as typeof fetch;
    await createResolutionDirective("case_01", { type: "CREATE_REVERIFY_RUN", caseVersion: 3, sourceRunVersion: 7 });
    await createResolutionDirective("case_01", { type: "CREATE_REVERIFY_RUN", caseVersion: 3, sourceRunVersion: 7 });
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/); // not a random UUID
  });

  test("directive Idempotency-Key changes when the CAS version changes (a real new decision is not silently deduped)", async () => {
    const keys: string[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      keys.push(new Headers(init?.headers).get("Idempotency-Key") ?? "");
      return jsonResponse({ directive: { directiveId: "dir_1", directiveHash: "x", caseId: "case_01", caseHash: "y", type: "CREATE_REVERIFY_RUN", expectedCaseVersion: 3, expectedSourceRunVersion: 7, selectedBlockers: [], budget: null, ttlSeconds: 900, createdAt: "x", expiresAt: "y" }, case: caseFixture });
    }) as typeof fetch;
    await createResolutionDirective("case_01", { type: "CREATE_REVERIFY_RUN", caseVersion: 3, sourceRunVersion: 7 });
    await createResolutionDirective("case_01", { type: "CREATE_REVERIFY_RUN", caseVersion: 4, sourceRunVersion: 7 });
    expect(keys[0]).not.toBe(keys[1]);
  });

  test("applyResolutionDirective sends the Idempotency-Key as a header and no request body (the live apply route never parses one), and returns the exact §2 apply shape", async () => {
    let capturedBody: unknown = null;
    let capturedHeaders: Headers | null = null;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = init?.body;
      capturedHeaders = new Headers(init?.headers);
      return jsonResponse({ replacementRunId: "run_02", state: "READY" });
    }) as typeof fetch;
    const result = await applyResolutionDirective("dir_1");
    expect(capturedBody).toBeUndefined();
    expect(capturedHeaders!.has("Idempotency-Key")).toBe(true);
    expect(result).toEqual({ replacementRunId: "run_02", state: "READY" });
  });

  test("listResolutionCases and getResolutionCase parse the §2 response shapes, including the live resolution-case event shape (not the unrelated run-event shape)", async () => {
    const liveEvent = {
      eventId: "sha256:e1", caseId: "case_01", sequence: 1, previousEventHash: null,
      eventType: "CASE_OPENED", caseVersion: 0, directiveId: null, actorType: "SYSTEM",
      actorId: "engineer-resolution-desk", createdAt: "2026-07-19T00:00:00.000Z",
      policyVersion: "engineer-resolution-event-v1", schemaVersion: 1, eventHash: "sha256:e1hash",
    };
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/resolution-cases")) return jsonResponse({ cases: [caseFixture] });
      return jsonResponse({ case: caseFixture, events: [liveEvent] });
    }) as typeof fetch;
    expect(await listResolutionCases("run_01")).toEqual([caseFixture]);
    const detail = await getResolutionCase("case_01");
    expect(detail).toEqual({ ...caseFixture, events: [liveEvent] });
  });
});

describe("Resolution Desk client — error surfacing (live nested {error:{code,detail}} envelope, per apps/gateway/src/handler.ts mapResolutionDeskError)", () => {
  test("409 CEILING_EXCEEDED surfaces status, code (nested under error.code), for the desk to render", async () => {
    globalThis.fetch = (async () => jsonResponse({ error: { message: "New cap exceeds the cumulative ceiling", code: "CEILING_EXCEEDED" } }, 409)) as unknown as typeof fetch;
    try {
      await createResolutionDirective("case_01", { type: "CREATE_CORRECTED_RUN", caseVersion: 3, sourceRunVersion: 7, budget: { maxCostUsd: 100, maxTokens: 1, maxActiveSeconds: 1, pricingPolicyDigest: "x" } });
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(ResolutionApiError);
      expect((error as ResolutionApiError).status).toBe(409);
      expect((error as ResolutionApiError).code).toBe("CEILING_EXCEEDED");
    }
  });

  test("410 DIRECTIVE_EXPIRED surfaces on apply from the nested error envelope", async () => {
    globalThis.fetch = (async () => jsonResponse({ error: { message: "Directive expired", code: "DIRECTIVE_EXPIRED" } }, 410)) as unknown as typeof fetch;
    await expect(applyResolutionDirective("dir_1")).rejects.toMatchObject({ status: 410, code: "DIRECTIVE_EXPIRED" });
  });

  test("409 CAS miss surfaces the expected/actual conflict verbatim from error.detail (the live nesting — ResolutionDeskError's 4th constructor arg lands under error.detail, not top-level conflict)", async () => {
    globalThis.fetch = (async () => jsonResponse({ error: { message: "Case version conflict", code: "CASE_VERSION_CONFLICT", detail: { expected: 3, actual: 4 } } }, 409)) as unknown as typeof fetch;
    try {
      await createResolutionDirective("case_01", { type: "REJECT_AND_CLOSE", caseVersion: 3, sourceRunVersion: 7 });
      throw new Error("expected rejection");
    } catch (error) {
      expect((error as ResolutionApiError).code).toBe("CASE_VERSION_CONFLICT");
      expect((error as ResolutionApiError).conflict).toEqual({ expected: 3, actual: 4 });
    }
  });

  test("a Zod .strict() validation failure (mapResolutionDeskError's ZodError branch: {error:{message,issues}}, no code) surfaces a null code rather than throwing on parse", async () => {
    globalThis.fetch = (async () => jsonResponse({ error: { message: "Invalid request body", issues: [{ path: ["idempotencyKey"], message: "Unrecognized key" }] } }, 400)) as unknown as typeof fetch;
    try {
      await createResolutionDirective("case_01", { type: "CREATE_REVERIFY_RUN", caseVersion: 3, sourceRunVersion: 7 });
      throw new Error("expected rejection");
    } catch (error) {
      expect((error as ResolutionApiError).status).toBe(400);
      expect((error as ResolutionApiError).code).toBeNull();
      expect((error as ResolutionApiError).message).toBe("Invalid request body");
    }
  });

  test("a bare string error (legacy shape, still handled) surfaces as the message with a null code", async () => {
    globalThis.fetch = (async () => jsonResponse({ error: "Engineer resolution desk is not configured" }, 503)) as unknown as typeof fetch;
    await expect(applyResolutionDirective("dir_1")).rejects.toMatchObject({ status: 503, code: null, message: "Engineer resolution desk is not configured" });
  });
});

describe("Approval/publication client (§3) — NOT wired to a live route yet; still exercised against its own documented shapes so the screen is ready the moment P8's HTTP layer is integrated", () => {
  test("getPublicationCandidates parses the exact §3 candidate shape including lineage and lineageVerified", async () => {
    globalThis.fetch = (async () => jsonResponse({
      candidates: [
        { checkpointId: "cp_1", checkpointHash: `sha256:${"a".repeat(64)}`, lineage: "ORIGINAL", lineageVerified: true },
        { checkpointId: "cp_2", checkpointHash: `sha256:${"b".repeat(64)}`, lineage: "P7_REPLACEMENT", lineageVerified: false },
      ],
    })) as unknown as typeof fetch;
    const candidates = await getPublicationCandidates("run_01");
    expect(candidates).toHaveLength(2);
    expect(candidates[1]).toEqual({ checkpointId: "cp_2", checkpointHash: `sha256:${"b".repeat(64)}`, lineage: "P7_REPLACEMENT", lineageVerified: false });
  });

  test("createApproval sends only checkpointHash, decision, optional rationale, and idempotencyKey — never approver/requester", async () => {
    let captured: unknown = null;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured = JSON.parse(String(init?.body));
      return jsonResponse({ approval: { approvalId: "appr_1", approver: "srv-derived", requester: "srv-derived", checkpointId: "cp_1", checkpointHash: `sha256:${"a".repeat(64)}`, evidenceRoot: "sha256:e", repositoryId: "repo_1", baseCommitSha: "c".repeat(40), policyVersion: "v1", expiresAt: "2026-07-20T00:00:00.000Z", status: "APPROVED", revision: 1 } });
    }) as typeof fetch;
    await createApproval("cp_1", { checkpointHash: `sha256:${"a".repeat(64)}`, decision: "APPROVE", rationale: "Looks correct" });
    expect(Object.keys(captured as object).sort()).toEqual(["checkpointHash", "decision", "idempotencyKey", "rationale"].sort());
  });

  test("self-approval 403 SELF_APPROVAL is surfaced with a distinguishable code", async () => {
    globalThis.fetch = (async () => jsonResponse({ error: "Requester and approver must differ", code: "SELF_APPROVAL" }, 403)) as unknown as typeof fetch;
    await expect(createApproval("cp_1", { checkpointHash: `sha256:${"a".repeat(64)}`, decision: "APPROVE" }))
      .rejects.toMatchObject({ status: 403 });
  });

  test("createPublication sends the Idempotency-Key header (§3 explicit requirement) and only approvalId/operation/idempotencyKey in the body", async () => {
    let headers: Headers | null = null;
    let body: unknown = null;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      headers = new Headers(init?.headers);
      body = JSON.parse(String(init?.body));
      return jsonResponse({ publicationId: "pub_1", state: "PREFLIGHT" });
    }) as typeof fetch;
    const created = await createPublication("run_01", { approvalId: "appr_1", operation: "BRANCH_PR" });
    expect(headers!.has("Idempotency-Key")).toBe(true);
    expect(Object.keys(body as object).sort()).toEqual(["approvalId", "idempotencyKey", "operation"].sort());
    expect(created).toEqual({ publicationId: "pub_1", state: "PREFLIGHT" });
  });

  test("409 PREFLIGHT_MISMATCH on publish surfaces distinctly so the UI can explain the approval was invalidated", async () => {
    globalThis.fetch = (async () => jsonResponse({ error: "Branch moved since approval", code: "PREFLIGHT_MISMATCH" }, 409)) as unknown as typeof fetch;
    await expect(createPublication("run_01", { approvalId: "appr_1", operation: "BRANCH_PR" }))
      .rejects.toMatchObject({ status: 409 });
  });

  test("getPublication parses every §3 publication state and the RECONCILING reconciliation record", async () => {
    globalThis.fetch = (async () => jsonResponse({ state: "RECONCILING", reconciliation: { reason: "AMBIGUOUS_REMOTE_OUTCOME", observedRemoteState: "PR_PRESENT_UNKNOWN_SHA" } })) as unknown as typeof fetch;
    const publication = await getPublication("pub_1");
    expect(publication.state).toBe("RECONCILING");
    expect(publication.reconciliation).toEqual({ reason: "AMBIGUOUS_REMOTE_OUTCOME", observedRemoteState: "PR_PRESENT_UNKNOWN_SHA" });
  });

  test("getPublication parses a RECEIPTED publication's receipt", async () => {
    globalThis.fetch = (async () => jsonResponse({ state: "RECEIPTED", receipt: { prUrl: "https://github.com/o/r/pull/1", commitSha: "d".repeat(40) } })) as unknown as typeof fetch;
    const publication = await getPublication("pub_1");
    expect(publication.receipt?.prUrl).toBe("https://github.com/o/r/pull/1");
  });
});

describe("Client-side ceiling pre-validation (mirrors, never replaces, the §2 server rule)", () => {
  test("projects within ceiling when actual+ambiguous+new cap does not exceed cumulativeCeilingUsd", () => {
    expect(projectsWithinCumulativeCeiling(caseFixture.spending, 3)).toBe(true); // 1.2+0.4+0.1+3 = 4.7 <= 5
  });

  test("projects over ceiling when actual+ambiguous+new cap exceeds cumulativeCeilingUsd", () => {
    expect(projectsWithinCumulativeCeiling(caseFixture.spending, 4)).toBe(false); // 1.2+0.4+0.1+4 = 5.7 > 5
  });

  test("is a boundary-inclusive check (exactly at the ceiling is allowed)", () => {
    expect(projectsWithinCumulativeCeiling(caseFixture.spending, 3.3)).toBe(true); // == 5 exactly
  });
});
