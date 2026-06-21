import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";
import { getKey, listKeys, probeKeychain } from "@zintus/keychain";
import { PROVIDER_IDS } from "@zintus/types";
import { getDbPath } from "../db.js";

const CHECK = chalk.green("✅");
const FAIL = chalk.red("❌");

function pass(label: string, detail?: string): void {
  console.log(`  ${CHECK}  ${label}${detail ? chalk.dim("  " + detail) : ""}`);
}

function fail(label: string, detail?: string): void {
  console.log(`  ${FAIL}  ${label}${detail ? chalk.dim("  " + detail) : ""}`);
}

function maskKey(key: string): string {
  if (key.length <= 8) return "sk-****...****";
  return `${key.slice(0, 4)}****...****${key.slice(-4)}`;
}

export async function runDoctor(): Promise<void> {
  console.log(chalk.bold("\nZintus Doctor — system health check\n"));
  let allPassed = true;

  // ── 1. Bun version ──────────────────────────────────────────────────────
  try {
    const version = process.versions.bun ?? "unknown";
    const parts = version.split(".").map(Number);
    const ok = (parts[0] ?? 0) > 1 || ((parts[0] ?? 0) === 1 && (parts[1] ?? 0) >= 2);
    if (ok) {
      pass(`Bun version >= 1.2`, `(${version})`);
    } else {
      fail(`Bun version >= 1.2`, `found ${version} — upgrade: curl -fsSL https://bun.sh/install | bash`);
      allPassed = false;
    }
  } catch {
    fail("Bun version check failed");
    allPassed = false;
  }

  // ── 2. OS keychain accessible ───────────────────────────────────────────
  {
    const probe = probeKeychain();
    if (probe.ok) {
      pass("OS keychain accessible");
    } else {
      fail("OS keychain inaccessible", probe.error);
      allPassed = false;
    }
  }

  // ── 3. quota.db writable + permissions 600 ──────────────────────────────
  const dbPath = getDbPath();
  try {
    accessSync(dbPath, constants.R_OK | constants.W_OK);
    const stat = statSync(dbPath);
    const mode = stat.mode & 0o777;
    if (mode === 0o600) {
      pass("quota.db writable, permissions 600", dbPath);
    } else {
      fail(
        `quota.db permissions are ${mode.toString(8).padStart(3, "0")}, expected 600`,
        `fix: chmod 600 ${dbPath}`,
      );
      allPassed = false;
    }
  } catch {
    // DB doesn't exist yet — that's fine on first run
    const dbDir = join(homedir(), ".zintus");
    try {
      accessSync(dbDir, constants.W_OK);
      pass("quota.db not yet created (will be on first use)", dbDir + " writable");
    } catch {
      fail("~/.zintus/ directory not writable");
      allPassed = false;
    }
  }

  // ── 4. Provider keys ────────────────────────────────────────────────────
  console.log(chalk.dim("\n  Provider keys (presence only — values never printed):"));
  const configuredIds = await listKeys();

  for (const id of PROVIDER_IDS) {
    if (id === "ollama" || id === "lmstudio") continue;
    const key = await getKey(id);
    if (key) {
      pass(`${id.padEnd(14)} key present`, maskKey(key));
    } else {
      console.log(`  ${chalk.dim("⬜")}  ${chalk.dim(id.padEnd(14))} no key — run: ${chalk.cyan(`zintus keys set ${id} <key>`)}`);
    }
  }

  if (configuredIds.length === 0) {
    console.log(chalk.yellow("\n  No API keys configured. Run: zintus setup"));
    allPassed = false;
  }

  // ── 5. Ollama reachable ─────────────────────────────────────────────────
  console.log("");
  try {
    const res = await fetch("http://localhost:11434", {
      signal: AbortSignal.timeout(2_000),
    }).catch(() => null);
    if (res?.ok || res?.status === 200) {
      pass("Ollama reachable at localhost:11434");
    } else {
      fail(
        "Ollama not running",
        "start with: ollama serve (optional — used as last-resort fallback)",
      );
    }
  } catch {
    fail(
      "Ollama not running at localhost:11434",
      "optional — used as last-resort fallback",
    );
  }

  // ── 6. Relay worker reachable (if cloud configured) ─────────────────────
  const cloudConfigPath = join(homedir(), ".zintus", "cloud.json");
  try {
    const raw = await Bun.file(cloudConfigPath).text();
    const config = JSON.parse(raw) as { relay_url?: string; session_id?: string };
    if (config.relay_url) {
      try {
        const res = await fetch(`${config.relay_url}/health`, {
          signal: AbortSignal.timeout(5_000),
        }).catch(() => null);
        if (res?.ok) {
          pass(`Relay worker reachable`, config.relay_url);
        } else {
          fail(`Relay worker returned ${res?.status ?? "no response"}`, config.relay_url);
          allPassed = false;
        }
      } catch {
        fail("Relay worker unreachable", config.relay_url);
        allPassed = false;
      }
    }
  } catch {
    // Not configured — skip silently
    console.log(chalk.dim("  ⬜  Relay not configured (run: zintus cloud login)"));
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log("");
  if (allPassed) {
    console.log(chalk.green("  All checks passed. Zintus is healthy.\n"));
  } else {
    console.log(chalk.yellow("  Some checks failed. Fix the issues above.\n"));
    process.exit(1);
  }
}
