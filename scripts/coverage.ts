#!/usr/bin/env bun
/**
 * Coverage for Zintus's SPLIT test suite (bun test + vitest).
 *
 * vitest's v8 coverage cannot see `bun:test` files (it can't even import them),
 * so a single `vitest --coverage` would measure <5% of the tree. Instead we run
 * each runner's NATIVE coverage and merge the lcov:
 *   - bun test --coverage --coverage-reporter=lcov   (the ~90% of files on bun)
 *   - vitest run --coverage                            (the 5 vitest files)
 * Batches mirror the root `test` script's isolation so bun's process-global
 * `mock.module` leak can't shadow across files (coverage runs per-invocation).
 *
 * Output: coverage/lcov.info (merged) + a per-path summary, with thresholds
 * enforced on the MERGED report. Thresholds are calibrated to the current
 * suite; docs/TESTING.md records the higher aspirational targets.
 */
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const COV = join(ROOT, "coverage");
const VITEST_FILES = [
  "packages/crypto-e2e/src/e2e.test.ts",
  "packages/router/src/priority.test.ts",
  "packages/router/src/cooldown.test.ts",
  "packages/router/src/groq-reset.test.ts",
  "packages/router/src/quota-core.test.ts",
];
// bun batches — kept separate exactly like the test script (providers isolated
// from the mock.module that weighted.test.ts registers; integration/mock files
// grouped; tokzen/relay/test-utils last).
const BUN_BATCHES: Record<string, string[]> = {
  providers: [
    "packages/providers/src/token-estimate.test.ts",
    "packages/providers/src/utils.test.ts",
    "packages/providers/src/vcr.test.ts",
    "packages/providers/src/provider-metadata.test.ts",
  ],
  core: [
    "packages/router/src/factory.test.ts",
    "packages/router/src/factory.cooldown.test.ts",
    "packages/router/src/factory.model-groups.test.ts",
    "packages/router/src/factory.latency.test.ts",
    "packages/router/src/factory.probe.test.ts",
    "packages/router/src/policy.test.ts",
    "packages/router/src/limits.test.ts",
    "packages/router/src/quota-ledger.test.ts",
    "packages/router/src/quota-ledger.vk.test.ts",
    "packages/router/src/inflight.test.ts",
    "packages/router/src/error-streak.test.ts",
    "packages/router/src/weighted.test.ts",
    "packages/engine/src/engine.test.ts",
    "packages/engine/src/otel.test.ts",
    "packages/context-compiler/src/compiler.test.ts",
    "packages/memory/src/vector.test.ts",
    "packages/memory/src/llm-memory.test.ts",
    "packages/memory/src/memory-consolidation.test.ts",
    "packages/cache/src/cache.test.ts",
    "apps/gateway/src/auth.test.ts",
    "apps/gateway/src/handler.test.ts",
    "apps/gateway/src/metrics.test.ts",
    "apps/gateway/src/rate-limit.test.ts",
    "packages/search/src/search.test.ts",
  ],
  integration: [
    "packages/engine/src/engine.integration.test.ts",
    "packages/engine/src/engine.failover.integration.test.ts",
    "apps/gateway/src/handler.integration.test.ts",
    "apps/gateway/src/gateway-flow.integration.test.ts",
    "apps/gateway/src/contracts.test.ts",
  ],
  trailing: [
    "packages/codebase-indexer/src/index.test.ts",
    "packages/context-compiler/src/util/diff-context.test.ts",
    "packages/context-compiler/src/smart-context.test.ts",
  ],
  packages: ["packages/tokzen/tests/", "workers/relay/tests/", "packages/test-utils/src/"],
};

// Per-path-prefix line-coverage gate (calibrated; see docs/TESTING.md for the
// aspirational targets this ratchets toward).
// Calibrated to the current suite with a small margin so the gate is real
// (catches regressions) but green today. These RATCHET toward the aspirational
// targets documented in docs/TESTING.md (router 90 / crypto-e2e 95 / inflight
// 100 / gateway 75). Raise them as coverage improves.
const THRESHOLDS: Array<{ prefix: string; lines: number }> = [
  { prefix: "packages/router/src/inflight.ts", lines: 90 }, // ~95% today (the LiteLLM-#18730 fix)
  { prefix: "packages/crypto-e2e/src/", lines: 65 }, // ~69% today
  { prefix: "packages/router/src/", lines: 60 }, // ~68% today
];

function run(cmd: string, args: string[], env: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, {
      cwd: ROOT,
      stdio: "inherit",
      env: { ...process.env, CI_KEYCHAIN: "memory", TOKZEN_HOME: join(ROOT, ".tokzen-test"), ...env },
    });
    p.on("close", (code) => resolve(code ?? 0));
  });
}

function readLcov(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

async function main(): Promise<void> {
  rmSync(COV, { recursive: true, force: true });
  mkdirSync(COV, { recursive: true });

  const lcovParts: string[] = [];

  // 1. bun batches, each to its own coverage dir.
  for (const [name, files] of Object.entries(BUN_BATCHES)) {
    const dir = join(COV, "bun", name);
    mkdirSync(dir, { recursive: true });
    await run("bun", ["test", ...files, "--coverage", "--coverage-reporter=lcov", `--coverage-dir=${dir}`]);
    lcovParts.push(readLcov(join(dir, "lcov.info")));
  }

  // 2. vitest's 5 files.
  await run("bunx", ["vitest", "run", "--coverage", ...VITEST_FILES]);
  lcovParts.push(readLcov(join(COV, "vitest", "lcov.info")));

  // 3. Merge (concatenate — standard lcov consumers union by SF).
  const merged = lcovParts.filter(Boolean).join("\n");
  writeFileSync(join(COV, "lcov.info"), merged);

  // 4. UNION per-line across duplicate SF records (a file appears once per batch
  // that loaded it). Take the max hit count per line — that is the correct lcov
  // merge; summing LF/LH would multiply-count and under-report coverage.
  const perFileLines = new Map<string, Map<number, number>>();
  let curr = "";
  for (const line of merged.split("\n")) {
    if (line.startsWith("SF:")) {
      curr = line.slice(3).trim().replace(`${ROOT}/`, "");
      if (!perFileLines.has(curr)) perFileLines.set(curr, new Map());
    } else if (line.startsWith("DA:")) {
      const [ln, hits] = line.slice(3).split(",").map(Number);
      if (ln == null) continue;
      const m = perFileLines.get(curr)!;
      m.set(ln, Math.max(m.get(ln) ?? 0, hits ?? 0));
    }
  }
  const perFile = new Map<string, { lf: number; lh: number }>();
  for (const [file, lines] of perFileLines) {
    let lh = 0;
    for (const hits of lines.values()) if (hits > 0) lh++;
    perFile.set(file, { lf: lines.size, lh });
  }

  console.log("\n── Coverage by gated prefix ──────────────────────────────");
  let failed = false;
  for (const { prefix, lines } of THRESHOLDS) {
    let lf = 0;
    let lh = 0;
    for (const [file, c] of perFile) {
      if (file.startsWith(prefix)) {
        lf += c.lf;
        lh += c.lh;
      }
    }
    const pct = lf === 0 ? 0 : (lh / lf) * 100;
    const ok = pct >= lines || lf === 0;
    if (!ok) failed = true;
    console.log(`  ${ok ? "✅" : "❌"} ${prefix.padEnd(38)} ${pct.toFixed(1)}%  (gate ${lines}%, ${lh}/${lf} lines)`);
  }
  console.log("──────────────────────────────────────────────────────────");
  console.log(`Merged lcov: coverage/lcov.info`);

  if (failed) {
    console.error("\nCoverage gate FAILED — a gated prefix dropped below threshold.");
    process.exit(1);
  }
}

void main();
