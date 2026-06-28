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

export interface CloudStatusResult {
  logged_in: boolean;
  session_id?: string;
  relay?: string;
  // "online"/"offline" only when the relay actually answered; "unknown" when the
  // state could NOT be verified (relay unreachable / credentials rejected / an
  // unexpected response) — never a confident-but-wrong "offline".
  status?: "online" | "offline" | "unknown";
  online?: boolean | null;
  last_seen?: number | null;
  reason?: string;
}

export async function runCloudStatus(options?: { json?: boolean }): Promise<void> {
  const json = options?.json ?? false;
  const config = await loadCloudConfig();
  if (!config) {
    if (json) {
      console.log(JSON.stringify({ logged_in: false } satisfies CloudStatusResult));
    } else {
      console.error(
        chalk.yellow("Not logged in to Zintus Cloud. Run: zintus cloud login"),
      );
    }
    return;
  }

  const relayUrl = config.relay_url ?? DEFAULT_RELAY_URL;
  // The relay's GET /api/sessions/:id/status accepts EITHER an owner cookie or
  // THIS session's own gateway_secret as a Bearer token (session-scoped — see
  // authorizeSessionScoped in workers/relay/src/index.ts, locked in by
  // workers/relay/tests/cloud-auth-bearer.test.ts). The CLI holds no browser
  // cookie, so it authenticates with the secret it stored at login.
  const res = await fetch(
    `${relayUrl}/api/sessions/${config.session_id}/status`,
    { headers: { Authorization: `Bearer ${config.gateway_secret}` } },
  ).catch(() => null);

  // Be honest about WHY the state couldn't be read instead of mislabelling every
  // failure "offline": a 401 (bad/expired secret) or an unreachable relay does
  // NOT mean the gateway is down — the real state is genuinely UNKNOWN. Say so
  // (and exit non-zero) rather than printing a confident-but-wrong "offline".
  if (!res || !res.ok) {
    const reason = !res
      ? "could not reach relay"
      : res.status === 401 || res.status === 403
        ? "relay rejected the saved credentials — run: zintus cloud login"
        : `relay returned HTTP ${res.status}`;
    process.exitCode = 1;
    if (json) {
      console.log(
        JSON.stringify({
          logged_in: true,
          session_id: config.session_id,
          relay: relayUrl,
          status: "unknown",
          online: null,
          last_seen: null,
          reason,
        } satisfies CloudStatusResult),
      );
    } else {
      console.error(chalk.dim("Session ID:"), config.session_id);
      console.error(chalk.dim("Relay:"), relayUrl);
      console.error(
        chalk.dim("Status:"),
        chalk.yellow(`unknown (cannot verify — ${reason})`),
      );
    }
    return;
  }

  const data = (await res.json().catch(() => ({}))) as {
    online?: boolean;
    name?: string;
    last_seen?: number;
  };
  const online = data.online === true;

  if (json) {
    console.log(
      JSON.stringify({
        logged_in: true,
        session_id: config.session_id,
        relay: relayUrl,
        status: online ? "online" : "offline",
        online,
        last_seen: data.last_seen ?? null,
      } satisfies CloudStatusResult),
    );
    return;
  }

  console.error(chalk.dim("Session ID:"), config.session_id);
  console.error(chalk.dim("Relay:"), relayUrl);
  console.error(
    chalk.dim("Status:"),
    online ? chalk.green("● online") : chalk.gray("○ offline"),
  );
  if (data.last_seen) {
    console.error(
      chalk.dim("Last seen:"),
      new Date(data.last_seen).toLocaleString(),
    );
  }
}

// ── zintus cloud logout ───────────────────────────────────────────────────

export interface CloudLogoutResult {
  // True once the local credentials have been removed (always, on any logout).
  logged_out: boolean;
  // True only when the relay confirmed the server-side session was deleted.
  revoked: boolean;
  session_id?: string;
  relay?: string;
  reason?: string;
}

export async function runCloudLogout(options?: { json?: boolean }): Promise<void> {
  const json = options?.json ?? false;
  const config = await loadCloudConfig();
  if (!config) {
    if (json) {
      console.log(
        JSON.stringify({
          logged_out: false,
          revoked: false,
          reason: "not_logged_in",
        } satisfies CloudLogoutResult),
      );
    } else {
      console.error(chalk.yellow("Not logged in."));
    }
    return;
  }

  const relayUrl = config.relay_url ?? DEFAULT_RELAY_URL;
  // Revoke the server-side session FIRST, then clear local state. The relay's
  // DELETE /api/sessions/:id accepts THIS session's gateway_secret as a Bearer
  // (session-scoped — authorizeSessionScoped in workers/relay/src/index.ts,
  // covered by workers/relay/tests/cloud-auth-bearer.test.ts), so the CLI can
  // delete the row it created without a browser cookie. A 200 means the
  // gateway_sessions row is gone server-side; anything else (401 / 5xx /
  // unreachable) means the server session may be ORPHANED — we still clear the
  // local credentials but report it and exit non-zero.
  const res = await fetch(`${relayUrl}/api/sessions/${config.session_id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${config.gateway_secret}` },
  }).catch(() => null);

  const revoked = res?.ok ?? false;
  const reason = revoked
    ? undefined
    : !res
      ? "could not reach relay"
      : `relay returned HTTP ${res.status}`;

  // Local credentials are ALWAYS removed, regardless of the revoke outcome.
  await clearCloudConfig();

  if (!revoked) process.exitCode = 1;

  if (json) {
    const result: CloudLogoutResult = {
      logged_out: true,
      revoked,
      session_id: config.session_id,
      relay: relayUrl,
    };
    if (reason) result.reason = reason;
    console.log(JSON.stringify(result));
    return;
  }

  if (revoked) {
    console.error(
      chalk.green("✓ Logged out from Zintus Cloud (server session revoked)."),
    );
  } else {
    console.error(chalk.green("✓ Cleared local credentials."));
    console.error(
      chalk.yellow(
        `⚠ Could not revoke the server session (${reason}). It may remain until it expires; sign in again to manage it.`,
      ),
    );
  }
}
