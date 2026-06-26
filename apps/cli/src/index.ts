#!/usr/bin/env bun
import { Command } from "commander";
import chalk from "chalk";
import { PROVIDER_IDS, type ContextMode } from "@zintus/types";
import { redactSecrets } from "@zintus/router";
import { runChat, type ChatOptions } from "./commands/chat.js";
import {
  runKeysSet,
  runKeysList,
  runKeysRemove,
  runKeysTest,
} from "./commands/keys.js";
import { runConfig } from "./commands/config.js";
import { runHistory, runTrace } from "./commands/history.js";

const program = new Command();

program
  .name("zintus")
  .description("Multi-provider AI CLI")
  .version("0.2.0");

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
  .command("test")
  .description("Validate a stored API key against its provider")
  .argument("<provider>", "Provider name")
  .action(async (provider: string) => {
    await runKeysTest(provider);
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
  // `init` is the name used across the marketing site / README / docs; keep it
  // as an alias so the advertised `zintus init` works (both invoke the wizard).
  .alias("init")
  .description("First-run wizard: add API keys with validation")
  .action(async () => {
    const { runSetup } = await import("./ui/setup.js");
    await runSetup();
  });

program
  .command("serve")
  .description("Run the gateway HTTP server the GUI clients connect to")
  .option("--host <host>", "Interface to bind (default 127.0.0.1)")
  .option("--port <port>", "Port to listen on (default 8788)")
  .option("--cloud", "Connect to Zintus Cloud relay (requires: zintus cloud login)")
  .option("--remote", "Alias for --cloud: connect to Zintus Cloud relay")
  .option("--managed, --pro", "Check Pro tier billing status on startup")
  .action(async (options: { host?: string; port?: string; cloud?: boolean; remote?: boolean; managed?: boolean }) => {
    const { runServe } = await import("./commands/serve.js");
    const port = options.port == null ? undefined : Number(options.port);
    if (port != null && (!Number.isInteger(port) || port < 1 || port > 65535)) {
      throw new Error("Invalid --port. Expected an integer 1–65535.");
    }
    await runServe({ host: options.host, port, cloud: options.cloud || options.remote, managed: options.managed });
  });

program
  .command("remote")
  .description("Show cloud remote URL and QR code for mobile access")
  .option("--qr", "Display QR code (requires qrcode-terminal)")
  .action(async (options: { qr?: boolean }) => {
    const { runRemote } = await import("./commands/remote.js");
    await runRemote(options);
  });

const cloud = program
  .command("cloud")
  .description("Connect your gateway to Zintus Cloud for remote access");

cloud
  .command("login")
  .description("Sign in to zintus.app and save credentials to ~/.zintus/cloud.json")
  .option("--relay-url <url>", "Custom relay URL (default: https://relay.zintus.ai)")
  .option("--web-url <url>", "Custom web app URL for browser sign-in (default: https://www.zintus.ai)")
  .action(async (options: { relayUrl?: string; webUrl?: string }) => {
    const { runCloudLogin } = await import("./commands/cloud.js");
    await runCloudLogin({ relayUrl: options.relayUrl, webUrl: options.webUrl });
  });

cloud
  .command("status")
  .description("Show cloud connection status")
  .action(async () => {
    const { runCloudStatus } = await import("./commands/cloud.js");
    await runCloudStatus();
  });

cloud
  .command("logout")
  .description("Sign out and remove ~/.zintus/cloud.json")
  .action(async () => {
    const { runCloudLogout } = await import("./commands/cloud.js");
    await runCloudLogout();
  });

program
  .command("doctor")
  .description("Check system health: keychain, quota DB, provider keys, Ollama, relay")
  .action(async () => {
    const { runDoctor } = await import("./commands/doctor.js");
    await runDoctor();
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
  const raw = err instanceof Error ? err.message : String(err);
  console.error(chalk.red("Error:"), redactSecrets(raw));
  process.exit(1);
});
