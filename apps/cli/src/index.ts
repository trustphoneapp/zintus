#!/usr/bin/env bun
import { Command } from "commander";
import chalk from "chalk";
import { PROVIDER_IDS } from "@multipleai/types";
import { runChat } from "./commands/chat.js";
import { runKeysSet, runKeysList, runKeysRemove } from "./commands/keys.js";
import { runConfig } from "./commands/config.js";
import { runHistory, runTrace } from "./commands/history.js";

const program = new Command();

program
  .name("multipleai")
  .description("Multi-provider AI CLI")
  .version("0.0.1");

program
  .command("chat")
  .description("Stream a chat response")
  .argument("<prompt>", "Chat prompt to send")
  .action(async (prompt: string) => {
    await runChat(prompt);
  });

program
  .argument("[prompt]", "Shorthand for chat")
  .action(async (prompt?: string) => {
    if (!prompt) {
      program.help();
      return;
    }
    await runChat(prompt);
  });

program
  .command("status")
  .description("Live dashboard of providers and quota usage")
  .action(async () => {
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
