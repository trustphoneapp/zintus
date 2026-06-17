import { describe, expect, test } from "bun:test";
import type {
  MemoryChunkHit,
  MemoryFact,
  MemoryStore,
  MemoryThreadState,
} from "@multipleai/types";
import { compileContext } from "./compiler.js";
import type { CodeContextHit } from "./types.js";

class StubMemoryStore implements MemoryStore {
  async getThreadState(_threadId: string): Promise<MemoryThreadState | null> {
    return null;
  }
  async getTopFacts(): Promise<MemoryFact[]> {
    return [];
  }
  async searchChunks(): Promise<MemoryChunkHit[]> {
    return [];
  }
}

function codeHits(n: number): CodeContextHit[] {
  return Array.from({ length: n }, (_unused, i) => ({
    path: `src/file${i}.ts`,
    startLine: 1,
    endLine: 20,
    // ~80 chars/line * 20 lines ≈ 1600 chars ≈ 400 tokens each
    content: Array.from({ length: 20 }, () => "x".repeat(78)).join("\n"),
    score: 1 - i * 0.01,
  }));
}

const base = {
  threadId: "t1",
  newUserMessage: "fix the bug",
  mode: "smart" as const,
  memory: new StubMemoryStore(),
  episodicMessages: [],
};

describe("Smart Context Engine blocks", () => {
  test("codeSearch produces a code-recall block", async () => {
    const result = await compileContext({
      ...base,
      codeSearch: async () => codeHits(2),
    });
    expect(result.compileTrace.includedSections).toContain("code-recall");
    expect(
      result.messages.some((m) => m.content.includes("Relevant code from the workspace")),
    ).toBe(true);
  });

  test("diffText produces a compressed diff block", async () => {
    const diff = [
      "diff --git a/x.ts b/x.ts",
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -1,2 +1,2 @@",
      "-const a = 1;",
      "+const a = 2;",
    ].join("\n");
    const result = await compileContext({ ...base, diffText: diff });
    expect(result.compileTrace.includedSections).toContain("diff");
    expect(result.messages.some((m) => m.content.includes("git diff"))).toBe(true);
  });

  test("terminalText produces a compressed terminal block", async () => {
    const log = ["start", ...Array.from({ length: 500 }, (_u, i) => `line ${i}`), "ERROR: boom at app.ts:42"].join("\n");
    const result = await compileContext({ ...base, terminalText: log });
    expect(result.compileTrace.includedSections).toContain("terminal");
    const block = result.messages.find((m) => m.content.includes("terminal output"));
    expect(block).toBeDefined();
    expect(block!.content).toContain("ERROR: boom");
  });

  test("quota-aware: a smaller model window includes fewer code chunks", async () => {
    const big = await compileContext({
      ...base,
      contextWindow: 128_000,
      codeSearch: async () => codeHits(20),
    });
    const small = await compileContext({
      ...base,
      contextWindow: 8_000,
      codeSearch: async () => codeHits(20),
    });
    const codeLen = (r: Awaited<ReturnType<typeof compileContext>>) =>
      r.messages.find((m) => m.content.includes("Relevant code from the workspace"))
        ?.content.length ?? 0;
    // The small-window compile must fit less code than the large-window one.
    expect(codeLen(small)).toBeLessThan(codeLen(big));
  });
});
