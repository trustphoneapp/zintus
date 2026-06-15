import chalk from "chalk";
import ora from "ora";
import { createAppEngine } from "../lib/router.js";
import { loadConfig } from "../lib/config.js";

export async function runChat(prompt: string): Promise<void> {
  const spinner = ora("Routing request").start();
  const config = await loadConfig();
  const engine = createAppEngine(config);

  try {
    const result = await engine.routeAndStream({
      messages: [{ role: "user", content: prompt }],
    });

    const provider = (await engine.getProviderStatus()).find(
      (p) => p.id === result.providerId,
    );
    spinner.succeed(
      `Routed to ${chalk.cyan(provider?.name ?? result.providerId)} · trace ${chalk.dim(result.traceId.slice(0, 8))}`,
    );

    for await (const chunk of result.stream) {
      process.stdout.write(chunk);
    }
    process.stdout.write("\n");

    if (result.threadId) {
      console.error(chalk.dim(`thread ${result.threadId}`));
    }
  } catch (error) {
    spinner.fail("Request failed");
    console.error(
      chalk.red(error instanceof Error ? error.message : String(error)),
    );
    process.exit(1);
  }
}
