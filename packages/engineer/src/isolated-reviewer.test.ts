import { expect, test } from "bun:test";
import { normalizeReviewerFindingPath } from "./isolated-reviewer.js";

test("normalizes Git diff prefixes in Reviewer finding paths before scope classification", () => {
  expect(normalizeReviewerFindingPath("a/src/scheduler.ts")).toBe("src/scheduler.ts");
  expect(normalizeReviewerFindingPath("b/test/scheduler.test.ts")).toBe("test/scheduler.test.ts");
  expect(normalizeReviewerFindingPath("src/scheduler.ts")).toBe("src/scheduler.ts");
  expect(normalizeReviewerFindingPath("a\\src\\scheduler.ts")).toBe("src/scheduler.ts");
});

test("Reviewer finding path normalization remains fail-closed for unsafe paths", () => {
  for (const path of ["/etc/passwd", "../src/scheduler.ts", "a/../src/scheduler.ts", "C:/temp/file.ts", ".git/config", "a/"]) {
    expect(() => normalizeReviewerFindingPath(path)).toThrow();
  }
});
