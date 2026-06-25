import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/router/src/**/*.test.ts",
      "packages/crypto-e2e/src/**/*.test.ts",
      "apps/web/lib/crypto.test.ts",
      "apps/web/lib/worker.test.ts",
    ],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/factory.test.ts",
      "**/quota-ledger.test.ts",
    ],
    environment: "node",
    // Coverage for the VITEST portion only (5 files: crypto-e2e + pure router
    // helpers). vitest cannot load bun:test files, so the bun-run suite is
    // measured separately with `bun test --coverage` and merged — see
    // scripts/coverage.ts. Thresholds are enforced on the MERGED lcov there,
    // not here, because vitest sees <5% of the source tree.
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "lcovonly"],
      reportsDirectory: "coverage/vitest",
      exclude: [
        "**/node_modules/**",
        "**/dist/**",
        "**/*.test.ts",
        "**/test-utils/**",
        "**/grammars/**",
        "**/*.config.ts",
      ],
    },
  },
});
