import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  ENGINEER_DATABASE_SCHEMA_SQL,
  migrateEngineerDatabase,
  PublicationAuthorityService,
  PUBLICATION_AUTHORITY_POLICY_VERSION,
  type ActuatorOutcome,
  type PublicationActuator,
  type PublicationAuthorityDeps,
} from "@zintus/engineer";
import { deriveEngineerPrincipal } from "./engineer-identity.js";
import {
  createEngineerPublicationAuthorityFacade,
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

// v33 slice via the live migration chain (exactly as production installs it). The
// run's user_id is the SERVER principal's ownerId so the selection's run-owner
// binding trigger accepts a server-derived requester.
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
  return db;
}

let counter = 0;
function makeService(db: Database): PublicationAuthorityService {
  const actuator: PublicationActuator = {
    async createBranchPr(): Promise<ActuatorOutcome> { return { kind: "RECEIPT", prUrl: "https://x/pr/1", commitSha: RESULT_COMMIT }; },
  };
  const deps: PublicationAuthorityDeps = {
    actuator,
    preflight: { probe: (input) => ({ repositoryId: input.repositoryId, baseCommitSha: input.baseCommitSha }) },
    credentialProvider: { getPublicationCredentials: () => ({ token: "ghp_x" }) },
    now: () => new Date(AT),
    idFactory: () => `id-${(counter += 1)}`,
  };
  return new PublicationAuthorityService(db, deps);
}

function makeFacade(db: Database, overrides: Partial<PublicationFacadeDeps> = {}) {
  const decideCalls: Array<{ record: unknown; provenanceContext: unknown }> = [];
  const deps: PublicationFacadeDeps = {
    service: makeService(db),
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

const selectBody = {
  candidateRunId: RUN_ID, repositoryId: REPO_ID, checkpointId: CK_ID, checkpointHash: CK_HASH,
  resultCommitSha: RESULT_COMMIT, lineage: "ORIGINAL", parentSelectionId: null,
};

describe("P8 publication facade — server-derived authority", () => {
  test("selectCandidate FORCES the requester to the server principal owner, ignoring a body-supplied requesterUserId", async () => {
    const db = scratchDb();
    const { facade } = makeFacade(db);
    await facade.selectCandidate(principal, RUN_ID, { ...selectBody, requesterUserId: "ATTACKER-CONTROLLED" });
    const row = db.query("SELECT requester_user_id, run_id FROM publication_candidate_selections_v33 WHERE checkpoint_id=?").get(CK_ID) as { requester_user_id: string; run_id: string };
    expect(row.requester_user_id).toBe(principal.ownerId);
    expect(row.requester_user_id).not.toBe("ATTACKER-CONTROLLED");
    expect(row.run_id).toBe(RUN_ID);
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
