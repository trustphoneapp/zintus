import chalk from "chalk";
import {
  startGateway,
  startCloudConnection,
  getOrCreateGatewayKeypair,
  decryptKeyPayload,
  detectLocalRuntimes,
} from "@zintus/gateway";
import { isValidProvider, setKey, removeKey } from "@zintus/keychain";
import { loadCloudConfig } from "./cloud.js";

export interface ServeOptions {
  host?: string;
  port?: number;
  /** Connect to Zintus Cloud relay using credentials in ~/.zintus/cloud.json. */
  cloud?: boolean;
  /** Force Pro managed key mode check on startup (alias: --pro). */
  managed?: boolean;
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

async function startCloudRelay(gatewayUrl: string): Promise<void> {
  const config = await loadCloudConfig();
  if (!config) {
    console.error(
      chalk.yellow(
        "  ⚠ Not connected to Zintus Cloud. Run: zintus cloud login",
      ),
    );
    return;
  }

  // Gateway E2E keypair — its public key is advertised to clients so they can
  // encrypt BYOK API keys to it; the private key never leaves this machine.
  const keypair = getOrCreateGatewayKeypair();

  startCloudConnection({
    sessionId: config.session_id,
    gatewaySecret: config.gateway_secret,
    relayUrl: config.relay_url,
    getStatus: async () => {
      const res = await fetch(`${gatewayUrl}/health`).catch(() => null);
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
}

/**
 * Run the gateway HTTP server in-process. This is the single source of truth the
 * GUI clients (web/desktop/mobile) connect to; without it they show a
 * "gateway offline" banner. Blocks until the process is killed.
 */
export async function runServe(options?: ServeOptions): Promise<void> {
  let running: ReturnType<typeof startGateway>;
  try {
    running = startGateway({ host: options?.host, port: options?.port });
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

  if (options?.cloud) {
    await startCloudRelay(running.url);
  } else {
    console.error(
      chalk.dim("  Tip: add ") +
        chalk.bold("--cloud") +
        chalk.dim(" to connect to zintus.app/dashboard"),
    );
  }

  // Pro managed key mode: fetch billing tier if cloud-connected (or --managed forced).
  const cloudConfig = await loadCloudConfig();
  if (cloudConfig?.session_id) {
    await printBillingStatus(cloudConfig.session_id, cloudConfig.relay_url);
  } else if (options?.managed) {
    console.error(
      chalk.yellow(
        "  ⚠ --managed flag set but not logged in. Run: zintus cloud login",
      ),
    );
  }

  console.error(chalk.dim("  Press Ctrl+C to stop."));

  // Bun.serve keeps the event loop alive; this promise never resolves so the
  // command stays in the foreground until the process is interrupted.
  await new Promise<void>(() => {});
}
