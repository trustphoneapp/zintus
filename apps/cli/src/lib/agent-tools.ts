import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
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
 * There is deliberately NO shell / run_command tool in v1.
 */

/** Max bytes for a single read or write (1 MiB). */
export const MAX_FILE_BYTES = 1024 * 1024;

/** Default and hard cap on applied mutations (write_file + apply_edit) per run. */
export const DEFAULT_MUTATION_BUDGET = 50;

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

export interface AgentToolContext {
  sandbox: AgentSandbox;
  /** Gate invoked before every applied mutation. Required. */
  confirm: ConfirmWrite;
  budget: MutationBudget;
}

interface AgentTool {
  definition: ToolDefinition;
  mutating: boolean;
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

const writeFile: AgentTool = {
  mutating: true,
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

export const AGENT_TOOLS: AgentTool[] = [
  readFile,
  listDirectory,
  searchCode,
  writeFile,
  applyEdit,
];

/** Definitions offered to the model for `zintus agent`. */
export const AGENT_TOOL_DEFINITIONS: ToolDefinition[] = AGENT_TOOLS.map(
  (t) => t.definition,
);

const AGENT_TOOLS_BY_NAME = new Map(AGENT_TOOLS.map((t) => [t.definition.name, t]));

/** True if `name` is a mutating agent tool (for transparency labeling). */
export function isMutatingTool(name: string): boolean {
  return AGENT_TOOLS_BY_NAME.get(name)?.mutating ?? false;
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
