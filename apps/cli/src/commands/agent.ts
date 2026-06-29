import { createInterface } from "node:readline/promises";
import chalk from "chalk";
import ora from "ora";
import { listKeys } from "@zintus/keychain";
import { embedBatch, embeddingMode } from "@zintus/memory";
import type {
  AppConfig,
  ChatMessage,
  RoutingStrategy,
  ToolDefinition,
} from "@zintus/types";
import { createAppEngine } from "../lib/router.js";
import { loadConfig } from "../lib/config.js";
import {
  AGENT_TOOL_DEFINITIONS,
  DEFAULT_AGENT_ROUNDS,
  DEFAULT_MUTATION_BUDGET,
  DEFAULT_RUN_BUDGET,
  MAX_AGENT_ROUNDS_CAP,
  RUN_COMMAND_TOOL_NAME,
  UPDATE_PLAN_TOOL_NAME,
  type AgentContextConfig,
  type AgentLoopHandlers,
  type AgentToolContext,
  type ChangeLogEntry,
  type ConfirmWrite,
  type PlanStep,
  type VerifyOutcome,
  createContextStore,
  createPlanState,
  createSandbox,
  executeAgentToolCall,
  isMutatingTool,
  planStatusSummary,
  runAgentToolLoop,
  runVerifyReviseController,
  summarizeChanges,
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
  /** The verify command the B3 gate runs deterministically after edits (must be on
   *  the run_command allowlist). Only used when allowRun is set. Default "bun run test". */
  verifyCommand?: string;
}

/** The DEFAULT project verify command the B3 gate runs (allowlisted). */
export const DEFAULT_VERIFY_COMMAND = "bun run test";

/**
 * B2 — the per-call routing strategy SEAM. Builds the RouteRequest for one agent turn,
 * threading a routing `strategy` WITHOUT hardcoding a provider/model — so the router
 * still picks the best/cheapest model across all providers WITHIN the chosen tier.
 * The main writer loop passes the user's configured strategy (honest: we never
 * silently override an explicit "fastest" with "quality"); internal/auxiliary callers
 * (e.g. a cheap triage/explorer) can request `"economy"`. The chosen strategy is
 * already surfaced in the engine's route-reason line.
 */
export function buildAgentRouteRequest(opts: {
  messages: ChatMessage[];
  mode: AppConfig["contextMode"];
  tools: ToolDefinition[];
  strategy: RoutingStrategy | "weighted";
}): {
  messages: ChatMessage[];
  mode: AppConfig["contextMode"];
  tools: ToolDefinition[];
  strategy: RoutingStrategy | "weighted";
} {
  return {
    messages: opts.messages,
    mode: opts.mode,
    tools: opts.tools,
    strategy: opts.strategy,
  };
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
    "You have these tools: read_file, list_directory, search_code, find_relevant_code",
    "(read-only) and write_file, apply_edit (mutating, each gated by user confirmation).",
    "find_relevant_code does relevance retrieval for a natural-language query (semantic",
    "when an embedder is configured, else a key-free lexical ranking) — use it to locate",
    "WHERE a concept lives; use search_code when you know an exact substring.",
    "You ALSO have update_plan: BEFORE you start editing, call it once with a short",
    "ordered list of steps for this task. As you work, call it again to mark a step",
    "'in_progress' when you begin it and 'done' when you finish it (re-send the full",
    "list each time). The plan is yours and is shown to the user; it edits nothing.",
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
    "- Investigate with find_relevant_code/search_code/read_file/list_directory before editing.",
    "- Prefer apply_edit for surgical changes; old_string must be an exact, unique match.",
    allowRun
      ? "- The only way to run anything is run_command with an allowlisted command — there is no shell; never claim to run other commands."
      : "- There is no shell. Do not claim to run commands.",
    "- When the task is complete, stop calling tools and give a short summary of what you changed.",
  );
  return lines.join("\n");
}

/** Render the model's plan with per-step status icons, for terminal display. The
 *  plan is the MODEL'S — we print exactly the steps/statuses it set, nothing more. */
function renderPlan(steps: PlanStep[]): string {
  const lines = [chalk.cyan(`\n📋 Plan (${planStatusSummary(steps)}):`)];
  steps.forEach((s, i) => {
    const n = `${i + 1}.`;
    if (s.status === "done") {
      lines.push(`  ${chalk.green("✔")} ${chalk.dim(`${n} ${s.text}`)}`);
    } else if (s.status === "in_progress") {
      lines.push(`  ${chalk.yellow("◐")} ${chalk.bold(`${n} ${s.text}`)}`);
    } else {
      lines.push(`  ${chalk.dim("○")} ${n} ${s.text}`);
    }
  });
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

  // find_relevant_code ranking: use REAL semantic embeddings only when a genuine
  // embedder is configured (Ollama). Otherwise leave `embed` undefined so the
  // tool uses its key-free lexical fallback rather than a degraded keyword-hash
  // embedding masquerading as semantic search.
  const semanticEmbed =
    embeddingMode() === "ollama" ? (texts: string[]) => embedBatch(texts) : undefined;
  // The model's plan + the per-file change log live in the run context so the
  // update_plan tool and gatedWrite can record into them; the CLI renders both.
  const changeLog: ChangeLogEntry[] = [];
  // B1: the CCR store backs context compaction (evicted tool_results land here) AND
  // the `retrieve` tool (the model pulls them back by hash). One store per run,
  // closed in the finally below.
  const ccrStore = createContextStore();
  const contextConfig: AgentContextConfig = {
    store: ccrStore,
    sessionId: `agent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  };
  const ctx: AgentToolContext = {
    sandbox,
    confirm,
    budget: { used: 0, max: DEFAULT_MUTATION_BUDGET },
    plan: createPlanState(),
    changeLog,
    context: contextConfig,
    // run_command is OFF unless explicitly opted in via --allow-run.
    run: options?.allowRun
      ? { allow: true, budget: { used: 0, max: DEFAULT_RUN_BUDGET } }
      : undefined,
    semantic: {
      embed: semanticEmbed,
      onIndexBuilt: ({ mode, filesIndexed, chunksIndexed }) =>
        console.error(
          chalk.dim(
            `🔎 find_relevant_code index ready (${mode} ranking · ${filesIndexed} file(s), ${chunksIndexed} chunk(s))`,
          ),
        ),
    },
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
    // The last allowlisted verification command's pass/fail, surfaced in the
    // end-of-run summary (honest: only set when run_command actually ran).
    let lastVerification: { command: string; pass: boolean } | null = null;
    // B2: one place that builds a routed turn, threading a routing STRATEGY (the
    // moat) without ever hardcoding a provider/model. The writer uses the user's
    // configured strategy; the optional override is the seam an internal/cheap call
    // (triage/explorer) uses to request "economy".
    const routeTurn = (
      messages: ChatMessage[],
      strategy?: RoutingStrategy | "weighted",
    ) =>
      engine.routeAndStream(
        buildAgentRouteRequest({
          messages,
          mode: config.contextMode,
          tools: toolDefinitions,
          strategy: strategy ?? config.routingStrategy,
        }),
      );
    type AgentTurn = Awaited<ReturnType<typeof engine.routeAndStream>>;
    const loopHandlers: AgentLoopHandlers<AgentTurn> = {
      maxRounds,
      route: async (messages) => {
        if (!firstRound) spinner.start("Routing tool follow-up");
        return routeTurn(messages);
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
              : call.name === UPDATE_PLAN_TOOL_NAME
                ? chalk.blue("[plan]")
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
        // When the model (re)sets its plan, render the updated plan + statuses so
        // a multi-step run stays legible. ctx.plan holds the model's own steps.
        if (call.name === UPDATE_PLAN_TOOL_NAME && !r.isError && ctx.plan?.steps.length) {
          console.error(renderPlan(ctx.plan.steps));
        }
        // Capture the final verification command's pass/fail for the summary.
        if (call.name === RUN_COMMAND_TOOL_NAME && !r.isError) {
          try {
            const parsed = JSON.parse(r.content) as Record<string, unknown>;
            if (!parsed.declined && typeof parsed.exitCode !== "undefined") {
              lastVerification = {
                command: String(parsed.command ?? ""),
                pass: parsed.exitCode === 0,
              };
            }
          } catch {
            // Non-JSON / unparseable — leave verification status unchanged.
          }
        }
      },
      onStopped: (max) =>
        console.error(chalk.yellow(`⚠ agent loop stopped after ${max} rounds (bounded)`)),
      // B1: compact the conversation between rounds once it crosses the token budget,
      // printing an honest dim line of tokens saved + tool_results evicted.
      context: contextConfig,
      onCompact: (r) =>
        console.error(
          chalk.dim(
            `🗜 compacted context (saved ${r.savedTokens} tokens, ${r.evicted} result(s) evicted)`,
          ),
        ),
    };

    let { rounds, convo } = await runAgentToolLoop(initialMessages, loopHandlers);

    // B3: deterministic test-gated verify→revise gate. Only when --allow-run is on AND
    // the model actually edited files this run. The controller runs the project verify
    // command through the EXISTING run_command machinery (allowlist/budget/confirm
    // intact); on a non-zero exit it feeds the failure back and lets the model revise,
    // bounded by MAX_REVISE rounds, then surfaces an honest failure — never a fake PASS.
    if (options?.allowRun && ctx.run) {
      const verifyCommand = options?.verifyCommand ?? DEFAULT_VERIFY_COMMAND;
      const runVerify = async (): Promise<VerifyOutcome | null> => {
        const result = await executeAgentToolCall(
          {
            id: `verify_${Date.now().toString(36)}`,
            name: RUN_COMMAND_TOOL_NAME,
            arguments: { command: verifyCommand },
          },
          ctx,
        );
        if (result.isError) {
          console.error(
            chalk.dim(
              `verify could not run (${verifyCommand}): ${result.content.slice(0, 160)}`,
            ),
          );
          return null;
        }
        try {
          const parsed = JSON.parse(result.content) as Record<string, unknown>;
          if (parsed.declined || typeof parsed.exitCode === "undefined") return null;
          return {
            command: String(parsed.command ?? verifyCommand),
            pass: parsed.exitCode === 0,
            code: parsed.exitCode as number | null,
            stdout: typeof parsed.stdout === "string" ? parsed.stdout : "",
            stderr: typeof parsed.stderr === "string" ? parsed.stderr : "",
          };
        } catch {
          return null;
        }
      };
      const controlled = await runVerifyReviseController(convo, {
        editsMade: () => changeLog.length > 0,
        runVerify,
        onVerify: (o) => {
          lastVerification = { command: o.command, pass: o.pass };
        },
        onRevise: (attempt, max) =>
          console.error(
            chalk.dim(
              `↻ verification failed — asking the model to revise (attempt ${attempt}/${max})`,
            ),
          ),
        onExhausted: (o, revisions) =>
          console.error(
            chalk.red(
              `⚠ verification still failing after ${revisions} revision(s): ${o.command} — surfaced honestly (no success claimed)`,
            ),
          ),
        revise: async (current, failure) => {
          const withFailure: ChatMessage[] = [
            ...current,
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text:
                    `The verification command \`${failure.command}\` FAILED (exit ${failure.code ?? "null"}). ` +
                    "Diagnose the cause from the output below and FIX it, then stop.\n\n" +
                    `stdout:\n${failure.stdout ?? ""}\n\nstderr:\n${failure.stderr ?? ""}`,
                },
              ],
            },
          ];
          const r = await runAgentToolLoop(withFailure, loopHandlers);
          return { convo: r.convo, rounds: r.rounds };
        },
      });
      rounds += controlled.reviseRounds;
    }

    // End-of-run change summary: the files ACTUALLY mutated through the loop,
    // with per-file write counts, plus the final verification result if one ran.
    // Only writes that hit disk are listed — we never claim an un-applied change.
    const summary = summarizeChanges(changeLog);
    if (summary.files.length > 0) {
      console.error(
        chalk.cyan(
          `\n📝 Changes (${summary.mutations} mutation(s) across ${summary.files.length} file(s)):`,
        ),
      );
      for (const f of summary.files) {
        const times = f.writes > 1 ? chalk.dim(` ×${f.writes}`) : "";
        console.error(
          `  ${chalk.green("•")} ${f.path}${times} ${chalk.dim(`(${f.tools.join(", ")})`)}`,
        );
      }
    } else {
      console.error(chalk.dim("\n📝 No files were changed."));
    }
    if (lastVerification) {
      const v = lastVerification as { command: string; pass: boolean };
      const verdict = v.pass ? chalk.green("PASS") : chalk.red("FAIL");
      console.error(`  ${chalk.bold("verify")} ${chalk.dim(v.command)} → ${verdict}`);
    }
    // If the model left a plan, show its final status so a multi-step run closes
    // legibly (the plan is the model's; statuses are exactly what it last set).
    if (ctx.plan && ctx.plan.steps.length > 0) {
      console.error(chalk.dim(`\nFinal plan status: ${planStatusSummary(ctx.plan.steps)}`));
    }

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
    // Close the CCR store opened for context eviction (releases the sqlite handle).
    try {
      ccrStore.close();
    } catch {
      // Already closed / never opened — nothing to release.
    }
  }
}
