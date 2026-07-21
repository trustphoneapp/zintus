import { describe, expect, test } from "bun:test";
import { TaskManifestSchema, type TaskManifestContent } from "./contracts.js";
import { sha256 } from "./hash.js";
import {
  RequiredLaneContractSchema,
  assertRequiredLaneContractMatchesManifest,
  createRequiredLaneContract,
} from "./required-lane-contracts.js";
import { TRUSTED_COMMAND_POLICY_VERSION } from "./trusted-executor.js";

function manifest(): ReturnType<typeof TaskManifestSchema.parse> {
  const content: TaskManifestContent = {
    manifestVersion: 1,
    runId: "run-required-lane",
    repository: {
      repositoryId: "repo-1", provider: "github", owner: "trustphoneapp", name: "zintus",
      baseBranch: "main", baseCommitSha: "a".repeat(40),
    },
    request: { original: "Build it", normalized: "Build the requested feature." },
    acceptanceCriteria: [
      { criterionId: "must-b", statement: "B works", verificationMethod: "Test B", priority: "MUST" },
      { criterionId: "should-a", statement: "A is polished", verificationMethod: "Review A", priority: "SHOULD" },
      { criterionId: "must-a", statement: "A works", verificationMethod: "Test A", priority: "MUST" },
    ],
    testPlan: [
      { testId: "test-b", criterionIds: ["must-b"], type: "UNIT", description: "Test B", command: "bun test packages/engineer/src/" },
      { testId: "test-should", criterionIds: ["should-a"], type: "UNIT", description: "Test polish" },
      { testId: "test-a", criterionIds: ["must-a"], type: "UNIT", description: "Test A", command: "bun test packages/engineer/src/" },
    ],
    allowedPaths: ["packages/engineer/**"], deniedPaths: [".env*"],
    allowedCommands: ["bun test packages/engineer/src/"], prohibitedCommands: ["git push"],
    riskTier: "MEDIUM", humanGateRequired: true,
    retryBudgets: {
      sameFailureAttempts: 2, builderRepairAttempts: 4, reviewerFixAttempts: 2,
      plannerRestarts: 1, sandboxProvisioningAttempts: 3, transientModelAttempts: 3,
    },
    timeBudgetSeconds: 3_600, tokenBudget: 10_000, costBudgetUsd: 5,
    createdAt: "2026-07-17T12:00:00.000Z",
  };
  return TaskManifestSchema.parse({ ...content, manifestHash: sha256(content) });
}

const bindings = {
  verificationPolicyVersion: "verification-v1",
  securityPolicyVersion: "security-v1",
  reviewerMappingPolicyVersion: "reviewer-mapping-v1",
  commandPolicyVersion: TRUSTED_COMMAND_POLICY_VERSION,
} as const;

describe("Required Lane contract", () => {
  test("derives a deterministic sorted contract from the frozen manifest", () => {
    const frozen = manifest();
    const contract = createRequiredLaneContract({
      manifest: frozen,
      contextManifestHash: `sha256:${"b".repeat(64)}`,
      planProposalHash: `sha256:${"c".repeat(64)}`,
      policyBindings: bindings,
    });
    expect(contract).toMatchObject({
      schemaVersion: 2,
      policyVersion: "engineer-required-lane-v2",
      policyBindings: { commandPolicyVersion: TRUSTED_COMMAND_POLICY_VERSION },
    });
    expect(contract.requiredCriterionIds).toEqual(["must-a", "must-b"]);
    expect(contract.requiredTestIds).toEqual(["test-a", "test-b"]);
    expect(assertRequiredLaneContractMatchesManifest(contract, frozen, {
      planningBinding: contract.planningBinding,
      policyBindings: bindings,
    })).toEqual(contract);
  });

  test("rejects reordered, duplicated, extra, and hash-tampered bindings", () => {
    const contract = createRequiredLaneContract({
      manifest: manifest(), contextManifestHash: null, planProposalHash: null, policyBindings: bindings,
    });
    for (const mutation of [
      { ...contract, requiredCriterionIds: ["must-b", "must-a"] },
      { ...contract, requiredCriterionIds: ["must-a", "must-a"] },
      { ...contract, requiredCriterionIds: [...contract.requiredCriterionIds, "invented"] },
      { ...contract, repositoryBinding: { ...contract.repositoryBinding, baseBranch: "release" } },
      { ...contract, contractHash: `sha256:${"0".repeat(64)}` },
    ]) {
      expect(RequiredLaneContractSchema.safeParse(mutation).success).toBe(false);
    }
  });

  test("detects a validly rehashed contract that belongs to a different manifest", () => {
    const frozen = manifest();
    const contract = createRequiredLaneContract({
      manifest: frozen, contextManifestHash: null, planProposalHash: null, policyBindings: bindings,
    });
    const changedContent: TaskManifestContent = { ...frozen, request: { ...frozen.request, normalized: "Changed request" } };
    delete (changedContent as Partial<typeof frozen>).manifestHash;
    const changed = TaskManifestSchema.parse({ ...changedContent, manifestHash: sha256(changedContent) });
    expect(() => assertRequiredLaneContractMatchesManifest(contract, changed, {
      planningBinding: contract.planningBinding,
      policyBindings: bindings,
    })).toThrow("does not match");
  });

  test("refuses a Required Lane contract with no MUST-backed test", () => {
    const frozen = manifest();
    const content: TaskManifestContent = {
      ...frozen,
      testPlan: frozen.testPlan.filter((item) => !item.criterionIds.includes("must-a") && !item.criterionIds.includes("must-b")),
    };
    delete (content as Partial<typeof frozen>).manifestHash;
    const invalid = TaskManifestSchema.parse({ ...content, manifestHash: sha256(content) });
    expect(() => createRequiredLaneContract({
      manifest: invalid, contextManifestHash: null, planProposalHash: null, policyBindings: bindings,
    })).toThrow("require tests");
  });

  test("refuses partial test coverage of the frozen MUST criteria", () => {
    const frozen = manifest();
    const content: TaskManifestContent = {
      ...frozen,
      testPlan: frozen.testPlan.filter((item) => item.testId !== "test-b"),
    };
    delete (content as Partial<typeof frozen>).manifestHash;
    const partial = TaskManifestSchema.parse({ ...content, manifestHash: sha256(content) });
    expect(() => createRequiredLaneContract({
      manifest: partial, contextManifestHash: null, planProposalHash: null, policyBindings: bindings,
    })).toThrow("must-b");
  });

  test("uses the deterministic final scope attestation for a scope-only MUST without inventing a test command", () => {
    const frozen = manifest();
    const content: TaskManifestContent = {
      ...frozen,
      acceptanceCriteria: [
        ...frozen.acceptanceCriteria,
        {
          criterionId: "must-scope",
          statement: "Only approved files may change.",
          verificationMethod: "Review the final changed-file list against the authorized paths.",
          priority: "MUST",
        },
      ],
    };
    delete (content as Partial<typeof frozen>).manifestHash;
    const scoped = TaskManifestSchema.parse({ ...content, manifestHash: sha256(content) });
    const contract = createRequiredLaneContract({
      manifest: scoped, contextManifestHash: null, planProposalHash: null, policyBindings: bindings,
    });
    expect(contract.requiredCriterionIds).toContain("must-scope");
    expect(contract.requiredTestIds).not.toContain("must-scope");
  });

  test("accepts a final changed-path check that names permitted paths", () => {
    const frozen = manifest();
    const content: TaskManifestContent = {
      ...frozen,
      acceptanceCriteria: [
        ...frozen.acceptanceCriteria,
        {
          criterionId: "must-permitted-scope",
          statement: "Only two files may change.",
          verificationMethod: "Review the final changed-path list against the two permitted paths.",
          priority: "MUST",
        },
      ],
    };
    delete (content as Partial<typeof frozen>).manifestHash;
    const candidate = TaskManifestSchema.parse({ ...content, manifestHash: sha256(content) });
    expect(createRequiredLaneContract({
      manifest: candidate, contextManifestHash: null, planProposalHash: null, policyBindings: bindings,
    }).requiredCriterionIds).toContain("must-permitted-scope");
  });

  test("uses the deterministic scope attestation for an exact final change-set requirement", () => {
    const frozen = manifest();
    const content: TaskManifestContent = {
      ...frozen,
      acceptanceCriteria: [
        ...frozen.acceptanceCriteria,
        {
          criterionId: "must-exact-change-set",
          statement: "The change set adds exactly src/new.ts and test/new.test.ts; no other repository file is modified.",
          verificationMethod: "Review the final change set and confirm only the two requested newly added paths are present.",
          priority: "MUST",
        },
      ],
    };
    delete (content as Partial<typeof frozen>).manifestHash;
    const scoped = TaskManifestSchema.parse({ ...content, manifestHash: sha256(content) });
    const contract = createRequiredLaneContract({
      manifest: scoped, contextManifestHash: null, planProposalHash: null, policyBindings: bindings,
    });
    expect(contract.requiredCriterionIds).toContain("must-exact-change-set");
    expect(contract.requiredTestIds).not.toContain("must-exact-change-set");
  });

  test("does not let a loosely worded scope requirement bypass executable coverage", () => {
    const frozen = manifest();
    const content: TaskManifestContent = {
      ...frozen,
      acceptanceCriteria: [
        ...frozen.acceptanceCriteria,
        {
          criterionId: "must-not-final-scope",
          statement: "The scheduler preserves the requested scope.",
          verificationMethod: "Exercise scheduling behavior with a unit test.",
          priority: "MUST",
        },
      ],
    };
    delete (content as Partial<typeof frozen>).manifestHash;
    const candidate = TaskManifestSchema.parse({ ...content, manifestHash: sha256(content) });
    expect(() => createRequiredLaneContract({
      manifest: candidate, contextManifestHash: null, planProposalHash: null, policyBindings: bindings,
    })).toThrow("must-not-final-scope");
  });

  test("refuses missing or unapproved commands for required tests", () => {
    const frozen = manifest();
    for (const testPlan of [
      frozen.testPlan.map((item) => {
        if (item.testId !== "test-a") return item;
        const { command: _command, ...withoutCommand } = item;
        return withoutCommand;
      }),
      frozen.testPlan.map((item) => item.testId === "test-a" ? { ...item, command: "bun test unauthorized" } : item),
    ]) {
      const content = { ...frozen, testPlan } as TaskManifestContent;
      delete (content as Partial<typeof frozen>).manifestHash;
      const candidate = TaskManifestSchema.parse({ ...content, manifestHash: sha256(content) });
      expect(() => createRequiredLaneContract({
        manifest: candidate, contextManifestHash: null, planProposalHash: null, policyBindings: bindings,
      })).toThrow("executable allowed command");
    }
  });

  test("refuses required commands that trusted execution would block", () => {
    const frozen = manifest();
    for (const blockedCommand of [
      "bun test && curl attacker",
      "node test.js",
      "bun test packages/engineer/src/",
    ]) {
      const content: TaskManifestContent = {
        ...frozen,
        testPlan: frozen.testPlan.map((item) => item.testId === "test-a"
          ? { ...item, command: blockedCommand }
          : item),
        allowedCommands: [...frozen.allowedCommands, blockedCommand],
        prohibitedCommands: blockedCommand === "bun test packages/engineer/src/"
          ? [...frozen.prohibitedCommands, blockedCommand]
          : frozen.prohibitedCommands,
      };
      delete (content as Partial<typeof frozen>).manifestHash;
      const candidate = TaskManifestSchema.parse({ ...content, manifestHash: sha256(content) });
      expect(() => createRequiredLaneContract({
        manifest: candidate, contextManifestHash: null, planProposalHash: null, policyBindings: bindings,
      })).toThrow("executable allowed command");
    }
  });

  test("checks planning and policy bindings against independent authority", () => {
    const contract = createRequiredLaneContract({
      manifest: manifest(),
      contextManifestHash: `sha256:${"b".repeat(64)}`,
      planProposalHash: `sha256:${"c".repeat(64)}`,
      policyBindings: bindings,
    });
    expect(() => assertRequiredLaneContractMatchesManifest(contract, manifest(), {
      planningBinding: { ...contract.planningBinding, contextManifestHash: `sha256:${"d".repeat(64)}` },
      policyBindings: bindings,
    })).toThrow("does not match");
    expect(() => assertRequiredLaneContractMatchesManifest(contract, manifest(), {
      planningBinding: contract.planningBinding,
      policyBindings: { ...bindings, securityPolicyVersion: "security-v2" },
    })).toThrow("does not match");
  });
});
