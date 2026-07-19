import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("the main Engineer corrected-run CTA enters Resolution Desk and never calls the retired endpoint", () => {
  const source = readFileSync(join(import.meta.dir, "../app/(app)/engineer/page.tsx"), "utf8");
  expect(source).toContain("/engineer/resolution?run=");
  expect(source).toContain("Open Resolution Desk");
  expect(source).not.toContain("createCorrectedEngineerRun");
  expect(source).not.toContain("/corrected-run");
});
