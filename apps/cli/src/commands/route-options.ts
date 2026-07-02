import chalk from "chalk";
import {
  computeRouteOptions,
  detectLocalRuntimes,
  type RouteOptionsResult,
} from "@zintus/gateway";
import { isProviderId } from "@zintus/types";
import { createAppEngine } from "../lib/router.js";
import { loadConfig } from "../lib/config.js";

/**
 * `zintus route-options <provider>` — matrix #14: the same BYOK quota-decision
 * the web/desktop RouteOptionsPanel shows, computed by the SAME function the
 * gateway's /v1/route/options uses (the CLI runs the engine in-process, so it
 * calls computeRouteOptions directly instead of HTTP). Never fabricates quota
 * or reset times; offers BYOK-only actions (no paid/credits option exists).
 */
export async function runRouteOptions(
  provider: string,
  options: { json?: boolean } = {},
): Promise<void> {
  if (!isProviderId(provider)) {
    console.error(chalk.red(`Unknown provider: ${provider}`));
    process.exit(1);
  }

  const config = await loadConfig();
  const engine = createAppEngine(config);
  const statuses = await engine.getProviderStatus();
  const self = statuses.find((s) => s.id === provider);
  const runtimes = await detectLocalRuntimes();

  const result = computeRouteOptions({
    provider,
    statuses,
    ledgerQuotaRemaining:
      self?.hasKey === true ? engine.getQuotaRemaining(provider) : null,
    runtimes,
  });

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  printHuman(result);
}

function printHuman(r: RouteOptionsResult): void {
  console.log(chalk.bold(`\nRoute options — ${r.provider}\n`));
  console.log(
    `  quota remaining: ${
      r.quotaRemaining != null ? `${Math.round(r.quotaRemaining * 100)}%` : chalk.dim("unknown")
    }`,
  );
  console.log(
    `  reset in: ${r.resetIn != null ? `~${r.resetIn}s` : chalk.dim(r.resetReason ?? "unknown")}`,
  );
  console.log(`  local runtime available: ${r.localAvailable ? "yes" : "no"}`);
  console.log(`\n  ${chalk.green("best:")} ${chalk.bold(r.best)} — ${r.reason}`);
  console.log(`  options: ${r.options.join(", ")}`);
  if (r.alternatives.length > 0) {
    console.log(chalk.dim("\n  Healthy alternatives (est. $/1M in+out):"));
    for (const a of r.alternatives) {
      console.log(
        chalk.dim(
          `    ${a.provider.padEnd(12)} ${a.model}  ~$${(a.estInputPer1M + a.estOutputPer1M).toFixed(2)}`,
        ),
      );
    }
  }
  console.log();
}
