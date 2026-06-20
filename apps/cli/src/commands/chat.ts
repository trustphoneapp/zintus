import chalk from "chalk";
import ora from "ora";
import { tryGitDiff } from "@zintus/context-compiler";
import { listKeys } from "@zintus/keychain";
import type { ContextMode } from "@zintus/types";
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
  // Zero-config nudge: if no keys are stored, point at the guided wizard. We
  // still proceed (a local Ollama may serve), so this is a hint, not a hard stop.
  if ((await listKeys()).length === 0) {
    console.error(
      chalk.dim("No API keys configured — run `zintus setup` to add free providers."),
    );
  }

  const spinner = ora("Routing request").start();
  const config = await loadConfig();
  const engine = createAppEngine(config, {
    workspaceDir: options?.workspaceDir,
  });

  try {
    // The working git diff is included by default (opt-out via --no-diff). It's
    // best-effort: outside a repo or with no changes tryGitDiff returns nothing
    // and we route without diff context — no noise, no empty thread.
    let diffText: string | undefined;
    if (options?.diff !== false) {
      const diff = await tryGitDiff(process.cwd());
      if (diff && diff.trim().length > 0) {
        diffText = diff;
      }
    }

    // The engine only compiles codebase/diff context for threaded requests, so
    // when context is actually available we create a thread up front and pass
    // its id (the engine's own auto-thread is created too late to compile).
    const useContext = Boolean(options?.workspaceDir) || Boolean(diffText);
    const threadId = useContext
      ? engine.createThread(prompt.slice(0, 48)).id
      : undefined;
    if (diffText) {
      spinner.text = "Routing request (with working git diff)";
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
