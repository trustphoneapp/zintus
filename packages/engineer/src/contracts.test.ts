import { describe, expect, test } from "bun:test";
import {
  ReviewerInputSchema,
  TaskManifestSchema,
  TrustedEvidenceSchema,
  reviewerEvidenceBundleHash,
  type TaskManifestContent,
} from "./contracts.js";
import { sha256 } from "./hash.js";
import { MODEL_ROLE_TIERS, modelTierForRole } from "./model-routing.js";

function manifest(): ReturnType<typeof TaskManifestSchema.parse> {
  const content: TaskManifestContent = {
    manifestVersion: 1,
    runId: "run-contract",
    repository: {
      repositoryId: "repo-1",
      provider: "github",
      owner: "trustphoneapp",
      name: "zintus",
      baseBranch: "main",
      baseCommitSha: "a".repeat(40),
    },
    request: { original: "Build it", normalized: "Build the requested feature." },
    acceptanceCriteria: [{
      criterionId: "criterion-1",
      statement: "The feature is verified.",
      verificationMethod: "Run a trusted test.",
      priority: "MUST",
    }],
    testPlan: [{
      testId: "test-1",
      criterionIds: ["criterion-1"],
      type: "UNIT",
      description: "Run the unit test.",
    }],
    allowedPaths: ["packages/engineer/**"],
    deniedPaths: [".env*"],
    allowedCommands: ["bun test packages/engineer/src/"],
    prohibitedCommands: ["git push"],
    riskTier: "MEDIUM",
    humanGateRequired: true,
    retryBudgets: {
      sameFailureAttempts: 2,
      builderRepairAttempts: 4,
      reviewerFixAttempts: 2,
      plannerRestarts: 1,
      sandboxProvisioningAttempts: 3,
      transientModelAttempts: 3,
    },
    timeBudgetSeconds: 3_600,
    tokenBudget: 10_000,
    costBudgetUsd: 5,
    createdAt: "2026-07-14T12:00:00.000Z",
  };
  return TaskManifestSchema.parse({ ...content, manifestHash: sha256(content) });
}

describe("mandatory isolation contracts", () => {
  test("Reviewer input accepts only frozen manifest, diff, and trusted evidence", () => {
    const taskManifest = manifest();
    const evidence = TrustedEvidenceSchema.parse({
      evidenceId: "evidence-1",
      runId: taskManifest.runId,
      eventType: "command.execution.completed",
      producerType: "EXECUTOR",
      producerId: "sandbox-1",
      sha256: `sha256:${"b".repeat(64)}`,
      payload: { command: "bun test", exitCode: 0 },
      createdAt: "2026-07-14T12:01:00.000Z",
    });
    const finalDiff = "diff --git a/a.ts b/a.ts";
    const input = {
      reviewSessionId: "review-session-1",
      runId: taskManifest.runId,
      reviewAttempt: 1,
      manifest: taskManifest,
      manifestHash: taskManifest.manifestHash,
      finalDiff,
      diffHash: sha256(finalDiff),
      trustedEvidence: [evidence],
      evidenceBundleHash: reviewerEvidenceBundleHash({
        manifestHash: taskManifest.manifestHash,
        diffHash: sha256(finalDiff),
        resultCommitSha: "e".repeat(40),
        trustedEvidence: [evidence],
      }),
      resultCommitSha: "e".repeat(40),
      reviewPolicyVersion: "review-policy-v1",
      createdAt: "2026-07-14T12:02:00.000Z",
    };
    expect(ReviewerInputSchema.safeParse(input).success).toBe(true);
    expect(ReviewerInputSchema.safeParse({
      ...input,
      builderSummary: "BUILDER_SECRET_SENTINEL",
    }).success).toBe(false);
    expect(ReviewerInputSchema.safeParse({
      ...input,
      finalDiff: `${finalDiff}\n+tampered`,
    }).success).toBe(false);
    expect(ReviewerInputSchema.safeParse({
      ...input,
      trustedEvidence: [{ ...evidence, runId: "another-run" }],
    }).success).toBe(false);
  });

  test("SOL is statically reserved for Builder and Reviewer", () => {
    expect(modelTierForRole("BUILDER")).toBe("GPT-5.6_SOL");
    expect(modelTierForRole("REVIEWER")).toBe("GPT-5.6_SOL");
    for (const [role, tier] of Object.entries(MODEL_ROLE_TIERS)) {
      if (role !== "BUILDER" && role !== "REVIEWER") expect(tier).not.toBe("GPT-5.6_SOL");
    }
    expect(modelTierForRole("TESTER")).toBe("GPT-5.6_TERRA");
    expect(modelTierForRole("SECURITY")).toBe("GPT-5.6_TERRA");
    expect(modelTierForRole("RISK_FEATURE_EXTRACTOR")).toBe("GPT-5.6_LUNA");
  });
});
