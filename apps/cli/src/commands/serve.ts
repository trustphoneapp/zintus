import chalk from "chalk";
import {
  startGateway,
  startCloudConnection,
  installShutdownHandlers,
  getOrCreateGatewayKeypair,
  decryptKeyPayload,
  detectLocalRuntimes,
  type CloudConnection,
} from "@zintus/gateway";
import { isValidProvider, setKey, removeKey } from "@zintus/keychain";
import { loadCloudConfig, type CloudConfig } from "./cloud.js";

export interface ServeOptions {
  host?: string;
  port?: number;
  /** Connect to Zintus Cloud relay using credentials in ~/.zintus/cloud.json. */
  cloud?: boolean;
  /** Force Pro managed key mode check on startup (alias: --pro). */
  managed?: boolean;
}

export async function fetchGithubPublicationToken(
  config: CloudConfig,
  forceRefresh = false,
  timeoutMs = 3_000,
): Promise<string | undefined> {
  const query = forceRefresh ? "?forceRefresh=1" : "";
  const response = await fetch(
    `${config.relay_url.replace(/\/$/, "")}/api/sessions/${encodeURIComponent(config.session_id)}/connectors/github/token${query}`,
    {
      headers: { Authorization: `Bearer ${config.gateway_secret}` },
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    },
  ).catch(() => null);
  if (!response?.ok) return undefined;
  const body = await response.json().catch(() => null) as { accessToken?: unknown } | null;
  return typeof body?.accessToken === "string" && body.accessToken.length > 0 && body.accessToken.length <= 4_096
    ? body.accessToken
    : undefined;
}

// ── Pro billing helpers ───────────────────────────────────────────────────

async function fetchBillingStatus(
  sessionId: string,
  relayUrl = "https://relay.zintus.ai",
): Promise<{
  tier: string;
  tokens_used: number;
  tokens_limit: number | null;
} | null> {
  try {
    const res = await fetch(`${relayUrl.replace(/\/$/, "")}/api/billing/status`, {
      headers: { Cookie: `zintus_session=${sessionId}` },
    });
    if (!res.ok) return null;
    return res.json() as Promise<{
      tier: string;
      tokens_used: number;
      tokens_limit: number | null;
    }>;
  } catch {
    return null;
  }
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

async function printBillingStatus(sessionId: string, relayUrl?: string): Promise<void> {
  const status = await fetchBillingStatus(sessionId, relayUrl);
  if (status?.tier && status.tier !== "free") {
    console.error(chalk.cyan(`✓ Pro tier: ${capitalize(status.tier)}`));
    if (status.tokens_limit) {
      const pct = Math.round((status.tokens_used / status.tokens_limit) * 100);
      console.error(
        chalk.dim(
          `  ${fmtTokens(status.tokens_used)} / ${fmtTokens(status.tokens_limit)} tokens used (${pct}%)`,
        ),
      );
      if (pct >= 80) {
        console.error(
          chalk.yellow(
            `  ⚠ 80%+ quota used — upgrade at https://zintus.ai/pricing`,
          ),
        );
      }
    }
  } else {
    console.error(chalk.dim("  BYOK mode — keys read from OS keychain"));
  }
}

// ── Cloud relay ───────────────────────────────────────────────────────────

async function startCloudRelay(
  gatewayUrl: string,
): Promise<CloudConnection | undefined> {
  const config = await loadCloudConfig();
  if (!config) {
    console.error(
      chalk.yellow(
        "  ⚠ Not connected to Zintus Cloud. Run: zintus cloud login",
      ),
    );
    return undefined;
  }

  // Gateway E2E keypair — its public key is advertised to clients so they can
  // encrypt BYOK API keys to it; the private key never leaves this machine.
  const keypair = getOrCreateGatewayKeypair();

  const cloud = startCloudConnection({
    sessionId: config.session_id,
    gatewaySecret: config.gateway_secret,
    relayUrl: config.relay_url,
    getStatus: async () => {
      // Provider inventory + savings now live behind the auth-gated /v1/status
      // (the public /health is minimal). We run in the same process as the
      // gateway, so authenticate with the configured GATEWAY_TOKEN to fetch the
      // full snapshot the dashboard/mobile remote view renders.
      const gatewayToken = process.env.GATEWAY_TOKEN?.trim();
      const authHeaders: Record<string, string> = gatewayToken
        ? { Authorization: `Bearer ${gatewayToken}` }
        : {};
      const res = await fetch(`${gatewayUrl}/v1/status`, {
        headers: authHeaders,
      }).catch(() => null);
      const health = (res?.ok ? await res.json() : { ok: false }) as Record<
        string,
        unknown
      >;
      return {
        ...health,
        gatewayPublicKey: keypair.publicKeyBase64,
        localRuntimes: await detectLocalRuntimes(),
      };
    },
    onControl: async (action, value) => {
      // BYOK key-push: clients send key material encrypted to the gateway's
      // public key; the relay forwards it opaquely. We decrypt here, write to
      // the OS keychain, and the engine picks it up on the next request (keys
      // are read fresh from the keychain per request — no in-memory reload).
      if (action === "set_key") {
        const v = (value ?? {}) as {
          provider?: unknown;
          encryptedKey?: unknown;
        };
        if (
          typeof v.provider !== "string" ||
          !isValidProvider(v.provider) ||
          typeof v.encryptedKey !== "string"
        ) {
          console.error(chalk.yellow("cloud: set_key — invalid payload"));
          return;
        }
        let key: string;
        try {
          key = decryptKeyPayload(v.encryptedKey);
        } catch {
          // Never log key material or decryption internals.
          console.error(chalk.yellow("cloud: set_key — decryption failed"));
          return;
        }
        await setKey(v.provider, key);
        console.error(chalk.dim(`cloud: set_key applied for ${v.provider}`));
        return;
      }

      if (action === "remove_key") {
        const v = (value ?? {}) as { provider?: unknown };
        if (typeof v.provider !== "string" || !isValidProvider(v.provider)) {
          console.error(chalk.yellow("cloud: remove_key — invalid payload"));
          return;
        }
        await removeKey(v.provider);
        console.error(chalk.dim(`cloud: remove_key applied for ${v.provider}`));
        return;
      }
    },
    log: (level, msg) => {
      if (level === "error") {
        console.error(chalk.red(msg));
      } else if (level === "warn") {
        console.error(chalk.yellow(msg));
      } else {
        console.error(chalk.dim(msg));
      }
    },
  });

  console.error(
    chalk.green("✓ Zintus Cloud relay started — ") +
      chalk.dim(`${config.relay_url.replace(/^https?:\/\//, "")}/dashboard`),
  );

  return cloud;
}

/**
 * Run the gateway HTTP server in-process. This is the single source of truth the
 * GUI clients (web/desktop/mobile) connect to; without it they show a
 * "gateway offline" banner. Blocks until the process is killed.
 */
export async function runServe(options?: ServeOptions): Promise<void> {
  const cloudConfig = options?.cloud ? await loadCloudConfig() : null;
  const initialGithubToken = cloudConfig ? await fetchGithubPublicationToken(cloudConfig) : undefined;
  let running: ReturnType<typeof startGateway>;
  try {
    running = startGateway({
      host: options?.host,
      port: options?.port,
      ...(cloudConfig ? {
        githubTokenProvider: ({ forceRefresh } = {}) => fetchGithubPublicationToken(cloudConfig, forceRefresh),
        githubCredentialAvailable: Boolean(initialGithubToken),
      } : {}),
    });
  } catch (error) {
    console.error(
      chalk.red(error instanceof Error ? error.message : String(error)),
    );
    process.exit(1);
  }

  console.error(chalk.green(`✓ Zintus gateway listening on ${running.url}`));
  console.error(
    chalk.dim(
      `  Point clients here (NEXT_PUBLIC_GATEWAY_URL / EXPO_PUBLIC_GATEWAY_URL).`,
    ),
  );

  let cloud: CloudConnection | undefined;
  if (options?.cloud) {
    cloud = await startCloudRelay(running.url);
  } else {
    console.error(
      chalk.dim("  Tip: add ") +
        chalk.bold("--cloud") +
        chalk.dim(" to connect to zintus.app/dashboard"),
    );
  }

  // Pro managed key mode: fetch billing tier if cloud-connected (or --managed forced).
  const billingCloudConfig = cloudConfig ?? await loadCloudConfig();
  if (billingCloudConfig?.session_id) {
    await printBillingStatus(billingCloudConfig.session_id, billingCloudConfig.relay_url);
  } else if (options?.managed) {
    console.error(
      chalk.yellow(
        "  ⚠ --managed flag set but not logged in. Run: zintus cloud login",
      ),
    );
  }

  console.error(chalk.dim("  Press Ctrl+C to stop."));

  // On SIGTERM/SIGINT, drain in-flight streams and close the cloud relay WS
  // (its heartbeat/status timers) cleanly before exiting. A second signal
  // forces an immediate exit.
  installShutdownHandlers(running, () => cloud?.close());

  // Sidecar mode (desktop app sets ZINTUS_PARENT_PID to its own pid): exit
  // when the parent dies. The desktop app kills us on a clean quit
  // (RunEvent::Exit), but a crash / force-quit / SIGKILL never runs that
  // handler — verified in the 2026-07-02 packaged smoke, which orphaned the
  // gateway. `kill(pid, 0)` is a liveness probe (no signal sent): ESRCH =
  // parent gone → shut down; EPERM = alive-but-foreign → keep serving.
  const parentPid = Number(process.env.ZINTUS_PARENT_PID);
  if (Number.isInteger(parentPid) && parentPid > 0) {
    console.error(
      chalk.dim(`  Sidecar mode: exiting if parent pid ${parentPid} dies.`),
    );
    setInterval(() => {
      try {
        process.kill(parentPid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EPERM") {
          console.error(
            chalk.dim("Parent process is gone — shutting the gateway down."),
          );
          process.kill(process.pid, "SIGTERM");
        }
      }
    }, 2_000).unref();
  }

  // Bun.serve keeps the event loop alive; this promise never resolves so the
  // command stays in the foreground until a signal handler exits the process.
  await new Promise<void>(() => {});
}
