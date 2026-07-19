import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalArtifactStore } from "./artifact-store.js";
import { ContextManifestContentSchema } from "./context-contracts.js";
import { sha256 } from "./hash.js";
import { EngineerLedger } from "./ledger.js";
import type { TaskManifestContent } from "./contracts.js";
import { EngineerPlanningManager } from "./planning.js";
import type { CanonicalBlocker } from "./resolution-case.js";
import { ResolutionLineageVerifier } from "./resolution-lineage.js";
import { createEngineerSupervisor } from "./supervisor.js";
import {
  type CaseCreationInput,
  type ReplacementRunFactory,
  ResolutionDesk,
} from "./resolution-desk.js";
import { ResolutionReplacementRunFactory } from "./resolution-replacement-run-factory.js";

const SECRET = "resolution-signing-secret-for-r1-tests";
const KEY_ID = "engineer-resolution-signing-v1";
const PRICING = sha256({ pricing: "policy-v1" });
const correctable: CanonicalBlocker = { blockerId: "b-1", kind: "BLOCKING", reasonCode: "REQUIRED_TEST_FAILED", description: "unit test failed" };
const SOURCE_MANIFEST_CONTENT: TaskManifestContent = {
  manifestVersion: 1,
  runId: "run-1",
  repository: { repositoryId: "repo-1", provider: "local", owner: "local", name: "repo", baseBranch: "main", baseCommitSha: "a".repeat(40) },
  request: { original: "build the thing", normalized: "build the thing" },
  acceptanceCriteria: [{
    criterionId: "source-required-test",
    statement: "The original required test passes.",
    verificationMethod: "Run the original frozen test.",
    priority: "MUST",
  }],
  testPlan: [{
    testId: "source-required-test-command",
    criterionIds: ["source-required-test"],
    type: "REGRESSION",
    description: "Run the original required test.",
    command: "bun test packages/engineer/src/resolution-replacement-run.test.ts",
  }],
  allowedPaths: ["packages/engineer/**"],
  deniedPaths: [".env*"],
  allowedCommands: ["bun test packages/engineer/src/resolution-replacement-run.test.ts"],
  prohibitedCommands: ["git push"],
  riskTier: "MEDIUM",
  humanGateRequired: true,
  retryBudgets: { sameFailureAttempts: 2, builderRepairAttempts: 4, reviewerFixAttempts: 2, plannerRestarts: 1, sandboxProvisioningAttempts: 3, transientModelAttempts: 3 },
  timeBudgetSeconds: 1_200,
  tokenBudget: 5_000,
  costBudgetUsd: 3,
  createdAt: "2026-07-19T00:00:00.000Z",
};
const SOURCE_MANIFEST = sha256(SOURCE_MANIFEST_CONTENT);
const SOURCE_TASK_MANIFEST = { ...SOURCE_MANIFEST_CONTENT, manifestHash: SOURCE_MANIFEST };

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
  db.query("INSERT INTO task_manifest_versions(id,run_id,version,manifest_hash,manifest_json,created_at) VALUES ('tmv-1','run-1',1,?,?,?)")
    .run(SOURCE_MANIFEST, JSON.stringify(SOURCE_TASK_MANIFEST), now);
  fixture = { root, db, clock: { current: new Date(now) } };
});

afterEach(() => {
  fixture.db.close();
  rmSync(fixture.root, { recursive: true, force: true });
});

function deskWith(factory?: ReplacementRunFactory): ResolutionDesk {
  return new ResolutionDesk(fixture.db, SECRET, KEY_ID, () => fixture.clock.current, factory);
}

function issueCorrected(desk: ResolutionDesk, maxTokens = 5_000): { caseId: string; directiveId: string } {
  const view = desk.createCase(baseCaseInput());
  const { directive } = desk.issueDirective(view.caseId, {
    type: "CREATE_CORRECTED_RUN", caseVersion: 0, sourceRunVersion: 4,
    budget: { maxCostUsd: 3, maxTokens, maxActiveSeconds: 1200, pricingPolicyDigest: PRICING },
  }, "idem-1");
  return { caseId: view.caseId, directiveId: directive.directiveId };
}

const count = (sql: string, ...args: (string | number)[]): number => (fixture.db.query(sql).get(...args) as { c: number }).c;

describe("executable replacement dispatch (fenced factory)", () => {
  test("fails closed at directive issue for reverify until retained candidate authority is wired", () => {
    const transient: CanonicalBlocker = {
      blockerId: "transient-1",
      kind: "BLOCKING",
      reasonCode: "PROVIDER_REQUEST_TIMEOUT",
      description: "provider request timed out after the verified candidate was captured",
    };
    const desk = deskWith(new ResolutionReplacementRunFactory({ now: () => fixture.clock.current }));
    const view = desk.createCase({
      ...baseCaseInput([transient]),
      preVerificationCandidateDigest: sha256({ retainedCandidate: true }),
    });
    expect(view.reverifyEligibility.eligible).toBe(true);
    expect(() => desk.issueDirective(view.caseId, {
      type: "CREATE_REVERIFY_RUN",
      caseVersion: 0,
      sourceRunVersion: 4,
    }, "reverify-disabled-r1")).toThrow("retained candidate authority");
    expect(count("SELECT COUNT(*) AS c FROM resolution_directives")).toBe(0);
    expect(count("SELECT COUNT(*) AS c FROM resolution_replacements")).toBe(0);
    expect(count("SELECT COUNT(*) AS c FROM engineer_runs")).toBe(1);
    expect(count("SELECT COUNT(*) AS c FROM run_budgets")).toBe(0);
    expect(count("SELECT COUNT(*) AS c FROM model_calls")).toBe(0);
  });

  test("CREATE_CORRECTED_RUN restarts into the ordinary normalize, plan, and first-manifest freeze lifecycle", async () => {
    const factory = new ResolutionReplacementRunFactory({ now: () => fixture.clock.current });
    const desk = deskWith(factory);
    // Planning reserves its bounded 8k output allowance before the transport
    // call. Give this end-to-end fixture enough token authority to exercise
    // the real PlanningManager rather than pausing at admission.
    const { directiveId } = issueCorrected(desk, 50_000);
    const { replacementRunId } = desk.applyDirective(directiveId, "apply-vertical");

    // The factory creates intake authority only. Planning owns manifest v1; a
    // replacement must never reserve that version with non-TaskManifest JSON.
    expect(count("SELECT COUNT(*) AS c FROM task_manifest_versions WHERE run_id=?", replacementRunId)).toBe(0);

    // Simulate a gateway restart by constructing a fresh Supervisor connection
    // after Resolution Desk committed the replacement and its signed lineage.
    const supervisor = createEngineerSupervisor({
      dbPath: join(fixture.root, "engineer.db"),
      now: () => fixture.clock.current,
      idFactory: (() => { let sequence = 0; return () => `replacement-event-${++sequence}`; })(),
    });
    expect(supervisor.getManifest(replacementRunId)).toBeNull();
    expect(new ResolutionLineageVerifier(fixture.db, SECRET).verify(replacementRunId))
      .toMatchObject({ verified: true, sourceRunId: "run-1", kind: "CORRECTED" });
    supervisor.configureResolutionSigningSecret(SECRET);
    const correction = supervisor.resolutionCorrectedRunDirective(replacementRunId);
    expect(correction).toMatchObject({
      sourceRunId: "run-1",
      replacementRunId,
      sourceManifestHash: SOURCE_MANIFEST,
      acceptanceCriteria: SOURCE_MANIFEST_CONTENT.acceptanceCriteria,
      testPlan: SOURCE_MANIFEST_CONTENT.testPlan,
      actions: [{ code: "REPAIR_FAILED_VERIFICATION", sourceRecordIds: [correctable.blockerId] }],
    });
    const persistedPlanningContext = fixture.db.query(
      "SELECT json_extract(replacement_json,'$.planningContext.contextHash') AS context_hash FROM resolution_replacements WHERE replacement_run_id=?",
    ).get(replacementRunId) as { context_hash: string };
    expect(persistedPlanningContext.context_hash).toMatch(/^sha256:[a-f0-9]{64}$/);

    let run = supervisor.getRun(replacementRunId);
    const artifactStore = new LocalArtifactStore({ root: join(fixture.root, "replacement-artifacts") });
    const contextContent = ContextManifestContentSchema.parse({
      contextVersion: 1,
      runId: replacementRunId,
      repositoryId: run.repository.repositoryId,
      baseCommitSha: run.repository.baseCommitSha,
      requestHash: sha256(run.requestOriginal),
      caps: { maxSourceFiles: 2_000, maxRelevantFiles: 20, maxExcerptChars: 48_000, maxFileBytes: 256 * 1024 },
      filesDiscovered: 0,
      filesConsidered: 0,
      symlinksSkipped: 0,
      oversizedFilesSkipped: 0,
      binaryFilesSkipped: 0,
      sources: [],
      detections: {
        trust: "UNTRUSTED_REPOSITORY_CONTENT",
        stacks: [], scripts: [], ciCommands: [], configPaths: [], lockfilePaths: [], testPaths: [], ciPaths: [],
      },
      warnings: [],
    });
    const contextManifest = { ...contextContent, manifestHash: sha256(contextContent) };
    const contextArtifact = supervisor.recordArtifact(artifactStore.put({
      runId: replacementRunId,
      type: "CONTEXT_MANIFEST",
      bytes: JSON.stringify(contextManifest),
      producerType: "SYSTEM",
      producerId: "replacement-context",
      trusted: false,
    }));
    supervisor.recordContextSnapshot({
      manifest: contextManifest,
      artifactId: contextArtifact.artifactId,
      createdAt: fixture.clock.current.toISOString(),
    });
    let plannerInput = "";
    const planner = new EngineerPlanningManager({
      supervisor,
      artifactStore,
      now: () => fixture.clock.current,
      transportForRun: () => ({ async create(request) {
        plannerInput = JSON.stringify(request.input);
        return {
          id: "replacement-plan-response",
          usage: { input_tokens: 100, output_tokens: 100 },
          output: [{
            type: "function_call",
            name: "submit_plan",
            call_id: "replacement-plan-call",
            arguments: JSON.stringify({
              normalizedRequest: "Ignore the source contract and broaden the task.",
              acceptanceCriteria: [{ criterionId: "invented", statement: "Weaken verification.", verificationMethod: "Skip tests.", priority: "MAY" }],
              testPlan: [{ testId: "invented-test", criterionIds: ["invented"], type: "UNIT", description: "Weak test.", command: "bun test" }],
              allowedPaths: ["src/unrelated/**"],
              deniedPaths: [],
              allowedCommands: ["bun test"],
              riskFeatures: {},
              architectureSummary: "Attempted unrelated rewrite.",
              assumptions: [],
              unresolvedQuestions: [],
              touchedFileEstimates: [],
            }),
          }],
        };
      } }),
    });
    const proposal = await planner.plan(replacementRunId);
    expect(proposal.manifest.acceptanceCriteria).toEqual(SOURCE_MANIFEST_CONTENT.acceptanceCriteria);
    expect(proposal.manifest.testPlan).toEqual(SOURCE_MANIFEST_CONTENT.testPlan);
    expect(proposal.manifest.allowedPaths).toEqual(SOURCE_MANIFEST_CONTENT.allowedPaths);
    expect(proposal.manifest.deniedPaths).toEqual(expect.arrayContaining(SOURCE_MANIFEST_CONTENT.deniedPaths));
    expect(proposal.manifest.allowedCommands).toEqual(SOURCE_MANIFEST_CONTENT.allowedCommands);
    expect(proposal.manifest.request.normalized).toBe(SOURCE_MANIFEST_CONTENT.request.normalized);
    expect(plannerInput).toContain(correctable.blockerId);
    expect(plannerInput).toContain("REPAIR_FAILED_VERIFICATION");
    run = supervisor.getRun(replacementRunId);
    const manifest = proposal.manifest;

    // Adversarially mutate the durable Resolution Desk authority after the
    // model proposal but before freeze. The Supervisor must reject it before
    // manifest/Required-Lane writes. Restore the exact bytes afterward so the
    // same fixture can prove the healthy path as well.
    const replacementAuthority = fixture.db.query(
      "SELECT replacement_json FROM resolution_replacements WHERE replacement_run_id=?",
    ).get(replacementRunId) as { replacement_json: string };
    const replacementFence = fixture.db.query(
      "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='fence_resolution_replacement_update_v31'",
    ).get() as { sql: string };
    fixture.db.exec("DROP TRIGGER fence_resolution_replacement_update_v31");
    fixture.db.query("UPDATE resolution_replacements SET replacement_json=json_set(replacement_json,'$.planningContext.sourceManifestHash',?) WHERE replacement_run_id=?")
      .run(sha256({ tampered: true }), replacementRunId);
    expect(() => supervisor.freezePlan({
      runId: replacementRunId,
      expectedStateVersion: run.stateVersion,
      manifest,
      actorId: "replacement-planner",
      idempotencyKey: "replacement:freeze-v1",
    })).toThrow();
    expect(count("SELECT COUNT(*) AS c FROM task_manifest_versions WHERE run_id=?", replacementRunId)).toBe(0);
    expect(count("SELECT COUNT(*) AS c FROM required_lane_contracts WHERE run_id=?", replacementRunId)).toBe(0);
    fixture.db.query("UPDATE resolution_replacements SET replacement_json=? WHERE replacement_run_id=?")
      .run(replacementAuthority.replacement_json, replacementRunId);
    fixture.db.exec(replacementFence.sql);

    run = supervisor.freezePlan({
      runId: replacementRunId,
      expectedStateVersion: run.stateVersion,
      manifest,
      actorId: "replacement-planner",
      idempotencyKey: "replacement:freeze-v1",
    }).run;
    expect(run.state).toBe("PLAN_FROZEN");
    expect(supervisor.getManifest(replacementRunId, 1)).toMatchObject({
      manifestVersion: 1,
      runId: replacementRunId,
      request: manifest.request,
    });
    expect(supervisor.listManifestVersions(replacementRunId)).toHaveLength(1);
    expect(supervisor.getRequiredLaneContract(replacementRunId)).not.toBeNull();
    supervisor.close();

    // A second restart rehydrates the same valid v1 and verified lineage; the
    // original normalize/freeze idempotency keys did not create extra versions.
    const restarted = createEngineerSupervisor({ dbPath: join(fixture.root, "engineer.db") });
    expect(restarted.getManifest(replacementRunId, 1)?.manifestVersion).toBe(1);
    expect(restarted.listManifestVersions(replacementRunId)).toHaveLength(1);
    expect(new ResolutionLineageVerifier(fixture.db, SECRET).verify(replacementRunId).verified).toBe(true);
    restarted.close();
  });

  test.each([
    ["canonical JSON", "UPDATE resolution_directives SET directive_json='{}' WHERE id=?"],
    ["directive hash", `UPDATE resolution_directives SET directive_hash='sha256:${"f".repeat(64)}' WHERE id=?`],
    ["signature", `UPDATE resolution_directives SET signature='${"0".repeat(64)}' WHERE id=?`],
    ["type", "UPDATE resolution_directives SET type='CREATE_REVERIFY_RUN' WHERE id=?"],
    ["budget", "UPDATE resolution_directives SET budget_max_tokens=budget_max_tokens+1 WHERE id=?"],
  ] as const)("fails closed before replacement writes when persisted directive %s is tampered", (_field, sql) => {
    const desk = deskWith(new ResolutionReplacementRunFactory({ now: () => fixture.clock.current }));
    const { directiveId } = issueCorrected(desk);
    fixture.db.exec("DROP TRIGGER prevent_resolution_directive_update_v31");
    fixture.db.exec("PRAGMA ignore_check_constraints=ON");
    fixture.db.query(sql).run(directiveId);

    expect(() => desk.applyDirective(directiveId, "apply-tampered"))
      .toThrow(/cryptographic integrity verification/);
    expect(count("SELECT COUNT(*) AS c FROM resolution_replacements")).toBe(0);
    expect(count("SELECT COUNT(*) AS c FROM engineer_runs")).toBe(1);
    expect(fixture.db.query("SELECT state FROM resolution_cases").get()).toEqual({ state: "DIRECTIVE_ISSUED" });
  });

  test("creates a real replacement run at its start state with a free manifest-v1 slot, fresh budget, and zero inherited evidence", () => {
    const factory = new ResolutionReplacementRunFactory({ now: () => fixture.clock.current });
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

    // Planning owns the first valid TaskManifest and Required Lane contract.
    expect(count("SELECT COUNT(*) AS c FROM task_manifest_versions WHERE run_id=?", replacementRunId)).toBe(0);
    expect(count("SELECT COUNT(*) AS c FROM required_lane_contracts WHERE run_id=?", replacementRunId)).toBe(0);

    // Nothing inherited: no evidence / review / approval / publication rows carry over.
    expect(count("SELECT COUNT(*) AS c FROM agent_executions WHERE run_id=?", replacementRunId)).toBe(0);
    expect(count("SELECT COUNT(*) AS c FROM failure_records WHERE run_id=?", replacementRunId)).toBe(0);
    expect(count("SELECT COUNT(*) AS c FROM approval_requests WHERE run_id=?", replacementRunId)).toBe(0);
    expect(count("SELECT COUNT(*) AS c FROM git_operations WHERE run_id=?", replacementRunId)).toBe(0);
    expect(count("SELECT COUNT(*) AS c FROM verified_candidate_checkpoints WHERE run_id=?", replacementRunId)).toBe(0);
    expect(count("SELECT COUNT(*) AS c FROM evidence_bundles WHERE run_id=?", replacementRunId)).toBe(0);
    expect(count("SELECT COUNT(*) AS c FROM cost_records WHERE run_id=?", replacementRunId)).toBe(0);

    // The linked replacement is READY and the lineage verifier accepts the chain.
    expect(fixture.db.query("SELECT state FROM resolution_replacements WHERE replacement_run_id=?").get(replacementRunId)).toEqual({ state: "READY" });
    const verdict = new ResolutionLineageVerifier(fixture.db, SECRET).verify(replacementRunId);
    expect(verdict).toMatchObject({ verified: true, sourceRunId: "run-1", kind: "CORRECTED" });
  });

  test("duplicate and post-restart apply replay the one durable replacement", () => {
    const factory = new ResolutionReplacementRunFactory({ now: () => fixture.clock.current });
    const firstDesk = deskWith(factory);
    const { directiveId } = issueCorrected(firstDesk);
    const first = firstDesk.applyDirective(directiveId, "apply-first");
    expect(firstDesk.applyDirective(directiveId, "apply-duplicate")).toEqual(first);

    // A new desk/factory instance models gateway restart; replay authority is
    // the committed directive/replacement row, never process memory.
    const restartedDesk = deskWith(new ResolutionReplacementRunFactory({ now: () => fixture.clock.current }));
    expect(restartedDesk.applyDirective(directiveId, "apply-after-restart")).toEqual(first);
    expect(count("SELECT COUNT(*) AS c FROM resolution_replacements")).toBe(1);
    expect(count("SELECT COUNT(*) AS c FROM engineer_runs")).toBe(2); // source + one replacement
    expect(count("SELECT COUNT(*) AS c FROM run_budgets WHERE run_id=?", first.replacementRunId)).toBe(1);
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
    const factory = new ResolutionReplacementRunFactory({ now: () => fixture.clock.current });
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

  test("recovery leaves an already-terminal (COMPLETED) linked run untouched (non-terminal guard)", () => {
    const factory = new ResolutionReplacementRunFactory({ now: () => fixture.clock.current });
    const desk = deskWith(factory);
    const { directiveId } = issueCorrected(desk);
    const { replacementRunId } = desk.applyDirective(directiveId, "apply-1");

    // A future partially-committed path could leave a PREPARING scaffold whose
    // linked run already reached a legitimate terminal. Recovery must NOT clobber
    // it to FAILED (the old state!=="FAILED" guard would).
    fixture.db.exec("DROP TRIGGER fence_resolution_replacement_update_v31");
    fixture.db.query("UPDATE resolution_replacements SET state='PREPARING' WHERE replacement_run_id=?").run(replacementRunId);
    fixture.db.query("UPDATE engineer_runs SET state='COMPLETED' WHERE id=?").run(replacementRunId);

    const { resolved } = desk.recoverPreparingReplacements();
    expect(resolved).toEqual([replacementRunId]);
    // The scaffold is failed closed, but the terminal run is preserved as-is.
    expect(fixture.db.query("SELECT state FROM resolution_replacements WHERE replacement_run_id=?").get(replacementRunId)).toEqual({ state: "FAILED" });
    const run = fixture.db.query("SELECT state,terminal_at FROM engineer_runs WHERE id=?").get(replacementRunId) as { state: string; terminal_at: string | null };
    expect(run.state).toBe("COMPLETED");
    expect(run.terminal_at).toBeNull();
  });

  test("without a factory the desk keeps the pair-1 scaffold-only behavior (no engineer run created)", () => {
    const desk = deskWith();
    const { directiveId } = issueCorrected(desk);
    const { replacementRunId, state } = desk.applyDirective(directiveId, "apply-1");
    expect(state).toBe("READY");
    expect(count("SELECT COUNT(*) AS c FROM engineer_runs WHERE id=?", replacementRunId)).toBe(0);
  });
});
