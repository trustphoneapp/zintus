import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EngineerPlanningManager } from "./planning.js";
import { EngineerSupervisor } from "./supervisor.js";
import { LocalArtifactStore } from "./artifact-store.js";

describe("Phase 5 structured planning", () => {
  test("uses TERRA for a persisted plan while deterministic rules assign risk", async () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-engineer-plan-"));
    const supervisor = new EngineerSupervisor({ dbPath: join(root, "engineer.db") });
    const run = supervisor.receiveRequest({
      runId: "plan-run", userId: "user-1",
      repository: { repositoryId: "repo-1", provider: "local", owner: "local", name: "fixture", baseBranch: "main", baseCommitSha: "a".repeat(40) },
      request: "Require authentication on the export endpoint.",
    });
    let seenModel = "";
    const manager = new EngineerPlanningManager({
      supervisor, artifactStore: new LocalArtifactStore({ root: join(root, "artifacts") }),
      transportForRun: () => ({ async create(request) {
        seenModel = String(request.model);
        return { id: "plan-response", output: [{ type: "function_call", name: "submit_plan", call_id: "plan-call", arguments: JSON.stringify({
          normalizedRequest: "Require authentication on the export endpoint.",
          acceptanceCriteria: [{ criterionId: "auth-1", statement: "Unauthenticated exports are rejected.", verificationMethod: "Run an authorization integration test.", priority: "MUST" }],
          testPlan: [{ testId: "auth-test", criterionIds: ["auth-1"], type: "INTEGRATION", description: "Verify authorization.", command: "bun test auth" }],
          allowedPaths: ["src/auth/**", "tests/auth/**"], deniedPaths: [], allowedCommands: ["bun test auth"],
          riskFeatures: { documentationOnly: false, sensitiveFilesChanged: true, touchesAuthentication: true, touchesAuthorization: true, touchesPayments: false, changesDatabaseSchema: false, destructiveProductionOperation: false, privilegeEscalation: false, changesInfrastructure: false, accessesSecrets: false, exposesSecrets: false, changesDependencies: false, changesPublicApi: true, requiredChecksPassed: false, testCoveragePercent: null, unresolvedWarnings: 0, highestSecuritySeverity: "NONE", retryCount: 0, dependsOnExternalService: false, diffLines: 0, generatedCodePercent: 0, reviewerDisagreement: false, suspectedRunnerCompromise: false },
        }) }] };
      } }),
    });
    const proposal = await manager.plan(run.runId);
    expect(seenModel).toBe("gpt-5.6-terra");
    expect(proposal.manifest.riskTier).toBe("HIGH");
    expect(proposal.manifest.humanGateRequired).toBe(true);
    expect(proposal.manifest.prohibitedCommands).toContain("git push");
    expect(supervisor.getRun(run.runId).state).toBe("PLAN_READY");
    expect(manager.get(run.runId)?.proposalHash).toBe(proposal.proposalHash);
    supervisor.close(); rmSync(root, { recursive: true, force: true });
  });
});
