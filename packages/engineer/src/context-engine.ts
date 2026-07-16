import { realpathSync } from "node:fs";
import { basename, extname } from "node:path";
import { execFile } from "node:child_process";
import { z } from "zod";
import {
  CONTEXT_CONTRACT_VERSION,
  CONTEXT_MAX_EXCERPT_CHARS,
  CONTEXT_MAX_DETECTED_COMMANDS,
  CONTEXT_MAX_DETECTION_PATHS,
  CONTEXT_MAX_FILE_BYTES,
  CONTEXT_MAX_RELEVANT_FILES,
  CONTEXT_MAX_SOURCE_FILES,
  ContextManifestContentSchema,
  ContextManifestSchema,
  ContextSourceSchema,
  ContextWarningSchema,
  RepositoryContextPathSchema,
  contextSourceId,
  type ContextManifest,
  type ContextManifestContent,
  type ContextSource,
  type ContextWarning,
} from "./context-contracts.js";
import { sha256 } from "./hash.js";

const INPUT_SCHEMA = z.object({
  runId: z.string().min(1).max(200),
  repositoryId: z.string().min(1).max(200),
  repositoryRoot: z.string().min(1).max(4_000),
  baseCommitSha: z.string().regex(/^[a-f0-9]{40}$|^[a-f0-9]{64}$/i),
  request: z.string().min(1).max(100_000),
}).strict();

const EXCERPT_CHARS_PER_FILE = Math.floor(CONTEXT_MAX_EXCERPT_CHARS / CONTEXT_MAX_RELEVANT_FILES);
const SOURCE_EXTENSIONS = new Set([
  ".c", ".cc", ".cpp", ".cs", ".css", ".go", ".h", ".hpp", ".html", ".java", ".js", ".jsx",
  ".kt", ".kts", ".php", ".py", ".rb", ".rs", ".scss", ".sh", ".sql", ".swift", ".ts", ".tsx", ".vue",
]);
const CONFIG_NAMES = /(^|\/)([^/]+\.(config|conf|toml|ya?ml|jsonc)|tsconfig[^/]*\.json|Dockerfile|Makefile|\.env\.example)$/i;
const TEST_PATH = /(^|\/)(__tests__|test|tests|spec|specs)(\/|$)|\.(test|spec)\.[^.\/]+$/i;
const CI_PATH = /(^|\/)(\.github\/workflows|\.gitlab-ci\.yml|\.circleci|azure-pipelines\.yml)(\/|$)/i;
const DOC_PATH = /(^|\/)(README|CONTRIBUTING|SECURITY|AGENTS)(\.[^/]*)?$/i;
const MANIFEST_NAMES = new Set(["package.json", "pyproject.toml", "requirements.txt", "Cargo.toml", "go.mod", "Gemfile"]);
const LOCKFILE_NAMES = new Set(["bun.lock", "bun.lockb", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "uv.lock", "poetry.lock", "Cargo.lock", "go.sum", "Gemfile.lock"]);
const PROMPT_INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior)\s+instructions?/i,
  /(?:system|developer)\s+(?:message|prompt|instructions?)/i,
  /reveal|exfiltrat|upload\s+(?:the\s+)?(?:secret|credential|token)/i,
  /do\s+not\s+tell\s+(?:the\s+)?user/i,
];

interface TreeEntry {
  mode: string;
  type: string;
  objectId: string;
  size: number | null;
  path: string;
}

interface Candidate {
  path: string;
  objectId: string;
  byteSize: number;
  content: string;
  kind: ContextSource["kind"];
  relevanceScore: number;
  signals: ContextSource["signals"];
}

export interface ContextEngineOptions { maxGitOutputBytes?: number; totalTimeoutMs?: number }

function runGit(cwd: string, args: string[], maxOutputBytes = 8 * 1024 * 1024, signal?: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-C", cwd, ...args], {
      timeout: 120_000,
      encoding: "buffer",
      maxBuffer: maxOutputBytes,
      windowsHide: true,
      ...(signal ? { signal } : {}),
    }, (error, stdout, stderr) => {
      const output = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? "");
      const errorText = Buffer.isBuffer(stderr) ? stderr.toString("utf8").trim() : String(stderr ?? "").trim();
      if ((error as NodeJS.ErrnoException | null)?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || (error as NodeJS.ErrnoException | null)?.code === "ENOBUFS") {
        reject(new Error(`git output exceeded ${maxOutputBytes} byte context limit`));
        return;
      }
      if (error) {
        reject(new Error(`git ${args[0] ?? "command"} failed: ${errorText || error.message || "unknown error"}`));
        return;
      }
      if (output.byteLength > maxOutputBytes) {
        reject(new Error(`git output exceeded ${maxOutputBytes} byte context limit`));
        return;
      }
      resolve(output);
    });
  });
}

function parseTree(buffer: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  for (const raw of buffer.toString("utf8").split("\0")) {
    if (!raw) continue;
    const tab = raw.indexOf("\t");
    if (tab < 0) continue;
    const metadata = raw.slice(0, tab).split(/\s+/);
    if (metadata.length !== 4) continue;
    const [mode, type, objectId, rawSize] = metadata as [string, string, string, string];
    entries.push({ mode, type, objectId, size: rawSize === "-" ? null : Number(rawSize), path: raw.slice(tab + 1) });
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path, "en"));
}

function classify(path: string): ContextSource["kind"] {
  if (CI_PATH.test(path)) return "CI";
  if (TEST_PATH.test(path)) return "TEST";
  if (MANIFEST_NAMES.has(basename(path))) return "MANIFEST";
  if (LOCKFILE_NAMES.has(basename(path))) return "LOCKFILE";
  if (CONFIG_NAMES.test(path)) return "CONFIG";
  if (DOC_PATH.test(path) || /\.(md|mdx|rst|txt)$/i.test(path)) return "DOCUMENTATION";
  if (SOURCE_EXTENSIONS.has(extname(path).toLowerCase())) return "SOURCE";
  return "OTHER";
}

function requestTerms(request: string): string[] {
  return [...new Set(request.toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? [])]
    .filter((term) => !["and", "the", "this", "that", "with", "from", "into", "for"].includes(term))
    .sort();
}

function relevance(path: string, content: string, kind: ContextSource["kind"], terms: string[]): {
  score: number;
  signals: ContextSource["signals"];
} {
  const normalizedPath = path.toLowerCase();
  const normalizedContent = content.toLowerCase();
  const signals = new Set<ContextSource["signals"][number]>();
  const pathMatches = terms.filter((term) => normalizedPath.includes(term)).length;
  const contentMatches = terms.filter((term) => normalizedContent.includes(term)).length;
  if (pathMatches) signals.add("REQUEST_PATH_MATCH");
  if (contentMatches) signals.add("REQUEST_CONTENT_MATCH");
  let score = pathMatches * 20 + Math.min(contentMatches, 10) * 4;
  if (kind === "MANIFEST") { score += 14; signals.add("STACK_MANIFEST"); }
  if (kind === "LOCKFILE") { score += 12; signals.add("LOCKFILE_DETECTED"); }
  if (kind === "CONFIG") { score += 10; signals.add("CONFIGURATION"); }
  if (kind === "TEST") { score += 8; signals.add("TEST_FILE"); }
  if (kind === "CI") { score += 6; signals.add("CI_CONFIGURATION"); }
  if (kind === "SOURCE") score += 4;
  if (kind === "DOCUMENTATION") score += 2;
  if (PROMPT_INJECTION_PATTERNS.some((pattern) => pattern.test(content))) {
    score += 5;
    signals.add("PROMPT_INJECTION_SENTINEL");
  }
  return { score, signals: [...signals].sort() };
}

function warning(input: Omit<ContextWarning, "warningId">): ContextWarning {
  return ContextWarningSchema.parse({
    ...input,
    warningId: `context-warning:${sha256(input).slice("sha256:".length)}`,
  });
}

function addPackageDetections(
  path: string,
  content: string,
  stacks: Set<string>,
  scripts: ContextManifestContent["detections"]["scripts"],
): boolean {
  if (basename(path) !== "package.json") return false;
  stacks.add("JavaScript/TypeScript");
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const dependencies = { ...(parsed.dependencies as Record<string, unknown> | undefined), ...(parsed.devDependencies as Record<string, unknown> | undefined) };
    for (const [dependency, stack] of [["next", "Next.js"], ["react", "React"], ["expo", "Expo"], ["typescript", "TypeScript"], ["bun", "Bun"]] as const) {
      if (dependency in dependencies || String(parsed.packageManager ?? "").startsWith(`${dependency}@`)) stacks.add(stack);
    }
    if (parsed.scripts && typeof parsed.scripts === "object" && !Array.isArray(parsed.scripts)) {
      for (const [name, command] of Object.entries(parsed.scripts as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b, "en"))) {
        if (typeof command === "string" && name && command) {
          if (scripts.length < CONTEXT_MAX_DETECTED_COMMANDS) {
            scripts.push({ path, name: name.slice(0, 200), command: command.slice(0, 4_000), trust: "UNTRUSTED_REPOSITORY_CONTENT" });
          }
        }
      }
    }
  } catch {
    // Invalid repository JSON remains untrusted input and simply yields no scripts.
  }
  return true;
}

function detectStackFromPath(path: string, stacks: Set<string>): void {
  const name = basename(path);
  if (name === "pyproject.toml" || name === "requirements.txt") stacks.add("Python");
  if (name === "Cargo.toml") stacks.add("Rust");
  if (name === "go.mod") stacks.add("Go");
  if (name === "Gemfile") stacks.add("Ruby");
  if (/^tsconfig.*\.json$/i.test(name)) stacks.add("TypeScript");
  if (name === "Dockerfile") stacks.add("Docker");
  if (["bun.lock", "bun.lockb", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"].includes(name)) stacks.add("JavaScript/TypeScript");
}

function addCiCommands(path: string, content: string, commands: ContextManifestContent["detections"]["ciCommands"]): boolean {
  if (!CI_PATH.test(path)) return false;
  let truncated = false;
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    const match = /^\s*(?:-\s*)?(?:run|script):\s*(.+?)\s*$/.exec(line);
    if (!match?.[1]) continue;
    if (commands.length >= CONTEXT_MAX_DETECTED_COMMANDS) { truncated = true; break; }
    commands.push({ path, name: `line-${index + 1}`, command: match[1].slice(0, 4_000), trust: "UNTRUSTED_REPOSITORY_CONTENT" });
  }
  return truncated;
}

export class ContextEngine {
  constructor(private readonly options: ContextEngineOptions) {}

  async build(rawInput: z.input<typeof INPUT_SCHEMA>): Promise<ContextManifest> {
    const input = INPUT_SCHEMA.parse(rawInput);
    const repositoryRoot = realpathSync(input.repositoryRoot);
    const totalTimeoutMs = this.options.totalTimeoutMs ?? 120_000;
    if (!Number.isSafeInteger(totalTimeoutMs) || totalTimeoutMs < 1_000 || totalTimeoutMs > 300_000) throw new Error("context total timeout must be between 1 and 300 seconds");
    const signal = AbortSignal.timeout(totalTimeoutMs);
    const resolved = (await runGit(repositoryRoot, ["rev-parse", "--verify", `${input.baseCommitSha}^{commit}`], 1_024, signal)).toString("utf8").trim();
    if (resolved.toLowerCase() !== input.baseCommitSha.toLowerCase()) throw new Error("context base did not resolve exactly");
    return this.scan(repositoryRoot, input, signal);
  }

  private async scan(workspaceRoot: string, input: z.output<typeof INPUT_SCHEMA>, signal: AbortSignal): Promise<ContextManifest> {
    const entries = parseTree(await runGit(workspaceRoot, ["ls-tree", "-rz", "-l", "--full-tree", input.baseCommitSha], this.options.maxGitOutputBytes, signal));
    const considered = entries.slice(0, CONTEXT_MAX_SOURCE_FILES);
    const warnings: ContextWarning[] = [];
    const candidates: Candidate[] = [];
    const stacks = new Set<string>();
    const scripts: ContextManifestContent["detections"]["scripts"] = [];
    const ciCommands: ContextManifestContent["detections"]["ciCommands"] = [];
    const configPaths: string[] = [];
    const lockfilePaths: string[] = [];
    const testPaths: string[] = [];
    const ciPaths: string[] = [];
    const terms = requestTerms(input.request);
    let symlinksSkipped = 0;
    let oversizedFilesSkipped = 0;
    let binaryFilesSkipped = 0;
    let scriptCapReached = false;
    let detectionCapReached = false;
    let relevantCandidateCount = 0;

    if (entries.length > CONTEXT_MAX_SOURCE_FILES) {
      warnings.push(warning({ runId: input.runId, code: "SOURCE_FILE_CAP_REACHED", path: null, sourceId: null, trust: "TRUSTED_GIT_METADATA", message: `Only the first ${CONTEXT_MAX_SOURCE_FILES} deterministic Git paths were considered.` }));
    }

    for (const entry of considered) {
      const parsedPath = RepositoryContextPathSchema.safeParse(entry.path);
      if (!parsedPath.success) {
        warnings.push(warning({ runId: input.runId, code: "UNSAFE_PATH_SKIPPED", path: null, sourceId: null, trust: "TRUSTED_GIT_METADATA", message: "A non-portable or unsafe Git path was excluded from context." }));
        continue;
      }
      const path = parsedPath.data;
      if (entry.mode === "120000") {
        symlinksSkipped += 1;
        warnings.push(warning({ runId: input.runId, code: "SYMLINK_SKIPPED", path, sourceId: null, trust: "TRUSTED_GIT_METADATA", message: "Symbolic links are never read by the Context Engine." }));
        continue;
      }
      if (entry.type !== "blob") continue;
      if (entry.size === null || entry.size > CONTEXT_MAX_FILE_BYTES) {
        oversizedFilesSkipped += 1;
        warnings.push(warning({ runId: input.runId, code: "OVERSIZED_FILE_SKIPPED", path, sourceId: null, trust: "TRUSTED_GIT_METADATA", message: `File exceeds the ${CONTEXT_MAX_FILE_BYTES}-byte context limit.` }));
        continue;
      }
      const bytes = await runGit(workspaceRoot, ["cat-file", "blob", entry.objectId], 8 * 1024 * 1024, signal);
      if (bytes.byteLength !== entry.size || bytes.includes(0)) {
        binaryFilesSkipped += 1;
        warnings.push(warning({ runId: input.runId, code: "BINARY_FILE_SKIPPED", path, sourceId: null, trust: "TRUSTED_GIT_METADATA", message: "Binary or size-mismatched content was excluded from context." }));
        continue;
      }
      let content: string;
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        binaryFilesSkipped += 1;
        warnings.push(warning({ runId: input.runId, code: "BINARY_FILE_SKIPPED", path, sourceId: null, trust: "TRUSTED_GIT_METADATA", message: "Non-UTF-8 content was excluded from context." }));
        continue;
      }
      const kind = classify(path);
      const addDetectionPath = (target: string[]) => {
        if (target.length < CONTEXT_MAX_DETECTION_PATHS) target.push(path);
        else detectionCapReached = true;
      };
      if (kind === "CONFIG" || kind === "MANIFEST") addDetectionPath(configPaths);
      if (kind === "LOCKFILE") addDetectionPath(lockfilePaths);
      if (kind === "TEST") addDetectionPath(testPaths);
      if (kind === "CI") addDetectionPath(ciPaths);
      detectStackFromPath(path, stacks);
      const hasScripts = addPackageDetections(path, content, stacks, scripts);
      if (scripts.length >= CONTEXT_MAX_DETECTED_COMMANDS) scriptCapReached = true;
      if (addCiCommands(path, content, ciCommands)) scriptCapReached = true;
      const scored = relevance(path, content, kind, terms);
      if (hasScripts && scripts.some((script) => script.path === path)) scored.signals.push("SCRIPT_DEFINITION");
      if (PROMPT_INJECTION_PATTERNS.some((pattern) => pattern.test(content))) {
        warnings.push(warning({ runId: input.runId, code: "PROMPT_INJECTION_SUSPECTED", path, sourceId: null, trust: "UNTRUSTED_REPOSITORY_CONTENT", message: "Repository text resembles prompt instructions; it remains untrusted data and grants no authority." }));
      }
      relevantCandidateCount += 1;
      candidates.push({ path, objectId: entry.objectId, byteSize: bytes.byteLength, content, kind, relevanceScore: scored.score, signals: [...new Set(scored.signals)].sort() });
      candidates.sort((left, right) => right.relevanceScore - left.relevanceScore || left.path.localeCompare(right.path, "en"));
      if (candidates.length > CONTEXT_MAX_RELEVANT_FILES) candidates.pop();
    }

    if (scriptCapReached) {
      warnings.push(warning({ runId: input.runId, code: "SCRIPT_CAP_REACHED", path: null, sourceId: null, trust: "TRUSTED_GIT_METADATA", message: `Detected package/CI commands were limited to ${CONTEXT_MAX_DETECTED_COMMANDS} entries per category.` }));
    }
    if (detectionCapReached) {
      warnings.push(warning({ runId: input.runId, code: "DETECTION_CAP_REACHED", path: null, sourceId: null, trust: "TRUSTED_GIT_METADATA", message: `Detected config/test/CI/lockfile paths were limited to ${CONTEXT_MAX_DETECTION_PATHS} entries per category.` }));
    }

    if (relevantCandidateCount > CONTEXT_MAX_RELEVANT_FILES) {
      warnings.push(warning({ runId: input.runId, code: "RELEVANT_FILE_CAP_REACHED", path: null, sourceId: null, trust: "TRUSTED_GIT_METADATA", message: `Relevant context was limited to ${CONTEXT_MAX_RELEVANT_FILES} files.` }));
    }
    const selected = candidates.slice(0, CONTEXT_MAX_RELEVANT_FILES);
    if (selected.reduce((sum, candidate) => sum + candidate.content.length, 0) > CONTEXT_MAX_EXCERPT_CHARS) {
      warnings.push(warning({ runId: input.runId, code: "EXCERPT_CAP_REACHED", path: null, sourceId: null, trust: "TRUSTED_GIT_METADATA", message: `Context excerpts were limited to ${CONTEXT_MAX_EXCERPT_CHARS} characters.` }));
    }

    let remainingExcerptChars = CONTEXT_MAX_EXCERPT_CHARS;
    const sources = selected.map((candidate) => {
      const excerptLength = Math.min(candidate.content.length, EXCERPT_CHARS_PER_FILE, remainingExcerptChars);
      const excerpt = candidate.content.slice(0, excerptLength);
      remainingExcerptChars -= excerpt.length;
      // Git objectId binds the full blob; contentHash binds the exact bounded bytes sent to models.
      const contentHash = sha256(excerpt);
      return ContextSourceSchema.parse({
        sourceId: contextSourceId({ runId: input.runId, baseCommitSha: input.baseCommitSha, path: candidate.path, objectId: candidate.objectId, contentHash }),
        runId: input.runId,
        path: candidate.path,
        kind: candidate.kind,
        trust: "UNTRUSTED_REPOSITORY_CONTENT",
        sourceType: "GIT_OBJECT",
        baseCommitSha: input.baseCommitSha,
        objectId: candidate.objectId,
        byteSize: candidate.byteSize,
        contentHash,
        excerptHash: sha256(excerpt),
        excerpt,
        excerptTruncated: excerpt.length < candidate.content.length,
        relevanceScore: candidate.relevanceScore,
        signals: candidate.signals,
      });
    });

    const content = ContextManifestContentSchema.parse({
      contextVersion: CONTEXT_CONTRACT_VERSION,
      runId: input.runId,
      repositoryId: input.repositoryId,
      baseCommitSha: input.baseCommitSha,
      requestHash: sha256(input.request),
      caps: {
        maxSourceFiles: CONTEXT_MAX_SOURCE_FILES,
        maxRelevantFiles: CONTEXT_MAX_RELEVANT_FILES,
        maxExcerptChars: CONTEXT_MAX_EXCERPT_CHARS,
        maxFileBytes: CONTEXT_MAX_FILE_BYTES,
      },
      filesDiscovered: entries.length,
      filesConsidered: considered.length,
      symlinksSkipped,
      oversizedFilesSkipped,
      binaryFilesSkipped,
      sources,
      detections: {
        trust: "UNTRUSTED_REPOSITORY_CONTENT",
        stacks: [...stacks].sort(),
        scripts: scripts.sort((left, right) => left.path.localeCompare(right.path, "en") || left.name.localeCompare(right.name, "en")),
        ciCommands: ciCommands.sort((left, right) => left.path.localeCompare(right.path, "en") || left.name.localeCompare(right.name, "en")),
        configPaths: [...new Set(configPaths)].sort(),
        lockfilePaths: [...new Set(lockfilePaths)].sort(),
        testPaths: [...new Set(testPaths)].sort(),
        ciPaths: [...new Set(ciPaths)].sort(),
      },
      warnings: warnings.sort((left, right) => left.code.localeCompare(right.code, "en") || (left.path ?? "").localeCompare(right.path ?? "", "en")),
    });
    return ContextManifestSchema.parse({ ...content, manifestHash: sha256(content) });
  }
}
