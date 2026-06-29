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
  // Repeatable `--image <path>`, collected into an array (max enforced in chat).
  image?: string[];
  // From `--tools [file]`: `true` when bare (enable the built-in executable
  // tools), or a path string to a JSON file of custom tool/function definitions.
  tools?: string | boolean;
  // `--mcp` / `--no-mcp`: force MCP on/off for this turn. Undefined = auto (on
  // when servers are enabled). Commander stores `--no-mcp` as `mcp: false`.
  mcp?: boolean;
}

// Commander collector: accumulate each repeated `--image` into one array.
function collectImage(value: string, previous: string[]): string[] {
  return [...previous, value];
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
  return {
    mode,
    workspaceDir,
    diff: options.diff,
    images: options.image,
    // A bare `--tools` (true) enables the built-in executable tools; a path
    // string points at a custom ToolDefinition[] JSON file.
    toolsFile: typeof options.tools === "string" ? options.tools : undefined,
    builtinTools: options.tools === true,
    mcp: options.mcp,
  };
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
  .option(
    "--image <path>",
    "Attach an image for a vision-capable model (repeatable, max 4)",
    collectImage,
    [],
  )
  .option(
    "--tools [file]",
    "Enable built-in executable tools (calculator, current_datetime, random_number) and run the execute→feed-back loop; pass a JSON file path for custom tool definitions",
  )
  .option(
    "--no-mcp",
    "Skip enabled MCP servers for this turn (default: enabled servers are offered)",
  )
  .option(
    "--mcp",
    "Force-enable MCP for this turn (routes via your gateway, which hosts the servers)",
  )
  .action(async (prompt: string, options: ChatCliOptions) => {
    await runChat(prompt, toChatOptions(options));
  });

program
  .command("research")
  .description(
    "Deep web research with cited sources (needs TAVILY_API_KEY or SERPER_API_KEY)",
  )
  .argument("<query>", "Research question")
  .option("--depth <depth>", "quick | standard | deep", "standard")
  .option("--json", "Output the result as JSON")
  .action(
    async (
      query: string,
      options: { depth?: string; json?: boolean },
    ) => {
      const { runResearch } = await import("./commands/research.js");
      const depth =
        options.depth === "quick" ||
        options.depth === "deep" ||
        options.depth === "standard"
          ? options.depth
          : "standard";
      await runResearch(query, { depth, json: options.json });
    },
  );

program
  .argument("[prompt]", "Shorthand for chat")
  .option("--mode <mode>", "Context mode (fast|smart|deep)")
  .option(
    "--code, --workspace [dir]",
    "Index a workspace for codebase-aware context (default: current dir)",
  )
  .option("--no-diff", "Don't auto-include the working git diff as context")
  .option(
    "--image <path>",
    "Attach an image for a vision-capable model (repeatable, max 4)",
    collectImage,
    [],
  )
  .option(
    "--tools [file]",
    "Enable built-in executable tools (calculator, current_datetime, random_number) and run the execute→feed-back loop; pass a JSON file path for custom tool definitions",
  )
  .option(
    "--no-mcp",
    "Skip enabled MCP servers for this turn (default: enabled servers are offered)",
  )
  .option(
    "--mcp",
    "Force-enable MCP for this turn (routes via your gateway, which hosts the servers)",
  )
  .action(async (prompt: string | undefined, options: ChatCliOptions) => {
    if (!prompt) {
      program.help();
      return;
    }
    await runChat(prompt, toChatOptions(options));
  });

program
  .command("agent")
  .description(
    "Run a SANDBOXED coding agent: it reads/searches files and (with per-write confirmation) edits them, confined to --root",
  )
  .argument("<task>", "What the agent should do")
  .option(
    "--root <dir>",
    "Sandbox root the agent is confined to (default: current dir)",
  )
  .option("--yes", "Auto-apply file writes WITHOUT confirmation (dangerous)")
  .option(
    "--allow-run",
    "Let the agent run ALLOWLISTED verification commands (bun test/typecheck/lint/build) to check its edits; still gated by confirmation",
  )
  .option("--max-rounds <n>", "Cap the tool loop rounds (default 15)")
  .option(
    "--mcp <name...>",
    "Use only these configured MCP servers (by name); default: all enabled",
  )
  .option("--no-mcp", "Disable MCP tools (sandboxed file tools only)")
  .action(
    async (
      task: string,
      options: {
        root?: string;
        yes?: boolean;
        allowRun?: boolean;
        maxRounds?: string;
        mcp?: string[] | boolean;
        // Commander sets `mcp: false` for `--no-mcp`.
      },
    ) => {
      const { runAgent } = await import("./commands/agent.js");
      let maxRounds: number | undefined;
      if (options.maxRounds != null) {
        maxRounds = Number(options.maxRounds);
        if (!Number.isInteger(maxRounds) || maxRounds < 1) {
          throw new Error("Invalid --max-rounds. Expected a positive integer.");
        }
      }
      // Commander: `--no-mcp` => options.mcp === false; `--mcp a b` => string[];
      // absent => undefined (default: all enabled servers).
      const noMcp = options.mcp === false;
      const mcpNames = Array.isArray(options.mcp) ? options.mcp : undefined;
      await runAgent(task, {
        root: options.root,
        yes: options.yes,
        allowRun: options.allowRun,
        maxRounds,
        mcp: mcpNames,
        noMcp,
      });
    },
  );

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
  .option(
    "--fallback",
    "Append as a FALLBACK key (kept in priority order; the router tries it on an auth failure) instead of replacing the primary",
  )
  .action(async (provider: string, key: string, options: { fallback?: boolean }) => {
    await runKeysSet(provider, key, options);
  });

keys
  .command("list")
  .description("List stored API keys (masked)")
  .option("--json", "Output as JSON for automation")
  .action(async (options: { json?: boolean }) => {
    await runKeysList(options);
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

const mcp = program
  .command("mcp")
  .description(
    "Manage MCP servers (the tools your chats can call). Your gateway hosts them; stdio servers spawn a LOCAL process",
  );

mcp
  .command("add")
  .description("Add (or update, by name) an MCP server")
  .argument("<name>", "Local name for this server")
  .option(
    "--stdio <command>",
    'Spawn a local process via the gateway, e.g. --stdio "npx -y @modelcontextprotocol/server-filesystem /tmp"',
  )
  .option(
    "--arg <value>",
    "Extra argv passed to the --stdio command (repeatable; use for args with spaces)",
    (value: string, prev: string[]) => [...prev, value],
    [],
  )
  .option(
    "--env <KEY=VALUE>",
    "Environment variable for the --stdio process (repeatable)",
    (value: string, prev: string[]) => [...prev, value],
    [],
  )
  .option("--sse <url>", "Connect to a remote server over the HTTP+SSE transport")
  .option("--http <url>", "Connect to a remote server over the Streamable HTTP transport")
  .action(
    async (
      name: string,
      options: {
        stdio?: string;
        arg?: string[];
        env?: string[];
        sse?: string;
        http?: string;
      },
    ) => {
      const { runMcpAdd } = await import("./commands/mcp.js");
      await runMcpAdd(name, options);
    },
  );

mcp
  .command("list")
  .description("List configured MCP servers (● enabled) with tool counts")
  .option("--json", "Output as JSON for automation")
  .action(async (options: { json?: boolean }) => {
    const { runMcpList } = await import("./commands/mcp.js");
    await runMcpList(options);
  });

mcp
  .command("remove")
  .description("Remove an MCP server")
  .argument("<name>", "Server name")
  .action(async (name: string) => {
    const { runMcpRemove } = await import("./commands/mcp.js");
    await runMcpRemove(name);
  });

mcp
  .command("test")
  .description("Connect via the gateway and list the server's tools")
  .argument("<name>", "Server name")
  .action(async (name: string) => {
    const { runMcpTest } = await import("./commands/mcp.js");
    await runMcpTest(name);
  });

mcp
  .command("enable")
  .description("Enable a server (its tools are offered in `zintus chat`)")
  .argument("<name>", "Server name")
  .action(async (name: string) => {
    const { runMcpEnable } = await import("./commands/mcp.js");
    await runMcpEnable(name, true);
  });

mcp
  .command("disable")
  .description("Disable a server (kept, but not offered in chat)")
  .argument("<name>", "Server name")
  .action(async (name: string) => {
    const { runMcpEnable } = await import("./commands/mcp.js");
    await runMcpEnable(name, false);
  });

const projects = program
  .command("projects")
  .description("Workspaces: shared instructions + a default provider for chats");

projects
  .command("list")
  .description("List projects (● marks the active one)")
  .action(async () => {
    const { runProjectsList } = await import("./commands/projects.js");
    await runProjectsList();
  });

projects
  .command("create")
  .description("Create a project")
  .argument("<name>", "Project name")
  .option("--instructions <text>", "System instructions injected into each chat")
  .option("--provider <id>", "Default provider for the project")
  .action(
    async (
      name: string,
      options: { instructions?: string; provider?: string },
    ) => {
      const { runProjectsCreate } = await import("./commands/projects.js");
      await runProjectsCreate(name, options);
    },
  );

projects
  .command("use")
  .description("Set the active project (its instructions lead each chat)")
  .argument("<name>", "Project name")
  .action(async (name: string) => {
    const { runProjectsUse } = await import("./commands/projects.js");
    await runProjectsUse(name);
  });

projects
  .command("clear")
  .description("Deactivate the active project")
  .action(async () => {
    const { runProjectsClear } = await import("./commands/projects.js");
    await runProjectsClear();
  });

projects
  .command("delete")
  .description("Delete a project")
  .argument("<name>", "Project name")
  .action(async (name: string) => {
    const { runProjectsDelete } = await import("./commands/projects.js");
    await runProjectsDelete(name);
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
  .option("--json", "Output the status as JSON for automation")
  .action(async (options: { json?: boolean }) => {
    const { runCloudStatus } = await import("./commands/cloud.js");
    await runCloudStatus({ json: options.json });
  });

cloud
  .command("logout")
  .description("Sign out (revoke the server session) and remove ~/.zintus/cloud.json")
  .option("--json", "Output the result as JSON for automation")
  .action(async (options: { json?: boolean }) => {
    const { runCloudLogout } = await import("./commands/cloud.js");
    await runCloudLogout({ json: options.json });
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
