import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CodeIndex, type CodeChunkHit } from "@zintus/codebase-indexer";
import type {
  ChatMessage,
  ToolCallContentBlock,
  ToolDefinition,
} from "@zintus/types";
import type { ToolExecutionResult, ToolLoopTurn } from "./builtin-tools.js";

export type { ToolExecutionResult, ToolLoopTurn } from "./builtin-tools.js";

/**
 * A SANDBOXED coding-agent toolset for `zintus agent`. Unlike the side-effect-free
 * built-in tools, these tools READ and (with an explicit gate) WRITE files — so the
 * sandbox here is the load-bearing safety boundary, not a convenience.
 *
 * SAFETY MODEL (every layer is enforced, errors are fed back to the model, never
 * silently bypassed):
 *  1. SANDBOX ROOT — every path is path.resolve'd against a single canonical root
 *     (realpathSync'd at construction). A path that escapes the root (via `..`,
 *     an absolute path outside, or a symlink whose realpath lands outside) is
 *     REJECTED before any fs call — the model gets an error result, no file is
 *     touched.
 *  2. SIZE CAP — reads/writes over MAX_FILE_BYTES are refused.
 *  3. MUTATION BUDGET — a hard cap on the number of applied writes per run.
 *  4. WRITE GATE — write_file / apply_edit build a diff preview and require an
 *     injectable confirm() to return true before touching disk; a decline returns
 *     "user declined" and applies nothing.
 *
 * RUN_COMMAND — the ONE side-effecting non-file tool. It exists so the agent can
 * close the write→run→verify→iterate loop (run the project's tests/typecheck/
 * lint/build, read the failure, fix it). It is emphatically NOT a shell, and its
 * security model is as load-bearing as the sandbox above:
 *  a. ALLOWLIST-ONLY — the model passes a `command` string; we split it into argv
 *     on whitespace and accept it ONLY if it matches a fixed allowlist of
 *     side-effect-bounded *verification* commands (see RUN_ALLOWLIST). Anything
 *     else — rm, git, curl/wget, package installs, unknown binaries — is refused
 *     with NO process spawned.
 *  b. ARGV-ONLY, NO SHELL — we spawn the argv array directly (spawnSync, shell:
 *     false). No string is ever handed to a shell, so `;`, `&&`, `|`, backticks,
 *     `$( )`, redirection, globbing and newlines cannot chain or inject; tokens
 *     containing shell metacharacters are rejected before any match attempt.
 *  c. CONFINED — cwd is pinned to the sandbox root; the only variable argument
 *     (a `bun test <path>` target) must resolve INSIDE the sandbox or it is
 *     rejected (no spawn). A hard 120s timeout and an output byte-cap bound the
 *     blast radius; stdout/stderr are captured and truncated, never streamed to a
 *     shell.
 *  d. GATED + BUDGETED — it requires the SAME injectable confirm() gate as the
 *     write tools (a decline runs nothing) AND it is OFF unless the run config is
 *     present and `allow` is true (the CLI gates this behind `--allow-run`). Each
 *     actual run counts against a bounded run-budget (analogous to the mutation
 *     budget) so the agent cannot loop forever re-running tests.
 * The exit code + truncated output are fed back into the agent loop so the model
 * can read failures and iterate.
 */

/** Max bytes for a single read or write (1 MiB). */
export const MAX_FILE_BYTES = 1024 * 1024;

/** Default and hard cap on applied mutations (write_file + apply_edit) per run. */
export const DEFAULT_MUTATION_BUDGET = 50;

/** Default cap on run_command invocations per agent run (bounds the verify loop). */
export const DEFAULT_RUN_BUDGET = 10;

/** Hard wall-clock timeout for a single run_command (ms). */
export const RUN_COMMAND_TIMEOUT_MS = 120_000;

/** Byte cap applied to EACH of the captured stdout/stderr before feed-back. */
export const MAX_RUN_OUTPUT_BYTES = 16 * 1024;

/**
 * The fixed allowlist of verification commands run_command may execute. Each entry
 * is the EXACT argv prefix that must match; `trailingPath: true` additionally
 * permits at most one extra token that must resolve to a path INSIDE the sandbox.
 * Nothing here mutates state outside build/test output dirs, reaches the network
 * by design, or accepts free-form arguments.
 */
interface AllowedCommand {
  argv: readonly string[];
  /** Allow at most one extra trailing token, validated as a sandbox-relative path. */
  trailingPath?: boolean;
}
export const RUN_ALLOWLIST: readonly AllowedCommand[] = [
  { argv: ["bun", "run", "test"] },
  { argv: ["bun", "run", "typecheck"] },
  { argv: ["bun", "run", "lint"] },
  { argv: ["bun", "run", "build"] },
  { argv: ["bun", "run", "check"] },
  // `bun test` with an optional single sandbox-relative file/dir target.
  { argv: ["bun", "test"], trailingPath: true },
];

/** Tokens may only contain these chars — anything else (`;`, `&`, `|`, backtick,
 *  `$`, `(`, `)`, `<`, `>`, quotes, spaces-within, NUL) means a metachar/injection
 *  attempt and the whole command is refused before any allowlist match. */
const SAFE_TOKEN = /^[A-Za-z0-9._/@-]+$/;

/** Default agent loop rounds and the hard ceiling a caller may request. */
export const DEFAULT_AGENT_ROUNDS = 15;
export const MAX_AGENT_ROUNDS_CAP = 40;

/** Directories never walked by search_code / list recursion. */
const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".turbo",
  "coverage",
]);

/** Thrown when a path escapes the sandbox root. Caught by the executor and turned
 *  into an honest error result — it must never propagate to an fs call. */
export class SandboxViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxViolation";
  }
}

/**
 * Resolve `relPath` against the canonical `root` and return a SAFE absolute path,
 * or throw SandboxViolation. Enforcement is twofold:
 *  - lexical: the resolved path must equal root or sit under `root + sep`;
 *  - symlink: the realpath of the nearest existing ancestor (the file itself when
 *    it exists) must ALSO sit under root — defeating a symlink that points out.
 * The path need not exist (writes create new files); only escape is rejected.
 */
function resolveWithinRoot(root: string, relPath: string): string {
  if (typeof relPath !== "string" || relPath.length === 0) {
    throw new SandboxViolation("path is required");
  }
  // NUL bytes can truncate paths at the syscall layer — reject outright.
  if (relPath.includes("\0")) {
    throw new SandboxViolation("path contains a null byte");
  }
  const resolved = path.resolve(root, relPath);
  if (!isWithin(root, resolved)) {
    throw new SandboxViolation(
      `path escapes the sandbox root: ${relPath} (root: ${root})`,
    );
  }
  // Symlink check: walk up to the nearest existing ancestor, realpath it, and
  // re-attach the non-existent tail. If the real ancestor (a resolved symlink)
  // lands outside root, the whole path is outside root.
  let existing = resolved;
  const tail: string[] = [];
  while (!existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break; // filesystem root reached
    tail.unshift(path.basename(existing));
    existing = parent;
  }
  let realExisting: string;
  try {
    realExisting = realpathSync(existing);
  } catch {
    // Could not realpath an existing ancestor (race / permission) — fail closed.
    throw new SandboxViolation(`could not verify path is inside the sandbox: ${relPath}`);
  }
  const realFinal = tail.length ? path.join(realExisting, ...tail) : realExisting;
  if (!isWithin(root, realFinal)) {
    throw new SandboxViolation(
      `path resolves (via symlink) outside the sandbox root: ${relPath}`,
    );
  }
  return resolved;
}

/** True when `p` is the root itself or strictly contained under it. */
function isWithin(root: string, p: string): boolean {
  return p === root || p.startsWith(root + path.sep);
}

export interface AgentSandbox {
  /** Canonical (realpath'd) absolute root. */
  readonly root: string;
  /** Safe-resolve a model-supplied path or throw SandboxViolation. */
  resolve(relPath: string): string;
  /** Display a path relative to the root (for diffs/logs). */
  relative(abs: string): string;
}

/** Build a sandbox rooted at `root` (default process.cwd()). The root is
 *  realpath'd up front so all containment checks compare canonical paths. */
export function createSandbox(root?: string): AgentSandbox {
  const requested = path.resolve(root ?? process.cwd());
  if (!existsSync(requested) || !statSync(requested).isDirectory()) {
    throw new Error(`Sandbox root is not a directory: ${requested}`);
  }
  const canonical = realpathSync(requested);
  return {
    root: canonical,
    resolve: (relPath: string) => resolveWithinRoot(canonical, relPath),
    relative: (abs: string) => path.relative(canonical, abs) || ".",
  };
}

/** The confirmation gate for a mutating tool. INJECTABLE so tests can allow/deny
 *  deterministically and the CLI can wire an interactive y/N prompt. Returning
 *  false declines the write (nothing is applied). */
export type ConfirmWrite = (request: {
  toolName: string;
  /** Path relative to the sandbox root. */
  path: string;
  /** A human-readable diff preview of the pending change. */
  diff: string;
}) => boolean | Promise<boolean>;

/** Per-run mutation accounting (shared budget across all mutating calls). */
export interface MutationBudget {
  used: number;
  readonly max: number;
}

/** Per-run run_command accounting (bounds the verify loop). */
export interface RunBudget {
  used: number;
  readonly max: number;
}

/** The result of one spawned verification command (already truncated/normalized).
 *  Injectable so tests never spawn a real process. */
export interface RunCommandResult {
  /** Process exit code, or null if it was killed (e.g. on timeout). */
  code: number | null;
  stdout: string;
  stderr: string;
  /** True if the command was killed for exceeding the timeout. */
  timedOut: boolean;
}

/** Spawn an allowlisted argv inside `cwd` with a hard timeout. INJECTABLE so tests
 *  exercise the allowlist/gate/budget WITHOUT running real commands. */
export type RunCommandSpawn = (
  argv: string[],
  opts: { cwd: string; timeoutMs: number },
) => RunCommandResult | Promise<RunCommandResult>;

/** Opt-in configuration enabling run_command. ABSENT (or allow=false) means the
 *  tool refuses with no spawn — the safest default posture (gated by --allow-run). */
export interface AgentRunConfig {
  /** Master switch. False/absent => run_command refuses before doing anything. */
  allow: boolean;
  budget: RunBudget;
  /** Defaults to a real spawnSync-backed runner; overridden in tests. */
  spawn?: RunCommandSpawn;
}

/**
 * Optional configuration for the (read-only) find_relevant_code tool.
 *
 * The tool ALWAYS works, key-free. The only thing this config decides is the
 * RANKING strategy:
 *  - `embed` PROVIDED  => semantic VECTOR search (cosine over real embeddings).
 *    Wire a real embedder here (e.g. @zintus/memory's embedBatch when Ollama is
 *    configured). Pass ONLY a genuinely semantic embedder — a degraded
 *    keyword-hash embedder should be left undefined so the explicit lexical
 *    ranking (below) is used instead.
 *  - `embed` ABSENT    => key-free LEXICAL fallback (query-term / identifier /
 *    symbol-declaration / filename overlap). Useful offline, NOT true semantic.
 */
export interface AgentSemanticConfig {
  /** A semantic embedder. Present => vector search; absent => lexical fallback. */
  embed?: (texts: string[]) => Promise<number[][]>;
  /** Base directory for the per-run temp index DB (default OS temp dir). */
  indexDir?: string;
  /** Fired once, when the per-run index is first built (logging / tests). */
  onIndexBuilt?: (info: {
    mode: "vector" | "lexical";
    filesIndexed: number;
    chunksIndexed: number;
  }) => void;
}

export interface AgentToolContext {
  sandbox: AgentSandbox;
  /** Gate invoked before every applied mutation AND before every command run. */
  confirm: ConfirmWrite;
  budget: MutationBudget;
  /** Opt-in run_command support. When absent, run_command is disabled. */
  run?: AgentRunConfig;
  /** Optional ranking config for find_relevant_code (absent => lexical fallback). */
  semantic?: AgentSemanticConfig;
}

interface AgentTool {
  definition: ToolDefinition;
  /** Writes to disk (counts against the mutation budget). */
  mutating: boolean;
  /** Side-effecting — must pass the confirm() gate before it acts. */
  requiresConfirmation: boolean;
  execute: (
    args: Record<string, unknown>,
    ctx: AgentToolContext,
  ) => Promise<string>;
}

/** Build a minimal, readable line diff (common prefix/suffix collapsed). Used only
 *  for the human preview shown by the write gate — not a patch format. */
export function buildDiff(
  relPath: string,
  oldText: string,
  newText: string,
): string {
  if (oldText === newText) return `(no changes to ${relPath})`;
  const oldLines = oldText.length ? oldText.split("\n") : [];
  const newLines = newText.length ? newText.split("\n") : [];
  let pre = 0;
  while (
    pre < oldLines.length &&
    pre < newLines.length &&
    oldLines[pre] === newLines[pre]
  ) {
    pre += 1;
  }
  let suf = 0;
  while (
    suf < oldLines.length - pre &&
    suf < newLines.length - pre &&
    oldLines[oldLines.length - 1 - suf] === newLines[newLines.length - 1 - suf]
  ) {
    suf += 1;
  }
  const removed = oldLines.slice(pre, oldLines.length - suf);
  const added = newLines.slice(pre, newLines.length - suf);
  const out: string[] = [`--- a/${relPath}`, `+++ b/${relPath}`, `@@ line ${pre + 1} @@`];
  for (const l of removed) out.push(`- ${l}`);
  for (const l of added) out.push(`+ ${l}`);
  return out.join("\n");
}

function ok(data: Record<string, unknown>): string {
  return JSON.stringify(data);
}
function err(message: string): string {
  return JSON.stringify({ error: message });
}

/** Apply a write to disk after the gate approves. Centralizes the budget check,
 *  parent-dir creation, and size cap so write_file and apply_edit share it. */
async function gatedWrite(
  ctx: AgentToolContext,
  toolName: string,
  absPath: string,
  oldText: string,
  newText: string,
): Promise<string> {
  const bytes = Buffer.byteLength(newText, "utf8");
  if (bytes > MAX_FILE_BYTES) {
    return err(
      `result is ${bytes} bytes, over the ${MAX_FILE_BYTES}-byte write cap`,
    );
  }
  if (ctx.budget.used >= ctx.budget.max) {
    return err(
      `mutation budget exhausted (${ctx.budget.max} writes) — refusing further writes`,
    );
  }
  const display = ctx.sandbox.relative(absPath);
  const diff = buildDiff(display, oldText, newText);
  const approved = await ctx.confirm({ toolName, path: display, diff });
  if (!approved) {
    return ok({ declined: true, message: "user declined the write", path: display });
  }
  // Re-resolve via the sandbox right before touching disk (TOCTOU-narrowing): the
  // parent dir must still be inside the root.
  const parent = path.dirname(absPath);
  ctx.sandbox.resolve(ctx.sandbox.relative(parent));
  mkdirSync(parent, { recursive: true });
  writeFileSync(absPath, newText, "utf8");
  ctx.budget.used += 1;
  return ok({
    applied: true,
    path: display,
    bytesWritten: bytes,
    mutationsUsed: ctx.budget.used,
    mutationsRemaining: ctx.budget.max - ctx.budget.used,
  });
}

const readFile: AgentTool = {
  mutating: false,
  requiresConfirmation: false,
  definition: {
    name: "read_file",
    description:
      "Read a UTF-8 text file inside the sandbox. Returns its full content. Use a path relative to the project root.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the sandbox root" },
      },
      required: ["path"],
    },
  },
  execute: async (args, ctx) => {
    const abs = ctx.sandbox.resolve(String(args.path ?? ""));
    if (!existsSync(abs)) return err(`file not found: ${args.path}`);
    const st = statSync(abs);
    if (st.isDirectory()) return err(`path is a directory, not a file: ${args.path}`);
    if (st.size > MAX_FILE_BYTES) {
      return err(`file is ${st.size} bytes, over the ${MAX_FILE_BYTES}-byte read cap`);
    }
    return ok({ path: ctx.sandbox.relative(abs), content: readFileSync(abs, "utf8") });
  },
};

const listDirectory: AgentTool = {
  mutating: false,
  requiresConfirmation: false,
  definition: {
    name: "list_directory",
    description:
      "List the entries of a directory inside the sandbox (name + type). Defaults to the project root.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Directory path relative to the sandbox root (default '.')",
        },
      },
    },
  },
  execute: async (args, ctx) => {
    const rel = args.path == null || args.path === "" ? "." : String(args.path);
    const abs = ctx.sandbox.resolve(rel);
    if (!existsSync(abs)) return err(`directory not found: ${rel}`);
    if (!statSync(abs).isDirectory()) return err(`path is not a directory: ${rel}`);
    const entries = readdirSync(abs, { withFileTypes: true })
      .map((e) => ({
        name: e.name,
        type: e.isDirectory() ? "dir" : e.isSymbolicLink() ? "symlink" : "file",
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return ok({ path: ctx.sandbox.relative(abs), entries });
  },
};

const MAX_SEARCH_MATCHES = 200;
const MAX_SEARCH_FILES = 5000;

const searchCode: AgentTool = {
  mutating: false,
  requiresConfirmation: false,
  definition: {
    name: "search_code",
    description:
      "Search file contents under the sandbox for a literal substring (grep-like). Returns matching file/line/text. Use to locate code before editing.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Literal substring to search for" },
        path: {
          type: "string",
          description: "Directory to search under, relative to root (default '.')",
        },
      },
      required: ["query"],
    },
  },
  execute: async (args, ctx) => {
    const query = String(args.query ?? "");
    if (!query) return err("query is required");
    const rel = args.path == null || args.path === "" ? "." : String(args.path);
    const start = ctx.sandbox.resolve(rel);
    if (!existsSync(start)) return err(`path not found: ${rel}`);
    const matches: { file: string; line: number; text: string }[] = [];
    let filesScanned = 0;
    const visit = (dir: string): void => {
      if (matches.length >= MAX_SEARCH_MATCHES || filesScanned >= MAX_SEARCH_FILES) return;
      let dirents;
      try {
        dirents = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of dirents) {
        if (matches.length >= MAX_SEARCH_MATCHES) return;
        const child = path.join(dir, e.name);
        // Stay inside the sandbox; skip symlinks entirely (no escape via search).
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) {
          if (IGNORED_DIRS.has(e.name)) continue;
          if (!isWithin(ctx.sandbox.root, child)) continue;
          visit(child);
          continue;
        }
        if (!e.isFile()) continue;
        filesScanned += 1;
        let st;
        try {
          st = statSync(child);
        } catch {
          continue;
        }
        if (st.size > MAX_FILE_BYTES) continue;
        let content: string;
        try {
          content = readFileSync(child, "utf8");
        } catch {
          continue;
        }
        if (content.includes("\0")) continue; // skip binary
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i += 1) {
          if (lines[i]!.includes(query)) {
            matches.push({
              file: ctx.sandbox.relative(child),
              line: i + 1,
              text: lines[i]!.slice(0, 300),
            });
            if (matches.length >= MAX_SEARCH_MATCHES) return;
          }
        }
      }
    };
    const startStat = statSync(start);
    if (startStat.isDirectory()) visit(start);
    else {
      // Searching a single file.
      const content = readFileSync(start, "utf8");
      const lines = content.split("\n");
      for (let i = 0; i < lines.length && matches.length < MAX_SEARCH_MATCHES; i += 1) {
        if (lines[i]!.includes(query)) {
          matches.push({ file: ctx.sandbox.relative(start), line: i + 1, text: lines[i]!.slice(0, 300) });
        }
      }
    }
    return ok({ query, matchCount: matches.length, truncated: matches.length >= MAX_SEARCH_MATCHES, matches });
  },
};

// --- find_relevant_code (semantic / lexical retrieval) ---------------------

/** Default and hard cap on results returned by find_relevant_code. */
export const DEFAULT_SEMANTIC_RESULTS = 5;
export const MAX_SEMANTIC_RESULTS = 20;
/** Per-result snippet char cap (chunks are ~40-80 lines; this bounds payload). */
export const MAX_SNIPPET_CHARS = 1600;
/** Cap on distinct query terms used for lexical scoring (bounds the regex work). */
const MAX_QUERY_TERMS = 24;

/** The built, cached per-run index plus the ranking mode it will use. */
interface BuiltSemanticIndex {
  mode: "vector" | "lexical";
  index: CodeIndex;
  /** Temp dir holding the sqlite db (cleaned by the OS / test teardown). */
  dbDir: string;
}

/**
 * Per-AGENT-RUN cache: the index is built once and reused across every
 * find_relevant_code call. Keyed by the AgentToolContext object (one per run),
 * via a WeakMap so it never leaks across runs and needs no caller bookkeeping.
 */
const semanticIndexCache = new WeakMap<
  AgentToolContext,
  Promise<BuiltSemanticIndex>
>();

function getOrBuildSemanticIndex(
  ctx: AgentToolContext,
): Promise<BuiltSemanticIndex> {
  const cached = semanticIndexCache.get(ctx);
  if (cached) return cached;
  const promise = buildSemanticIndex(ctx);
  semanticIndexCache.set(ctx, promise);
  return promise;
}

async function buildSemanticIndex(
  ctx: AgentToolContext,
): Promise<BuiltSemanticIndex> {
  const embed = ctx.semantic?.embed;
  const mode: "vector" | "lexical" = embed ? "vector" : "lexical";
  const baseDir = ctx.semantic?.indexDir ?? tmpdir();
  mkdirSync(baseDir, { recursive: true });
  const dbDir = mkdtempSync(path.join(baseDir, "zintus-agent-index-"));
  // CodeIndex.indexWorkspace only walks UNDER the given root and already skips
  // node_modules/.git/build dirs, binaries and oversized files — so indexing the
  // sandbox root is itself confined to the sandbox. In lexical mode we hand it a
  // no-op embedder so indexing skips all (pointless, possibly degraded) embedding
  // work; ranking happens over the raw chunk text instead.
  const index = new CodeIndex({
    dbPath: path.join(dbDir, "code.db"),
    embed: embed ?? noopEmbed,
  });
  const stats = await index.indexWorkspace(ctx.sandbox.root);
  ctx.semantic?.onIndexBuilt?.({
    mode,
    filesIndexed: stats.filesIndexed,
    chunksIndexed: stats.chunksIndexed,
  });
  return { mode, index, dbDir };
}

/** Lexical-mode embedder: produces no vectors so indexWorkspace stores chunks
 *  WITHOUT embeddings (and never calls a real, possibly key-gated, embedder). */
const noopEmbed = async (texts: string[]): Promise<number[][]> =>
  texts.map(() => []);

function clampSemanticLimit(raw: unknown): number {
  const n =
    typeof raw === "number" && Number.isFinite(raw)
      ? Math.floor(raw)
      : DEFAULT_SEMANTIC_RESULTS;
  return Math.max(1, Math.min(MAX_SEMANTIC_RESULTS, n));
}

function capSnippet(content: string): string {
  if (content.length <= MAX_SNIPPET_CHARS) return content;
  return `${content.slice(0, MAX_SNIPPET_CHARS)}\n…[snippet truncated]`;
}

/** Distinct, lowercased query terms (>=2 chars), capped. */
function queryTerms(query: string): string[] {
  const seen = new Set<string>();
  for (const tok of query.toLowerCase().split(/[^a-z0-9_]+/)) {
    if (tok.length >= 2) seen.add(tok);
    if (seen.size >= MAX_QUERY_TERMS) break;
  }
  return [...seen];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * KEY-FREE lexical relevance score for one chunk against the query terms.
 * Rewards (per distinct term): a filename hit, whole-word identifier matches
 * (with a small frequency bump), and — most strongly — the term appearing as a
 * DECLARED symbol name (function/class/const/...). A multiplier rewards chunks
 * that cover MORE of the distinct query terms. This is keyword/symbol overlap,
 * NOT semantic meaning — but it makes the tool genuinely useful with no key.
 */
function lexicalScore(
  terms: string[],
  chunk: { path: string; content: string },
): number {
  if (!terms.length) return 0;
  const content = chunk.content;
  const lower = content.toLowerCase();
  const pathLower = chunk.path.toLowerCase();
  let score = 0;
  let matchedDistinct = 0;
  for (const term of terms) {
    let termScore = 0;
    if (pathLower.includes(term)) termScore += 3;
    const esc = escapeRegExp(term);
    const wordMatches = (lower.match(new RegExp(`\\b${esc}\\b`, "g")) ?? [])
      .length;
    if (wordMatches > 0) {
      termScore += 1 + Math.log2(1 + wordMatches);
      if (
        new RegExp(
          `\\b(?:function|class|interface|type|enum|struct|impl|trait|def|fn|func|const|let|var)\\s+${esc}\\b`,
          "i",
        ).test(content)
      ) {
        termScore += 4;
      }
    } else if (lower.includes(term)) {
      termScore += 0.5; // partial / substring hit
    }
    if (termScore > 0) matchedDistinct += 1;
    score += termScore;
  }
  if (score === 0) return 0;
  // Reward breadth of coverage across the distinct query terms.
  return score * (1 + matchedDistinct / terms.length);
}

function rankLexically(
  query: string,
  chunks: Array<{
    path: string;
    startLine: number;
    endLine: number;
    content: string;
  }>,
): CodeChunkHit[] {
  const terms = queryTerms(query);
  const scored: CodeChunkHit[] = [];
  for (const chunk of chunks) {
    const score = lexicalScore(terms, chunk);
    if (score > 0) scored.push({ ...chunk, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

const findRelevantCode: AgentTool = {
  mutating: false,
  requiresConfirmation: false,
  definition: {
    name: "find_relevant_code",
    description:
      "Find the code most RELEVANT to a natural-language query across the whole sandbox, returning the top files with their line range + a snippet. Use this to locate WHERE a concept/feature lives when you don't know the exact text to grep for — it complements search_code (literal substring). Ranking: when a semantic embedder is configured it uses vector similarity; otherwise it falls back to a KEY-FREE lexical ranking (query-term, identifier, symbol-declaration and filename overlap) that still works offline but is not true semantic search. Read-only; the index is built once per run and results + snippets are capped.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Natural-language description of the code you're looking for",
        },
        limit: {
          type: "number",
          description: `Max results (default ${DEFAULT_SEMANTIC_RESULTS}, max ${MAX_SEMANTIC_RESULTS})`,
        },
      },
      required: ["query"],
    },
  },
  execute: async (args, ctx) => {
    const query = String(args.query ?? "");
    if (!query.trim()) return err("query is required");
    const limit = clampSemanticLimit(args.limit);

    const built = await getOrBuildSemanticIndex(ctx);
    // Over-fetch in vector mode so sandbox filtering still leaves `limit` hits.
    const hits =
      built.mode === "vector"
        ? await built.index.searchCode(query, limit * 4)
        : rankLexically(query, built.index.allChunks());

    const root = ctx.sandbox.root;
    const results: {
      file: string;
      startLine: number;
      endLine: number;
      score: number;
      snippet: string;
    }[] = [];
    for (const hit of hits) {
      // Defense in depth: only ever surface files INSIDE the sandbox root, even
      // though CodeIndex already walked only under it.
      const abs = path.resolve(hit.path);
      if (!isWithin(root, abs)) continue;
      results.push({
        file: ctx.sandbox.relative(abs),
        startLine: hit.startLine,
        endLine: hit.endLine,
        score: Math.round(hit.score * 1000) / 1000,
        snippet: capSnippet(hit.content),
      });
      if (results.length >= limit) break;
    }
    return ok({
      query,
      mode: built.mode,
      resultCount: results.length,
      results,
    });
  },
};

const writeFile: AgentTool = {
  mutating: true,
  requiresConfirmation: true,
  definition: {
    name: "write_file",
    description:
      "Create or overwrite a text file inside the sandbox with the given content. Requires user confirmation (a diff is shown). Use apply_edit for surgical changes to an existing file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the sandbox root" },
        content: { type: "string", description: "Full new file content" },
      },
      required: ["path", "content"],
    },
  },
  execute: async (args, ctx) => {
    const abs = ctx.sandbox.resolve(String(args.path ?? ""));
    if (existsSync(abs) && statSync(abs).isDirectory()) {
      return err(`path is a directory, not a file: ${args.path}`);
    }
    const content = String(args.content ?? "");
    const oldText = existsSync(abs) ? readFileSync(abs, "utf8") : "";
    return gatedWrite(ctx, "write_file", abs, oldText, content);
  },
};

const applyEdit: AgentTool = {
  mutating: true,
  requiresConfirmation: true,
  definition: {
    name: "apply_edit",
    description:
      "Replace an EXACT, UNIQUE occurrence of old_string with new_string in an existing file. Errors if old_string is not found or matches more than once (make it more specific). Requires user confirmation.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the sandbox root" },
        old_string: { type: "string", description: "Exact text to find (must be unique)" },
        new_string: { type: "string", description: "Replacement text" },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  execute: async (args, ctx) => {
    const abs = ctx.sandbox.resolve(String(args.path ?? ""));
    if (!existsSync(abs)) return err(`file not found: ${args.path}`);
    if (statSync(abs).isDirectory()) return err(`path is a directory, not a file: ${args.path}`);
    const oldString = String(args.old_string ?? "");
    const newString = String(args.new_string ?? "");
    if (oldString === "") return err("old_string must be non-empty");
    if (oldString === newString) return err("old_string and new_string are identical");
    const content = readFileSync(abs, "utf8");
    // Count occurrences without regex (literal, overlap-free).
    let count = 0;
    let idx = content.indexOf(oldString);
    while (idx !== -1) {
      count += 1;
      idx = content.indexOf(oldString, idx + oldString.length);
    }
    if (count === 0) return err("old_string not found in file (no edit applied)");
    if (count > 1) {
      return err(
        `old_string matches ${count} times — make it unique (no edit applied)`,
      );
    }
    const newText = content.replace(oldString, newString);
    return gatedWrite(ctx, "apply_edit", abs, content, newText);
  },
};

/** Truncate `s` to MAX_RUN_OUTPUT_BYTES, marking when bytes were dropped. */
function truncateOutput(s: string): { text: string; truncated: boolean } {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= MAX_RUN_OUTPUT_BYTES) return { text: s, truncated: false };
  const head = buf.subarray(0, MAX_RUN_OUTPUT_BYTES).toString("utf8");
  return {
    text: `${head}\n…[truncated ${buf.length - MAX_RUN_OUTPUT_BYTES} bytes]`,
    truncated: true,
  };
}

/**
 * Parse a model-supplied command STRING into a validated argv, or return an error.
 * Pure + side-effect-free: it NEVER spawns. Enforces (in order): non-empty,
 * tokenizes on whitespace ONLY (no shell), every token must match SAFE_TOKEN (so
 * metachars/injection are refused), the argv must match a RUN_ALLOWLIST entry, and
 * any `trailingPath` argument must resolve INSIDE the sandbox.
 */
export function resolveAllowedCommand(
  command: string,
  sandbox: AgentSandbox,
): { argv: string[] } | { error: string } {
  if (typeof command !== "string" || command.trim() === "") {
    return { error: "command is required" };
  }
  if (command.includes("\0")) return { error: "command contains a null byte" };
  const tokens = command.trim().split(/\s+/);
  for (const tok of tokens) {
    if (!SAFE_TOKEN.test(tok)) {
      return {
        error: `command token "${tok}" contains disallowed characters (no shell metacharacters or chaining)`,
      };
    }
  }
  for (const allowed of RUN_ALLOWLIST) {
    const base = allowed.argv;
    const prefixMatches =
      tokens.length >= base.length && base.every((t, i) => tokens[i] === t);
    if (!prefixMatches) continue;
    const extra = tokens.slice(base.length);
    if (extra.length === 0) return { argv: [...tokens] };
    if (allowed.trailingPath && extra.length === 1) {
      // The single target must resolve inside the sandbox or we refuse (no spawn).
      try {
        sandbox.resolve(extra[0]!);
      } catch (e) {
        return {
          error: e instanceof Error ? e.message : "path argument escapes the sandbox",
        };
      }
      return { argv: [...tokens] };
    }
    // Right prefix but too many / disallowed trailing args.
    return {
      error: `command "${command}" has arguments that are not allowed`,
    };
  }
  return {
    error: `command not allowed: "${command}". Allowed: ${RUN_ALLOWLIST.map((a) => a.argv.join(" ") + (a.trailingPath ? " [path]" : "")).join(", ")}`,
  };
}

/** The default spawner: runs the argv directly (NO shell), pinned to `cwd`, with a
 *  hard timeout and a large maxBuffer (output is truncated downstream regardless). */
const defaultRunSpawn: RunCommandSpawn = (argv, opts) => {
  const [cmd, ...rest] = argv;
  const res = spawnSync(cmd!, rest, {
    cwd: opts.cwd,
    timeout: opts.timeoutMs,
    shell: false, // argv-only — never hand a string to a shell.
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  const timedOut =
    res.error != null &&
    (res.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
  const stderr = res.error && !timedOut
    ? `${res.stderr ?? ""}\n${res.error.message}`
    : res.stderr ?? "";
  return {
    code: res.status,
    stdout: res.stdout ?? "",
    stderr,
    timedOut,
  };
};

const runCommand: AgentTool = {
  mutating: false,
  requiresConfirmation: true,
  definition: {
    name: "run_command",
    description:
      "Run ONE allowlisted verification command at the sandbox root to check your edits (write→run→verify→fix). Allowed: `bun run test`, `bun run typecheck`, `bun run lint`, `bun run build`, `bun run check`, and `bun test <path>`. This is NOT a shell: no other commands, no chaining (`;`/`&&`/`|`/`$()`/backticks), no flags. Requires user confirmation and is bounded by a run budget; returns the exit code and (truncated) output so you can read failures and fix them.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description:
            "One allowlisted command exactly, e.g. 'bun run test' or 'bun test path/to/file.test.ts'",
        },
      },
      required: ["command"],
    },
  },
  execute: async (args, ctx) => {
    // OFF by default: refuse with NO spawn unless explicitly enabled (--allow-run).
    if (!ctx.run || !ctx.run.allow) {
      return err(
        "run_command is disabled. Re-run with --allow-run to let the agent run allowlisted verification commands.",
      );
    }
    const resolved = resolveAllowedCommand(String(args.command ?? ""), ctx.sandbox);
    if ("error" in resolved) return err(resolved.error); // rejected — never spawned

    // Budget BEFORE the gate (mirrors gatedWrite): an exhausted budget refuses
    // without prompting and without spawning.
    if (ctx.run.budget.used >= ctx.run.budget.max) {
      return err(
        `run budget exhausted (${ctx.run.budget.max} commands) — refusing further runs`,
      );
    }

    const argvStr = resolved.argv.join(" ");
    const approved = await ctx.confirm({
      toolName: "run_command",
      path: argvStr,
      diff: `$ ${argvStr}`,
    });
    if (!approved) {
      return ok({ declined: true, message: "user declined the command", command: argvStr });
    }

    const spawn = ctx.run.spawn ?? defaultRunSpawn;
    const result = await spawn(resolved.argv, {
      cwd: ctx.sandbox.root,
      timeoutMs: RUN_COMMAND_TIMEOUT_MS,
    });
    ctx.run.budget.used += 1;

    const out = truncateOutput(result.stdout);
    const errOut = truncateOutput(result.stderr);
    return ok({
      command: argvStr,
      exitCode: result.code,
      timedOut: result.timedOut,
      stdout: out.text,
      stderr: errOut.text,
      outputTruncated: out.truncated || errOut.truncated,
      runsUsed: ctx.run.budget.used,
      runsRemaining: ctx.run.budget.max - ctx.run.budget.used,
    });
  },
};

export const AGENT_TOOLS: AgentTool[] = [
  readFile,
  listDirectory,
  searchCode,
  findRelevantCode,
  writeFile,
  applyEdit,
  runCommand,
];

/** The model-visible name of the opt-in run_command tool. */
export const RUN_COMMAND_TOOL_NAME = "run_command";

/** Definitions offered to the model for `zintus agent`. */
export const AGENT_TOOL_DEFINITIONS: ToolDefinition[] = AGENT_TOOLS.map(
  (t) => t.definition,
);

const AGENT_TOOLS_BY_NAME = new Map(AGENT_TOOLS.map((t) => [t.definition.name, t]));

/** True if `name` is a mutating agent tool (for transparency labeling). */
export function isMutatingTool(name: string): boolean {
  return AGENT_TOOLS_BY_NAME.get(name)?.mutating ?? false;
}

/** True if `name` is a side-effecting tool gated by the confirm() prompt
 *  (write_file, apply_edit, run_command). */
export function toolRequiresConfirmation(name: string): boolean {
  return AGENT_TOOLS_BY_NAME.get(name)?.requiresConfirmation ?? false;
}

/**
 * Execute one model tool call against the sandboxed agent tools. NEVER throws —
 * a sandbox violation, unknown tool, or fs failure is returned as a structured
 * `isError` result so the model can recover (and, critically, so an escape attempt
 * is surfaced rather than executed).
 */
export async function executeAgentToolCall(
  call: { id: string; name: string; arguments: Record<string, unknown> },
  ctx: AgentToolContext,
): Promise<ToolExecutionResult> {
  const tool = AGENT_TOOLS_BY_NAME.get(call.name);
  if (!tool) {
    return {
      toolCallId: call.id,
      content: err(`unknown tool: ${call.name}`),
      isError: true,
    };
  }
  try {
    const content = await tool.execute(call.arguments ?? {}, ctx);
    let isError = false;
    try {
      const parsed = JSON.parse(content) as Record<string, unknown>;
      isError = parsed != null && typeof parsed === "object" && "error" in parsed;
    } catch {
      isError = false;
    }
    return { toolCallId: call.id, content, isError };
  } catch (error) {
    // SandboxViolation lands here too — surfaced as an honest error, never run.
    return {
      toolCallId: call.id,
      content: err(error instanceof Error ? error.message : "tool failed"),
      isError: true,
    };
  }
}

export interface AgentLoopHandlers<R extends ToolLoopTurn> {
  /** Route + stream a single turn (the agent tools are passed by the caller). */
  route: (messages: ChatMessage[], round: number) => Promise<R>;
  /** Execute a single tool call (async — the write gate may prompt). */
  execute: (call: ToolCallContentBlock) => Promise<ToolExecutionResult>;
  maxRounds?: number;
  onRouted?: (result: R, round: number) => void | Promise<void>;
  onChunk?: (chunk: string) => void;
  onTurnEnd?: () => void;
  onToolCalls?: (calls: ToolCallContentBlock[]) => void;
  onToolResult?: (
    result: ToolExecutionResult,
    call: ToolCallContentBlock,
  ) => void | Promise<void>;
  onStopped?: (maxRounds: number) => void;
}

/**
 * The bounded route→execute→feed-back loop for the agent, mirroring
 * runBuiltinToolLoop but with an ASYNC executor (the write gate awaits user
 * confirmation). Stops on the first round with no tool calls (final answer) or at
 * `maxRounds` (bounded — a runaway model is surfaced, never looped forever).
 */
export async function runAgentToolLoop<R extends ToolLoopTurn>(
  messages: ChatMessage[],
  handlers: AgentLoopHandlers<R>,
): Promise<{ finalResult: R; rounds: number }> {
  const maxRounds = Math.min(
    handlers.maxRounds ?? DEFAULT_AGENT_ROUNDS,
    MAX_AGENT_ROUNDS_CAP,
  );
  const convo: ChatMessage[] = [...messages];
  let finalResult!: R;

  for (let round = 0; round <= maxRounds; round += 1) {
    const result = await handlers.route(convo, round);
    finalResult = result;
    await handlers.onRouted?.(result, round);

    let streamedText = "";
    for await (const chunk of result.stream) {
      streamedText += chunk;
      handlers.onChunk?.(chunk);
    }
    handlers.onTurnEnd?.();

    const calls = result.toolCalls ?? [];
    if (calls.length === 0) return { finalResult: result, rounds: round + 1 };

    handlers.onToolCalls?.(calls);

    if (round === maxRounds) {
      handlers.onStopped?.(maxRounds);
      return { finalResult: result, rounds: round + 1 };
    }

    const results: ToolExecutionResult[] = [];
    for (const c of calls) {
      const r = await handlers.execute(c);
      results.push(r);
      await handlers.onToolResult?.(r, c);
    }

    convo.push({
      role: "assistant",
      content: [
        ...(streamedText.trim()
          ? [{ type: "text" as const, text: streamedText }]
          : []),
        ...calls,
      ],
    });
    convo.push({
      role: "user",
      content: results.map((r) => ({
        type: "tool_result" as const,
        toolCallId: r.toolCallId,
        content: r.content,
        isError: r.isError,
      })),
    });
  }

  return { finalResult, rounds: maxRounds + 1 };
}
