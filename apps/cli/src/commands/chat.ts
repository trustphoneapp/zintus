import chalk from "chalk";
import ora from "ora";
import { createAppRouter } from "../lib/router.js";
import { loadConfig } from "../lib/config.js";

export async function runChat(prompt: string): Promise<void> {
  const spinner = ora("Routing request").start();
  const config = await loadConfig();
  const router = createAppRouter(config);

  try {
    const result = await router.routeAndStream({
      messages: [{ role: "user", content: prompt }],
    });

    const provider = (await router.getProviderStatus()).find(
      (p) => p.id === result.providerId,
    );
    spinner.succeed(`Routed to ${chalk.cyan(provider?.name ?? result.providerId)}`);

    for await (const chunk of result.stream) {
      process.stdout.write(chunk);
    }
    process.stdout.write("\n");
  } catch (error) {
    spinner.fail("Request failed");
    console.error(
      chalk.red(error instanceof Error ? error.message : String(error)),
    );
    process.exit(1);
  }
}
