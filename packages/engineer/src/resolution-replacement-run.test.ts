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
const SOURCE_MANIFEST = sha256({ m: 1 });
const correctable: CanonicalBlocker = { blockerId: "b-1", kind: "BLOCKING", reasonCode: "REQUIRED_TEST_FAILED", description: "unit test failed" };

/**
 * A real executable-replacement factory: creates the run at its REQUEST_RECEIVED
 * start state on the desk's own connection, with a fresh budget from the
 * directive and a fresh manifest freeze derived from the source manifest + open
 * blockers. It inherits nothing else — no evidence, review, approval, or
 * publication rows exist for a brand-new run id.
 */
class RealReplacementRunFactory implements ReplacementRunFactory {
  freshManifestHashes: string[] = [];
  createReplacementRun(db: Database, plan: ReplacementRunCreationPlan): void {
    const at = "2026-07-19T00:00:00.000Z";
    const source = db.query("SELECT request_original,base_branch FROM engineer_runs WHERE id=?").get(plan.sourceRunId) as { request_original: string; base_branch: string };
    db.query(`INSERT INTO engineer_runs(id,user_id,repository_id,base_branch,base_commit_sha,request_original,request_normalized,state,state_version,manifest_hash,risk_tier,human_gate_required,created_at,updated_at)
      VALUES (?,?,?,?,?,?,'','REQUEST_RECEIVED',0,NULL,'MEDIUM',1,?,?)`).run(
      plan.replacementRunId, plan.ownerUserId, plan.repositoryId, source.base_branch, plan.baseCommitSha, source.request_original, at, at);
    const costUsd = plan.budget.maxCostMicrousd / 1_000_000;
    db.query(`INSERT INTO run_budgets(run_id,cost_limit_usd,token_limit,time_limit_seconds,lifetime_cost_limit_usd,lifetime_token_limit,lifetime_time_limit_seconds,status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,'ACTIVE',?,?)`).run(
      plan.replacementRunId, costUsd, plan.budget.maxTokens, plan.budget.maxActiveSeconds, costUsd, plan.budget.maxTokens, plan.budget.maxActiveSeconds, at, at);
    const freshManifestHash = sha256({ replacementOf: plan.sourceManifestHash, directive: plan.directiveId, blockers: plan.blockers });
    this.freshManifestHashes.push(freshManifestHash);
    db.query("INSERT INTO task_manifest_versions(id,run_id,version,manifest_hash,manifest_json,created_at) VALUES (?,?,1,?,'{}',?)")
      .run(`tmv-${plan.replacementRunId}`, plan.replacementRunId, freshManifestHash, at);
  }
}

interface Fixture { root: string; db: Database; clock: { current: Date } }
let fixture: Fixture;

function baseCaseInput(blockers: CanonicalBlocker[] = [correctable]): CaseCreationInput {
  return {
    sourceRunId: "run-1", ownerUserId: "user-1", repositoryId: "repo-1", sourceState: "VERIFICATION_INCOMPLETE",
    sourceStateVersion: 4, baseCommitSha: "a".repeat(40), manifestHash: SOURCE_MANIFEST, requiredLaneContractHash: sha256({ contract: 1 }),
    blockers, preVerificationCandidateDigest: null, sourceActualMicrousd: 2_000_000, priorReplacementActualMicrousd: 0,
    ambiguousLiabilityMicrousd: 0, cumulativeCeilingMicrousd: 10_000_000, pricingPolicyDigest: PRICING, sourceClassExcluded: false,
  };
}

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "zintus-replacement-run-"));
  const dbPath = join(root, "engineer.db");
  new EngineerLedger(dbPath).close();
  const db = new Database(dbPath);
  db.exec("PRAGMA foreign_keys=ON");
  db.exec("PRAGMA busy_timeout=5000");
  const now = "2026-07-19T00:00:00.000Z";
  db.query("INSERT INTO users(id,email,created_at,updated_at) VALUES ('user-1',NULL,?,?)").run(now, now);
  db.query("INSERT INTO repository_connections(id,user_id,provider,owner,name,created_at,updated_at) VALUES ('repo-1','user-1','local','local','repo',?,?)").run(now, now);
  db.query(`INSERT INTO engineer_runs(id,user_id,repository_id,base_branch,base_commit_sha,request_original,request_normalized,state,state_version,manifest_hash,risk_tier,human_gate_required,created_at,updated_at)
    VALUES ('run-1','user-1','repo-1','main',?,'build the thing','build the thing','VERIFICATION_INCOMPLETE',4,?,'MEDIUM',1,?,?)`).run("a".repeat(40), SOURCE_MANIFEST, now, now);
  db.query("INSERT INTO task_manifest_versions(id,run_id,version,manifest_hash,manifest_json,created_at) VALUES ('tmv-1','run-1',1,?,'{}',?)").run(SOURCE_MANIFEST, now);
  fixture = { root, db, clock: { current: new Date(now) } };
});

afterEach(() => {
  fixture.db.close();
  rmSync(fixture.root, { recursive: true, force: true });
});

function deskWith(factory?: ReplacementRunFactory): ResolutionDesk {
  return new ResolutionDesk(fixture.db, SECRET, KEY_ID, () => fixture.clock.current, factory);
}

function issueCorrected(desk: ResolutionDesk): { caseId: string; directiveId: string } {
  const view = desk.createCase(baseCaseInput());
  const { directive } = desk.issueDirective(view.caseId, {
    type: "CREATE_CORRECTED_RUN", caseVersion: 0, sourceRunVersion: 4,
    budget: { maxCostUsd: 3, maxTokens: 5000, maxActiveSeconds: 1200, pricingPolicyDigest: PRICING },
  }, "idem-1");
  return { caseId: view.caseId, directiveId: directive.directiveId };
}

const count = (sql: string, ...args: (string | number)[]): number => (fixture.db.query(sql).get(...args) as { c: number }).c;

describe("executable replacement dispatch (fenced factory)", () => {
  test("creates a real replacement run at its start state with fresh manifest + budget and zero inherited evidence", () => {
    const factory = new RealReplacementRunFactory();
    const desk = deskWith(factory);
    const { directiveId } = issueCorrected(desk);
    const { replacementRunId, state } = desk.applyDirective(directiveId, "apply-1");
    expect(state).toBe("READY");

    // Real run exists at the state-machine start, version 0, distinct from the source.
    const run = fixture.db.query("SELECT state,state_version,repository_id,base_commit_sha FROM engineer_runs WHERE id=?").get(replacementRunId) as { state: string; state_version: number; repository_id: string; base_commit_sha: string } | null;
    expect(run).toEqual({ state: "REQUEST_RECEIVED", state_version: 0, repository_id: "repo-1", base_commit_sha: "a".repeat(40) });

    // Fresh budget from the directive (3 USD / 5000 tok / 1200 s).
    const budget = fixture.db.query("SELECT cost_limit_usd,token_limit,time_limit_seconds FROM run_budgets WHERE run_id=?").get(replacementRunId);
    expect(budget).toEqual({ cost_limit_usd: 3, token_limit: 5000, time_limit_seconds: 1200 });

    // Fresh manifest freeze derived from the source manifest + open blockers, and NOT equal to the source manifest.
    const manifest = fixture.db.query("SELECT manifest_hash FROM task_manifest_versions WHERE run_id=?").get(replacementRunId) as { manifest_hash: string };
    expect(manifest.manifest_hash).toBe(factory.freshManifestHashes[0]!);
    expect(manifest.manifest_hash).not.toBe(SOURCE_MANIFEST);

    // Nothing inherited: no evidence / review / approval / publication rows carry over.
    expect(count("SELECT COUNT(*) AS c FROM agent_executions WHERE run_id=?", replacementRunId)).toBe(0);
    expect(count("SELECT COUNT(*) AS c FROM failure_records WHERE run_id=?", replacementRunId)).toBe(0);
    expect(count("SELECT COUNT(*) AS c FROM approval_requests WHERE run_id=?", replacementRunId)).toBe(0);
    expect(count("SELECT COUNT(*) AS c FROM git_operations WHERE run_id=?", replacementRunId)).toBe(0);
    expect(count("SELECT COUNT(*) AS c FROM verified_candidate_checkpoints WHERE run_id=?", replacementRunId)).toBe(0);

    // The linked replacement is READY and the lineage verifier accepts the chain.
    expect(fixture.db.query("SELECT state FROM resolution_replacements WHERE replacement_run_id=?").get(replacementRunId)).toEqual({ state: "READY" });
    const verdict = new ResolutionLineageVerifier(fixture.db, SECRET).verify(replacementRunId);
    expect(verdict).toMatchObject({ verified: true, sourceRunId: "run-1", kind: "CORRECTED" });
  });

  test("a crash during run creation rolls back atomically — no executable orphan, case stays DIRECTIVE_ISSUED", () => {
    const { directiveId } = issueCorrected(deskWith());
    const crashing: ReplacementRunFactory = { createReplacementRun: () => { throw new Error("simulated crash between PREPARING and READY"); } };
    const desk = deskWith(crashing);
    const replacementRunId = `resolution-${sha256({ directiveId, kind: "CORRECTED" }).slice("sha256:".length, "sha256:".length + 24)}`;
    expect(() => desk.applyDirective(directiveId, "apply-crash")).toThrow(/simulated crash/);
    // Everything rolled back together: no replacement, no orphan run, case unresolved.
    expect(count("SELECT COUNT(*) AS c FROM resolution_replacements")).toBe(0);
    expect(count("SELECT COUNT(*) AS c FROM engineer_runs WHERE id=?", replacementRunId)).toBe(0);
    expect(fixture.db.query("SELECT state FROM resolution_cases").get()).toEqual({ state: "DIRECTIVE_ISSUED" });
  });

  test("recovery resolves a committed PREPARING orphan to FAILED and terminalizes its run (never executable)", () => {
    const factory = new RealReplacementRunFactory();
    const desk = deskWith(factory);
    const { directiveId } = issueCorrected(desk);
    const { replacementRunId } = desk.applyDirective(directiveId, "apply-1");

    // Simulate a crash-committed PREPARING scaffold (the atomic happy path never
    // leaves one, so construct it by bypassing the fence) with its real run.
    fixture.db.exec("DROP TRIGGER fence_resolution_replacement_update_v31");
    fixture.db.query("UPDATE resolution_replacements SET state='PREPARING' WHERE replacement_run_id=?").run(replacementRunId);

    const { resolved } = desk.recoverPreparingReplacements();
    expect(resolved).toEqual([replacementRunId]);
    expect(fixture.db.query("SELECT state FROM resolution_replacements WHERE replacement_run_id=?").get(replacementRunId)).toEqual({ state: "FAILED" });
    const run = fixture.db.query("SELECT state,terminal_at FROM engineer_runs WHERE id=?").get(replacementRunId) as { state: string; terminal_at: string | null };
    expect(run.state).toBe("FAILED");
    expect(run.terminal_at).not.toBeNull();
  });

  test("without a factory the desk keeps the pair-1 scaffold-only behavior (no engineer run created)", () => {
    const desk = deskWith();
    const { directiveId } = issueCorrected(desk);
    const { replacementRunId, state } = desk.applyDirective(directiveId, "apply-1");
    expect(state).toBe("READY");
    expect(count("SELECT COUNT(*) AS c FROM engineer_runs WHERE id=?", replacementRunId)).toBe(0);
  });
});
