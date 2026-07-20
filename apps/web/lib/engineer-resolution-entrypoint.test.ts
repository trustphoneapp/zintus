import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(import.meta.dir, "../app/(app)/engineer/page.tsx"), "utf8");

test("the main Engineer corrected-run CTA enters Resolution Desk and never calls the retired endpoint", () => {
  expect(source).toContain("/engineer/resolution?run=");
  expect(source).toContain("Open Resolution Desk");
  expect(source).not.toContain("createCorrectedEngineerRun");
  expect(source).not.toContain("/corrected-run");
});

// R8-3 P1 #2 + P1 #3 — the two stranded legacy-gate states (BASE_BRANCH_STALE and
// HUMAN_APPROVAL_PENDING) are recovered EXCLUSIVELY through the Resolution Desk.
// The UI must offer "Open in Resolution Desk", never the retired stale-base bypass
// (recoverEngineerStaleBase) nor the dead 410 approve/reject/extend approval
// controls.
test("the stranded-run UI routes to the Resolution Desk, not the retired stale-base bypass or legacy approval controls", () => {
  // P1 #2: the direct stale-base recovery bypass is gone from the UI entirely.
  expect(source).not.toContain("recoverEngineerStaleBase");
  expect(source).not.toContain("recover-stale-base");
  expect(source).not.toContain("Start controlled recovery");

  // P1 #3: the legacy approval WRITE controls are gone from the UI.
  expect(source).not.toContain("ApprovalDecisionControls");
  expect(source).not.toContain("extendEngineerApproval");

  // Both stranded states offer a single "Open in Resolution Desk" action.
  expect(source).toContain("Open in Resolution Desk");
  const strandedMatches = source.match(/Open in Resolution Desk/g) ?? [];
  expect(strandedMatches.length).toBeGreaterThanOrEqual(2);

  // Both stranded gate sections still exist (rendered) and route to the desk.
  expect(source).toContain('latestState === "BASE_BRANCH_STALE"');
  expect(source).toContain('latestState === "HUMAN_APPROVAL_PENDING"');
});
