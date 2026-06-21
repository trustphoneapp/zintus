// MIT License — see LICENSE file
import { countTokensFast, estimateSavings } from "../tokenizer/count.js";
import { getDefaultCCRStore } from "../ccr/store.js";
import type { CompressContext, CompressResult } from "../pipeline/types.js";

const ANSI_RE = /\x1B\[[0-9;]*[mGKHFJK]/g;

interface DiffHunk {
  header: string;
  lines: string[];
  changedCount: number;
  contextCount: number;
}

interface DiffFile {
  header: string[];
  hunks: DiffHunk[];
}

function parseDiff(content: string): DiffFile[] {
  const lines = content.split("\n");
  const files: DiffFile[] = [];
  let currentFile: DiffFile | null = null;
  let currentHunk: DiffHunk | null = null;

  for (const line of lines) {
    if (line.startsWith("diff --git") || line.startsWith("--- ") && currentFile === null) {
      if (currentHunk && currentFile) currentFile.hunks.push(currentHunk);
      if (currentFile) files.push(currentFile);
      currentFile = { header: [line], hunks: [] };
      currentHunk = null;
    } else if (
      currentFile &&
      (line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("index ") || line.startsWith("new file") || line.startsWith("deleted file"))
    ) {
      currentFile.header.push(line);
    } else if (line.startsWith("@@ ")) {
      if (currentHunk && currentFile) currentFile.hunks.push(currentHunk);
      currentHunk = { header: line, lines: [], changedCount: 0, contextCount: 0 };
    } else if (currentHunk) {
      currentHunk.lines.push(line);
      if (line.startsWith("+") || line.startsWith("-")) {
        currentHunk.changedCount++;
      } else {
        currentHunk.contextCount++;
      }
    } else if (currentFile) {
      currentFile.header.push(line);
    }
  }

  if (currentHunk && currentFile) currentFile.hunks.push(currentHunk);
  if (currentFile) files.push(currentFile);
  return files;
}

function renderHunk(hunk: DiffHunk, maxContext = 2): string[] {
  const result: string[] = [hunk.header];
  let contextBuffer: string[] = [];
  let contextEmitted = 0;

  for (const line of hunk.lines) {
    if (line.startsWith("+") || line.startsWith("-")) {
      // Before a changed line: emit up to maxContext context lines
      const toEmit = contextBuffer.slice(Math.max(0, contextBuffer.length - maxContext));
      if (contextEmitted === 0 || toEmit.length > 0) {
        result.push(...toEmit);
      }
      contextBuffer = [];
      contextEmitted = 0;
      result.push(line);
    } else {
      contextBuffer.push(line);
      contextEmitted++;
    }
  }
  // After last change: emit up to maxContext trailing context
  result.push(...contextBuffer.slice(0, maxContext));
  return result;
}

function hunkDensity(hunk: DiffHunk): number {
  const total = hunk.changedCount + hunk.contextCount;
  if (total === 0) return 0;
  return hunk.changedCount / total;
}

/**
 * Compresses git diff output by reducing context lines and dropping
 * low-priority hunks when over token budget.
 */
export function compressDiff(
  content: string,
  ctx?: Partial<CompressContext>,
): CompressResult {
  const originalTokens = countTokensFast(content);
  const noop = (): CompressResult => ({
    content,
    originalTokens,
    compressedTokens: originalTokens,
    ratio: 1,
    transforms: [],
    ccrHashes: [],
    cacheHit: false,
  });

  try {
    // Always strip ANSI first — even if no diff structure found, return stripped content
    const stripped = content.replace(ANSI_RE, "");
    const files = parseDiff(stripped);

    if (files.length === 0) {
      const originalTokens = countTokensFast(content);
      const compressedTokens = countTokensFast(stripped);
      return {
        content: stripped,
        originalTokens,
        compressedTokens,
        ratio: originalTokens === 0 ? 1 : compressedTokens / originalTokens,
        transforms: ["ansi-strip"],
        ccrHashes: [],
        cacheHit: false,
      };
    }

    const store = getDefaultCCRStore();
    const hash = store.store(content, "diff", { sessionId: ctx?.sessionId });
    const ccrHashes = [hash];
    const appliedTransforms: string[] = ["ansi-strip"];

    // Reduce context lines to 2 per hunk boundary
    const contextReduced = files.map((file) => ({
      ...file,
      hunks: file.hunks.map((hunk) => ({
        ...hunk,
        rendered: renderHunk(hunk, 2),
      })),
    }));
    appliedTransforms.push("context-reduce");

    const tokenBudget = ctx?.tokenBudget;

    // Deduplicate file headers
    const seenHeaders = new Set<string>();
    let resultParts: string[] = [];
    let omittedHunksByFile = new Map<string, number>();

    for (const file of contextReduced) {
      const headerKey = file.header.filter((h) => h.startsWith("diff --git")).join("|");
      const header = seenHeaders.has(headerKey) ? [] : file.header;
      seenHeaders.add(headerKey);
      resultParts.push(...header);

      for (const hunk of file.hunks as (DiffHunk & { rendered: string[] })[]) {
        resultParts.push(...hunk.rendered);
      }
    }

    // Budget enforcement: drop lowest-density hunks
    if (tokenBudget && countTokensFast(resultParts.join("\n")) > tokenBudget) {
      appliedTransforms.push("hunk-budget");
      // Collect all hunks with file context, sort by density
      const allHunks: Array<{
        fileIndex: number;
        hunkIndex: number;
        density: number;
        rendered: string[];
        fileName: string;
      }> = [];

      for (let fi = 0; fi < contextReduced.length; fi++) {
        const file = contextReduced[fi]!;
        const fileName = file.header.find((h) => h.startsWith("diff --git")) ?? `file-${fi}`;
        for (let hi = 0; hi < file.hunks.length; hi++) {
          const hunk = file.hunks[hi] as DiffHunk & { rendered: string[] };
          allHunks.push({
            fileIndex: fi,
            hunkIndex: hi,
            density: hunkDensity(hunk),
            rendered: hunk.rendered,
            fileName,
          });
        }
      }

      // Sort by density descending (keep highest density)
      allHunks.sort((a, b) => b.density - a.density);

      resultParts = [];
      let budget = tokenBudget;
      const keptHunks = new Set<string>();

      for (const h of allHunks) {
        const tokens = countTokensFast(h.rendered.join("\n"));
        if (tokens <= budget) {
          keptHunks.add(`${h.fileIndex}:${h.hunkIndex}`);
          budget -= tokens;
        } else {
          const key = h.fileName;
          omittedHunksByFile.set(key, (omittedHunksByFile.get(key) ?? 0) + 1);
        }
      }

      const seenHeaders2 = new Set<string>();
      for (let fi = 0; fi < contextReduced.length; fi++) {
        const file = contextReduced[fi]!;
        const headerKey = file.header.filter((h) => h.startsWith("diff --git")).join("|");
        const header = seenHeaders2.has(headerKey) ? [] : file.header;
        seenHeaders2.add(headerKey);
        const fileName = file.header.find((h) => h.startsWith("diff --git")) ?? `file-${fi}`;

        const fileHunks = (file.hunks as (DiffHunk & { rendered: string[] })[]).filter(
          (_, hi) => keptHunks.has(`${fi}:${hi}`),
        );
        if (fileHunks.length > 0) {
          resultParts.push(...header);
          for (const hunk of fileHunks) {
            resultParts.push(...hunk.rendered);
          }
        }

        const omitted = omittedHunksByFile.get(fileName);
        if (omitted) {
          resultParts.push(
            `// [${omitted} hunks omitted from ${fileName}. retrieve(${hash}) for full diff]`,
          );
        }
      }
    }

    const result =
      resultParts.join("\n") +
      `\n// [Diff compressed. retrieve(${hash}) for full]`;

    const { compressedTokens } = estimateSavings(content, result);

    return {
      content: result,
      originalTokens,
      compressedTokens,
      ratio: originalTokens === 0 ? 1 : compressedTokens / originalTokens,
      transforms: appliedTransforms,
      ccrHashes,
      cacheHit: false,
    };
  } catch {
    return noop();
  }
}
