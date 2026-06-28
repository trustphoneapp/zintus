import { readFileSync } from "node:fs";
import chalk from "chalk";
import ora from "ora";
import { tryGitDiff } from "@zintus/context-compiler";
import { listKeys } from "@zintus/keychain";
import { estimateCostUsd } from "@zintus/providers";
import type {
  ChatMessage,
  ContextMode,
  ImageContentBlock,
  RouteUsage,
  ToolDefinition,
} from "@zintus/types";
import { createAppEngine } from "../lib/router.js";
import { loadConfig } from "../lib/config.js";
import { getActiveProject } from "../lib/projects.js";
import {
  BUILTIN_TOOL_DEFINITIONS,
  runBuiltinToolLoop,
} from "../lib/builtin-tools.js";
import {
  buildChatContent,
  formatTurnSummary,
  loadImages,
  normalizeChatError,
} from "./chat-content.js";
import {
  buildChatMcpConfig,
  formatMcpToolEvent,
  gatewayUrl,
  loadMcpServers,
  parseMcpToolEvent,
  type ChatMcpConfig,
} from "../lib/mcp-config.js";

/** Load + minimally validate a `ToolDefinition[]` from a JSON file. Throws a
 *  clear, user-facing error rather than a raw parse stack. */
function loadTools(path: string): ToolDefinition[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(`Could not read --tools file: ${path}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`--tools file is not valid JSON: ${path}`);
  }
  // `parameters` must be a PLAIN object: a JSON Schema. `typeof x === "object"`
  // alone is true for `null` and arrays, which would pass a malformed tool
  // through to the provider — reject both explicitly.
  const isPlainObject = (v: unknown): boolean =>
    typeof v === "object" && v !== null && !Array.isArray(v);
  if (
    !Array.isArray(parsed) ||
    !parsed.every(
      (t) =>
        t &&
        typeof t === "object" &&
        typeof (t as { name?: unknown }).name === "string" &&
        typeof (t as { description?: unknown }).description === "string" &&
        isPlainObject((t as { parameters?: unknown }).parameters),
    )
  ) {
    throw new Error(
      "--tools file must be a JSON array of { name, description, parameters } objects",
    );
  }
  return parsed as ToolDefinition[];
}

export interface ChatOptions {
  mode?: ContextMode;
  /** Index this workspace for codebase-aware context. When the flag is passed
   *  without a value, defaults to process.cwd(). Off by default. */
  workspaceDir?: string;
  /** Include the current git diff (best-effort) as turn context. */
  diff?: boolean;
  /** Image file paths to attach (repeatable `--image`, max 4). Processed
   *  locally into vision content blocks before routing. */
  images?: string[];
  /** Path to a JSON file holding a `ToolDefinition[]` array. When set, the
   *  request requires a tool-capable model and those definitions are offered. */
  toolsFile?: string;
  /** Enable the CLI's built-in, executable tools (calculator, current_datetime,
   *  random_number) — set by a bare `--tools` (no file). The CLI then runs the
   *  real execute→feed-back loop, mirroring the web chat. */
  builtinTools?: boolean;
  /** MCP toggle for this turn. `undefined` = auto (on when servers are enabled);
   *  `false` (`--no-mcp`) forces it off; `true` (`--mcp`) forces it on. When
   *  active the chat runs through the local gateway, which hosts the servers. */
  mcp?: boolean;
}

/** One streamed SSE chunk from the gateway chat endpoint, narrowed to the fields
 *  the MCP path reads. Structurally a superset of `GatewayMcpChunk`, so it passes
 *  straight to `parseMcpToolEvent`. */
interface ChatStreamChunk {
  type?: string;
  provider?: string;
  model?: string;
  error?: { message?: string };
  choices?: Array<{
    delta?: {
      content?: string;
      tool_calls?: Array<{
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
  tool_call_id?: string;
  is_error?: boolean;
  content?: string;
}

/**
 * MCP chat path — runs through the LOCAL gateway (`zintus serve`), the only
 * component that hosts MCP. Posts the configured servers in the request body;
 * the gateway connects them, runs the bounded tool loop SERVER-SIDE, and streams
 * `mcp_tool_call` / `mcp_tool_result` events alongside the answer text. The CLI
 * only DISPLAYS them — it never executes a tool and no MCP data touches the
 * relay. Honest, base64-free errors on an offline gateway or a refused server.
 */
async function runMcpChat(
  prompt: string,
  mcp: ChatMcpConfig,
  options: ChatOptions | undefined,
  project: { instructions?: string } | null,
): Promise<void> {
  const userText = project?.instructions
    ? `${project.instructions}\n\n---\n\n${prompt}`
    : prompt;

  const spinner = ora(
    `Routing via gateway with ${mcp.servers.length} MCP server${mcp.servers.length === 1 ? "" : "s"}`,
  ).start();

  let response: Response;
  try {
    response = await fetch(`${gatewayUrl()}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: userText }],
        stream: true,
        mode: options?.mode,
        mcp,
      }),
    });
  } catch {
    spinner.fail("Couldn't reach the gateway");
    console.error(
      chalk.red("Start it with `zintus serve` (it hosts your MCP servers), then retry."),
    );
    process.exit(1);
  }

  if (!response.ok || !response.body) {
    const body = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    spinner.fail("Request failed");
    console.error(
      chalk.red(body?.error?.message ?? `Gateway error ${response.status}`),
    );
    process.exit(1);
  }

  spinner.succeed("Streaming (MCP tools run server-side on your gateway)");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let printedAnswer = false;
  let providerLabel: string | undefined;
  let model: string | undefined;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r\n|\r|\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let chunk: ChatStreamChunk;
        try {
          chunk = JSON.parse(payload) as ChatStreamChunk;
        } catch {
          continue;
        }
        if (chunk.error?.message) {
          process.stdout.write("\n");
          console.error(chalk.red(chunk.error.message));
          process.exit(1);
        }

        // MCP tool-loop frames first: they reuse the tool-call delta shape, so
        // they must be peeled off before we treat the chunk as answer text.
        const event = parseMcpToolEvent(chunk);
        if (event) {
          const text = formatMcpToolEvent(event);
          const colored =
            event.kind === "call"
              ? chalk.cyan(text)
              : event.ok
                ? chalk.green(text)
                : chalk.yellow(text);
          // Keep tool activity on stderr so piping the answer stays clean.
          console.error(colored);
          continue;
        }

        if (chunk.type === "metadata") {
          providerLabel = chunk.provider ?? providerLabel;
          model = chunk.model ?? model;
          continue;
        }

        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) {
          printedAnswer = true;
          process.stdout.write(delta);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (printedAnswer) {
    process.stdout.write("\n");
  }
  if (providerLabel) {
    console.error(
      chalk.dim(`${providerLabel}${model ? ` · ${model}` : ""}`),
    );
  }
}

export async function runChat(
  prompt: string,
  options?: ChatOptions,
): Promise<void> {
  // Zero-config nudge: if no keys are stored, point at the guided wizard. We
  // still proceed (a local Ollama may serve), so this is a hint, not a hard stop.
  const storedKeys = await listKeys();
  if (storedKeys.length === 0) {
    console.error(
      chalk.dim("No API keys configured — run `zintus setup` to add free providers."),
    );
  }

  // Active project (if any): its instructions lead the chat and its default
  // provider is preferred. Surfaced on stderr so it's never a silent injection.
  const project = await getActiveProject();
  if (project) {
    console.error(chalk.dim(`📁 project: ${project.name}`));
  }

  // MCP: when servers are enabled (and not `--no-mcp`), or `--mcp` is forced,
  // the chat MUST run through the local gateway — the in-process engine can't
  // host MCP. This is a separate, text-only path; the normal (non-MCP) chat
  // below is unchanged. `--mcp` with nothing enabled is an honest no-op hint.
  if (options?.mcp !== false) {
    const mcp = buildChatMcpConfig(await loadMcpServers());
    if (mcp) {
      await runMcpChat(prompt, mcp, options, project);
      return;
    }
    if (options?.mcp === true) {
      console.error(
        chalk.yellow(
          "No enabled MCP servers — add one with `zintus mcp add` (running without MCP).",
        ),
      );
    }
  }
  // Only pin the project's provider if it's actually keyed (or a local runtime):
  // forcing a keyless provider disables failover and fails every request.
  const keyed = new Set(storedKeys.map((k) => k.provider));
  const forcedProvider =
    project?.defaultProvider &&
    (keyed.has(project.defaultProvider) ||
      project.defaultProvider === "ollama" ||
      project.defaultProvider === "lmstudio")
      ? project.defaultProvider
      : undefined;
  if (project?.defaultProvider && !forcedProvider) {
    console.error(
      chalk.yellow(
        `  (project provider ${project.defaultProvider} has no key — using auto routing)`,
      ),
    );
  }

  // Process any --image attachments BEFORE routing. This is local, fail-fast
  // work (magic-byte mime + EXIF strip via @zintus/media's Node path) and never
  // touches the network. Image bytes/base64 are never printed; on failure we
  // surface a clear, base64-free message and exit non-zero.
  let imageBlocks: ImageContentBlock[] = [];
  if (options?.images && options.images.length > 0) {
    try {
      imageBlocks = await loadImages(options.images);
    } catch (error) {
      console.error(chalk.red(normalizeChatError(error)));
      process.exit(1);
    }
  }
  const hasImages = imageBlocks.length > 0;

  const spinner = ora("Routing request").start();
  const config = await loadConfig();
  const engine = createAppEngine(config, {
    workspaceDir: options?.workspaceDir,
  });

  try {
    // The working git diff is included by default (opt-out via --no-diff). It's
    // best-effort: outside a repo or with no changes tryGitDiff returns nothing
    // and we route without diff context — no noise, no empty thread.
    //
    // With images attached we DELIBERATELY skip diff/codebase context: the
    // engine compiles threaded context from the user turn's TEXT only
    // (newUserMessage is a string), so routing an image request through the
    // compile path would silently drop the image blocks. Sending the message
    // verbatim keeps the vision blocks intact (and the router enforces a
    // vision-capable provider). Image queries are standalone anyway.
    let diffText: string | undefined;
    if (!hasImages && options?.diff !== false) {
      const diff = await tryGitDiff(process.cwd());
      if (diff && diff.trim().length > 0) {
        diffText = diff;
      }
    }

    // The engine only compiles codebase/diff context for threaded requests, so
    // when context is actually available we create a thread up front and pass
    // its id (the engine's own auto-thread is created too late to compile).
    const useContext =
      !hasImages && (Boolean(options?.workspaceDir) || Boolean(diffText));
    const threadId = useContext
      ? engine.createThread(prompt.slice(0, 48)).id
      : undefined;
    if (diffText) {
      spinner.text = "Routing request (with working git diff)";
    }

    // Fold project instructions into the USER turn rather than a system message:
    // when a thread/diff context compiles, the engine rebuilds messages and only
    // re-reads the last user message, so a leading system message would be
    // silently dropped. Folding into the user content survives both paths.
    const userText = project?.instructions
      ? `${project.instructions}\n\n---\n\n${prompt}`
      : prompt;
    // Text prompt FIRST, then the image blocks in order. With no images this is
    // just the plain string (unchanged text-only shape).
    const userContent = buildChatContent(userText, imageBlocks);
    // `--tools <file>` offers the file's custom definitions; a bare `--tools`
    // offers the CLI's built-in, EXECUTABLE tools. Either way, when the model
    // emits tool calls we run the bounded execute→feed-back loop below — only
    // built-in tool names actually run; an unknown tool is fed back as an honest
    // error result (never silently executed).
    const tools = options?.toolsFile
      ? loadTools(options.toolsFile)
      : options?.builtinTools
        ? BUILTIN_TOOL_DEFINITIONS
        : undefined;
    const toolsEnabled = Boolean(tools);
    // Captured when the winning provider's stream completes — the real measured
    // token counts for this turn (never fabricated). Mirrors the gateway's
    // `onUsage`-fed metadata frame. Reflects the FINAL routed turn.
    let usage: RouteUsage | undefined;

    // Run the bounded execute→feed-back loop. With tools OFF this routes exactly
    // once and prints the answer (path unchanged). With tools ON, each round
    // routes the growing conversation, executes the built-in tool calls locally,
    // feeds the results back as tool_result turns, and re-routes — bounded by
    // MAX_TOOL_ROUNDS — until the model returns a final answer. Tool rounds run
    // STATELESS (no threadId) for determinism, mirroring the web chat.
    const initialMessages: ChatMessage[] = [
      { role: "user", content: userContent },
    ];
    let firstRound = true;
    const { finalResult: result } = await runBuiltinToolLoop(initialMessages, {
      route: async (messages) => {
        if (!firstRound) spinner.start("Routing tool follow-up");
        return engine.routeAndStream({
          messages,
          provider: forcedProvider,
          mode: options?.mode ?? config.contextMode,
          // Tool rounds run stateless; the non-tools path keeps thread/diff context.
          threadId: toolsEnabled ? undefined : threadId,
          diffText: toolsEnabled ? undefined : diffText,
          tools,
          onUsage: (u) => {
            usage = u;
          },
        });
      },
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
          console.error(
            `  ${chalk.bold(call.name)}(${JSON.stringify(call.arguments)})  ${chalk.dim(call.id)}`,
          );
        }
      },
      onToolResult: (r, call) => {
        const label = r.isError ? chalk.yellow("error") : chalk.green("result");
        console.error(
          `  🔧 ${chalk.bold(call.name)} → ${label} ${chalk.dim(r.content)}`,
        );
      },
      onStopped: (max) =>
        console.error(
          chalk.yellow(`⚠ tool loop stopped after ${max} rounds`),
        ),
    });

    const provider = (await engine.getProviderStatus()).find(
      (p) => p.id === result.providerId,
    );

    // Post-turn transparency: provider · model, the route-reason headline, and
    // the REAL per-turn facts (tokens, cost estimate, quota). Everything here is
    // measured or reported by the engine — absent fields are omitted, the quota
    // denominator is the provider's real cap or "unknown" (never a fabricated
    // 1,000,000), and cost is an estimate ($0 on free tiers).
    const costUsd = usage
      ? estimateCostUsd(
          result.providerId,
          usage.model ?? result.model,
          usage.inputTokens,
          usage.outputTokens,
        )
      : undefined;
    const summary = formatTurnSummary({
      providerLabel: provider?.name ?? result.providerId,
      model: result.model,
      routeReason: result.routeReason,
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
      costUsd,
      quotaUsed: provider?.tokensToday,
      // tokensLimit is undefined when the engine has no reported daily cap — pass
      // it through as null so the renderer prints "limit unknown", not a guess.
      quotaLimit: provider?.tokensLimit ?? null,
    });
    console.error(chalk.dim(summary));

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
    // Normalize the router's bare `unsupported_capability` into the honest
    // vision-capability error + provider suggestions (other errors pass through).
    console.error(chalk.red(normalizeChatError(error)));
    process.exit(1);
  }
}
