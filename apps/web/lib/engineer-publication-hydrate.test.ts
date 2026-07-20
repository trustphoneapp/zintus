import { afterEach, describe, expect, test } from "bun:test";
import { hydratePublicationDesk } from "./engineer-publication-hydrate";
import { getCurrentPublication, type CurrentPublication } from "./engineer-resolution";

const nativeFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = nativeFetch; });

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const CK_ID = `sha256:${"a".repeat(64)}`;
const CK_HASH = `sha256:${"b".repeat(64)}`;

/**
 * A run mid-publication: the durable server projection carries a DISPATCHED
 * publication with its approval + selected candidate. This is exactly the state
 * a browser refresh must restore.
 */
const activeCurrent: CurrentPublication = {
  publicationId: "pub-1",
  runId: "run-1",
  state: "DISPATCHED",
  approvalId: "approval-1",
  approvalStatus: "APPROVED",
  checkpointId: CK_ID,
  checkpointHash: CK_HASH,
  lineage: "ORIGINAL",
  lineageVerified: true,
};

/**
 * Routes each mocked GET to its live route shape. `/current-publication` MUST be
 * matched before `/publication-candidates` here only for clarity; the paths are
 * disjoint so order is immaterial.
 */
function mockServer(current: { publication: CurrentPublication | null }, candidates: unknown[]) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/current-publication")) return jsonResponse(current);
    if (url.includes("/publication-candidates")) return jsonResponse({ candidates });
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
}

/**
 * R7-2 (FINDING #3): a mid-publication refresh must restore the EXACT durable
 * publication from the server projection — not fall back to a blank
 * candidate-only screen with the in-flight publication lost. These exercise the
 * loader the page re-runs on every load/refresh.
 *
 * RED against pre-R7-2 code: `getCurrentPublication` / `hydratePublicationDesk`
 * did not exist (the page loader only fetched candidates), so importing them
 * fails and there is no server projection to restore from.
 */
describe("hydratePublicationDesk — refresh restores the durable current publication", () => {
  test("a refresh mid-publication restores the current publication + approval + selected candidate from the server", async () => {
    mockServer({ publication: activeCurrent }, [
      { checkpointId: CK_ID, checkpointHash: CK_HASH, lineage: "ORIGINAL", lineageVerified: true },
    ]);

    const hydration = await hydratePublicationDesk("run-1");

    // The active publication is restored from the server — NOT dropped.
    expect(hydration.current).not.toBeNull();
    expect(hydration.current!.publicationId).toBe("pub-1");
    expect(hydration.current!.state).toBe("DISPATCHED");
    expect(hydration.current!.approvalId).toBe("approval-1");
    expect(hydration.current!.approvalStatus).toBe("APPROVED");
    expect(hydration.current!.checkpointId).toBe(CK_ID);
    expect(hydration.current!.lineage).toBe("ORIGINAL");
    // Candidates are still loaded for the render tree.
    expect(hydration.candidates).toHaveLength(1);
  });

  test("carries the receipt when the restored publication is RECEIPTED", async () => {
    mockServer({
      publication: { ...activeCurrent, state: "RECEIPTED", receipt: { prUrl: "https://x/pr/1", commitSha: "1".repeat(40) } },
    }, [{ checkpointId: CK_ID, checkpointHash: CK_HASH, lineage: "ORIGINAL", lineageVerified: true }]);

    const hydration = await hydratePublicationDesk("run-1");
    expect(hydration.current!.state).toBe("RECEIPTED");
    expect(hydration.current!.receipt).toEqual({ prUrl: "https://x/pr/1", commitSha: "1".repeat(40) });
  });

  test("no active publication → current is null and the candidate-selection flow runs as before", async () => {
    mockServer({ publication: null }, [
      { checkpointId: CK_ID, checkpointHash: CK_HASH, lineage: "ORIGINAL", lineageVerified: true },
    ]);

    const hydration = await hydratePublicationDesk("run-1");
    expect(hydration.current).toBeNull();
    expect(hydration.candidates).toHaveLength(1);
  });

  test("getCurrentPublication unwraps the { publication } envelope the route returns", async () => {
    globalThis.fetch = (async (_input: RequestInfo | URL) => jsonResponse({ publication: activeCurrent })) as unknown as typeof fetch;
    expect(await getCurrentPublication("run-1")).toEqual(activeCurrent);
  });
});
