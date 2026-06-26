import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";

// Config lives in ~/.zintus by default. ZINTUS_CONFIG_DIR relocates it (CI /
// containers / tests that must not touch the developer's real home). Read lazily
// via a function — not a module constant — because some runtimes (Bun) cache
// os.homedir() at startup, so a constant computed at import can't be redirected.
function cloudConfigDir(): string {
  return process.env.ZINTUS_CONFIG_DIR ?? join(homedir(), ".zintus");
}
function cloudConfigPath(): string {
  return join(cloudConfigDir(), "cloud.json");
}
const DEFAULT_RELAY_URL = "https://relay.zintus.ai";
// The browser sign-in page lives on the Next.js web app, NOT the relay worker.
// The relay only exposes API routes (e.g. POST /api/auth/magic-link); it has no
// HTML login page. The web /login page reads `?cli=true&state=` (see
// apps/web/app/login/page.tsx) and drives the cookie-auth flow that calls the
// relay's POST /api/auth/cli-complete on our behalf. Override with ZINTUS_WEB_URL.
const DEFAULT_WEB_URL = "https://www.zintus.ai";

export interface CloudConfig {
  session_id: string;
  gateway_secret: string;
  relay_url: string;
}

// ── Persist / read cloud.json ─────────────────────────────────────────────

export async function loadCloudConfig(): Promise<CloudConfig | null> {
  // Env vars take precedence over the file so CI/container deployments work
  // without writing ~/.zintus/cloud.json to disk.
  const envSessionId = process.env.ZINTUS_SESSION_ID;
  const envGatewaySecret = process.env.ZINTUS_GATEWAY_SECRET;
  if (envSessionId && envGatewaySecret) {
    return {
      session_id: envSessionId,
      gateway_secret: envGatewaySecret,
      relay_url: process.env.ZINTUS_RELAY_URL ?? DEFAULT_RELAY_URL,
    };
  }

  try {
    const raw = await readFile(cloudConfigPath(), "utf-8");
    return JSON.parse(raw) as CloudConfig;
  } catch {
    return null;
  }
}

export async function saveCloudConfig(config: CloudConfig): Promise<void> {
  await mkdir(cloudConfigDir(), { recursive: true });
  await writeFile(cloudConfigPath(), JSON.stringify(config, null, 2), {
    mode: 0o600,
  });
}

export async function clearCloudConfig(): Promise<void> {
  try {
    await rm(cloudConfigPath());
  } catch {
    // already gone
  }
}

// ── zintus cloud login ────────────────────────────────────────────────────

export async function runCloudLogin(options?: {
  relayUrl?: string;
  webUrl?: string;
}): Promise<void> {
  const relayUrl = (options?.relayUrl ?? DEFAULT_RELAY_URL).replace(/\/$/, "");
  const webUrl = (
    options?.webUrl ?? process.env.ZINTUS_WEB_URL ?? DEFAULT_WEB_URL
  ).replace(/\/$/, "");

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

  // Open the WEB app's login page (not a relay API route). It reads cli=true +
  // state, signs the user in (sets the relay session cookie), then its
  // /dashboard/cli-callback page creates a gateway session and POSTs
  // /api/auth/cli-complete so our poll below resolves.
  const loginUrl = `${webUrl}/login?cli=true&state=${state}`;
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
  // KNOWN RELAY GAP: the relay's GET /api/sessions/:id/status route is
  // cookie-authenticated (requireSession → parseSessionCookie, see
  // workers/relay/src/index.ts:750 + auth.ts:141). It IGNORES this Authorization
  // header, so an authed-only relay returns 401 here. gateway_secret is verified
  // ONLY in the WebSocket register handshake (GatewaySession.ts:293), never on an
  // HTTP route — the CLI holds no session cookie, so it currently cannot read
  // real online status. We still send the secret as a Bearer token so that this
  // works the moment the relay grows gateway_secret auth on this route (handed
  // back to the relay agent); until then a 401 falls through to the offline path.
  const res = await fetch(
    `${relayUrl}/api/sessions/${config.session_id}/status`,
    {
      headers: {
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
  // Best-effort server-side revoke. KNOWN RELAY GAP (same as status): the relay's
  // DELETE /api/sessions/:id route is cookie-authenticated (index.ts:665), so
  // this Bearer header is ignored and the call 401s — the gateway_session row is
  // NOT deleted server-side and is orphaned in D1. Handed back to the relay agent
  // (add gateway_secret auth, or have cli-complete also issue a CLI session
  // token). The LOCAL logout below always succeeds regardless.
  await fetch(`${relayUrl}/api/sessions/${config.session_id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${config.gateway_secret}` },
  }).catch(() => {});

  await clearCloudConfig();
  console.error(chalk.green("✓ Logged out from Zintus Cloud."));
}
