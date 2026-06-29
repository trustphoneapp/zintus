import { createInterface } from "node:readline/promises";
import chalk from "chalk";
import ora from "ora";
import { listKeys } from "@zintus/keychain";
import type { ChatMessage } from "@zintus/types";
import { createAppEngine } from "../lib/router.js";
import { loadConfig } from "../lib/config.js";
import {
  AGENT_TOOL_DEFINITIONS,
  DEFAULT_AGENT_ROUNDS,
  DEFAULT_MUTATION_BUDGET,
  DEFAULT_RUN_BUDGET,
  MAX_AGENT_ROUNDS_CAP,
  RUN_COMMAND_TOOL_NAME,
  type AgentToolContext,
  type ConfirmWrite,
  createSandbox,
  executeAgentToolCall,
  isMutatingTool,
  runAgentToolLoop,
} from "../lib/agent-tools.js";
import {
  type AgentMcpToolset,
  connectAgentMcp,
  isMcpAgentTool,
  selectAgentMcpServers,
} from "../lib/agent-mcp.js";
import { loadMcpServers } from "../lib/mcp-config.js";
import { normalizeChatError } from "./chat-content.js";

export interface AgentOptions {
  /** Sandbox root (default process.cwd()). All file ops are confined here. */
  root?: string;
  /** Bypass the per-write confirmation gate. Prints a loud warning. */
  yes?: boolean;
  /** Round cap for the route→execute→feed-back loop. */
  maxRounds?: number;
  /** Use only these configured MCP servers (by name). Empty/undefined => the
   *  enabled servers. Ignored when `noMcp` is set. */
  mcp?: string[];
  /** Disable MCP entirely — the prior file-tool-only behaviour. */
  noMcp?: boolean;
  /** Opt in to the allowlisted run_command verification tool (off by default). */
  allowRun?: boolean;
}

/** The instruction that frames the task and the sandbox rules for the model. */
function buildSystemPreamble(
  root: string,
  mcpToolCount: number,
  allowRun: boolean,
): string {
  const lines = [
    "You are a coding agent operating inside a SANDBOX.",
    `All file operations are confined to this root: ${root}`,
    "You have these tools: read_file, list_directory, search_code (read-only) and",
    "write_file, apply_edit (mutating, each gated by user confirmation).",
  ];
  if (allowRun) {
    lines.push(
      "You ALSO have run_command: run ONE allowlisted verification command",
      "(bun run test / typecheck / lint / build, or bun test <path>) at the root to",
      "check your edits, then read failures and fix them. It is NOT a shell — only",
      "those commands run, and each is gated by confirmation and a run budget.",
    );
  }
  if (mcpToolCount > 0) {
    lines.push(
      `You ALSO have ${mcpToolCount} connected MCP tool(s) named mcp__<server>__<tool>`,
      "(e.g. GitHub/Postgres/filesystem). Use them when the task needs capabilities",
      "the file tools don't cover; they run against the user's own connected servers.",
    );
  }
  lines.push(
    "Rules:",
    "- Use paths RELATIVE to the sandbox root. Paths that escape the root are rejected.",
    "- Investigate with read_file/list_directory/search_code before editing.",
    "- Prefer apply_edit for surgical changes; old_string must be an exact, unique match.",
    allowRun
      ? "- The only way to run anything is run_command with an allowlisted command — there is no shell; never claim to run other commands."
      : "- There is no shell. Do not claim to run commands.",
    "- When the task is complete, stop calling tools and give a short summary of what you changed.",
  );
  return lines.join("\n");
}

/** An interactive y/N confirm gate over stdin/stdout. Replaced by an auto-yes
 *  gate when --yes is set, and injectable in tests. Default is NO. Handles both
 *  file writes (a diff preview) and run_command (the argv preview). */
function interactiveConfirm(): ConfirmWrite {
  return async ({ toolName, path, diff }) => {
    const isRun = toolName === RUN_COMMAND_TOOL_NAME;
    if (isRun) {
      console.error(chalk.yellow(`\n▶ ${toolName} wants to run:`));
      console.error(chalk.bold(diff));
    } else {
      console.error(chalk.yellow(`\n✎ ${toolName} wants to write ${chalk.bold(path)}:`));
      console.error(diff);
    }
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
      const prompt = isRun ? "Run this command? [y/N] " : "Apply this change? [y/N] ";
      const answer = (await rl.question(chalk.bold(prompt))).trim().toLowerCase();
      return answer === "y" || answer === "yes";
    } finally {
      rl.close();
    }
  };
}

export async function runAgent(task: string, options?: AgentOptions): Promise<void> {
  if (!task || !task.trim()) {
    console.error(chalk.red("A task is required: zintus agent \"<task>\""));
    process.exit(1);
  }

  let sandbox;
  try {
    sandbox = createSandbox(options?.root);
  } catch (error) {
    console.error(chalk.red(error instanceof Error ? error.message : String(error)));
    process.exit(1);
    return;
  }

  const storedKeys = await listKeys();
  if (storedKeys.length === 0) {
    console.error(
      chalk.dim("No API keys configured — run `zintus setup` to add free providers."),
    );
  }

  const maxRounds = Math.min(
    Math.max(1, options?.maxRounds ?? DEFAULT_AGENT_ROUNDS),
    MAX_AGENT_ROUNDS_CAP,
  );

  // The write gate. --yes bypasses it (with a loud warning); otherwise every
  // mutation requires an interactive y/N (default NO).
  const confirm: ConfirmWrite = options?.yes
    ? async ({ toolName, path }) => {
        const verb = toolName === RUN_COMMAND_TOOL_NAME ? "running" : "applying";
        console.error(
          chalk.yellow(`⚠ --yes: auto-${verb} ${toolName} → ${path} (gate bypassed)`),
        );
        return true;
      }
    : interactiveConfirm();

  const ctx: AgentToolContext = {
    sandbox,
    confirm,
    budget: { used: 0, max: DEFAULT_MUTATION_BUDGET },
    // run_command is OFF unless explicitly opted in via --allow-run.
    run: options?.allowRun
      ? { allow: true, budget: { used: 0, max: DEFAULT_RUN_BUDGET } }
      : undefined,
  };

  console.error(chalk.cyan(`🤖 agent · sandbox root: ${chalk.bold(sandbox.root)}`));
  if (options?.yes) {
    console.error(chalk.yellow("⚠ --yes: write confirmation gate is DISABLED for this run."));
  }
  if (options?.allowRun) {
    console.error(
      chalk.yellow("⚠ --allow-run: the agent may run allowlisted verification commands (gated)."),
    );
  }

  // Connect the configured MCP servers IN-PROCESS (the CLI is Bun, it hosts the
  // MCP SDK directly). Failures are surfaced honestly and that server is
  // skipped; every connected client is disconnected in the finally below.
  let mcp: AgentMcpToolset | null = null;
  if (!options?.noMcp) {
    const { servers, missing } = selectAgentMcpServers(await loadMcpServers(), {
      only: options?.mcp,
    });
    for (const name of missing) {
      console.error(chalk.yellow(`⚠ no configured MCP server named "${name}" — skipping`));
    }
    if (servers.length > 0) {
      console.error(
        chalk.yellow(
          "⚠ MCP servers run the USER'S OWN local processes from your config (same posture as file writes).",
        ),
      );
      mcp = await connectAgentMcp(servers, {
        onConnect: ({ server, toolCount }) =>
          console.error(
            chalk.cyan(`🔌 MCP connected: ${chalk.bold(server)} (${toolCount} tool(s))`),
          ),
        onConnectError: ({ server, message }) =>
          console.error(
            chalk.yellow(`⚠ MCP server "${server}" failed to connect — skipped: ${message}`),
          ),
      });
    }
  }

  const mcpToolCount = mcp?.size ?? 0;
  // Only offer run_command to the model when the user opted in (--allow-run);
  // otherwise the tool is both hidden AND refused at execution.
  const fileToolDefinitions = options?.allowRun
    ? AGENT_TOOL_DEFINITIONS
    : AGENT_TOOL_DEFINITIONS.filter((d) => d.name !== RUN_COMMAND_TOOL_NAME);
  const toolDefinitions = [...fileToolDefinitions, ...(mcp?.definitions ?? [])];

  const spinner = ora("Routing request").start();
  const config = await loadConfig();
  const engine = createAppEngine(config);

  try {
    const initialMessages: ChatMessage[] = [
      {
        role: "user",
        content: `${buildSystemPreamble(sandbox.root, mcpToolCount, options?.allowRun ?? false)}\n\n---\n\nTask:\n${task}`,
      },
    ];

    let firstRound = true;
    const { rounds } = await runAgentToolLoop(initialMessages, {
      maxRounds,
      route: async (messages) => {
        if (!firstRound) spinner.start("Routing tool follow-up");
        return engine.routeAndStream({
          messages,
          mode: config.contextMode,
          tools: toolDefinitions,
        });
      },
      // Route MCP calls to the in-process MCP clients; everything else to the
      // sandboxed file executor. Both feed back into the SAME bounded loop.
      execute: (call) =>
        mcp && isMcpAgentTool(call.name)
          ? mcp.execute({
              id: call.id,
              name: call.name,
              arguments: call.arguments,
            })
          : executeAgentToolCall(
              { id: call.id, name: call.name, arguments: call.arguments },
              ctx,
            ),
      onRouted: async (turn) => {
        const provider = (await engine.getProviderStatus()).find(
          (p) => p.id === turn.providerId,
        );
        spinner.succeed(
          `Routed to ${chalk.cyan(provider?.name ?? turn.providerId)} · trace ${chalk.dim(turn.traceId.slice(0, 8))}`,
        );
        firstRound = false;
      },
      onChunk: (chunk) => process.stdout.write(chunk),
      onTurnEnd: () => process.stdout.write("\n"),
      onToolCalls: (calls) => {
        console.error(chalk.cyan(`\n${calls.length} tool call(s):`));
        for (const call of calls) {
          if (isMcpAgentTool(call.name)) {
            // Secret-safe: show the parameter NAMES only, never their values.
            const argNames = Object.keys(call.arguments ?? {}).join(", ");
            console.error(`  ${chalk.blue("[mcp]")} ${chalk.bold(call.name)}(${argNames})`);
            continue;
          }
          const tag =
            call.name === RUN_COMMAND_TOOL_NAME
              ? chalk.red("[run]")
              : isMutatingTool(call.name)
                ? chalk.magenta("[write]")
                : chalk.dim("[read]");
          console.error(
            `  ${tag} ${chalk.bold(call.name)}(${JSON.stringify(call.arguments)})`,
          );
        }
      },
      onToolResult: (r, call) => {
        const label = r.isError ? chalk.yellow("error") : chalk.green("ok");
        // For MCP results show only a size/error summary — the body may carry
        // secrets. File-tool results (structured JSON) print as before.
        const summary = isMcpAgentTool(call.name)
          ? r.isError
            ? r.content.slice(0, 200)
            : `${r.content.length} char(s)`
          : r.content.slice(0, 400);
        console.error(`  🔧 ${chalk.bold(call.name)} → ${label} ${chalk.dim(summary)}`);
      },
      onStopped: (max) =>
        console.error(chalk.yellow(`⚠ agent loop stopped after ${max} rounds (bounded)`)),
    });

    console.error(
      chalk.dim(
        `\nDone in ${rounds} round(s) · ${ctx.budget.used} mutation(s) applied · sandbox ${sandbox.root}`,
      ),
    );
  } catch (error) {
    spinner.fail("Agent run failed");
    console.error(chalk.red(normalizeChatError(error)));
    // Disconnect MCP before exiting so no spawned child process leaks.
    await mcp?.disconnect();
    process.exit(1);
  } finally {
    // Lifecycle: tear down every connected MCP server on every exit path.
    await mcp?.disconnect();
  }
}
