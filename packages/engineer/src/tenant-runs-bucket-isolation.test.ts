import { afterEach, describe, expect, test } from "bun:test";
import { EngineerNotFoundError } from "./errors.js";
import { createTwoOrgFixture, type TwoOrgFixture } from "./test-support/two-org-fixture.js";
import type { LedgerCreateRunInput } from "./ledger.js";
import type { CheckpointAttestor } from "./verified-candidate-checkpoint.js";

/**
 * R8-5 BK1 (runs-core) cross-tenant isolation — RED-first proofs for the
 * `engineer_runs`, `run_budgets`, `run_state_events`, `task_manifest_versions`,
 * and `repository_admissions` data-access sites converted in this bucket.
 *
 * The security property (contract §0/§2): an org-B principal can never read,
 * list, write, or infer the existence of org-A's runs/budgets/events/manifests/
 * admissions. A cross-org id is INDISTINGUISHABLE from an absent id — identical
 * `EngineerNotFoundError` / identical `null` / identical invisibility.
 *
 * Each test REDS on the pre-conversion code (org B leaks org A's row or gets a
 * distinguishable oracle) and GREENS after the `AND org_id = @tenantOrgId`
 * predicate. Verified red-first by reverting individual predicates during
 * development (see the bucket report).
 */
const NOW = "2026-07-20T00:00:00.000Z";

const stubAttestor: CheckpointAttestor = {
  algorithm: "test",
  keyId: "test-key",
  sign: () => "sig",
  verify: () => true,
};

function orgARunInput(): LedgerCreateRunInput {
  return {
    runId: "run-owned-by-org-a",
    userId: "user-a-owner",
    repository: {
      repositoryId: "repo-a",
      provider: "local",
      owner: "local",
      name: "repo",
      baseBranch: "main",
      baseCommitSha: "a".repeat(40),
    },
    requestOriginal: "org A private work",
    riskTier: "MEDIUM",
    humanGateRequired: true,
    now: NOW,
    budget: {
      costBudgetUsd: 5,
      tokenBudget: 5000,
      timeBudgetSeconds: 600,
      lifetimeCostBudgetUsd: 5,
      lifetimeTokenBudget: 5000,
      lifetimeTimeBudgetSeconds: 600,
    },
  } as unknown as LedgerCreateRunInput;
}

let fixture: TwoOrgFixture;
afterEach(() => { fixture?.cleanup(); });

describe("§2 engineer_runs — org B cannot read/write/list org A's run", () => {
  test("getRun / getLastError / setLastError on a cross-org run are the IDENTICAL not-found as an absent run", () => {
    fixture = createTwoOrgFixture({ now: NOW });
    fixture.ledgerA().createRun(orgARunInput());
    const orgB = fixture.ledgerB();

    // Read (getRun)
    let foreignGet: unknown; try { orgB.getRun("run-owned-by-org-a"); } catch (e) { foreignGet = e; }
    let absentGet: unknown; try { orgB.getRun("no-such-run"); } catch (e) { absentGet = e; }
    expect(foreignGet).toBeInstanceOf(EngineerNotFoundError);
    expect(absentGet).toBeInstanceOf(EngineerNotFoundError);
    expect((foreignGet as Error).message.replace("run-owned-by-org-a", "<id>"))
      .toBe((absentGet as Error).message.replace("no-such-run", "<id>"));

    // Read (getLastError)
    let foreignErr: unknown; try { orgB.getLastError("run-owned-by-org-a"); } catch (e) { foreignErr = e; }
    let absentErr: unknown; try { orgB.getLastError("no-such-run"); } catch (e) { absentErr = e; }
    expect(foreignErr).toBeInstanceOf(EngineerNotFoundError);
    expect(absentErr).toBeInstanceOf(EngineerNotFoundError);

    // Write (setLastError) — a cross-org write must NOT touch org A's row.
    let foreignSet: unknown; try { orgB.setLastError("run-owned-by-org-a", "ORG-B-INJECTED", NOW); } catch (e) { foreignSet = e; }
    expect(foreignSet).toBeInstanceOf(EngineerNotFoundError);
    // org A's row is untouched.
    expect(fixture.ledgerA().getLastError("run-owned-by-org-a")).toBeNull();
  });

  test("listRuns / listRunsForUser / listRunObservability never surface org A's run to org B", () => {
    fixture = createTwoOrgFixture({ now: NOW });
    fixture.ledgerA().createRun(orgARunInput());
    const orgB = fixture.ledgerB();

    expect(orgB.listRuns().map((r) => r.runId)).not.toContain("run-owned-by-org-a");
    expect(orgB.listRuns()).toHaveLength(0);
    expect(orgB.listRunsForUser("user-a-owner")).toHaveLength(0);
    expect(orgB.listRunObservability()).toHaveLength(0);
    // org A still sees its own run.
    expect(fixture.ledgerA().listRuns().map((r) => r.runId)).toContain("run-owned-by-org-a");
  });
});

describe("§2 createRun INSERT stamp — a run created by org B is stamped org B, invisible to org A", () => {
  test("ledgerB().createRun stamps org_id=orgB so org A gets the IDENTICAL not-found while org B sees run + budget", () => {
    fixture = createTwoOrgFixture({ now: NOW });
    const orgB = fixture.ledgerB();
    const orgA = fixture.ledgerA();

    // Create the run through ORG B's ledger. createRun needs no admission — it
    // inserts the user/connection/run/budget directly, all stamped this.tenantOrgId.
    orgB.createRun({
      runId: "run-owned-by-org-b",
      userId: "user-b-owner",
      repository: {
        repositoryId: "repo-b",
        provider: "local",
        owner: "local",
        name: "repo-b",
        baseBranch: "main",
        baseCommitSha: "b".repeat(40),
      },
      requestOriginal: "org B private work",
      riskTier: "MEDIUM",
      humanGateRequired: true,
      now: NOW,
      budget: {
        costBudgetUsd: 3,
        tokenBudget: 3000,
        timeBudgetSeconds: 600,
        lifetimeCostBudgetUsd: 3,
        lifetimeTokenBudget: 3000,
        lifetimeTimeBudgetSeconds: 600,
      },
    } as unknown as LedgerCreateRunInput);

    // Org B sees its own run + budget.
    expect(orgB.getRun("run-owned-by-org-b").runId).toBe("run-owned-by-org-b");
    expect(orgB.getBudget("run-owned-by-org-b", NOW).runId).toBe("run-owned-by-org-b");
    expect(orgB.listRuns().map((r) => r.runId)).toContain("run-owned-by-org-b");

    // Org A (the default org) must NOT see the org-B run: a foreign id and an
    // absent id both funnel to the IDENTICAL not-found. If the createRun INSERT
    // stamp were dropped (org_id DEFAULTing to the default/org-A), org A would
    // read the run here — this is the load-bearing assertion for the stamp.
    let foreignRun: unknown; try { orgA.getRun("run-owned-by-org-b"); } catch (e) { foreignRun = e; }
    let absentRun: unknown; try { orgA.getRun("no-such-run"); } catch (e) { absentRun = e; }
    expect(foreignRun).toBeInstanceOf(EngineerNotFoundError);
    expect(absentRun).toBeInstanceOf(EngineerNotFoundError);
    expect((foreignRun as Error).message.replace("run-owned-by-org-b", "<id>"))
      .toBe((absentRun as Error).message.replace("no-such-run", "<id>"));

    // ...and org A cannot read the org-B budget row either (run_budgets INSERT stamp).
    let foreignBudget: unknown; try { orgA.getBudget("run-owned-by-org-b", NOW); } catch (e) { foreignBudget = e; }
    expect(foreignBudget).toBeInstanceOf(EngineerNotFoundError);
    expect(orgA.listRuns().map((r) => r.runId)).not.toContain("run-owned-by-org-b");
  });
});

describe("§2 run_budgets — org B cannot read org A's budget", () => {
  test("getBudget on a cross-org run is the IDENTICAL not-found as an absent run", () => {
    fixture = createTwoOrgFixture({ now: NOW });
    fixture.ledgerA().createRun(orgARunInput());
    const orgB = fixture.ledgerB();

    let foreign: unknown; try { orgB.getBudget("run-owned-by-org-a", NOW); } catch (e) { foreign = e; }
    let absent: unknown; try { orgB.getBudget("no-such-run", NOW); } catch (e) { absent = e; }
    expect(foreign).toBeInstanceOf(EngineerNotFoundError);
    expect(absent).toBeInstanceOf(EngineerNotFoundError);
    expect((foreign as Error).message.replace("run-owned-by-org-a", "<id>"))
      .toBe((absent as Error).message.replace("no-such-run", "<id>"));
    // org A can still read its own budget.
    expect(fixture.ledgerA().getBudget("run-owned-by-org-a", NOW).runId).toBe("run-owned-by-org-a");
  });
});

describe("§2 task_manifest_versions — org B cannot read org A's manifest", () => {
  test("getManifest for a cross-org run is the IDENTICAL null as an absent run (never parses org A's manifest bytes)", () => {
    fixture = createTwoOrgFixture({ now: NOW });
    fixture.ledgerA().createRun(orgARunInput());
    const orgB = fixture.ledgerB();

    // Plant a task_manifest_versions row OWNED BY ORG A with deliberately invalid
    // manifest_json: a PRE-FIX foreign read would TaskManifestSchema.parse('{}')
    // and throw (an observable oracle), while an absent run returns null. POST-FIX
    // both collapse to the identical null.
    const seed = fixture.seed();
    seed.query(
      "INSERT INTO task_manifest_versions(id, run_id, version, manifest_hash, manifest_json, created_at, org_id)" +
        " VALUES (?,?,?,?,?,?,?)",
    ).run("tmv-a", "run-owned-by-org-a", 1, `sha256:${"a".repeat(64)}`, "{}", NOW, fixture.orgAId);
    seed.close();

    const foreign = orgB.getManifest("run-owned-by-org-a");
    const absent = orgB.getManifest("no-such-run");
    expect(foreign).toBeNull();
    expect(absent).toBeNull();
    expect(foreign).toEqual(absent);
  });
});

describe("§2 run_state_events — org B cannot read org A's events", () => {
  test("replayTransition against a cross-org event is the IDENTICAL null as an absent event", () => {
    fixture = createTwoOrgFixture({ now: NOW });
    fixture.ledgerA().createRun(orgARunInput());
    const orgB = fixture.ledgerB();

    // Plant a run_state_events row OWNED BY ORG A. PRE-FIX a foreign replay would
    // find it and either return a replay (leak) or throw IdempotencyConflictError
    // (oracle); POST-FIX the org predicate makes it invisible → null, identical to
    // a truly-absent idempotency key.
    const seed = fixture.seed();
    seed.query(
      "INSERT INTO run_state_events(event_id, run_id, sequence, previous_state, next_state, reason_code," +
        " actor_type, actor_id, timestamp, evidence_ids_json, manifest_hash, state_version, idempotency_key, org_id)" +
        " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run("evt-a", "run-owned-by-org-a", 1, "REQUEST_RECEIVED", "PLANNING", "PLANNING_STARTED",
      "SUPERVISOR", "engineer-supervisor", NOW, "[]", null, 1, "org-a-key", fixture.orgAId);
    seed.close();

    const foreign = orgB.replayTransition({
      runId: "run-owned-by-org-a", idempotencyKey: "org-a-key", nextState: "PLANNING",
      reasonCode: "PLANNING_STARTED", actorType: "SUPERVISOR", actorId: "engineer-supervisor",
      evidenceIds: [], manifestHash: null,
    });
    const absent = orgB.replayTransition({
      runId: "run-owned-by-org-a", idempotencyKey: "no-such-key", nextState: "PLANNING",
      reasonCode: "PLANNING_STARTED", actorType: "SUPERVISOR", actorId: "engineer-supervisor",
      evidenceIds: [], manifestHash: null,
    });
    expect(foreign).toBeNull();
    expect(absent).toBeNull();
  });

  test("getVerifiedCandidateCheckpoint({runId}) for a cross-org run is the IDENTICAL null as an absent run", async () => {
    fixture = createTwoOrgFixture({ now: NOW });
    fixture.ledgerA().createRun(orgARunInput());
    const orgB = fixture.ledgerB();

    // Plant a promotion event OWNED BY ORG A but NO org-B checkpoint. PRE-FIX the
    // event read is unscoped: org B finds org A's promotion event, extracts the
    // checkpointId, the (org-scoped) checkpoint lookup misses, and it throws a
    // VerifiedCandidateIntegrityError — distinguishable from the clean null an
    // absent run yields. POST-FIX the org-scoped event read returns [] → null.
    const seed = fixture.seed();
    seed.query(
      "INSERT INTO run_state_events(event_id, run_id, sequence, previous_state, next_state, reason_code," +
        " actor_type, actor_id, timestamp, evidence_ids_json, manifest_hash, state_version, idempotency_key, org_id)" +
        " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run("promo-a", "run-owned-by-org-a", 1, "REVIEWING", "REVIEW_APPROVED", "VERIFIED_CANDIDATE_PROMOTED",
      "SUPERVISOR", "engineer-supervisor", NOW, JSON.stringify([`sha256:${"c".repeat(64)}`]), null, 1, "promo-key", fixture.orgAId);
    seed.close();

    const foreign = await orgB.getVerifiedCandidateCheckpoint({ runId: "run-owned-by-org-a" }, stubAttestor);
    const absent = await orgB.getVerifiedCandidateCheckpoint({ runId: "no-such-run" }, stubAttestor);
    expect(foreign).toBeNull();
    expect(absent).toBeNull();
    expect(foreign).toEqual(absent);
  });
});

describe("§2 repository_admissions — org B cannot read/list org A's admission", () => {
  test("getRepositoryAdmission / listRepositoryAdmissions never surface org A's admission to org B", () => {
    fixture = createTwoOrgFixture({ now: NOW });
    // createRun seeds an org-A repository_connections row we can attach an admission to.
    fixture.ledgerA().createRun(orgARunInput());
    const orgB = fixture.ledgerB();

    const seed = fixture.seed();
    seed.query(
      "INSERT INTO repository_admissions(admission_id, repository_id, owner_user_id, base_branch, base_commit_sha," +
        " source, authorization_subject, authorization_evidence_hash, authorization_expires_at," +
        " authorization_generation, status, created_at, updated_at, org_id)" +
        " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run("adm-a", "repo-a", "user-a-owner", "main", "a".repeat(40), "CONFIGURED_CANONICAL",
      "org-a-subject", `sha256:${"e".repeat(64)}`, null, 1, "ACTIVE", NOW, NOW, fixture.orgAId);
    seed.close();

    expect(orgB.getRepositoryAdmission("user-a-owner", "repo-a")).toBeNull();
    expect(orgB.listRepositoryAdmissions("user-a-owner")).toHaveLength(0);
    // org A still sees its own admission.
    expect(fixture.ledgerA().getRepositoryAdmission("user-a-owner", "repo-a")?.status).toBe("ACTIVE");
  });
});
