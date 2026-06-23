// MIT License — see LICENSE file
import { countTokensFast } from "../tokenizer/count.js";
import { alignCache } from "../transforms/cache-aligner.js";
import { routeAndCompress } from "../transforms/content-router.js";
import { manageContext } from "../transforms/context-manager.js";
import { injectRetrieveTool, type ToolDefinition } from "../ccr/tool.js";
import type { CompressContext, CompressResult, Message } from "./types.js";

export interface CompressInput {
  messages: Message[];
  systemPrompt?: string;
  tools?: ToolDefinition[];
}

export interface CompressOutput {
  messages: Message[];
  systemPrompt?: string;
  totalResult: CompressResult;
  /** Enriched tools array (with tokzen_retrieve injected) if CCR was applied. */
  tools?: ToolDefinition[];
}

function mergeResults(results: CompressResult[]): CompressResult {
  const originalTokens = results.reduce((s, r) => s + r.originalTokens, 0);
  const compressedTokens = results.reduce((s, r) => s + r.compressedTokens, 0);
  return {
    content: results.map((r) => r.content).join("\n"),
    originalTokens,
    compressedTokens,
    ratio: originalTokens === 0 ? 1 : compressedTokens / originalTokens,
    transforms: [...new Set(results.flatMap((r) => r.transforms))],
    ccrHashes: [...new Set(results.flatMap((r) => r.ccrHashes))],
    cacheHit: results.some((r) => r.cacheHit),
  };
}

const MIN_COMPRESS_TOKENS = 200;

/**
 * Main compression pipeline:
 * CacheAligner → ContentRouter → ContextManager → CacheHints
 *
 * Rules enforced:
 * - NEVER compress user messages
 * - NEVER compress content under 200 tokens
 * - NEVER throw — returns original on any error
 * - Only apply CCR to messages older than the previous 2 turns
 */
export async function compress(
  input: CompressInput,
  ctx: CompressContext,
): Promise<CompressOutput> {
  try {
    const { messages, systemPrompt } = input;
    const results: CompressResult[] = [];
    let processedSystemPrompt = systemPrompt;

    // Stage 1: CacheAligner on system prompt
    if (systemPrompt && countTokensFast(systemPrompt) >= MIN_COMPRESS_TOKENS) {
      const aligned = alignCache(systemPrompt, ctx);
      processedSystemPrompt = aligned.combined;
      results.push(aligned);
    }

    // Stage 2: ContextManager — rolling window on conversation history
    // Only compress messages older than the previous 2 turns (CCR gate)
    const contextResult = manageContext(messages, ctx, { maxTurns: 8 });
    let processedMessages = contextResult.messages;
    if (contextResult.transforms.length > 0) results.push(contextResult);

    // Stage 3: ContentRouter — compress system + assistant messages only
    // NEVER compress user messages
    const finalMessages: Message[] = [];
    for (const msg of processedMessages) {
      if (msg.role === "user" || msg.role === "tool") {
        finalMessages.push(msg);
        continue;
      }
      if (msg.role === "system" && msg === processedMessages[0]) {
        // System summary marker — skip re-compression
        finalMessages.push(msg);
        continue;
      }
      const tokenCount = countTokensFast(msg.content);
      if (tokenCount < MIN_COMPRESS_TOKENS) {
        finalMessages.push(msg);
        continue;
      }
      try {
        const contentResult = await routeAndCompress(msg.content, ctx);
        finalMessages.push({ ...msg, content: contentResult.content });
        if (contentResult.transforms.length > 0) results.push(contentResult);
      } catch {
        finalMessages.push(msg);
      }
    }

    const totalResult = results.length > 0
      ? mergeResults(results)
      : {
          content: messages.map((m) => m.content).join("\n"),
          originalTokens: countTokensFast(messages.map((m) => m.content).join(" ")),
          compressedTokens: countTokensFast(finalMessages.map((m) => m.content).join(" ")),
          ratio: 1,
          transforms: [],
          ccrHashes: [],
          cacheHit: false,
        };

    // Inject tokzen_retrieve tool if CCR hashes were produced
    const outputTools =
      totalResult.ccrHashes && totalResult.ccrHashes.length > 0
        ? injectRetrieveTool(input.tools)
        : undefined;

    return { messages: finalMessages, systemPrompt: processedSystemPrompt, totalResult, tools: outputTools };
  } catch {
    // NEVER throw — return original on any error
    const originalTokens = countTokensFast(input.messages.map((m) => m.content).join(" "));
    return {
      messages: input.messages,
      systemPrompt: input.systemPrompt,
      totalResult: {
        content: "",
        originalTokens,
        compressedTokens: originalTokens,
        ratio: 1,
        transforms: [],
        ccrHashes: [],
        cacheHit: false,
      },
    };
  }
}
