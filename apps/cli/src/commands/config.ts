import * as p from "@clack/prompts";
import chalk from "chalk";
import { DEFAULT_CONFIG, PROVIDER_IDS, type ProviderId, type RoutingStrategy } from "@multipleai/types";
import { PROVIDER_META } from "../lib/router.js";
import { loadConfig, saveConfig, isRoutingStrategy } from "../lib/config.js";

export async function runConfig(): Promise<void> {
  p.intro(chalk.bgCyan.black(" multipleai config "));

  const current = await loadConfig();

  const strategy = await p.select({
    message: "Routing strategy",
    options: [
      {
        value: "fastest" as RoutingStrategy,
        label: "Fastest",
        hint: "use provider priority order below",
      },
      {
        value: "capability" as RoutingStrategy,
        label: "Capability",
        hint: "prefer higher-capability models",
      },
      {
        value: "economy" as RoutingStrategy,
        label: "Economy",
        hint: "prefer providers with most quota headroom",
      },
    ],
    initialValue: current.routingStrategy,
  });

  if (p.isCancel(strategy)) {
    p.cancel("Configuration cancelled.");
    process.exit(0);
  }

  const providerOptions = PROVIDER_IDS.map((id) => ({
    value: id,
    label: PROVIDER_META[id].name,
  }));

  const priority = await p.multiselect({
    message: "Provider priority (top = highest)",
    options: providerOptions,
    required: true,
    initialValues: current.providerPriority,
  });

  if (p.isCancel(priority)) {
    p.cancel("Configuration cancelled.");
    process.exit(0);
  }

  const defaultProvider = await p.select({
    message: "Default provider (optional fallback)",
    options: [{ value: "", label: "None" }, ...providerOptions],
    initialValue: current.defaultProvider ?? "",
  });

  if (p.isCancel(defaultProvider)) {
    p.cancel("Configuration cancelled.");
    process.exit(0);
  }

  const routingStrategy = isRoutingStrategy(String(strategy))
    ? strategy
    : DEFAULT_CONFIG.routingStrategy;

  const config = {
    routingStrategy,
    providerPriority: priority as ProviderId[],
    ...(defaultProvider
      ? { defaultProvider: defaultProvider as ProviderId }
      : {}),
  };

  await saveConfig(config);

  p.outro(chalk.green("Configuration saved to ~/.multipleai/config.json"));
}
