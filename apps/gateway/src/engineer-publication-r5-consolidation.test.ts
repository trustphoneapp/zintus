/**
 * R5E — R5 PUBLICATION CONSOLIDATION PROOF SUITE (adversarial capstone).
 *
 * R5A/B/C/D landed the consolidation onto P8: legacy EngineerPublicationManager
 * retired from new-run paths, GitPublicationMechanics extracted under P8, the P8
 * approval + attestation made atomic, audit-export routed to the real DAL. This
 * suite is the gate that earns "R5 done": each of the six DANGEROUS properties is
 * PROVEN ABSENT by a DRIVEN test over the REAL engine (a migrated DB + the real
 * supervisor, ledger, P8 PublicationAuthorityService, gateway facade, real
 * GitPublicationMechanics, real audit-export DAL). Every test is written so it
 * goes RED if the property were violated — not asserted by green counts.
 *
 * The ONLY sanctioned test-seam injections (same as the joint integration gate):
 *   1. a SEPARATELY provisioned approver secret (production ceremony is [HUMAN]);
 *   2. a `resultTreeHashFor` fake returning a valid sha256 (prod wires () => null);
 *   3. a fake GitService / actuator standing in for the credentialed GitHub effect.
 * The units under test — facade, service, ledger, attestation, GitPublicationMechanics,
 * audit export — are REAL. Authority-binding TRIGGERS (v21/v22/v23/v31) are dropped
 * ONLY to seed durable fixture rows directly; every seam under test runs real.
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
  ENGINEER_DEFAULT_ORG_ID,
  PUBLICATION_AUTHORITY_POLICY_VERSION,
  PublicationAuthorityService,
  GitPublicationMechanics,
  PreflightMismatchError,
  ApprovalAuthorityInvalidError,
  type CheckpointAttestor,
  type VerifiedCandidateCheckpointInput,
  type ActuatorOutcome,
  type PublicationActuator,
  type GitService,
  type BaseBranchStatus,
  type PullRequestResult,
  type BranchResult,
  type PushResult,
  type PublicationOperationReconciliation,
  type RepositoryReference,
} from "@zintus/engineer";
import { EngineerRunManager } from "./engineer.js";
import { deriveEngineerPrincipal, type EngineerPrincipal } from "./engineer-identity.js";
import {
  createEngineerPublicationAuthorityFacade,
  type PublicationFacadeDeps,
} from "./engineer-publication-facade.js";

const NOW = "2026-07-19T00:00:00.000Z";
const AT = "2026-07-19T12:00:00.000Z";
const DEADLINE = "2026-07-20T00:00:00.000Z";
const POLICY = PUBLICATION_AUTHORITY_POLICY_VERSION;
const INJECTED_RESULT_TREE_HASH = `sha256:${"a".repeat(64)}`;
const BASE_X = "a".repeat(40); // the run's recorded base commit (what an approval binds)
const BASE_Y = "f".repeat(40); // a MOVED base — a different remote head
const hx = (seed: string): string => sha256(seed);

const checkpointAttestor: CheckpointAttestor = {
  algorithm: "test-sha256",
  keyId: "checkpoint-test-key",
  sign: (payload) => `test:${sha256(payload)}`,
  verify: (payload, signature) => signature === `test:${sha256(payload)}`,
};

const AUTHORITY_GUARDS = [
  "require_verified_candidate_checkpoint_bindings_v21",
  "require_approval_checkpoint_pair_v21",
  "require_approval_checkpoint_match_v21",
  "require_new_approval_checkpoint_v22",
  "require_approval_selection_v23",
  "require_new_approval_decision_checkpoint_v22",
  "require_approval_decision_checkpoint_match_v22",
];

// Additional guards dropped ONLY when seeding a historical LEGACY-lane graph
// directly (property 2). Their invariants are covered by their own suites.
const LEGACY_GUARDS = [
  "require_git_checkpoint_pair_v21",
  "require_git_checkpoint_match_v21",
  "require_new_git_checkpoint_v22",
  "require_git_selection_v23",
  "freeze_source_run_state_event_v31",
  "freeze_source_approval_request_v31",
  "freeze_source_approval_decision_v31",
  "freeze_source_git_operation_v31",
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
    baseCommitSha: BASE_X, resultCommitSha: "b".repeat(40), diffHash: hx(`diff-${nonce}`),
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
  org: string; runId: string; repositoryId: string; ownerId: string; approverId: string;
  checkpointId: string; checkpointHash: string; resultCommitSha: string; approvalRequestId: string;
}

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
  ).run(opts.runId, opts.ownerId, opts.repositoryId, "main", BASE_X, "req", "req", "REVIEW_APPROVED", 1, "HIGH", 1, NOW, NOW, opts.org);
  insertCheckpointRow(seed, checkpoint, opts.org, opts.nonce);
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
    checkpointId: checkpoint.checkpointId, checkpointHash: checkpoint.checkpointHash,
    resultCommitSha: checkpoint.resultCommitSha, approvalRequestId,
  };
}

/** Insert an extra PROMOTED verified-candidate checkpoint for an existing run (a fresh candidate). */
async function seedExtraCheckpoint(dbPath: string, opts: { runId: string; ownerId: string; repositoryId: string; org: string; nonce: string }): Promise<{ checkpointId: string; checkpointHash: string; resultCommitSha: string }> {
  const { checkpoint } = await createVerifiedCandidateCheckpoint(
    checkpointInput(opts.runId, opts.ownerId, opts.repositoryId, opts.nonce), checkpointAttestor);
  const seed = new Database(dbPath);
  seed.exec("PRAGMA foreign_keys=OFF");
  for (const trigger of AUTHORITY_GUARDS) seed.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
  insertCheckpointRow(seed, checkpoint, opts.org, opts.nonce);
  seed.close();
  return { checkpointId: checkpoint.checkpointId, checkpointHash: checkpoint.checkpointHash, resultCommitSha: checkpoint.resultCommitSha };
}

function insertCheckpointRow(seed: Database, checkpoint: Awaited<ReturnType<typeof createVerifiedCandidateCheckpoint>>["checkpoint"], org: string, nonce: string): void {
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
    checkpoint.environmentDigest, canonicalJson(checkpoint), "{}", hx(`cp-statement-${nonce}`),
    checkpointAttestor.algorithm, checkpointAttestor.keyId, "sig", checkpoint.createdAt, org,
  );
}

interface LegacySeed {
  runId: string; org: string; ownerId: string; approvalRequestId: string; gitOperationId: string;
  checkpointId: string; prUrl: string;
}

/**
 * Seed a run that ALREADY completed the LEGACY EngineerPublicationManager lane
 * BEFORE the R5 cutover: run COMPLETED, run_state_events across the legacy
 * HUMAN_APPROVAL_PENDING → HUMAN_APPROVED → PR_CREATING → PR_CREATED → COMPLETED
 * transitions, an APPROVED approval_request + APPROVE decision, a SUCCEEDED
 * CREATE_PR git_operation with a remote reference, an evidence bundle, a claim,
 * an artifact, and the promoted checkpoint. Nothing is written through P8.
 */
async function seedLegacyRun(dbPath: string, opts: { org: string; runId: string; repositoryId: string; ownerId: string; nonce: string }): Promise<LegacySeed> {
  const { checkpoint } = await createVerifiedCandidateCheckpoint(
    checkpointInput(opts.runId, opts.ownerId, opts.repositoryId, opts.nonce), checkpointAttestor);
  const seed = new Database(dbPath);
  seed.exec("PRAGMA foreign_keys=OFF");
  for (const trigger of [...AUTHORITY_GUARDS, ...LEGACY_GUARDS]) seed.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
  seed.query("INSERT OR IGNORE INTO orgs(id,display_name,default_retention_class,status,created_at,updated_at) VALUES (?,?,?,?,?,?)")
    .run(opts.org, opts.org, "STANDARD", "ACTIVE", NOW, NOW);
  seed.query("INSERT OR IGNORE INTO users(id,email,created_at,updated_at) VALUES (?,?,?,?)").run(opts.ownerId, null, NOW, NOW);
  seed.query("INSERT INTO repository_connections(id,user_id,provider,owner,name,created_at,updated_at,org_id) VALUES (?,?,?,?,?,?,?,?)")
    .run(opts.repositoryId, opts.ownerId, "local", "o", opts.nonce, NOW, NOW, opts.org);
  seed.query(
    "INSERT INTO engineer_runs(id,user_id,repository_id,base_branch,base_commit_sha,request_original," +
      "request_normalized,state,state_version,risk_tier,human_gate_required,created_at,updated_at,terminal_at,org_id)" +
      " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(opts.runId, opts.ownerId, opts.repositoryId, "main", BASE_X, "old change", "old change", "COMPLETED", 22, "MEDIUM", 1, NOW, NOW, NOW, opts.org);
  insertCheckpointRow(seed, checkpoint, opts.org, opts.nonce);
  // Legacy run-state history (the exact lane a legacy run walked).
  const legacyStates: Array<[string, string, string]> = [
    ["REVIEW_APPROVED", "HUMAN_APPROVAL_PENDING", "HUMAN_APPROVAL_REQUESTED"],
    ["HUMAN_APPROVAL_PENDING", "HUMAN_APPROVED", "HUMAN_APPROVAL_VALIDATED"],
    ["HUMAN_APPROVED", "PR_PREFLIGHT", "PUBLICATION_PREFLIGHT_PASSED"],
    ["PR_PREFLIGHT", "PR_CREATING", "SUPERVISOR_PR_COMMAND_AUTHORIZED"],
    ["PR_CREATING", "PR_CREATED", "PULL_REQUEST_CREATED"],
    ["PR_CREATED", "COMPLETED", "ENGINEER_RUN_COMPLETED"],
  ];
  legacyStates.forEach(([prev, next, reason], index) => {
    seed.query(
      "INSERT INTO run_state_events(event_id,run_id,sequence,previous_state,next_state,reason_code,actor_type," +
        "actor_id,timestamp,evidence_ids_json,manifest_hash,state_version,idempotency_key,org_id)" +
        " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(`evt-${opts.nonce}-${index}`, opts.runId, index + 1, prev, next, reason, "HUMAN", "reviewer-legacy",
      NOW, "[]", checkpoint.manifestHash, index + 2, `legacy:${next}:${index}`, opts.org);
  });
  const approvalRequestId = `legacy-approval-${opts.nonce}`;
  seed.query(
    "INSERT INTO approval_requests(id,run_id,risk_tier,assigned_reviewer_id,requested_at,deadline_at," +
      "reminder_schedule_json,timeout_action,manifest_hash,diff_hash,evidence_bundle_hash,status," +
      "reviewer_session_id,classification_hash,classification_result,verified_checkpoint_id," +
      "verified_checkpoint_hash,approval_revision,org_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    approvalRequestId, opts.runId, "MEDIUM", "reviewer-legacy", NOW, DEADLINE, "[]", "REJECT",
    checkpoint.manifestHash, checkpoint.diffHash, checkpoint.evidenceBundleHash, "APPROVED",
    checkpoint.reviewerSessionId, checkpoint.classificationHash, checkpoint.classificationResult,
    checkpoint.checkpointId, checkpoint.checkpointHash, 1, opts.org,
  );
  seed.query(
    "INSERT INTO approval_decisions(id,approval_request_id,actor_id,decision,reason,decided_at," +
      "expected_verified_checkpoint_id,expected_verified_checkpoint_hash,expected_approval_revision,org_id) VALUES (?,?,?,?,?,?,?,?,?,?)",
  ).run(`legacy-decision-${opts.nonce}`, approvalRequestId, "reviewer-legacy", "APPROVE", "looks good", NOW,
    checkpoint.checkpointId, checkpoint.checkpointHash, 0, opts.org);
  const gitOperationId = `legacy-gitop-${opts.nonce}`;
  const prUrl = "https://github.test/legacy/pull/7";
  seed.query(
    "INSERT INTO git_operations(id,run_id,operation_type,requested_by,idempotency_key,expected_base_commit_sha," +
      "result_commit_sha,approval_id,evidence_bundle_hash,status,remote_reference,started_at,completed_at,error_code," +
      "verified_checkpoint_id,verified_checkpoint_hash,org_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(gitOperationId, opts.runId, "CREATE_PR", "SUPERVISOR", `pr:create:${opts.runId}`, BASE_X,
    checkpoint.resultCommitSha, approvalRequestId, checkpoint.evidenceBundleHash, "SUCCEEDED", prUrl, NOW, NOW, null,
    checkpoint.checkpointId, checkpoint.checkpointHash, opts.org);
  const bundleJson = JSON.stringify({
    bundleVersion: 1, runId: opts.runId, manifestHash: checkpoint.manifestHash,
    baseCommitSha: BASE_X, resultCommitSha: checkpoint.resultCommitSha, environmentDigest: checkpoint.environmentDigest,
    artifacts: [], claims: [], finalDecision: "PROMOTE", createdAt: NOW,
  });
  seed.query(
    "INSERT INTO evidence_bundles(id,run_id,manifest_hash,bundle_hash,base_commit_sha,result_commit_sha," +
      "environment_digest,manifest_json,final_decision,created_at,org_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
  ).run(checkpoint.evidenceBundleId, opts.runId, checkpoint.manifestHash, checkpoint.evidenceBundleHash, BASE_X,
    checkpoint.resultCommitSha, checkpoint.environmentDigest, bundleJson, "PROMOTE", NOW, opts.org);
  seed.query(
    "INSERT INTO claim_evidence(id,run_id,criterion_id,claim,status,evidence_ids_json,notes,created_at,org_id) VALUES (?,?,?,?,?,?,?,?,?)",
  ).run(`legacy-claim-${opts.nonce}`, opts.runId, "crit-1", "the fix works", "VERIFIED", '["legacy-evidence-1"]', "", NOW, opts.org);
  seed.query(
    "INSERT INTO artifacts(id,run_id,type,sha256,producer_type,producer_id,storage_reference,size_bytes,trusted,created_at,org_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
  ).run(`legacy-artifact-${opts.nonce}`, opts.runId, "FINAL_DIFF", hx(`diff-artifact-${opts.nonce}`), "SYSTEM",
    "engineer-supervisor", "/secret/ref", 10, 1, NOW, opts.org);
  seed.close();
  return { runId: opts.runId, org: opts.org, ownerId: opts.ownerId, approvalRequestId, gitOperationId, checkpointId: checkpoint.checkpointId, prUrl };
}

const repositoryRef = (repositoryId: string): RepositoryReference => ({
  repositoryId, provider: "local", owner: "local", name: "fixture", baseBranch: "main", baseCommitSha: BASE_X,
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

const INSTALL_SECRET = "r5-consolidation-install-secret";
const APPROVER_SECRET = "r5-consolidation-independent-approver-secret";
let idCounter = 0;
const nextId = (prefix: string): string => `${prefix}-${(idCounter += 1)}`;

const RECEIPT_ACTUATOR: PublicationActuator = {
  async createBranchPr(): Promise<ActuatorOutcome> { return { kind: "RECEIPT", prUrl: "https://github.test/pull/1", commitSha: "b".repeat(40) }; },
};
const ECHO_PREFLIGHT = { probe: (input: { repositoryId: string; baseCommitSha: string }) => ({ repositoryId: input.repositoryId, baseCommitSha: input.baseCommitSha }) };

interface Harness {
  supervisor: EngineerSupervisor;
  dbPath: string;
  principal: EngineerPrincipal;
  singleInstallPrincipal: EngineerPrincipal;
  seed: TenantSeed;
  buildService: (opts?: { actuator?: PublicationActuator; preflight?: { probe: (input: { repositoryId: string; baseCommitSha: string }) => { repositoryId: string; baseCommitSha: string } | Promise<{ repositoryId: string; baseCommitSha: string }> } }) => PublicationAuthorityService;
  buildFacade: (service: PublicationAuthorityService, opts?: { attestationRequired?: boolean; resultTreeHashFor?: () => string | null; decideApprove?: PublicationFacadeDeps["decideApprove"]; principal?: EngineerPrincipal; credentialAvailable?: boolean }) => ReturnType<typeof createEngineerPublicationAuthorityFacade>;
  readerDb: () => Database;
}

async function makeHarness(): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), "zintus-engineer-r5-"));
  const dbPath = join(root, "engineer.sqlite");
  const supervisor = new EngineerSupervisor({ dbPath, now: () => new Date(AT) });
  supervisor.configureProvenanceAttestationSigner("r5-provenance-signer-secret-32bytes-min!!", "engineer-provenance-key-r5");
  cleanups.push(() => { try { supervisor.close(); } catch { /* already closed */ } rmSync(root, { recursive: true, force: true }); });

  const principal = deriveEngineerPrincipal({ gatewayIdentitySecret: INSTALL_SECRET, approverIdentitySecret: APPROVER_SECRET });
  const singleInstallPrincipal = deriveEngineerPrincipal({ gatewayIdentitySecret: INSTALL_SECRET });

  const seed = await seedTenant(dbPath, {
    org: ENGINEER_DEFAULT_ORG_ID, runId: "run-a", repositoryId: "repo-a", ownerId: principal.ownerId,
    approverId: principal.approverId as string, nonce: "a",
  });

  const buildService: Harness["buildService"] = (opts = {}) =>
    supervisor.createPublicationAuthorityService({
      actuator: opts.actuator ?? RECEIPT_ACTUATOR,
      preflight: opts.preflight ?? ECHO_PREFLIGHT,
      credentialProvider: { getPublicationCredentials: () => ({ token: "ghp_r5" }) },
      now: () => new Date(AT),
      idFactory: () => nextId("pub"),
    });

  const buildFacade: Harness["buildFacade"] = (service, opts = {}) => {
    const deps: PublicationFacadeDeps = {
      service,
      principal: opts.principal ?? principal,
      connection: supervisor.resolutionDeskConnection(),
      now: () => new Date(AT),
      credentialAvailable: opts.credentialAvailable ?? true,
      attestationRequired: opts.attestationRequired ?? false,
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
      decideApprove: opts.decideApprove ?? ((record, provenanceContext) => {
        supervisor.decideApproval(record as never, "APPROVED", provenanceContext);
      }),
      resultTreeHashFor: opts.resultTreeHashFor ?? (() => INJECTED_RESULT_TREE_HASH),
    };
    return createEngineerPublicationAuthorityFacade(deps);
  };

  const readerDb = (): Database => { const db = new Database(dbPath); cleanups.push(() => db.close()); return db; };

  return { supervisor, dbPath, principal, singleInstallPrincipal, seed, buildService, buildFacade, readerDb };
}

/**
 * A configurable, PR-COUNTING fake GitService. `createPullRequest` calls are
 * counted so the "at most one PR per publication identity" invariant is asserted
 * DIRECTLY, driven through the REAL GitPublicationMechanics effect layer.
 */
class CountingGitService implements GitService {
  createPullRequestCalls = 0;
  currentBaseSha = BASE_X;
  protectionEnforced = true;
  createPullRequestBehavior: "SUCCEED" | "THROW" = "SUCCEED";
  reconcileResult: PublicationOperationReconciliation = { status: "NOT_FOUND", detail: "no PR found" };

  async createRunBranch(): Promise<BranchResult> { return { branchName: "zintus/run", remoteReference: "refs/heads/zintus/run" }; }
  async pushVerifiedCommit(): Promise<PushResult> { return { remoteReference: "refs/heads/zintus/run" }; }
  async createPullRequest(): Promise<PullRequestResult> {
    this.createPullRequestCalls += 1;
    if (this.createPullRequestBehavior === "THROW") throw new Error("createPullRequest failed (remote outcome unknown)");
    return { id: "pr-1", number: 1, url: "https://github.test/pull/1" };
  }
  async inspectBaseBranch(input: { expectedBaseCommitSha: string }): Promise<BaseBranchStatus> {
    return {
      currentCommitSha: this.currentBaseSha,
      matchesExpected: this.currentBaseSha === input.expectedBaseCommitSha,
      protectionEnforced: this.protectionEnforced,
    };
  }
  async reconcilePublicationOperation(): Promise<PublicationOperationReconciliation> { return this.reconcileResult; }
}

function makeMechanics(git: CountingGitService): GitPublicationMechanics {
  return new GitPublicationMechanics({
    gitService: git,
    resolveRepository: (repositoryId) => repositoryRef(repositoryId),
    resolvePublicationContext: (runId) => ({
      repository: repositoryRef("repo-a"),
      title: `publish ${runId}`,
      narrative: {
        requestNormalized: "change", requestOriginal: "change", riskTier: "HIGH",
        evidenceBundleHash: `sha256:${"e".repeat(64)}`, acceptanceCriteria: [{ statement: "works" }],
        diff: "--- a/x\n+++ b/x\n+change\n", claims: [{ status: "VERIFIED", claim: "the fix works" }],
      },
    }),
  });
}

describe("R5E — R5 publication consolidation proof suite", () => {
  // ========================================================================
  // PROPERTY 1 — ONE WRITER
  // ========================================================================
  test("1. ONE WRITER: a new run driven select→approve→publish→dispatch is written ONLY by P8; the legacy lane never fires (RED if legacy re-wired)", async () => {
    const h = await makeHarness();
    const { principal, seed } = h;
    const facade = h.buildFacade(h.buildService());

    // Drive the FULL P8 vertical over the real engine.
    await facade.selectCandidate(principal, seed.runId, { checkpointId: seed.checkpointId });
    const approval = facade.approve(principal, seed.checkpointId, {
      checkpointHash: seed.checkpointHash, decision: "APPROVE", policyVersion: POLICY,
    }) as { approvalId: string; status: string };
    expect(approval.status).toBe("APPROVED");
    const started = await facade.startPublication(principal, seed.runId, { approvalId: approval.approvalId }, "idem-onewriter") as { publicationId: string; state: string };
    const dispatched = await facade.dispatch(principal, started.publicationId) as { state: string };
    expect(dispatched.state).toBe("RECEIPTED");

    const db = h.readerDb();
    // P8 is the SOLE writer of publication/approval state: everything lives in the
    // v33 tables, and the run's engine state was NEVER advanced into the legacy
    // publication lane (it stays REVIEW_APPROVED). If the legacy authority were
    // re-wired as a second writer, the run would be at HUMAN_APPROVAL_PENDING /
    // HUMAN_APPROVED / PR_CREATED / COMPLETED and legacy git_operations would exist.
    expect((db.query("SELECT state FROM engineer_runs WHERE id=?").get(seed.runId) as { state: string }).state).toBe("REVIEW_APPROVED");
    expect((db.query("SELECT COUNT(*) n FROM publication_git_operations_v33 WHERE run_id=? AND state='RECEIPTED'").get(seed.runId) as { n: number }).n).toBe(1);
    expect((db.query("SELECT COUNT(*) n FROM publication_approvals_v33 WHERE run_id=?").get(seed.runId) as { n: number }).n).toBeGreaterThan(0);
    // NO legacy publication writes for this new run.
    expect((db.query("SELECT COUNT(*) n FROM git_operations WHERE run_id=?").get(seed.runId) as { n: number }).n).toBe(0);
    expect((db.query(
      "SELECT COUNT(*) n FROM run_state_events WHERE run_id=? AND next_state IN ('HUMAN_APPROVAL_PENDING','HUMAN_APPROVED','PR_PREFLIGHT','PR_CREATING','PR_CREATED')",
    ).get(seed.runId) as { n: number }).n).toBe(0);
    // No NEW legacy approval_request/decision was created by the P8 path (only the
    // seeded PENDING request exists, untouched — still PENDING, no decision rows).
    expect((db.query("SELECT COUNT(*) n FROM approval_decisions ad JOIN approval_requests ar ON ad.approval_request_id=ar.id WHERE ar.run_id=?").get(seed.runId) as { n: number }).n).toBe(0);

    // Companion RED trip: the single-writer invariant is directly observable at the
    // run manager. With NO legacy publication wired, REVIEW_APPROVED is stream-terminal
    // (P8 takes over). Re-wiring the legacy authority flips this to FALSE — a SECOND writer.
    const preflight = { assertRunAdmission: async () => undefined, repository: () => repositoryRef("repo-a") } as never;
    const p8Only = new EngineerRunManager({ supervisor: {} as never, principal, preflight });
    expect(p8Only.reviewApprovedEndsStream()).toBe(true);
    const legacyWired = new EngineerRunManager({
      supervisor: {} as never, principal, preflight,
      publication: { start: async () => ({ status: "AWAITING_APPROVAL" as const }) } as never,
    });
    expect(legacyWired.reviewApprovedEndsStream()).toBe(false);
  });

  // ========================================================================
  // PROPERTY 2 — HISTORICAL COMPATIBILITY
  // ========================================================================
  test("2. HISTORICAL COMPATIBILITY: a run that already went through the legacy lane still reads back its full history via the current read APIs AND the audit-export route", async () => {
    const h = await makeHarness();
    const legacy = await seedLegacyRun(h.dbPath, { org: ENGINEER_DEFAULT_ORG_ID, runId: "legacy-run", repositoryId: "repo-legacy", ownerId: h.principal.ownerId, nonce: "legacy" });

    // --- Current read APIs (supervisor ledger) — nothing about the retirement broke them.
    const approval = h.supervisor.latestApprovalRequest(legacy.runId);
    expect(approval?.approvalRequestId).toBe(legacy.approvalRequestId);
    expect(approval?.status).toBe("APPROVED");
    const decisions = h.supervisor.listApprovalDecisions(legacy.approvalRequestId);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.decision).toBe("APPROVE");
    const gitOps = h.supervisor.listGitOperations(legacy.runId);
    expect(gitOps).toHaveLength(1);
    expect(gitOps[0]?.operationType).toBe("CREATE_PR");
    expect(gitOps[0]?.status).toBe("SUCCEEDED");
    expect(gitOps[0]?.remoteReference).toBe(legacy.prUrl);
    const bundles = h.supervisor.listEvidenceBundles(legacy.runId);
    expect(bundles).toHaveLength(1);
    const claims = h.supervisor.listClaimEvidence(legacy.runId);
    expect(claims).toHaveLength(1);
    expect(claims[0]?.status).toBe("VERIFIED");
    const artifacts = h.supervisor.listArtifacts(legacy.runId);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.type).toBe("FINAL_DIFF");

    // --- Audit-export route (the REAL org-scoped DAL) still renders the legacy history.
    const dal = new TenantScopedLedgerDal(h.supervisor.resolutionDeskConnection(), { orgId: ENGINEER_DEFAULT_ORG_ID, actor: defineHumanActor("auditor") });
    const entries = dal.exportRunAuditChain(legacy.runId).pages.flatMap((page) => page.entries);
    // Every legacy run-state transition is present, incl. the legacy-lane HUMAN_APPROVAL_PENDING.
    const nextStates = entries.filter((e) => e.kind === "EVENT").map((e) => (e.payload as { nextState: string }).nextState);
    for (const expected of ["HUMAN_APPROVAL_PENDING", "HUMAN_APPROVED", "PR_CREATING", "PR_CREATED", "COMPLETED"]) {
      expect(nextStates).toContain(expected);
    }
    // The promoted checkpoint reads back as an ATTESTATION entry.
    expect(entries.some((e) => e.kind === "ATTESTATION" && e.id === legacy.checkpointId)).toBe(true);
    for (const entry of entries) expect(entry.tenantId).toBe(ENGINEER_DEFAULT_ORG_ID);
  });

  // ========================================================================
  // PROPERTY 3 — RESTART SAFETY
  // ========================================================================
  test("3. RESTART SAFETY: a durable DISPATCHED survives restart, ONLY P8 recovery runs (listResumablePublications→resume parks RECONCILING), the actuator is never re-invoked, and no legacy sweep double-acts", async () => {
    const h = await makeHarness();
    const { principal, seed } = h;
    // Crash window: an actuator whose remote call THROWS *after* dispatch committed
    // DISPATCHED. It counts every remote attempt so we can prove it is never re-run.
    let actuatorCalls = 0;
    const crashingActuator: PublicationActuator = {
      async createBranchPr(): Promise<ActuatorOutcome> { actuatorCalls += 1; throw new Error("process crashed mid-dispatch"); },
    };
    const facade = h.buildFacade(h.buildService({ actuator: crashingActuator }));
    await facade.selectCandidate(principal, seed.runId, { checkpointId: seed.checkpointId });
    const approval = facade.approve(principal, seed.checkpointId, { checkpointHash: seed.checkpointHash, decision: "APPROVE", policyVersion: POLICY }) as { approvalId: string };
    const started = await facade.startPublication(principal, seed.runId, { approvalId: approval.approvalId }, "idem-restart") as { publicationId: string };
    await expect(facade.dispatch(principal, started.publicationId)).rejects.toThrow("process crashed mid-dispatch");
    expect(actuatorCalls).toBe(1);

    const db = h.readerDb();
    expect((db.query("SELECT state FROM publication_git_operations_v33 WHERE publication_id=? ORDER BY revision DESC LIMIT 1").get(started.publicationId) as { state: string }).state).toBe("DISPATCHED");

    // RESTART: a fresh P8 service on a NEW connection to the SAME db file, mirroring
    // the gateway boot recovery loop in index.ts (listResumablePublications → resume).
    // Its actuator counts remote attempts — a legacy or P8 double-act would increment it.
    let restartActuatorCalls = 0;
    const restartDb = new Database(h.dbPath);
    cleanups.push(() => { try { restartDb.close(); } catch { /* already closed */ } });
    const service2 = new PublicationAuthorityService(restartDb, {
      actuator: { async createBranchPr(): Promise<ActuatorOutcome> { restartActuatorCalls += 1; throw new Error("must never be called on recovery"); } },
      preflight: ECHO_PREFLIGHT,
      credentialProvider: { getPublicationCredentials: () => ({ token: "ghp_r5" }) },
      now: () => new Date(AT), idFactory: () => nextId("pub-restart"),
    });
    // ONLY P8 recovery: the P8 service is the sole thing that enumerates resumable
    // publications. It finds exactly the durable DISPATCHED and parks it RECONCILING.
    expect(service2.listResumablePublications()).toEqual([started.publicationId]);
    expect(service2.resume(started.publicationId).state).toBe("RECONCILING");
    expect(restartActuatorCalls).toBe(0);
    expect(actuatorCalls).toBe(1); // the original actuator was never re-invoked either

    // Exactly one reconciliation record, requires_human; a repeated restart is idempotent.
    expect((db.query("SELECT COUNT(*) c, MAX(requires_human) h FROM publication_reconciliations_v33 WHERE publication_id=?").get(started.publicationId) as { c: number; h: number })).toEqual({ c: 1, h: 1 });
    service2.resume(started.publicationId);
    expect((db.query("SELECT COUNT(*) c FROM publication_reconciliations_v33 WHERE publication_id=?").get(started.publicationId) as { c: number }).c).toBe(1);
    // No legacy publication row was ever produced for this run — no legacy timer/sweep
    // fired a legacy publication action across the restart.
    expect((db.query("SELECT COUNT(*) n FROM git_operations WHERE run_id=?").get(seed.runId) as { n: number }).n).toBe(0);
  });

  // ========================================================================
  // PROPERTY 4 — BASE-RACE SAFETY (real GitPublicationMechanics preflight)
  // ========================================================================
  test("4. BASE-RACE SAFETY: after approval the base moves; the REAL GitPublicationMechanics preflight supersedes the approval (INVALIDATED), blocks the publish, a retry stays blocked, and a fresh selection+approval against the new base is required", async () => {
    const h = await makeHarness();
    const { principal, seed } = h;
    const git = new CountingGitService();
    git.currentBaseSha = BASE_X; // fresh at approval time
    const mechanics = makeMechanics(git);
    const service = h.buildService({ actuator: mechanics.createActuator(), preflight: mechanics.preflightProbe });
    const facade = h.buildFacade(service);

    await facade.selectCandidate(principal, seed.runId, { checkpointId: seed.checkpointId });
    const approval = facade.approve(principal, seed.checkpointId, { checkpointHash: seed.checkpointHash, decision: "APPROVE", policyVersion: POLICY }) as { approvalId: string };

    // BASE MOVES between approval and publish (a concurrent base change).
    git.currentBaseSha = BASE_Y;

    // startPublication's real preflight (branch-protection + base-SHA recheck) observes
    // the moved base → PREFLIGHT_MISMATCH; the approval is invalidated and the publish blocked.
    await expect(facade.startPublication(principal, seed.runId, { approvalId: approval.approvalId }, "idem-baserace")).rejects.toBeInstanceOf(PreflightMismatchError);

    const db = h.readerDb();
    expect((db.query("SELECT status FROM publication_approvals_v33 WHERE approval_id=? ORDER BY revision DESC LIMIT 1").get(approval.approvalId) as { status: string }).status).toBe("INVALIDATED");
    // NO publication was created (nothing published against the stale base), and NO PR effect ran.
    expect((db.query("SELECT COUNT(*) n FROM publication_git_operations_v33 WHERE run_id=?").get(seed.runId) as { n: number }).n).toBe(0);
    expect(git.createPullRequestCalls).toBe(0);

    // A RETRY with the same (now invalidated) approval stays blocked — even if the base returned.
    git.currentBaseSha = BASE_X;
    await expect(facade.startPublication(principal, seed.runId, { approvalId: approval.approvalId }, "idem-baserace-retry")).rejects.toBeInstanceOf(ApprovalAuthorityInvalidError);
    // The spent candidate cannot be re-approved (single live APPROVE per candidate) — a
    // FRESH SELECTION is structurally required, not a re-approve of the stale one.
    expect(() => facade.approve(principal, seed.checkpointId, { checkpointHash: seed.checkpointHash, decision: "APPROVE", policyVersion: POLICY })).toThrow(ApprovalAuthorityInvalidError);

    // A FRESH selection + approval against the (now-current) base is the ONLY path
    // forward — and it publishes cleanly. Seed a fresh promoted candidate for the run.
    const fresh = await seedExtraCheckpoint(h.dbPath, { runId: seed.runId, ownerId: principal.ownerId, repositoryId: seed.repositoryId, org: seed.org, nonce: "a-fresh" });
    await facade.selectCandidate(principal, seed.runId, { checkpointId: fresh.checkpointId });
    const freshApproval = facade.approve(principal, fresh.checkpointId, { checkpointHash: fresh.checkpointHash, decision: "APPROVE", policyVersion: POLICY }) as { approvalId: string; status: string };
    expect(freshApproval.status).toBe("APPROVED");
    const freshStarted = await facade.startPublication(principal, seed.runId, { approvalId: freshApproval.approvalId }, "idem-baserace-fresh") as { state: string };
    expect(freshStarted.state).toBe("PREFLIGHT");
  });

  // ========================================================================
  // PROPERTY 5 — NO DUPLICATE PRs (counting GitService through real mechanics)
  // ========================================================================
  test("5. NO DUPLICATE PRs: at most one createPullRequest per publication identity across re-dispatch, ambiguous-then-resume, and restart-mid-DISPATCHED", async () => {
    // --- Path A: re-dispatch after a RECEIPT — exactly one PR, the second dispatch conflicts.
    {
      const h = await makeHarness();
      const { principal, seed } = h;
      const git = new CountingGitService();
      const mechanics = makeMechanics(git);
      const facade = h.buildFacade(h.buildService({ actuator: mechanics.createActuator(), preflight: mechanics.preflightProbe }));
      await facade.selectCandidate(principal, seed.runId, { checkpointId: seed.checkpointId });
      const approval = facade.approve(principal, seed.checkpointId, { checkpointHash: seed.checkpointHash, decision: "APPROVE", policyVersion: POLICY }) as { approvalId: string };
      const started = await facade.startPublication(principal, seed.runId, { approvalId: approval.approvalId }, "idem-dupA") as { publicationId: string };
      expect((await facade.dispatch(principal, started.publicationId) as { state: string }).state).toBe("RECEIPTED");
      expect(git.createPullRequestCalls).toBe(1);
      // Re-dispatch the same publication — it is already RECEIPTED; no second PR.
      await expect(facade.dispatch(principal, started.publicationId)).rejects.toThrow();
      expect(git.createPullRequestCalls).toBe(1);
    }

    // --- Path B: ambiguous outcome, then resume — exactly one PR, resume never re-issues.
    {
      const h = await makeHarness();
      const { principal, seed } = h;
      const git = new CountingGitService();
      git.createPullRequestBehavior = "THROW"; // remote outcome unknown
      git.reconcileResult = { status: "NOT_FOUND", detail: "no PR discovered" };
      const mechanics = makeMechanics(git);
      const facade = h.buildFacade(h.buildService({ actuator: mechanics.createActuator(), preflight: mechanics.preflightProbe }));
      await facade.selectCandidate(principal, seed.runId, { checkpointId: seed.checkpointId });
      const approval = facade.approve(principal, seed.checkpointId, { checkpointHash: seed.checkpointHash, decision: "APPROVE", policyVersion: POLICY }) as { approvalId: string };
      const started = await facade.startPublication(principal, seed.runId, { approvalId: approval.approvalId }, "idem-dupB") as { publicationId: string };
      const parked = await facade.dispatch(principal, started.publicationId) as { state: string };
      expect(parked.state).toBe("RECONCILING");
      expect(git.createPullRequestCalls).toBe(1);
      // Resume the reconciling publication — the effect layer is NEVER driven again.
      expect((facade.resume(principal, started.publicationId) as { state: string }).state).toBe("RECONCILING");
      expect(git.createPullRequestCalls).toBe(1);
    }

    // --- Path C: restart mid-DISPATCHED — ZERO PRs on the recovery service; it reconciles.
    {
      const h = await makeHarness();
      const { principal, seed } = h;
      const crashingActuator: PublicationActuator = { async createBranchPr(): Promise<ActuatorOutcome> { throw new Error("crash mid-dispatch"); } };
      const facade = h.buildFacade(h.buildService({ actuator: crashingActuator }));
      await facade.selectCandidate(principal, seed.runId, { checkpointId: seed.checkpointId });
      const approval = facade.approve(principal, seed.checkpointId, { checkpointHash: seed.checkpointHash, decision: "APPROVE", policyVersion: POLICY }) as { approvalId: string };
      const started = await facade.startPublication(principal, seed.runId, { approvalId: approval.approvalId }, "idem-dupC") as { publicationId: string };
      await expect(facade.dispatch(principal, started.publicationId)).rejects.toThrow();
      // Restart with the REAL mechanics actuator over a counting GitService.
      const git = new CountingGitService();
      const mechanics = makeMechanics(git);
      const restartDb = new Database(h.dbPath);
      cleanups.push(() => { try { restartDb.close(); } catch { /* already closed */ } });
      const service2 = new PublicationAuthorityService(restartDb, {
        actuator: mechanics.createActuator(), preflight: mechanics.preflightProbe,
        credentialProvider: { getPublicationCredentials: () => ({ token: "ghp_r5" }) },
        now: () => new Date(AT), idFactory: () => nextId("pub-restartC"),
      });
      for (const id of service2.listResumablePublications()) service2.resume(id);
      expect(service2.getPublication(started.publicationId).state).toBe("RECONCILING");
      expect(git.createPullRequestCalls).toBe(0);
    }
  });

  // ========================================================================
  // PROPERTY 6 — ATOMICITY UNDER CRASH (R5C in the full flow)
  // ========================================================================
  test("6. ATOMICITY UNDER CRASH: a crash between the P8 approval INSERT and its required attestation leaves NEITHER — no consumable-approval-without-attestation ever reaches publish", async () => {
    const h = await makeHarness();
    const { principal, seed } = h;
    // Attestation REQUIRED; feasibility passes (PENDING request bound + resultTreeHash
    // sourceable) so the flow enters the ONE atomic transaction — but the attestation
    // write itself CRASHES after the P8 approval INSERT (the R5C window).
    let attestationAttempted = false;
    const facade = h.buildFacade(h.buildService(), {
      attestationRequired: true,
      decideApprove: () => { attestationAttempted = true; throw new Error("process crashed mid-attestation"); },
    });
    await facade.selectCandidate(principal, seed.runId, { checkpointId: seed.checkpointId });
    expect(() => facade.approve(principal, seed.checkpointId, { checkpointHash: seed.checkpointHash, decision: "APPROVE", policyVersion: POLICY })).toThrow(/fail-closed|attestation/i);
    expect(attestationAttempted).toBe(true);

    const db = h.readerDb();
    // ATOMIC ROLLBACK: NEITHER the P8 approval NOR the attestation persisted. If the two
    // writes were NOT atomic (separate txns / best-effort compensation), the approval INSERT
    // would survive the attestation crash → a consumable approval without attestation.
    expect((db.query("SELECT COUNT(*) n FROM publication_approvals_v33 WHERE run_id=?").get(seed.runId) as { n: number }).n).toBe(0);
    expect((db.query("SELECT COUNT(*) n FROM provenance_attestations").get() as { n: number }).n).toBe(0);
    expect((db.query("SELECT COUNT(*) n FROM approval_decisions ad JOIN approval_requests ar ON ad.approval_request_id=ar.id WHERE ar.run_id=?").get(seed.runId) as { n: number }).n).toBe(0);

    // With no durable approval, there is nothing to publish: no consumable-approval-without-
    // attestation can reach the publish path.
    expect((db.query("SELECT COUNT(*) n FROM publication_git_operations_v33 WHERE run_id=?").get(seed.runId) as { n: number }).n).toBe(0);

    // And the retry path is honest: a subsequent APPROVE whose attestation SUCCEEDS commits
    // BOTH atomically (proving the failure above was a true rollback, not a poisoned state).
    const facadeOk = h.buildFacade(h.buildService(), { attestationRequired: true });
    const approved = facadeOk.approve(principal, seed.checkpointId, { checkpointHash: seed.checkpointHash, decision: "APPROVE", policyVersion: POLICY }) as { status: string };
    expect(approved.status).toBe("APPROVED");
    expect((db.query("SELECT COUNT(*) n FROM publication_approvals_v33 WHERE run_id=?").get(seed.runId) as { n: number }).n).toBe(1);
    expect((db.query("SELECT COUNT(*) n FROM provenance_attestations").get() as { n: number }).n).toBe(1);
  });
});
