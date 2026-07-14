import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EngineerSupervisor,
  EngineerVerificationManager,
  DockerSandboxManager,
  GitWorkspaceManager,
  IndependentVerifier,
  IsolatedReviewer,
  LocalArtifactStore,
  REVIEWER_POLICY_VERSION,
  ReviewerInputSchema,
  TaskManifestSchema,
  TrustedCommandExecutor,
  TrustedEvidenceSchema,
  reviewerEvidenceBundleHash,
  sha256,
  type ResponsesTransport,
  type EngineerExecutionManager,
  type ProvisionedSandbox,
  type SandboxRecord,
  type TaskManifest,
  type WorkspaceRecord,
} from "./index.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function root(): string {
  const value = realpathSync(mkdtempSync(join(tmpdir(), "zintus-engineer-phase3-")));
  roots.push(value);
  return value;
}

const testGitSpawn = ((command: string, args: readonly string[]) => {
  const capture = mkdtempSync(join(tmpdir(), "zintus-phase3-git-"));
  const stdoutPath = join(capture, "stdout");
  const stderrPath = join(capture, "stderr");
  const result = Bun.spawnSync([
    "/bin/sh", "-c", 'out="$1"; err="$2"; shift 2; "$@" >"$out" 2>"$err"',
    "zintus-phase3-git", stdoutPath, stderrPath, command, ...args,
  ], { stdout: "ignore", stderr: "ignore" });
  const stdout = readFileSync(stdoutPath, "utf8");
  const stderr = readFileSync(stderrPath, "utf8");
  rmSync(capture, { recursive: true, force: true });
  return {
    pid: result.pid, status: result.exitCode, signal: result.signalCode == null ? null : String(result.signalCode),
    stdout, stderr, output: [null, stdout, stderr], error: undefined,
  };
}) as typeof import("node:child_process").spawnSync;

function repository(path: string): { path: string; sha: string } {
  const repo = join(path, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "value.ts"), "export const value = 2;\n");
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "test@zintus.local"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Zintus Test"]);
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "base"]);
  const head = readFileSync(join(repo, ".git", "HEAD"), "utf8").trim().slice(5);
  return { path: repo, sha: readFileSync(join(repo, ".git", head), "utf8").trim() };
}

function task(runId: string, sha: string): TaskManifest {
  const content = {
    manifestVersion: 1, runId,
    repository: { repositoryId: "repo-1", provider: "local" as const, owner: "local", name: "repo", baseBranch: "main", baseCommitSha: sha },
    request: { original: "Verify value", normalized: "Verify src/value.ts exports value 2." },
    acceptanceCriteria: [{ criterionId: "criterion-1", statement: "Value is two", verificationMethod: "unit test", priority: "MUST" as const }],
    testPlan: [{ testId: "test-1", criterionIds: ["criterion-1"], type: "UNIT" as const, description: "Run unit tests", command: "bun run test" }],
    allowedPaths: ["src/**"], deniedPaths: [], allowedCommands: ["bun run test"], prohibitedCommands: [],
    riskTier: "LOW" as const, humanGateRequired: false,
    retryBudgets: { sameFailureAttempts: 2, builderRepairAttempts: 4, reviewerFixAttempts: 2, plannerRestarts: 1, sandboxProvisioningAttempts: 3, transientModelAttempts: 3 },
    timeBudgetSeconds: 600, tokenBudget: 100_000, costBudgetUsd: 10,
    createdAt: "2026-07-14T12:00:00.000Z",
  };
  return TaskManifestSchema.parse({ ...content, manifestHash: sha256(content) });
}

function setupFastChecks(path: string) {
  const repo = repository(path);
  const supervisor = new EngineerSupervisor({ dbPath: join(path, "engineer.db") });
  const manifest = task("run-phase3", repo.sha);
  let run = supervisor.receiveRequest({ runId: manifest.runId, userId: "user-1", repository: manifest.repository, request: manifest.request.original });
  run = supervisor.normalizeRequest({ runId: run.runId, expectedStateVersion: run.stateVersion, normalizedRequest: manifest.request.normalized, idempotencyKey: "normalize" }).run;
  for (const [nextState, reasonCode] of [["PLANNING", "PLAN_STARTED"], ["PLAN_READY", "PLAN_READY"]] as const) {
    run = supervisor.transition({ runId: run.runId, expectedStateVersion: run.stateVersion, nextState, reasonCode, idempotencyKey: reasonCode }).run;
  }
  const { manifestHash: _hash, ...content } = manifest;
  run = supervisor.freezePlan({ runId: run.runId, expectedStateVersion: run.stateVersion, manifest: content, actorId: "planner", idempotencyKey: "freeze" }).run;
  for (const [nextState, reasonCode] of [
    ["QUEUED", "QUEUED"], ["SANDBOX_COLD_PROVISIONING", "COLD"], ["SANDBOX_PREFLIGHT", "PREFLIGHT"],
    ["SANDBOX_READY", "READY"], ["CONTEXT_BUILDING", "CONTEXT"], ["IMPLEMENTING", "IMPLEMENT"], ["FAST_CHECKS", "BUILT"],
  ] as const) {
    run = supervisor.transition({ runId: run.runId, expectedStateVersion: run.stateVersion, nextState, reasonCode, manifestHash: manifest.manifestHash, idempotencyKey: `state:${reasonCode}` }).run;
  }
  const workspace: WorkspaceRecord = {
    workspaceIdentity: "workspace-phase3", runId: run.runId, repositoryRoot: repo.path, workspaceRoot: repo.path,
    branchName: "zintus/engineer/test", baseCommitSha: repo.sha, originUrl: null, createdAt: "2026-07-14T12:00:00.000Z",
  };
  const sandbox: SandboxRecord = {
    sandboxId: "sandbox-phase3", runId: run.runId, workspaceIdentity: workspace.workspaceIdentity,
    imageReference: `oven/bun@sha256:${"a".repeat(64)}`, imageDigest: `sha256:${"a".repeat(64)}`,
    environmentDigest: `sha256:${"b".repeat(64)}`, networkPolicyVersion: "network-v1", sandboxPolicyVersion: "sandbox-v1",
    status: "READY", source: "COLD", createdAt: "2026-07-14T12:00:00.000Z", destroyedAt: null,
  };
  supervisor.recordSandbox(sandbox);
  return { supervisor, manifest, workspace, sandbox, dbPath: join(path, "engineer.db") };
}

describe("Phase 3 independent verification", () => {
  test("executes the frozen test plan independently and persists objective evidence", () => {
    const path = root();
    const setup = setupFastChecks(path);
    const artifactStore = new LocalArtifactStore({ root: join(path, "artifacts") });
    const executor = new TrustedCommandExecutor({
      artifactStore, workspace: setup.workspace, sandbox: setup.sandbox, manifest: setup.manifest,
      currentCommit: () => setup.manifest.repository.baseCommitSha,
      runner: () => ({ status: 0, stdout: "1 pass", stderr: "" }),
      onRecord: (record) => { setup.supervisor.recordCommandExecution(record); },
    });
    const result = new IndependentVerifier({
      supervisor: setup.supervisor, artifactStore, manifest: setup.manifest, executor,
      diff: () => "diff --git a/src/value.ts b/src/value.ts\n+++ b/src/value.ts\n@@ -1 +1 @@\n+export const value = 2;\n",
    }).run();
    expect(result.executions).toHaveLength(1);
    expect(result.executions[0]?.status).toBe("PASSED");
    expect(result.trustedEvidence.map((item) => item.eventType)).toContain("INDEPENDENT_VERIFICATION");
    expect(setup.supervisor.getRun(setup.manifest.runId).state).toBe("SECURITY_REVIEW");
    const db = new Database(setup.dbPath, { readonly: true });
    expect((db.query("SELECT COUNT(*) AS count FROM test_executions").get() as { count: number }).count).toBe(1);
    db.close();
    setup.supervisor.close();
  });
});

describe("Phase 3 isolated Reviewer", () => {
  test("never receives Builder narrative and rejects tampered diff or evidence", async () => {
    const sentinel = "BUILDER-SECRET-SENTINEL-7f3d";
    const manifest = task("run-review", "1".repeat(40));
    const evidence = TrustedEvidenceSchema.parse({
      evidenceId: "evidence-1", runId: manifest.runId, eventType: "INDEPENDENT_VERIFICATION",
      producerType: "EXECUTOR", producerId: "sandbox-1", sha256: sha256({ passed: true }),
      payload: { passed: true }, createdAt: "2026-07-14T12:00:00.000Z",
    });
    const diff = "diff --git a/src/value.ts b/src/value.ts\n+export const value = 2;\n";
    const base = {
      reviewSessionId: "review-1", runId: manifest.runId, reviewAttempt: 1, manifest,
      manifestHash: manifest.manifestHash, finalDiff: diff, diffHash: sha256(diff), trustedEvidence: [evidence],
      resultCommitSha: "2".repeat(40), reviewPolicyVersion: REVIEWER_POLICY_VERSION,
      createdAt: "2026-07-14T12:00:00.000Z",
    };
    const input = ReviewerInputSchema.parse({ ...base, evidenceBundleHash: reviewerEvidenceBundleHash(base) });
    const transport: ResponsesTransport = {
      async create(request) {
        const serialized = JSON.stringify(request);
        expect(serialized).not.toContain(sentinel);
        expect(serialized).not.toContain("previous_response_id");
        expect(request.model).toBe("gpt-5.6-sol");
        expect(request.store).toBe(false);
        return {
          id: "review-response-1",
          output: [{ type: "function_call", call_id: "review-call-1", name: "submit_review", arguments: JSON.stringify({
            decision: "APPROVE",
            requirementCoverage: [{ criterionId: "criterion-1", status: "SATISFIED", evidenceIds: ["evidence-1"], explanation: "Executor evidence passes." }],
            findings: [], unsupportedClaims: [], residualRisks: [],
            reviewedDiffHash: input.diffHash, reviewedEvidenceBundleHash: input.evidenceBundleHash,
            reviewPolicyVersion: REVIEWER_POLICY_VERSION,
          }) }],
        };
      },
    };
    const result = await new IsolatedReviewer({ transport }).review(input, 1);
    expect(JSON.stringify(result)).not.toContain(sentinel);
    expect(result.session.decision).toBe("APPROVE");
    expect(result.session.cacheKey).not.toContain(sentinel);
    expect(() => ReviewerInputSchema.parse({ ...input, finalDiff: `${input.finalDiff}\ntampered` })).toThrow("diff hash mismatch");
    expect(() => ReviewerInputSchema.parse({
      ...input,
      trustedEvidence: [{ ...evidence, payload: { passed: false } }],
    })).toThrow("evidence bundle hash mismatch");
  });
});

describe("Phase 3 authoritative verification manager", () => {
  test("uses Terra advisories and a fresh Sol review to produce a hash-bound evidence bundle", async () => {
    const path = root();
    const setup = setupFastChecks(path);
    const digest = `sha256:${"a".repeat(64)}`;
    const workspaceManager = new GitWorkspaceManager({ workspaceRoot: join(path, "managed-workspaces"), gitSpawn: testGitSpawn });
    const sandboxManager = new DockerSandboxManager({
      workspaceManager,
      imageReference: `oven/bun@${digest}`,
      imageDigest: digest,
    });
    expect(workspaceManager.currentCommit(setup.workspace)).toBe(setup.manifest.repository.baseCommitSha);
    const provisioned: ProvisionedSandbox = {
      record: setup.sandbox,
      workspace: setup.workspace,
      commandRunner: () => ({ status: 0, stdout: "1 pass", stderr: "" }),
    };
    const executionManager = {
      getSandbox: (runId: string) => runId === setup.manifest.runId ? provisioned : null,
    } as unknown as EngineerExecutionManager;
    const seenModels: string[] = [];
    const transportForRole = (_runId: string, role: "BUILDER" | "TESTER" | "SECURITY" | "REVIEWER"): ResponsesTransport => ({
      async create(request) {
        seenModels.push(String(request.model));
        if (role === "TESTER") {
          return { id: "tester-response", output: [{
            type: "function_call", call_id: "tester-call", name: "submit_test_advisory",
            arguments: JSON.stringify({ uncoveredCriterionIds: [], warnings: [] }),
          }] };
        }
        if (role === "SECURITY") {
          return { id: "security-response", output: [{
            type: "function_call", call_id: "security-call", name: "submit_security_advisory",
            arguments: JSON.stringify({ findings: [] }),
          }] };
        }
        const requestInput = request.input as Array<{ content: Array<{ text: string }> }>;
        const input = JSON.parse(requestInput[0]!.content[0]!.text) as {
          diffHash: string; evidenceBundleHash: string; trustedEvidence: Array<{ evidenceId: string; eventType: string }>;
        };
        expect(input.trustedEvidence.some((item) => item.eventType.includes("ADVISOR"))).toBe(false);
        const verificationEvidence = input.trustedEvidence.find((item) => item.eventType === "INDEPENDENT_VERIFICATION")!;
        return { id: "reviewer-response", output: [{
          type: "function_call", call_id: "reviewer-call", name: "submit_review",
          arguments: JSON.stringify({
            decision: "APPROVE",
            requirementCoverage: [{
              criterionId: "criterion-1", status: "SATISFIED",
              evidenceIds: [verificationEvidence.evidenceId], explanation: "Independent unit test passed.",
            }],
            findings: [], unsupportedClaims: [], residualRisks: [],
            reviewedDiffHash: input.diffHash, reviewedEvidenceBundleHash: input.evidenceBundleHash,
            reviewPolicyVersion: REVIEWER_POLICY_VERSION,
          }),
        }] };
      },
    });
    const manager = new EngineerVerificationManager({
      supervisor: setup.supervisor,
      executionManager,
      sandboxManager,
      artifactStore: new LocalArtifactStore({ root: join(path, "artifacts") }),
      transportForRole,
    });
    const result = await manager.verify(setup.manifest.runId);
    expect(seenModels).toEqual(["gpt-5.6-terra", "gpt-5.6-terra", "gpt-5.6-sol"]);
    expect(result.claims[0]?.status).toBe("VERIFIED");
    expect(result.evidenceBundle.bundleHash).toBe(sha256(result.evidenceBundle.bundle));
    expect(result.evidenceBundle.bundle.artifacts.some((artifact) => artifact.type.endsWith("ADVISORY"))).toBe(false);
    expect(setup.supervisor.listClaimEvidence(setup.manifest.runId)).toEqual(result.claims);
    expect(setup.supervisor.listEvidenceBundles(setup.manifest.runId)).toEqual([result.evidenceBundle]);
    expect(setup.supervisor.getRun(setup.manifest.runId).state).toBe("REVIEW_APPROVED");
    const db = new Database(setup.dbPath, { readonly: true });
    expect((db.query("SELECT COUNT(*) AS count FROM reviewer_sessions").get() as { count: number }).count).toBe(1);
    expect((db.query("SELECT COUNT(*) AS count FROM model_calls").get() as { count: number }).count).toBe(3);
    expect((db.query("SELECT COUNT(*) AS count FROM evidence_bundles").get() as { count: number }).count).toBe(1);
    db.close();
    setup.supervisor.close();
  });

  test("honors a Sol Reviewer change request, runs a bounded repair, then fully reverifies in a fresh session", async () => {
    const path = root();
    const setup = setupFastChecks(path);
    const digest = `sha256:${"a".repeat(64)}`;
    const workspaceManager = new GitWorkspaceManager({ workspaceRoot: join(path, "managed-workspaces"), gitSpawn: testGitSpawn });
    const sandboxManager = new DockerSandboxManager({ workspaceManager, imageReference: `oven/bun@${digest}`, imageDigest: digest });
    const provisioned: ProvisionedSandbox = {
      record: setup.sandbox, workspace: setup.workspace,
      commandRunner: () => ({ status: 0, stdout: "1 pass", stderr: "" }),
    };
    const executionManager = { getSandbox: () => provisioned } as unknown as EngineerExecutionManager;
    let reviewAttempt = 0;
    let builderRound = 0;
    const transportForRole = (_runId: string, role: "BUILDER" | "TESTER" | "SECURITY" | "REVIEWER"): ResponsesTransport => ({
      async create(request) {
        if (role === "TESTER") return { id: `tester-${reviewAttempt}`, output: [{
          type: "function_call", call_id: "tester", name: "submit_test_advisory",
          arguments: JSON.stringify({ uncoveredCriterionIds: [], warnings: [] }),
        }] };
        if (role === "SECURITY") return { id: `security-${reviewAttempt}`, output: [{
          type: "function_call", call_id: "security", name: "submit_security_advisory", arguments: JSON.stringify({ findings: [] }),
        }] };
        if (role === "BUILDER") {
          builderRound += 1;
          if (builderRound === 1) return { id: "repair-1", output: [{
            type: "function_call", call_id: "repair-write", name: "write_file",
            arguments: JSON.stringify({ path: "src/value.ts", content: "// reviewer-requested regression note\nexport const value = 2;\n" }),
          }] };
          return { id: "repair-2", output: [], output_text: "Applied the structured Reviewer finding." };
        }
        reviewAttempt += 1;
        const requestInput = request.input as Array<{ content: Array<{ text: string }> }>;
        const input = JSON.parse(requestInput[0]!.content[0]!.text) as {
          diffHash: string; evidenceBundleHash: string; trustedEvidence: Array<{ evidenceId: string; eventType: string }>;
        };
        const evidenceId = input.trustedEvidence.find((item) => item.eventType === "INDEPENDENT_VERIFICATION")!.evidenceId;
        const requestChanges = reviewAttempt === 1;
        return { id: `review-${reviewAttempt}`, output: [{
          type: "function_call", call_id: `review-call-${reviewAttempt}`, name: "submit_review",
          arguments: JSON.stringify({
            decision: requestChanges ? "REQUEST_CHANGES" : "APPROVE",
            requirementCoverage: [{ criterionId: "criterion-1", status: "SATISFIED", evidenceIds: [evidenceId], explanation: "Independent test passed." }],
            findings: requestChanges ? [{
              findingId: "finding-1", severity: "MEDIUM", category: "REGRESSION_COVERAGE",
              file: "src/value.ts", lineStart: 1, lineEnd: 1, criterionIds: ["criterion-1"],
              description: "The change needs an explicit regression note.", requiredChange: "Add the scoped regression note.", evidenceIds: [evidenceId],
            }] : [],
            unsupportedClaims: [], residualRisks: [], reviewedDiffHash: input.diffHash,
            reviewedEvidenceBundleHash: input.evidenceBundleHash, reviewPolicyVersion: REVIEWER_POLICY_VERSION,
          }),
        }] };
      },
    });
    const manager = new EngineerVerificationManager({
      supervisor: setup.supervisor, executionManager, sandboxManager,
      artifactStore: new LocalArtifactStore({ root: join(path, "artifacts") }), transportForRole,
    });
    const result = await manager.verify(setup.manifest.runId);
    expect(reviewAttempt).toBe(2);
    expect(builderRound).toBe(2);
    expect(result.reviewerSession.attempt).toBe(2);
    expect(setup.supervisor.getRun(setup.manifest.runId).state).toBe("REVIEW_APPROVED");
    const db = new Database(setup.dbPath, { readonly: true });
    expect((db.query("SELECT COUNT(*) AS count FROM reviewer_sessions").get() as { count: number }).count).toBe(2);
    expect((db.query("SELECT COUNT(*) AS count FROM retry_attempts").get() as { count: number }).count).toBe(1);
    expect((db.query("SELECT COUNT(*) AS count FROM test_executions").get() as { count: number }).count).toBe(2);
    db.close();
    setup.supervisor.close();
  });
});
