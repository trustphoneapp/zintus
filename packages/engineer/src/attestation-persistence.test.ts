import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { ENGINEER_DATABASE_SCHEMA_SQL, ENGINEER_DEFAULT_ORG_ID } from "./database-schema.js";
import { migrateEngineerDatabase } from "./database-migrations.js";
import { canonicalJson, sha256 } from "./hash.js";
import { EngineerLedger } from "./ledger.js";
import {
  createHmacProvenanceSigner,
  DsseEnvelopeSchema,
  verifyProvenanceAttestation,
} from "./attestation.js";
import { exportAuditChain, type AuditEntry } from "./audit-export.js";
import {
  createVerifiedCandidateCheckpoint,
  type CheckpointAttestor,
  type VerifiedCandidateCheckpointInput,
} from "./index.js";

const NOW = "2026-07-19T00:00:00.000Z";
const DECIDED_AT = "2026-07-19T00:05:00.000Z";
const DEADLINE = "2026-07-20T00:00:00.000Z";
const ORG = "org-tenant-a";
const SECRET = "provenance-hmac-secret-32bytes!!!";
const KEY_ID = "engineer-provenance-key-1";
const REQUESTER = "requester-user";
const APPROVER = "approver-human";
const hash = (value: string): string => sha256(value);

const checkpointAttestor: CheckpointAttestor = {
  algorithm: "test-sha256", keyId: "checkpoint-test-key",
  sign: (payload) => `test:${sha256(payload)}`,
  verify: (payload, signature) => signature === `test:${sha256(payload)}`,
};

function legacyInput(runId: string): VerifiedCandidateCheckpointInput {
  const claim = {
    inputHash: hash("builder-input"), agentExecutionId: "builder-1", modelTier: "GPT-5.6_TERRA" as const,
    workerOwnerId: null, workerFencingToken: null, status: "SUCCEEDED" as const,
    outputArtifactId: "builder-output", startedAt: NOW, completedAt: "2026-07-19T00:01:00.000Z",
    outputArtifactAuthority: {
      artifactId: "builder-output", sha256: hash("builder-output"), sizeBytes: 1,
      createdAt: "2026-07-19T00:01:00.000Z", type: "BUILDER_RESULT" as const,
      producerType: "SYSTEM" as const, producerId: "builder", trusted: false as const,
      regularFile: true as const, symbolicLink: false as const,
    },
  };
  return {
    schemaVersion: 1, policyVersion: "verified-candidate-checkpoint-v1", parentCheckpointId: null,
    runId, requesterUserId: REQUESTER, repositoryId: "repo",
    requiredLaneContractHash: hash("contract"), manifestHash: hash("manifest"),
    baseCommitSha: "a".repeat(40), resultCommitSha: "b".repeat(40), diffHash: hash("diff"),
    reviewerSessionId: "reviewer", classificationHash: hash("classification"), classificationResult: "READY",
    evidenceBundleId: "bundle", evidenceBundleHash: hash("bundle"),
    claimSummary: { claimIds: ["claim"], claimSetHash: hash("claim-set") },
    verificationSummary: { verificationPass: 1, testExecutionIds: ["test-a", "test-b"], testExecutionSetHash: hash("tests"),
      provenanceEventIds: ["event"], provenanceHash: hash("events"), allRequiredChecksPassed: true },
    securitySummary: { findingIds: [], findingSetHash: hash("findings"), openBlockingCriticalCount: 0 },
    scopeSummary: { artifactId: "scope", artifactHash: hash("scope"), policyVersion: "final-change-scope-v1" },
    environmentDigest: hash("environment"),
    builderDispatchSummary: { claims: [claim], claimSetHash: sha256([claim]) },
    prePromotionEventChainSummary: { eventCount: 1, headEventId: "reviewing", headSequence: 1,
      headStateVersion: 1, chainHash: hash("chain") },
    createdAt: "2026-07-19T00:02:00.000Z",
  };
}

// Guard triggers that enforce the approval-authority bindings (their own tests
// cover those invariants). We drop them so the fixture can seed a persisted
// checkpoint + a PENDING approval request DIRECTLY and exercise the P11
// emission/persistence/atomicity seam in isolation.
const AUTHORITY_GUARDS = [
  "require_verified_candidate_checkpoint_bindings_v21",
  "require_approval_checkpoint_pair_v21", "require_approval_checkpoint_match_v21",
  "require_new_approval_checkpoint_v22", "require_approval_selection_v23",
  "require_new_approval_decision_checkpoint_v22", "require_approval_decision_checkpoint_match_v22",
];

interface Fixture {
  root: string;
  ledger: EngineerLedger;
  seed: Database;
  runId: string;
  checkpointId: string;
  checkpointHash: string;
  approvalRequestId: string;
  approvalDecisionId: string;
}

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

async function approvableFixture(options: { withRoles?: boolean; withSigner?: boolean } = {}): Promise<Fixture> {
  const withRoles = options.withRoles ?? true;
  const withSigner = options.withSigner ?? true;
  const root = mkdtempSync(join(tmpdir(), "zintus-engineer-p11-persist-"));
  const dbPath = join(root, "engineer.sqlite");
  const ledger = new EngineerLedger(dbPath, () => new Date(DECIDED_AT));
  if (withSigner) ledger.configureProvenanceAttestationSigner(SECRET, KEY_ID);
  cleanups.push(() => { try { ledger.close(); } catch { /* already closed */ } rmSync(root, { recursive: true, force: true }); });

  const runId = "run-approve";
  const { checkpoint } = await createVerifiedCandidateCheckpoint(legacyInput(runId), checkpointAttestor);

  // Seed the durable supporting records directly with FK enforcement off (their
  // own tables' bindings are covered elsewhere); the P11 provenance FK to
  // verified_candidate_checkpoints / approval_decisions / orgs is still enforced
  // on the ledger's own connection when decideApproval writes.
  const seed = new Database(dbPath);
  seed.exec("PRAGMA foreign_keys=OFF");
  for (const trigger of AUTHORITY_GUARDS) seed.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
  // A distinct (non-default) tenant org so org-scoping is meaningfully exercised.
  seed.query("INSERT INTO orgs(id,display_name,default_retention_class,status,created_at,updated_at) VALUES (?,?,?,?,?,?)")
    .run(ORG, "Tenant A", "STANDARD", "ACTIVE", NOW, NOW);
  seed.query("INSERT INTO users(id,email,created_at,updated_at) VALUES (?,?,?,?)").run(REQUESTER, null, NOW, NOW);
  seed.query("INSERT INTO repository_connections(id,user_id,provider,owner,name,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
    .run("repo", REQUESTER, "local", "o", "n", NOW, NOW);
  seed.query(
    "INSERT INTO engineer_runs(id,user_id,repository_id,base_branch,base_commit_sha,request_original," +
      "request_normalized,state,state_version,risk_tier,human_gate_required,created_at,updated_at)" +
      " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(runId, REQUESTER, "repo", "main", "a".repeat(40), "req", "req", "REVIEW_APPROVED", 1, "HIGH", 1, NOW, NOW);
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
    checkpoint.environmentDigest, canonicalJson(checkpoint), "{}", hash("cp-statement"),
    checkpointAttestor.algorithm, checkpointAttestor.keyId, "sig", checkpoint.createdAt, ORG,
  );
  if (withRoles) {
    seed.query("INSERT INTO agent_executions(id,run_id,role,model_tier,status,started_at,completed_at,org_id) VALUES (?,?,?,?,?,?,?,?)")
      .run("reviewer-1", runId, "REVIEWER", "GPT-5.6_TERRA", "SUCCEEDED", NOW, NOW, ORG);
    seed.query("INSERT INTO agent_executions(id,run_id,role,model_tier,status,started_at,completed_at,org_id) VALUES (?,?,?,?,?,?,?,?)")
      .run("builder-1", runId, "BUILDER", "GPT-5.6_TERRA", "SUCCEEDED", NOW, NOW, ORG);
  }
  seed.query(
    "INSERT INTO run_budgets(run_id,cost_limit_usd,token_limit,time_limit_seconds,lifetime_cost_limit_usd," +
      "lifetime_token_limit,lifetime_time_limit_seconds,used_cost_usd,used_tokens,used_time_seconds,status," +
      "created_at,updated_at,org_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(runId, 10, 100000, 3600, 10, 100000, 3600, 0.125, 6789, 42, "ACTIVE", NOW, NOW, ORG);

  const approvalRequestId = "approval-1";
  seed.query(
    "INSERT INTO approval_requests(id,run_id,risk_tier,assigned_reviewer_id,requested_at,deadline_at," +
      "reminder_schedule_json,timeout_action,manifest_hash,diff_hash,evidence_bundle_hash,status," +
      "reviewer_session_id,classification_hash,classification_result,verified_checkpoint_id," +
      "verified_checkpoint_hash,approval_revision,org_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    approvalRequestId, runId, "HIGH", null, NOW, DEADLINE, "[]", "REJECT",
    checkpoint.manifestHash, checkpoint.diffHash, checkpoint.evidenceBundleHash, "PENDING",
    checkpoint.reviewerSessionId, checkpoint.classificationHash, checkpoint.classificationResult,
    checkpoint.checkpointId, checkpoint.checkpointHash, 0, ORG,
  );
  seed.close();

  return {
    root, ledger, seed, runId,
    checkpointId: checkpoint.checkpointId, checkpointHash: checkpoint.checkpointHash,
    approvalRequestId, approvalDecisionId: "decision-1",
  };
}

function decisionRecord(fixture: Fixture, actorId = APPROVER) {
  return {
    approvalDecisionId: fixture.approvalDecisionId, approvalRequestId: fixture.approvalRequestId,
    actorId, decision: "APPROVE" as const, reason: "Verified evidence reviewed.", decidedAt: DECIDED_AT,
    expectedApprovalRevision: 0, expectedVerifiedCheckpointId: fixture.checkpointId,
    expectedVerifiedCheckpointHash: fixture.checkpointHash,
  };
}

function readerDb(fixture: Fixture): Database {
  const db = new Database(join(fixture.root, "engineer.sqlite"));
  cleanups.push(() => db.close());
  return db;
}

describe("P11 v35 forward-install on a populated v34 database", () => {
  test("every pre-v35 row is readable, foreign_key_check clean, head advances to 35", () => {
    const now = NOW;
    const db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys=OFF");
    db.exec(ENGINEER_DATABASE_SCHEMA_SQL);
    db.query("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(14, now);
    migrateEngineerDatabase(db, now, 34);
    expect((db.query("SELECT MAX(version) v FROM schema_migrations").get() as { v: number }).v).toBe(34);

    // Populate a v34 row before the forward-install.
    db.query("INSERT INTO users(id,email,created_at,updated_at) VALUES (?,?,?,?)").run("u-legacy", null, now, now);
    db.query("INSERT INTO repository_connections(id,user_id,provider,owner,name,created_at,updated_at,org_id) VALUES (?,?,?,?,?,?,?,?)")
      .run("r-legacy", "u-legacy", "local", "o", "n", now, now, ENGINEER_DEFAULT_ORG_ID);

    // Forward-install v35 onto the populated v34 DB.
    migrateEngineerDatabase(db, now);
    expect((db.query("SELECT MAX(version) v FROM schema_migrations").get() as { v: number }).v).toBe(35);

    // Prior rows survive unchanged and remain readable.
    expect(db.query("SELECT id,user_id FROM repository_connections WHERE id='r-legacy'").get())
      .toEqual({ id: "r-legacy", user_id: "u-legacy" });
    expect(db.query("PRAGMA foreign_key_check").all().length).toBe(0);
    // The v35 store exists and is empty.
    expect(db.query("SELECT COUNT(*) n FROM provenance_attestations").get()).toEqual({ n: 0 });
    // Ancestry: a recorded v35 without its v34 predecessor is rejected.
    const gap = new Database(":memory:");
    gap.exec("PRAGMA foreign_keys=OFF");
    gap.exec(ENGINEER_DATABASE_SCHEMA_SQL);
    for (const v of [14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 35]) {
      gap.query("INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)").run(v, now);
    }
    expect(() => migrateEngineerDatabase(gap, now)).toThrow(/v35 is missing required migration ancestry/);
    db.close();
    gap.close();
  });
});

describe("P11 durable APPROVE atomically emits + persists a verifiable attestation", () => {
  test("a real APPROVE persists an org-scoped attestation an independent verifier accepts", async () => {
    const fixture = await approvableFixture();
    fixture.ledger.decideApproval(decisionRecord(fixture), "APPROVED", DECIDED_AT, { resultTreeHash: hash("tree") });

    const db = readerDb(fixture);
    const row = db.query("SELECT * FROM provenance_attestations").get() as {
      org_id: string; subject_checkpoint_id: string; approval_decision_id: string; approver_actor_id: string;
      signature_key_id: string; statement_hash: string; envelope_json: string; created_at: string;
    };
    expect(row).toBeTruthy();
    // Org-scoped to the subject checkpoint's tenancy (v34), 1:1 with the approval.
    expect(row.org_id).toBe(ORG);
    expect(row.subject_checkpoint_id).toBe(fixture.checkpointId);
    expect(row.approval_decision_id).toBe(fixture.approvalDecisionId);
    expect(row.approver_actor_id).toBe(APPROVER);
    expect(row.signature_key_id).toBe(KEY_ID);

    // An independent verifier (same gateway-held secret) validates the stored envelope.
    const envelope = DsseEnvelopeSchema.parse(JSON.parse(row.envelope_json));
    const verifier = createHmacProvenanceSigner({ secret: SECRET, keyId: KEY_ID });
    const result = await verifyProvenanceAttestation(envelope, verifier);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.statement.predicate.identities.approverUserId).toBe(APPROVER);
      expect(result.statement.predicate.identities.requesterUserId).toBe(REQUESTER);
      // Fields came from the REAL seeded rows, not the caller.
      expect(result.statement.predicate.roles.map((r) => r.role)).toEqual(["BUILDER", "REVIEWER"]);
      expect(result.statement.predicate.budget).toEqual({ costMicrousd: 125_000, tokensConsumed: 6789, activeSeconds: 42 });
    }

    // The attestation appears in the tenant-scoped audit export chain.
    const entries: AuditEntry[] = [
      { kind: "EVENT", id: "e1", sequence: 1, tenantId: row.org_id, runId: fixture.runId, recordedAt: NOW,
        payload: { action: "HUMAN_APPROVE" } },
      { kind: "ATTESTATION", id: row.statement_hash, sequence: 2, tenantId: row.org_id, runId: fixture.runId,
        recordedAt: row.created_at, payload: { statementHash: row.statement_hash, keyId: row.signature_key_id } },
    ];
    const auditExport = exportAuditChain({ tenantId: ORG, runId: fixture.runId, entries, pageSize: 10 });
    const flattened = auditExport.pages.flatMap((page) => page.entries);
    const attestationEntry = flattened.find((entry) => entry.kind === "ATTESTATION");
    expect(attestationEntry?.tenantId).toBe(ORG);
    expect(attestationEntry?.id).toBe(row.statement_hash);
  });

  test("approver == requester is rejected and NOTHING is persisted (fail closed)", async () => {
    const fixture = await approvableFixture();
    expect(() =>
      fixture.ledger.decideApproval(decisionRecord(fixture, REQUESTER), "APPROVED", DECIDED_AT, { resultTreeHash: hash("tree") }),
    ).toThrow(/approver must differ/);
    const db = readerDb(fixture);
    expect(db.query("SELECT COUNT(*) n FROM approval_decisions").get()).toEqual({ n: 0 });
    expect(db.query("SELECT COUNT(*) n FROM provenance_attestations").get()).toEqual({ n: 0 });
  });

  test("a configured signer with NO resultTreeHash seam fails closed (no silent approval)", async () => {
    const fixture = await approvableFixture();
    expect(() => fixture.ledger.decideApproval(decisionRecord(fixture), "APPROVED", DECIDED_AT))
      .toThrow(/resultTreeHash seam was not supplied/);
    const db = readerDb(fixture);
    expect(db.query("SELECT COUNT(*) n FROM approval_decisions").get()).toEqual({ n: 0 });
    expect(db.query("SELECT COUNT(*) n FROM provenance_attestations").get()).toEqual({ n: 0 });
  });
});

describe("P11 attestation store is immutable and its writes are atomic with the approval", () => {
  test("a persisted attestation cannot be UPDATEd or DELETEd", async () => {
    const fixture = await approvableFixture();
    fixture.ledger.decideApproval(decisionRecord(fixture), "APPROVED", DECIDED_AT, { resultTreeHash: hash("tree") });
    const db = readerDb(fixture);
    expect(() => db.query("UPDATE provenance_attestations SET approver_actor_id='x'").run()).toThrow(/immutable/);
    expect(() => db.query("DELETE FROM provenance_attestations").run()).toThrow(/immutable/);
    expect(db.query("SELECT COUNT(*) n FROM provenance_attestations").get()).toEqual({ n: 1 });
  });

  test("emission failure rolls back the approval too — NEITHER row is left behind", async () => {
    // No agent_executions => the predicate's `roles` (min 1) fails at build time,
    // so the attestation cannot be produced. Because the emit+persist runs INSIDE
    // decideApproval's transaction, the approval decision must roll back with it.
    const fixture = await approvableFixture({ withRoles: false });
    expect(() =>
      fixture.ledger.decideApproval(decisionRecord(fixture), "APPROVED", DECIDED_AT, { resultTreeHash: hash("tree") }),
    ).toThrow();
    const db = readerDb(fixture);
    expect(db.query("SELECT COUNT(*) n FROM approval_decisions").get()).toEqual({ n: 0 });
    expect(db.query("SELECT COUNT(*) n FROM provenance_attestations").get()).toEqual({ n: 0 });
    // The approval request is untouched (still PENDING) — the whole unit rolled back.
    expect(db.query("SELECT status,approval_revision FROM approval_requests WHERE id=?").get(fixture.approvalRequestId))
      .toEqual({ status: "PENDING", approval_revision: 0 });
  });

  test("with no signer configured, APPROVE still succeeds but emits no attestation (documented seam)", async () => {
    const fixture = await approvableFixture({ withSigner: false });
    fixture.ledger.decideApproval(decisionRecord(fixture), "APPROVED", DECIDED_AT, { resultTreeHash: hash("tree") });
    const db = readerDb(fixture);
    expect(db.query("SELECT COUNT(*) n FROM approval_decisions").get()).toEqual({ n: 1 });
    expect(db.query("SELECT COUNT(*) n FROM provenance_attestations").get()).toEqual({ n: 0 });
  });
});
