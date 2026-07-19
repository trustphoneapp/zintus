import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "./hash.js";
import { EngineerLedger } from "./ledger.js";
import type { CanonicalBlocker } from "./resolution-case.js";
import { ResolutionLineageVerifier } from "./resolution-lineage.js";
import {
  type CaseCreationInput,
  type ReplacementRunCreationPlan,
  type ReplacementRunFactory,
  ResolutionDesk,
} from "./resolution-desk.js";

const SECRET = "resolution-signing-secret";
const KEY_ID = "engineer-resolution-signing-v1";
const PRICING = sha256({ pricing: "policy-v1" });

/**
 * A real executable-replacement factory: creates the replacement engineer run at
 * its REQUEST_RECEIVED start state on the desk's own connection, so the lineage
 * verifier's P1-A replacement-run existence/state check has a real run to bind.
 * A factory-less desk (the prior fixture) left the run a phantom — the exact
 * fail-open this verifier now closes.
 */
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
  db: Database;
  desk: ResolutionDesk;
  clock: { current: Date };
}

let fixture: Fixture;

const correctable: CanonicalBlocker = { blockerId: "b-1", kind: "BLOCKING", reasonCode: "REQUIRED_TEST_FAILED", description: "unit test failed" };
const transient: CanonicalBlocker = { blockerId: "b-2", kind: "BLOCKING", reasonCode: "PROVIDER_REQUEST_TIMEOUT", description: "provider timed out" };

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
  const root = mkdtempSync(join(tmpdir(), "zintus-resolution-lineage-"));
  const dbPath = join(root, "engineer.db");
  new EngineerLedger(dbPath).close();
  const db = new Database(dbPath);
  db.exec("PRAGMA foreign_keys=ON");
  db.exec("PRAGMA busy_timeout=5000");
  const now = "2026-07-19T00:00:00.000Z";
  db.query("INSERT INTO users(id,email,created_at,updated_at) VALUES ('user-1',NULL,?,?)").run(now, now);
  db.query("INSERT INTO repository_connections(id,user_id,provider,owner,name,created_at,updated_at) VALUES ('repo-1','user-1','local','local','repo',?,?)").run(now, now);
  db.query(`INSERT INTO engineer_runs(id,user_id,repository_id,base_branch,base_commit_sha,request_original,request_normalized,state,state_version,manifest_hash,risk_tier,human_gate_required,created_at,updated_at)
    VALUES ('run-1','user-1','repo-1','main',?,'req','req','VERIFICATION_INCOMPLETE',4,?,'MEDIUM',1,?,?)`).run("a".repeat(40), sha256({ m: 1 }), now, now);
  db.query("INSERT INTO task_manifest_versions(id,run_id,version,manifest_hash,manifest_json,created_at) VALUES ('tmv-1','run-1',1,?,'{}',?)").run(sha256({ m: 1 }), now);
  const clock = { current: new Date(now) };
  fixture = { root, db, desk: new ResolutionDesk(db, SECRET, KEY_ID, () => clock.current, new RealReplacementRunFactory()), clock };
});

afterEach(() => {
  fixture.db.close();
  rmSync(fixture.root, { recursive: true, force: true });
});

/** Drive a case through corrected/reverify apply and return the linked ids. */
function applyCorrected(): { replacementRunId: string; caseId: string; directiveId: string } {
  const view = fixture.desk.createCase(baseCaseInput([correctable]));
  const { directive } = fixture.desk.issueDirective(view.caseId, {
    type: "CREATE_CORRECTED_RUN", caseVersion: 0, sourceRunVersion: 4,
    budget: { maxCostUsd: 2, maxTokens: 1000, maxActiveSeconds: 600, pricingPolicyDigest: PRICING },
  }, "idem-1");
  const applied = fixture.desk.applyDirective(directive.directiveId, "apply-1");
  return { replacementRunId: applied.replacementRunId, caseId: view.caseId, directiveId: directive.directiveId };
}

function applyReverify(): { replacementRunId: string } {
  const view = fixture.desk.createCase(baseCaseInput([transient], { preVerificationCandidateDigest: sha256({ candidate: 1 }) }));
  const { directive } = fixture.desk.issueDirective(view.caseId, { type: "CREATE_REVERIFY_RUN", caseVersion: 0, sourceRunVersion: 4 }, "idem-rv");
  const applied = fixture.desk.applyDirective(directive.directiveId, "apply-rv");
  return { replacementRunId: applied.replacementRunId };
}

describe("companion-aware replacement-lineage verifier", () => {
  test("accepts the complete good chain for a corrected replacement", () => {
    const { replacementRunId, caseId, directiveId } = applyCorrected();
    const verifier = new ResolutionLineageVerifier(fixture.db, SECRET);
    const verdict = verifier.verify(replacementRunId);
    expect(verdict.verified).toBe(true);
    if (verdict.verified) {
      expect(verdict.sourceRunId).toBe("run-1");
      expect(verdict.kind).toBe("CORRECTED");
      expect(verdict.caseId).toBe(caseId);
      expect(verdict.directiveId).toBe(directiveId);
    }
  });

  test("accepts the good chain for a reverify replacement", () => {
    const { replacementRunId } = applyReverify();
    const verdict = new ResolutionLineageVerifier(fixture.db, SECRET).verify(replacementRunId);
    expect(verdict).toMatchObject({ verified: true, kind: "REVERIFY", sourceRunId: "run-1" });
  });

  test("fails closed when the candidate is not a replacement at all (foreign checkpoint)", () => {
    applyCorrected();
    const verdict = new ResolutionLineageVerifier(fixture.db, SECRET).verify("run-1");
    expect(verdict).toEqual({ verified: false, reason: "NOT_A_REPLACEMENT" });
  });

  test("fails closed when the signing authority is unavailable", () => {
    const { replacementRunId } = applyCorrected();
    const verdict = new ResolutionLineageVerifier(fixture.db, "").verify(replacementRunId);
    expect(verdict).toEqual({ verified: false, reason: "SIGNING_AUTHORITY_UNAVAILABLE" });
  });

  test("rejects a directive whose HMAC does not verify under the held secret", () => {
    const { replacementRunId } = applyCorrected();
    const verdict = new ResolutionLineageVerifier(fixture.db, "a-different-secret").verify(replacementRunId);
    expect(verdict).toEqual({ verified: false, reason: "DIRECTIVE_SIGNATURE_INVALID" });
  });

  test("rejects a directive whose signed bytes were tampered (independent of storage triggers)", () => {
    const { replacementRunId, directiveId } = applyCorrected();
    // Prove the verifier is an independent layer: bypass the durable immutability
    // triggers and rewrite the directive body so it no longer hashes to its id.
    fixture.db.exec("DROP TRIGGER prevent_resolution_directive_update_v31");
    fixture.db.exec("DROP TRIGGER require_resolution_directive_projection_v31");
    const row = fixture.db.query("SELECT directive_json FROM resolution_directives WHERE id=?").get(directiveId) as { directive_json: string };
    const parsed = JSON.parse(row.directive_json);
    parsed.expiresAt = "2099-01-01T00:00:00.000Z";
    fixture.db.query("UPDATE resolution_directives SET directive_json=? WHERE id=?").run(JSON.stringify(parsed), directiveId);
    const verdict = new ResolutionLineageVerifier(fixture.db, SECRET).verify(replacementRunId);
    expect(verdict).toEqual({ verified: false, reason: "DIRECTIVE_TAMPERED" });
  });

  test("rejects a tampered case authority (independent of storage triggers)", () => {
    const { replacementRunId, caseId } = applyCorrected();
    fixture.db.exec("DROP TRIGGER fence_resolution_case_update_v31");
    const row = fixture.db.query("SELECT case_json FROM resolution_cases WHERE id=?").get(caseId) as { case_json: string };
    const parsed = JSON.parse(row.case_json);
    parsed.baseCommitSha = "b".repeat(40); // authority bytes changed, case_hash left stale
    fixture.db.query("UPDATE resolution_cases SET case_json=? WHERE id=?").run(JSON.stringify(parsed), caseId);
    const verdict = new ResolutionLineageVerifier(fixture.db, SECRET).verify(replacementRunId);
    expect(verdict).toEqual({ verified: false, reason: "CASE_TAMPERED" });
  });

  test("rejects a replacement that is not READY", () => {
    const { replacementRunId } = applyCorrected();
    fixture.db.exec("DROP TRIGGER fence_resolution_replacement_update_v31");
    fixture.db.query("UPDATE resolution_replacements SET state='PREPARING' WHERE replacement_run_id=?").run(replacementRunId);
    const verdict = new ResolutionLineageVerifier(fixture.db, SECRET).verify(replacementRunId);
    expect(verdict).toEqual({ verified: false, reason: "REPLACEMENT_NOT_READY" });
  });

  test("rejects a replacement scaffolded after the directive TTL expired at apply time", () => {
    const { replacementRunId } = applyCorrected();
    fixture.db.exec("DROP TRIGGER fence_resolution_replacement_update_v31");
    // Push the scaffold time past the directive's 900s expiry window.
    fixture.db.query("UPDATE resolution_replacements SET created_at='2099-01-01T00:00:00.000Z' WHERE replacement_run_id=?").run(replacementRunId);
    const verdict = new ResolutionLineageVerifier(fixture.db, SECRET).verify(replacementRunId);
    expect(verdict).toEqual({ verified: false, reason: "DIRECTIVE_EXPIRED_AT_APPLY" });
  });

  // --- P1-A: replacement-run existence + state (the closed fail-open) --------

  test("fails closed when the READY replacement has NO executable engineer run (phantom)", () => {
    const { replacementRunId } = applyCorrected();
    // Remove the executable run while leaving the READY resolution_replacements
    // row intact — the exact fail-open shape (scaffold without a real run).
    fixture.db.exec("PRAGMA foreign_keys=OFF");
    fixture.db.query("DELETE FROM engineer_runs WHERE id=?").run(replacementRunId);
    const verdict = new ResolutionLineageVerifier(fixture.db, SECRET).verify(replacementRunId);
    expect(verdict).toEqual({ verified: false, reason: "REPLACEMENT_RUN_MISSING" });
  });

  test("fails closed when the replacement run was failed-closed by orphan recovery", () => {
    const { replacementRunId } = applyCorrected();
    // Orphan recovery stamps FAILED on the run; its checkpoints must never verify.
    fixture.db.query("UPDATE engineer_runs SET state='FAILED' WHERE id=?").run(replacementRunId);
    const verdict = new ResolutionLineageVerifier(fixture.db, SECRET).verify(replacementRunId);
    expect(verdict).toEqual({ verified: false, reason: "REPLACEMENT_RUN_INVALID_STATE" });
  });

  test("accepts a COMPLETED replacement run (the one legitimate terminal)", () => {
    const { replacementRunId } = applyCorrected();
    fixture.db.query("UPDATE engineer_runs SET state='COMPLETED' WHERE id=?").run(replacementRunId);
    expect(new ResolutionLineageVerifier(fixture.db, SECRET).verify(replacementRunId).verified).toBe(true);
  });

  // --- P1-D: targeted rejection coverage for the seven walked links ----------

  test("rejects when the directive row is missing (DIRECTIVE_MISSING)", () => {
    const { replacementRunId } = applyCorrected();
    fixture.db.exec("PRAGMA foreign_keys=OFF");
    fixture.db.exec("DROP TRIGGER fence_resolution_replacement_update_v31");
    fixture.db.query("UPDATE resolution_replacements SET directive_id='ghost-directive' WHERE replacement_run_id=?").run(replacementRunId);
    const verdict = new ResolutionLineageVerifier(fixture.db, SECRET).verify(replacementRunId);
    expect(verdict).toEqual({ verified: false, reason: "DIRECTIVE_MISSING" });
  });

  test("rejects when the directive's case link does not match the replacement (DIRECTIVE_LINK_MISMATCH)", () => {
    const { replacementRunId } = applyCorrected();
    fixture.db.exec("PRAGMA foreign_keys=OFF");
    fixture.db.exec("DROP TRIGGER prevent_resolution_directive_update_v31");
    fixture.db.query("UPDATE resolution_directives SET case_id='other-case' WHERE id=(SELECT directive_id FROM resolution_replacements WHERE replacement_run_id=?)").run(replacementRunId);
    const verdict = new ResolutionLineageVerifier(fixture.db, SECRET).verify(replacementRunId);
    expect(verdict).toEqual({ verified: false, reason: "DIRECTIVE_LINK_MISMATCH" });
  });

  test("rejects when the directive type and replacement kind disagree (KIND_MISMATCH)", () => {
    const { replacementRunId } = applyCorrected();
    fixture.db.exec("DROP TRIGGER fence_resolution_replacement_update_v31");
    fixture.db.query("UPDATE resolution_replacements SET kind='REVERIFY' WHERE replacement_run_id=?").run(replacementRunId);
    const verdict = new ResolutionLineageVerifier(fixture.db, SECRET).verify(replacementRunId);
    expect(verdict).toEqual({ verified: false, reason: "KIND_MISMATCH" });
  });

  test("rejects when the referenced case row is gone (CASE_MISSING)", () => {
    const { replacementRunId } = applyCorrected();
    fixture.db.exec("PRAGMA foreign_keys=OFF");
    fixture.db.exec("DROP TRIGGER prevent_resolution_directive_update_v31");
    fixture.db.exec("DROP TRIGGER fence_resolution_replacement_update_v31");
    // Keep directive.case_id === replacement.case_id (LINK passes) but point both
    // at a case id that does not exist, so the case lookup itself fails.
    fixture.db.query("UPDATE resolution_directives SET case_id='ghost-case' WHERE id=(SELECT directive_id FROM resolution_replacements WHERE replacement_run_id=?)").run(replacementRunId);
    fixture.db.query("UPDATE resolution_replacements SET case_id='ghost-case' WHERE replacement_run_id=?").run(replacementRunId);
    const verdict = new ResolutionLineageVerifier(fixture.db, SECRET).verify(replacementRunId);
    expect(verdict).toEqual({ verified: false, reason: "CASE_MISSING" });
  });

  test("rejects when the case_hash no longer matches the directive's pinned case_hash (CASE_HASH_MISMATCH)", () => {
    const { replacementRunId } = applyCorrected();
    fixture.db.exec("PRAGMA foreign_keys=OFF");
    fixture.db.exec("DROP TRIGGER fence_resolution_case_update_v31");
    fixture.db.query("UPDATE resolution_cases SET case_hash=? WHERE id=(SELECT case_id FROM resolution_replacements WHERE replacement_run_id=?)")
      .run(sha256({ tamperedCaseHash: 1 }), replacementRunId);
    const verdict = new ResolutionLineageVerifier(fixture.db, SECRET).verify(replacementRunId);
    expect(verdict).toEqual({ verified: false, reason: "CASE_HASH_MISMATCH" });
  });

  test("rejects when the case is not in a resolved state (CASE_NOT_RESOLVED)", () => {
    const { replacementRunId } = applyCorrected();
    fixture.db.exec("DROP TRIGGER fence_resolution_case_update_v31");
    fixture.db.query("UPDATE resolution_cases SET state='OPEN' WHERE id=(SELECT case_id FROM resolution_replacements WHERE replacement_run_id=?)").run(replacementRunId);
    const verdict = new ResolutionLineageVerifier(fixture.db, SECRET).verify(replacementRunId);
    expect(verdict).toEqual({ verified: false, reason: "CASE_NOT_RESOLVED" });
  });

  test("rejects when the frozen source run is gone (SOURCE_RUN_MISSING)", () => {
    const { replacementRunId } = applyCorrected();
    // Drop the source run; the replacement run stays, so P1-A passes and the walk
    // reaches the source-existence check.
    fixture.db.exec("PRAGMA foreign_keys=OFF");
    fixture.db.query("DELETE FROM engineer_runs WHERE id='run-1'").run();
    const verdict = new ResolutionLineageVerifier(fixture.db, SECRET).verify(replacementRunId);
    expect(verdict).toEqual({ verified: false, reason: "SOURCE_RUN_MISSING" });
  });

  test("the P8 boolean seam accepts the good chain and rejects a foreign run", () => {
    const { replacementRunId } = applyCorrected();
    const verifier = new ResolutionLineageVerifier(fixture.db, SECRET);
    const good = verifier.verifyReplacementLineage({
      runId: replacementRunId, candidateRunId: replacementRunId, parentSelectionId: sha256({ p: 1 }),
      checkpointId: sha256({ c: 1 }), checkpointHash: sha256({ h: 1 }), resultCommitSha: "c".repeat(40),
    });
    expect(good).toBe(true);
    const foreign = verifier.verifyReplacementLineage({
      runId: "run-1", candidateRunId: "run-1", parentSelectionId: sha256({ p: 1 }),
      checkpointId: sha256({ c: 1 }), checkpointHash: sha256({ h: 1 }), resultCommitSha: "c".repeat(40),
    });
    expect(foreign).toBe(false);
  });
});
