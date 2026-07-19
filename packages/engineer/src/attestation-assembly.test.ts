import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ENGINEER_DATABASE_SCHEMA_SQL } from "./database-schema.js";
import { migrateEngineerDatabase } from "./database-migrations.js";
import { canonicalJson, sha256 } from "./hash.js";
import { EngineerNotFoundError } from "./errors.js";
import {
  createHmacProvenanceSigner,
  verifyProvenanceAttestation,
  type DsseEnvelope,
} from "./attestation.js";
import {
  assemblePromotionProvenanceInput,
  emitPromotionProvenanceAttestation,
} from "./attestation-assembly.js";
import {
  createVerifiedCandidateCheckpoint,
  type CheckpointAttestor,
  type VerifiedCandidateCheckpointInput,
} from "./index.js";

const NOW = "2026-07-19T00:00:00.000Z";
const ORG = "org-a";
const SECRET = "attestation-hmac-secret-32bytes!!";
const KEY_ID = "engineer-provenance-key-1";
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
    runId, requesterUserId: "requester-user", repositoryId: "repo",
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

async function scratchWithCheckpoint(runId: string): Promise<{ db: Database; checkpointId: string }> {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=OFF");
  db.exec(ENGINEER_DATABASE_SCHEMA_SQL);
  db.query("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(14, NOW);
  migrateEngineerDatabase(db, NOW);
  // We are unit-testing the assembly READS, not the checkpoint-insertion
  // bindings (their own tests cover those), so drop the binding trigger and
  // seed the persisted checkpoint row directly.
  db.exec("DROP TRIGGER IF EXISTS require_verified_candidate_checkpoint_bindings_v21");

  const { checkpoint, attestation } = await createVerifiedCandidateCheckpoint(legacyInput(runId), checkpointAttestor);
  db.query(
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
    checkpoint.environmentDigest, canonicalJson(checkpoint), attestation.statementJson, attestation.statementHash,
    attestation.algorithm, attestation.keyId, attestation.signature, checkpoint.createdAt, ORG,
  );

  // Real durable supporting records the assembly reads.
  db.query(
    "INSERT INTO agent_executions(id,run_id,role,model_tier,status,started_at,completed_at,org_id) VALUES (?,?,?,?,?,?,?,?)",
  ).run("reviewer-1", runId, "REVIEWER", "GPT-5.6_TERRA", "SUCCEEDED", NOW, NOW, ORG);
  db.query(
    "INSERT INTO agent_executions(id,run_id,role,model_tier,status,started_at,completed_at,org_id) VALUES (?,?,?,?,?,?,?,?)",
  ).run("builder-1", runId, "BUILDER", "GPT-5.6_TERRA", "SUCCEEDED", NOW, NOW, ORG);
  db.query(
    "INSERT INTO run_budgets(run_id,cost_limit_usd,token_limit,time_limit_seconds,lifetime_cost_limit_usd," +
      "lifetime_token_limit,lifetime_time_limit_seconds,used_cost_usd,used_tokens,used_time_seconds,status," +
      "created_at,updated_at,org_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(runId, 10, 100000, 3600, 10, 100000, 3600, 0.125, 6789, 42, "ACTIVE", NOW, NOW, ORG);

  return { db, checkpointId: checkpoint.checkpointId };
}

function seedReplacement(db: Database, runId: string): { caseHash: string; replacementId: string } {
  // We only READ case_hash / replacement fields in the assembly; drop the v31
  // resolution state-machine insert guards so we can seed a terminal-shaped row
  // directly (their own tests cover those invariants).
  for (const trigger of [
    "require_resolution_case_projection_v31", "require_resolution_replacement_binding_v31",
  ]) {
    db.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
  }
  const caseId = hash("case-id");
  const caseHash = hash("case-hash");
  const directiveId = hash("directive-id");
  const directiveHash = hash("directive-hash");
  const replacementId = hash("replacement-id");
  const replacementHash = hash("replacement-hash");
  const digest = hash("pricing");
  db.query(
    "INSERT INTO resolution_cases(id,case_hash,schema_version,policy_version,source_run_id,owner_user_id," +
      "repository_id,source_state,source_state_version,base_commit_sha,manifest_hash,required_lane_contract_hash," +
      "blockers_json,blocker_count,correction_eligible,reverify_eligible,pre_verification_candidate_present," +
      "reverify_reason,source_actual_microusd,prior_replacement_actual_microusd,ambiguous_liability_microusd," +
      "cumulative_ceiling_microusd,pricing_policy_digest,case_version,state,case_json,created_at,expires_at,org_id)" +
      " VALUES (?,?,1,'engineer-resolution-case-v1',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(caseId, caseHash, "source-run", "owner", "repo", "REVIEWING", 1, "a".repeat(40), hash("manifest"),
    hash("contract"), "[]", 0, 1, 1, 0, "reason", 0, 0, 0, 0, digest, 0, "OPEN", "{}", NOW,
    "2026-08-01T00:00:00.000Z", ORG);
  db.query(
    "INSERT INTO resolution_replacements(id,replacement_hash,schema_version,policy_version,case_id,directive_id," +
      "directive_hash,kind,replacement_run_id,state,budget_max_cost_microusd,budget_max_tokens," +
      "budget_max_active_seconds,budget_pricing_policy_digest,replacement_json,created_at,updated_at,org_id)" +
      " VALUES (?,?,1,'engineer-resolution-replacement-v1',?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(replacementId, replacementHash, caseId, directiveId, directiveHash, "CORRECTED", runId, "READY",
    0, 0, 1, digest, "{}", NOW, NOW, ORG);
  return { caseHash, replacementId };
}

const signer = createHmacProvenanceSigner({ secret: SECRET, keyId: KEY_ID });

describe("P11 live attestation assembly from real DB records", () => {
  test("a persisted verified candidate emits a verifiable attestation with real-sourced fields", async () => {
    const { db, checkpointId } = await scratchWithCheckpoint("run-1");
    const { envelope, statement } = await emitPromotionProvenanceAttestation(db, checkpointId, {
      approverUserId: "approver-user", resultTreeHash: hash("tree"), createdAt: "2026-07-19T00:05:00.000Z",
    }, signer);

    const result = await verifyProvenanceAttestation(envelope, signer);
    expect(result.ok).toBe(true);

    // Fields came from the REAL rows, not from the caller.
    expect(statement.predicate.roles.map((role) => role.role)).toEqual(["BUILDER", "REVIEWER"]);
    expect(statement.predicate.budget).toEqual({ costMicrousd: 125_000, tokensConsumed: 6789, activeSeconds: 42 });
    expect(statement.predicate.identities.requesterUserId).toBe("requester-user");
    expect(statement.predicate.identities.approverUserId).toBe("approver-user");
    expect(statement.predicate.isReplacement).toBe(false);
    expect(statement.predicate.replacementLineage).toBeNull();
    // Subject binds to the exact persisted checkpoint digest.
    const persisted = db.query("SELECT checkpoint_hash h FROM verified_candidate_checkpoints WHERE id=?")
      .get(checkpointId) as { h: string };
    expect(`sha256:${statement.subject[0].digest.sha256}`).toBe(persisted.h);
  });

  test("tampering one predicate byte makes the independent verifier reject", async () => {
    const { db, checkpointId } = await scratchWithCheckpoint("run-1");
    const { envelope } = await emitPromotionProvenanceAttestation(db, checkpointId, {
      approverUserId: "approver-user", resultTreeHash: hash("tree"), createdAt: "2026-07-19T00:05:00.000Z",
    }, signer);
    const decoded = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8"));
    decoded.predicate.budget.costMicrousd = 999_999;
    const tampered: DsseEnvelope = { ...envelope, payload: Buffer.from(canonicalJson(decoded), "utf8").toString("base64") };
    const result = await verifyProvenanceAttestation(tampered, signer);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("SIGNATURE_INVALID");
  });

  test("approver == requester is rejected at assembly time", async () => {
    const { db, checkpointId } = await scratchWithCheckpoint("run-1");
    await expect(emitPromotionProvenanceAttestation(db, checkpointId, {
      approverUserId: "requester-user", resultTreeHash: hash("tree"), createdAt: "2026-07-19T00:05:00.000Z",
    }, signer)).rejects.toThrow(/approver must differ/);
  });

  test("a P7 replacement run's attestation carries AND requires its lineage", async () => {
    const { db, checkpointId } = await scratchWithCheckpoint("run-repl");
    const seeded = seedReplacement(db, "run-repl");
    const { envelope, statement } = await emitPromotionProvenanceAttestation(db, checkpointId, {
      approverUserId: "approver-user", resultTreeHash: hash("tree"), createdAt: "2026-07-19T00:05:00.000Z",
    }, signer);
    expect(statement.predicate.isReplacement).toBe(true);
    expect(statement.predicate.replacementLineage).not.toBeNull();
    expect(statement.predicate.replacementLineage!.caseHash).toBe(seeded.caseHash);
    expect(statement.predicate.replacementLineage!.replacementId).toBe(seeded.replacementId);
    expect((await verifyProvenanceAttestation(envelope, signer)).ok).toBe(true);

    // REQUIRES lineage: strip it and the verifier rejects with the P7 code.
    const decoded = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8"));
    decoded.predicate.replacementLineage = null;
    const payloadBytes = Buffer.from(canonicalJson(decoded), "utf8");
    const { preAuthEncoding, DSSE_PAYLOAD_TYPE } = await import("./attestation.js");
    const resigned: DsseEnvelope = {
      payloadType: DSSE_PAYLOAD_TYPE,
      payload: payloadBytes.toString("base64"),
      signatures: [{ keyid: signer.keyId, sig: await signer.sign(preAuthEncoding(DSSE_PAYLOAD_TYPE, payloadBytes)) }],
    };
    const stripped = await verifyProvenanceAttestation(resigned, signer);
    expect(stripped.ok).toBe(false);
    if (!stripped.ok) expect(stripped.code).toBe("MISSING_REPLACEMENT_LINEAGE");
  });

  test("unknown checkpoint id is a not-found", async () => {
    const { db } = await scratchWithCheckpoint("run-1");
    expect(() => assemblePromotionProvenanceInput(db, "sha256:" + "0".repeat(64), {
      approverUserId: "approver-user", resultTreeHash: hash("tree"), createdAt: NOW,
    })).toThrow(EngineerNotFoundError);
  });
});
