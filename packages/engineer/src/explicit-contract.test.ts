import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ExplicitContractViolationError,
  assertManifestPreservesExplicitApiContract,
  assertWorkspaceSatisfiesExplicitApiContract,
  extractExplicitApiContract,
} from "./explicit-contract.js";
import { TaskManifestSchema, type TaskManifestContent } from "./contracts.js";
import { sha256 } from "./hash.js";

const request = `Create the code inside src/scheduler.ts and write tests in test/scheduler.test.ts.\nexport class DagScheduler {\n  constructor(options: { maxConcurrency: number });\n  addTask<T>(id: string): Promise<T>;\n  setPriority(id: string, priority: number): void;\n  cancelTask(id: string): void;\n}\nThrow CyclicDependencyError, MissingDependencyError, TaskCancelledError, and TimeoutError.`;

function manifest(criteria: string[]): ReturnType<typeof TaskManifestSchema.parse> {
  const content: TaskManifestContent = {
    manifestVersion: 1, runId: "explicit-contract", repository: { repositoryId: "repo", provider: "local", owner: "local", name: "repo", baseBranch: "main", baseCommitSha: "a".repeat(40) },
    request: { original: request, normalized: request },
    acceptanceCriteria: criteria.map((statement, index) => ({ criterionId: `ac-${index}`, statement, verificationMethod: statement, priority: "MUST" as const })),
    testPlan: [{ testId: "scheduler-contract", criterionIds: criteria.map((_, index) => `ac-${index}`), type: "UNIT", description: criteria.join(" "), command: "bun test test/scheduler.test.ts" }],
    allowedPaths: ["src/**", "test/**"], deniedPaths: [], allowedCommands: ["bun test test/scheduler.test.ts"], prohibitedCommands: [],
    riskTier: "MEDIUM", humanGateRequired: true, retryBudgets: { sameFailureAttempts: 1, builderRepairAttempts: 1, reviewerFixAttempts: 1, plannerRestarts: 1, sandboxProvisioningAttempts: 1, transientModelAttempts: 1 },
    timeBudgetSeconds: 600, tokenBudget: 1000, costBudgetUsd: 1, createdAt: "2026-07-20T00:00:00.000Z",
  };
  return TaskManifestSchema.parse({ ...content, manifestHash: sha256(content) });
}

describe("explicit API contract gate", () => {
  test("extracts explicit class, methods, errors, and file paths", () => {
    expect(extractExplicitApiContract(request)).toEqual(expect.objectContaining({
      sourcePaths: ["src/scheduler.ts", "test/scheduler.test.ts"], exportedClasses: ["DagScheduler"],
      requiredMethods: expect.arrayContaining(["addTask", "setPriority", "cancelTask"]),
      requiredErrors: expect.arrayContaining(["CyclicDependencyError", "MissingDependencyError", "TaskCancelledError", "TimeoutError"]),
    }));
  });

  test("blocks freezing a planner-replaced functional API", () => {
    expect(() => assertManifestPreservesExplicitApiContract(manifest(["Export schedule(tasks, options) as a functional batch API."])))
      .toThrow(ExplicitContractViolationError);
  });

  test("accepts a valid plan that says a source file exports the requested class", () => {
    const intent = "src/scheduler.ts exports DagScheduler, TaskCancelledError, TimeoutError, MissingDependencyError, and CyclicDependencyError. DagScheduler exposes addTask, setPriority, and cancelTask.";
    expect(() => assertManifestPreservesExplicitApiContract(manifest([intent]))).not.toThrow();
  });

  test("does not treat runtime built-ins mentioned in prose as required user exports", () => {
    const extracted = extractExplicitApiContract(`${request}\nDo not leak TypeError, RangeError, AggregateError, DOMException, or ErrnoException from scheduler internals.`);
    expect(extracted.requiredErrors).toEqual(expect.arrayContaining([
      "CyclicDependencyError", "MissingDependencyError", "TaskCancelledError", "TimeoutError",
    ]));
    expect(extracted.requiredErrors).not.toEqual(expect.arrayContaining([
      "TypeError", "RangeError", "AggregateError", "DOMException", "ErrnoException",
    ]));
  });

  test("blocks Reviewer dispatch when the workspace replaces the requested class API", () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-explicit-contract-"));
    try {
      mkdirSync(join(root, "src"));
      writeFileSync(join(root, "src", "scheduler.ts"), "export async function schedule() {}\n");
      const full = "Export class DagScheduler with addTask, setPriority, cancelTask, CyclicDependencyError, MissingDependencyError, TaskCancelledError, and TimeoutError in src/scheduler.ts and test/scheduler.test.ts.";
      expect(() => assertWorkspaceSatisfiesExplicitApiContract(root, manifest([full]))).toThrow(ExplicitContractViolationError);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("validates an explicit API in a package-scoped src path", () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-explicit-contract-package-"));
    const packageRequest = `Create packages/engineer/src/dag-scheduler.ts and packages/engineer/src/dag-scheduler.test.ts.\nexport class DagScheduler {\n  addTask<T>(id: string): Promise<T>;\n  setPriority(id: string, priority: number): void;\n  cancelTask(id: string): void;\n}\nExport DuplicateTaskError, MissingDependencyError, CyclicDependencyError, TaskCancelledError, TimeoutError, and DependencyFailedError.`;
    const { manifestHash: _manifestHash, ...baseContent } = manifest(["packages/engineer/src/dag-scheduler.ts exports DagScheduler, addTask, setPriority, cancelTask, DuplicateTaskError, MissingDependencyError, CyclicDependencyError, TaskCancelledError, TimeoutError, and DependencyFailedError."]);
    const packageContent = {
      ...baseContent,
      request: { original: packageRequest, normalized: packageRequest },
      allowedPaths: ["packages/engineer/src/**"],
    };
    const packageManifest = TaskManifestSchema.parse({ ...packageContent, manifestHash: sha256(packageContent) });
    try {
      mkdirSync(join(root, "packages", "engineer", "src"), { recursive: true });
      writeFileSync(join(root, "packages", "engineer", "src", "dag-scheduler.ts"), `
        export class DuplicateTaskError extends Error {}
        export class MissingDependencyError extends Error {}
        export class CyclicDependencyError extends Error {}
        export class TaskCancelledError extends Error {}
        export class TimeoutError extends Error {}
        export class DependencyFailedError extends Error {}
        export class DagScheduler {
          addTask<T>(_id: string): Promise<T> { throw new Error("not implemented"); }
          setPriority(_id: string, _priority: number): void {}
          cancelTask(_id: string): void {}
        }
      `);
      expect(() => assertWorkspaceSatisfiesExplicitApiContract(root, packageManifest)).not.toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
