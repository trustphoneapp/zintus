import chalk from "chalk";
import { startGateway } from "@zintus/gateway";

export interface ServeOptions {
  host?: string;
  port?: number;
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
  console.error(chalk.dim("  Press Ctrl+C to stop."));

  // Bun.serve keeps the event loop alive; this promise never resolves so the
  // command stays in the foreground until the process is interrupted.
  await new Promise<void>(() => {});
}
