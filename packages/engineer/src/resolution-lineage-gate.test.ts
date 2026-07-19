import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReplacementLineageUnverifiedError } from "./errors.js";
import { sha256 } from "./hash.js";
import { EngineerLedger } from "./ledger.js";
import type { CanonicalBlocker } from "./resolution-case.js";
import {
  type CaseCreationInput,
  type ReplacementRunCreationPlan,
  type ReplacementRunFactory,
  ResolutionDesk,
} from "./resolution-desk.js";
import type { CheckpointAttestor, PromoteVerifiedCandidateInput } from "./verified-candidate-checkpoint.js";
import type { NewApprovalRequestRecord } from "./control-contracts.js";

// ---------------------------------------------------------------------------
// P7 integration proof: the ResolutionLineageVerifier is now INVOKED at the
// three authority-granting call sites in the ledger (promotion, approval
// request, publication-selection preflight). A replacement run whose complete
// resolution lineage does not verify must be REFUSED at every one; a good-
// lineage replacement passes the gate and continues on the ordinary path; a
// non-replacement run is entirely unaffected.
//
// These tests are RED without the wiring: with the gate removed, a broken-
// lineage replacement falls through to a DIFFERENT downstream error (an
// invalid-transition / checkpoint / not-found error) instead of the lineage
// rejection — so every `toThrow(ReplacementLineageUnverifiedError)` assertion
// below fails. (Verified by temporarily deleting each
// `assertReplacementLineageAuthority` call — see the report.)
// ---------------------------------------------------------------------------

const SECRET = "resolution-signing-secret-0123456789abcdef"; // >= 32 chars
const KEY_ID = "engineer-resolution-signing-v1";
const PRICING = sha256({ pricing: "policy-v1" });

/** Creates the executable replacement engineer run in REQUEST_RECEIVED so the
 *  verifier's replacement-run existence/state link binds to a real run. */
class RealReplacementRunFactory implements ReplacementRunFactory {
  createReplacementRun(db: Database, plan: ReplacementRunCreationPlan): void {
    const at = "2026-07-19T00:00:00.000Z";
    const source = db.query("SELECT request_original,base_branch FROM engineer_runs WHERE id=?")
      .get(plan.sourceRunId) as { request_original: string; base_branch: string };
    db.query(`INSERT INTO engineer_runs(id,user_id,repository_id,base_branch,base_commit_sha,request_original,request_normalized,state,state_version,manifest_hash,risk_tier,human_gate_required,created_at,updated_at)
      VALUES (?,?,?,?,?,?,'','REQUEST_RECEIVED',0,NULL,'MEDIUM',1,?,?)`).run(
      plan.replacementRunId, plan.ownerUserId, plan.repositoryId, source.base_branch, plan.baseCommitSha, source.request_original, at, at);
    const freshManifestHash = sha256({ replacementOf: plan.sourceManifestHash, directive: plan.directiveId, blockers: plan.blockers });
    db.query("INSERT INTO task_manifest_versions(id,run_id,version,manifest_hash,manifest_json,created_at) VALUES (?,?,1,?,'{}',?)")
      .run(`tmv-${plan.replacementRunId}`, plan.replacementRunId, freshManifestHash, at);
  }
}

interface Fixture {
  root: string;
  ledger: EngineerLedger;
  db: Database;
  desk: ResolutionDesk;
  clock: { current: Date };
}

let fixture: Fixture;

const attestor: CheckpointAttestor = {
  algorithm: "ed25519", keyId: "test-key",
  sign: () => "sig", verify: () => true,
};

const correctable: CanonicalBlocker = { blockerId: "b-1", kind: "BLOCKING", reasonCode: "REQUIRED_TEST_FAILED", description: "unit test failed" };

function baseCaseInput(blockers: CanonicalBlocker[], overrides: Partial<CaseCreationInput> = {}): CaseCreationInput {
  return {
    sourceRunId: "run-1", ownerUserId: "user-1", repositoryId: "repo-1",
    sourceState: "VERIFICATION_INCOMPLETE", sourceStateVersion: 4, baseCommitSha: "a".repeat(40),
    manifestHash: sha256({ m: 1 }), requiredLaneContractHash: sha256({ contract: 1 }), blockers,
    preVerificationCandidateDigest: null, sourceActualMicrousd: 2_000_000, priorReplacementActualMicrousd: 0,
    ambiguousLiabilityMicrousd: 0, cumulativeCeilingMicrousd: 10_000_000, pricingPolicyDigest: PRICING,
    sourceClassExcluded: false, ...overrides,
  };
}

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "zintus-lineage-gate-"));
  const dbPath = join(root, "engineer.db");
  // A single LIVE ledger; the desk runs on the ledger's OWN connection so the
  // verifier the ledger builds reads exactly the rows the desk writes.
  const ledger = new EngineerLedger(dbPath);
  const db = ledger.resolutionDeskConnection();
  const now = "2026-07-19T00:00:00.000Z";
  db.query("INSERT INTO users(id,email,created_at,updated_at) VALUES ('user-1',NULL,?,?)").run(now, now);
  db.query("INSERT INTO repository_connections(id,user_id,provider,owner,name,created_at,updated_at) VALUES ('repo-1','user-1','local','local','repo',?,?)").run(now, now);
  db.query(`INSERT INTO engineer_runs(id,user_id,repository_id,base_branch,base_commit_sha,request_original,request_normalized,state,state_version,manifest_hash,risk_tier,human_gate_required,created_at,updated_at)
    VALUES ('run-1','user-1','repo-1','main',?,'req','req','VERIFICATION_INCOMPLETE',4,?,'MEDIUM',1,?,?)`).run("a".repeat(40), sha256({ m: 1 }), now, now);
  db.query("INSERT INTO task_manifest_versions(id,run_id,version,manifest_hash,manifest_json,created_at) VALUES ('tmv-1','run-1',1,?,'{}',?)").run(sha256({ m: 1 }), now);
  const clock = { current: new Date(now) };
  const desk = new ResolutionDesk(db, SECRET, KEY_ID, () => clock.current, new RealReplacementRunFactory());
  fixture = { root, ledger, db, desk, clock };
});

afterEach(() => {
  fixture.ledger.close();
  rmSync(fixture.root, { recursive: true, force: true });
});

/** Bind the signing secret so the ledger builds its lineage verifier. */
function configure(): void {
  fixture.ledger.configureResolutionSigningSecret(SECRET);
}

/** Drive a case through corrected apply; return the linked ids. */
function applyCorrected(): { replacementRunId: string; caseId: string; directiveId: string } {
  const view = fixture.desk.createCase(baseCaseInput([correctable]));
  const { directive } = fixture.desk.issueDirective(view.caseId, {
    type: "CREATE_CORRECTED_RUN", caseVersion: 0, sourceRunVersion: 4,
    budget: { maxCostUsd: 2, maxTokens: 1000, maxActiveSeconds: 600, pricingPolicyDigest: PRICING },
  }, "idem-1");
  const applied = fixture.desk.applyDirective(directive.directiveId, "apply-1");
  return { replacementRunId: applied.replacementRunId, caseId: view.caseId, directiveId: directive.directiveId };
}

/** Tamper the case authority bytes so lineage yields CASE_TAMPERED (leaves the
 *  replacement engineer run in its REQUEST_RECEIVED state — a clean contrast:
 *  WITHOUT the gate the call sites fall through to their own downstream error). */
function breakLineageCaseTampered(caseId: string): void {
  fixture.db.exec("DROP TRIGGER fence_resolution_case_update_v31");
  const row = fixture.db.query("SELECT case_json FROM resolution_cases WHERE id=?").get(caseId) as { case_json: string };
  const parsed = JSON.parse(row.case_json);
  parsed.baseCommitSha = "b".repeat(40); // authority bytes changed, case_hash left stale
  fixture.db.query("UPDATE resolution_cases SET case_json=? WHERE id=?").run(JSON.stringify(parsed), caseId);
}

function promotionInput(runId: string): PromoteVerifiedCandidateInput {
  return { runId, reviewerSessionId: "rs-1", classificationHash: sha256({ c: 1 }), evidenceBundleId: "eb-1", attestor };
}

function approvalRecord(runId: string): NewApprovalRequestRecord {
  return {
    approvalRequestId: "ar-1", runId, riskTier: "MEDIUM", assignedReviewerId: null,
    requestedAt: "2026-07-19T00:00:00.000Z", deadlineAt: "2026-07-19T01:00:00.000Z",
    reminderSchedule: [], timeoutAction: "PAUSE",
    manifestHash: sha256({ m: 1 }), diffHash: sha256({ d: 1 }), evidenceBundleHash: sha256({ e: 1 }),
    reviewerSessionId: "rs-1", classificationHash: sha256({ c: 1 }), classificationResult: "READY",
    status: "PENDING", approvalRevision: 0,
    verifiedCheckpointId: sha256({ vc: 1 }), verifiedCheckpointHash: sha256({ vch: 1 }),
  };
}

async function reasonOf(fn: () => Promise<unknown>): Promise<string> {
  try { await fn(); throw new Error("expected rejection"); }
  catch (error) {
    if (error instanceof ReplacementLineageUnverifiedError) return error.reason;
    throw error;
  }
}

describe("P7 replacement-lineage authority gate (promotion / approval / publication)", () => {
  // --- promoteVerifiedCandidate (REVIEW_APPROVED grant) ---------------------

  test("REJECTS promotion of a replacement run whose lineage is broken", async () => {
    configure();
    const { replacementRunId, caseId } = applyCorrected();
    breakLineageCaseTampered(caseId);
    await expect(fixture.ledger.promoteVerifiedCandidate(promotionInput(replacementRunId), 0))
      .rejects.toThrow(ReplacementLineageUnverifiedError);
    expect(await reasonOf(() => fixture.ledger.promoteVerifiedCandidate(promotionInput(replacementRunId), 0)))
      .toBe("CASE_TAMPERED");
  });

  test("REJECTS promotion of a replacement run whose executable run was failed-closed", async () => {
    configure();
    const { replacementRunId } = applyCorrected();
    fixture.db.query("UPDATE engineer_runs SET state='FAILED' WHERE id=?").run(replacementRunId);
    expect(await reasonOf(() => fixture.ledger.promoteVerifiedCandidate(promotionInput(replacementRunId), 0)))
      .toBe("REPLACEMENT_RUN_INVALID_STATE");
  });

  test("a GOOD-lineage replacement passes the gate and reaches the ordinary promotion path", async () => {
    configure();
    const { replacementRunId } = applyCorrected();
    // Gate passes; the run is REQUEST_RECEIVED so the normal state check fires.
    await expect(fixture.ledger.promoteVerifiedCandidate(promotionInput(replacementRunId), 0))
      .rejects.toThrow("requires REVIEWING");
  });

  test("an ORDINARY (non-replacement) run is unaffected by the gate on promotion", async () => {
    configure();
    // run-1 has no resolution_replacements row; the gate is a pure pass-through.
    await expect(fixture.ledger.promoteVerifiedCandidate(promotionInput("run-1"), 4))
      .rejects.toThrow("requires REVIEWING");
  });

  // --- recordApprovalRequest (human-approval authority grant) ---------------

  test("REJECTS an approval request for a replacement run whose lineage is broken", async () => {
    configure();
    const { replacementRunId, caseId } = applyCorrected();
    breakLineageCaseTampered(caseId);
    await expect(fixture.ledger.recordApprovalRequest(approvalRecord(replacementRunId), attestor))
      .rejects.toThrow(ReplacementLineageUnverifiedError);
  });

  test("a GOOD-lineage replacement approval request passes the gate (fails later on checkpoint authority)", async () => {
    configure();
    const { replacementRunId } = applyCorrected();
    await expect(fixture.ledger.recordApprovalRequest(approvalRecord(replacementRunId), attestor))
      .rejects.toThrow("verified checkpoint authority");
  });

  test("an ORDINARY run approval request is unaffected by the gate", async () => {
    configure();
    await expect(fixture.ledger.recordApprovalRequest(approvalRecord("run-1"), attestor))
      .rejects.toThrow("verified checkpoint authority");
  });

  // --- getPublicationEvidence (publication-selection preflight) -------------

  test("REJECTS publication evidence for a replacement run whose lineage is broken", () => {
    configure();
    const { replacementRunId, caseId } = applyCorrected();
    breakLineageCaseTampered(caseId);
    expect(() => fixture.ledger.getPublicationEvidence(replacementRunId)).toThrow(ReplacementLineageUnverifiedError);
  });

  test("a GOOD-lineage replacement publication preflight passes the gate (fails later on missing evidence)", () => {
    configure();
    const { replacementRunId } = applyCorrected();
    // Gate passes; the fresh replacement has no reviewer session yet.
    expect(() => fixture.ledger.getPublicationEvidence(replacementRunId)).toThrow("publication evidence");
    expect(() => fixture.ledger.getPublicationEvidence(replacementRunId)).not.toThrow(ReplacementLineageUnverifiedError);
  });

  test("an ORDINARY run publication preflight is unaffected by the gate", () => {
    configure();
    expect(() => fixture.ledger.getPublicationEvidence("run-1")).not.toThrow(ReplacementLineageUnverifiedError);
  });

  // --- fail closed when the signing authority is unavailable ----------------

  test("REFUSES a replacement run when the signing secret was never configured (no legacy fallback)", () => {
    // Deliberately do NOT call configure(): the verifier is unset.
    const { replacementRunId } = applyCorrected();
    try {
      fixture.ledger.getPublicationEvidence(replacementRunId);
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(ReplacementLineageUnverifiedError);
      expect((error as ReplacementLineageUnverifiedError).reason).toBe("SIGNING_AUTHORITY_UNAVAILABLE");
    }
  });
});
