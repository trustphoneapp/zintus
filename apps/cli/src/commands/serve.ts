import chalk from "chalk";
import { startGateway } from "@zintus/gateway";
import { loadCloudConfig } from "./cloud.js";
import { startCloudConnection } from "@zintus/gateway";

export interface ServeOptions {
  host?: string;
  port?: number;
  /** Connect to Zintus Cloud relay using credentials in ~/.zintus/cloud.json. */
  cloud?: boolean;
}

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

  startCloudConnection({
    sessionId: config.session_id,
    gatewaySecret: config.gateway_secret,
    relayUrl: config.relay_url,
    getStatus: async () => {
      const res = await fetch(`${gatewayUrl}/health`).catch(() => null);
      return res?.ok ? res.json() : { ok: false };
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

  console.error(chalk.dim("  Press Ctrl+C to stop."));

  // Bun.serve keeps the event loop alive; this promise never resolves so the
  // command stays in the foreground until the process is interrupted.
  await new Promise<void>(() => {});
}
