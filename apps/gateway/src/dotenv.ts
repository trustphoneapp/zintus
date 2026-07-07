import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Minimal .env fallback for the gateway.
 *
 * Bun only auto-loads `.env` files from the CURRENT working directory, so a
 * gateway started from the repo root (`bun run --filter`, `zintus serve`, an
 * IDE task) never sees `apps/gateway/.env`. This loader makes that file work
 * regardless of cwd while keeping strict precedence: a variable already
 * present in the real environment (or already loaded by Bun) always wins —
 * the file only fills gaps.
 */

/** Parse simple KEY=VALUE lines: #-comments, blank lines, optional quotes. */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
      (val.startsWith("'") && val.endsWith("'") && val.length >= 2)
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

/**
 * Apply `<gatewayDir>/.env` into `env` for keys that are unset or empty.
 * Returns the file path when one was loaded, null when absent (no-op for
 * compiled/installed builds where the source tree isn't present).
 */
export function applyGatewayDotenv(
  env: NodeJS.ProcessEnv = process.env,
  gatewayDir: string = resolve(import.meta.dir, ".."),
): string | null {
  const file = resolve(gatewayDir, ".env");
  if (!existsSync(file)) return null;
  for (const [k, v] of Object.entries(parseDotenv(readFileSync(file, "utf8")))) {
    if (env[k] === undefined || env[k] === "") env[k] = v;
  }
  return file;
}
