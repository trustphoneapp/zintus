import chalk from "chalk";
import { loadCloudConfig } from "./cloud.js";

/**
 * `zintus remote` — show the cloud remote URL and optionally a QR code.
 * QR code requires `qrcode-terminal` to be installed (optional peer dep).
 */
export async function runRemote(options?: { qr?: boolean }): Promise<void> {
  const config = await loadCloudConfig();
  if (!config) {
    console.error(
      chalk.yellow(
        "Not connected to Zintus Cloud. Run: zintus cloud login",
      ),
    );
    process.exit(1);
  }

  const relayUrl = config.relay_url;
  const dashboardUrl = `${relayUrl.replace(/\/$/, "")}/dashboard`;

  console.error(chalk.bold("Zintus Cloud Remote"));
  console.error(chalk.dim("Session:"), config.session_id);
  console.error(chalk.dim("Dashboard:"), chalk.cyan(dashboardUrl));

  if (options?.qr) {
    try {
      // qrcode-terminal is an optional dependency — import dynamically to avoid hard failure
      type QRModule = { default: { generate: (url: string, opts: { small: boolean }) => void } };
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const qrcode = await (Function("return import('qrcode-terminal')")() as Promise<QRModule>).catch(() => null);
      if (qrcode && typeof qrcode.default?.generate === "function") {
        console.error("");
        qrcode.default.generate(dashboardUrl, { small: true });
      } else {
        console.error(
          chalk.dim("  (install qrcode-terminal for QR code: bun add qrcode-terminal)"),
        );
        console.error(chalk.dim("  URL:"), dashboardUrl);
      }
    } catch {
      console.error(chalk.dim("  URL:"), dashboardUrl);
    }
  }
}
