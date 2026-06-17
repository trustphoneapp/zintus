/**
 * Heuristic, parser-free source chunker (v1).
 *
 * Splits a file into ~40-80 line windows that prefer to break on natural
 * boundaries (blank lines, top-level `}`, or lines that start a new
 * `function`/`class`/`def`/etc. declaration) with a small overlap between
 * consecutive chunks. Line numbers are 1-based and inclusive.
 *
 * Deterministic: the same input always produces the same chunks. No
 * tree-sitter / language parser is used (that is a future v2).
 */

export interface CodeChunk {
  /** 1-based inclusive start line. */
  startLine: number;
  /** 1-based inclusive end line. */
  endLine: number;
  content: string;
}

/** Target lower/upper bounds (in lines) for each window. */
const MIN_CHUNK_LINES = 40;
const MAX_CHUNK_LINES = 80;
/** Number of lines repeated at the start of the next chunk for context. */
const OVERLAP_LINES = 8;

/**
 * Matches lines that begin a new top-level-ish declaration. Used as a
 * preferred break point so a chunk does not start in the middle of a symbol.
 */
const DECLARATION_RE =
  /^\s*(export\s+)?(default\s+)?(async\s+)?(function|class|interface|type|enum|struct|impl|trait|def|fn|func|public|private|protected|module)\b/;

/** A line that is exactly a closing brace (optionally followed by `;`/`,`). */
function isClosingBrace(line: string): boolean {
  return /^\s*[}\])]+\s*[;,]?\s*$/.test(line);
}

function isBlank(line: string): boolean {
  return line.trim().length === 0;
}

/**
 * Decide whether `line` (the line that WOULD start the next chunk) is a good
 * boundary. Preferred boundaries: blank lines and declaration starts. A line
 * immediately after a closing brace is also treated as a clean boundary.
 */
function isPreferredBoundaryStart(lines: string[], index: number): boolean {
  const line = lines[index];
  if (line === undefined) {
    return false;
  }
  if (isBlank(line)) {
    return true;
  }
  if (DECLARATION_RE.test(line)) {
    return true;
  }
  const prev = lines[index - 1];
  if (prev !== undefined && isClosingBrace(prev)) {
    return true;
  }
  return false;
}

/**
 * Chunk source text into windowed line ranges.
 *
 * Algorithm:
 *  - Walk forward accumulating lines.
 *  - Once at least MIN_CHUNK_LINES have accumulated, look for a preferred
 *    boundary; cut there.
 *  - Hard-cut at MAX_CHUNK_LINES even without a preferred boundary.
 *  - Start the next chunk OVERLAP_LINES earlier for context continuity.
 */
export function chunkSource(source: string): CodeChunk[] {
  const normalized = source.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  // Drop a single trailing empty line produced by a final newline so the last
  // chunk's endLine maps to real content.
  if (lines.length > 1 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  const total = lines.length;
  if (total === 0) {
    return [];
  }

  const chunks: CodeChunk[] = [];
  let start = 0; // 0-based index of first line of current chunk

  while (start < total) {
    let end = Math.min(start + MAX_CHUNK_LINES, total); // exclusive

    // If we have room for a preferred boundary, try to cut earlier on one.
    if (end < total) {
      // Search the window [start + MIN_CHUNK_LINES, end] for a boundary at
      // which the NEXT chunk could cleanly begin.
      const searchFrom = Math.min(start + MIN_CHUNK_LINES, end);
      let boundary = -1;
      for (let i = searchFrom; i <= end && i < total; i += 1) {
        if (isPreferredBoundaryStart(lines, i)) {
          boundary = i;
          break;
        }
      }
      if (boundary > start) {
        end = boundary;
      }
    }

    const slice = lines.slice(start, end);
    const content = slice.join("\n");
    if (content.trim().length > 0) {
      chunks.push({
        startLine: start + 1,
        endLine: end,
        content,
      });
    }

    if (end >= total) {
      break;
    }

    // Advance with overlap, but always make forward progress.
    const nextStart = Math.max(start + 1, end - OVERLAP_LINES);
    start = nextStart;
  }

  return chunks;
}
