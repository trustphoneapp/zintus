import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";

/**
 * ARCHITECTURAL GUARD (audit punch-list #1).
 *
 * `pricing.ts` is a STATIC, NON-BILLING reference catalog (see its header:
 * "NOT BILLING TRUTH"). It powers savings estimates and cheapest-routing hints
 * only. This test gives that doc-comment teeth: it fails the build if the
 * pricing catalog is ever imported into a money/credit/metering code path,
 * where an estimate could silently become a charge.
 *
 * Detection is structural, not name-based, so it survives refactors:
 *  - a file "imports pricing" if any import statement pulls a pricing symbol
 *    or resolves a module path containing "pricing";
 *  - "billing-sensitive" files are matched by path (relay money paths +
 *    anything named billing/invoice/charge/payout/credit/metering).
 *
 * The test is self-checking: a POSITIVE CONTROL asserts the detector actually
 * fires on a known legitimate importer (the gateway handler), so a broken
 * detector can't make the guard pass vacuously, and a NON-EMPTY assertion
 * ensures the billing-sensitive set didn't silently vanish if paths move.
 */

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");

const PRICING_SYMBOLS = [
  "PRICING_CATALOG",
  "getModelPricing",
  "listPricing",
  "estimateCostUsd",
  "ModelPricing",
];

const SCAN_ROOTS = ["packages", "workers", "apps"];

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  ".next",
  "coverage",
  ".tokzen-test",
  "target",
]);

// The pricing module itself + its own tests are exempt (they ARE pricing).
function isPricingSelf(rel: string): boolean {
  return /(^|\/)pricing(-[\w-]+)?\.(ts|tsx)$/.test(rel) || rel.endsWith("pricing.test.ts");
}

// Money / credit / metering paths where an estimate must never leak in.
function isBillingSensitive(rel: string): boolean {
  if (rel.endsWith(".test.ts") || rel.endsWith(".test.tsx")) return false;
  if (isPricingSelf(rel)) return false;
  if (/(^|\/)(billing|invoice|charge|payout|credit|metering)/i.test(rel)) return true;
  // Explicit relay money paths that aren't caught by name alone.
  return (
    rel === "workers/relay/src/tiers.ts" ||
    rel === "workers/relay/src/middleware/quota.ts"
  );
}

function importsPricing(source: string): boolean {
  const importRe = /import\s+(?:type\s+)?([\s\S]*?)\s+from\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(source)) !== null) {
    const clause = m[1];
    const modulePath = m[2];
    if (/pricing/i.test(modulePath)) return true;
    if (PRICING_SYMBOLS.some((sym) => new RegExp(`\\b${sym}\\b`).test(clause))) {
      return true;
    }
  }
  return false;
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const abs = join(dir, entry);
    const st = statSync(abs);
    if (st.isDirectory()) {
      walk(abs, out);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(abs);
    }
  }
}

function collect(): { rel: string; imports: boolean }[] {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) {
    const abs = join(REPO_ROOT, root);
    try {
      statSync(abs);
    } catch {
      continue;
    }
    walk(abs, files);
  }
  return files.map((abs) => {
    const rel = abs.slice(REPO_ROOT.length + 1).split(sep).join("/");
    return { rel, imports: importsPricing(readFileSync(abs, "utf8")) };
  });
}

describe("pricing catalog billing-path guard", () => {
  const all = collect();

  test("detector is not broken (positive control: gateway handler imports pricing)", () => {
    const handler = all.find((f) => f.rel === "apps/gateway/src/handler.ts");
    expect(handler, "apps/gateway/src/handler.ts not found — paths moved?").toBeDefined();
    expect(handler!.imports).toBe(true);
  });

  test("billing-sensitive set is non-empty (paths didn't silently move)", () => {
    const sensitive = all.filter((f) => isBillingSensitive(f.rel)).map((f) => f.rel);
    expect(sensitive.length).toBeGreaterThan(0);
    // Anchor on a known money path so a rename is caught loudly.
    expect(sensitive).toContain("workers/relay/src/tiers.ts");
  });

  test("no billing/credit/metering path imports the pricing catalog", () => {
    const violations = all
      .filter((f) => isBillingSensitive(f.rel) && f.imports)
      .map((f) => f.rel);
    expect(
      violations,
      `pricing.ts is a NON-BILLING estimate catalog and must not be imported ` +
        `into money/credit/metering paths. Offending files:\n  ${violations.join("\n  ")}`,
    ).toEqual([]);
  });
});
