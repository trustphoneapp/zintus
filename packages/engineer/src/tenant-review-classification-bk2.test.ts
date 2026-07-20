/**
 * R8-5 BK2 (reviewer + classification) — cross-org isolation for the tables this
 * bucket owns: reviewer_sessions, review_classification_batches, review_findings,
 * review_finding_classifications, evidence_bundles.
 *
 * The security property (contract §0/§2): an org-B principal can NEVER read, list,
 * infer the existence of, or write into org-A's reviewer/classification/evidence
 * rows. A cross-org id is INDISTINGUISHABLE from an absent id (identical null / no
 * leaked run_id oracle), and an org-B write is stamped with org B's id — it must
 * never default into org A.
 *
 * RED-first (proven against the pre-predicate code):
 *  - reviewClassificationRunId(foreignSessionId) leaked org A's run_id (oracle);
 *  - getReviewClassification(foreignSessionId) reached org A's batch row (parse
 *    throw) instead of the clean null an absent id yields;
 *  - recordEvidenceBundle on org B's ledger wrote a row that DEFAULTED to org A's
 *    org_id (the column default), making org B's evidence visible under org A.
 * GREEN after: every cross-org read collapses to the identical null, and every
 * org-B insert carries org B's id.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createTwoOrgFixture, type TwoOrgFixture } from "./test-support/two-org-fixture.js";
import type { EvidenceBundleRecord } from "./verification-contracts.js";

const NOW = "2026-07-20T00:00:00.000Z";
const H = (c: string) => `sha256:${c.repeat(64)}`;

let fixture: TwoOrgFixture;
afterEach(() => { fixture?.cleanup(); });

/**
 * Plant a review_classification_batches row OWNED BY ORG A (org_id = orgAId). The
 * v18 completeness trigger guards production writes only; drop it in this isolated
 * temp db so a minimal foreign-owned row can be seeded. `batch_json` is minimal so
 * a PRE-FIX foreign getReviewClassification would parse-throw (an observable that
 * differs from the null an absent id returns) — POST-FIX both are null.
 */
function seedOrgABatch(f: TwoOrgFixture, sessionId: string, runId: string): void {
  const seed = f.seed();
  seed.exec("DROP TRIGGER IF EXISTS require_complete_review_classification_batch_v18");
  seed.query(
    "INSERT INTO review_classification_batches(classification_hash, reviewer_session_id, run_id," +
      " contract_hash, schema_version, policy_version, raw_output_artifact_id, raw_output_hash," +
      " normalized_output_hash, normalized_session_hash, normalized_findings_hash, batch_json," +
      " created_at, org_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    H("a"), sessionId, runId, H("b"), 1, "review-policy-v1", "raw-artifact-a", H("c"),
    H("d"), H("e"), H("f"), "{}", NOW, f.orgAId,
  );
  seed.close();
}

describe("§2 BK2 review_classification_batches — cross-org reviewerSessionId is indistinguishable from absent", () => {
  test("reviewClassificationRunId: org B reading org A's session id returns the IDENTICAL null (no run_id oracle)", () => {
    fixture = createTwoOrgFixture({ now: NOW });
    const orgB = fixture.ledgerB();
    const orgASessionId = "reviewer-session-owned-by-org-a";
    seedOrgABatch(fixture, orgASessionId, "run-owned-by-org-a");

    const absent = orgB.reviewClassificationRunId("no-such-session");
    const foreign = orgB.reviewClassificationRunId(orgASessionId);

    expect(absent).toBeNull();
    expect(foreign).toBeNull();
    expect(foreign).toEqual(absent);
  });

  test("getReviewClassification: org B reading org A's session id returns the IDENTICAL null as an absent id", () => {
    fixture = createTwoOrgFixture({ now: NOW });
    const orgB = fixture.ledgerB();
    const orgASessionId = "reviewer-session-owned-by-org-a-2";
    seedOrgABatch(fixture, orgASessionId, "run-owned-by-org-a-2");

    const absent = orgB.getReviewClassification("no-such-session");
    const foreign = orgB.getReviewClassification(orgASessionId);

    expect(absent).toBeNull();
    expect(foreign).toBeNull();
    expect(foreign).toEqual(absent);
  });

  test("org A still reads its OWN planted batch's run_id (predicate scopes, not blanket-hides)", () => {
    fixture = createTwoOrgFixture({ now: NOW });
    // Force org B construction first so the shared schema is validated clean.
    fixture.ledgerB();
    const orgA = fixture.ledgerA();
    const orgASessionId = "reviewer-session-owned-by-org-a-3";
    seedOrgABatch(fixture, orgASessionId, "run-a-visible-to-a");
    expect(orgA.reviewClassificationRunId(orgASessionId)).toBe("run-a-visible-to-a");
  });
});

describe("§2 BK2 evidence_bundles — an org-B write is stamped with org B (never defaults into org A)", () => {
  test("recordEvidenceBundle on org B's ledger persists org_id = org B", () => {
    fixture = createTwoOrgFixture({ now: NOW });
    const orgB = fixture.ledgerB();
    const runB = "run-owned-by-org-b";

    // Plant org B's run + repo (FK-off seed) so getRun(runB) on org B succeeds.
    const seed = fixture.seed();
    seed.query(
      "INSERT INTO repository_connections(id,user_id,provider,owner,name,created_at,updated_at,org_id)" +
        " VALUES (?,?,?,?,?,?,?,?)",
    ).run("repo-b", "user-b", "local", "o", "n", NOW, NOW, fixture.orgBId);
    seed.query(
      "INSERT INTO engineer_runs(id,user_id,repository_id,base_branch,base_commit_sha,request_original," +
        "request_normalized,state,state_version,risk_tier,human_gate_required,created_at,updated_at,org_id)" +
        " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(runB, "user-b", "repo-b", "main", "f".repeat(40), "req", "req", "REQUEST_RECEIVED", 0, "MEDIUM", 0, NOW, NOW, fixture.orgBId);
    seed.close();

    const record = {
      evidenceBundleId: "evidence-bundle-org-b-1",
      bundleHash: H("e"),
      bundle: {
        bundleVersion: 1,
        runId: runB,
        manifestHash: H("a"),
        baseCommitSha: "b".repeat(40),
        resultCommitSha: "c".repeat(40),
        environmentDigest: H("d"),
        artifacts: [],
        claims: [],
        finalDecision: "APPROVE",
        createdAt: NOW,
      },
    } as unknown as EvidenceBundleRecord;

    orgB.recordEvidenceBundle(record);

    // The durable row must carry ORG B's id — not the column default (= org A).
    const check = fixture.seed();
    const row = check.query("SELECT org_id FROM evidence_bundles WHERE id = ?")
      .get("evidence-bundle-org-b-1") as { org_id: string } | null;
    check.close();

    expect(row).not.toBeNull();
    expect(row!.org_id).toBe(fixture.orgBId);
    expect(row!.org_id).not.toBe(fixture.orgAId);

    // And org B can read its own bundle back through the org-scoped list path.
    const listed = orgB.listEvidenceBundles(runB);
    expect(listed.map((b) => b.evidenceBundleId)).toContain("evidence-bundle-org-b-1");
  });
});
