import chalk from "chalk";
import ora from "ora";
import { tryGitDiff } from "@multipleai/context-compiler";
import type { ContextMode } from "@multipleai/types";
import { createAppEngine } from "../lib/router.js";
import { loadConfig } from "../lib/config.js";

export interface ChatOptions {
  mode?: ContextMode;
  /** Index this workspace for codebase-aware context. When the flag is passed
   *  without a value, defaults to process.cwd(). Off by default. */
  workspaceDir?: string;
  /** Include the current git diff (best-effort) as turn context. */
  diff?: boolean;
}

export async function runChat(
  prompt: string,
  options?: ChatOptions,
): Promise<void> {
  const spinner = ora("Routing request").start();
  const config = await loadConfig();
  const engine = createAppEngine(config, {
    workspaceDir: options?.workspaceDir,
  });

  try {
    // The engine only compiles codebase/diff context for threaded requests, so
    // when either context flag is active we create a thread up front and pass
    // its id (the engine's own auto-thread is created too late to compile).
    const useContext = Boolean(options?.workspaceDir) || Boolean(options?.diff);
    const threadId = useContext
      ? engine.createThread(prompt.slice(0, 48)).id
      : undefined;

    let diffText: string | undefined;
    if (options?.diff) {
      const diff = await tryGitDiff(process.cwd());
      if (diff && diff.trim().length > 0) {
        diffText = diff;
      } else {
        spinner.info(
          chalk.dim(
            "No git diff available (not a repo or no changes) — proceeding without diff context.",
          ),
        );
        spinner.start("Routing request");
      }
    }

    const result = await engine.routeAndStream({
      messages: [{ role: "user", content: prompt }],
      mode: options?.mode ?? config.contextMode,
      threadId,
      diffText,
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

    const saved = engine.getSavings().total;
    if (saved > 0) {
      console.error(
        chalk.dim(`Estimated saved vs paid APIs: $${saved.toFixed(2)} (est.)`),
      );
    }
  } catch (error) {
    spinner.fail("Request failed");
    console.error(
      chalk.red(error instanceof Error ? error.message : String(error)),
    );
    process.exit(1);
  }
}
