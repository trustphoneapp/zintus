import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import { z } from "zod";
import type { LocalArtifactStore } from "./artifact-store.js";
import type { TaskManifest } from "./contracts.js";
import { ArtifactRecordSchema, type ArtifactRecord, type WorkspaceRecord } from "./execution-contracts.js";
import { canonicalJson, sha256 } from "./hash.js";
import { isManifestPathAllowed, normalizeRepositoryPath } from "./manifest-files.js";
import type { EngineerSupervisor } from "./supervisor.js";

export const TEST_BASELINE_POLICY_VERSION = "engineer-test-baseline-v1" as const;
const HashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const ShaSchema = z.string().regex(/^[a-f0-9]{40}$|^[a-f0-9]{64}$/i);
const MAX_TEST_SURFACE_FILES = 20_000;
const MAX_TEST_SURFACE_FILE_BYTES = 4 * 1024 * 1024;
const MAX_TEST_SURFACE_TOTAL_BYTES = 128 * 1024 * 1024;

export const TestBaselineEntrySchema = z.object({
  path: z.string().min(1).max(2_000),
  gitBlobObjectId: z.string().regex(/^[a-f0-9]{40}$|^[a-f0-9]{64}$/i),
  contentSha256: HashSchema,
  byteLength: z.number().int().nonnegative(),
  fileMode: z.string().regex(/^[0-7]{6}$/),
  classification: z.enum(["IMMUTABLE", "PLAN_AUTHORIZED_CHANGE"]),
}).strict();

const TestBaselineContentSchema = z.object({
  policyVersion: z.literal(TEST_BASELINE_POLICY_VERSION),
  runId: z.string().min(1).max(200),
  manifestHash: HashSchema,
  baseCommitSha: ShaSchema,
  entries: z.array(TestBaselineEntrySchema).max(MAX_TEST_SURFACE_FILES),
  createdAt: z.string().datetime({ offset: true }),
}).strict();

export const TestBaselineManifestSchema = TestBaselineContentSchema.extend({ baselineHash: HashSchema }).strict()
  .superRefine((manifest, context) => {
    const { baselineHash, ...content } = manifest;
    if (sha256(content) !== baselineHash) context.addIssue({ code: z.ZodIssueCode.custom, message: "test baseline hash mismatch", path: ["baselineHash"] });
    const paths = manifest.entries.map((entry) => entry.path);
    if (new Set(paths).size !== paths.length || [...paths].sort().some((path, index) => path !== paths[index])) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "test baseline paths must be unique and sorted", path: ["entries"] });
    }
  });

export const TestIntegrityComparisonSchema = z.object({
  policyVersion: z.literal(TEST_BASELINE_POLICY_VERSION),
  runId: z.string().min(1).max(200),
  baselineHash: HashSchema,
  stage: z.string().min(1).max(200),
  immutableChanges: z.array(z.string().min(1).max(2_000)),
  authorizedChanges: z.array(z.string().min(1).max(2_000)),
  builderAuthoredTests: z.array(z.string().min(1).max(2_000)),
  commandMutationChecks: z.number().int().nonnegative(),
  passed: z.boolean(),
  comparedAt: z.string().datetime({ offset: true }),
  comparisonHash: HashSchema,
}).strict().superRefine((comparison, context) => {
  const { comparisonHash, ...content } = comparison;
  if (sha256(content) !== comparisonHash) context.addIssue({ code: z.ZodIssueCode.custom, message: "test integrity comparison hash mismatch", path: ["comparisonHash"] });
  if (comparison.passed !== (comparison.immutableChanges.length === 0)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "test integrity pass flag is inconsistent", path: ["passed"] });
  }
});

export type TestBaselineManifest = z.infer<typeof TestBaselineManifestSchema>;
export type TestIntegrityComparison = z.infer<typeof TestIntegrityComparisonSchema>;

export class TestIntegrityViolationError extends Error {
  readonly reasonCode: "TEST_BASELINE_TAMPERED" | "TEST_RUN_MUTATED_TEST_SURFACE";
  readonly evidenceId: string | null;
  constructor(reasonCode: TestIntegrityViolationError["reasonCode"], message: string, evidenceId: string | null = null) {
    super(message); this.name = "TestIntegrityViolationError"; this.reasonCode = reasonCode; this.evidenceId = evidenceId;
  }
}

interface IndexedFile { path: string; mode: string; objectId: string }
interface CurrentEntry { path: string; contentSha256: string; byteLength: number; fileMode: string }

/** Match JavaScript's deterministic default string ordering without locale-dependent collation. */
function compareRepositoryPaths(left: { path: string }, right: { path: string }): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

/** Tests, fixtures, snapshots, runner policy, and CI test definitions form one protected surface. */
export function isTestSurfacePath(rawPath: string): boolean {
  const path = normalizeRepositoryPath(rawPath).toLowerCase();
  const base = path.split("/").at(-1) ?? path;
  if (/(?:^|\/)(?:__tests__|__snapshots__|tests?|specs?|fixtures?|cypress|playwright)(?:\/|$)/.test(path)) return true;
  if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(base) || /(?:^|\.)test\.py$/.test(base)) return true;
  if (/^(?:vitest|jest|playwright|cypress|pytest|karma|ava|mocha)(?:\.[\w-]+)*\.(?:js|cjs|mjs|ts|json|toml|ini)$/.test(base)) return true;
  if (/^(?:package\.json|bun\.lockb?|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(base)) return true;
  if (path.startsWith(".github/workflows/") && /(?:test|ci|verify|security)/.test(base)) return true;
  return false;
}

function rawSha256(bytes: Uint8Array): `sha256:${string}` { return `sha256:${createHash("sha256").update(bytes).digest("hex")}`; }

function runGit(workspaceRoot: string, args: string[]): string {
  const result = spawnSync("git", ["-C", workspaceRoot, ...args], {
    shell: false, encoding: "utf8", timeout: 120_000, maxBuffer: 32 * 1024 * 1024,
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
  });
  if (result.status !== 0) throw new Error(`test integrity Git inspection failed: ${result.stderr || result.error?.message || "unknown error"}`);
  return result.stdout ?? "";
}

function baseTreeFiles(workspaceRoot: string): IndexedFile[] {
  return runGit(workspaceRoot, ["ls-tree", "-r", "-z", "--full-tree", "HEAD"]).split("\0").filter(Boolean).map((record) => {
    const tab = record.indexOf("\t");
    const metadata = tab >= 0 ? record.slice(0, tab) : "";
    const path = tab >= 0 ? record.slice(tab + 1) : "";
    const [mode, objectType, objectId] = metadata.split(/\s+/);
    if (objectType !== "blob") throw new Error(`test surface base-tree entry is not a blob: ${path}`);
    if (!mode || !objectId || !path) throw new Error("Git returned an invalid indexed test file record");
    return { path: normalizeRepositoryPath(path), mode, objectId };
  });
}

function currentPaths(workspaceRoot: string): string[] {
  return runGit(workspaceRoot, ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--"])
    .split("\0").filter(Boolean).map(normalizeRepositoryPath);
}

function readCurrentEntry(workspaceRoot: string, path: string): CurrentEntry {
  const root = realpathSync(workspaceRoot);
  const target = resolve(root, path);
  if (!target.startsWith(`${root}${sep}`)) throw new TestIntegrityViolationError("TEST_BASELINE_TAMPERED", `test path escaped workspace: ${path}`);
  const stat = lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new TestIntegrityViolationError("TEST_BASELINE_TAMPERED", `test surface entry is not a regular file: ${path}`);
  if (stat.size > MAX_TEST_SURFACE_FILE_BYTES) throw new Error(`test surface file exceeds the ${MAX_TEST_SURFACE_FILE_BYTES}-byte limit: ${path}`);
  const bytes = readFileSync(target);
  return { path, contentSha256: rawSha256(bytes), byteLength: bytes.byteLength, fileMode: (stat.mode & 0o111) === 0 ? "100644" : "100755" };
}

function assertSurfaceBounds(entries: Array<{ byteLength: number }>): void {
  if (entries.length > MAX_TEST_SURFACE_FILES) throw new Error(`test surface exceeds the ${MAX_TEST_SURFACE_FILES}-file limit`);
  if (entries.reduce((sum, entry) => sum + entry.byteLength, 0) > MAX_TEST_SURFACE_TOTAL_BYTES) {
    throw new Error(`test surface exceeds the ${MAX_TEST_SURFACE_TOTAL_BYTES}-byte aggregate limit`);
  }
}

export function createTestBaseline(input: { runId: string; manifest: TaskManifest; workspace: WorkspaceRecord; now?: () => Date;
  verifiedSeedHeadCommitSha?: string }): TestBaselineManifest {
  if (input.manifest.runId !== input.runId || input.workspace.runId !== input.runId) throw new Error("test baseline inputs belong to different runs");
  if (input.workspace.baseCommitSha.toLowerCase() !== input.manifest.repository.baseCommitSha.toLowerCase()) throw new Error("test baseline workspace does not match the frozen base");
  const head = runGit(input.workspace.workspaceRoot, ["rev-parse", "--verify", "HEAD^{commit}"]).trim();
  const expectedHead = (input.verifiedSeedHeadCommitSha ?? input.workspace.baseCommitSha).toLowerCase();
  if (head.toLowerCase() !== expectedHead) {
    throw new TestIntegrityViolationError("TEST_BASELINE_TAMPERED", "test baseline workspace HEAD does not match the frozen base");
  }
  if (runGit(input.workspace.workspaceRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).length > 0) {
    throw new TestIntegrityViolationError("TEST_BASELINE_TAMPERED", "workspace contains changes before test baseline capture");
  }
  const entries = baseTreeFiles(input.workspace.workspaceRoot).filter((entry) => isTestSurfacePath(entry.path)).map((entry) => {
    const current = readCurrentEntry(input.workspace.workspaceRoot, entry.path);
    if (current.fileMode !== entry.mode) {
      throw new TestIntegrityViolationError("TEST_BASELINE_TAMPERED", `test surface was modified before baseline capture: ${entry.path}`);
    }
    return TestBaselineEntrySchema.parse({ ...current, gitBlobObjectId: entry.objectId, classification: isManifestPathAllowed(entry.path, input.manifest) ? "PLAN_AUTHORIZED_CHANGE" : "IMMUTABLE" });
  }).sort(compareRepositoryPaths);
  assertSurfaceBounds(entries);
  const content = TestBaselineContentSchema.parse({
    policyVersion: TEST_BASELINE_POLICY_VERSION, runId: input.runId, manifestHash: input.manifest.manifestHash,
    baseCommitSha: input.workspace.baseCommitSha, entries, createdAt: (input.now ?? (() => new Date()))().toISOString(),
  });
  return TestBaselineManifestSchema.parse({ ...content, baselineHash: sha256(content) });
}

function currentTestSurface(workspaceRoot: string): CurrentEntry[] {
  const entries = currentPaths(workspaceRoot).filter(isTestSurfacePath).map((path) => readCurrentEntry(workspaceRoot, path));
  entries.sort(compareRepositoryPaths); assertSurfaceBounds(entries); return entries;
}

export function currentTestSurfaceHash(workspaceRoot: string): string {
  return sha256({ policyVersion: TEST_BASELINE_POLICY_VERSION, entries: currentTestSurface(workspaceRoot) });
}

export function compareTestBaseline(input: { baseline: TestBaselineManifest; workspaceRoot: string; stage: string; commandMutationChecks?: number; now?: () => Date }): TestIntegrityComparison {
  const baseline = TestBaselineManifestSchema.parse(input.baseline);
  const current = new Map(currentTestSurface(input.workspaceRoot).map((entry) => [entry.path, entry]));
  const immutableChanges: string[] = [], authorizedChanges: string[] = [];
  for (const entry of baseline.entries) {
    const candidate = current.get(entry.path);
    const changed = !candidate || candidate.contentSha256 !== entry.contentSha256 || candidate.byteLength !== entry.byteLength || candidate.fileMode !== entry.fileMode;
    if (changed) (entry.classification === "IMMUTABLE" ? immutableChanges : authorizedChanges).push(entry.path);
    current.delete(entry.path);
  }
  const content = {
    policyVersion: TEST_BASELINE_POLICY_VERSION, runId: baseline.runId, baselineHash: baseline.baselineHash, stage: input.stage,
    immutableChanges: immutableChanges.sort(), authorizedChanges: authorizedChanges.sort(), builderAuthoredTests: [...current.keys()].sort(),
    commandMutationChecks: input.commandMutationChecks ?? 0, passed: immutableChanges.length === 0,
    comparedAt: (input.now ?? (() => new Date()))().toISOString(),
  };
  return TestIntegrityComparisonSchema.parse({ ...content, comparisonHash: sha256(content) });
}

type GuardOptions = { supervisor: EngineerSupervisor; artifactStore: LocalArtifactStore; manifest: TaskManifest; workspace: WorkspaceRecord;
  now?: () => Date; verifiedSeedHeadCommitSha?: string;strictArtifactReads?:boolean };

export class TestIntegrityGuard {
  private commandMutationChecks = 0;
  private constructor(private readonly options: GuardOptions, private readonly baseline: TestBaselineManifest) {
    if (baseline.runId !== options.manifest.runId || baseline.manifestHash !== options.manifest.manifestHash || baseline.baseCommitSha.toLowerCase() !== options.workspace.baseCommitSha.toLowerCase()) {
      throw new TestIntegrityViolationError("TEST_BASELINE_TAMPERED", "test baseline is not bound to the active run, manifest, and base");
    }
  }

  static createAndRecord(options: GuardOptions): TestIntegrityGuard {
    const baseline = createTestBaseline({ runId: options.manifest.runId, manifest: options.manifest, workspace: options.workspace, now: options.now,
      ...(options.verifiedSeedHeadCommitSha ? { verifiedSeedHeadCommitSha: options.verifiedSeedHeadCommitSha } : {}) });
    const guard = new TestIntegrityGuard(options, baseline);
    guard.record("TEST_BASELINE_MANIFEST", baseline);
    return guard;
  }

  static load(options: GuardOptions): TestIntegrityGuard {
    const artifact = options.supervisor.listArtifacts(options.manifest.runId).filter((candidate) => candidate.type === "TEST_BASELINE_MANIFEST" && candidate.trusted).at(-1);
    if (!artifact) throw new TestIntegrityViolationError("TEST_BASELINE_TAMPERED", "trusted test baseline manifest is unavailable");
    try {
      const bytes=options.strictArtifactReads?options.artifactStore.readVerifiedExact(artifact):options.artifactStore.read(artifact);
      const baseline = TestBaselineManifestSchema.parse(JSON.parse(bytes.toString("utf8")));
      return new TestIntegrityGuard(options, baseline);
    } catch (error) {
      if (error instanceof TestIntegrityViolationError) throw error;
      throw new TestIntegrityViolationError("TEST_BASELINE_TAMPERED", `trusted test baseline manifest failed validation: ${error instanceof Error ? error.message : String(error)}`, artifact.artifactId);
    }
  }

  captureCommandSnapshot(): string { return currentTestSurfaceHash(this.options.workspace.workspaceRoot); }

  assertCommandDidNotMutate(beforeHash: string, command: string): void {
    const afterHash = currentTestSurfaceHash(this.options.workspace.workspaceRoot); this.commandMutationChecks += 1;
    if (afterHash === beforeHash) return;
    const artifact = this.record("TEST_COMMAND_MUTATION", {
      policyVersion: TEST_BASELINE_POLICY_VERSION, runId: this.options.manifest.runId, baselineHash: this.baseline.baselineHash,
      command, beforeHash, afterHash, detectedAt: (this.options.now ?? (() => new Date()))().toISOString(),
    });
    throw new TestIntegrityViolationError("TEST_RUN_MUTATED_TEST_SURFACE", `verification command mutated the protected test surface: ${command}`, artifact.artifactId);
  }

  attest(stage: string): { comparison: TestIntegrityComparison; artifact: ArtifactRecord } {
    const prepared=this.prepareAttestation(stage),comparison=prepared.comparison,
      artifact=this.options.supervisor.recordArtifact(prepared.artifact);
    this.options.supervisor.recordTestIntegrityAttestation(artifact.artifactId, comparison);
    if (!comparison.passed) throw new TestIntegrityViolationError("TEST_BASELINE_TAMPERED", `immutable test surface changed at ${stage}: ${comparison.immutableChanges.join(", ")}`, artifact.artifactId);
    return { comparison, artifact };
  }

  /**
   * Builds a content-addressed comparison without making it authoritative.
   * Optional-hardening uses this to include PRE_REVIEW in the single atomic
   * Reviewer-ingress transaction; a crash can leave only an unreferenced file.
   */
  prepareAttestation(stage:string,options:{comparedAt?:string;artifactId?:string}={}):{
    comparison:TestIntegrityComparison;artifact:ArtifactRecord}{
    const comparedAt=options.comparedAt,
      comparison=compareTestBaseline({baseline:this.baseline,workspaceRoot:this.options.workspace.workspaceRoot,
        stage,commandMutationChecks:this.commandMutationChecks,
        now:comparedAt===undefined?this.options.now:()=>new Date(comparedAt)}),
      pending=this.options.artifactStore.put({runId:this.options.manifest.runId,type:"TEST_INTEGRITY_COMPARISON",
        bytes:canonicalJson(comparison),producerType:"SYSTEM",producerId:"engineer-supervisor-test-integrity",trusted:true,
        createdAt:comparison.comparedAt}),artifact=ArtifactRecordSchema.parse({
          ...pending,...(options.artifactId===undefined?{}:{artifactId:options.artifactId})});
    return {comparison,artifact};
  }

  manifest(): TestBaselineManifest { return this.baseline; }

  private record(type: string, value: unknown): ArtifactRecord {
    return this.options.supervisor.recordArtifact(this.options.artifactStore.put({
      runId: this.options.manifest.runId, type, bytes: canonicalJson(value), producerType: "SYSTEM",
      producerId: "engineer-supervisor-test-integrity", trusted: true,
    }));
  }
}
