import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ENGINEER_DATABASE_SCHEMA_SQL } from "./database-schema.js";
import { migrateEngineerDatabase } from "./database-migrations.js";
import { ResolutionLineageVerifier } from "./resolution-lineage.js";
import {
  PublicationAuthorityService,
  ApprovalConsumedError,
  PreflightMismatchError,
  PublicationIdempotencyConflictError,
  SelfApprovalError,
  StaleCandidateError,
  PUBLICATION_AUTHORITY_POLICY_VERSION,
  type ActuatorOutcome,
  type ApproverAuthContext,
  type CompanionLineageVerifier,
  type PublicationActuator,
  type PublicationAuthorityDeps,
  type PublicationCredentials,
  type RepositoryPreflightProbe,
} from "./publication-authority.js";

const AT = "2026-07-19T12:00:00.000Z";
const CK_ID = `sha256:${"a".repeat(64)}`;
const CK_HASH = `sha256:${"b".repeat(64)}`;
const CK2_ID = `sha256:${"7".repeat(64)}`;
const CK2_HASH = `sha256:${"8".repeat(64)}`;
const CHILD_CK_ID = `sha256:${"d".repeat(64)}`;
const CHILD_CK_HASH = `sha256:${"e".repeat(64)}`;
const EVID = `sha256:${"c".repeat(64)}`;
const RESULT_COMMIT = "1".repeat(40);
const BASE_COMMIT = "0".repeat(40);
const RUN_ID = "run-1";
const CHILD_RUN_ID = "hardening-child-1";
const REPO_ID = "repo-1";
const USER_ID = "owner-1";
const APPROVER = "human-approver"; // distinct human, never the selection's requester
const SIGNING_SECRET = "publication-authority-real-verifier-secret";

// Server-authenticated approval context (gateway seam). Never client-writable.
const CTX: ApproverAuthContext = {
  approverActorId: APPROVER, implementationActorId: "engineer-agent",
  evidenceRoot: EVID, expiresAt: "2026-07-20T12:00:00.000Z",
};

// Uses the LIVE migration chain (no standalone applyDraftMigration33): v33 is
// installed by migrateEngineerDatabase, exactly as production installs it.
function scratchDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(ENGINEER_DATABASE_SCHEMA_SQL);
  db.query("INSERT INTO schema_migrations(version, applied_at) VALUES (14, ?)").run(AT);
  migrateEngineerDatabase(db, AT);
  db.query("INSERT INTO users(id, created_at, updated_at) VALUES (?,?,?)").run(USER_ID, AT, AT);
  db.query(`INSERT INTO repository_connections(id, user_id, provider, owner, name, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?)`).run(REPO_ID, USER_ID, "local", "acme", "svc", AT, AT);
  for (const id of [RUN_ID, CHILD_RUN_ID]) {
    db.query(`INSERT INTO engineer_runs(id, user_id, repository_id, base_branch, base_commit_sha,
      request_original, state, risk_tier, human_gate_required, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
        id, USER_ID, REPO_ID, "main", BASE_COMMIT, "do the thing", "REVIEW_APPROVED", "HIGH", 1, AT, AT);
  }
  return db;
}

let counter = 0;
function deterministicId(): string { counter += 1; return `id-${counter}`; }

interface Harness {
  db: Database;
  draft: PublicationAuthorityService;
  actuatorCalls: number;
  credentialCalls: number;
  seenCredentials: PublicationCredentials[];
  nextOutcome: ActuatorOutcome;
  actuatorThrows: boolean;
}

function harness(overrides: {
  outcome?: ActuatorOutcome;
  actuatorThrows?: boolean;
  preflight?: RepositoryPreflightProbe;
  lineageVerifier?: CompanionLineageVerifier;
} = {}): Harness {
  const db = scratchDb();
  const state: Harness = {
    db, draft: null as unknown as PublicationAuthorityService, actuatorCalls: 0, credentialCalls: 0, seenCredentials: [],
    nextOutcome: overrides.outcome ?? { kind: "RECEIPT", prUrl: "https://example/pr/1", commitSha: RESULT_COMMIT },
    actuatorThrows: overrides.actuatorThrows ?? false,
  };
  const actuator: PublicationActuator = {
    async createBranchPr(_input, credentials) {
      state.actuatorCalls += 1;
      state.seenCredentials.push(credentials);
      if (state.actuatorThrows) throw new Error("network partition");
      return state.nextOutcome;
    },
  };
  const preflight: RepositoryPreflightProbe = overrides.preflight ?? {
    probe: (input) => ({ repositoryId: input.repositoryId, baseCommitSha: input.baseCommitSha }),
  };
  const credentialProvider = {
    getPublicationCredentials: () => { state.credentialCalls += 1; return { token: "ghp_secret" }; },
  };
  const deps: PublicationAuthorityDeps = {
    actuator, preflight, credentialProvider,
    lineageVerifier: overrides.lineageVerifier,
    now: () => new Date(AT), idFactory: deterministicId,
  };
  state.draft = new PublicationAuthorityService(db, deps);
  return state;
}

async function selectOriginal(h: Harness, checkpointId = CK_ID, checkpointHash = CK_HASH) {
  await h.draft.selectCandidate({
    runId: RUN_ID, candidateRunId: RUN_ID, requesterUserId: USER_ID, repositoryId: REPO_ID,
    checkpointId, checkpointHash, resultCommitSha: RESULT_COMMIT, lineage: "ORIGINAL", parentSelectionId: null,
  });
}

async function seedApprovedOriginal(h: Harness, checkpointId = CK_ID, checkpointHash = CK_HASH) {
  await selectOriginal(h, checkpointId, checkpointHash);
  return h.draft.approve(checkpointId, { checkpointHash, decision: "APPROVE", policyVersion: PUBLICATION_AUTHORITY_POLICY_VERSION }, CTX);
}

describe("v33 approval — three-identity & self-approval", () => {
  test("self-approval rejected: approver IS the selection's real requester", async () => {
    const h = harness();
    await selectOriginal(h); // selection.requester_user_id === USER_ID
    expect(() => h.draft.approve(CK_ID,
      { checkpointHash: CK_HASH, decision: "APPROVE", policyVersion: PUBLICATION_AUTHORITY_POLICY_VERSION },
      { ...CTX, approverActorId: USER_ID })).toThrow(SelfApprovalError);
    const count = h.db.query("SELECT COUNT(*) c FROM publication_approvals_v33").get() as { c: number };
    expect(count.c).toBe(0);
  });

  test("self-approval rejected across a simulated role change (binds identity, not role)", async () => {
    const h = harness();
    await selectOriginal(h);
    expect(() => h.draft.approve(CK_ID,
      { checkpointHash: CK_HASH, decision: "APPROVE", policyVersion: PUBLICATION_AUTHORITY_POLICY_VERSION, approverRole: "APPROVER" },
      { ...CTX, approverActorId: USER_ID })).toThrow(SelfApprovalError);
    const count = h.db.query("SELECT COUNT(*) c FROM publication_approvals_v33").get() as { c: number };
    expect(count.c).toBe(0);
  });

  test("distinct requester/approver approve succeeds and binds three identities", async () => {
    const h = harness();
    const result = await seedApprovedOriginal(h);
    expect(result.status).toBe("APPROVED");
    const row = h.db.query(`SELECT requester_actor_id, approver_actor_id, implementation_actor_id,
      requester_actor_kind, approver_actor_kind, implementation_actor_kind FROM publication_approvals_v33 WHERE revision=0`).get() as Record<string, string>;
    expect(row.requester_actor_id).toBe(USER_ID);
    expect(row.approver_actor_id).toBe(APPROVER);
    expect(row.requester_actor_id).not.toBe(row.approver_actor_id);
    expect(row.implementation_actor_kind).toBe("NON_HUMAN");
    expect(row.approver_actor_kind).toBe("HUMAN");
  });
});

describe("v33 approval — stale candidate", () => {
  test("hash mismatch is rejected", async () => {
    const h = harness();
    await selectOriginal(h);
    expect(() => h.draft.approve(CK_ID,
      { checkpointHash: `sha256:${"f".repeat(64)}`, decision: "APPROVE", policyVersion: PUBLICATION_AUTHORITY_POLICY_VERSION },
      CTX)).toThrow(StaleCandidateError);
  });
});

describe("v33 candidate lineage — fail closed", () => {
  async function seedParentAndChild(h: Harness) {
    await selectOriginal(h);
    const parentRow = h.db.query("SELECT id FROM publication_candidate_selections_v33 WHERE checkpoint_id=?").get(CK_ID) as { id: string };
    return h.draft.selectCandidate({
      runId: RUN_ID, candidateRunId: CHILD_RUN_ID, requesterUserId: USER_ID, repositoryId: REPO_ID,
      checkpointId: CHILD_CK_ID, checkpointHash: CHILD_CK_HASH, resultCommitSha: "2".repeat(40),
      lineage: "P7_REPLACEMENT", parentSelectionId: parentRow.id,
    });
  }

  test("absent verifier => replacement candidate ineligible", async () => {
    const h = harness();
    const child = await seedParentAndChild(h);
    expect(child.lineageVerified).toBe(false);
    expect(h.draft.listPublicationCandidates(RUN_ID).map((c) => c.lineage).sort()).toEqual(["ORIGINAL"]);
  });

  test("throwing verifier => ineligible (fail closed)", async () => {
    const h = harness({ lineageVerifier: { verifyReplacementLineage() { throw new Error("verifier down"); } } });
    const child = await seedParentAndChild(h);
    expect(child.lineageVerified).toBe(false);
    expect(h.draft.listPublicationCandidates(RUN_ID).some((c) => c.lineage === "P7_REPLACEMENT")).toBe(false);
  });

  test("verifier returns true => parent-linked replacement listed", async () => {
    const h = harness({ lineageVerifier: { verifyReplacementLineage: () => true } });
    const child = await seedParentAndChild(h);
    expect(child.lineageVerified).toBe(true);
    expect(h.draft.listPublicationCandidates(RUN_ID).some((c) => c.checkpointId === CHILD_CK_ID && c.lineageVerified)).toBe(true);
  });

  test("hardening child is never listable without a parent link", async () => {
    const h = harness({ lineageVerifier: { verifyReplacementLineage: () => true } });
    expect(() => h.draft.selectCandidate({
      runId: RUN_ID, candidateRunId: CHILD_RUN_ID, requesterUserId: USER_ID, repositoryId: REPO_ID,
      checkpointId: CHILD_CK_ID, checkpointHash: CHILD_CK_HASH, resultCommitSha: "2".repeat(40),
      lineage: "P7_REPLACEMENT", parentSelectionId: null,
    })).toThrow();
  });

  // The REAL ResolutionLineageVerifier (not a mock): a replacement-run candidate
  // whose durable resolution chain does not verify is ineligible and cannot be
  // approved or published. No resolution_replacements row => NOT_A_REPLACEMENT
  // => verified:false => lineageVerified=0.
  test("real verifier: broken-lineage replacement cannot be listed, approved, or published", async () => {
    const h = harness();
    const realVerifier = new ResolutionLineageVerifier(h.db, SIGNING_SECRET);
    // Rebind the service with the real verifier over the same DB.
    const draft = new PublicationAuthorityService(h.db, {
      actuator: { async createBranchPr() { return { kind: "RECEIPT", prUrl: "x", commitSha: RESULT_COMMIT }; } },
      preflight: { probe: (i) => i },
      credentialProvider: { getPublicationCredentials: () => ({ token: "ghp_secret" }) },
      lineageVerifier: realVerifier,
      now: () => new Date(AT), idFactory: deterministicId,
    });
    await draft.selectCandidate({
      runId: RUN_ID, candidateRunId: RUN_ID, requesterUserId: USER_ID, repositoryId: REPO_ID,
      checkpointId: CK_ID, checkpointHash: CK_HASH, resultCommitSha: RESULT_COMMIT, lineage: "ORIGINAL", parentSelectionId: null,
    });
    const parent = h.db.query("SELECT id FROM publication_candidate_selections_v33 WHERE checkpoint_id=?").get(CK_ID) as { id: string };
    // CHILD_RUN_ID has no resolution_replacements row: the real verifier fails closed.
    const child = await draft.selectCandidate({
      runId: RUN_ID, candidateRunId: CHILD_RUN_ID, requesterUserId: USER_ID, repositoryId: REPO_ID,
      checkpointId: CHILD_CK_ID, checkpointHash: CHILD_CK_HASH, resultCommitSha: "2".repeat(40),
      lineage: "P7_REPLACEMENT", parentSelectionId: parent.id,
    });
    expect(child.lineageVerified).toBe(false);
    expect(draft.listPublicationCandidates(RUN_ID).some((c) => c.lineage === "P7_REPLACEMENT")).toBe(false);
    expect(() => draft.approve(CHILD_CK_ID,
      { checkpointHash: CHILD_CK_HASH, decision: "APPROVE", policyVersion: PUBLICATION_AUTHORITY_POLICY_VERSION },
      CTX)).toThrow(StaleCandidateError);
  });
});

describe("v33 publication flow — preflight & idempotency", () => {
  test("preflight mismatch blocks and invalidates the approval", async () => {
    const drift: RepositoryPreflightProbe = { probe: () => ({ repositoryId: REPO_ID, baseCommitSha: "9".repeat(40) }) };
    const h = harness({ preflight: drift });
    const approval = await seedApprovedOriginal(h);
    await expect(h.draft.startPublication({
      runId: RUN_ID, approvalId: approval.approvalId, operation: "BRANCH_PR", idempotencyKey: "k1",
    })).rejects.toThrow(PreflightMismatchError);
    const current = h.db.query(`SELECT status FROM publication_approvals_v33 WHERE approval_id=? ORDER BY revision DESC LIMIT 1`).get(approval.approvalId) as { status: string };
    expect(current.status).toBe("INVALIDATED");
    const ops = h.db.query("SELECT COUNT(*) c FROM publication_git_operations_v33").get() as { c: number };
    expect(ops.c).toBe(0);
    await expect(h.draft.startPublication({
      runId: RUN_ID, approvalId: approval.approvalId, operation: "BRANCH_PR", idempotencyKey: "k2",
    })).rejects.toThrow();
  });

  test("duplicate Idempotency-Key (same approval) replays the one operation", async () => {
    const h = harness();
    const approval = await seedApprovedOriginal(h);
    const first = await h.draft.startPublication({ runId: RUN_ID, approvalId: approval.approvalId, operation: "BRANCH_PR", idempotencyKey: "same-key" });
    const second = await h.draft.startPublication({ runId: RUN_ID, approvalId: approval.approvalId, operation: "BRANCH_PR", idempotencyKey: "same-key" });
    expect(second.publicationId).toBe(first.publicationId);
    const rev0 = h.db.query("SELECT COUNT(*) c FROM publication_git_operations_v33 WHERE revision=0").get() as { c: number };
    expect(rev0.c).toBe(1);
  });

  test("happy path reaches RECEIPTED with a receipt; credentials reach only the actuator", async () => {
    const h = harness();
    const approval = await seedApprovedOriginal(h);
    const started = await h.draft.startPublication({ runId: RUN_ID, approvalId: approval.approvalId, operation: "BRANCH_PR", idempotencyKey: "k" });
    expect(started.state).toBe("PREFLIGHT");
    const settled = await h.draft.dispatch(started.publicationId);
    expect(settled.state).toBe("RECEIPTED");
    expect(settled.receipt?.prUrl).toBe("https://example/pr/1");
    expect(h.actuatorCalls).toBe(1);
    expect(h.credentialCalls).toBe(1);
    expect(h.seenCredentials).toEqual([{ token: "ghp_secret" }]);
  });
});

describe("v33 REGRESSION — integrator probes", () => {
  // A1 (P0): one approval must authorize at most one PR, even with a fresh key.
  test("A1: fresh idempotency key under a spent approval cannot double-publish", async () => {
    const h = harness();
    const approval = await seedApprovedOriginal(h);
    const p1 = await h.draft.startPublication({ runId: RUN_ID, approvalId: approval.approvalId, operation: "BRANCH_PR", idempotencyKey: "k1" });
    const r1 = await h.draft.dispatch(p1.publicationId);
    expect(r1.state).toBe("RECEIPTED");
    // Second publication, DIFFERENT key, SAME approval => APPROVAL_CONSUMED.
    await expect(h.draft.startPublication({
      runId: RUN_ID, approvalId: approval.approvalId, operation: "BRANCH_PR", idempotencyKey: "k2",
    })).rejects.toThrow(ApprovalConsumedError);
    // Exactly one publication, one actuator PR.
    expect(h.actuatorCalls).toBe(1);
    const pubs = h.db.query("SELECT COUNT(*) c FROM publication_git_operations_v33 WHERE revision=0").get() as { c: number };
    expect(pubs.c).toBe(1);
    const status = h.db.query("SELECT status FROM publication_approvals_v33 WHERE approval_id=? ORDER BY revision DESC LIMIT 1").get(approval.approvalId) as { status: string };
    expect(status.status).toBe("CONSUMED");
  });

  test("A1: a fresh PR requires a fresh approval", async () => {
    const h = harness();
    const a1 = await seedApprovedOriginal(h, CK_ID, CK_HASH);
    await h.draft.dispatch((await h.draft.startPublication({ runId: RUN_ID, approvalId: a1.approvalId, operation: "BRANCH_PR", idempotencyKey: "k1" })).publicationId);
    const a2 = await seedApprovedOriginal(h, CK2_ID, CK2_HASH);
    const p2 = await h.draft.startPublication({ runId: RUN_ID, approvalId: a2.approvalId, operation: "BRANCH_PR", idempotencyKey: "k2" });
    expect((await h.draft.dispatch(p2.publicationId)).state).toBe("RECEIPTED");
    expect(h.actuatorCalls).toBe(2);
  });

  // A2 (P1): the requester binding is server-derived; a lying caller cannot self-approve.
  test("A2: caller cannot approve their own selection by misnaming the requester", async () => {
    const h = harness();
    await selectOriginal(h);
    expect(() => h.draft.approve(CK_ID,
      { checkpointHash: CK_HASH, decision: "APPROVE", policyVersion: PUBLICATION_AUTHORITY_POLICY_VERSION },
      { ...CTX, approverActorId: USER_ID })).toThrow(SelfApprovalError);
  });

  test("A2: the DB trigger rejects an approval row whose requester != the selection's recorded requester", async () => {
    const h = harness();
    await selectOriginal(h);
    const selection = h.db.query("SELECT id FROM publication_candidate_selections_v33 WHERE checkpoint_id=?").get(CK_ID) as { id: string };
    expect(() => h.db.query(`INSERT INTO publication_approvals_v33
      (approval_id, revision, run_id, selection_id, checkpoint_id, checkpoint_hash, requester_actor_id,
       requester_actor_kind, approver_actor_id, approver_actor_kind, implementation_actor_id,
       implementation_actor_kind, evidence_root, repository_id, base_commit_sha, policy_version, decision,
       status, invalidation_reason, rationale, expires_at, created_at, approval_json)
      VALUES ('forged',0,?,?,?,?,'not-the-requester','HUMAN','mallory','HUMAN','engineer-agent','NON_HUMAN',?,?,?,?,'APPROVE','APPROVED',NULL,NULL,?,?,?)`).run(
        RUN_ID, selection.id, CK_ID, CK_HASH, EVID, REPO_ID, BASE_COMMIT, PUBLICATION_AUTHORITY_POLICY_VERSION,
        "2026-07-20T12:00:00.000Z", AT, JSON.stringify({ approvalId: "forged", revision: 0, checkpointId: CK_ID, checkpointHash: CK_HASH, approver: "mallory", requester: "not-the-requester" }))).toThrow();
  });

  // A3 (P2): idempotency replay with a different bound approval is a conflict.
  test("A3: same key + different approvalId => IDEMPOTENCY_CONFLICT", async () => {
    const h = harness();
    const a1 = await seedApprovedOriginal(h, CK_ID, CK_HASH);
    const a2 = await seedApprovedOriginal(h, CK2_ID, CK2_HASH);
    await h.draft.startPublication({ runId: RUN_ID, approvalId: a1.approvalId, operation: "BRANCH_PR", idempotencyKey: "shared" });
    await expect(h.draft.startPublication({
      runId: RUN_ID, approvalId: a2.approvalId, operation: "BRANCH_PR", idempotencyKey: "shared",
    })).rejects.toThrow(PublicationIdempotencyConflictError);
  });
});

describe("v33 publication flow — RECONCILING is durable & typed", () => {
  test("ambiguous outcome parks and a restart does NOT redispatch", async () => {
    const h = harness({ outcome: { kind: "AMBIGUOUS", observedRemoteState: "PR_MAYBE_CREATED", detail: "receipt lost" } });
    const approval = await seedApprovedOriginal(h);
    const started = await h.draft.startPublication({ runId: RUN_ID, approvalId: approval.approvalId, operation: "BRANCH_PR", idempotencyKey: "k" });
    const parked = await h.draft.dispatch(started.publicationId);
    expect(parked.state).toBe("RECONCILING");
    expect(parked.reconciliation?.reason).toBe("AMBIGUOUS_REMOTE_OUTCOME");
    expect(h.actuatorCalls).toBe(1);

    const resumed = h.draft.resume(started.publicationId);
    expect(resumed.state).toBe("RECONCILING");
    expect(h.actuatorCalls).toBe(1);

    const recon = h.db.query("SELECT COUNT(*) c FROM publication_reconciliations_v33").get() as { c: number };
    expect(recon.c).toBe(1);
  });

  test("crash mid-dispatch leaves durable DISPATCHED; restart reconciles without redispatch", async () => {
    const h = harness({ actuatorThrows: true });
    const approval = await seedApprovedOriginal(h);
    const started = await h.draft.startPublication({ runId: RUN_ID, approvalId: approval.approvalId, operation: "BRANCH_PR", idempotencyKey: "k" });
    await expect(h.draft.dispatch(started.publicationId)).rejects.toThrow(/network partition/);
    expect(h.draft.getPublication(started.publicationId).state).toBe("DISPATCHED");
    expect(h.actuatorCalls).toBe(1);

    const resumed = h.draft.resume(started.publicationId);
    expect(resumed.state).toBe("RECONCILING");
    expect(resumed.reconciliation?.reason).toBe("RESTART_UNCERTAIN_DISPATCH");
    expect(h.actuatorCalls).toBe(1);
    expect(h.draft.resume(started.publicationId).state).toBe("RECONCILING");
    expect(h.actuatorCalls).toBe(1);
  });

  // A4 (P2): RECONCILING only accepts an explicit typed resolution transition.
  test("A4: a non-resolution successor to RECONCILING is rejected at the DB layer", async () => {
    const h = harness({ outcome: { kind: "AMBIGUOUS", observedRemoteState: "PR_MAYBE", detail: "lost" } });
    const approval = await seedApprovedOriginal(h);
    const started = await h.draft.startPublication({ runId: RUN_ID, approvalId: approval.approvalId, operation: "BRANCH_PR", idempotencyKey: "k" });
    await h.draft.dispatch(started.publicationId);
    const row = h.db.query("SELECT * FROM publication_git_operations_v33 WHERE publication_id=? ORDER BY revision DESC LIMIT 1").get(started.publicationId) as {
      revision: number; approval_id: string; idempotency_key: string; requester_actor_id: string; implementation_actor_id: string;
    };
    expect(() => h.db.query(`INSERT INTO publication_git_operations_v33
      (publication_id, revision, run_id, approval_id, operation_type, idempotency_key, requester_actor_id,
       implementation_actor_id, repository_id, base_commit_sha, checkpoint_id, checkpoint_hash, state,
       prev_state, resolution_type, detail, created_at)
      VALUES (?,?,?,?,'BRANCH_PR',?,?,?,?,?,?,?,'RECEIPTED','RECONCILING',NULL,'silent',?)`).run(
        started.publicationId, Number(row.revision) + 1, RUN_ID, row.approval_id, row.idempotency_key,
        row.requester_actor_id, row.implementation_actor_id, REPO_ID, BASE_COMMIT, CK_ID, CK_HASH, AT)).toThrow();
  });

  test("A4: explicit typed resolution advances RECONCILING to a terminal state", async () => {
    const h = harness({ outcome: { kind: "AMBIGUOUS", observedRemoteState: "PR_MAYBE", detail: "lost" } });
    const approval = await seedApprovedOriginal(h);
    const started = await h.draft.startPublication({ runId: RUN_ID, approvalId: approval.approvalId, operation: "BRANCH_PR", idempotencyKey: "k" });
    await h.draft.dispatch(started.publicationId);
    const resolved = h.draft.resolveReconciliation(started.publicationId, "FAILED", "operator confirmed no PR landed");
    expect(resolved.state).toBe("FAILED");
  });
});

describe("v33 migration table immutability", () => {
  const tables = [
    "publication_candidate_selections_v33",
    "publication_approvals_v33",
    "publication_git_operations_v33",
    "publication_remote_receipts_v33",
    "publication_reconciliations_v33",
  ];

  async function seedAllTables(h: Harness): Promise<void> {
    const a = await seedApprovedOriginal(h, CK_ID, CK_HASH);
    h.nextOutcome = { kind: "RECEIPT", prUrl: "https://example/pr/1", commitSha: RESULT_COMMIT };
    const pa = await h.draft.startPublication({ runId: RUN_ID, approvalId: a.approvalId, operation: "BRANCH_PR", idempotencyKey: "kA" });
    expect((await h.draft.dispatch(pa.publicationId)).state).toBe("RECEIPTED");
    const b = await seedApprovedOriginal(h, CK2_ID, CK2_HASH);
    h.nextOutcome = { kind: "AMBIGUOUS", observedRemoteState: "PR_MAYBE_CREATED", detail: "receipt lost" };
    const pb = await h.draft.startPublication({ runId: RUN_ID, approvalId: b.approvalId, operation: "BRANCH_PR", idempotencyKey: "kB" });
    expect((await h.draft.dispatch(pb.publicationId)).state).toBe("RECONCILING");
  }

  test.each(tables)("%s rejects UPDATE and DELETE", async (table) => {
    const h = harness();
    await seedAllTables(h);
    const rows = h.db.query(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number };
    expect(rows.c).toBeGreaterThan(0);
    expect(() => h.db.query(`UPDATE ${table} SET created_at='2000-01-01T00:00:00.000Z'`).run()).toThrow(/immutable/);
    expect(() => h.db.query(`DELETE FROM ${table}`).run()).toThrow(/immutable/);
  });
});
