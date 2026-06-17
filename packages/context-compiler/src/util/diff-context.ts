/**
 * Git diff -> compact context block.
 *
 * `formatDiffContext` is pure and deterministic: it takes a raw unified diff
 * string (the caller is responsible for obtaining it) and renders a
 * token-frugal version that preserves file headers and hunk markers while
 * capping lines per file and overall. `tryGitDiff` is an optional, best-effort
 * helper that shells out to git and returns `null` (never throws) when git is
 * unavailable or the cwd is not a repository.
 */

export interface DiffContextOptions {
  /** Max rendered lines per file (excluding the file separator). Default 120. */
  maxLinesPerFile?: number;
  /** Max rendered lines across the whole diff. Default 400. */
  maxTotalLines?: number;
  /**
   * Whether to retain pure-context lines (those starting with a space). When
   * over budget, context lines are dropped before changed lines regardless.
   * Default true.
   */
  includeContext?: boolean;
}

const ELIDED_MARKER = (count: number): string => `… ${count} lines elided …`;

interface FileSection {
  /** Header lines: `diff --git`, `index`, `--- a/...`, `+++ b/...`, etc. */
  header: string[];
  /** Body lines: `@@` hunk markers plus `+`/`-`/` ` content lines. */
  body: string[];
}

/**
 * Parse a unified diff into per-file sections.
 *
 * A new file starts at a `diff --git` line, or (for diffs lacking those) at a
 * `--- ` header that is immediately followed by a `+++ ` header. Hunk markers
 * (`@@`) and content lines belong to the body of the current file.
 */
function parseUnifiedDiff(raw: string): FileSection[] {
  const lines = raw.split("\n");
  const sections: FileSection[] = [];
  let current: FileSection | null = null;

  const startSection = (): FileSection => {
    const section: FileSection = { header: [], body: [] };
    sections.push(section);
    return section;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";

    if (line.startsWith("diff --git ")) {
      current = startSection();
      current.header.push(line);
      continue;
    }

    // `--- ` paired with a following `+++ ` denotes a file boundary when no
    // `diff --git` line preceded it.
    if (line.startsWith("--- ")) {
      const next = lines[i + 1] ?? "";
      if (next.startsWith("+++ ") && (current === null || current.body.length > 0)) {
        current = startSection();
      }
      if (current === null) {
        current = startSection();
      }
      current.header.push(line);
      continue;
    }

    if (current === null) {
      // Leading noise before any file section (e.g. blank lines): ignore.
      continue;
    }

    if (line.startsWith("+++ ") || line.startsWith("index ") ||
        line.startsWith("new file mode") || line.startsWith("deleted file mode") ||
        line.startsWith("old mode") || line.startsWith("new mode") ||
        line.startsWith("similarity index") || line.startsWith("rename from") ||
        line.startsWith("rename to") || line.startsWith("copy from") ||
        line.startsWith("copy to") || line.startsWith("Binary files")) {
      current.header.push(line);
      continue;
    }

    // Hunk markers and content lines (including `\ No newline at end of file`).
    current.body.push(line);
  }

  return sections;
}

function isChangedLine(line: string): boolean {
  // `+`/`-` content, but not the `+++`/`---` headers (handled separately).
  if (line.startsWith("+++") || line.startsWith("---")) {
    return false;
  }
  return line.startsWith("+") || line.startsWith("-");
}

function isHunkMarker(line: string): boolean {
  return line.startsWith("@@");
}

/**
 * Render one file's body within a per-file line budget.
 *
 * Priority when trimming: hunk markers and changed (`+`/`-`) lines are kept;
 * pure-context lines are dropped first. Dropped runs collapse into a single
 * `… N lines elided …` marker. Returns the rendered body lines.
 */
function renderBody(
  body: readonly string[],
  budget: number,
  includeContext: boolean,
): string[] {
  if (body.length === 0) {
    return [];
  }

  const selected = new Array<boolean>(body.length).fill(false);
  const mustKeep = new Array<boolean>(body.length).fill(false);

  // Pass 1: always keep hunk markers and changed lines. These are protected
  // from budget-driven dropping until no droppable context lines remain.
  for (let i = 0; i < body.length; i++) {
    const line = body[i] ?? "";
    if (isHunkMarker(line) || isChangedLine(line)) {
      selected[i] = true;
      mustKeep[i] = true;
    }
  }

  // Pass 2: optionally add context lines while under budget.
  if (includeContext) {
    for (let i = 0; i < body.length; i++) {
      if (countSelected(selected) >= budget) {
        break;
      }
      if (!selected[i]) {
        selected[i] = true;
      }
    }
  }

  // Pass 3a: if over budget, first drop optional (context) lines, most central
  // first, so changed lines survive.
  enforceBudget(selected, mustKeep, budget, false);
  // Pass 3b: if still over budget (the file is all changed lines), drop
  // protected lines too, most central first, as a last resort.
  enforceBudget(selected, mustKeep, budget, true);

  return renderSelected(body, selected);
}

function countSelected(selected: readonly boolean[]): number {
  let n = 0;
  for (const s of selected) {
    if (s) {
      n++;
    }
  }
  return n;
}

function countMarkers(selected: readonly boolean[]): number {
  let markers = 0;
  let inRun = false;
  for (const s of selected) {
    if (!s) {
      if (!inRun) {
        markers++;
        inRun = true;
      }
    } else {
      inRun = false;
    }
  }
  return markers;
}

/**
 * Drop selected lines (most central first) until kept + elision markers fit
 * within `budget`. When `dropProtected` is false, only lines that are not in
 * `mustKeep` are eligible for dropping; when true, every selected line is
 * eligible (last-resort). Lines already deselected are skipped.
 */
function enforceBudget(
  selected: boolean[],
  mustKeep: readonly boolean[],
  budget: number,
  dropProtected: boolean,
): void {
  let kept = countSelected(selected);
  let markers = countMarkers(selected);
  if (kept + markers <= budget) {
    return;
  }

  const candidates: number[] = [];
  for (let i = 0; i < selected.length; i++) {
    if (selected[i] && (dropProtected || !mustKeep[i])) {
      candidates.push(i);
    }
  }
  const center = (selected.length - 1) / 2;
  candidates.sort((a, b) => Math.abs(b - center) - Math.abs(a - center));

  for (const idx of candidates) {
    if (kept + markers <= budget) {
      break;
    }
    selected[idx] = false;
    kept = countSelected(selected);
    markers = countMarkers(selected);
  }
}

/** Emit kept lines, replacing each dropped run with one elision marker. */
function renderSelected(source: readonly string[], selected: readonly boolean[]): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < source.length) {
    if (selected[i]) {
      out.push(source[i] ?? "");
      i++;
      continue;
    }
    let run = 0;
    while (i < source.length && !selected[i]) {
      run++;
      i++;
    }
    out.push(ELIDED_MARKER(run));
  }
  return out;
}

/**
 * Format a raw unified diff into a compact, token-frugal context block.
 * Pure and deterministic.
 */
export function formatDiffContext(
  rawUnifiedDiff: string,
  opts: DiffContextOptions = {},
): string {
  const maxLinesPerFile = Math.max(1, opts.maxLinesPerFile ?? 120);
  const maxTotalLines = Math.max(1, opts.maxTotalLines ?? 400);
  const includeContext = opts.includeContext ?? true;

  if (rawUnifiedDiff.trim().length === 0) {
    return "";
  }

  const sections = parseUnifiedDiff(rawUnifiedDiff);
  if (sections.length === 0) {
    return "";
  }

  const out: string[] = [];
  let total = 0;
  let elidedFiles = 0;

  for (const section of sections) {
    if (total >= maxTotalLines) {
      elidedFiles++;
      continue;
    }

    const remaining = maxTotalLines - total;
    const perFileBudget = Math.min(maxLinesPerFile, remaining);

    const block: string[] = [...section.header];
    const body = renderBody(section.body, Math.max(1, perFileBudget - section.header.length), includeContext);
    block.push(...body);

    // If the header alone already exhausts the remaining total budget, still
    // emit the header so the file is at least named.
    out.push(...block);
    total += block.length;
  }

  if (elidedFiles > 0) {
    out.push(`… ${elidedFiles} file${elidedFiles === 1 ? "" : "s"} elided …`);
  }

  return out.join("\n");
}

/**
 * Best-effort git diff. Returns the raw unified diff string, or `null` if git
 * is unavailable, the cwd is not a repository, or anything else goes wrong.
 * Never throws.
 */
export async function tryGitDiff(
  cwd: string,
  opts: { staged?: boolean } = {},
): Promise<string | null> {
  const args = ["diff", "--no-color"];
  if (opts.staged) {
    args.push("--staged");
  }

  // Prefer Bun.spawn when available; fall back to node:child_process.
  const bun = (globalThis as { Bun?: BunLike }).Bun;
  try {
    if (bun?.spawn) {
      const proc = bun.spawn(["git", ...args], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      });
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        return null;
      }
      const text = await new Response(proc.stdout).text();
      return text;
    }
  } catch {
    return null;
  }

  try {
    const { execFile } = await import("node:child_process");
    return await new Promise<string | null>((resolve) => {
      execFile("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        resolve(stdout);
      });
    });
  } catch {
    return null;
  }
}

interface BunLike {
  spawn?: (
    cmd: string[],
    options: { cwd: string; stdout: "pipe"; stderr: "pipe" },
  ) => { stdout: ReadableStream<Uint8Array>; exited: Promise<number> };
}
