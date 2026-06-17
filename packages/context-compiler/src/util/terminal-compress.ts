/**
 * Terminal output compression.
 *
 * Collapses noisy logs, build output, and stack traces down to the salient
 * lines so that far fewer tokens are sent to a provider. Pure and
 * deterministic: the same input always yields the same output.
 */

export interface TerminalCompressOptions {
  /** Hard upper bound on the number of lines in the result. Default 80. */
  maxLines?: number;
  /** Number of leading lines always preserved. Default 5. */
  keepHeadLines?: number;
  /** Number of trailing lines always preserved. Default 15. */
  keepTailLines?: number;
}

export interface TerminalCompressResult {
  text: string;
  originalLines: number;
  keptLines: number;
}

/** Matches error / warning / failure style lines that must always be kept. */
const SALIENT_PATTERN =
  /error|exception|failed|failure|fatal|panic|traceback|warning|\bwarn\b|\bE\d{3,}\b/i;

/** Matches file:line(:col) references, e.g. `src/foo.ts:42` or `a/b.py:10:3`. */
const FILE_LINE_PATTERN = /\b[\w./-]+:\d+(:\d+)?\b/;

const ELIDED_MARKER = (count: number): string => `… ${count} lines elided …`;

function isImportant(line: string): boolean {
  return SALIENT_PATTERN.test(line) || FILE_LINE_PATTERN.test(line);
}

/**
 * Compress raw terminal / log output to its salient lines.
 *
 * Heuristics (all deterministic):
 *  - Always keep the first `keepHeadLines` and last `keepTailLines` lines.
 *  - Always keep lines matching error/warning/failure patterns.
 *  - Always keep lines containing `file:line(:col)` references.
 *  - Collapse contiguous runs of dropped lines into a single
 *    `… N lines elided …` marker.
 *  - Never emit more than `maxLines` lines. If keeping every important line
 *    would exceed the budget, the middle important lines are dropped (folded
 *    into elision markers) while head and tail remain intact.
 *  - Individual kept lines are never truncated.
 *  - If the input already has `<= maxLines` lines, it is returned unchanged
 *    with `keptLines === originalLines`.
 */
export function compressTerminalOutput(
  raw: string,
  opts: TerminalCompressOptions = {},
): TerminalCompressResult {
  const maxLines = opts.maxLines ?? 80;
  const keepHeadLines = Math.max(0, opts.keepHeadLines ?? 5);
  const keepTailLines = Math.max(0, opts.keepTailLines ?? 15);

  const lines = raw.split("\n");
  const originalLines = lines.length;

  // Already short enough: return verbatim.
  if (originalLines <= maxLines) {
    return { text: raw, originalLines, keptLines: originalLines };
  }

  // Decide, per line, whether it is selected for keeping.
  const head = Math.min(keepHeadLines, originalLines);
  const tailStart = Math.max(head, originalLines - keepTailLines);

  const selected = new Array<boolean>(originalLines).fill(false);
  for (let i = 0; i < head; i++) {
    selected[i] = true;
  }
  for (let i = tailStart; i < originalLines; i++) {
    selected[i] = true;
  }
  for (let i = head; i < tailStart; i++) {
    const line = lines[i] ?? "";
    if (isImportant(line)) {
      selected[i] = true;
    }
  }

  // Enforce the maxLines budget. Each contiguous run of dropped lines becomes
  // one marker line, so we account for markers when counting. If we are still
  // over budget, drop important lines from the middle (closest to center
  // first) until we fit.
  let kept = countKept(selected);
  let markers = countMarkers(selected, originalLines);

  if (kept + markers > maxLines) {
    // Indices eligible for dropping: only the "important middle" lines, never
    // head or tail. Order by distance from the vertical center so the most
    // central (typically least informative for head/tail framing) go first.
    const middleImportant: number[] = [];
    for (let i = head; i < tailStart; i++) {
      if (selected[i]) {
        middleImportant.push(i);
      }
    }
    const center = (head + tailStart) / 2;
    middleImportant.sort((a, b) => Math.abs(b - center) - Math.abs(a - center));

    for (const idx of middleImportant) {
      if (kept + markers <= maxLines) {
        break;
      }
      selected[idx] = false;
      kept = countKept(selected);
      markers = countMarkers(selected, originalLines);
    }
  }

  // Render: emit kept lines, replacing each contiguous dropped run with a
  // single elision marker.
  const out: string[] = [];
  let i = 0;
  while (i < originalLines) {
    if (selected[i]) {
      out.push(lines[i] ?? "");
      i++;
      continue;
    }
    let run = 0;
    while (i < originalLines && !selected[i]) {
      run++;
      i++;
    }
    out.push(ELIDED_MARKER(run));
  }

  return {
    text: out.join("\n"),
    originalLines,
    keptLines: countKept(selected),
  };
}

function countKept(selected: readonly boolean[]): number {
  let n = 0;
  for (const s of selected) {
    if (s) {
      n++;
    }
  }
  return n;
}

/** Counts how many elision markers a selection will produce. */
function countMarkers(selected: readonly boolean[], length: number): number {
  let markers = 0;
  let inRun = false;
  for (let i = 0; i < length; i++) {
    if (!selected[i]) {
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
