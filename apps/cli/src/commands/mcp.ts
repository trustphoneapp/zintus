import chalk from "chalk";
import type { MCPServerConfig, MCPTool } from "@zintus/mcp";
import {
  addMcpServer,
  gatewayUrl,
  getMcpServer,
  loadMcpServers,
  removeMcpServer,
  updateMcpServer,
  type StoredMcpServer,
} from "../lib/mcp-config.js";

/** Result of asking the gateway to connect to one server: the advertised tools,
 *  or an honest, human-readable error (never thrown — every caller renders it). */
export type DiscoverResult = { tools: MCPTool[] } | { error: string };

/**
 * Ask the LOCAL gateway (`zintus serve`) to connect to one MCP server and report
 * its tools, via POST /v1/mcp/discover. The gateway is the only component that
 * hosts MCP — for a `stdio` server it spawns the user's local process. Never
 * throws: an offline gateway or a refused connection resolves to `{ error }`.
 */
export async function discoverMcpServer(
  config: MCPServerConfig,
): Promise<DiscoverResult> {
  let response: Response;
  try {
    response = await fetch(`${gatewayUrl()}/v1/mcp/discover`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return {
      error:
        "Couldn't reach the gateway. Start it with `zintus serve`, then try again.",
    };
  }
  const body = (await response.json().catch(() => null)) as {
    tools?: MCPTool[];
    error?: { message?: string };
  } | null;
  if (!response.ok) {
    return {
      error:
        body?.error?.message ??
        `The gateway couldn't connect to the server (error ${response.status}).`,
    };
  }
  return { tools: body?.tools ?? [] };
}

function transportLabel(config: MCPServerConfig): string {
  if (config.transport === "stdio") {
    return `stdio: ${[config.command, ...(config.args ?? [])].join(" ")}`;
  }
  return `${config.transport}: ${config.url}`;
}

export interface AddOptions {
  stdio?: string;
  arg?: string[];
  env?: string[];
  sse?: string;
  http?: string;
}

/** Parse `K=V` pairs into an env record. Throws on a malformed pair so the user
 *  gets a clear message rather than a silently dropped variable. */
function parseEnv(pairs: string[] | undefined): Record<string, string> | undefined {
  if (!pairs || pairs.length === 0) {
    return undefined;
  }
  const env: Record<string, string> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) {
      throw new Error(`Invalid --env "${pair}". Expected KEY=VALUE.`);
    }
    env[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return env;
}

/** Build the MCPServerConfig from the mutually-exclusive transport flags. */
function configFromOptions(options: AddOptions): MCPServerConfig {
  const chosen = [options.stdio, options.sse, options.http].filter(Boolean);
  if (chosen.length !== 1) {
    throw new Error(
      "Choose exactly one transport: --stdio \"<command>\", --sse <url>, or --http <url>.",
    );
  }
  if (options.stdio) {
    // The command is split on whitespace for convenience; repeated --arg appends
    // further argv entries verbatim (use --arg for anything containing spaces).
    const parts = options.stdio.trim().split(/\s+/);
    const command = parts[0];
    if (!command) {
      throw new Error("--stdio needs a command, e.g. --stdio \"npx -y my-mcp\".");
    }
    return {
      transport: "stdio",
      command,
      args: [...parts.slice(1), ...(options.arg ?? [])],
      env: parseEnv(options.env),
    };
  }
  const url = (options.sse ?? options.http)!;
  return { transport: options.sse ? "sse" : "http", url };
}

export async function runMcpAdd(name: string, options: AddOptions): Promise<void> {
  let config: MCPServerConfig;
  try {
    config = configFromOptions(options);
  } catch (error) {
    console.error(chalk.red(error instanceof Error ? error.message : String(error)));
    process.exit(1);
  }

  const existed = Boolean(await getMcpServer(name));
  const server: StoredMcpServer = {
    name,
    config,
    enabled: true,
    enabledTools: "all",
  };
  await addMcpServer(server);

  console.log(
    chalk.green(existed ? `✓ Updated MCP server ${name}` : `✓ Added MCP server ${name}`),
    chalk.dim(`(${transportLabel(config)})`),
  );
  if (config.transport === "stdio") {
    console.log(
      chalk.dim(
        "  Heads up: this spawns a LOCAL process via your gateway when chat uses it.",
      ),
    );
  }
  console.log(chalk.dim(`  Test it: zintus mcp test ${name}`));
}

export async function runMcpList(options?: { json?: boolean }): Promise<void> {
  const servers = await loadMcpServers();

  if (options?.json) {
    console.log(JSON.stringify(servers, null, 2));
    return;
  }

  if (servers.length === 0) {
    console.log(chalk.dim("No MCP servers configured."));
    console.log(chalk.dim("Add one: zintus mcp add <name> --stdio \"npx -y <server>\""));
    return;
  }

  console.log(chalk.bold("Configured MCP servers:\n"));
  for (const server of servers) {
    const dot = server.enabled ? chalk.green("●") : chalk.dim("○");
    // Tool count is from the last successful `test` — "untested" until then, so
    // we never imply a live connection or a fabricated count.
    const toolNote =
      server.tools != null
        ? chalk.dim(`${server.tools.length} tool${server.tools.length === 1 ? "" : "s"}`)
        : chalk.dim("untested");
    console.log(`  ${dot} ${chalk.cyan(server.name.padEnd(16))} ${toolNote}`);
    console.log(`      ${chalk.dim(transportLabel(server.config))}`);
    if (server.lastError) {
      console.log(`      ${chalk.yellow(`last error: ${server.lastError}`)}`);
    }
  }
  console.log(
    chalk.dim(
      "\nEnabled servers are offered to the model in `zintus chat` (--no-mcp to skip).",
    ),
  );
}

export async function runMcpRemove(name: string): Promise<void> {
  const removed = await removeMcpServer(name);
  if (removed) {
    console.log(chalk.green(`✓ Removed MCP server ${name}`));
  } else {
    console.log(chalk.yellow(`No MCP server named ${name}`));
  }
}

export async function runMcpEnable(name: string, enabled: boolean): Promise<void> {
  const ok = await updateMcpServer(name, { enabled });
  if (!ok) {
    console.error(chalk.red(`No MCP server named ${name}`));
    process.exit(1);
  }
  console.log(
    chalk.green(`✓ ${enabled ? "Enabled" : "Disabled"} MCP server ${name}`),
  );
}

export async function runMcpTest(name: string): Promise<void> {
  const server = await getMcpServer(name);
  if (!server) {
    console.error(chalk.red(`No MCP server named ${name}.`));
    console.error(chalk.dim(`Add one: zintus mcp add ${name} --stdio "<command>"`));
    process.exit(1);
  }

  console.log(chalk.dim(`Connecting via gateway (${gatewayUrl()})…`));
  const result = await discoverMcpServer(server.config);

  if ("error" in result) {
    // Persist the honest failure so `list` reflects it; clear any stale success.
    await updateMcpServer(name, { lastError: result.error });
    console.error(chalk.red(`✗ ${result.error}`));
    process.exit(1);
  }

  // Cache the discovered tools (and clear lastError) so `list` shows real counts.
  await updateMcpServer(name, {
    tools: result.tools,
    lastConnectedAt: Date.now(),
    lastError: undefined,
  });

  const n = result.tools.length;
  console.log(chalk.green(`✓ Connected — ${n} tool${n === 1 ? "" : "s"}`));
  for (const tool of result.tools) {
    const desc = tool.description ? chalk.dim(` — ${tool.description}`) : "";
    console.log(`  ${chalk.cyan(tool.name)}${desc}`);
  }
}
