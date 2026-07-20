import { afterEach, describe, expect, test } from "bun:test";
import {
  ResolutionApiError,
  markPublicationFailed,
  recheckPublicationReconciliation,
  reconcilePublicationReceipt,
  type EngineerPublication,
} from "./engineer-resolution";
import {
  RECONCILIATION_BINDING_REJECTED,
  canSubmitVerifiedReceipt,
  reconciliationErrorDetail,
} from "../app/(app)/engineer/publication/PublicationControls";

const nativeFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = nativeFetch; });

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const PUB_ID = "pub-42";
const COMMIT = "a".repeat(40);
const PR_URL = "https://github.com/acme/repo/pull/7";

/**
 * FINDING #4 (R7-3): a RECONCILING publication was UNOPERABLE from the UI — no
 * remote recheck, no verified-receipt entry, no mark-failed. These drive the
 * three operator controls at the client seam (the app has no React harness, so
 * the client functions + the control-logic mapping are the seam under test).
 *
 * RED against today: none of `reconcilePublicationReceipt`,
 * `markPublicationFailed`, `recheckPublicationReconciliation`,
 * `reconciliationErrorDetail`, `canSubmitVerifiedReceipt`, nor
 * `RECONCILIATION_BINDING_REJECTED` exist yet — no reconcile controls/client
 * wiring were present, so importing them fails.
 */
describe("RECONCILING operator controls — client wiring (server is the authority)", () => {
  test("VERIFIED RECEIPT posts { resolution: RECEIPTED, prUrl, commitSha, detail } to the reconcile route and hydrates the server view", async () => {
    let captured: { url: string; method: string | undefined; body: unknown } | null = null;
    const serverView: EngineerPublication = { state: "RECEIPTED", receipt: { prUrl: PR_URL, commitSha: COMMIT } };
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = { url: String(input), method: init?.method, body: JSON.parse(String(init?.body)) };
      return jsonResponse({ publicationId: PUB_ID, ...serverView });
    }) as typeof fetch;

    const result = await reconcilePublicationReceipt(PUB_ID, { prUrl: PR_URL, commitSha: COMMIT, detail: "confirmed in GitHub UI" });

    expect(captured!.url).toContain(`/v1/engineer/publications/${PUB_ID}/reconcile`);
    expect(captured!.method).toBe("POST");
    expect(captured!.body).toEqual({ resolution: "RECEIPTED", prUrl: PR_URL, commitSha: COMMIT, detail: "confirmed in GitHub UI" });
    // The UI state follows the durable server response, never a fabricated success.
    expect(result.state).toBe("RECEIPTED");
    expect(result.receipt).toEqual({ prUrl: PR_URL, commitSha: COMMIT });
  });

  test("a rejected VERIFIED RECEIPT (foreign commit / unconfirmed PR — R7-1 PUBLICATION_RECEIPT_BINDING) surfaces the typed error, NOT a fake success", async () => {
    globalThis.fetch = (async () => jsonResponse(
      { error: { code: "PUBLICATION_RECEIPT_BINDING", message: "manual RECEIPTED receipt commitSha does not match the publication's verified result commit" } },
      409,
    )) as unknown as typeof fetch;

    const error = await reconcilePublicationReceipt(PUB_ID, { prUrl: PR_URL, commitSha: "f".repeat(40) }).then(
      () => { throw new Error("expected the binding rejection to throw"); },
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(ResolutionApiError);
    expect((error as ResolutionApiError).code).toBe("PUBLICATION_RECEIPT_BINDING");
    expect((error as ResolutionApiError).status).toBe(409);
  });

  test("MARK FAILED posts { resolution: FAILED, detail } and transitions the view to FAILED", async () => {
    let capturedBody: unknown = null;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body));
      return jsonResponse({ publicationId: PUB_ID, state: "FAILED" });
    }) as typeof fetch;

    const result = await markPublicationFailed(PUB_ID, { detail: "PR never landed; abandoning" });
    expect(capturedBody).toEqual({ resolution: "FAILED", detail: "PR never landed; abandoning" });
    expect(result.state).toBe("FAILED");
  });

  test("REMOTE RECHECK posts to the reconcile-discovery route with NO body and reflects the server outcome (auto-confirmed RECEIPTED)", async () => {
    let captured: { url: string; method: string | undefined; body: unknown } | null = null;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = { url: String(input), method: init?.method, body: init?.body };
      return jsonResponse({ publicationId: PUB_ID, state: "RECEIPTED", receipt: { prUrl: PR_URL, commitSha: COMMIT } });
    }) as typeof fetch;

    const result = await recheckPublicationReconciliation(PUB_ID);
    expect(captured!.url).toContain(`/v1/engineer/publications/${PUB_ID}/reconcile-discovery`);
    expect(captured!.method).toBe("POST");
    expect(captured!.body).toBeUndefined();
    expect(result.state).toBe("RECEIPTED");
  });

  test("REMOTE RECHECK that finds nothing reflects the server's unchanged RECONCILING view (no fake progress)", async () => {
    globalThis.fetch = (async () => jsonResponse(
      { publicationId: PUB_ID, state: "RECONCILING", reconciliation: { reason: "RESTART_UNCERTAIN_DISPATCH", observedRemoteState: "unknown" } },
    )) as unknown as typeof fetch;

    const result = await recheckPublicationReconciliation(PUB_ID);
    expect(result.state).toBe("RECONCILING");
    expect(result.reconciliation?.reason).toBe("RESTART_UNCERTAIN_DISPATCH");
  });
});

describe("reconciliationErrorDetail — honest presentation of the server's typed rejection", () => {
  test("a PUBLICATION_RECEIPT_BINDING (R7-1) rejection is presented as a receipt-does-not-match message with a safe next step, not a bare failure", () => {
    const detail = reconciliationErrorDetail(new ResolutionApiError(
      409,
      "manual RECEIPTED prUrl does not match the discovered open-draft pull request for this publication",
      "PUBLICATION_RECEIPT_BINDING",
      null,
      null,
    ));
    expect(detail.code).toBe("PUBLICATION_RECEIPT_BINDING");
    expect(detail.message).toBe(RECONCILIATION_BINDING_REJECTED);
    // Honest: names the verified-candidate / confirmed-PR requirement and that nothing changed.
    expect(detail.cause).toContain("verified candidate");
    expect(detail.cause).toContain("open-draft");
    expect(detail.spent.toLowerCase()).toContain("nothing");
    expect(detail.nextAction.length).toBeGreaterThan(0);
  });

  test("the RECEIPT-required (shape) rejection is distinguished from the binding rejection", () => {
    const detail = reconciliationErrorDetail(new ResolutionApiError(
      400, "a RECEIPTED reconciliation must carry a real receipt", "PUBLICATION_RECONCILIATION_RECEIPT_REQUIRED", null, null,
    ));
    expect(detail.code).toBe("PUBLICATION_RECONCILIATION_RECEIPT_REQUIRED");
    expect(detail.message).not.toBe(RECONCILIATION_BINDING_REJECTED);
  });

  test("an unknown/other error still yields a full ActionErrorDetail (never a bare string)", () => {
    const detail = reconciliationErrorDetail(new Error("network down"));
    expect(detail.message.length).toBeGreaterThan(0);
    expect(detail.cause.length).toBeGreaterThan(0);
    expect(detail.nextAction.length).toBeGreaterThan(0);
    expect(detail.spent.length).toBeGreaterThan(0);
  });
});

describe("canSubmitVerifiedReceipt — client-side pre-gate (never a substitute for the server binding check)", () => {
  test("requires a non-empty prUrl and a 40/64-hex commitSha", () => {
    expect(canSubmitVerifiedReceipt({ prUrl: PR_URL, commitSha: COMMIT })).toBe(true);
    expect(canSubmitVerifiedReceipt({ prUrl: PR_URL, commitSha: "s".repeat(64) })).toBe(false);
    expect(canSubmitVerifiedReceipt({ prUrl: "", commitSha: COMMIT })).toBe(false);
    expect(canSubmitVerifiedReceipt({ prUrl: PR_URL, commitSha: "abc" })).toBe(false);
    expect(canSubmitVerifiedReceipt({ prUrl: "  ", commitSha: COMMIT })).toBe(false);
  });
});
