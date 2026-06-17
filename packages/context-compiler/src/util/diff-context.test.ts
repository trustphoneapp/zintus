import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatDiffContext, tryGitDiff } from "./diff-context.js";

function fileDiff(path: string, addedLines: number, contextLines: number): string {
  const lines: string[] = [];
  lines.push(`diff --git a/${path} b/${path}`);
  lines.push("index 1111111..2222222 100644");
  lines.push(`--- a/${path}`);
  lines.push(`+++ b/${path}`);
  lines.push(`@@ -1,${contextLines} +1,${contextLines + addedLines} @@`);
  for (let i = 0; i < contextLines; i++) {
    lines.push(` context line ${i} in ${path}`);
  }
  for (let i = 0; i < addedLines; i++) {
    lines.push(`+added line ${i} in ${path}`);
  }
  return lines.join("\n");
}

describe("formatDiffContext", () => {
  test("preserves file headers and hunk markers", () => {
    const diff = fileDiff("src/a.ts", 3, 3);
    const out = formatDiffContext(diff);
    expect(out).toContain("--- a/src/a.ts");
    expect(out).toContain("+++ b/src/a.ts");
    expect(out).toMatch(/@@ -1,3 \+1,6 @@/);
  });

  test("multi-file diff is capped at maxTotalLines", () => {
    const diff = [
      fileDiff("src/a.ts", 200, 200),
      fileDiff("src/b.ts", 200, 200),
      fileDiff("src/c.ts", 200, 200),
    ].join("\n");
    const out = formatDiffContext(diff, { maxTotalLines: 120, maxLinesPerFile: 60 });
    const lineCount = out.split("\n").length;
    // Allow a small slack for per-file headers and elision markers.
    expect(lineCount).toBeLessThanOrEqual(160);
    expect(lineCount).toBeLessThan(620);
  });

  test("per-file cap collapses with an elision marker", () => {
    const diff = fileDiff("src/big.ts", 500, 0);
    const out = formatDiffContext(diff, { maxLinesPerFile: 50, maxTotalLines: 400 });
    expect(out).toMatch(/… \d+ lines elided …/);
    const lineCount = out.split("\n").length;
    expect(lineCount).toBeLessThanOrEqual(60);
  });

  test("changed lines are kept over context lines when over budget", () => {
    // Many context lines, few changed lines, tiny budget: changed lines win.
    const diff = fileDiff("src/x.ts", 5, 300);
    const out = formatDiffContext(diff, { maxLinesPerFile: 30, maxTotalLines: 400 });
    for (let i = 0; i < 5; i++) {
      expect(out).toContain(`+added line ${i} in src/x.ts`);
    }
    // Most pure-context lines should be gone.
    const remainingContext = (out.match(/context line/g) ?? []).length;
    expect(remainingContext).toBeLessThan(300);
  });

  test("includeContext=false drops context lines", () => {
    const diff = fileDiff("src/y.ts", 2, 10);
    const out = formatDiffContext(diff, { includeContext: false, maxLinesPerFile: 120 });
    expect(out).toContain("+added line 0 in src/y.ts");
    expect(out).not.toContain("context line 5 in src/y.ts");
  });

  test("empty diff yields empty string", () => {
    expect(formatDiffContext("")).toBe("");
    expect(formatDiffContext("   \n  \n")).toBe("");
  });

  test("is deterministic across repeated calls", () => {
    const diff = [fileDiff("a.ts", 80, 80), fileDiff("b.ts", 80, 80)].join("\n");
    const a = formatDiffContext(diff, { maxLinesPerFile: 40, maxTotalLines: 100 });
    const b = formatDiffContext(diff, { maxLinesPerFile: 40, maxTotalLines: 100 });
    expect(a).toBe(b);
  });

  test("handles diffs lacking `diff --git` headers", () => {
    const diff = [
      "--- a/one.txt",
      "+++ b/one.txt",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "--- a/two.txt",
      "+++ b/two.txt",
      "@@ -1 +1 @@",
      "-foo",
      "+bar",
    ].join("\n");
    const out = formatDiffContext(diff);
    expect(out).toContain("--- a/one.txt");
    expect(out).toContain("--- a/two.txt");
    expect(out).toContain("+new");
    expect(out).toContain("+bar");
  });
});

describe("tryGitDiff", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "diff-context-test-"));

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("returns null when cwd is not a git repository", async () => {
    const result = await tryGitDiff(tempDir);
    expect(result).toBeNull();
  });

  test("returns null for a nonexistent cwd without throwing", async () => {
    const missing = join(tempDir, "does", "not", "exist");
    const result = await tryGitDiff(missing, { staged: true });
    expect(result).toBeNull();
  });
});
