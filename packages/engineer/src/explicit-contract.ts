import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { TaskManifest, TaskManifestContent } from "./contracts.js";
import { isManifestPathAllowed } from "./manifest-files.js";

/**
 * Explicit user API requirements are not planning suggestions. This small,
 * deterministic extractor handles the high-confidence TypeScript forms that
 * would otherwise be easy for a planner to silently replace with a different
 * architecture (for example, a requested class changed to a helper function).
 */
export interface ExplicitApiContract {
  readonly sourcePaths: readonly string[];
  readonly exportedClasses: readonly string[];
  readonly requiredMethods: readonly string[];
  readonly requiredErrors: readonly string[];
}

export class ExplicitContractViolationError extends Error {
  constructor(readonly violations: readonly string[]) {
    super(`Frozen contract does not preserve explicit user requirements: ${violations.join("; ")}`);
    this.name = "ExplicitContractViolationError";
  }
}

const unique = (items: readonly string[]) => [...new Set(items)].sort();

// These identifiers describe runtime/platform failures rather than user-defined
// API exports.  A prose mention must never turn one into an `export class` gate.
// Keep this deliberately narrow: names such as TimeoutError and AbortError are
// common, legitimate user-defined domain errors and are therefore not included.
const RUNTIME_ERROR_IDENTIFIERS = new Set([
  "Error", "EvalError", "RangeError", "ReferenceError", "SyntaxError", "TypeError", "URIError",
  "AggregateError", "SuppressedError", "DOMException", "CompileError", "LinkError", "RuntimeError",
  "Exception", "ErrnoException",
]);

export function extractExplicitApiContract(request: string): ExplicitApiContract {
  // Engineer tasks often live in a workspace package (for example
  // `packages/engineer/src/scheduler.ts`), not only in a repository-root
  // `src/` directory. Capture the complete relative path so the workspace
  // gate reads the file the user actually authorized.
  const sourcePaths = unique([...request.matchAll(/\b((?:[A-Za-z0-9_@.-]+\/)*(?:src|test)\/[A-Za-z0-9_@./-]+\.(?:ts|tsx))\b/g)]
    .map((match) => match[1]!)
    .filter((path) => !path.split("/").includes("..")));
  const exportedClasses = unique([...request.matchAll(/export\s+class\s+([A-Za-z_$][\w$]*)/g)]
    .map((match) => match[1]!));
  // Method declarations in a supplied interface/code block. Only treat names
  // appearing as declarations as contractual; prose references are ambiguous.
  const requiredMethods = unique([...request.matchAll(/^\s*(?:public\s+)?([A-Za-z_$][\w$]*)\s*(?:<[^\n>]*>)?\s*\(/gm)]
    .map((match) => match[1]!)
    .filter((name) => !["constructor", "if", "for", "while", "switch", "catch"].includes(name)));
  const requiredErrors = unique([...request.matchAll(/\b([A-Z][A-Za-z0-9_$]*(?:Error|Exception))\b/g)]
    .map((match) => match[1]!)
    .filter((name) => !RUNTIME_ERROR_IDENTIFIERS.has(name)));
  return { sourcePaths, exportedClasses, requiredMethods, requiredErrors };
}

type ContractManifest = Pick<TaskManifestContent, "request" | "acceptanceCriteria" | "testPlan" | "allowedPaths" | "deniedPaths">;

function manifestText(manifest: ContractManifest): string {
  return [
    ...manifest.acceptanceCriteria.flatMap((criterion) => [criterion.statement, criterion.verificationMethod]),
    ...manifest.testPlan.flatMap((test) => [test.description, test.command ?? ""]),
  ].join("\n");
}

/** Blocks plan freeze when a planner has weakened an explicit user contract. */
export function assertManifestPreservesExplicitApiContract(manifest: ContractManifest): ExplicitApiContract {
  const contract = extractExplicitApiContract(manifest.request.original);
  if (!contract.exportedClasses.length && !contract.requiredMethods.length && !contract.requiredErrors.length) return contract;
  const text = manifestText(manifest);
  const violations: string[] = [];
  for (const path of contract.sourcePaths) {
    if (!isManifestPathAllowed(path, manifest as TaskManifest)) violations.push(`required path ${path} is outside allowedPaths`);
  }
  for (const className of contract.exportedClasses) {
    // Freeze validates planning intent, not TypeScript syntax. The workspace
    // gate below remains responsible for the strict `export class` check.
    if (!new RegExp(`\\b${className}\\b`).test(text)) {
      violations.push(`required export class ${className} is absent from MUST criteria/tests`);
    }
  }
  for (const method of contract.requiredMethods) {
    if (!new RegExp(`\\b${method}\\b`).test(text)) violations.push(`required method ${method} is absent from MUST criteria/tests`);
  }
  for (const errorName of contract.requiredErrors) {
    if (!new RegExp(`\\b${errorName}\\b`).test(text)) violations.push(`required error ${errorName} is absent from MUST criteria/tests`);
  }
  if (violations.length) throw new ExplicitContractViolationError(violations);
  return contract;
}

/** Local, no-model check used after implementation and before any Reviewer call. */
export function assertWorkspaceSatisfiesExplicitApiContract(workspaceRoot: string, manifest: TaskManifest): ExplicitApiContract {
  const contract = assertManifestPreservesExplicitApiContract(manifest);
  if (!contract.exportedClasses.length && !contract.requiredMethods.length && !contract.requiredErrors.length) return contract;
  const sourceFiles = contract.sourcePaths.filter((path) =>
    path.split("/").includes("src") && !/\.(?:test|spec)\.tsx?$/.test(path),
  );
  const content = sourceFiles.map((path) => {
    const absolute = resolve(workspaceRoot, path);
    if (!absolute.startsWith(`${resolve(workspaceRoot)}/`) || !existsSync(absolute)) {
      throw new ExplicitContractViolationError([`required source file ${path} was not created`]);
    }
    return readFileSync(join(workspaceRoot, path), "utf8");
  }).join("\n");
  const violations: string[] = [];
  for (const className of contract.exportedClasses) {
    if (!new RegExp(`export\\s+class\\s+${className}\\b`).test(content)) violations.push(`missing export class ${className}`);
  }
  for (const method of contract.requiredMethods) {
    if (!new RegExp(`\\b${method}\\s*(?:<[^\\n>]*>)?\\s*\\(`).test(content)) violations.push(`missing method ${method}`);
  }
  for (const errorName of contract.requiredErrors) {
    if (!new RegExp(`export\\s+class\\s+${errorName}\\b`).test(content)) violations.push(`missing error ${errorName}`);
  }
  if (violations.length) throw new ExplicitContractViolationError(violations);
  return contract;
}
