import { describe, expect, test } from "bun:test";
import { scanDiffForSecurity, securityFindingSemantics } from "./deterministic-security-scan.js";

test("shared deterministic security scan is replay-stable apart from supplied identity and time", () => {
  const diff = [
    "diff --git a/src/auth.ts b/src/auth.ts",
    "--- a/src/auth.ts",
    "+++ b/src/auth.ts",
    "@@ -1,1 +1,2 @@",
    "-requirePermission(user);",
    "+eval(user.input);",
    "+const value = user.input;",
  ].join("\n");
  let firstId = 0;
  let secondId = 100;
  const first = scanDiffForSecurity({
    runId: "run-security-replay", diff, createdAt: "2026-07-17T18:00:00.000Z",
    idFactory: () => `first-${++firstId}`,
  });
  const second = scanDiffForSecurity({
    runId: "run-security-replay", diff, createdAt: "2026-07-17T19:00:00.000Z",
    idFactory: () => `second-${++secondId}`,
  });
  expect(first.map(securityFindingSemantics)).toEqual(second.map(securityFindingSemantics));
  expect(first.map((finding) => finding.category)).toEqual(["UNSAFE_EVAL", "AUTHORIZATION_CONTROL_REMOVED"]);
});

describe("POSSIBLE_SECRET is never downgraded by Builder-controlled path or content", () => {
  // Both the file path and the added line are attacker-authored diff content, so a
  // test-ish name or a "test/fake/dummy" marker must NOT lower the severity.
  const cases: Array<{ name: string; file: string; line: string }> = [
    { name: "test directory path with fixture marker", file: "test/value.test.ts", line: '+const secret = "test-webhook-secret";' },
    { name: "__tests__ path with dummy marker", file: "src/__tests__/keys.ts", line: '+const apiKey = "dummy-live-key-abcdef123456";' },
    { name: ".spec file with example marker", file: "src/pay.spec.ts", line: '+password = "example-p@ssw0rd-value"' },
    { name: "test path with mock marker", file: "tests/auth.test.ts", line: '+const token = "mock-aaaaaaaaaaaaaaaa";' },
    { name: "non-test path (control)", file: "src/config.ts", line: '+const secret = "prod-webhook-secret-1234";' },
  ];

  for (const testCase of cases) {
    test(`${testCase.name} stays CRITICAL and blocking`, () => {
      const findings = scanDiffForSecurity({
        runId: "run-secret-floor",
        diff: [
          `diff --git a/${testCase.file} b/${testCase.file}`,
          `+++ b/${testCase.file}`,
          "@@ -0,0 +1 @@",
          testCase.line,
        ].join("\n"),
        createdAt: "2026-07-19T00:00:00.000Z",
        idFactory: () => "finding-id",
      });
      const secret = findings.find((finding) => finding.category === "POSSIBLE_SECRET");
      expect(secret).toBeDefined();
      expect(secret!.severity).toBe("CRITICAL");
      expect(secret!.description).not.toMatch(/synthetic/i);
    });
  }
});
