import { describe, expect, test } from "bun:test";
import { changedPathsFromDiff, extractChangedPaths, derivePostVerificationRiskFeatures } from "./post-verification-risk";
import { assessRisk } from "./risk";

describe("post-verification deterministic risk", () => {
  test("actual auth, dependency, migration, workflow, and secret changes cannot be hidden by planning", () => {
    const features = derivePostVerificationRiskFeatures({
      diff: [
        "diff --git a/package.json b/package.json", "+\"oauth-client\": \"1.0.0\"",
        "diff --git a/migrations/001.sql b/migrations/001.sql", "+ALTER TABLE users ADD COLUMN access_token TEXT;",
        "diff --git a/.github/workflows/release.yml b/.github/workflows/release.yml", "+API_KEY: hardcoded",
      ].join("\n"),
      requiredChecksPassed: true, retryCount: 2, unresolvedWarnings: 1,
      securityFindings: [{ severity: "CRITICAL", category: "SECRET_EXPOSURE", status: "OPEN" }],
    });
    expect(features).toMatchObject({ changesDependencies: true, changesDatabaseSchema: true, changesInfrastructure: true, touchesAuthentication: true, exposesSecrets: true, retryCount: 2 });
    expect(assessRisk(features).riskTier).toBe("CRITICAL");
  });

  test("documentation-only is low only with complete checks and no findings", () => {
    const features = derivePostVerificationRiskFeatures({
      diff: "diff --git a/docs/guide.md b/docs/guide.md\n+Clarify setup.", requiredChecksPassed: true,
      retryCount: 0, unresolvedWarnings: 0, testCoveragePercent: 100, securityFindings: [],
    });
    expect(features.documentationOnly).toBe(true);
    expect(assessRisk(features, { autoApproveLowRisk: true }).riskTier).toBe("LOW");
  });

  test("decodes Git-quoted paths and excludes diff file headers from line counts", () => {
    const features = derivePostVerificationRiskFeatures({
      diff: [
        'diff --git "a/.github/workflows/\\303\\251 release.yml" "b/.github/workflows/\\303\\251 release.yml"',
        '--- "a/.github/workflows/\\303\\251 release.yml"',
        '+++ "b/.github/workflows/\\303\\251 release.yml"',
        "@@ -1 +1 @@", "-name: old", "+name: new",
      ].join("\n"),
      requiredChecksPassed: true, retryCount: 0, unresolvedWarnings: 0, securityFindings: [],
    });
    expect(features.changesInfrastructure).toBe(true);
    expect(features.sensitiveFilesChanged).toBe(true);
    expect(features.diffLines).toBe(2);
  });

  test("includes additions, deletions, and quoted names in final scope paths", () => {
    const paths = changedPathsFromDiff([
      "diff --git a/src/removed.ts b/src/removed.ts",
      "deleted file mode 100644",
      "--- a/src/removed.ts",
      "+++ /dev/null",
      'diff --git "a/src/\\303\\251 added.ts" "b/src/\\303\\251 added.ts"',
      "new file mode 100644",
      "--- /dev/null",
      '+++ "b/src/\\303\\251 added.ts"',
    ].join("\n"));
    expect(paths).toEqual(["src/removed.ts", "src/é added.ts"]);
  });
});

describe("changed-path extraction is space-safe, rename-safe, and fails closed", () => {
  const cases: Array<{ name: string; diff: string[]; paths: string[]; unresolved: string[] }> = [
    {
      name: "unquoted space-containing modified path",
      diff: [
        "diff --git a/src/some file.ts b/src/some file.ts",
        "index abc1234..def5678 100644",
        "--- a/src/some file.ts",
        "+++ b/src/some file.ts",
        "@@ -1 +1 @@",
        "-a",
        "+b",
      ],
      paths: ["src/some file.ts"],
      unresolved: [],
    },
    {
      name: "unquoted space-containing added path",
      diff: [
        "diff --git a/dir/new file.ts b/dir/new file.ts",
        "new file mode 100644",
        "index 0000000..abc1234",
        "--- /dev/null",
        "+++ b/dir/new file.ts",
        "@@ -0,0 +1 @@",
        "+hello",
      ],
      paths: ["dir/new file.ts"],
      unresolved: [],
    },
    {
      name: "unquoted space-containing deleted path (b-side is /dev/null)",
      diff: [
        "diff --git a/dir/old file.ts b/dir/old file.ts",
        "deleted file mode 100644",
        "index abc1234..0000000",
        "--- a/dir/old file.ts",
        "+++ /dev/null",
      ],
      paths: ["dir/old file.ts"],
      unresolved: [],
    },
    {
      name: "pure 100% rename with spaces and no hunk body keeps BOTH source and destination",
      diff: [
        "diff --git a/lib/old name.ts b/lib/new name.ts",
        "similarity index 100%",
        "rename from lib/old name.ts",
        "rename to lib/new name.ts",
      ],
      paths: ["lib/new name.ts", "lib/old name.ts"],
      unresolved: [],
    },
    {
      name: "rename with edits keeps source and destination",
      diff: [
        "diff --git a/lib/old name.ts b/lib/new name.ts",
        "similarity index 80%",
        "rename from lib/old name.ts",
        "rename to lib/new name.ts",
        "index abc1234..def5678 100644",
        "--- a/lib/old name.ts",
        "+++ b/lib/new name.ts",
        "@@ -1 +1 @@",
        "-x",
        "+y",
      ],
      paths: ["lib/new name.ts", "lib/old name.ts"],
      unresolved: [],
    },
    {
      name: "git-quoted special-char path",
      diff: [
        'diff --git "a/.github/workflows/\\303\\251 release.yml" "b/.github/workflows/\\303\\251 release.yml"',
        '--- "a/.github/workflows/\\303\\251 release.yml"',
        '+++ "b/.github/workflows/\\303\\251 release.yml"',
        "@@ -1 +1 @@",
        "-name: old",
        "+name: new",
      ],
      paths: [".github/workflows/é release.yml"],
      unresolved: [],
    },
    {
      name: "mixed diff: clean file, spaced rename, and an ambiguous header",
      diff: [
        "diff --git a/src/clean.ts b/src/clean.ts",
        "--- a/src/clean.ts",
        "+++ b/src/clean.ts",
        "@@ -1 +1 @@",
        "-a",
        "+b",
        "diff --git a/lib/old name.ts b/lib/new name.ts",
        "similarity index 100%",
        "rename from lib/old name.ts",
        "rename to lib/new name.ts",
        "diff --git a/has space.ts b/has space.ts",
        "old mode 100644",
        "new mode 100755",
      ],
      paths: ["lib/new name.ts", "lib/old name.ts", "src/clean.ts"],
      unresolved: ["a/has space.ts b/has space.ts"],
    },
    {
      name: "ambiguous unquoted-with-spaces header with no body markers fails closed",
      diff: [
        "diff --git a/some file.ts b/some file.ts",
        "old mode 100644",
        "new mode 100755",
      ],
      paths: [],
      unresolved: ["a/some file.ts b/some file.ts"],
    },
    {
      name: "clean single-token header with no body still resolves both sides",
      diff: ["diff --git a/src/only.ts b/src/only.ts", "old mode 100644", "new mode 100755"],
      paths: ["src/only.ts"],
      unresolved: [],
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      const extraction = extractChangedPaths(testCase.diff.join("\n"));
      expect(extraction.paths).toEqual(testCase.paths);
      expect(extraction.unresolved).toEqual(testCase.unresolved);
      // The flat helper must never silently drop an ambiguous header.
      expect(changedPathsFromDiff(testCase.diff.join("\n")))
        .toEqual([...new Set([...testCase.paths, ...testCase.unresolved])].sort());
    });
  }

  test("a prohibited path smuggled as a rename SOURCE is still visible", () => {
    // A 100% rename FROM an out-of-scope path has no +++/--- body to fall back to;
    // the source must survive so the scope gate can reject it.
    const paths = changedPathsFromDiff([
      "diff --git a/.github/workflows/release.yml b/src/allowed.ts",
      "similarity index 100%",
      "rename from .github/workflows/release.yml",
      "rename to src/allowed.ts",
    ].join("\n"));
    expect(paths).toContain(".github/workflows/release.yml");
    expect(paths).toContain("src/allowed.ts");
  });
});
