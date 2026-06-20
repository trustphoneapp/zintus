import chalk from "chalk";
import { createAppEngine } from "../lib/router.js";
import { loadConfig } from "../lib/config.js";

export async function runHistory(): Promise<void> {
  const config = await loadConfig();
  const engine = createAppEngine(config);
  const threads = engine.listThreads();

  if (threads.length === 0) {
    console.log(chalk.dim("No conversations yet. Run `zintus chat \"hello\"` first."));
    return;
  }

  for (const thread of threads) {
    console.log(
      `${chalk.cyan(thread.id.slice(0, 8))}  ${thread.title}  ${chalk.dim(thread.updatedAt.toLocaleString())}`,
    );
  }
}

export async function runTrace(traceId?: string): Promise<void> {
  const config = await loadConfig();
  const engine = createAppEngine(config);
  const trace = traceId ? engine.getTrace(traceId) : engine.getLastTrace();

  if (!trace) {
    console.log(chalk.dim("No trace found."));
    return;
  }

  console.log(chalk.bold(`Trace ${trace.traceId}`));
  console.log(
    chalk.dim(
      `${trace.startedAt.toISOString()} → ${trace.completedAt?.toISOString() ?? "in progress"}`,
    ),
  );
  if (trace.winner) {
    console.log(`Winner: ${chalk.cyan(trace.winner.providerId)} / ${trace.winner.model}`);
  }
  if (trace.totalLatencyMs != null) {
    console.log(`Latency: ${trace.totalLatencyMs}ms`);
  }

  console.log("\nAttempts:");
  for (const attempt of trace.attempts) {
    const status =
      attempt.status === "success" ? chalk.green("ok") : chalk.red("fail");
    const error = attempt.errorMessage ? chalk.dim(` — ${attempt.errorMessage}`) : "";
    console.log(
      `  ${status} ${attempt.providerId}/${attempt.model} ${attempt.latencyMs}ms${error}`,
    );
  }
}
