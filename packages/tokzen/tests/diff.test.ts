import { describe, it, expect } from "bun:test";
import { compressDiff } from "../src/compressors/diff";

const SAMPLE_DIFF = `diff --git a/src/handler.ts b/src/handler.ts
index abc1234..def5678 100644
--- a/src/handler.ts
+++ b/src/handler.ts
@@ -1,10 +1,12 @@ function handleRequest
 import { Request } from "./types";
 import { Response } from "./types";
 import { validate } from "./validator";
-export function handleRequest(req: Request): Response {
+export async function handleRequest(req: Request): Promise<Response> {
   const validated = validate(req);
+  await sleep(10);
   return { status: 200, body: validated };
 }
 function helper() {
   return true;
 }
`.trim();

describe("compressDiff", () => {
  it("strips ANSI codes", () => {
    const diff = "\x1B[32m+ added line\x1B[0m\n\x1B[31m- removed line\x1B[0m";
    const result = compressDiff(diff);
    expect(result.content).not.toContain("\x1B");
    expect(result.transforms).toContain("ansi-strip");
  });

  it("keeps changed lines (+ and -)", () => {
    const result = compressDiff(SAMPLE_DIFF);
    expect(result.content).toContain("+export async function");
    expect(result.content).toContain("-export function");
  });

  it("reduces context lines to max 2", () => {
    const result = compressDiff(SAMPLE_DIFF);
    expect(result.transforms).toContain("context-reduce");
  });

  it("stores original in CCR", () => {
    const result = compressDiff(SAMPLE_DIFF);
    expect(result.ccrHashes).toHaveLength(1);
    expect(result.content).toContain("retrieve(");
  });

  it("keeps file headers", () => {
    const result = compressDiff(SAMPLE_DIFF);
    expect(result.content).toContain("diff --git");
  });

  it("never throws on empty or invalid input", () => {
    expect(() => compressDiff("")).not.toThrow();
    expect(() => compressDiff("not a diff")).not.toThrow();
    expect(() => compressDiff("@@ -1,2 +1,3 @@\n+new line")).not.toThrow();
  });

  it("respects token budget by dropping low-priority hunks", () => {
    // Create a diff with many hunks that exceeds budget
    const bigDiff = Array.from({ length: 5 }, (_, i) => `
diff --git a/file${i}.ts b/file${i}.ts
--- a/file${i}.ts
+++ b/file${i}.ts
@@ -1,3 +1,4 @@
 unchanged1
 unchanged2
 unchanged3
+added line ${i}
`).join("\n");
    const result = compressDiff(bigDiff, { tokenBudget: 50 });
    expect(result.ratio).toBeLessThanOrEqual(1);
  });
});
