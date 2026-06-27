import chalk from "chalk";
import ora from "ora";
import { tryGitDiff } from "@zintus/context-compiler";
import { listKeys } from "@zintus/keychain";
import type { ContextMode, ImageContentBlock } from "@zintus/types";
import { createAppEngine } from "../lib/router.js";
import { loadConfig } from "../lib/config.js";
import { getActiveProject } from "../lib/projects.js";
import { buildChatContent, loadImages, normalizeChatError } from "./chat-content.js";

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
    const result = await engine.routeAndStream({
      messages: [{ role: "user", content: userContent }],
      provider: forcedProvider,
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
    // Normalize the router's bare `unsupported_capability` into the honest
    // vision-capability error + provider suggestions (other errors pass through).
    console.error(chalk.red(normalizeChatError(error)));
    process.exit(1);
  }
}
