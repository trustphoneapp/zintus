import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { EngineerNotFoundError } from "./errors.js";
import { createTwoOrgFixture, type TwoOrgFixture } from "./test-support/two-org-fixture.js";
import type { PlanProposal } from "./planning.js";
import type { CheckpointAttestor } from "./verified-candidate-checkpoint.js";

/**
 * R8-5 (contract §2/§8) — the anti-oracle NotFound funnel wired at two
 * REPRESENTATIVE dangerous id-keyed sites. The security property under test: an
 * org-B principal requesting an org-A id gets the SAME outcome as a truly-absent
 * id — no distinguishable "forbidden"/leaked variant that would let org B infer
 * org A's data exists.
 *
 * RED (before the org predicate): org B saw org A's checkpoint row (parse throws)
 * / read org A's artifact bytes (integrity TypeError) — distinguishable from the
 * clean not-found an absent id produces. GREEN: both collapse to the identical
 * not-found.
 */
const NOW = "2026-07-20T00:00:00.000Z";
const ABSENT_CHECKPOINT_ID = `sha256:${"0".repeat(64)}`;

// The null-return path in getVerifiedCandidateCheckpoint is reached BEFORE the
// attestor is ever consulted, so a stub is safe here.
const stubAttestor: CheckpointAttestor = {
  algorithm: "test",
  keyId: "test-key",
  sign: () => "sig",
  verify: () => true,
};

let fixture: TwoOrgFixture;
afterEach(() => { fixture?.cleanup(); });

describe("§8 getVerifiedCandidateCheckpoint — cross-org checkpointId is indistinguishable from absent", () => {
  test("org B reading org A's checkpoint id returns the IDENTICAL null as an absent id", async () => {
    fixture = createTwoOrgFixture({ now: NOW });
    const orgACheckpointId = `sha256:${"a".repeat(64)}`;
    // Construct org B's ledger BEFORE seeding: its migration validates schema
    // shape + foreign keys, so the trigger-drop and dangling-FK seed rows below
    // must land AFTER construction (they are confined to this temp db).
    const orgB = fixture.ledgerB();

    // Plant a checkpoint OWNED BY ORG A. The insert trigger only guards production
    // writes; drop it in this isolated temp db so a minimal row can be seeded with
    // an intentionally invalid checkpoint_json (so a PRE-FIX foreign read would
    // throw on parse — an observable oracle — while an absent id returns null).
    const seed = fixture.seed();
    seed.exec("DROP TRIGGER IF EXISTS require_verified_candidate_checkpoint_bindings_v21");
    seed.query(
      "INSERT INTO verified_candidate_checkpoints(id, checkpoint_hash, parent_checkpoint_id, run_id," +
        " requester_user_id, repository_id, required_lane_contract_hash, manifest_hash, base_commit_sha," +
        " result_commit_sha, diff_hash, reviewer_session_id, classification_hash, classification_result," +
        " evidence_bundle_id, evidence_bundle_hash, environment_digest, checkpoint_json, statement_json," +
        " statement_hash, signature_algorithm, signature_key_id, signature, created_at, org_id)" +
        " VALUES (?,?,NULL,?,?,?,?,?,?,?,?,?,?, 'READY', ?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      orgACheckpointId, `sha256:${"b".repeat(64)}`, "run-a", "user-a", "repo-a", `sha256:${"c".repeat(64)}`,
      `sha256:${"d".repeat(64)}`, "base-sha", "result-sha", `sha256:${"e".repeat(64)}`, "reviewer-a",
      `sha256:${"f".repeat(64)}`, "ev-bundle-a", `sha256:${"1".repeat(64)}`, "env-digest",
      "{}", "{}", `sha256:${"2".repeat(64)}`, "ed25519", "key-a", "sig-a", NOW, fixture.orgAId,
    );
    seed.close();

    const absent = await orgB.getVerifiedCandidateCheckpoint({ checkpointId: ABSENT_CHECKPOINT_ID }, stubAttestor);
    const foreign = await orgB.getVerifiedCandidateCheckpoint({ checkpointId: orgACheckpointId }, stubAttestor);

    expect(absent).toBeNull();
    expect(foreign).toBeNull();
    expect(foreign).toEqual(absent);
  });
});

describe("§8 recordPlanProposal artifact byte read — cross-org artifactId is indistinguishable from absent", () => {
  test("org B referencing org A's artifact throws the IDENTICAL not-found as an absent id (never reads foreign bytes)", () => {
    fixture = createTwoOrgFixture({ now: NOW });
    const orgAArtifactId = "artifact-owned-by-org-a";
    const orgARunId = "run-owned-by-org-a";
    const secretPath = join(fixture.root, "org-a-secret-plan.json");
    const secretBytes = Buffer.from(JSON.stringify({ secret: "ORG-A-PRIVATE-PLAN-BYTES" }), "utf8");
    writeFileSync(secretPath, secretBytes);
    // Construct org B's ledger BEFORE seeding dangling-FK rows (see note above).
    const orgB = fixture.ledgerB();

    // Plant a PLAN_PROPOSAL artifact OWNED BY ORG A pointing at real secret bytes.
    // A deliberately-wrong sha256 means a PRE-FIX foreign read would readFileSync
    // the secret then throw an integrity TypeError — proving the bytes were reached
    // — whereas an absent id throws the not-found. POST-FIX both are the not-found.
    const seed = fixture.seed();
    seed.query(
      "INSERT INTO artifacts(id, run_id, type, sha256, producer_type, producer_id, storage_reference," +
        " size_bytes, trusted, created_at, org_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      orgAArtifactId, orgARunId, "PLAN_PROPOSAL", `sha256:${"0".repeat(64)}`, "AGENT", "planner-a",
      secretPath, secretBytes.byteLength, 1, NOW, fixture.orgAId,
    );
    seed.close();

    const proposalForForeignArtifact = {
      planProposalId: "pp-x", runId: orgARunId, artifactId: orgAArtifactId,
      proposalHash: `sha256:${"3".repeat(64)}`, proposalSchemaVersion: 1, plannerPolicyVersion: "p",
      manifest: {}, planningAnalysis: {}, contextManifestHash: `sha256:${"4".repeat(64)}`, createdAt: NOW,
    } as unknown as PlanProposal;
    const proposalForAbsentArtifact = { ...proposalForForeignArtifact, artifactId: "no-such-artifact" } as unknown as PlanProposal;

    let foreignError: unknown;
    try { orgB.recordPlanProposal(proposalForForeignArtifact, 0); } catch (error) { foreignError = error; }
    let absentError: unknown;
    try { orgB.recordPlanProposal(proposalForAbsentArtifact, 0); } catch (error) { absentError = error; }

    // Both must be the IDENTICAL not-found (same class, same message shape). Before
    // the fix the foreign case threw a TypeError (bytes already read) — an oracle.
    expect(absentError).toBeInstanceOf(EngineerNotFoundError);
    expect(foreignError).toBeInstanceOf(EngineerNotFoundError);
    expect((foreignError as Error).name).toBe((absentError as Error).name);
    expect((foreignError as EngineerNotFoundError).message.replace(orgAArtifactId, "<id>"))
      .toBe((absentError as EngineerNotFoundError).message.replace("no-such-artifact", "<id>"));
  });
});
