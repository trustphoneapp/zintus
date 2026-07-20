import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "./hash.js";
import { EngineerLedger } from "./ledger.js";
import { deriveCaseCreationInput, serverPricingPolicyDigest } from "./resolution-case-derivation.js";
import { ResolutionDesk } from "./resolution-desk.js";

const SECRET = "resolution-signing-secret";
const KEY_ID = "engineer-resolution-signing-v1";
const NOW = "2026-07-19T00:00:00.000Z";

interface Fixture { root: string; db: Database }
let fixture: Fixture;

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "zintus-derivation-"));
  const dbPath = join(root, "engineer.db");
  new EngineerLedger(dbPath).close();
  const db = new Database(dbPath);
  // Pure-read derivation fixture: drop every trigger and relax foreign keys so
  // scenarios can insert exactly the durable rows they exercise.
  for (const trigger of db.query("SELECT name FROM sqlite_master WHERE type='trigger'").all() as Array<{ name: string }>) {
    db.exec(`DROP TRIGGER IF EXISTS "${trigger.name}"`);
  }
  db.exec("PRAGMA foreign_keys=OFF");
  db.query("INSERT INTO users(id,email,created_at,updated_at) VALUES ('user-1',NULL,?,?)").run(NOW, NOW);
  db.query("INSERT INTO repository_connections(id,user_id,provider,owner,name,created_at,updated_at) VALUES ('repo-1','user-1','local','local','repo',?,?)").run(NOW, NOW);
  fixture = { root, db };
});

afterEach(() => {
  fixture.db.close();
  rmSync(fixture.root, { recursive: true, force: true });
});

function insertRun(runId: string, state: string, options: { lifetimeCostUsd?: number } = {}): void {
  const db = fixture.db;
  db.query(`INSERT INTO engineer_runs(id,user_id,repository_id,base_branch,base_commit_sha,request_original,request_normalized,state,state_version,manifest_hash,risk_tier,human_gate_required,created_at,updated_at)
    VALUES (?,'user-1','repo-1','main',?,'build','build',?,4,?,'MEDIUM',1,?,?)`)
    .run(runId, "a".repeat(40), state, sha256({ manifest: runId }), NOW, NOW);
  db.query(`INSERT INTO run_budgets(run_id,cost_limit_usd,token_limit,time_limit_seconds,lifetime_cost_limit_usd,lifetime_token_limit,lifetime_time_limit_seconds,status,created_at,updated_at)
    VALUES (?,1,1000,3600,?,1000000,86400,'ACTIVE',?,?)`)
    .run(runId, options.lifetimeCostUsd ?? 10, NOW, NOW);
}

function insertCost(runId: string, id: string, sourceType: string, costUsd: number, reservationStatus = "ACTIVE"): void {
  fixture.db.query(`INSERT INTO cost_records(id,run_id,source_type,source_id,estimated_cost_usd,reservation_status,created_at)
    VALUES (?,?,?,?,?,?,?)`).run(id, runId, sourceType, `${id}-src`, costUsd, reservationStatus, NOW);
}

function insertFailure(runId: string, id: string, failureClass: string, reasonCode: string, underlyingCause?: string): void {
  fixture.db.query(`INSERT INTO failure_records(id,run_id,failure_class,reason_code,fingerprint,evidence_ids_json,retryable,underlying_cause,created_at)
    VALUES (?,?,?,?,?, '[]',0,?,?)`).run(id, runId, failureClass, reasonCode, sha256({ f: id }), underlyingCause ?? null, NOW);
}

function insertSecurity(runId: string, id: string, severity: string, status = "OPEN"): void {
  fixture.db.query(`INSERT INTO security_findings(id,run_id,severity,category,description,evidence_ids_json,status,created_at)
    VALUES (?,?,?,'injection','SQL injection risk','[]',?,?)`).run(id, runId, severity, status, NOW);
}

function insertReviewFinding(runId: string, sessionId: string, findingId: string, severity: string, status = "OPEN"): void {
  const db = fixture.db;
  const exists = db.query("SELECT 1 FROM reviewer_sessions WHERE id=?").get(sessionId);
  if (!exists) {
    db.query(`INSERT INTO reviewer_sessions(id,run_id,attempt,model_tier,resolved_model,input_hash,manifest_hash,diff_hash,evidence_bundle_hash,policy_version,cache_hit,started_at,isolation_verified)
      VALUES (?,?,1,'GPT-5.6_SOL','gpt-5.6-sol',?,?,?,?,'review-v1',0,?,1)`)
      .run(sessionId, runId, sha256({ i: sessionId }), sha256({ m: sessionId }), sha256({ d: sessionId }), sha256({ e: sessionId }), NOW);
  }
  db.query(`INSERT INTO review_findings(id,reviewer_session_id,fingerprint,severity,category,file,line_start,line_end,description,required_change,criterion_ids_json,evidence_ids_json,status)
    VALUES (?,?,?,?,'correctness','a.ts',1,2,'bug','fix it','[]','[]',?)`)
    .run(findingId, sessionId, sha256({ rf: findingId }), severity, status);
}

function insertCandidate(runId: string): string {
  const hash = sha256({ candidate: runId });
  fixture.db.query(`INSERT INTO verified_candidate_checkpoints
    (id,checkpoint_hash,run_id,requester_user_id,repository_id,required_lane_contract_hash,manifest_hash,base_commit_sha,result_commit_sha,diff_hash,reviewer_session_id,classification_hash,classification_result,evidence_bundle_id,evidence_bundle_hash,environment_digest,checkpoint_json,statement_json,statement_hash,signature_algorithm,signature_key_id,signature,created_at)
    VALUES (?,?,?,'user-1','repo-1',?,?,?,?,?,'sess-x',?,'READY','eb-x',?,'env','{}','{}',?,'ed25519','key-x','sig',?)`)
    .run(sha256({ id: runId }), hash, runId, sha256({ c: runId }), sha256({ manifest: runId }), "a".repeat(40), "b".repeat(40), sha256({ diff: runId }), sha256({ cls: runId }), sha256({ ebh: runId }), sha256({ st: runId }), NOW);
  return hash;
}

/** Build the case via the real desk so the assertions run through the real law. */
function deskCase(runId: string) {
  const desk = new ResolutionDesk(fixture.db, SECRET, KEY_ID, () => new Date(NOW));
  return desk.createCase(deriveCaseCreationInput(fixture.db, runId));
}

describe("deriveCaseCreationInput blocker classification", () => {
  test("(a) a failed required test is a BLOCKING correction-eligible blocker; reverify refused", () => {
    insertRun("run-1", "VERIFICATION_INCOMPLETE");
    insertFailure("run-1", "f-1", "TEST_FAILURE", "REQUIRED_TEST_FAILED");
    const view = deskCase("run-1");
    expect(view.blockers).toHaveLength(1);
    expect(view.blockers[0]).toMatchObject({ kind: "BLOCKING", reasonCode: "REQUIRED_TEST_FAILED" });
    expect(view.correctionEligible).toBe(true);
    expect(view.reverifyEligibility).toEqual({ eligible: false, reason: "CORRECTION_ELIGIBLE_BLOCKERS_PRESENT" });
  });

  test("(b) a single typed transient cause with a retained candidate is reverify-eligible", () => {
    insertRun("run-1", "VERIFICATION_INCOMPLETE");
    insertFailure("run-1", "f-1", "MODEL_FAILURE", "PROVIDER_REQUEST_TIMEOUT");
    insertCandidate("run-1");
    const view = deskCase("run-1");
    expect(view.blockers).toHaveLength(1);
    expect(view.blockers[0]).toMatchObject({ kind: "BLOCKING", reasonCode: "PROVIDER_REQUEST_TIMEOUT" });
    expect(view.correctionEligible).toBe(false);
    expect(view.reverifyEligibility).toEqual({ eligible: true, reason: "PROVIDER_REQUEST_TIMEOUT" });
  });

  test("(b') a generic PHASE3 failure with a typed transient underlying_cause surfaces as transient", () => {
    insertRun("run-1", "VERIFICATION_INCOMPLETE");
    insertFailure("run-1", "f-1", "WORKFLOW_FAILURE", "PHASE3_UNEXPECTED_FAILURE", "SANDBOX_PROVISION_TIMEOUT");
    insertCandidate("run-1");
    const view = deskCase("run-1");
    expect(view.blockers[0]!.reasonCode).toBe("SANDBOX_PROVISION_TIMEOUT");
    expect(view.reverifyEligibility).toEqual({ eligible: true, reason: "SANDBOX_PROVISION_TIMEOUT" });
  });

  test("(b'') a generic PHASE3 failure with NO typed cause stays untyped and reverify-ineligible", () => {
    insertRun("run-1", "VERIFICATION_INCOMPLETE");
    insertFailure("run-1", "f-1", "WORKFLOW_FAILURE", "PHASE3_UNEXPECTED_FAILURE");
    insertCandidate("run-1");
    const view = deskCase("run-1");
    expect(view.blockers[0]!.reasonCode).toBe("PHASE3_UNEXPECTED_FAILURE");
    expect(view.reverifyEligibility).toEqual({ eligible: false, reason: "PHASE3_CAUSE_UNTYPED" });
  });

  test("(c) mixed transient + security -> correction wins, reverify refused", () => {
    insertRun("run-1", "VERIFICATION_INCOMPLETE");
    insertFailure("run-1", "f-1", "MODEL_FAILURE", "PROVIDER_REQUEST_TIMEOUT");
    insertSecurity("run-1", "s-1", "HIGH");
    insertCandidate("run-1");
    const view = deskCase("run-1");
    expect(view.correctionEligible).toBe(true);
    expect(view.reverifyEligibility).toEqual({ eligible: false, reason: "CORRECTION_ELIGIBLE_BLOCKERS_PRESENT" });
  });

  test("(d) an open high-severity security finding is a BLOCKING correction-eligible defect", () => {
    insertRun("run-1", "SECURITY_ESCALATION");
    insertSecurity("run-1", "s-1", "CRITICAL");
    const view = deskCase("run-1");
    const security = view.blockers.find((b) => b.reasonCode === "SECURITY_FINDING");
    expect(security).toMatchObject({ kind: "BLOCKING" });
    expect(view.correctionEligible).toBe(true);
    expect(view.reverifyEligibility.eligible).toBe(false);
  });

  test("(f) a terminal non-success run with NO durable record fails closed to a BLOCKING correction", () => {
    insertRun("run-1", "FAILED");
    const view = deskCase("run-1");
    expect(view.blockers).toHaveLength(1);
    expect(view.blockers[0]).toMatchObject({ kind: "BLOCKING", reasonCode: "RUN_FAILED" });
    expect(view.correctionEligible).toBe(true);
    expect(view.reverifyEligibility.eligible).toBe(false);
    // never advisory
    expect(view.blockers.some((b) => b.kind === "ADVISORY")).toBe(false);
  });

  test("(f') an unclassifiable retry-exhaustion is BLOCKING and non-recoverable (reject-only)", () => {
    insertRun("run-1", "RETRY_BUDGET_EXHAUSTED");
    const view = deskCase("run-1");
    expect(view.blockers[0]).toMatchObject({ kind: "BLOCKING", reasonCode: "RETRY_BUDGET_EXHAUSTED" });
    expect(view.correctionEligible).toBe(false);
    expect(view.reverifyEligibility).toEqual({ eligible: false, reason: "NON_TRANSIENT_BLOCKER" });
  });

  test("advisory-only findings still leave a BLOCKING backstop (never blocker-free)", () => {
    insertRun("run-1", "FAILED");
    insertSecurity("run-1", "s-1", "LOW");
    const view = deskCase("run-1");
    expect(view.blockers.some((b) => b.kind === "ADVISORY" && b.reasonCode === "SECURITY_FINDING")).toBe(true);
    expect(view.blockers.some((b) => b.kind === "BLOCKING")).toBe(true);
  });

  test("an open blocking reviewer finding is a BLOCKING correction-eligible blocker", () => {
    insertRun("run-1", "FAILED");
    insertReviewFinding("run-1", "sess-1", "rf-1", "HIGH");
    insertReviewFinding("run-1", "sess-1", "rf-2", "INFO"); // advisory-only, must not gate
    const view = deskCase("run-1");
    expect(view.blockers.some((b) => b.kind === "BLOCKING" && b.reasonCode === "REVIEW_CHANGE_REQUIRED")).toBe(true);
    expect(view.blockers.some((b) => b.kind === "ADVISORY" && b.reasonCode === "REVIEW_ADVISORY")).toBe(true);
    expect(view.correctionEligible).toBe(true);
    expect(view.reverifyEligibility.eligible).toBe(false);
  });

  test("optional-hardening / v2 source is reverify-excluded", () => {
    insertRun("run-1", "VERIFICATION_INCOMPLETE");
    insertFailure("run-1", "f-1", "MODEL_FAILURE", "PROVIDER_REQUEST_TIMEOUT");
    insertCandidate("run-1");
    fixture.db.query(`INSERT INTO engineer_run_lineage(id,lineage_hash,schema_version,policy_version,relation,root_run_id,parent_run_id,child_run_id,requester_user_id,repository_id,parent_checkpoint_id,parent_checkpoint_hash,parent_base_commit_sha,seed_result_commit_sha,quote_id,quote_hash,consent_id,consent_hash,selection_hash,cost_microusd,tokens,time_seconds,lineage_json,created_at)
      VALUES (?,?,1,'engineer-hardening-lineage-v1','OPTIONAL_HARDENING','root-1','root-1','run-1','user-1','repo-1','cp','cph','sha','sha','q','qh','c','ch',?,1,1,1,'{}',?)`)
      .run(sha256({ l: 1 }), sha256({ lh: 1 }), sha256({ sel: 1 }), NOW);
    const view = deskCase("run-1");
    expect(view.reverifyEligibility).toEqual({ eligible: false, reason: "SOURCE_CLASS_EXCLUDED" });
  });
});

describe("stranded legacy non-terminal run adoption (Finding #6)", () => {
  // A historical run parked at HUMAN_APPROVAL_PENDING or BASE_BRANCH_STALE can
  // no longer use the retired legacy approval lane (410) — only the RETIRED
  // legacy publication manager ever entered these states, so any run found here
  // is necessarily a stranded legacy run. The 410 names the Resolution Desk as
  // the successor; the desk must therefore ADOPT these two states, deriving an
  // honest, CORRECTABLE blocker so the operator gets a real corrected-run route
  // out, with the source run's history readable throughout.
  function driveCorrectedRunEndToEnd(runId: string, expectedReasonCode: string) {
    const view = deskCase(runId);
    expect(view.blockers).toHaveLength(1);
    expect(view.blockers[0]).toMatchObject({ kind: "BLOCKING", reasonCode: expectedReasonCode });
    expect(view.correctionEligible).toBe(true);
    // never silently advisory / blocker-free
    expect(view.blockers.some((b) => b.kind === "ADVISORY")).toBe(false);

    // End-to-end: a signed corrected directive is issuable AND applyable, so the
    // operator reaches a real replacement run — not another dead end.
    const desk = new ResolutionDesk(fixture.db, SECRET, KEY_ID, () => new Date(NOW));
    const issued = desk.issueDirective(
      view.caseId,
      {
        type: "CREATE_CORRECTED_RUN",
        caseVersion: view.caseVersion,
        sourceRunVersion: 4,
        budget: { maxCostUsd: 5, maxTokens: 100_000, maxActiveSeconds: 3_600, pricingPolicyDigest: serverPricingPolicyDigest() },
      },
      `idem-${runId}`,
    );
    const applied = desk.applyDirective(issued.directive.directiveId, `apply-${runId}`);
    expect(applied.state).toBe("READY");
    expect(applied.replacementRunId).toMatch(/^resolution-/);

    // History stays readable throughout: the stranded source run row is intact.
    const sourceRow = fixture.db.query("SELECT id,state FROM engineer_runs WHERE id=?").get(runId) as
      | { id: string; state: string }
      | null;
    expect(sourceRow).not.toBeNull();
    return view;
  }

  test("a stranded HUMAN_APPROVAL_PENDING legacy run adopts into a correctable case with a corrected-run route", () => {
    insertRun("run-1", "HUMAN_APPROVAL_PENDING");
    const view = driveCorrectedRunEndToEnd("run-1", "LEGACY_HUMAN_APPROVAL_GATE_RETIRED");
    expect(view.state).toBe("OPEN"); // the freshly-opened case (pre-directive snapshot)
  });

  test("a stranded BASE_BRANCH_STALE legacy run adopts into a correctable case with a corrected-run route", () => {
    insertRun("run-1", "BASE_BRANCH_STALE");
    driveCorrectedRunEndToEnd("run-1", "LEGACY_BASE_BRANCH_STALE");
  });

  test("adoption is bounded: a genuinely live non-terminal run (not one of the two legacy gates) is still refused", () => {
    insertRun("run-1", "IMPLEMENTING");
    expect(() => deriveCaseCreationInput(fixture.db, "run-1")).toThrow(/not terminal|IMPLEMENTING/i);
    insertRun("run-2", "PLANNING");
    expect(() => deriveCaseCreationInput(fixture.db, "run-2")).toThrow(/not terminal|PLANNING/i);
    insertRun("run-3", "HUMAN_APPROVED");
    expect(() => deriveCaseCreationInput(fixture.db, "run-3")).toThrow(/not terminal|HUMAN_APPROVED/i);
  });
});

describe("deriveCaseCreationInput spend + guards", () => {
  test("(e) spend + ceiling are derived from the real cost/budget records", () => {
    insertRun("run-1", "VERIFICATION_INCOMPLETE", { lifetimeCostUsd: 10 });
    insertFailure("run-1", "f-1", "TEST_FAILURE", "REQUIRED_TEST_FAILED");
    insertCost("run-1", "c-1", "MODEL_CALL", 2.0);
    insertCost("run-1", "c-2", "MODEL_RESERVATION", 0.5, "ACTIVE");
    insertCost("run-1", "c-3", "MODEL_RESERVATION", 0.3, "AMBIGUOUS_PROVIDER_OUTCOME");
    const input = deriveCaseCreationInput(fixture.db, "run-1");
    // total 2.8, open reservations 0.8 -> settled 2.0; ambiguous 0.3; ceiling 10.
    expect(input.sourceActualMicrousd).toBe(2_000_000);
    expect(input.ambiguousLiabilityMicrousd).toBe(300_000);
    expect(input.priorReplacementActualMicrousd).toBe(0);
    expect(input.cumulativeCeilingMicrousd).toBe(10_000_000);
    expect(input.pricingPolicyDigest).toBe(serverPricingPolicyDigest());
  });

  test("prior replacement actual accumulates across the resolution lineage", () => {
    // root -> case -> directive -> replacement(child). child is the source.
    insertRun("root-1", "VERIFICATION_INCOMPLETE", { lifetimeCostUsd: 50 });
    insertCost("root-1", "rc-1", "MODEL_CALL", 4.0);
    insertRun("child-1", "VERIFICATION_INCOMPLETE", { lifetimeCostUsd: 10 });
    insertCost("child-1", "cc-1", "MODEL_CALL", 1.0);
    const db = fixture.db;
    const caseId = sha256({ resolutionCase: "root-1", owner: "user-1" });
    db.query(`INSERT INTO resolution_cases(id,case_hash,schema_version,policy_version,source_run_id,owner_user_id,repository_id,source_state,source_state_version,base_commit_sha,manifest_hash,required_lane_contract_hash,blockers_json,blocker_count,correction_eligible,reverify_eligible,reverify_reason,pre_verification_candidate_present,pre_verification_candidate_digest,source_actual_microusd,prior_replacement_actual_microusd,ambiguous_liability_microusd,cumulative_ceiling_microusd,pricing_policy_digest,case_version,state,case_json,created_at,expires_at)
      VALUES (?,?,1,'engineer-resolution-case-v1','root-1','user-1','repo-1','VERIFICATION_INCOMPLETE',4,?,?,?, '[]',0,1,0,'NO_BLOCKERS',0,NULL,4000000,0,0,50000000,?,0,'RESOLVED_CORRECTED','{}',?,?)`)
      .run(caseId, sha256({ ch: 1 }), "a".repeat(40), sha256({ manifest: "root-1" }), sha256({ c: 1 }), serverPricingPolicyDigest(), NOW, NOW);
    // The ancestor walk joins resolution_replacements -> resolution_cases only;
    // no directive row is needed (and its CHECKs are irrelevant here).
    const directiveId = "directive-placeholder-1";
    const replacementId = sha256({ r: 1 });
    db.query(`INSERT INTO resolution_replacements(id,replacement_hash,schema_version,policy_version,case_id,directive_id,directive_hash,kind,replacement_run_id,state,budget_max_cost_microusd,budget_max_tokens,budget_max_active_seconds,budget_pricing_policy_digest,replacement_json,created_at,updated_at)
      VALUES (?,?,1,'engineer-resolution-replacement-v1',?,?,?,'CORRECTED','child-1','READY',3000000,5000,1200,?, '{}',?,?)`)
      .run(replacementId, sha256({ rh: 1 }), caseId, directiveId, sha256({ dh: 1 }), serverPricingPolicyDigest(), NOW, NOW);

    const input = deriveCaseCreationInput(db, "child-1");
    expect(input.sourceActualMicrousd).toBe(1_000_000); // child settled
    expect(input.priorReplacementActualMicrousd).toBe(4_000_000); // root settled
    expect(input.cumulativeCeilingMicrousd).toBe(50_000_000); // ROOT lifetime ceiling
  });

  test("a non-terminal run is refused", () => {
    insertRun("run-1", "IMPLEMENTING");
    expect(() => deriveCaseCreationInput(fixture.db, "run-1")).toThrow(/not terminal|IMPLEMENTING/i);
  });

  test("a missing run is refused", () => {
    expect(() => deriveCaseCreationInput(fixture.db, "nope")).toThrow(/not found/i);
  });
});
