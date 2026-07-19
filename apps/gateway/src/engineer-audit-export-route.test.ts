/**
 * R5D item 1 — the owner-scoped, org-scoped audit-export gateway route.
 *
 * The REAL org-scoped `TenantScopedLedgerDal.exportRunAuditChain` (the R4 B1 fix)
 * is correct but was reachable via NO gateway route (barrel-exported only). This
 * drives the REAL route `GET /v1/engineer/runs/:runId/audit-export` through the
 * REAL `createGatewayHandler` + REAL `EngineerRunManager` over a REAL migrated
 * supervisor DB, seeding the run graph directly (the write/approve path is proven
 * elsewhere; this is the READ surface).
 *
 * RED WITHOUT THE FIX: with no route + no `EngineerRunManager.auditExport`, the
 * approved-run request 404s (unknown action) instead of returning the chain, and
 * the ATTESTATION assertion fails.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type { Engine } from "@zintus/engine";
import {
  EngineerSupervisor,
  createVerifiedCandidateCheckpoint,
  canonicalJson,
  sha256,
  ENGINEER_DEFAULT_ORG_ID,
  type CheckpointAttestor,
  type VerifiedCandidateCheckpointInput,
} from "@zintus/engineer";
import { createGatewayHandler } from "./handler.js";
import { EngineerRunManager } from "./engineer.js";
import { deriveEngineerPrincipal, type EngineerPrincipal } from "./engineer-identity.js";
import type { EngineerCapabilityPreflight } from "./engineer-preflight.js";

const NOW = "2026-07-19T00:00:00.000Z";
const hx = (seed: string): string => sha256(seed);

const checkpointAttestor: CheckpointAttestor = {
  algorithm: "test-sha256", keyId: "audit-export-test-key",
  sign: (payload) => `test:${sha256(payload)}`,
  verify: (payload, signature) => signature === `test:${sha256(payload)}`,
};

// The v21/v22/v23 approval-authority binding triggers, dropped so the fixture can
// seed a promoted checkpoint + provenance directly (their invariants are covered by
// their own suites). The provenance envelope-projection trigger stays intact.
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

function insertRunGraph(seed: Database, opts: { runId: string; ownerId: string; repositoryId: string; nonce: string }): void {
  seed.query("INSERT OR IGNORE INTO users(id,email,created_at,updated_at) VALUES (?,?,?,?)").run(opts.ownerId, null, NOW, NOW);
  seed.query("INSERT INTO repository_connections(id,user_id,provider,owner,name,created_at,updated_at,org_id) VALUES (?,?,?,?,?,?,?,?)")
    .run(opts.repositoryId, opts.ownerId, "local", "o", opts.nonce, NOW, NOW, ENGINEER_DEFAULT_ORG_ID);
  seed.query(
    "INSERT INTO engineer_runs(id,user_id,repository_id,base_branch,base_commit_sha,request_original," +
      "request_normalized,state,state_version,risk_tier,human_gate_required,created_at,updated_at,org_id)" +
      " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(opts.runId, opts.ownerId, opts.repositoryId, "main", "a".repeat(40), "req", "req", "REVIEW_APPROVED", 1, "HIGH", 1, NOW, NOW, ENGINEER_DEFAULT_ORG_ID);
  // Two org-scoped state events → EVENT entries in the export.
  for (const [n, prev, next] of [[1, "CREATED", "PLANNING"], [2, "PLANNING", "IMPLEMENTING"]] as const) {
    seed.query(
      "INSERT INTO run_state_events(event_id,run_id,sequence,previous_state,next_state,reason_code,actor_type," +
        "actor_id,timestamp,evidence_ids_json,manifest_hash,state_version,idempotency_key,org_id)" +
        " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(`evt-${opts.nonce}-${n}`, opts.runId, n, prev, next, "TRANSITION", "SUPERVISOR",
      "engineer-supervisor", NOW, "[]", null, n, `idem-${opts.nonce}-${n}`, ENGINEER_DEFAULT_ORG_ID);
  }
}

async function insertAttestation(seed: Database, opts: { runId: string; ownerId: string; repositoryId: string; nonce: string }): Promise<string> {
  const { checkpoint } = await createVerifiedCandidateCheckpoint(
    checkpointInput(opts.runId, opts.ownerId, opts.repositoryId, opts.nonce), checkpointAttestor);
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
    checkpointAttestor.algorithm, checkpointAttestor.keyId, "sig", checkpoint.createdAt, ENGINEER_DEFAULT_ORG_ID,
  );
  const statementHash = hx(`provenance-statement-${opts.nonce}`);
  const payloadType = "application/vnd.in-toto+json";
  const keyId = "audit-export-provenance-key";
  const envelopeJson = JSON.stringify({ payloadType, signatures: [{ keyid: keyId, sig: "x" }] });
  seed.query(
    "INSERT INTO provenance_attestations(statement_hash,org_id,subject_checkpoint_id,subject_checkpoint_hash," +
      "approval_decision_id,approver_actor_id,signature_key_id,signature_algorithm,payload_type,envelope_json," +
      "statement_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    statementHash, ENGINEER_DEFAULT_ORG_ID, checkpoint.checkpointId, checkpoint.checkpointHash,
    `decision-${opts.nonce}`, `approver-${opts.nonce}`, keyId, "hmac-sha256",
    payloadType, envelopeJson, "{}", NOW,
  );
  return statementHash;
}

const readyPreflight = {
  readiness: () => ({ state: "READY", error: null }),
  assertStartup: async () => {},
  assertRunAdmission: async () => {},
  repository: () => ({ repositoryId: "repo", provider: "local", owner: "o", name: "r", baseBranch: "main", baseCommitSha: "a".repeat(40) }),
  repositories: () => [],
} as unknown as EngineerCapabilityPreflight;

const engine = { getQuotaRemaining: () => 1 } as unknown as Engine;

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

async function makeHandler(): Promise<{
  handler: ReturnType<typeof createGatewayHandler>;
  principal: EngineerPrincipal;
  approvedRunId: string; plainRunId: string; foreignRunId: string; provenanceStatementHash: string;
}> {
  const root = mkdtempSync(join(tmpdir(), "zintus-audit-export-route-"));
  const dbPath = join(root, "engineer.sqlite");
  const supervisor = new EngineerSupervisor({ dbPath, now: () => new Date(NOW) });
  cleanups.push(() => { try { supervisor.close(); } catch { /* already closed */ } rmSync(root, { recursive: true, force: true }); });

  const principal = deriveEngineerPrincipal({ gatewayIdentitySecret: "audit-export-route-install-secret" });
  const approvedRunId = "run-approved";
  const plainRunId = "run-plain";
  const foreignRunId = "run-foreign";

  const seed = new Database(dbPath);
  seed.exec("PRAGMA foreign_keys=OFF");
  for (const trigger of AUTHORITY_GUARDS) seed.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
  insertRunGraph(seed, { runId: approvedRunId, ownerId: principal.ownerId, repositoryId: "repo-approved", nonce: "approved" });
  insertRunGraph(seed, { runId: plainRunId, ownerId: principal.ownerId, repositoryId: "repo-plain", nonce: "plain" });
  insertRunGraph(seed, { runId: foreignRunId, ownerId: "foreign-owner", repositoryId: "repo-foreign", nonce: "foreign" });
  const provenanceStatementHash = await insertAttestation(seed, { runId: approvedRunId, ownerId: principal.ownerId, repositoryId: "repo-approved", nonce: "approved" });
  seed.close();

  const engineerRuns = new EngineerRunManager({ supervisor, principal, preflight: readyPreflight });
  const handler = createGatewayHandler({ engine, config: { port: 8788, host: "127.0.0.1", token: "secret", corsOrigins: "*" }, engineerRuns });
  return { handler, principal, approvedRunId, plainRunId, foreignRunId, provenanceStatementHash };
}

const get = (handler: ReturnType<typeof createGatewayHandler>, runId: string) =>
  handler(new Request(`http://x/v1/engineer/runs/${runId}/audit-export`, { headers: { Authorization: "Bearer secret" } }));

describe("R5D — GET /v1/engineer/runs/:runId/audit-export", () => {
  test("an approved run returns its org-scoped audit chain WITH an ATTESTATION entry", async () => {
    const h = await makeHandler();
    const response = await get(h.handler, h.approvedRunId);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.json() as {
      schemaVersion: number; tenantId: string; runId: string; contentDigest: string;
      pages: Array<{ entries: Array<{ kind: string; id: string; payload: Record<string, unknown> }> }>;
    };
    expect(body.schemaVersion).toBe(1);
    expect(body.tenantId).toBe(ENGINEER_DEFAULT_ORG_ID);
    expect(body.runId).toBe(h.approvedRunId);
    expect(body.contentDigest.startsWith("sha256:")).toBe(true);
    const entries = body.pages.flatMap((page) => page.entries);
    // EVENT chain present.
    expect(entries.filter((e) => e.kind === "EVENT").map((e) => e.id)).toEqual(["evt-approved-1", "evt-approved-2"]);
    // ATTESTATION present: the checkpoint-derived one AND the v35 provenance one.
    expect(entries.some((e) => e.kind === "ATTESTATION")).toBe(true);
    expect(entries.some((e) => e.kind === "ATTESTATION" && e.payload.statementHash === h.provenanceStatementHash)).toBe(true);
  });

  test("a run with NO attestation still returns its event chain (no ATTESTATION entries)", async () => {
    const h = await makeHandler();
    const response = await get(h.handler, h.plainRunId);
    expect(response.status).toBe(200);
    const body = await response.json() as { pages: Array<{ entries: Array<{ kind: string; id: string }> }> };
    const entries = body.pages.flatMap((page) => page.entries);
    expect(entries.map((e) => e.id)).toEqual(["evt-plain-1", "evt-plain-2"]);
    expect(entries.every((e) => e.kind === "EVENT")).toBe(true);
  });

  test("a cross-owner run is a byte-identical not-found (404)", async () => {
    const h = await makeHandler();
    const response = await get(h.handler, h.foreignRunId);
    expect(response.status).toBe(404);
  });

  test("an unknown run is a not-found (404) — no ownership oracle", async () => {
    const h = await makeHandler();
    const response = await get(h.handler, "run-does-not-exist");
    expect(response.status).toBe(404);
  });
});
