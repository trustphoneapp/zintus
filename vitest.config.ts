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
  },
});
