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
  PublicationApproverNotProvisionedError,
  PublicationAttestationUnavailableError,
  PublicationReconciliationReceiptError,
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
// B4: the P8 approver is derived from a SEPARATELY provisioned credential, distinct
// from the requester's own secret. A single-install principal (no approver secret) has
// no usable approver and cannot self-approve.
const principal = deriveEngineerPrincipal({
  gatewayIdentitySecret: "publication-facade-owner",
  approverIdentitySecret: "publication-facade-independent-approver",
});

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
function makeService(
  db: Database,
  lineageVerifier?: CompanionLineageVerifier,
  preflight?: PublicationAuthorityDeps["preflight"],
): PublicationAuthorityService {
  const actuator: PublicationActuator = {
    async createBranchPr(): Promise<ActuatorOutcome> { return { kind: "RECEIPT", prUrl: "https://x/pr/1", commitSha: RESULT_COMMIT }; },
  };
  const deps: PublicationAuthorityDeps = {
    actuator,
    preflight: preflight ?? { probe: (input) => ({ repositoryId: input.repositoryId, baseCommitSha: input.baseCommitSha }) },
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
    expect(principal.approverId).toBeTruthy();
    expect(row.approver_actor_id).toBe(principal.approverId as string);  // independent approver, distinct
    expect(row.approver_actor_id).not.toBe(principal.ownerId);
    expect(row.status).toBe("APPROVED");
  });
});

describe("B4 — the P8 approver is an independently provisioned second party", () => {
  test("deriveEngineerPrincipal with ONLY the requester secret yields NO usable approver (approverId=null)", () => {
    const single = deriveEngineerPrincipal({ gatewayIdentitySecret: "single-install-secret" });
    expect(single.approverId ?? null).toBeNull();
  });

  test("configuring the approver from the requester's OWN secret is rejected", () => {
    expect(() => deriveEngineerPrincipal({
      gatewayIdentitySecret: "same-secret",
      approverIdentitySecret: "same-secret",
    })).toThrow(/independent of the requester/);
  });

  test("a distinct approver secret yields an approver distinct from the owner", () => {
    const two = deriveEngineerPrincipal({
      gatewayIdentitySecret: "requester-secret",
      approverIdentitySecret: "independent-approver-secret",
    });
    expect(two.approverId).toBeTruthy();
    expect(two.approverId).not.toBe(two.ownerId);
  });

  test("RED-without-fix: a single-install principal (no approver) CANNOT self-approve — approve fails closed, NOTHING persisted", async () => {
    const db = scratchDb();
    // A single-install principal derives the SAME ownerId as `principal` (same
    // gateway secret) so it owns the seeded run/selection, but has NO approver.
    const singleInstall = deriveEngineerPrincipal({ gatewayIdentitySecret: "publication-facade-owner" });
    expect(singleInstall.ownerId).toBe(principal.ownerId);
    expect(singleInstall.approverId ?? null).toBeNull();
    const { facade } = makeFacade(db, { principal: singleInstall });
    await facade.selectCandidate(singleInstall, RUN_ID, selectBody);
    expect(() => facade.approve(singleInstall, CK_ID, { checkpointHash: CK_HASH, decision: "APPROVE", policyVersion: POLICY }))
      .toThrow(PublicationApproverNotProvisionedError);
    const count = (db.query("SELECT COUNT(*) AS n FROM publication_approvals_v33").get() as { n: number }).n;
    expect(count).toBe(0);
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

describe("P8 publication facade — approval+attestation are GENUINELY ATOMIC (R5C)", () => {
  // A PENDING ledger approval_request bound to this exact candidate, plus a sourced
  // result tree hash, make attestation FEASIBLE so the P8 approval INSERT runs;
  // decideApprove then THROWS to model a CRASH between the approval write and the
  // attestation commit. Because both writes share ONE transaction on the shared
  // connection, the rollback leaves NOTHING durable — no consumable approval AND
  // no invalidated tombstone. (Under the OLD two-transaction compensation form the
  // approval row would already be committed and only invalidated after the fact,
  // so these count===0 assertions go RED without the single-transaction fix.)
  const boundRequest = {
    approvalRequestId: "areq-1", status: "PENDING", approvalRevision: 0,
    deadlineAt: "2026-07-20T12:00:00.000Z", evidenceBundleHash: `sha256:${"c".repeat(64)}`,
    verifiedCheckpointId: CK_ID, verifiedCheckpointHash: CK_HASH,
  };

  test("CRASH injected between the approval write and the attestation write leaves NO approval row at all (atomic rollback) and surfaces 503", async () => {
    const db = scratchDb();
    const { facade } = makeFacade(db, {
      attestationRequired: true,
      latestApprovalRequest: () => boundRequest,
      resultTreeHashFor: () => `sha256:${"9".repeat(64)}`,
      // Models a process crash / ledger failure AFTER the P8 approval INSERT but
      // BEFORE the attestation commits.
      decideApprove: () => { throw new Error("ledger attestation emission crashed"); },
    });
    await facade.selectCandidate(principal, RUN_ID, selectBody);
    expect(() => facade.approve(principal, CK_ID, { checkpointHash: CK_HASH, decision: "APPROVE", policyVersion: POLICY }))
      .toThrow(PublicationAttestationUnavailableError);
    // The ENTIRE transaction rolled back: ZERO approval rows of ANY revision/status.
    // This is strictly stronger than "invalidated after the fact" — the approval
    // INSERT itself was undone. RED under the two-transaction compensation form.
    const total = (db.query("SELECT COUNT(*) AS n FROM publication_approvals_v33").get() as { n: number }).n;
    expect(total).toBe(0);
    // No consumable approval survives => no publication is possible.
    const consumable = (db.query(`SELECT COUNT(*) AS n FROM publication_approvals_v33 a
      WHERE a.revision=0 AND a.decision='APPROVE' AND a.status='APPROVED'
        AND NOT EXISTS(SELECT 1 FROM publication_approvals_v33 b
          WHERE b.approval_id=a.approval_id AND b.status IN ('INVALIDATED','CONSUMED'))`).get() as { n: number }).n;
    expect(consumable).toBe(0);
  });

  test("no attestation write was committed either: a crash rolls back BOTH sides (nothing persists without the other)", async () => {
    const db = scratchDb();
    let decideAttempts = 0;
    const { facade } = makeFacade(db, {
      attestationRequired: true,
      latestApprovalRequest: () => boundRequest,
      resultTreeHashFor: () => `sha256:${"9".repeat(64)}`,
      // Write a REAL sentinel row inside the attestation phase, then crash: the
      // rollback must undo the sentinel too (proving the attestation shares the
      // approval's transaction, not a separate committed one).
      decideApprove: () => {
        decideAttempts += 1;
        db.query("INSERT INTO users(id, created_at, updated_at) VALUES ('attestation-sentinel', ?, ?)").run(AT, AT);
        throw new Error("crash after the attestation-phase write");
      },
    });
    await facade.selectCandidate(principal, RUN_ID, selectBody);
    expect(() => facade.approve(principal, CK_ID, { checkpointHash: CK_HASH, decision: "APPROVE", policyVersion: POLICY }))
      .toThrow(PublicationAttestationUnavailableError);
    expect(decideAttempts).toBe(1);
    // Both the approval AND the attestation-phase sentinel are gone.
    expect((db.query("SELECT COUNT(*) AS n FROM publication_approvals_v33").get() as { n: number }).n).toBe(0);
    expect((db.query("SELECT COUNT(*) AS n FROM users WHERE id='attestation-sentinel'").get() as { n: number }).n).toBe(0);
  });

  test("happy path: the P8 approval and its v35 attestation commit together — a consumable APPROVED approval WITH its attestation call", async () => {
    const db = scratchDb();
    const decideCalls: unknown[] = [];
    const { facade } = makeFacade(db, {
      attestationRequired: true,
      latestApprovalRequest: () => boundRequest,
      resultTreeHashFor: () => `sha256:${"9".repeat(64)}`,
      decideApprove: (record) => { decideCalls.push(record); },
    });
    await facade.selectCandidate(principal, RUN_ID, selectBody);
    const result = facade.approve(principal, CK_ID, { checkpointHash: CK_HASH, decision: "APPROVE", policyVersion: POLICY }) as { approvalId: string; status: string };
    expect(result.status).toBe("APPROVED");
    // The attestation was emitted exactly once, bound to this approval's candidate.
    expect(decideCalls.length).toBe(1);
    // The approval is durably consumable (revision-0 APPROVED, no terminal revision).
    const live = db.query(`SELECT status FROM publication_approvals_v33 WHERE approval_id=? ORDER BY revision DESC LIMIT 1`).get(result.approvalId) as { status: string };
    expect(live.status).toBe("APPROVED");
    // And it can actually drive a publication (proves consumability end-to-end).
    const pub = await facade.startPublication(principal, RUN_ID, { approvalId: result.approvalId }, "hk-atomic") as { state: string };
    expect(pub.state).toBe("PREFLIGHT");
  });

  test("an approval-phase failure (self-approval / stale) surfaces with its OWN status, NOT the attestation 503", async () => {
    const db = scratchDb();
    // No selection recorded => approveWithinTx throws CandidateNotFound BEFORE the
    // attestation phase; the facade must NOT mis-wrap it as a 503.
    const { facade } = makeFacade(db, {
      attestationRequired: true,
      latestApprovalRequest: () => boundRequest,
      resultTreeHashFor: () => `sha256:${"9".repeat(64)}`,
      decideApprove: () => { throw new Error("attestation should never be reached"); },
    });
    // selectCandidate deliberately NOT called for CK_ID's owned selection... actually
    // approve derives the selection first; without it the facade throws CandidateNotFound
    // before any transaction. Use a checkpoint with no selection.
    expect(() => facade.approve(principal, `sha256:${"7".repeat(64)}`, { checkpointHash: CK_HASH, decision: "APPROVE", policyVersion: POLICY }))
      .toThrow(CandidateNotFoundError);
    expect((db.query("SELECT COUNT(*) AS n FROM publication_approvals_v33").get() as { n: number }).n).toBe(0);
  });
});

describe("P8 publication facade — stale-base at preflight supersedes the approval (R5C item 2)", () => {
  test("when the base has moved, startPublication invalidates the hash-bound approval (non-consumable) and blocks the publish; a retry stays blocked", async () => {
    const db = scratchDb();
    // A preflight that reports a DIFFERENT base than the approval's => stale base.
    const movedBase = "e".repeat(40);
    const stalePreflight = { probe: (input: { repositoryId: string }) => ({ repositoryId: input.repositoryId, baseCommitSha: movedBase }) };
    const { facade } = makeFacade(db, { service: makeService(db, undefined, stalePreflight) });
    await facade.selectCandidate(principal, RUN_ID, selectBody);
    const approval = facade.approve(principal, CK_ID, { checkpointHash: CK_HASH, decision: "APPROVE", policyVersion: POLICY }) as { approvalId: string };
    // First publish attempt: preflight detects the moved base and fails closed.
    await expect(facade.startPublication(principal, RUN_ID, { approvalId: approval.approvalId }, "hk-stale-1"))
      .rejects.toThrow();
    // The old hash-bound approval is SUPERSEDED: an INVALIDATED revision is durable,
    // so no dangling consumable approval survives against the stale base.
    const live = db.query(`SELECT status FROM publication_approvals_v33 WHERE approval_id=? ORDER BY revision DESC LIMIT 1`).get(approval.approvalId) as { status: string };
    expect(live.status).toBe("INVALIDATED");
    const consumable = (db.query(`SELECT COUNT(*) AS n FROM publication_approvals_v33 a
      WHERE a.approval_id=? AND a.revision=0 AND a.decision='APPROVE' AND a.status='APPROVED'
        AND NOT EXISTS(SELECT 1 FROM publication_approvals_v33 b
          WHERE b.approval_id=a.approval_id AND b.status IN ('INVALIDATED','CONSUMED'))`).get(approval.approvalId) as { n: number }).n;
    expect(consumable).toBe(0);
    // No publication row was created.
    expect((db.query("SELECT COUNT(*) AS n FROM publication_git_operations_v33").get() as { n: number }).n).toBe(0);
    // A retry with the SAME (now superseded) approval stays blocked — never publishes.
    await expect(facade.startPublication(principal, RUN_ID, { approvalId: approval.approvalId }, "hk-stale-2"))
      .rejects.toThrow();
    expect((db.query("SELECT COUNT(*) AS n FROM publication_git_operations_v33").get() as { n: number }).n).toBe(0);
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
    const resolved = await facade.resolveReconciliation(principal, publicationId, { resolution: "FAILED", detail: "operator confirmed no PR landed" }) as { state: string };
    expect(resolved.state).toBe("FAILED");
  });

  test("reconcile rejects a resolution that is not RECEIPTED|FAILED (400)", async () => {
    const db = scratchDb();
    const { facade } = makeFacade(db);
    const publicationId = await seedStartedPublication(facade);
    await expect(facade.resolveReconciliation(principal, publicationId, { resolution: "MAYBE" })).rejects.toThrow(/RECEIPTED.*FAILED/);
  });

  // F5 (P1): a RECEIPTED reconciliation MUST carry a real receipt so a RECEIPTED
  // publication can never exist without its durable receipt (prUrl + commit_sha).
  test("F5: RECEIPTED reconciliation without a real receipt is rejected (400); with one it persists and getPublication returns it", async () => {
    const db = scratchDb();
    const CONFIRMED_PR = "https://github.test/pull/42";
    const ambiguousService = new PublicationAuthorityService(db, {
      actuator: { async createBranchPr(): Promise<ActuatorOutcome> { return { kind: "AMBIGUOUS", observedRemoteState: "PR_MAYBE", detail: "receipt lost" }; } },
      preflight: { probe: (input) => ({ repositoryId: input.repositoryId, baseCommitSha: input.baseCommitSha }) },
      credentialProvider: { getPublicationCredentials: () => ({ token: "ghp_x" }) },
      // A manual RECEIPTED now REQUIRES provider confirmation of the exact open-draft
      // PR — wire the read-only discovery that positively confirms it (as production
      // does via gitPublicationMechanics.createReceiptDiscovery).
      receiptDiscovery: { discoverExistingReceipt: async (input) => ({ kind: "RECEIPT", prUrl: CONFIRMED_PR, commitSha: input.resultCommitSha }) },
      now: () => new Date(AT), idFactory: () => `f5-${(counter += 1)}`,
    });
    const { facade } = makeFacade(db, { service: ambiguousService });
    const publicationId = await seedStartedPublication(facade);
    expect((await facade.dispatch(principal, publicationId) as { state: string }).state).toBe("RECONCILING");

    // No receipt in the body => rejected; the publication is NOT advanced to RECEIPTED.
    await expect(facade.resolveReconciliation(principal, publicationId, { resolution: "RECEIPTED", detail: "operator says it landed" }))
      .rejects.toThrow(PublicationReconciliationReceiptError);
    // A non-hex commitSha is likewise rejected.
    await expect(facade.resolveReconciliation(principal, publicationId, { resolution: "RECEIPTED", prUrl: "https://x/pr/1", commitSha: "not-a-sha" }))
      .rejects.toThrow(PublicationReconciliationReceiptError);
    expect((facade.getPublication(principal, publicationId) as { state: string }).state).toBe("RECONCILING");
    expect((db.query("SELECT COUNT(*) c FROM publication_remote_receipts_v33 WHERE publication_id=?").get(publicationId) as { c: number }).c).toBe(0);

    // A provider-confirmed receipt persists atomically with the RECEIPTED transition.
    // F-L1 / GAP #1: commitSha MUST bind to the run's verified result commit
    // (RESULT_COMMIT) AND the exact open-draft PR must be provider-confirmed — the
    // persisted reference is the authoritative discovered html_url.
    const resolved = await facade.resolveReconciliation(principal, publicationId, {
      resolution: "RECEIPTED", detail: "operator confirmed PR", prUrl: CONFIRMED_PR, commitSha: RESULT_COMMIT,
    }) as { state: string; receipt?: { prUrl: string; commitSha: string } };
    expect(resolved.state).toBe("RECEIPTED");
    expect(resolved.receipt?.prUrl).toBe(CONFIRMED_PR);
    expect((db.query("SELECT COUNT(*) c FROM publication_remote_receipts_v33 WHERE publication_id=?").get(publicationId) as { c: number }).c).toBe(1);
  });

  // F-L1 (Luna): the EXACT provenance-integrity attack driven through the facade —
  // reconcile to RECEIPTED with a prUrl in a DIFFERENT repo + a foreign commitSha.
  // Shape validation passes (real URL, 40-hex sha), so on the shape-only code it
  // persisted verbatim; the server binding now REJECTS it (409) with no receipt row.
  test("F-L1: a manual RECEIPTED with a FOREIGN prUrl + foreign commitSha is REJECTED (409), not persisted", async () => {
    const db = scratchDb();
    const ambiguousService = new PublicationAuthorityService(db, {
      actuator: { async createBranchPr(): Promise<ActuatorOutcome> { return { kind: "AMBIGUOUS", observedRemoteState: "PR_MAYBE", detail: "receipt lost" }; } },
      preflight: { probe: (input) => ({ repositoryId: input.repositoryId, baseCommitSha: input.baseCommitSha }) },
      credentialProvider: { getPublicationCredentials: () => ({ token: "ghp_x" }) },
      now: () => new Date(AT), idFactory: () => `fl1-${(counter += 1)}`,
    });
    const { facade } = makeFacade(db, { service: ambiguousService });
    const publicationId = await seedStartedPublication(facade);
    expect((await facade.dispatch(principal, publicationId) as { state: string }).state).toBe("RECONCILING");
    // The Luna receipt: a well-shaped but UNBOUND receipt pointing at a foreign PR/commit.
    await expect(facade.resolveReconciliation(principal, publicationId, {
      resolution: "RECEIPTED", detail: "operator claims it landed",
      prUrl: "https://github.com/attacker/other-repo/pull/999", commitSha: "9".repeat(40),
    })).rejects.toMatchObject({ httpStatus: 409, code: "PUBLICATION_RECEIPT_BINDING" });
    // Still RECONCILING; NO receipt row was written.
    expect((facade.getPublication(principal, publicationId) as { state: string }).state).toBe("RECONCILING");
    expect((db.query("SELECT COUNT(*) c FROM publication_remote_receipts_v33 WHERE publication_id=?").get(publicationId) as { c: number }).c).toBe(0);
  });

  test("an unknown / cross-owner publication collapses to the single 404 not-found (no ownership oracle) for dispatch, resume, and reconcile", async () => {
    const db = scratchDb();
    const { facade } = makeFacade(db);
    await expect(facade.dispatch(principal, "not-a-real-publication")).rejects.toBeInstanceOf(CandidateNotFoundError);
    expect(() => facade.resume(principal, "not-a-real-publication")).toThrow(CandidateNotFoundError);
    await expect(facade.resolveReconciliation(principal, "not-a-real-publication", { resolution: "FAILED" })).rejects.toThrow(CandidateNotFoundError);
    // R7-3: recheckReconciliation is likewise owner-fenced with the same 404.
    await expect(facade.recheckReconciliation(principal, "not-a-real-publication")).rejects.toBeInstanceOf(CandidateNotFoundError);
  });

  // R7-3 (FINDING #4): the REMOTE RECHECK the operator drives from the RECONCILING
  // screen — a read-only re-discovery that auto-confirms to RECEIPTED when (and only
  // when) the provider confirms the exact open-draft PR, else leaves it RECONCILING.
  test("recheckReconciliation auto-confirms RECONCILING → RECEIPTED when the provider now confirms the exact open-draft PR", async () => {
    const db = scratchDb();
    const CONFIRMED_PR = "https://github.test/pull/77";
    const ambiguousService = new PublicationAuthorityService(db, {
      actuator: { async createBranchPr(): Promise<ActuatorOutcome> { return { kind: "AMBIGUOUS", observedRemoteState: "PR_MAYBE", detail: "receipt lost" }; } },
      preflight: { probe: (input) => ({ repositoryId: input.repositoryId, baseCommitSha: input.baseCommitSha }) },
      credentialProvider: { getPublicationCredentials: () => ({ token: "ghp_x" }) },
      receiptDiscovery: { discoverExistingReceipt: async (input) => ({ kind: "RECEIPT", prUrl: CONFIRMED_PR, commitSha: input.resultCommitSha }) },
      now: () => new Date(AT), idFactory: () => `rck-${(counter += 1)}`,
    });
    const { facade } = makeFacade(db, { service: ambiguousService });
    const publicationId = await seedStartedPublication(facade);
    expect((await facade.dispatch(principal, publicationId) as { state: string }).state).toBe("RECONCILING");
    const rechecked = await facade.recheckReconciliation(principal, publicationId) as { state: string; receipt?: { prUrl: string } };
    expect(rechecked.state).toBe("RECEIPTED");
    expect(rechecked.receipt?.prUrl).toBe(CONFIRMED_PR);
    expect((db.query("SELECT COUNT(*) c FROM publication_remote_receipts_v33 WHERE publication_id=?").get(publicationId) as { c: number }).c).toBe(1);
  });

  test("recheckReconciliation with no provider confirmation leaves the publication RECONCILING (no throw, no receipt row)", async () => {
    const db = scratchDb();
    const ambiguousService = new PublicationAuthorityService(db, {
      actuator: { async createBranchPr(): Promise<ActuatorOutcome> { return { kind: "AMBIGUOUS", observedRemoteState: "PR_MAYBE", detail: "receipt lost" }; } },
      preflight: { probe: (input) => ({ repositoryId: input.repositoryId, baseCommitSha: input.baseCommitSha }) },
      credentialProvider: { getPublicationCredentials: () => ({ token: "ghp_x" }) },
      receiptDiscovery: { discoverExistingReceipt: async () => ({ kind: "AMBIGUOUS", observedRemoteState: "none", detail: "no PR yet" }) },
      now: () => new Date(AT), idFactory: () => `rck2-${(counter += 1)}`,
    });
    const { facade } = makeFacade(db, { service: ambiguousService });
    const publicationId = await seedStartedPublication(facade);
    expect((await facade.dispatch(principal, publicationId) as { state: string }).state).toBe("RECONCILING");
    const rechecked = await facade.recheckReconciliation(principal, publicationId) as { state: string };
    expect(rechecked.state).toBe("RECONCILING");
    expect((db.query("SELECT COUNT(*) c FROM publication_remote_receipts_v33 WHERE publication_id=?").get(publicationId) as { c: number }).c).toBe(0);
  });
});

// R7-2 (FINDING #3): the durable current-publication projection the Approval &
// publication screen hydrates from on refresh, so React state is never the
// authority for an in-flight publication. Owner-fenced, server-derived,
// read-only. Each assertion below fails against the pre-R7-2 facade (the method
// did not exist — the page could only reload candidates).
describe("R7-2 — durable current-publication projection (refresh hydration)", () => {
  interface CurrentShape {
    publication: null | {
      publicationId: string; runId: string; state: string; approvalId: string; approvalStatus: string | null;
      checkpointId: string; checkpointHash: string; lineage: string; lineageVerified: boolean;
      receipt?: { prUrl: string; commitSha: string };
    };
  }

  test("returns the run's CURRENT publication with state, approval id/status, checkpoint and lineage", async () => {
    const db = scratchDb();
    const { facade } = makeFacade(db);
    await facade.selectCandidate(principal, RUN_ID, selectBody);
    const approval = facade.approve(principal, CK_ID, { checkpointHash: CK_HASH, decision: "APPROVE", policyVersion: POLICY }) as { approvalId: string };
    const pub = await facade.startPublication(principal, RUN_ID, { approvalId: approval.approvalId }, "hk-r72") as { publicationId: string };

    const projection = facade.getCurrentPublication(principal, RUN_ID) as CurrentShape;
    expect(projection.publication).not.toBeNull();
    expect(projection.publication!.publicationId).toBe(pub.publicationId);
    expect(projection.publication!.runId).toBe(RUN_ID);
    expect(projection.publication!.state).toBe("PREFLIGHT");
    expect(projection.publication!.approvalId).toBe(approval.approvalId);
    // The projection faithfully reports the DURABLE approval status: creating the
    // publication consumed the single-use approval (APPROVED → CONSUMED). The web
    // page maps CONSUMED → APPROVED for its gate model, but the server-derived
    // projection never lies about the durable state.
    expect(projection.publication!.approvalStatus).toBe("CONSUMED");
    expect(projection.publication!.checkpointId).toBe(CK_ID);
    expect(projection.publication!.checkpointHash).toBe(CK_HASH);
    expect(projection.publication!.lineage).toBe("ORIGINAL");
    expect(projection.publication!.lineageVerified).toBe(true);
  });

  test("carries the durable receipt once the publication is RECEIPTED", async () => {
    const db = scratchDb();
    const { facade } = makeFacade(db);
    const publicationId = await seedStartedPublication(facade);
    expect((await facade.dispatch(principal, publicationId) as { state: string }).state).toBe("RECEIPTED");

    const projection = facade.getCurrentPublication(principal, RUN_ID) as CurrentShape;
    expect(projection.publication!.state).toBe("RECEIPTED");
    expect(projection.publication!.receipt).toEqual({ prUrl: "https://x/pr/1", commitSha: RESULT_COMMIT });
  });

  test("a run with NO publication returns the none-shape { publication: null }", () => {
    const db = scratchDb();
    const { facade } = makeFacade(db);
    expect(facade.getCurrentPublication(principal, RUN_ID)).toEqual({ publication: null });
  });

  test("an unknown run returns the same none-shape", () => {
    const db = scratchDb();
    const { facade } = makeFacade(db);
    expect(facade.getCurrentPublication(principal, "no-such-run")).toEqual({ publication: null });
  });

  test("a cross-owner principal gets the SAME none-shape (no ownership oracle), never the owner's publication", async () => {
    const db = scratchDb();
    const { facade } = makeFacade(db);
    await seedStartedPublication(facade);

    const stranger = deriveEngineerPrincipal({
      gatewayIdentitySecret: "r72-different-owner",
      approverIdentitySecret: "r72-different-approver",
    });
    expect(stranger.ownerId).not.toBe(principal.ownerId);
    const strangerFacade = makeFacade(db, { principal: stranger }).facade;
    expect(strangerFacade.getCurrentPublication(stranger, RUN_ID)).toEqual({ publication: null });
  });
});
