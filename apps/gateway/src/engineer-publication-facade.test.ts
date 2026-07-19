import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  ENGINEER_DATABASE_SCHEMA_SQL,
  migrateEngineerDatabase,
  PublicationAuthorityService,
  PUBLICATION_AUTHORITY_POLICY_VERSION,
  ResolutionLineageVerifier,
  type ActuatorOutcome,
  type CompanionLineageVerifier,
  type PublicationActuator,
  type PublicationAuthorityDeps,
} from "@zintus/engineer";
import { deriveEngineerPrincipal } from "./engineer-identity.js";
import {
  createEngineerPublicationAuthorityFacade,
  CandidateNotFoundError,
  PublicationAttestationUnavailableError,
  type PublicationFacadeDeps,
} from "./engineer-publication-facade.js";

const AT = "2026-07-19T12:00:00.000Z";
const CK_ID = `sha256:${"a".repeat(64)}`;
const CK_HASH = `sha256:${"b".repeat(64)}`;
const RESULT_COMMIT = "1".repeat(40);
const BASE_COMMIT = "0".repeat(40);
const RUN_ID = "run-1";
const REPO_ID = "repo-1";
const POLICY = PUBLICATION_AUTHORITY_POLICY_VERSION;
const principal = deriveEngineerPrincipal({ gatewayIdentitySecret: "publication-facade-owner" });

/** Deterministic `sha256:<64hex>` authority tag for seeding format-checked columns. */
function hx(seed: string): string {
  return `sha256:${createHash("sha256").update(seed).digest("hex")}`;
}

/**
 * Seed a PROMOTED verified_candidate_checkpoints row directly. The v21 binding
 * trigger + the dependency FKs (contracts/reviewers/bundles) are covered by their
 * own suites; we drop the binding trigger and seed with FK enforcement off so the
 * facade's server-derivation (which reads this durable row) can be exercised in
 * isolation. org_id defaults to the seeded single-tenant org.
 */
function seedCheckpoint(db: Database, opts: {
  id: string; hash: string; runId: string; owner: string; repositoryId: string; resultCommit: string; nonce: string;
}): void {
  db.exec("DROP TRIGGER IF EXISTS require_verified_candidate_checkpoint_bindings_v21");
  db.exec("PRAGMA foreign_keys=OFF");
  db.query(
    "INSERT INTO verified_candidate_checkpoints(id,checkpoint_hash,parent_checkpoint_id,run_id,requester_user_id," +
      "repository_id,required_lane_contract_hash,manifest_hash,base_commit_sha,result_commit_sha,diff_hash," +
      "reviewer_session_id,classification_hash,classification_result,evidence_bundle_id,evidence_bundle_hash," +
      "environment_digest,checkpoint_json,statement_json,statement_hash,signature_algorithm,signature_key_id," +
      "signature,created_at) VALUES (?,?,NULL,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    opts.id, opts.hash, opts.runId, opts.owner, opts.repositoryId, hx(`contract-${opts.nonce}`), hx(`manifest-${opts.nonce}`),
    BASE_COMMIT, opts.resultCommit, hx(`diff-${opts.nonce}`), `reviewer-${opts.nonce}`, hx(`class-${opts.nonce}`),
    "READY", `bundle-${opts.nonce}`, hx(`bundle-${opts.nonce}`), hx(`env-${opts.nonce}`), "{}", "{}",
    hx(`stmt-${opts.nonce}`), "ed25519", "key-1", "sig", AT);
  db.exec("PRAGMA foreign_keys=ON");
}

function seedRun(db: Database, runId: string, owner: string): void {
  db.query(`INSERT INTO engineer_runs(id, user_id, repository_id, base_branch, base_commit_sha,
    request_original, state, risk_tier, human_gate_required, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      runId, owner, REPO_ID, "main", BASE_COMMIT, "do the thing", "COMPLETED", "HIGH", 1, AT, AT);
}

// v33 slice via the live migration chain (exactly as production installs it). The
// run's user_id is the SERVER principal's ownerId, and the ORIGINAL candidate
// checkpoint CK_ID is a PROMOTED verified_candidate_checkpoints row owned by the
// principal — the durable authority the facade now derives from.
function scratchDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(ENGINEER_DATABASE_SCHEMA_SQL);
  db.query("INSERT INTO schema_migrations(version, applied_at) VALUES (14, ?)").run(AT);
  migrateEngineerDatabase(db, AT);
  db.query("INSERT INTO users(id, created_at, updated_at) VALUES (?,?,?)").run(principal.ownerId, AT, AT);
  db.query(`INSERT INTO repository_connections(id, user_id, provider, owner, name, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?)`).run(REPO_ID, principal.ownerId, "local", "acme", "svc", AT, AT);
  db.query(`INSERT INTO engineer_runs(id, user_id, repository_id, base_branch, base_commit_sha,
    request_original, state, risk_tier, human_gate_required, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      RUN_ID, principal.ownerId, REPO_ID, "main", BASE_COMMIT, "do the thing", "REVIEW_APPROVED", "HIGH", 1, AT, AT);
  seedCheckpoint(db, { id: CK_ID, hash: CK_HASH, runId: RUN_ID, owner: principal.ownerId, repositoryId: REPO_ID, resultCommit: RESULT_COMMIT, nonce: "orig" });
  return db;
}

let counter = 0;
function makeService(db: Database, lineageVerifier?: CompanionLineageVerifier): PublicationAuthorityService {
  const actuator: PublicationActuator = {
    async createBranchPr(): Promise<ActuatorOutcome> { return { kind: "RECEIPT", prUrl: "https://x/pr/1", commitSha: RESULT_COMMIT }; },
  };
  const deps: PublicationAuthorityDeps = {
    actuator,
    preflight: { probe: (input) => ({ repositoryId: input.repositoryId, baseCommitSha: input.baseCommitSha }) },
    credentialProvider: { getPublicationCredentials: () => ({ token: "ghp_x" }) },
    lineageVerifier,
    now: () => new Date(AT),
    idFactory: () => `id-${(counter += 1)}`,
  };
  return new PublicationAuthorityService(db, deps);
}

function makeFacade(db: Database, overrides: Partial<PublicationFacadeDeps> = {}, lineageVerifier?: CompanionLineageVerifier) {
  const decideCalls: Array<{ record: unknown; provenanceContext: unknown }> = [];
  const deps: PublicationFacadeDeps = {
    service: makeService(db, lineageVerifier),
    principal,
    connection: db,
    now: () => new Date(AT),
    attestationRequired: false,
    latestApprovalRequest: () => null,
    decideApprove: (record, provenanceContext) => { decideCalls.push({ record, provenanceContext }); },
    resultTreeHashFor: () => null,
    ...overrides,
  };
  return { facade: createEngineerPublicationAuthorityFacade(deps), decideCalls, db };
}

// The browser now references a candidate ONLY by opaque checkpointId; every other
// authority field is server-derived. The extra fields here are deliberate hostile
// noise the server must IGNORE.
const selectBody = { checkpointId: CK_ID };

describe("P8 publication facade — server-derived authority", () => {
  test("selectCandidate binds the requester to the server principal owner and derives it from the durable checkpoint", async () => {
    const db = scratchDb();
    const { facade } = makeFacade(db);
    await facade.selectCandidate(principal, RUN_ID, { checkpointId: CK_ID, requesterUserId: "ATTACKER-CONTROLLED" });
    const row = db.query("SELECT requester_user_id, run_id, candidate_run_id FROM publication_candidate_selections_v33 WHERE checkpoint_id=?").get(CK_ID) as { requester_user_id: string; run_id: string; candidate_run_id: string };
    expect(row.requester_user_id).toBe(principal.ownerId);
    expect(row.requester_user_id).not.toBe("ATTACKER-CONTROLLED");
    expect(row.run_id).toBe(RUN_ID);
    expect(row.candidate_run_id).toBe(RUN_ID);
  });

  test("approve (no signer) records the P8 approval with the server-derived approver (reviewer) bound to the selection's requester (owner)", async () => {
    const db = scratchDb();
    const { facade } = makeFacade(db);
    await facade.selectCandidate(principal, RUN_ID, selectBody);
    const result = facade.approve(principal, CK_ID, { checkpointHash: CK_HASH, decision: "APPROVE", policyVersion: POLICY }) as { approvalId: string; status: string };
    expect(result.status).toBe("APPROVED");
    const row = db.query("SELECT requester_actor_id, approver_actor_id, status FROM publication_approvals_v33 WHERE approval_id=?").get(result.approvalId) as { requester_actor_id: string; approver_actor_id: string; status: string };
    expect(row.requester_actor_id).toBe(principal.ownerId);   // requester bound to the selection
    expect(row.approver_actor_id).toBe(principal.reviewerId);  // approver server-derived, distinct
    expect(row.status).toBe("APPROVED");
  });
});

describe("P8 publication facade — R2 server-derivation security (each RED-without-fix)", () => {
  test("a body claiming a foreign repositoryId / resultCommitSha / lineage / candidateRunId is IGNORED — the server-derived values win", async () => {
    const db = scratchDb();
    const { facade } = makeFacade(db);
    // Hostile body: every authority field is a lie. Only checkpointId is honored.
    await facade.selectCandidate(principal, RUN_ID, {
      checkpointId: CK_ID,
      repositoryId: "FOREIGN-REPO",
      resultCommitSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      candidateRunId: "FOREIGN-RUN",
      lineage: "P7_REPLACEMENT",
      requesterUserId: "FOREIGN-OWNER",
      checkpointHash: `sha256:${"f".repeat(64)}`,
    });
    const row = db.query("SELECT repository_id, result_commit_sha, candidate_run_id, lineage, checkpoint_hash, requester_user_id FROM publication_candidate_selections_v33 WHERE checkpoint_id=?").get(CK_ID) as Record<string, string>;
    // Every field is the DERIVED value from verified_candidate_checkpoints, never the body's.
    expect(row.repository_id).toBe(REPO_ID);
    expect(row.result_commit_sha).toBe(RESULT_COMMIT);
    expect(row.candidate_run_id).toBe(RUN_ID);
    expect(row.lineage).toBe("ORIGINAL");
    expect(row.checkpoint_hash).toBe(CK_HASH);
    expect(row.requester_user_id).toBe(principal.ownerId);
  });

  test("a body referencing ANOTHER owner's checkpoint gets the not-found shape (no ownership oracle)", async () => {
    const db = scratchDb();
    // A checkpoint owned by a DIFFERENT user.
    db.query("INSERT INTO users(id, created_at, updated_at) VALUES (?,?,?)").run("other-owner", AT, AT);
    const FOREIGN_CK = `sha256:${"c".repeat(64)}`;
    seedRun(db, "run-foreign", "other-owner");
    // repository_id must reference a real connection; reuse REPO_ID (FK off during seed anyway).
    seedCheckpoint(db, { id: FOREIGN_CK, hash: `sha256:${"d".repeat(64)}`, runId: "run-foreign", owner: "other-owner", repositoryId: REPO_ID, resultCommit: "3".repeat(40), nonce: "foreign" });
    const { facade } = makeFacade(db);
    // The facade derives authority synchronously, so an unresolvable reference throws
    // before any async work — assert the throw directly.
    expect(() => facade.selectCandidate(principal, RUN_ID, { checkpointId: FOREIGN_CK })).toThrow(CandidateNotFoundError);
    // A wholly unknown checkpoint returns the IDENTICAL shape — indistinguishable.
    expect(() => facade.selectCandidate(principal, RUN_ID, { checkpointId: `sha256:${"e".repeat(64)}` })).toThrow(CandidateNotFoundError);
    const count = (db.query("SELECT COUNT(*) AS n FROM publication_candidate_selections_v33").get() as { n: number }).n;
    expect(count).toBe(0);
  });

  test("a client CANNOT select a candidate for a checkpoint that is not a PROMOTED verified_candidate_checkpoints row", async () => {
    const db = scratchDb();
    const { facade } = makeFacade(db);
    // Well-formed but never-promoted checkpoint id.
    expect(() => facade.selectCandidate(principal, RUN_ID, { checkpointId: `sha256:${"9".repeat(64)}` })).toThrow(CandidateNotFoundError);
    const count = (db.query("SELECT COUNT(*) AS n FROM publication_candidate_selections_v33").get() as { n: number }).n;
    expect(count).toBe(0);
  });

  test("a P7_REPLACEMENT candidate's lineage is DERIVED (not client-claimed): a client cannot pass off a resolution-replacement checkpoint as ORIGINAL", async () => {
    const db = scratchDb();
    const REPL_RUN = "run-replacement";
    const CHILD_CK = `sha256:${"7".repeat(64)}`;
    const CHILD_HASH = `sha256:${"8".repeat(64)}`;
    seedRun(db, REPL_RUN, principal.ownerId);
    seedCheckpoint(db, { id: CHILD_CK, hash: CHILD_HASH, runId: REPL_RUN, owner: principal.ownerId, repositoryId: REPO_ID, resultCommit: "2".repeat(40), nonce: "child" });
    seedResolutionReplacement(db, REPL_RUN, "PREPARING");
    // Wire the REAL ResolutionLineageVerifier — the same one production binds.
    const verifier = new ResolutionLineageVerifier(db, "test-signing-secret");
    const { facade } = makeFacade(db, {}, verifier);
    // Client LIES: claims ORIGINAL for a resolution-replacement-run checkpoint. The
    // server derives P7_REPLACEMENT and fails closed synchronously (no lineage
    // attestation), so the throw is synchronous.
    expect(() => facade.selectCandidate(principal, RUN_ID, {
      checkpointId: CHILD_CK, lineage: "ORIGINAL", candidateRunId: REPL_RUN, repositoryId: REPO_ID,
      checkpointHash: CHILD_HASH, resultCommitSha: "2".repeat(40), parentSelectionId: null,
    })).toThrow();
    // The server derived P7_REPLACEMENT and FAILED CLOSED — it never stored the
    // replacement checkpoint as an eligible ORIGINAL candidate.
    const originals = (db.query("SELECT COUNT(*) AS n FROM publication_candidate_selections_v33 WHERE checkpoint_id=? AND lineage='ORIGINAL'").get(CHILD_CK) as { n: number }).n;
    expect(originals).toBe(0);
  });

  test("a P7_REPLACEMENT candidate is stored with server-derived lineage and remains GATED by the real ResolutionLineageVerifier (ineligible on a broken chain)", async () => {
    const db = scratchDb();
    const REPL_RUN = "run-replacement";
    const CHILD_CK = `sha256:${"7".repeat(64)}`;
    const CHILD_HASH = `sha256:${"8".repeat(64)}`;
    const CHILD_RESULT = "2".repeat(40);
    seedRun(db, REPL_RUN, principal.ownerId);
    seedCheckpoint(db, { id: CHILD_CK, hash: CHILD_HASH, runId: REPL_RUN, owner: principal.ownerId, repositoryId: REPO_ID, resultCommit: CHILD_RESULT, nonce: "child" });
    seedResolutionReplacement(db, REPL_RUN, "PREPARING"); // not READY => real verifier returns false
    // Durable hardening candidate-lineage attestation binds the child checkpoint to
    // its publication ROOT run (RUN_ID) — the honest source the facade derives from.
    seedChildLineageAttestation(db, { childCheckpointId: CHILD_CK, childRunId: REPL_RUN, rootRunId: RUN_ID });
    const verifier = new ResolutionLineageVerifier(db, "test-signing-secret");
    const { facade } = makeFacade(db, {}, verifier);
    // The ORIGINAL parent under the root run must be selected first.
    await facade.selectCandidate(principal, RUN_ID, { checkpointId: CK_ID });
    // Client claims ORIGINAL; server derives P7_REPLACEMENT and routes through the verifier.
    const candidate = await facade.selectCandidate(principal, RUN_ID, { checkpointId: CHILD_CK, lineage: "ORIGINAL" }) as { lineage: string; lineageVerified: boolean };
    expect(candidate.lineage).toBe("P7_REPLACEMENT");   // server-derived, NOT the client's ORIGINAL
    expect(candidate.lineageVerified).toBe(false);       // the real verifier gated the broken chain
    const row = db.query("SELECT lineage, lineage_verified FROM publication_candidate_selections_v33 WHERE checkpoint_id=?").get(CHILD_CK) as { lineage: string; lineage_verified: number };
    expect(row.lineage).toBe("P7_REPLACEMENT");
    expect(row.lineage_verified).toBe(0);
    // Gated => never listed as an eligible candidate.
    const listed = await facade.listCandidates(principal, RUN_ID) as Array<{ checkpointId: string }>;
    expect(listed.some((c) => c.checkpointId === CHILD_CK)).toBe(false);
  });

  test("approve derives the checkpointHash from the owner's selection — a body-claimed foreign checkpointHash cannot name a different candidate", async () => {
    const db = scratchDb();
    const { facade } = makeFacade(db);
    await facade.selectCandidate(principal, RUN_ID, selectBody);
    // Body claims a WRONG checkpointHash; the server overrides it with the derived one.
    const result = facade.approve(principal, CK_ID, { checkpointHash: `sha256:${"f".repeat(64)}`, decision: "APPROVE", policyVersion: POLICY }) as { approvalId: string; status: string };
    expect(result.status).toBe("APPROVED");
    const row = db.query("SELECT checkpoint_hash FROM publication_approvals_v33 WHERE approval_id=?").get(result.approvalId) as { checkpoint_hash: string };
    expect(row.checkpoint_hash).toBe(CK_HASH); // derived, not the body's forgery
  });

  test("approve on an unknown/cross-owner checkpoint gets the not-found shape", async () => {
    const db = scratchDb();
    const { facade } = makeFacade(db);
    // No selection exists for this checkpoint owned by the principal.
    expect(() => facade.approve(principal, `sha256:${"9".repeat(64)}`, { checkpointHash: CK_HASH, decision: "APPROVE", policyVersion: POLICY }))
      .toThrow(CandidateNotFoundError);
  });

  test("startPublication derives the runId from the owner's approval; a cross-owner/unknown approvalId gets the not-found shape", async () => {
    const db = scratchDb();
    const { facade } = makeFacade(db);
    await facade.selectCandidate(principal, RUN_ID, selectBody);
    const approval = facade.approve(principal, CK_ID, { checkpointHash: CK_HASH, decision: "APPROVE", policyVersion: POLICY }) as { approvalId: string };
    // A bogus runId in the URL is IGNORED — runId is derived from the approval row.
    const pub = await facade.startPublication(principal, "URL-RUN-IGNORED", { approvalId: approval.approvalId }, "header-key") as { publicationId: string; state: string };
    expect(pub.state).toBe("PREFLIGHT");
    const opRun = db.query("SELECT run_id FROM publication_git_operations_v33 WHERE publication_id=?").get(pub.publicationId) as { run_id: string };
    expect(opRun.run_id).toBe(RUN_ID);
    // An unknown approval is not-found.
    await expect(facade.startPublication(principal, RUN_ID, { approvalId: "no-such-approval" }, "k2")).rejects.toBeInstanceOf(CandidateNotFoundError);
  });
});

describe("P8 publication facade — attestation last-mile fails closed", () => {
  test("with attestation required but no bound PENDING approval request, APPROVE fails closed (503) and writes NO approval", async () => {
    const db = scratchDb();
    const { facade } = makeFacade(db, { attestationRequired: true, latestApprovalRequest: () => null });
    await facade.selectCandidate(principal, RUN_ID, selectBody);
    expect(() => facade.approve(principal, CK_ID, { checkpointHash: CK_HASH, decision: "APPROVE", policyVersion: POLICY }))
      .toThrow(PublicationAttestationUnavailableError);
    const count = (db.query("SELECT COUNT(*) AS n FROM publication_approvals_v33").get() as { n: number }).n;
    expect(count).toBe(0); // fail closed BEFORE any P8 approval row is written
  });

  test("RED-without-fail-closed: the SAME inputs with attestation NOT required (deferred default) DO write an approval (proving the flag is what blocks it)", async () => {
    const db = scratchDb();
    const { facade } = makeFacade(db, { attestationRequired: false, latestApprovalRequest: () => null });
    await facade.selectCandidate(principal, RUN_ID, selectBody);
    const result = facade.approve(principal, CK_ID, { checkpointHash: CK_HASH, decision: "APPROVE", policyVersion: POLICY }) as { status: string };
    expect(result.status).toBe("APPROVED");
    const count = (db.query("SELECT COUNT(*) AS n FROM publication_approvals_v33").get() as { n: number }).n;
    expect(count).toBe(1);
  });
});

describe("P8 publication facade — attestation atomicity (Finding A compensation)", () => {
  // A PENDING ledger approval_request bound to this exact candidate, plus a sourced
  // result tree hash, make attestation FEASIBLE so service.approve() commits the P8
  // approval; then decideApprove THROWS to simulate a post-commit attestation
  // failure. The compensation must leave NO live/consumable approval.
  const boundRequest = {
    approvalRequestId: "areq-1", status: "PENDING", approvalRevision: 0,
    deadlineAt: "2026-07-20T12:00:00.000Z", evidenceBundleHash: `sha256:${"c".repeat(64)}`,
    verifiedCheckpointId: CK_ID, verifiedCheckpointHash: CK_HASH,
  };

  test("a decideApprove failure AFTER the P8 approve commit leaves NO live approval (invalidated) and surfaces 503", async () => {
    const db = scratchDb();
    const { facade } = makeFacade(db, {
      attestationRequired: true,
      latestApprovalRequest: () => boundRequest,
      resultTreeHashFor: () => `sha256:${"9".repeat(64)}`,
      decideApprove: () => { throw new Error("ledger attestation emission failed"); },
    });
    await facade.selectCandidate(principal, RUN_ID, selectBody);
    expect(() => facade.approve(principal, CK_ID, { checkpointHash: CK_HASH, decision: "APPROVE", policyVersion: POLICY }))
      .toThrow(PublicationAttestationUnavailableError);
    // The P8 approval row WAS written (approve committed before decideApprove),
    // but compensation must have appended an INVALIDATED revision so the live
    // (highest-revision) status is not APPROVED — no consumable approval survives.
    const live = db.query(`SELECT status FROM publication_approvals_v33
      ORDER BY revision DESC LIMIT 1`).get() as { status: string } | null;
    expect(live?.status).toBe("INVALIDATED");
    const liveApproved = db.query(`SELECT COUNT(*) AS n FROM publication_approvals_v33 a
      WHERE a.decision='APPROVE' AND a.status='APPROVED'
        AND NOT EXISTS(SELECT 1 FROM publication_approvals_v33 b
          WHERE b.approval_id=a.approval_id AND b.revision>a.revision)`).get() as { n: number };
    expect(liveApproved.n).toBe(0);
  });

  test("RED-without-compensation control: the SAME feasible attestation that SUCCEEDS leaves the approval live and APPROVED", async () => {
    const db = scratchDb();
    const decideCalls: unknown[] = [];
    const { facade } = makeFacade(db, {
      attestationRequired: true,
      latestApprovalRequest: () => boundRequest,
      resultTreeHashFor: () => `sha256:${"9".repeat(64)}`,
      decideApprove: (record) => { decideCalls.push(record); },
    });
    await facade.selectCandidate(principal, RUN_ID, selectBody);
    const result = facade.approve(principal, CK_ID, { checkpointHash: CK_HASH, decision: "APPROVE", policyVersion: POLICY }) as { status: string };
    expect(result.status).toBe("APPROVED");
    expect(decideCalls.length).toBe(1);
    const live = db.query(`SELECT status FROM publication_approvals_v33 ORDER BY revision DESC LIMIT 1`).get() as { status: string };
    expect(live.status).toBe("APPROVED");
  });
});

describe("P8 publication facade — idempotency key from the header dedups the publication", () => {
  test("two startPublication calls with the SAME header key return the SAME publication; a body key is ignored", async () => {
    const db = scratchDb();
    const { facade } = makeFacade(db);
    await facade.selectCandidate(principal, RUN_ID, selectBody);
    const approval = facade.approve(principal, CK_ID, { checkpointHash: CK_HASH, decision: "APPROVE", policyVersion: POLICY }) as { approvalId: string };
    // Body carries a DIFFERENT idempotencyKey — the header key must win and dedup.
    const first = await facade.startPublication(principal, RUN_ID, { approvalId: approval.approvalId, idempotencyKey: "body-ignored" }, "header-key-1") as { publicationId: string; state: string };
    const second = await facade.startPublication(principal, RUN_ID, { approvalId: approval.approvalId, idempotencyKey: "different-body" }, "header-key-1") as { publicationId: string };
    expect(first.state).toBe("PREFLIGHT");
    expect(second.publicationId).toBe(first.publicationId); // header-key dedup
    const count = (db.query("SELECT COUNT(DISTINCT publication_id) AS n FROM publication_git_operations_v33").get() as { n: number }).n;
    expect(count).toBe(1);
  });
});

/** Seed a durable resolution_replacements row (binding trigger dropped, FK off). */
function seedResolutionReplacement(db: Database, replacementRunId: string, state: string): void {
  db.exec("DROP TRIGGER IF EXISTS require_resolution_replacement_binding_v31");
  db.exec("PRAGMA foreign_keys=OFF");
  const id = hx(`repl-${replacementRunId}`);
  const json = JSON.stringify({
    replacementId: id, caseId: `case-${replacementRunId}`, directiveId: `dir-${replacementRunId}`,
    kind: "CORRECTED", replacementRunId,
    budget: { maxCostMicrousd: 0, maxTokens: 0, maxActiveSeconds: 1, pricingPolicyDigest: hx(`pricing-${replacementRunId}`) },
  });
  db.query(
    "INSERT INTO resolution_replacements(id,replacement_hash,schema_version,policy_version,case_id,directive_id," +
      "directive_hash,kind,replacement_run_id,state,budget_max_cost_microusd,budget_max_tokens," +
      "budget_max_active_seconds,budget_pricing_policy_digest,replacement_json,created_at,updated_at)" +
      " VALUES (?,?,1,'engineer-resolution-replacement-v1',?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    id, hx(`replhash-${replacementRunId}`), `case-${replacementRunId}`, `dir-${replacementRunId}`,
    hx(`dirhash-${replacementRunId}`), "CORRECTED", replacementRunId, state, 0, 0, 1,
    hx(`pricing-${replacementRunId}`), json, AT, AT);
  db.exec("PRAGMA foreign_keys=ON");
}

/** Seed a durable candidate_lineage_attestations row (binding trigger dropped, FK off). */
function seedChildLineageAttestation(db: Database, opts: { childCheckpointId: string; childRunId: string; rootRunId: string }): void {
  db.exec("DROP TRIGGER IF EXISTS require_candidate_lineage_binding_v23");
  db.exec("PRAGMA foreign_keys=OFF");
  const n = opts.childRunId;
  db.query(
    "INSERT INTO candidate_lineage_attestations(lineage_attestation_id,lineage_attestation_hash,schema_version,policy_version,relation," +
      "lineage_id,lineage_hash,root_run_id,parent_run_id,child_run_id,requester_user_id,repository_id," +
      "parent_checkpoint_id,parent_checkpoint_hash,parent_result_commit_sha,child_checkpoint_id,child_checkpoint_hash," +
      "child_result_commit_sha,parent_base_commit_sha,selection_hash,quote_hash,consent_hash,attestation_json," +
      "statement_json,statement_hash,signature_algorithm,signature_key_id,signature,created_at)" +
      " VALUES (?,?,1,'engineer-candidate-lineage-v1','OPTIONAL_HARDENING',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    hx(`la-${n}`), hx(`lah-${n}`), hx(`lineage-${n}`), hx(`lineageh-${n}`), opts.rootRunId, opts.rootRunId,
    opts.childRunId, principal.ownerId, REPO_ID, CK_ID, CK_HASH, RESULT_COMMIT, opts.childCheckpointId,
    `sha256:${"8".repeat(64)}`, "2".repeat(40), BASE_COMMIT, hx(`sel-${n}`), hx(`quote-${n}`), hx(`consent-${n}`),
    "{}", "{}", hx(`stmt-${n}`), "ed25519", "key-1", "sig", AT);
  db.exec("PRAGMA foreign_keys=ON");
}

// R3: the facade dispatch/resume/reconcile methods over the real service +
// durable rows. Each names the publication only by opaque publicationId; every
// authority (ownership, credential boundary) is server-derived.
async function seedStartedPublication(facade: ReturnType<typeof createEngineerPublicationAuthorityFacade>): Promise<string> {
  await facade.selectCandidate(principal, RUN_ID, selectBody);
  const approval = facade.approve(principal, CK_ID, { checkpointHash: CK_HASH, decision: "APPROVE", policyVersion: POLICY }) as { approvalId: string };
  const started = await facade.startPublication(principal, RUN_ID, { approvalId: approval.approvalId }, "idem-1") as { publicationId: string; state: string };
  return started.publicationId;
}

describe("P8 publication facade — R3 dispatch / restart / reconcile (owner-scoped)", () => {
  test("dispatch drives PREFLIGHT → RECEIPTED and records the durable receipt", async () => {
    const db = scratchDb();
    const { facade } = makeFacade(db);
    const publicationId = await seedStartedPublication(facade);
    expect((facade.getPublication(principal, publicationId) as { state: string }).state).toBe("PREFLIGHT");
    const dispatched = await facade.dispatch(principal, publicationId) as { state: string; receipt?: { prUrl: string } };
    expect(dispatched.state).toBe("RECEIPTED");
    expect(dispatched.receipt?.prUrl).toBe("https://x/pr/1");
    const receipts = db.query("SELECT COUNT(*) c FROM publication_remote_receipts_v33 WHERE publication_id=?").get(publicationId) as { c: number };
    expect(receipts.c).toBe(1);
  });

  test("dispatch is withheld at the [HUMAN] credential boundary (503) and leaves the publication in PREFLIGHT", async () => {
    const db = scratchDb();
    const { facade } = makeFacade(db, { credentialAvailable: false });
    const publicationId = await seedStartedPublication(facade);
    await expect(facade.dispatch(principal, publicationId)).rejects.toMatchObject({ httpStatus: 503, code: "PUBLICATION_CREDENTIAL_UNAVAILABLE" });
    // The publication is untouched — still PREFLIGHT, re-driveable once GitHub is connected.
    expect((facade.getPublication(principal, publicationId) as { state: string }).state).toBe("PREFLIGHT");
  });

  test("an AMBIGUOUS remote outcome parks RECONCILING (requires_human) with no auto-redispatch; an explicit reconcile resolves it", async () => {
    const db = scratchDb();
    const ambiguousService = (() => {
      const actuator: PublicationActuator = { async createBranchPr(): Promise<ActuatorOutcome> { return { kind: "AMBIGUOUS", observedRemoteState: "PR_MAYBE", detail: "receipt lost" }; } };
      return new PublicationAuthorityService(db, {
        actuator,
        preflight: { probe: (input) => ({ repositoryId: input.repositoryId, baseCommitSha: input.baseCommitSha }) },
        credentialProvider: { getPublicationCredentials: () => ({ token: "ghp_x" }) },
        now: () => new Date(AT), idFactory: () => `amb-${(counter += 1)}`,
      });
    })();
    const { facade } = makeFacade(db, { service: ambiguousService });
    const publicationId = await seedStartedPublication(facade);
    const parked = await facade.dispatch(principal, publicationId) as { state: string; reconciliation?: { reason: string } };
    expect(parked.state).toBe("RECONCILING");
    expect(parked.reconciliation?.reason).toBe("AMBIGUOUS_REMOTE_OUTCOME");
    const recon = db.query("SELECT requires_human FROM publication_reconciliations_v33 WHERE publication_id=?").get(publicationId) as { requires_human: number };
    expect(recon.requires_human).toBe(1);
    // Explicit operator resolution is the ONLY legal successor.
    const resolved = facade.resolveReconciliation(principal, publicationId, { resolution: "FAILED", detail: "operator confirmed no PR landed" }) as { state: string };
    expect(resolved.state).toBe("FAILED");
  });

  test("reconcile rejects a resolution that is not RECEIPTED|FAILED (400)", async () => {
    const db = scratchDb();
    const { facade } = makeFacade(db);
    const publicationId = await seedStartedPublication(facade);
    expect(() => facade.resolveReconciliation(principal, publicationId, { resolution: "MAYBE" })).toThrow(/RECEIPTED.*FAILED/);
  });

  test("an unknown / cross-owner publication collapses to the single 404 not-found (no ownership oracle) for dispatch, resume, and reconcile", async () => {
    const db = scratchDb();
    const { facade } = makeFacade(db);
    await expect(facade.dispatch(principal, "not-a-real-publication")).rejects.toBeInstanceOf(CandidateNotFoundError);
    expect(() => facade.resume(principal, "not-a-real-publication")).toThrow(CandidateNotFoundError);
    expect(() => facade.resolveReconciliation(principal, "not-a-real-publication", { resolution: "FAILED" })).toThrow(CandidateNotFoundError);
  });
});
