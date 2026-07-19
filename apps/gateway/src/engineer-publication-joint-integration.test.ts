/**
 * JOINT INTEGRATION GATE (R3 + R4 driven TOGETHER).
 *
 * The isolated R3 (publication dispatch/reconcile) and R4 (attestation export,
 * tenant isolation) suites are green individually, but NO test drives them
 * through ONE coherent vertical. Per the mandate: "Neither should receive a PASS
 * until cross-tenant publication, restart recovery, reconciliation and audit-export
 * tests pass TOGETHER."
 *
 * This test drives the REAL seams over ONE migrated database:
 *   - the REAL gateway publication-authority FACADE (createEngineerPublicationAuthorityFacade),
 *   - the REAL P8 PublicationAuthorityService (supervisor.createPublicationAuthorityService),
 *   - the REAL ledger APPROVE + v35 provenance attestation persistence
 *     (supervisor.decideApproval → EngineerLedger.persistPromotionAttestation),
 *   - the REAL org-scoped LIVE audit export (TenantScopedLedgerDal.exportRunAuditChain, B1),
 *   - the REAL two-person approver identity derivation (deriveEngineerPrincipal, B4).
 *
 * The ONLY test-seam injections (explicitly sanctioned by the mandate) are:
 *   1. a SEPARATELY provisioned approver secret (the production ceremony is [HUMAN]);
 *   2. a `resultTreeHashFor` fake returning a valid `sha256:<64hex>` (production wires
 *      `() => null`; a real git-tree source is [HUMAN]);
 *   3. a fake publication actuator (RECEIPT / AMBIGUOUS / THROW) standing in for the
 *      credentialed GitHub branch/PR effect (real GitHub creds are [HUMAN]).
 * The units under test — facade, service, ledger, attestation, audit export — are REAL.
 *
 * Supporting-record binding TRIGGERS (v21/v22/v23 approval-authority guards) are dropped
 * ONLY to seed the durable checkpoint + PENDING approval request directly (their invariants
 * are covered by their own suites, exactly as attestation-persistence.test.ts does). Every
 * JOINT seam under test runs with its real triggers intact.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  EngineerSupervisor,
  TenantScopedLedgerDal,
  defineHumanActor,
  createVerifiedCandidateCheckpoint,
  canonicalJson,
  sha256,
  EngineerNotFoundError,
  ENGINEER_DEFAULT_ORG_ID,
  PUBLICATION_AUTHORITY_POLICY_VERSION,
  type CheckpointAttestor,
  type VerifiedCandidateCheckpointInput,
  PublicationAuthorityService,
  type ActuatorOutcome,
  type PublicationActuator,
} from "@zintus/engineer";
import { deriveEngineerPrincipal, type EngineerPrincipal } from "./engineer-identity.js";
import {
  createEngineerPublicationAuthorityFacade,
  CandidateNotFoundError,
  PublicationApproverNotProvisionedError,
  PublicationAttestationUnavailableError,
  type PublicationFacadeDeps,
} from "./engineer-publication-facade.js";

const NOW = "2026-07-19T00:00:00.000Z";
const AT = "2026-07-19T12:00:00.000Z"; // facade + supervisor clock: between NOW and DEADLINE
const DEADLINE = "2026-07-20T00:00:00.000Z";
const POLICY = PUBLICATION_AUTHORITY_POLICY_VERSION;
const INJECTED_RESULT_TREE_HASH = `sha256:${"a".repeat(64)}`;
const hx = (seed: string): string => sha256(seed);

const checkpointAttestor: CheckpointAttestor = {
  algorithm: "test-sha256",
  keyId: "checkpoint-test-key",
  sign: (payload) => `test:${sha256(payload)}`,
  verify: (payload, signature) => signature === `test:${sha256(payload)}`,
};

// The v21/v22/v23 approval-authority binding triggers, dropped so the fixture can
// seed a promoted checkpoint + PENDING approval request directly (their invariants
// are covered by their own suites). The v33 publication state-machine triggers and
// the provenance FK/immutability triggers stay INTACT — the joint seams run real.
const AUTHORITY_GUARDS = [
  "require_verified_candidate_checkpoint_bindings_v21",
  "require_approval_checkpoint_pair_v21",
  "require_approval_checkpoint_match_v21",
  "require_new_approval_checkpoint_v22",
  "require_approval_selection_v23",
  "require_new_approval_decision_checkpoint_v22",
  "require_approval_decision_checkpoint_match_v22",
];

function checkpointInput(runId: string, requesterUserId: string, repositoryId: string, nonce: string): VerifiedCandidateCheckpointInput {
  const claim = {
    inputHash: hx(`builder-input-${nonce}`), agentExecutionId: "builder-1", modelTier: "GPT-5.6_TERRA" as const,
    workerOwnerId: null, workerFencingToken: null, status: "SUCCEEDED" as const,
    outputArtifactId: "builder-output", startedAt: NOW, completedAt: "2026-07-19T00:01:00.000Z",
    outputArtifactAuthority: {
      artifactId: "builder-output", sha256: hx(`builder-output-${nonce}`), sizeBytes: 1,
      createdAt: "2026-07-19T00:01:00.000Z", type: "BUILDER_RESULT" as const,
      producerType: "SYSTEM" as const, producerId: "builder", trusted: false as const,
      regularFile: true as const, symbolicLink: false as const,
    },
  };
  return {
    schemaVersion: 1, policyVersion: "verified-candidate-checkpoint-v1", parentCheckpointId: null,
    runId, requesterUserId, repositoryId,
    requiredLaneContractHash: hx(`contract-${nonce}`), manifestHash: hx(`manifest-${nonce}`),
    baseCommitSha: "a".repeat(40), resultCommitSha: "b".repeat(40), diffHash: hx(`diff-${nonce}`),
    reviewerSessionId: `reviewer-${nonce}`, classificationHash: hx(`classification-${nonce}`), classificationResult: "READY",
    evidenceBundleId: `bundle-${nonce}`, evidenceBundleHash: hx(`bundle-${nonce}`),
    claimSummary: { claimIds: ["claim"], claimSetHash: hx(`claim-set-${nonce}`) },
    verificationSummary: { verificationPass: 1, testExecutionIds: ["test-a", "test-b"], testExecutionSetHash: hx(`tests-${nonce}`),
      provenanceEventIds: ["event"], provenanceHash: hx(`events-${nonce}`), allRequiredChecksPassed: true },
    securitySummary: { findingIds: [], findingSetHash: hx(`findings-${nonce}`), openBlockingCriticalCount: 0 },
    scopeSummary: { artifactId: "scope", artifactHash: hx(`scope-${nonce}`), policyVersion: "final-change-scope-v1" },
    environmentDigest: hx(`environment-${nonce}`),
    builderDispatchSummary: { claims: [claim], claimSetHash: sha256([claim]) },
    prePromotionEventChainSummary: { eventCount: 1, headEventId: "reviewing", headSequence: 1,
      headStateVersion: 1, chainHash: hx(`chain-${nonce}`) },
    createdAt: "2026-07-19T00:02:00.000Z",
  };
}

interface TenantSeed {
  org: string;
  runId: string;
  repositoryId: string;
  ownerId: string;
  approverId: string;
  checkpointId: string;
  checkpointHash: string;
  approvalRequestId: string;
}

/**
 * Seed one tenant's durable graph directly on the ledger's file (a separate handle
 * with FK enforcement off + authority guards dropped): org, user, repo connection,
 * run, promoted verified-candidate checkpoint (real checkpoint_json), agent
 * executions, run budget, and a PENDING approval request bound to the checkpoint.
 */
async function seedTenant(dbPath: string, opts: {
  org: string; runId: string; repositoryId: string; ownerId: string; approverId: string; nonce: string;
}): Promise<TenantSeed> {
  const { checkpoint } = await createVerifiedCandidateCheckpoint(
    checkpointInput(opts.runId, opts.ownerId, opts.repositoryId, opts.nonce), checkpointAttestor);
  const seed = new Database(dbPath);
  seed.exec("PRAGMA foreign_keys=OFF");
  for (const trigger of AUTHORITY_GUARDS) seed.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
  seed.query("INSERT OR IGNORE INTO orgs(id,display_name,default_retention_class,status,created_at,updated_at) VALUES (?,?,?,?,?,?)")
    .run(opts.org, opts.org, "STANDARD", "ACTIVE", NOW, NOW);
  seed.query("INSERT OR IGNORE INTO users(id,email,created_at,updated_at) VALUES (?,?,?,?)").run(opts.ownerId, null, NOW, NOW);
  seed.query("INSERT INTO repository_connections(id,user_id,provider,owner,name,created_at,updated_at,org_id) VALUES (?,?,?,?,?,?,?,?)")
    .run(opts.repositoryId, opts.ownerId, "local", "o", opts.nonce, NOW, NOW, opts.org);
  seed.query(
    "INSERT INTO engineer_runs(id,user_id,repository_id,base_branch,base_commit_sha,request_original," +
      "request_normalized,state,state_version,risk_tier,human_gate_required,created_at,updated_at,org_id)" +
      " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(opts.runId, opts.ownerId, opts.repositoryId, "main", "a".repeat(40), "req", "req", "REVIEW_APPROVED", 1, "HIGH", 1, NOW, NOW, opts.org);
  seed.query(
    "INSERT INTO verified_candidate_checkpoints(id,checkpoint_hash,parent_checkpoint_id,run_id,requester_user_id," +
      "repository_id,required_lane_contract_hash,manifest_hash,base_commit_sha,result_commit_sha,diff_hash," +
      "reviewer_session_id,classification_hash,classification_result,evidence_bundle_id,evidence_bundle_hash," +
      "environment_digest,checkpoint_json,statement_json,statement_hash,signature_algorithm,signature_key_id," +
      "signature,created_at,org_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    checkpoint.checkpointId, checkpoint.checkpointHash, null, checkpoint.runId, checkpoint.requesterUserId,
    checkpoint.repositoryId, checkpoint.requiredLaneContractHash, checkpoint.manifestHash, checkpoint.baseCommitSha,
    checkpoint.resultCommitSha, checkpoint.diffHash, checkpoint.reviewerSessionId, checkpoint.classificationHash,
    checkpoint.classificationResult, checkpoint.evidenceBundleId, checkpoint.evidenceBundleHash,
    checkpoint.environmentDigest, canonicalJson(checkpoint), "{}", hx(`cp-statement-${opts.nonce}`),
    checkpointAttestor.algorithm, checkpointAttestor.keyId, "sig", checkpoint.createdAt, opts.org,
  );
  seed.query("INSERT INTO agent_executions(id,run_id,role,model_tier,status,started_at,completed_at,org_id) VALUES (?,?,?,?,?,?,?,?)")
    .run(`reviewer-${opts.nonce}`, opts.runId, "REVIEWER", "GPT-5.6_TERRA", "SUCCEEDED", NOW, NOW, opts.org);
  seed.query("INSERT INTO agent_executions(id,run_id,role,model_tier,status,started_at,completed_at,org_id) VALUES (?,?,?,?,?,?,?,?)")
    .run(`builder-${opts.nonce}`, opts.runId, "BUILDER", "GPT-5.6_TERRA", "SUCCEEDED", NOW, NOW, opts.org);
  seed.query(
    "INSERT INTO run_budgets(run_id,cost_limit_usd,token_limit,time_limit_seconds,lifetime_cost_limit_usd," +
      "lifetime_token_limit,lifetime_time_limit_seconds,used_cost_usd,used_tokens,used_time_seconds,status," +
      "created_at,updated_at,org_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(opts.runId, 10, 100000, 3600, 10, 100000, 3600, 0.125, 6789, 42, "ACTIVE", NOW, NOW, opts.org);
  const approvalRequestId = `approval-${opts.nonce}`;
  seed.query(
    "INSERT INTO approval_requests(id,run_id,risk_tier,assigned_reviewer_id,requested_at,deadline_at," +
      "reminder_schedule_json,timeout_action,manifest_hash,diff_hash,evidence_bundle_hash,status," +
      "reviewer_session_id,classification_hash,classification_result,verified_checkpoint_id," +
      "verified_checkpoint_hash,approval_revision,org_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    approvalRequestId, opts.runId, "HIGH", null, NOW, DEADLINE, "[]", "REJECT",
    checkpoint.manifestHash, checkpoint.diffHash, checkpoint.evidenceBundleHash, "PENDING",
    checkpoint.reviewerSessionId, checkpoint.classificationHash, checkpoint.classificationResult,
    checkpoint.checkpointId, checkpoint.checkpointHash, 0, opts.org,
  );
  seed.close();
  return {
    org: opts.org, runId: opts.runId, repositoryId: opts.repositoryId, ownerId: opts.ownerId, approverId: opts.approverId,
    checkpointId: checkpoint.checkpointId, checkpointHash: checkpoint.checkpointHash, approvalRequestId,
  };
}

/**
 * Seed a FOREIGN (non-default) tenant's run + checkpoint + a durable v35 provenance
 * attestation row DIRECTLY. The run/approval WRITE path is single-tenant (the ledger
 * rejects a non-default org), so a foreign tenant's provenance can only be planted
 * directly — its presence lets us prove the audit-export ORG fence excludes it.
 * Returns the foreign statement_hash + runId.
 */
async function seedForeignOrgAttestation(dbPath: string, opts: { org: string; runId: string; repositoryId: string; ownerId: string; nonce: string }): Promise<{ statementHash: string; runId: string }> {
  const { checkpoint } = await createVerifiedCandidateCheckpoint(
    checkpointInput(opts.runId, opts.ownerId, opts.repositoryId, opts.nonce), checkpointAttestor);
  const statementHash = hx(`foreign-statement-${opts.nonce}`);
  const seed = new Database(dbPath);
  seed.exec("PRAGMA foreign_keys=OFF");
  for (const trigger of AUTHORITY_GUARDS) seed.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
  seed.query("INSERT OR IGNORE INTO orgs(id,display_name,default_retention_class,status,created_at,updated_at) VALUES (?,?,?,?,?,?)")
    .run(opts.org, opts.org, "STANDARD", "ACTIVE", NOW, NOW);
  seed.query("INSERT OR IGNORE INTO users(id,email,created_at,updated_at) VALUES (?,?,?,?)").run(opts.ownerId, null, NOW, NOW);
  seed.query("INSERT INTO repository_connections(id,user_id,provider,owner,name,created_at,updated_at,org_id) VALUES (?,?,?,?,?,?,?,?)")
    .run(opts.repositoryId, opts.ownerId, "local", "o", opts.nonce, NOW, NOW, opts.org);
  seed.query(
    "INSERT INTO engineer_runs(id,user_id,repository_id,base_branch,base_commit_sha,request_original," +
      "request_normalized,state,state_version,risk_tier,human_gate_required,created_at,updated_at,org_id)" +
      " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(opts.runId, opts.ownerId, opts.repositoryId, "main", "a".repeat(40), "req", "req", "REVIEW_APPROVED", 1, "HIGH", 1, NOW, NOW, opts.org);
  seed.query(
    "INSERT INTO verified_candidate_checkpoints(id,checkpoint_hash,parent_checkpoint_id,run_id,requester_user_id," +
      "repository_id,required_lane_contract_hash,manifest_hash,base_commit_sha,result_commit_sha,diff_hash," +
      "reviewer_session_id,classification_hash,classification_result,evidence_bundle_id,evidence_bundle_hash," +
      "environment_digest,checkpoint_json,statement_json,statement_hash,signature_algorithm,signature_key_id," +
      "signature,created_at,org_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    checkpoint.checkpointId, checkpoint.checkpointHash, null, checkpoint.runId, checkpoint.requesterUserId,
    checkpoint.repositoryId, checkpoint.requiredLaneContractHash, checkpoint.manifestHash, checkpoint.baseCommitSha,
    checkpoint.resultCommitSha, checkpoint.diffHash, checkpoint.reviewerSessionId, checkpoint.classificationHash,
    checkpoint.classificationResult, checkpoint.evidenceBundleId, checkpoint.evidenceBundleHash,
    checkpoint.environmentDigest, canonicalJson(checkpoint), "{}", hx(`cp-statement-${opts.nonce}`),
    checkpointAttestor.algorithm, checkpointAttestor.keyId, "sig", checkpoint.createdAt, opts.org,
  );
  // The v35 binding trigger requires envelope_json's payloadType/keyid to project the
  // row's columns — satisfy it (keeping the integrity trigger intact) rather than drop it.
  const payloadType = "application/vnd.in-toto+json";
  const foreignKeyId = "foreign-key";
  const envelopeJson = JSON.stringify({ payloadType, signatures: [{ keyid: foreignKeyId, sig: "x" }] });
  seed.query(
    "INSERT INTO provenance_attestations(statement_hash,org_id,subject_checkpoint_id,subject_checkpoint_hash," +
      "approval_decision_id,approver_actor_id,signature_key_id,signature_algorithm,payload_type,envelope_json," +
      "statement_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    statementHash, opts.org, checkpoint.checkpointId, checkpoint.checkpointHash,
    `foreign-decision-${opts.nonce}`, `foreign-approver-${opts.nonce}`, foreignKeyId, "hmac-sha256",
    payloadType, envelopeJson, "{}", NOW,
  );
  seed.close();
  return { statementHash, runId: opts.runId };
}

interface Harness {
  supervisor: EngineerSupervisor;
  dbPath: string;
  principal: EngineerPrincipal;
  singleInstallPrincipal: EngineerPrincipal;
  makeFacade: (overrides?: Partial<PublicationFacadeDeps>, actuator?: PublicationActuator) => ReturnType<typeof createEngineerPublicationAuthorityFacade>;
  seed: TenantSeed;
}

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

const RECEIPT_ACTUATOR: PublicationActuator = {
  async createBranchPr(): Promise<ActuatorOutcome> { return { kind: "RECEIPT", prUrl: "https://github.test/pull/1", commitSha: "b".repeat(40) }; },
};

let idCounter = 0;

/**
 * The default install SECRET — a single install's principal derives THIS ownerId
 * (so it owns the seeded graph) but has NO approver. The happy-path principal adds
 * a SEPARATELY provisioned approver secret (the [HUMAN] ceremony, injected here).
 */
const INSTALL_SECRET = "joint-integration-install-secret";
const APPROVER_SECRET = "joint-integration-independent-approver-secret";

async function makeHarness(): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), "zintus-engineer-joint-"));
  const dbPath = join(root, "engineer.sqlite");
  // Construct the supervisor first so the full migration chain installs the schema
  // (v33 publication slice + v34 tenancy + v35 provenance store) on the file.
  const supervisor = new EngineerSupervisor({ dbPath, now: () => new Date(AT) });
  // Production wires the SAME confined secret as both the resolution-signing and the
  // provenance signer (index.ts). Configure a provenance signer so a durable APPROVE
  // atomically emits + persists the v35 attestation.
  supervisor.configureProvenanceAttestationSigner("joint-provenance-signer-secret-32bytes!!", "engineer-provenance-key-joint");
  cleanups.push(() => { try { supervisor.close(); } catch { /* already closed */ } rmSync(root, { recursive: true, force: true }); });

  const principal = deriveEngineerPrincipal({ gatewayIdentitySecret: INSTALL_SECRET, approverIdentitySecret: APPROVER_SECRET });
  const singleInstallPrincipal = deriveEngineerPrincipal({ gatewayIdentitySecret: INSTALL_SECRET });

  // The run/approval/publication WRITE path is deliberately single-tenant: the ledger
  // fixes its operative org to ENGINEER_DEFAULT_ORG_ID (ledger.ts:648-683) and rejects
  // any other. So the live joint flow (the production reality of a single install) runs
  // in the DEFAULT org; the v34 multi-org isolation is a READ-side (audit-export DAL)
  // property proven separately in assertion 4.
  const seed = await seedTenant(dbPath, {
    org: ENGINEER_DEFAULT_ORG_ID, runId: "run-a", repositoryId: "repo-a", ownerId: principal.ownerId,
    approverId: principal.approverId as string, nonce: "a",
  });

  const makeFacade = (overrides: Partial<PublicationFacadeDeps> = {}, actuator: PublicationActuator = RECEIPT_ACTUATOR) => {
    const service = supervisor.createPublicationAuthorityService({
      actuator,
      preflight: { probe: (input) => ({ repositoryId: input.repositoryId, baseCommitSha: input.baseCommitSha }) },
      credentialProvider: { getPublicationCredentials: () => ({ token: "ghp_joint" }) },
      now: () => new Date(AT),
      idFactory: () => `pub-${(idCounter += 1)}`,
    });
    const deps: PublicationFacadeDeps = {
      service,
      principal,
      connection: supervisor.resolutionDeskConnection(),
      now: () => new Date(AT),
      credentialAvailable: true,
      attestationRequired: true,
      latestApprovalRequest: (runId) => {
        const request = supervisor.latestApprovalRequest(runId);
        return request ? {
          approvalRequestId: request.approvalRequestId, status: request.status,
          approvalRevision: request.approvalRevision, deadlineAt: request.deadlineAt,
          evidenceBundleHash: request.evidenceBundleHash,
          verifiedCheckpointId: request.verifiedCheckpointId ?? null,
          verifiedCheckpointHash: request.verifiedCheckpointHash ?? null,
        } : null;
      },
      // The REAL ledger APPROVE + v35 attestation persistence path (production wires
      // exactly this: supervisor.decideApproval(record, "APPROVED", provenanceContext)).
      decideApprove: (record, provenanceContext) => {
        supervisor.decideApproval(record as never, "APPROVED", provenanceContext);
      },
      // [test seam] production wires () => null (fail-closed); a real git-tree source is [HUMAN].
      resultTreeHashFor: () => INJECTED_RESULT_TREE_HASH,
      ...overrides,
    };
    return createEngineerPublicationAuthorityFacade(deps);
  };

  return { supervisor, dbPath, principal, singleInstallPrincipal, makeFacade, seed };
}

function auditDal(supervisor: EngineerSupervisor, org: string) {
  return new TenantScopedLedgerDal(supervisor.resolutionDeskConnection(), { orgId: org, actor: defineHumanActor("auditor") });
}

function readerDb(dbPath: string): Database {
  const db = new Database(dbPath);
  cleanups.push(() => db.close());
  return db;
}

describe("JOINT GATE — R3 publication + R4 attestation/export/tenant driven together", () => {
  // ------------------------------------------------------------------------
  // Assertion 1: HAPPY PATH — verified candidate → distinct provisioned approver
  // APPROVEs → v35 attestation persists atomically → appears in the org-scoped
  // audit export → startPublication → dispatch (RECEIPT) → RECEIPTED with receipt.
  // ------------------------------------------------------------------------
  test("1. HAPPY PATH: approve emits a v35 attestation that surfaces in the audit export, then publication dispatches to RECEIPTED", async () => {
    const h = await makeHarness();
    const { principal, seed } = h;
    const facade = h.makeFacade();

    // Distinct provisioned approver (B4): the happy path REQUIRES it.
    expect(principal.approverId).toBeTruthy();
    expect(principal.approverId).not.toBe(principal.ownerId);

    // select → approve (drives the REAL v35 attestation emission+persistence).
    await facade.selectCandidate(principal, seed.runId, { checkpointId: seed.checkpointId });
    const approval = facade.approve(principal, seed.checkpointId, {
      checkpointHash: seed.checkpointHash, decision: "APPROVE", policyVersion: POLICY,
    }) as { approvalId: string; status: string };
    expect(approval.status).toBe("APPROVED");

    // The v35 attestation was persisted atomically, org-scoped to the tenant.
    const db = readerDb(h.dbPath);
    const attestation = db.query("SELECT statement_hash, org_id, subject_checkpoint_id, approver_actor_id FROM provenance_attestations")
      .get() as { statement_hash: string; org_id: string; subject_checkpoint_id: string; approver_actor_id: string };
    expect(attestation).toBeTruthy();
    expect(attestation.org_id).toBe(seed.org);
    expect(attestation.subject_checkpoint_id).toBe(seed.checkpointId);
    expect(attestation.approver_actor_id).toBe(principal.approverId as string);

    // It APPEARS in the LIVE org-scoped audit export as an ATTESTATION entry with the
    // right statement_hash (the B1 seam: provenance_attestations JOIN checkpoint, org-scoped).
    const chain = auditDal(h.supervisor, seed.org).exportRunAuditChain(seed.runId);
    const entries = chain.pages.flatMap((page) => page.entries);
    const provenanceEntry = entries.find(
      (entry) => entry.kind === "ATTESTATION" && entry.payload.statementHash === attestation.statement_hash,
    );
    expect(provenanceEntry).toBeTruthy();
    expect(provenanceEntry?.tenantId).toBe(seed.org);
    // The checkpoint-derived ATTESTATION entry (a DIFFERENT id) coexists — the
    // provenance entry is distinct, not a mislabel of the checkpoint.
    expect(entries.some((e) => e.kind === "ATTESTATION" && e.id === seed.checkpointId)).toBe(true);

    // startPublication → dispatch → RECEIPTED with a durable receipt row.
    const started = await facade.startPublication(principal, seed.runId, { approvalId: approval.approvalId }, "idem-happy") as { publicationId: string; state: string };
    expect(started.state).toBe("PREFLIGHT");
    const dispatched = await facade.dispatch(principal, started.publicationId) as { state: string; receipt?: { prUrl: string } };
    expect(dispatched.state).toBe("RECEIPTED");
    expect(dispatched.receipt?.prUrl).toBe("https://github.test/pull/1");
    const receipts = db.query("SELECT COUNT(*) c FROM publication_remote_receipts_v33 WHERE publication_id=?").get(started.publicationId) as { c: number };
    expect(receipts.c).toBe(1);
    expect((facade.getPublication(principal, started.publicationId) as { state: string }).state).toBe("RECEIPTED");
  });

  // ------------------------------------------------------------------------
  // Assertion 2: RESTART RECOVERY — a durable DISPATCHED (crash mid-remote) parks
  // RECONCILING on boot recovery; exactly one PR path, never a redispatch.
  // ------------------------------------------------------------------------
  test("2. RESTART RECOVERY: a durable DISPATCHED publication parks RECONCILING on restart with exactly one reconciliation and no redispatch", async () => {
    const h = await makeHarness();
    const { principal, seed } = h;
    // An actuator whose remote call THROWS *after* dispatch committed DISPATCHED —
    // the crash window. It records how many times the remote effect was attempted.
    let actuatorCalls = 0;
    const crashingActuator: PublicationActuator = {
      async createBranchPr(): Promise<ActuatorOutcome> { actuatorCalls += 1; throw new Error("process crashed mid-dispatch"); },
    };
    const facade = h.makeFacade({}, crashingActuator);
    await facade.selectCandidate(principal, seed.runId, { checkpointId: seed.checkpointId });
    const approval = facade.approve(principal, seed.checkpointId, { checkpointHash: seed.checkpointHash, decision: "APPROVE", policyVersion: POLICY }) as { approvalId: string };
    const started = await facade.startPublication(principal, seed.runId, { approvalId: approval.approvalId }, "idem-restart") as { publicationId: string };
    // dispatch commits DISPATCHED durably, then the remote throws → a DISPATCHED row
    // with no receipt survives (the crash boundary). One remote attempt.
    await expect(facade.dispatch(principal, started.publicationId)).rejects.toThrow("process crashed mid-dispatch");
    expect(actuatorCalls).toBe(1);
    const db = readerDb(h.dbPath);
    const state = db.query(
      "SELECT state FROM publication_git_operations_v33 WHERE publication_id=? ORDER BY revision DESC LIMIT 1",
    ).get(started.publicationId) as { state: string };
    expect(state.state).toBe("DISPATCHED");

    // RESTART: a fresh PublicationAuthorityService on a NEW connection to the SAME db
    // file (mirrors the gateway boot-recovery loop in index.ts, which calls
    // listResumablePublications()/resume() after a restart). Its actuator would throw
    // if the recovery ever re-issued the remote effect.
    const restartDb = new Database(h.dbPath);
    cleanups.push(() => { try { restartDb.close(); } catch { /* already closed */ } });
    const service2 = new PublicationAuthorityService(restartDb, {
      actuator: crashingActuator,
      preflight: { probe: (input) => ({ repositoryId: input.repositoryId, baseCommitSha: input.baseCommitSha }) },
      credentialProvider: { getPublicationCredentials: () => ({ token: "ghp_joint" }) },
      now: () => new Date(AT), idFactory: () => `pub-restart-${(idCounter += 1)}`,
    });
    const resumable = service2.listResumablePublications();
    expect(resumable).toEqual([started.publicationId]);
    const recovered = await service2.resume(started.publicationId);
    expect(recovered.state).toBe("RECONCILING");

    // Exactly one reconciliation record, requires_human; the actuator was NEVER
    // re-invoked (no second PR) — the crash window closed.
    expect(actuatorCalls).toBe(1);
    const recon = db.query("SELECT COUNT(*) c, MAX(requires_human) h FROM publication_reconciliations_v33 WHERE publication_id=?")
      .get(started.publicationId) as { c: number; h: number };
    expect(recon.c).toBe(1);
    expect(recon.h).toBe(1);
    // A repeated restart is idempotent — still one reconciliation, still RECONCILING.
    await service2.resume(started.publicationId);
    const reconAfter = db.query("SELECT COUNT(*) c FROM publication_reconciliations_v33 WHERE publication_id=?").get(started.publicationId) as { c: number };
    expect(reconAfter.c).toBe(1);
    expect((service2.getPublication(started.publicationId)).state).toBe("RECONCILING");
  });

  // ------------------------------------------------------------------------
  // Assertion 3: RECONCILIATION — an AMBIGUOUS outcome parks RECONCILING
  // (requires_human); only resolveReconciliation drives it terminal.
  // ------------------------------------------------------------------------
  test("3. RECONCILIATION: an AMBIGUOUS actuator parks RECONCILING and only resolveReconciliation drives a terminal state", async () => {
    const h = await makeHarness();
    const { principal, seed } = h;
    const ambiguousActuator: PublicationActuator = {
      async createBranchPr(): Promise<ActuatorOutcome> { return { kind: "AMBIGUOUS", observedRemoteState: "PR_MAYBE_LANDED", detail: "receipt lost in flight" }; },
    };
    const facade = h.makeFacade({}, ambiguousActuator);
    await facade.selectCandidate(principal, seed.runId, { checkpointId: seed.checkpointId });
    const approval = facade.approve(principal, seed.checkpointId, { checkpointHash: seed.checkpointHash, decision: "APPROVE", policyVersion: POLICY }) as { approvalId: string };
    const started = await facade.startPublication(principal, seed.runId, { approvalId: approval.approvalId }, "idem-recon") as { publicationId: string };
    const parked = await facade.dispatch(principal, started.publicationId) as { state: string; reconciliation?: { reason: string } };
    expect(parked.state).toBe("RECONCILING");
    expect(parked.reconciliation?.reason).toBe("AMBIGUOUS_REMOTE_OUTCOME");

    const db = readerDb(h.dbPath);
    expect((db.query("SELECT requires_human h FROM publication_reconciliations_v33 WHERE publication_id=?").get(started.publicationId) as { h: number }).h).toBe(1);
    // A non-RECEIPTED/FAILED resolution is rejected (400) — RECONCILING is not
    // silently escapable.
    expect(() => facade.resolveReconciliation(principal, started.publicationId, { resolution: "MAYBE" })).toThrow(/RECEIPTED.*FAILED/);
    expect((facade.getPublication(principal, started.publicationId) as { state: string }).state).toBe("RECONCILING");
    // Only an explicit operator resolution drives it terminal.
    const resolved = facade.resolveReconciliation(principal, started.publicationId, { resolution: "FAILED", detail: "operator confirmed no PR landed" }) as { state: string };
    expect(resolved.state).toBe("FAILED");
  });

  // ------------------------------------------------------------------------
  // Assertion 4: CROSS-TENANT ISOLATION — org A's audit export never contains org
  // B's attestations/runs, and cross-org candidate/publication access is not-found.
  // ------------------------------------------------------------------------
  test("4. CROSS-TENANT ISOLATION: org A's export excludes org B; cross-org candidate/publication access is not-found", async () => {
    const h = await makeHarness();
    const { principal, seed } = h;

    // Drive org A's (default-org) real APPROVE so a genuine v35 attestation exists.
    const facadeA = h.makeFacade();
    await facadeA.selectCandidate(principal, seed.runId, { checkpointId: seed.checkpointId });
    facadeA.approve(principal, seed.checkpointId, { checkpointHash: seed.checkpointHash, decision: "APPROVE", policyVersion: POLICY });

    // ORG FENCE (audit export). A FOREIGN tenant (org-tenant-b) with its own run +
    // checkpoint + a durable provenance attestation, planted directly (the write path
    // is single-tenant, so a foreign attestation can only be seeded). The org-scoped
    // DAL must never surface it in the default org's export, and its run is not-found.
    const foreign = await seedForeignOrgAttestation(h.dbPath, { org: "org-tenant-b", runId: "run-b", repositoryId: "repo-b", ownerId: "owner-b", nonce: "b" });
    const dalDefault = auditDal(h.supervisor, ENGINEER_DEFAULT_ORG_ID);
    const chainA = dalDefault.exportRunAuditChain(seed.runId);
    const entriesA = chainA.pages.flatMap((page) => page.entries);
    // The default org's export carries its OWN provenance attestation but NOT org B's.
    expect(entriesA.some((e) => e.kind === "ATTESTATION")).toBe(true);
    expect(entriesA.map((e) => e.id)).not.toContain(foreign.statementHash);
    for (const entry of entriesA) expect(entry.tenantId).toBe(ENGINEER_DEFAULT_ORG_ID);
    // The default-org DAL cannot even reach org B's run — byte-identical not-found.
    expect(() => dalDefault.exportRunAuditChain(foreign.runId)).toThrow(EngineerNotFoundError);
    // Symmetrically, a DAL scoped to org B does surface B's attestation (proving the
    // exclusion above is the org fence, not an empty store).
    const dalForeign = auditDal(h.supervisor, "org-tenant-b");
    const chainB = dalForeign.exportRunAuditChain(foreign.runId).pages.flatMap((p) => p.entries);
    expect(chainB.some((e) => e.kind === "ATTESTATION" && e.id === foreign.statementHash)).toBe(true);

    // OWNER FENCE (candidate + publication access). A SECOND principal (different owner)
    // in the default org drives a REAL publication; principal A can neither see its
    // candidate nor its publication (single not-found shape; no ownership oracle).
    const principalB = deriveEngineerPrincipal({ gatewayIdentitySecret: "second-owner-install-secret", approverIdentitySecret: "second-owner-independent-approver" });
    const seedB = await seedTenant(h.dbPath, { org: ENGINEER_DEFAULT_ORG_ID, runId: "run-b-owner", repositoryId: "repo-b-owner", ownerId: principalB.ownerId, approverId: principalB.approverId as string, nonce: "bowner" });
    const facadeB = h.makeFacade({ principal: principalB });
    await facadeB.selectCandidate(principalB, seedB.runId, { checkpointId: seedB.checkpointId });
    const approvalB = facadeB.approve(principalB, seedB.checkpointId, { checkpointHash: seedB.checkpointHash, decision: "APPROVE", policyVersion: POLICY }) as { approvalId: string };
    const pubB = await facadeB.startPublication(principalB, seedB.runId, { approvalId: approvalB.approvalId }, "idem-bowner") as { publicationId: string };
    // Principal A selecting principal B's checkpoint → not-found (requester mismatch).
    expect(() => facadeA.selectCandidate(principal, seed.runId, { checkpointId: seedB.checkpointId })).toThrow(CandidateNotFoundError);
    // Principal A referencing principal B's real publication by opaque id → the same
    // not-found shape as a wholly-unknown id (no ownership oracle).
    await expect(facadeA.dispatch(principal, pubB.publicationId)).rejects.toBeInstanceOf(CandidateNotFoundError);
    expect(() => facadeA.resume(principal, pubB.publicationId)).toThrow(CandidateNotFoundError);
    await expect(facadeA.dispatch(principal, "wholly-unknown-publication-id")).rejects.toBeInstanceOf(CandidateNotFoundError);
  });

  // ------------------------------------------------------------------------
  // Assertion 5: FAIL-CLOSED (default install) — no provisioned approver ⇒ 403,
  // nothing published; required attestation with no resultTreeHash ⇒ fail closed.
  // ------------------------------------------------------------------------
  test("5a. FAIL-CLOSED: a single install (no provisioned approver) cannot self-approve — 403, no approval, no attestation, no publication", async () => {
    const h = await makeHarness();
    const { singleInstallPrincipal, seed } = h;
    // The single install owns the seeded graph (same ownerId) but has NO approver.
    expect(singleInstallPrincipal.ownerId).toBe(h.principal.ownerId);
    expect(singleInstallPrincipal.approverId ?? null).toBeNull();
    const facade = h.makeFacade({ principal: singleInstallPrincipal });
    await facade.selectCandidate(singleInstallPrincipal, seed.runId, { checkpointId: seed.checkpointId });
    expect(() => facade.approve(singleInstallPrincipal, seed.checkpointId, { checkpointHash: seed.checkpointHash, decision: "APPROVE", policyVersion: POLICY }))
      .toThrow(PublicationApproverNotProvisionedError);
    const db = readerDb(h.dbPath);
    expect((db.query("SELECT COUNT(*) n FROM publication_approvals_v33").get() as { n: number }).n).toBe(0);
    expect((db.query("SELECT COUNT(*) n FROM provenance_attestations").get() as { n: number }).n).toBe(0);
    expect((db.query("SELECT COUNT(*) n FROM approval_decisions").get() as { n: number }).n).toBe(0);
  });

  test("5b. FAIL-CLOSED: REQUIRED attestation with no sourceable resultTreeHash fails closed — no approval, no attestation, no unattested publish", async () => {
    const h = await makeHarness();
    const { principal, seed } = h;
    // A properly provisioned approver, but the resultTreeHash cannot be sourced
    // (production's default posture: resultTreeHashFor → null).
    const facade = h.makeFacade({ resultTreeHashFor: () => null });
    await facade.selectCandidate(principal, seed.runId, { checkpointId: seed.checkpointId });
    expect(() => facade.approve(principal, seed.checkpointId, { checkpointHash: seed.checkpointHash, decision: "APPROVE", policyVersion: POLICY }))
      .toThrow(PublicationAttestationUnavailableError);
    const db = readerDb(h.dbPath);
    // Fail closed BEFORE any P8 approval row is written (feasibility checked first).
    expect((db.query("SELECT COUNT(*) n FROM publication_approvals_v33").get() as { n: number }).n).toBe(0);
    expect((db.query("SELECT COUNT(*) n FROM provenance_attestations").get() as { n: number }).n).toBe(0);
    // No live approval ⇒ nothing to publish.
    expect((db.query("SELECT COUNT(*) n FROM publication_git_operations_v33").get() as { n: number }).n).toBe(0);
  });
});
