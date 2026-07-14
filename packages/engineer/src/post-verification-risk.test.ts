import { describe, expect, test } from "bun:test";
import { derivePostVerificationRiskFeatures } from "./post-verification-risk";
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
});
