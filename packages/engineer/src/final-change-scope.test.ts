import { describe, expect, test } from "bun:test";
import { TaskManifestSchema, type TaskManifestContent } from "./contracts.js";
import { sha256 } from "./hash.js";
import { buildFinalChangeScopeAttestation } from "./final-change-scope.js";

function manifest(overrides: { allowedPaths: string[]; deniedPaths: string[] }): ReturnType<typeof TaskManifestSchema.parse> {
  const content: TaskManifestContent = {
    manifestVersion: 1,
    runId: "run-scope-gate",
    repository: {
      repositoryId: "repo-1", provider: "github", owner: "trustphoneapp", name: "zintus",
      baseBranch: "main", baseCommitSha: "a".repeat(40),
    },
    request: { original: "Build it", normalized: "Build the requested feature." },
    acceptanceCriteria: [
      { criterionId: "must-a", statement: "A works", verificationMethod: "Test A", priority: "MUST" },
    ],
    testPlan: [
      { testId: "test-a", criterionIds: ["must-a"], type: "UNIT", description: "Test A", command: "bun test packages/engineer/src/" },
    ],
    allowedPaths: overrides.allowedPaths, deniedPaths: overrides.deniedPaths,
    allowedCommands: ["bun test packages/engineer/src/"], prohibitedCommands: ["git push"],
    riskTier: "MEDIUM", humanGateRequired: true,
    retryBudgets: {
      sameFailureAttempts: 2, builderRepairAttempts: 4, reviewerFixAttempts: 2,
      plannerRestarts: 1, sandboxProvisioningAttempts: 3, transientModelAttempts: 3,
    },
    timeBudgetSeconds: 3_600, tokenBudget: 10_000, costBudgetUsd: 5,
    createdAt: "2026-07-19T12:00:00.000Z",
  };
  return TaskManifestSchema.parse({ ...content, manifestHash: sha256(content) });
}

const RESULT_COMMIT = "b".repeat(40);

describe("final change scope attestation fails closed", () => {
  test("succeeds when every resolved path is allowed", () => {
    const attestation = buildFinalChangeScopeAttestation({
      manifest: manifest({ allowedPaths: ["src/**"], deniedPaths: [] }),
      diff: [
        "diff --git a/src/some file.ts b/src/some file.ts",
        "--- a/src/some file.ts",
        "+++ b/src/some file.ts",
        "@@ -1 +1 @@",
        "-a",
        "+b",
      ].join("\n"),
      resultCommitSha: RESULT_COMMIT,
      credentialedGitOperationCount: 0,
    });
    expect(attestation.status).toBe("SUCCEEDED");
    expect(attestation.violations).toEqual([]);
    expect(attestation.changedPaths).toEqual(["src/some file.ts"]);
  });

  test("a prohibited path smuggled as a rename SOURCE is a scope violation", () => {
    const attestation = buildFinalChangeScopeAttestation({
      manifest: manifest({ allowedPaths: ["src/**"], deniedPaths: [] }),
      diff: [
        "diff --git a/.github/workflows/release.yml b/src/allowed.ts",
        "similarity index 100%",
        "rename from .github/workflows/release.yml",
        "rename to src/allowed.ts",
      ].join("\n"),
      resultCommitSha: RESULT_COMMIT,
      credentialedGitOperationCount: 0,
    });
    expect(attestation.status).toBe("FAILED");
    expect(attestation.violations).toContain(".github/workflows/release.yml");
    expect(attestation.changedPaths).toContain(".github/workflows/release.yml");
  });

  test("an ambiguous unparseable header fails closed even under a permissive ** allowlist", () => {
    const attestation = buildFinalChangeScopeAttestation({
      manifest: manifest({ allowedPaths: ["**"], deniedPaths: [] }),
      diff: [
        "diff --git a/some file.ts b/some file.ts",
        "old mode 100644",
        "new mode 100755",
      ].join("\n"),
      resultCommitSha: RESULT_COMMIT,
      credentialedGitOperationCount: 0,
    });
    expect(attestation.status).toBe("FAILED");
    expect(attestation.violations).toEqual([
      "unparseable diff header (scope indeterminate): a/some file.ts b/some file.ts",
    ]);
  });
});
