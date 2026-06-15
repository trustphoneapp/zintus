import { useEffect, useState } from "react";
import { Box, Text, render } from "ink";
import chalk from "chalk";
import { createAppRouter, getProviderInfos, type ProviderInfo } from "../lib/router.js";
import { loadConfig } from "../lib/config.js";

function QuotaBar({
  used,
  limit,
  width = 30,
}: {
  used: number;
  limit: number;
  width?: number;
}) {
  const pct = limit > 0 ? Math.min(used / limit, 1) : 0;
  const filled = Math.round(pct * width);
  const empty = width - filled;
  const color =
    pct >= 0.9 ? chalk.red : pct >= 0.7 ? chalk.yellow : chalk.green;

  return (
    <Text>
      {color("█".repeat(filled))}
      {chalk.gray("░".repeat(empty))}{" "}
      <Text dimColor>
        {used.toLocaleString()}/{limit.toLocaleString()}
      </Text>
    </Text>
  );
}

function ProviderRow({ provider }: { provider: ProviderInfo }) {
  const status = provider.hasKey ? chalk.green("●") : chalk.gray("○");
  const name = provider.enabled
    ? chalk.hex(provider.color)(provider.name)
    : chalk.gray(provider.name);
  const cooldown = provider.inCooldown ? chalk.yellow(" cooldown") : "";

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>
        {status} {name.padEnd(14)}{" "}
        <Text dimColor>
          {provider.hasKey ? "configured" : "no key"}
          {cooldown}
        </Text>
      </Text>
      <Box marginLeft={2}>
        <QuotaBar used={provider.quotaUsed} limit={provider.quotaLimit} />
      </Box>
    </Box>
  );
}

function StatusDashboard() {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;

    async function refresh() {
      const config = await loadConfig();
      const router = createAppRouter(config);
      const infos = await getProviderInfos(router);
      if (active) {
        setProviders(infos);
        setLoading(false);
      }
    }

    refresh();
    const interval = setInterval(refresh, 2000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, []);

  const configured = providers.filter((p) => p.hasKey).length;

  return (
    <Box flexDirection="column" padding={1} borderStyle="round" borderColor="cyan">
      <Text bold color="cyan">
        MultipleAI Status
      </Text>
      <Text dimColor>
        {configured}/{providers.length} providers configured · refreshes every 2s
      </Text>
      <Box marginTop={1} flexDirection="column">
        {loading ? (
          <Text dimColor>Loading...</Text>
        ) : (
          providers.map((p) => <ProviderRow key={p.id} provider={p} />)
        )}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Press Ctrl+C to exit</Text>
      </Box>
    </Box>
  );
}

export function runStatus(): void {
  render(<StatusDashboard />);
}
