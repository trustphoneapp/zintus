import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";
import { getKey, listKeys, probeKeychain } from "@zintus/keychain";
import { PROVIDER_IDS } from "@zintus/types";
import { getDbPath } from "../db.js";

const CHECK = chalk.green("✅");
const FAIL = chalk.red("❌");

function maskKey(key: string): string {
  if (key.length <= 8) return "sk-****...****";
  return `${key.slice(0, 4)}****...****${key.slice(-4)}`;
}

/** One doctor check result — the unit both renderers (text/JSON) consume. */
interface DoctorCheck {
  id: string;
  label: string;
  status: "pass" | "fail" | "skip";
  detail?: string;
  /** `false` for optional checks (Ollama) that never fail the run. */
  gating: boolean;
}

export interface DoctorOptions {
  /** Emit `{ ok, checks: [...] }` JSON for automation instead of the TTY report. */
  json?: boolean;
}

export async function runDoctor(options: DoctorOptions = {}): Promise<void> {
  const json = options.json ?? false;
  const checks: DoctorCheck[] = [];

  function record(check: DoctorCheck): void {
    checks.push(check);
    if (json) return;
    if (check.status === "skip") {
      console.log(
        `  ${chalk.dim("⬜")}  ${chalk.dim(check.label)}${check.detail ? chalk.dim("  " + check.detail) : ""}`,
      );
      return;
    }
    const icon = check.status === "pass" ? CHECK : FAIL;
    console.log(
      `  ${icon}  ${check.label}${check.detail ? chalk.dim("  " + check.detail) : ""}`,
    );
  }

  if (!json) {
    console.log(chalk.bold("\nZintus Doctor — system health check\n"));
  }

  // ── 1. Bun version ──────────────────────────────────────────────────────
  try {
    const version = process.versions.bun ?? "unknown";
    const parts = version.split(".").map(Number);
    const ok = (parts[0] ?? 0) > 1 || ((parts[0] ?? 0) === 1 && (parts[1] ?? 0) >= 2);
    record({
      id: "bun-version",
      label: "Bun version >= 1.2",
      status: ok ? "pass" : "fail",
      detail: ok
        ? `(${version})`
        : `found ${version} — upgrade: curl -fsSL https://bun.sh/install | bash`,
      gating: true,
    });
  } catch {
    record({ id: "bun-version", label: "Bun version check failed", status: "fail", gating: true });
  }

  // ── 2. OS keychain accessible ───────────────────────────────────────────
  {
    const probe = probeKeychain();
    record({
      id: "keychain",
      label: probe.ok ? "OS keychain accessible" : "OS keychain inaccessible",
      status: probe.ok ? "pass" : "fail",
      detail: probe.ok ? undefined : probe.error,
      gating: true,
    });
  }

  // ── 3. quota.db writable + permissions 600 ──────────────────────────────
  const dbPath = getDbPath();
  try {
    accessSync(dbPath, constants.R_OK | constants.W_OK);
    const stat = statSync(dbPath);
    const mode = stat.mode & 0o777;
    record({
      id: "quota-db",
      label:
        mode === 0o600
          ? "quota.db writable, permissions 600"
          : `quota.db permissions are ${mode.toString(8).padStart(3, "0")}, expected 600`,
      status: mode === 0o600 ? "pass" : "fail",
      detail: mode === 0o600 ? dbPath : `fix: chmod 600 ${dbPath}`,
      gating: true,
    });
  } catch {
    // DB doesn't exist yet — that's fine on first run
    const dbDir = join(homedir(), ".zintus");
    try {
      accessSync(dbDir, constants.W_OK);
      record({
        id: "quota-db",
        label: "quota.db not yet created (will be on first use)",
        status: "pass",
        detail: dbDir + " writable",
        gating: true,
      });
    } catch {
      record({
        id: "quota-db",
        label: "~/.zintus/ directory not writable",
        status: "fail",
        gating: true,
      });
    }
  }

  // ── 4. Provider keys ────────────────────────────────────────────────────
  if (!json) {
    console.log(chalk.dim("\n  Provider keys (presence only — values never printed):"));
  }
  const configuredIds = await listKeys();

  for (const id of PROVIDER_IDS) {
    if (id === "ollama" || id === "lmstudio") continue;
    const key = await getKey(id);
    record({
      id: `key-${id}`,
      label: key ? `${id.padEnd(14)} key present` : `${id.padEnd(14)} no key`,
      status: key ? "pass" : "skip",
      // Presence only — JSON gets the same masked tail the TTY shows, never a value.
      detail: key ? maskKey(key) : `run: zintus keys set ${id} <key>`,
      gating: false,
    });
  }

  record({
    id: "any-keys",
    label:
      configuredIds.length > 0
        ? `${configuredIds.length} provider key(s) configured`
        : "No API keys configured",
    status: configuredIds.length > 0 ? "pass" : "fail",
    detail: configuredIds.length > 0 ? undefined : "run: zintus setup",
    gating: true,
  });

  // ── 5. Ollama reachable (optional — never gates the run) ────────────────
  if (!json) console.log("");
  try {
    const res = await fetch("http://localhost:11434", {
      signal: AbortSignal.timeout(2_000),
    }).catch(() => null);
    record({
      id: "ollama",
      label:
        res?.ok || res?.status === 200
          ? "Ollama reachable at localhost:11434"
          : "Ollama not running",
      status: res?.ok || res?.status === 200 ? "pass" : "fail",
      detail:
        res?.ok || res?.status === 200
          ? undefined
          : "start with: ollama serve (optional — used as last-resort fallback)",
      gating: false,
    });
  } catch {
    record({
      id: "ollama",
      label: "Ollama not running at localhost:11434",
      status: "fail",
      detail: "optional — used as last-resort fallback",
      gating: false,
    });
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
        record({
          id: "relay",
          label: res?.ok
            ? "Relay worker reachable"
            : `Relay worker returned ${res?.status ?? "no response"}`,
          status: res?.ok ? "pass" : "fail",
          detail: config.relay_url,
          gating: true,
        });
      } catch {
        record({
          id: "relay",
          label: "Relay worker unreachable",
          status: "fail",
          detail: config.relay_url,
          gating: true,
        });
      }
    }
  } catch {
    // Not configured — skip silently
    record({
      id: "relay",
      label: "Relay not configured",
      status: "skip",
      detail: "run: zintus cloud login",
      gating: false,
    });
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  const allPassed = checks.every((c) => c.status !== "fail" || !c.gating);

  if (json) {
    console.log(
      JSON.stringify(
        {
          ok: allPassed,
          checks: checks.map(({ id, label, status, detail, gating }) => ({
            id,
            label: label.trim().replace(/\s+/g, " "),
            status,
            ...(detail ? { detail } : {}),
            gating,
          })),
        },
        null,
        2,
      ),
    );
    if (!allPassed) process.exit(1);
    return;
  }

  console.log("");
  if (allPassed) {
    console.log(chalk.green("  All checks passed. Zintus is healthy.\n"));
  } else {
    console.log(chalk.yellow("  Some checks failed. Fix the issues above.\n"));
    process.exit(1);
  }
}
