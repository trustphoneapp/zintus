// B6 (repo-map v0 — grep/regex ranked declarations) tests.
//
// Proves: buildRepoMap scans source files under a root, extracts top-level exported
// declarations, RANKS them (more-exported / referenced files first), is SIZE-CAPPED
// (lines + chars), CAPS the number of files scanned on a large tree (graceful), and is
// sandbox-confined (only walks under the root; skips node_modules and binaries).

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  MAX_REPO_MAP_CHARS,
  buildRepoMap,
} from "./agent-tools.js";

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "zintus-repomap-")));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(rel: string, content: string): void {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

describe("B6 buildRepoMap", () => {
  it("extracts top-level declarations and ranks the richer file first", async () => {
    write(
      "src/core.ts",
      [
        "export function alpha() {}",
        "export class Beta {}",
        "export const gamma = 1;",
        "export interface Delta {}",
        "const privateThing = 2;", // non-exported const => excluded
      ].join("\n"),
    );
    write(
      "src/util.ts",
      ["export function helper() {}", "// references core via name", "alpha();"].join(
        "\n",
      ),
    );

    const map = buildRepoMap(root);
    expect(map.entries.length).toBe(2);
    const core = map.entries.find((e) => e.path === "src/core.ts")!;
    const util = map.entries.find((e) => e.path === "src/util.ts")!;
    expect(core.exportedCount).toBe(4);
    // core has more exports => ranks ahead of util.
    expect(map.entries[0]!.path).toBe("src/core.ts");
    // Non-exported const excluded from the symbol list.
    expect(core.symbols.some((s) => s.name === "privateThing")).toBe(false);
    expect(core.symbols.some((s) => s.name === "alpha" && s.exported)).toBe(true);
    // The text summary is labelled as a heuristic and names the file.
    expect(map.text).toContain("heuristic");
    expect(map.text).toContain("src/core.ts");
    expect(util.exportedCount).toBe(1);
  });

  it("does NOT walk node_modules or binary files (sandbox-confined hygiene)", async () => {
    write("src/real.ts", "export function realOne() {}");
    write("node_modules/dep/index.ts", "export function shouldNotAppear() {}");
    writeFileSync(path.join(root, "bin.ts"), "export function x() {}\0\0", "utf8");

    const map = buildRepoMap(root);
    expect(map.text).toContain("realOne");
    expect(map.text).not.toContain("shouldNotAppear");
    expect(map.entries.some((e) => e.path.includes("node_modules"))).toBe(false);
    // The NUL-containing file is skipped as binary.
    expect(map.entries.some((e) => e.path === "bin.ts")).toBe(false);
  });

  it("is SIZE-CAPPED in lines and chars", async () => {
    for (let i = 0; i < 200; i += 1) {
      write(`src/mod${i}.ts`, `export function fn${i}() {}\nexport const c${i} = ${i};`);
    }
    const map = buildRepoMap(root, { maxLines: 10, maxChars: MAX_REPO_MAP_CHARS });
    expect(map.text.length).toBeLessThanOrEqual(MAX_REPO_MAP_CHARS);
    // Header + at most maxLines declaration lines.
    expect(map.text.split("\n").length).toBeLessThanOrEqual(11);
    expect(map.entries.length).toBe(200); // all scanned, but only some emitted
  });

  it("CAPS files scanned on a large tree (graceful, flagged honest)", async () => {
    for (let i = 0; i < 50; i += 1) {
      write(`src/f${i}.ts`, `export function fn${i}() {}`);
    }
    const map = buildRepoMap(root, { maxFiles: 10 });
    expect(map.filesScanned).toBeLessThanOrEqual(10);
    expect(map.filesTruncated).toBe(true);
    expect(map.text).toContain("CAPPED"); // honest "may be incomplete" labelling
  });

  it("returns an empty map (no throw) for a directory with no source files", async () => {
    write("README.txt", "not source");
    const map = buildRepoMap(root);
    expect(map.entries).toEqual([]);
    expect(map.text).toBe("");
  });
});
