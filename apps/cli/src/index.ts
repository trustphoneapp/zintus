#!/usr/bin/env bun
import { Command } from "commander";
import chalk from "chalk";
import { PROVIDER_IDS, type ContextMode } from "@zintus/types";
import { runChat, type ChatOptions } from "./commands/chat.js";
import { runKeysSet, runKeysList, runKeysRemove } from "./commands/keys.js";
import { runConfig } from "./commands/config.js";
import { runHistory, runTrace } from "./commands/history.js";

const program = new Command();

program
  .name("zintus")
  .description("Multi-provider AI CLI")
  .version("0.0.1");

interface ChatCliOptions {
  mode?: string;
  // From `--code` / `--workspace [dir]`. Commander stores the value under the
  // long flag (`workspace`): `true` when bare, a path string when given.
  workspace?: string | boolean;
  diff?: boolean;
}

function toChatOptions(options: ChatCliOptions): ChatOptions {
  const mode = options.mode as ContextMode | undefined;
  if (mode && !["fast", "smart", "deep"].includes(mode)) {
    throw new Error("Invalid --mode. Expected one of: fast, smart, deep");
  }
  let workspaceDir: string | undefined;
  if (options.workspace === true) {
    workspaceDir = process.cwd();
  } else if (typeof options.workspace === "string") {
    workspaceDir = options.workspace;
  }
  return { mode, workspaceDir, diff: options.diff };
}

program
  .command("chat")
  .description("Stream a chat response")
  .argument("<prompt>", "Chat prompt to send")
  .option("--mode <mode>", "Context mode (fast|smart|deep)")
  .option(
    "--code, --workspace [dir]",
    "Index a workspace for codebase-aware context (default: current dir)",
  )
  .option("--no-diff", "Don't auto-include the working git diff as context")
  .action(async (prompt: string, options: ChatCliOptions) => {
    await runChat(prompt, toChatOptions(options));
  });

program
  .argument("[prompt]", "Shorthand for chat")
  .option("--mode <mode>", "Context mode (fast|smart|deep)")
  .option(
    "--code, --workspace [dir]",
    "Index a workspace for codebase-aware context (default: current dir)",
  )
  .option("--no-diff", "Don't auto-include the working git diff as context")
  .action(async (prompt: string | undefined, options: ChatCliOptions) => {
    if (!prompt) {
      program.help();
      return;
    }
    await runChat(prompt, toChatOptions(options));
  });

program
  .command("status")
  .description("Live dashboard of providers and quota usage")
  .action(async () => {
    // Source is status.tsx; TS/bundler emits status.js, so the ESM
    // specifier must use the .js extension (not .tsx) to resolve at runtime.
    const { runStatus } = await import("./commands/status.js");
    runStatus();
  });

const keys = program
  .command("keys")
  .description("Manage API keys in OS keychain");

keys
  .command("set")
  .description("Store an API key for a provider")
  .argument("<provider>", `Provider (${PROVIDER_IDS.join(", ")})`)
  .argument("<key>", "API key value")
  .action(async (provider: string, key: string) => {
    await runKeysSet(provider, key);
  });

keys
  .command("list")
  .description("List stored API keys (masked)")
  .action(async () => {
    await runKeysList();
  });

keys
  .command("remove")
  .description("Remove a stored API key")
  .argument("<provider>", "Provider name")
  .action(async (provider: string) => {
    await runKeysRemove(provider);
  });

program
  .command("config")
  .description("Configure routing strategy via interactive wizard")
  .action(async () => {
    await runConfig();
  });

program
  .command("setup")
  .description("First-run wizard: add API keys with validation")
  .action(async () => {
    const { runSetup } = await import("./ui/setup.js");
    await runSetup();
  });

program
  .command("history")
  .description("List saved conversation threads")
  .action(async () => {
    await runHistory();
  });

program
  .command("trace")
  .description("Show routing trace waterfall for the last or given request")
  .argument("[traceId]", "Trace UUID (defaults to last)")
  .action(async (traceId?: string) => {
    await runTrace(traceId);
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(chalk.red("Error:"), err instanceof Error ? err.message : err);
  process.exit(1);
});
