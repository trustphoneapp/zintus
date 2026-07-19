import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "./hash.js";
import { EngineerLedger } from "./ledger.js";
import type { CanonicalBlocker } from "./resolution-case.js";
import { type CaseCreationInput, ResolutionDesk, ResolutionDeskError } from "./resolution-desk.js";

const SECRET = "resolution-signing-secret";
const KEY_ID = "engineer-resolution-signing-v1";
const PRICING = sha256({ pricing: "policy-v1" });

interface Fixture {
  root: string;
  db: Database;
  desk: ResolutionDesk;
  clock: { current: Date };
  sourceRunId: string;
  ownerUserId: string;
  repositoryId: string;
  manifestHash: string;
}

let fixture: Fixture;

function baseCaseInput(fx: Fixture, blockers: CanonicalBlocker[], overrides: Partial<CaseCreationInput> = {}): CaseCreationInput {
  return {
    sourceRunId: fx.sourceRunId,
    ownerUserId: fx.ownerUserId,
    repositoryId: fx.repositoryId,
    sourceState: "VERIFICATION_INCOMPLETE",
    sourceStateVersion: 4,
    baseCommitSha: "a".repeat(40),
    manifestHash: fx.manifestHash,
    requiredLaneContractHash: sha256({ contract: 1 }),
    blockers,
    preVerificationCandidateDigest: null,
    sourceActualMicrousd: 2_000_000,
    priorReplacementActualMicrousd: 0,
    ambiguousLiabilityMicrousd: 0,
    cumulativeCeilingMicrousd: 10_000_000,
    pricingPolicyDigest: PRICING,
    sourceClassExcluded: false,
    ...overrides,
  };
}

const correctable: CanonicalBlocker = { blockerId: "b-1", kind: "BLOCKING", reasonCode: "REQUIRED_TEST_FAILED", description: "unit test failed" };
const transient: CanonicalBlocker = { blockerId: "b-2", kind: "BLOCKING", reasonCode: "PROVIDER_REQUEST_TIMEOUT", description: "provider timed out" };

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "zintus-resolution-desk-"));
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
  const manifestHash = sha256({ m: 1 });
  db.query("INSERT INTO task_manifest_versions(id,run_id,version,manifest_hash,manifest_json,created_at) VALUES ('tmv-1','run-1',1,?,'{}',?)").run(manifestHash, now);
  const clock = { current: new Date(now) };
  const desk = new ResolutionDesk(db, SECRET, KEY_ID, () => clock.current);
  fixture = { root, db, desk, clock, sourceRunId: "run-1", ownerUserId: "user-1", repositoryId: "repo-1", manifestHash };
});

afterEach(() => {
  fixture.db.close();
  rmSync(fixture.root, { recursive: true, force: true });
});

describe("case creation installs the ledger-wide source freeze", () => {
  test("creates the canonical case and derives eligibility", () => {
    const view = fixture.desk.createCase(baseCaseInput(fixture, [correctable]));
    expect(view.state).toBe("OPEN");
    expect(view.caseVersion).toBe(0);
    expect(view.correctionEligible).toBe(true);
    expect(view.reverifyEligibility).toEqual({ eligible: false, reason: "CORRECTION_ELIGIBLE_BLOCKERS_PRESENT" });
    expect(view.pricingPolicyDigest).toBe(PRICING);
    // Exactly one case per source run.
    expect(fixture.db.query("SELECT COUNT(*) AS c FROM resolution_cases").get()).toEqual({ c: 1 });
    // A CASE_OPENED event was chained.
    expect(fixture.db.query("SELECT event_type FROM resolution_events WHERE case_id=? ORDER BY sequence").all(view.caseId))
      .toEqual([{ event_type: "CASE_OPENED" }]);
  });

  test("is idempotent on the source run (a second call returns the same case, one freeze)", () => {
    const a = fixture.desk.createCase(baseCaseInput(fixture, [correctable]));
    const b = fixture.desk.createCase(baseCaseInput(fixture, [transient]));
    expect(b.caseId).toBe(a.caseId);
    expect(fixture.db.query("SELECT COUNT(*) AS c FROM resolution_cases").get()).toEqual({ c: 1 });
  });

  test.each([
    ["a state transition (run_state_events)", () => fixture.db.query(`INSERT INTO run_state_events(event_id,run_id,sequence,previous_state,next_state,reason_code,actor_type,actor_id,timestamp,evidence_ids_json,state_version,idempotency_key)
      VALUES ('e-x','run-1',9,'VERIFICATION_INCOMPLETE','IMPLEMENTING','RESUME','SYSTEM','s','2026-07-19T00:00:00.000Z','[]',9,'k-x')`).run()],
    ["a run mutation (engineer_runs UPDATE)", () => fixture.db.query("UPDATE engineer_runs SET last_error='x' WHERE id='run-1'").run()],
    ["a top-up (budget_events)", () => fixture.db.query("INSERT INTO budget_events(id,run_id,event_type,actor_id,idempotency_key,budget_revision,details_json,created_at) VALUES ('be-x','run-1','BUDGET_TOPPED_UP','u','k',1,'{}','2026-07-19T00:00:00.000Z')").run()],
    ["an approval request", () => fixture.db.query(`INSERT INTO approval_requests(id,run_id,risk_tier,requested_at,deadline_at,reminder_schedule_json,timeout_action,manifest_hash,diff_hash,evidence_bundle_hash,status)
      VALUES ('ar-x','run-1','MEDIUM','2026-07-19T00:00:00.000Z','2026-07-20T00:00:00.000Z','[]','ESCALATE',?,?,?,'PENDING')`).run(sha256({ m: 1 }), sha256({ d: 1 }), sha256({ e: 1 }))],
    ["a publication/Git operation", () => fixture.db.query(`INSERT INTO git_operations(id,run_id,operation_type,requested_by,idempotency_key,expected_base_commit_sha,status,started_at)
      VALUES ('go-x','run-1','BRANCH_PR','u','k',?,'PENDING','2026-07-19T00:00:00.000Z')`).run("a".repeat(40))],
  ] as const)("rejects %s on the frozen source", (_label, mutate) => {
    fixture.desk.createCase(baseCaseInput(fixture, [correctable]));
    expect(mutate).toThrow(/frozen/);
  });

  test("rejects worker dispatch on the frozen source once a valid running agent exists", () => {
    const now = "2026-07-19T00:00:00.000Z";
    const inputHash = sha256({ builder: 1 });
    fixture.db.query(`INSERT INTO agent_executions(id,run_id,role,model_tier,status,input_hash,output_artifact_id,started_at,completed_at)
      VALUES ('agent-1','run-1','BUILDER','GPT-5.6_TERRA','RUNNING',?,NULL,?,NULL)`).run(inputHash, now);
    fixture.desk.createCase(baseCaseInput(fixture, [correctable]));
    expect(() => fixture.db.query(`INSERT INTO builder_dispatch_claims(run_id,input_hash,agent_execution_id,model_tier,claimed_at)
      VALUES ('run-1',?,'agent-1','GPT-5.6_TERRA',?)`).run(inputHash, now)).toThrow(/frozen/);
  });

  test("a case decision (the resolution tables) is never frozen out", () => {
    const view = fixture.desk.createCase(baseCaseInput(fixture, [correctable]));
    // Issuing a directive writes resolution rows against the frozen source and must succeed.
    const result = fixture.desk.issueDirective(view.caseId, {
      type: "CREATE_CORRECTED_RUN", caseVersion: 0, sourceRunVersion: 4,
      budget: { maxCostUsd: 1, maxTokens: 1000, maxActiveSeconds: 600, pricingPolicyDigest: PRICING },
    }, "idem-1");
    expect(result.case.state).toBe("DIRECTIVE_ISSUED");
  });
});

describe("directive creation (signed, CAS, replay / conflict)", () => {
  function openCase(blockers: CanonicalBlocker[] = [correctable], overrides: Partial<CaseCreationInput> = {}) {
    return fixture.desk.createCase(baseCaseInput(fixture, blockers, overrides));
  }
  const correctedBody = { type: "CREATE_CORRECTED_RUN" as const, caseVersion: 0, sourceRunVersion: 4, budget: { maxCostUsd: 1, maxTokens: 1000, maxActiveSeconds: 600, pricingPolicyDigest: PRICING } };

  test("signs the directive with the gateway secret and advances the case", () => {
    const view = openCase();
    const { directive, case: updated } = fixture.desk.issueDirective(view.caseId, correctedBody, "idem-1");
    expect(directive.signature.algorithm).toBe("HMAC-SHA256");
    expect(directive.signature.keyId).toBe(KEY_ID);
    expect(directive.type).toBe("CREATE_CORRECTED_RUN");
    expect(directive.selectedBlockers.map((b) => b.reasonCode)).toEqual(["REQUIRED_TEST_FAILED"]);
    expect(updated.state).toBe("DIRECTIVE_ISSUED");
    expect(updated.caseVersion).toBe(1);
  });

  test("an exact byte-identical replay returns the original response", () => {
    const view = openCase();
    const first = fixture.desk.issueDirective(view.caseId, correctedBody, "idem-1");
    const replay = fixture.desk.issueDirective(view.caseId, correctedBody, "idem-1");
    expect(replay.directive.directiveHash).toBe(first.directive.directiveHash);
    expect(fixture.db.query("SELECT COUNT(*) AS c FROM resolution_directives").get()).toEqual({ c: 1 });
  });

  test("a different request under the same Idempotency-Key is 409", () => {
    const view = openCase();
    fixture.desk.issueDirective(view.caseId, correctedBody, "idem-1");
    expect(() => fixture.desk.issueDirective(view.caseId, { ...correctedBody, sourceRunVersion: 4, type: "REJECT_AND_CLOSE", budget: undefined }, "idem-1"))
      .toThrow(/Idempotency-Key/);
  });

  test.each([
    ["case version", { ...correctedBody, caseVersion: 1 }],
    ["source run version", { ...correctedBody, sourceRunVersion: 99 }],
  ] as const)("rejects a %s compare-and-swap miss", (_label, body) => {
    const view = openCase();
    expect(() => fixture.desk.issueDirective(view.caseId, body, "idem-cas")).toThrow(ResolutionDeskError);
  });

  test("two writers with distinct keys yield exactly one directive (the case is no longer OPEN)", () => {
    const view = openCase();
    fixture.desk.issueDirective(view.caseId, correctedBody, "idem-a");
    expect(() => fixture.desk.issueDirective(view.caseId, correctedBody, "idem-b")).toThrow(/OPEN/);
    expect(fixture.db.query("SELECT COUNT(*) AS c FROM resolution_directives").get()).toEqual({ c: 1 });
  });

  test("rejects a budget that breaches the root/case cumulative ceiling", () => {
    const view = openCase([correctable], { priorReplacementActualMicrousd: 6_000_000, ambiguousLiabilityMicrousd: 1_000_000, cumulativeCeilingMicrousd: 10_000_000 });
    expect(() => fixture.desk.issueDirective(view.caseId, { ...correctedBody, budget: { maxCostUsd: 4, maxTokens: 10, maxActiveSeconds: 10, pricingPolicyDigest: PRICING } }, "idem-ceil"))
      .toThrow(/ceiling/i);
  });

  test("rejects a budget whose pricing-policy digest drifts from the case", () => {
    const view = openCase();
    expect(() => fixture.desk.issueDirective(view.caseId, { ...correctedBody, budget: { maxCostUsd: 1, maxTokens: 10, maxActiveSeconds: 10, pricingPolicyDigest: sha256({ pricing: "drifted" }) } }, "idem-drift"))
      .toThrow(/pricing/i);
  });

  test("refuses a corrected directive when no blocker is correction-eligible", () => {
    const view = openCase([transient], { preVerificationCandidateDigest: sha256({ candidate: 1 }) });
    expect(() => fixture.desk.issueDirective(view.caseId, correctedBody, "idem-nc")).toThrow(/correction-eligible/);
  });

  test("refuses a reverify directive for an ineligible case", () => {
    const view = openCase([correctable]);
    expect(() => fixture.desk.issueDirective(view.caseId, { type: "CREATE_REVERIFY_RUN", caseVersion: 0, sourceRunVersion: 4 }, "idem-rv"))
      .toThrow(/reverify is ineligible/);
  });
});

describe("directive application (fenced replacement scaffold)", () => {
  test("scaffolds a corrected replacement PREPARING -> READY and resolves the case", () => {
    const view = fixture.desk.createCase(baseCaseInput(fixture, [correctable]));
    const { directive } = fixture.desk.issueDirective(view.caseId, {
      type: "CREATE_CORRECTED_RUN", caseVersion: 0, sourceRunVersion: 4,
      budget: { maxCostUsd: 2, maxTokens: 1000, maxActiveSeconds: 600, pricingPolicyDigest: PRICING },
    }, "idem-1");
    const applied = fixture.desk.applyDirective(directive.directiveId, "apply-1");
    expect(applied.state).toBe("READY");
    const replacement = fixture.db.query("SELECT state,kind FROM resolution_replacements WHERE directive_id=?").get(directive.directiveId);
    expect(replacement).toEqual({ state: "READY", kind: "CORRECTED" });
    expect(fixture.desk.getCase(view.caseId).state).toBe("RESOLVED_CORRECTED");
  });

  test("a reverify directive resolves as RESOLVED_REVERIFIED", () => {
    const view = fixture.desk.createCase(baseCaseInput(fixture, [transient], { preVerificationCandidateDigest: sha256({ candidate: 1 }) }));
    expect(view.reverifyEligibility).toEqual({ eligible: true, reason: "PROVIDER_REQUEST_TIMEOUT" });
    const { directive } = fixture.desk.issueDirective(view.caseId, { type: "CREATE_REVERIFY_RUN", caseVersion: 0, sourceRunVersion: 4 }, "idem-rv");
    const applied = fixture.desk.applyDirective(directive.directiveId, "apply-rv");
    expect(applied.state).toBe("READY");
    expect(fixture.desk.getCase(view.caseId).state).toBe("RESOLVED_REVERIFIED");
  });

  test("concurrent applies resolve to exactly one replacement (the loser replays)", () => {
    const view = fixture.desk.createCase(baseCaseInput(fixture, [correctable]));
    const { directive } = fixture.desk.issueDirective(view.caseId, {
      type: "CREATE_CORRECTED_RUN", caseVersion: 0, sourceRunVersion: 4,
      budget: { maxCostUsd: 2, maxTokens: 1000, maxActiveSeconds: 600, pricingPolicyDigest: PRICING },
    }, "idem-1");
    const a = fixture.desk.applyDirective(directive.directiveId, "apply-a");
    const b = fixture.desk.applyDirective(directive.directiveId, "apply-b");
    expect(b.replacementRunId).toBe(a.replacementRunId);
    expect(fixture.db.query("SELECT COUNT(*) AS c FROM resolution_replacements").get()).toEqual({ c: 1 });
  });

  test("an expired directive is 410 and leaves no orphan replacement", () => {
    const view = fixture.desk.createCase(baseCaseInput(fixture, [correctable]));
    const { directive } = fixture.desk.issueDirective(view.caseId, {
      type: "CREATE_CORRECTED_RUN", caseVersion: 0, sourceRunVersion: 4,
      budget: { maxCostUsd: 2, maxTokens: 1000, maxActiveSeconds: 600, pricingPolicyDigest: PRICING },
    }, "idem-1");
    fixture.clock.current = new Date(Date.parse(directive.expiresAt) + 1_000);
    expect(() => fixture.desk.applyDirective(directive.directiveId, "apply-late")).toThrow(/expired/);
    expect(fixture.db.query("SELECT COUNT(*) AS c FROM resolution_replacements").get()).toEqual({ c: 0 });
    // The case never left DIRECTIVE_ISSUED — the whole apply rolled back.
    expect(fixture.desk.getCase(view.caseId).state).toBe("DIRECTIVE_ISSUED");
  });

  test("reject-and-close resolves the case with no replacement to apply", () => {
    const view = fixture.desk.createCase(baseCaseInput(fixture, [{ blockerId: "b", kind: "BLOCKING", reasonCode: "PHASE3_UNEXPECTED_FAILURE", description: "erased" }]));
    const { directive, case: updated } = fixture.desk.issueDirective(view.caseId, { type: "REJECT_AND_CLOSE", caseVersion: 0, sourceRunVersion: 4 }, "idem-reject");
    expect(updated.state).toBe("REJECTED_CLOSED");
    expect(() => fixture.desk.applyDirective(directive.directiveId, "apply-reject")).toThrow(/no replacement/);
  });
});

describe("case durability triggers", () => {
  test("resolution rows cannot be deleted or forged out of order", () => {
    const view = fixture.desk.createCase(baseCaseInput(fixture, [correctable]));
    expect(() => fixture.db.query("DELETE FROM resolution_cases WHERE id=?").run(view.caseId)).toThrow(/durable/);
    expect(() => fixture.db.query("DELETE FROM resolution_events WHERE case_id=?").run(view.caseId)).toThrow(/immutable/);
    // An out-of-band case transition that skips a version is rejected by the fence.
    expect(() => fixture.db.query("UPDATE resolution_cases SET state='RESOLVED_CORRECTED', case_version=5 WHERE id=?").run(view.caseId))
      .toThrow(/transition mismatch/);
  });
});
