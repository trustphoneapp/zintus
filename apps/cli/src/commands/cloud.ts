import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";

const CLOUD_CONFIG_PATH = join(homedir(), ".zintus", "cloud.json");
const DEFAULT_RELAY_URL = "https://zintus-relay.yashwanth-surabhi.workers.dev";

export interface CloudConfig {
  session_id: string;
  gateway_secret: string;
  relay_url: string;
}

// ── Persist / read cloud.json ─────────────────────────────────────────────

export async function loadCloudConfig(): Promise<CloudConfig | null> {
  try {
    const raw = await readFile(CLOUD_CONFIG_PATH, "utf-8");
    return JSON.parse(raw) as CloudConfig;
  } catch {
    return null;
  }
}

export async function saveCloudConfig(config: CloudConfig): Promise<void> {
  await mkdir(join(homedir(), ".zintus"), { recursive: true });
  await writeFile(CLOUD_CONFIG_PATH, JSON.stringify(config, null, 2), {
    mode: 0o600,
  });
}

export async function clearCloudConfig(): Promise<void> {
  try {
    await rm(CLOUD_CONFIG_PATH);
  } catch {
    // already gone
  }
}

// ── zintus cloud login ────────────────────────────────────────────────────

export async function runCloudLogin(options?: {
  relayUrl?: string;
}): Promise<void> {
  const relayUrl = (options?.relayUrl ?? DEFAULT_RELAY_URL).replace(/\/$/, "");

  // Register the CLI state token with the relay before opening the browser.
  const state = crypto.randomUUID();
  const regRes = await fetch(`${relayUrl}/api/auth/cli-login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ state }),
  }).catch(() => null);

  if (!regRes?.ok) {
    console.error(chalk.red(`✗ Could not reach relay at ${relayUrl}`));
    console.error(chalk.dim("  Is the relay deployed? Check workers/relay/README.md"));
    process.exit(1);
  }

  const loginUrl = `${relayUrl.replace("relay.", "")}/login?cli=true&state=${state}`;
  console.error(chalk.bold("Opening browser to sign in to Zintus Cloud..."));
  console.error(chalk.dim(`  ${loginUrl}`));
  console.error(chalk.dim("  Waiting for login... (Ctrl+C to cancel)"));

  // Open browser.
  const open = (await import("../lib/open-url.js")).openUrl;
  await open(loginUrl);

  // Poll for completion.
  const deadline = Date.now() + 5 * 60 * 1000;
  let result: { session_id: string; gateway_secret: string } | null = null;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const res = await fetch(
      `${relayUrl}/api/auth/cli-status?state=${state}`,
    ).catch(() => null);

    if (!res) continue;

    if (res.status === 200) {
      const data = (await res.json()) as {
        status: string;
        session_id?: string;
        gateway_secret?: string;
      };
      if (data.status === "complete" && data.session_id && data.gateway_secret) {
        result = {
          session_id: data.session_id,
          gateway_secret: data.gateway_secret,
        };
        break;
      }
    }

    if (res.status === 404) {
      console.error(chalk.red("✗ Login state expired."));
      process.exit(1);
    }
    // 202 = still pending, keep polling
  }

  if (!result) {
    console.error(chalk.red("✗ Login timed out (5 minutes)."));
    process.exit(1);
  }

  await saveCloudConfig({
    session_id: result.session_id,
    gateway_secret: result.gateway_secret,
    relay_url: relayUrl,
  });

  console.error(
    chalk.green(`✓ Logged in to Zintus Cloud (${relayUrl.replace(/^https?:\/\//, "")})`),
  );
  console.error(
    chalk.dim("  Run: ") + chalk.bold("zintus serve --cloud") + chalk.dim(" to connect your gateway."),
  );
}

// ── zintus cloud status ───────────────────────────────────────────────────

export async function runCloudStatus(): Promise<void> {
  const config = await loadCloudConfig();
  if (!config) {
    console.error(
      chalk.yellow(
        "Not logged in to Zintus Cloud. Run: zintus cloud login",
      ),
    );
    return;
  }

  const relayUrl = config.relay_url ?? DEFAULT_RELAY_URL;
  const res = await fetch(
    `${relayUrl}/api/sessions/${config.session_id}/status`,
    {
      headers: {
        // Use gateway_secret in Authorization for status endpoint (no user cookie needed).
        Authorization: `Bearer ${config.gateway_secret}`,
      },
    },
  ).catch(() => null);

  if (!res?.ok) {
    console.error(chalk.dim("Session ID:"), config.session_id);
    console.error(chalk.dim("Relay:"), relayUrl);
    console.error(chalk.yellow("Gateway status: offline (could not reach relay)"));
    return;
  }

  const data = (await res.json()) as {
    online?: boolean;
    name?: string;
    last_seen?: number;
  };

  console.error(chalk.dim("Session ID:"), config.session_id);
  console.error(chalk.dim("Relay:"), relayUrl);
  console.error(
    chalk.dim("Status:"),
    data.online ? chalk.green("● online") : chalk.gray("○ offline"),
  );
  if (data.last_seen) {
    console.error(
      chalk.dim("Last seen:"),
      new Date(data.last_seen).toLocaleString(),
    );
  }
}

// ── zintus cloud logout ───────────────────────────────────────────────────

export async function runCloudLogout(): Promise<void> {
  const config = await loadCloudConfig();
  if (!config) {
    console.error(chalk.yellow("Not logged in."));
    return;
  }

  const relayUrl = config.relay_url ?? DEFAULT_RELAY_URL;
  await fetch(`${relayUrl}/api/sessions/${config.session_id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${config.gateway_secret}` },
  }).catch(() => {});

  await clearCloudConfig();
  console.error(chalk.green("✓ Logged out from Zintus Cloud."));
}
