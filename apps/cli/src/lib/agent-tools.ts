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
  ContentBlock,
  ToolCallContentBlock,
  ToolDefinition,
} from "@zintus/types";
import { countTokensFast, createCCRStore, retrieve } from "tokzen";
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

/**
 * Context-management (B1) defaults. The agent's `convo` grows unbounded with every
 * tool_result fed back; left alone it eventually crosses the provider context window
 * on long tasks. We track an APPROXIMATE token size of `convo` (via tokzen's
 * `countTokensFast`) and, once it crosses `DEFAULT_CONTEXT_BUDGET_TOKENS`, COMPACT by
 * EVICTING the bulky tool_result blocks in the OLDER middle of the conversation into a
 * content-addressed (CCR) store, leaving a short, honest pointer the model can pull
 * back on demand via the `retrieve` tool. Nothing is fabricated and nothing is silently
 * lost — every evicted block is re-fetchable by hash.
 */
/** Token budget that triggers compaction (sane CLI default; most models are ≥128k). */
export const DEFAULT_CONTEXT_BUDGET_TOKENS = 96_000;
/** Trailing ReAct turns kept VERBATIM (each round adds an assistant + a tool_result
 *  message, so the live tail spans `2 × liveTailTurns` messages — kept atomic). */
export const DEFAULT_LIVE_TAIL_TURNS = 3;
/** Minimum token size of a tool_result before it is eligible for eviction (tiny
 *  results cost nothing to keep and stay legible inline). */
export const DEFAULT_MIN_EVICT_TOKENS = 200;

/** Cap on plan steps the model may set (bounded — the plan stays legible). */
export const MAX_PLAN_STEPS = 20;
/** Per-step text cap (a plan step is a short line, not a paragraph). */
export const MAX_PLAN_STEP_CHARS = 200;

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

/** Status of a single plan step. The model owns these — we NEVER auto-advance a
 *  step the model didn't itself mark (honest planning, no fake autonomy). */
export type PlanStepStatus = "pending" | "in_progress" | "done";

/** One ordered step in the model's plan. */
export interface PlanStep {
  text: string;
  status: PlanStepStatus;
}

/**
 * The model-driven plan for an agent run, captured + tracked in loop state. The
 * plan is the MODEL'S: it is set (and re-set, with updated statuses) via the
 * update_plan tool. `revision` counts how many times the model rewrote it.
 */
export interface PlanState {
  steps: PlanStep[];
  revision: number;
}

/** A fresh, empty plan (revision 0, no steps) for the start of a run. */
export function createPlanState(): PlanState {
  return { steps: [], revision: 0 };
}

const PLAN_STATUSES: ReadonlySet<string> = new Set<PlanStepStatus>([
  "pending",
  "in_progress",
  "done",
]);

/**
 * Normalize the model-supplied `steps` argument into a bounded PlanStep[], or
 * return an error. Accepts either bare strings (=> pending) or {step|text, status}
 * objects. Over-long lists/texts are truncated rather than rejected (bounded).
 */
function normalizePlanSteps(raw: unknown): PlanStep[] | { error: string } {
  if (!Array.isArray(raw)) return { error: "steps must be an array" };
  if (raw.length === 0) return { error: "steps must be a non-empty array" };
  const steps: PlanStep[] = [];
  for (const item of raw.slice(0, MAX_PLAN_STEPS)) {
    let text: string;
    let status: PlanStepStatus = "pending";
    if (typeof item === "string") {
      text = item;
    } else if (item != null && typeof item === "object") {
      const obj = item as Record<string, unknown>;
      text = String(obj.step ?? obj.text ?? "");
      const s = typeof obj.status === "string" ? obj.status : "pending";
      status = PLAN_STATUSES.has(s) ? (s as PlanStepStatus) : "pending";
    } else {
      continue;
    }
    text = text.trim();
    if (!text) continue;
    if (text.length > MAX_PLAN_STEP_CHARS) {
      text = `${text.slice(0, MAX_PLAN_STEP_CHARS)}…`;
    }
    steps.push({ text, status });
  }
  if (steps.length === 0) return { error: "no valid steps provided" };
  return steps;
}

/** A one-line "N/M done[, K in progress]" summary of a plan's status. */
export function planStatusSummary(steps: PlanStep[]): string {
  const done = steps.filter((s) => s.status === "done").length;
  const inProgress = steps.filter((s) => s.status === "in_progress").length;
  return `${done}/${steps.length} done${inProgress ? `, ${inProgress} in progress` : ""}`;
}

/** One applied write, recorded as the run progresses (for the change summary). */
export interface ChangeLogEntry {
  /** Path relative to the sandbox root. */
  path: string;
  /** The tool that performed the write (write_file | apply_edit). */
  tool: string;
  /** Bytes written by this mutation. */
  bytes: number;
}

/** A per-file rollup of the change log (distinct files, write counts, tools). */
export interface RunChangeSummary {
  files: { path: string; writes: number; tools: string[] }[];
  /** Total applied mutations (== changeLog.length == budget.used). */
  mutations: number;
}

/**
 * Roll a change log up into a per-DISTINCT-file summary. Only files ACTUALLY
 * mutated through the loop appear — we never claim a write that didn't happen.
 */
export function summarizeChanges(changeLog: ChangeLogEntry[]): RunChangeSummary {
  const byPath = new Map<
    string,
    { path: string; writes: number; tools: Set<string> }
  >();
  for (const e of changeLog) {
    const cur =
      byPath.get(e.path) ?? { path: e.path, writes: 0, tools: new Set<string>() };
    cur.writes += 1;
    cur.tools.add(e.tool);
    byPath.set(e.path, cur);
  }
  const files = [...byPath.values()]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((f) => ({ path: f.path, writes: f.writes, tools: [...f.tools] }));
  return { files, mutations: changeLog.length };
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

// --- B1: context management (tool-result eviction + compaction) -------------

/** The content-addressed retrieval store backing eviction. Structural alias for
 *  tokzen's CCR store so we needn't import its (un-exported) interface name. */
export type CCRStore = ReturnType<typeof createCCRStore>;

/** Create a CCR store for a run. Thin wrapper so the CLI/tests have one import site. */
export function createContextStore(dbPath?: string): CCRStore {
  return createCCRStore(dbPath);
}

/** The dim, honest pointer that REPLACES an evicted tool_result's content. It states
 *  the exact token count saved and the hash to pull the original back with. */
export function formatEvictionPointer(tokens: number, hash: string): string {
  return `[evicted ${tokens} tokens — retrieve("${hash}") to restore]`;
}

/** Matches a content string that is already an eviction pointer (so we never
 *  double-evict a pointer or store a pointer as if it were real content). */
const EVICTION_POINTER_RE = /^\[evicted \d+ tokens — retrieve\("[0-9a-fA-F]+"\) to restore\]$/;
export function isEvictionPointer(s: string): boolean {
  return EVICTION_POINTER_RE.test(s.trim());
}

/** Serialize one content block to plain text for APPROXIMATE token counting. */
function blockToText(b: ContentBlock): string {
  switch (b.type) {
    case "text":
      return b.text;
    case "tool_call":
      return `${b.name} ${JSON.stringify(b.arguments)}`;
    case "tool_result":
      return b.content;
    case "image":
      return "[image]";
    default:
      return "";
  }
}

/** Serialize one message to plain text (string content passes through). */
function messageToText(m: ChatMessage): string {
  return typeof m.content === "string"
    ? m.content
    : m.content.map(blockToText).join("\n");
}

/** Approximate token size of the whole conversation (serialized, then tokzen). */
export function countConvoTokens(messages: ChatMessage[]): number {
  return countTokensFast(messages.map(messageToText).join("\n"));
}

/** Configuration for between-rounds context compaction. Injectable end-to-end so
 *  tests drive it with a temp store + a tiny budget. ABSENT on the loop => no
 *  compaction (back-compat: the loop behaves exactly as before). */
export interface AgentContextConfig {
  /** Store evicted tool_result bodies are written to (retrievable by hash). */
  store: CCRStore;
  /** Token budget that triggers compaction (default DEFAULT_CONTEXT_BUDGET_TOKENS). */
  budgetTokens?: number;
  /** Verbatim trailing turns (default DEFAULT_LIVE_TAIL_TURNS). */
  liveTailTurns?: number;
  /** Min tool_result token size eligible for eviction (default DEFAULT_MIN_EVICT_TOKENS). */
  minEvictTokens?: number;
  /** Tag stored entries with this session id (for store-side grouping/TTL). */
  sessionId?: string;
}

/** The outcome of a compaction pass (honest, fully accounted). */
export interface CompactionResult {
  /** True only when at least one block was actually evicted. */
  compacted: boolean;
  /** Approx tokens removed from `convo` by this pass (before − after). */
  savedTokens: number;
  /** Number of tool_result blocks evicted into the store. */
  evicted: number;
  tokensBefore: number;
  tokensAfter: number;
}

/**
 * Compact `convo` IN PLACE when it crosses the token budget by evicting the bulky
 * tool_result blocks in its OLDER middle into `cfg.store`, replacing each with a short
 * pointer. PRESERVED verbatim, always: (a) the FIRST message (system preamble + task),
 * and (b) the live tail — the last `2 × liveTailTurns` messages, which keeps every
 * tool_call and its matching tool_result atomic (we never split a pair). Returns a
 * fully-accounted CompactionResult. Bounded + honest: under budget => no-op; evicted
 * content is never lost — the model can `retrieve("<hash>")` it back on demand.
 */
export function maybeCompactConvo(
  convo: ChatMessage[],
  cfg: AgentContextConfig,
): CompactionResult {
  const budget = cfg.budgetTokens ?? DEFAULT_CONTEXT_BUDGET_TOKENS;
  const tokensBefore = countConvoTokens(convo);
  if (tokensBefore <= budget) {
    return {
      compacted: false,
      savedTokens: 0,
      evicted: 0,
      tokensBefore,
      tokensAfter: tokensBefore,
    };
  }
  const tailTurns = cfg.liveTailTurns ?? DEFAULT_LIVE_TAIL_TURNS;
  const minEvict = cfg.minEvictTokens ?? DEFAULT_MIN_EVICT_TOKENS;
  // Keep message[0] (preamble+task) and the last 2×turns messages verbatim. The
  // eviction zone is the older middle: [1, length − tailCount).
  const tailCount = Math.max(0, tailTurns) * 2;
  const evictEnd = Math.max(1, convo.length - tailCount);
  let evicted = 0;
  for (let i = 1; i < evictEnd; i += 1) {
    const m = convo[i]!;
    if (typeof m.content === "string" || !Array.isArray(m.content)) continue;
    for (const block of m.content) {
      if (block.type !== "tool_result") continue;
      if (isEvictionPointer(block.content)) continue; // already evicted — skip
      const tk = countTokensFast(block.content);
      if (tk < minEvict) continue; // small results stay inline (legible, cheap)
      const hash = cfg.store.store(block.content, "tool_result", {
        sessionId: cfg.sessionId,
        originalTokens: tk,
      });
      block.content = formatEvictionPointer(tk, hash);
      evicted += 1;
    }
  }
  const tokensAfter = countConvoTokens(convo);
  return {
    compacted: evicted > 0,
    savedTokens: Math.max(0, tokensBefore - tokensAfter),
    evicted,
    tokensBefore,
    tokensAfter,
  };
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
  /** Model-driven plan, captured + tracked across the run. ABSENT => update_plan
   *  is a no-op error and the run proceeds without a plan (back-compat). */
  plan?: PlanState;
  /** Optional per-file change log; gatedWrite appends each APPLIED mutation here.
   *  ABSENT => no change summary is collected (back-compat). */
  changeLog?: ChangeLogEntry[];
  /** Context-management config. Its `store` backs the `retrieve` tool so the model
   *  can pull evicted tool_result content back by hash. ABSENT => retrieve refuses. */
  context?: AgentContextConfig;
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
  // Record the applied mutation for the end-of-run change summary (honest: only
  // writes that actually hit disk are logged).
  ctx.changeLog?.push({ path: display, tool: toolName, bytes });
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

/** The model-visible name of the planning tool. */
export const UPDATE_PLAN_TOOL_NAME = "update_plan";

const updatePlan: AgentTool = {
  mutating: false,
  requiresConfirmation: false,
  definition: {
    name: UPDATE_PLAN_TOOL_NAME,
    description:
      "Record or update your ordered plan for the task. Call this FIRST, before editing, with a short ordered list of steps; then call it again as you work to update step statuses (mark a step 'in_progress' when you start it and 'done' when you finish it). Always re-send the FULL ordered list. This plan is shown to the user — it does not read or write files and does not count against any budget.",
    parameters: {
      type: "object",
      properties: {
        steps: {
          type: "array",
          description: `The full ordered plan (max ${MAX_PLAN_STEPS} steps).`,
          items: {
            type: "object",
            properties: {
              step: { type: "string", description: "Short description of the step" },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "done"],
                description: "Step status (defaults to pending)",
              },
            },
            required: ["step"],
          },
        },
      },
      required: ["steps"],
    },
  },
  execute: async (args, ctx) => {
    if (!ctx.plan) {
      return err("planning is not enabled for this run");
    }
    const normalized = normalizePlanSteps(args.steps);
    if (!Array.isArray(normalized)) return err(normalized.error);
    ctx.plan.steps = normalized;
    ctx.plan.revision += 1;
    return ok({
      planUpdated: true,
      revision: ctx.plan.revision,
      steps: normalized.map((s) => ({ step: s.text, status: s.status })),
      summary: planStatusSummary(normalized),
    });
  },
};

/** The model-visible name of the context-retrieval tool (B1). */
export const RETRIEVE_TOOL_NAME = "retrieve";

/**
 * B1 retrieval tool: restore the FULL content of a tool_result that was evicted from
 * the conversation to save context. The model is handed a pointer
 * `[evicted N tokens — retrieve("<hash>") to restore]`; calling this with that hash
 * returns the original verbatim (or, with an optional `query`, only the most relevant
 * sections via the store's BM25). Read-only; honest — it can only return content that
 * was actually stored.
 */
const retrieveTool: AgentTool = {
  mutating: false,
  requiresConfirmation: false,
  definition: {
    name: RETRIEVE_TOOL_NAME,
    description:
      "Restore the full content of an earlier tool result that was EVICTED from the conversation to save context. When you see a pointer like `[evicted 1234 tokens — retrieve(\"abc123\") to restore]`, call this with that hash to read the original content. Optionally pass `query` to get only the most relevant sections of a large result. Read-only.",
    parameters: {
      type: "object",
      properties: {
        hash: {
          type: "string",
          description: "The hash from an `[evicted … retrieve(\"<hash>\")]` pointer",
        },
        query: {
          type: "string",
          description: "Optional: return only sections relevant to this query",
        },
      },
      required: ["hash"],
    },
  },
  execute: async (args, ctx) => {
    const store = ctx.context?.store;
    if (!store) {
      return err("retrieve is unavailable: no context store is configured for this run");
    }
    const hash = String(args.hash ?? "").trim();
    if (!hash) return err("hash is required");
    const query =
      typeof args.query === "string" && args.query.trim() ? args.query : undefined;
    const content = retrieve(hash, query, store);
    if (content == null) {
      return err(`no evicted content found for hash ${hash}`);
    }
    return ok({ hash, content });
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
  updatePlan,
  readFile,
  listDirectory,
  searchCode,
  findRelevantCode,
  retrieveTool,
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
  /** B1: between-rounds context compaction. ABSENT => the loop never compacts
   *  (back-compat). When the serialized `convo` crosses the budget, the loop evicts
   *  bulky older tool_results into `context.store` and replaces them with pointers. */
  context?: AgentContextConfig;
  /** Fired only when a compaction pass actually evicted something (for a dim log). */
  onCompact?: (result: CompactionResult) => void;
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
): Promise<{ finalResult: R; rounds: number; convo: ChatMessage[] }> {
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
    if (calls.length === 0) return { finalResult: result, rounds: round + 1, convo };

    handlers.onToolCalls?.(calls);

    if (round === maxRounds) {
      handlers.onStopped?.(maxRounds);
      return { finalResult: result, rounds: round + 1, convo };
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

    // B1: after appending this round's tool results, compact if we've crossed the
    // token budget. Eviction mutates `convo` in place (older bulky tool_results ->
    // pointers); the live tail + preamble are preserved, and evicted content stays
    // retrievable by hash. No-op (and no log) when under budget.
    if (handlers.context) {
      const compaction = maybeCompactConvo(convo, handlers.context);
      if (compaction.compacted) handlers.onCompact?.(compaction);
    }
  }

  return { finalResult, rounds: maxRounds + 1, convo };
}

// --- B3: test-gated verify→revise controller --------------------------------

/** Bounded number of revise rounds the controller will drive on a FAILING verify
 *  before surfacing an honest failure. A deterministic gate, not a workflow engine. */
export const MAX_REVISE = 2;

/** The result of one deterministic verify run (already parsed from run_command). */
export interface VerifyOutcome {
  /** True iff the verify command exited 0. */
  pass: boolean;
  /** The exact allowlisted command that ran (e.g. "bun run test"). */
  command: string;
  /** Truncated captured output, for feeding a failure back to the model. */
  stdout?: string;
  stderr?: string;
  /** Process exit code (null if killed/timed-out). */
  code?: number | null;
}

/** Injectable dependencies for the verify→revise controller. Everything the
 *  controller needs is a function so it is fully unit-testable WITHOUT spawning a
 *  process or routing a real model. */
export interface VerifyReviseDeps {
  /** True iff the model made mutating edits this run (no edits => no verify). */
  editsMade: () => boolean;
  /** Run the project verify command deterministically (through the existing
   *  run_command allowlist/budget/confirm). Return null if it could NOT run
   *  (disabled / declined / budget exhausted) — treated as "skip", never "pass". */
  runVerify: () => Promise<VerifyOutcome | null>;
  /** Re-enter the writer loop with the failure fed back; returns the grown convo. */
  revise: (
    convo: ChatMessage[],
    failure: VerifyOutcome,
  ) => Promise<{ convo: ChatMessage[]; rounds: number }>;
  /** Revise bound (default MAX_REVISE). */
  maxRevise?: number;
  /** Fired with each verify result (e.g. to record the last PASS/FAIL for the UI). */
  onVerify?: (outcome: VerifyOutcome) => void;
  /** Fired before each revise round (attempt is 1-based). */
  onRevise?: (attempt: number, max: number) => void;
  /** Fired when verify STILL fails after `maxRevise` revisions (honest surface). */
  onExhausted?: (outcome: VerifyOutcome, revisions: number) => void;
}

/** The outcome of the controller. `verified` is null when verify never ran (no edits
 *  or could-not-run), else the FINAL pass/fail — never a fabricated success. */
export interface VerifyReviseResult {
  convo: ChatMessage[];
  verified: boolean | null;
  /** How many revise rounds were driven (0..maxRevise). */
  revisions: number;
  /** Total writer-loop rounds consumed by revises (for the run summary). */
  reviseRounds: number;
}

/**
 * The deterministic verify→revise gate (B3). After the writer signals completion,
 * IF edits were made: run the project verify command; on FAILURE feed the failure back
 * and let the model revise, bounded by `maxRevise` rounds; re-verify after each revise.
 * On a passing verify it returns immediately (no revise). On exhaustion it surfaces an
 * honest failure (`verified:false`, `onExhausted`) — it NEVER claims success. This is a
 * gate, not a plan state-machine: it fires only on a real exit code.
 */
export async function runVerifyReviseController(
  convo: ChatMessage[],
  deps: VerifyReviseDeps,
): Promise<VerifyReviseResult> {
  const max = deps.maxRevise ?? MAX_REVISE;
  let current = convo;
  let revisions = 0;
  let reviseRounds = 0;

  // Gate: no edits this run => nothing to verify (also the shape of "off when the
  // model changed nothing"). The caller additionally gates on --allow-run.
  if (!deps.editsMade()) {
    return { convo: current, verified: null, revisions, reviseRounds };
  }

  for (;;) {
    const outcome = await deps.runVerify();
    if (!outcome) {
      // Could not run (disabled/declined/budget) — surface nothing, claim nothing.
      return { convo: current, verified: null, revisions, reviseRounds };
    }
    deps.onVerify?.(outcome);
    if (outcome.pass) {
      return { convo: current, verified: true, revisions, reviseRounds };
    }
    if (revisions >= max) {
      deps.onExhausted?.(outcome, revisions);
      return { convo: current, verified: false, revisions, reviseRounds };
    }
    revisions += 1;
    deps.onRevise?.(revisions, max);
    const revised = await deps.revise(current, outcome);
    current = revised.convo;
    reviseRounds += revised.rounds;
  }
}
