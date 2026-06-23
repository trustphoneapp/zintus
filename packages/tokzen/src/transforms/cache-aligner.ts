// MIT License — see LICENSE file
import { countTokensFast } from "../tokenizer/count.js";
import { getCacheMinTokens, injectAnthropicCacheControl } from "./cache-hints.js";
import type { CompressContext, CompressResult } from "../pipeline/types.js";
import type { AnthropicBlock } from "./cache-hints.js";

interface AlignResult {
  /** The cache-stable prefix. Byte-identical to the input prompt. */
  staticPrefix: string;
  /** Retained for API compatibility; always empty now (no reordering). */
  dynamicTail: string;
  /** The prompt to send. Byte-identical to the input — never reordered. */
  combined: string;
  /** Anthropic/Gemini blocks with a cache_control breakpoint at the end. */
  cacheBlocks?: AnthropicBlock[];
}

/**
 * Prepares a system prompt for provider prefix caching WITHOUT rewriting it.
 *
 * Prompt caching is a prefix match: the stable prose must stay byte-identical
 * across requests, with a `cache_control` breakpoint at the end of the stable
 * block. The earlier implementation moved "volatile" lines (dates, UUIDs,
 * template vars) to a tail section — that REORDERS instructions and can change
 * model behavior (e.g. severing "Today is {{date}}." from a rule that depends
 * on it). The correct technique is to leave the prose untouched and place
 * volatile per-request content in a *later* message, never to splice the prose.
 *
 * So this returns the prompt unchanged and, for providers with a prefix cache,
 * emits `cacheBlocks` carrying the breakpoint. Forwarding those blocks to the
 * provider request is a separate plumbing step (the gateway's chat path does
 * not yet carry structured system blocks).
 */
export function alignCache(
  systemPrompt: string,
  ctx: CompressContext,
): AlignResult & CompressResult {
  const originalTokens = countTokensFast(systemPrompt);

  try {
    const minTokens = getCacheMinTokens(ctx.provider, ctx.model);

    let cacheBlocks: AnthropicBlock[] | undefined;
    if (
      (ctx.provider === "anthropic" || ctx.provider === "gemini") &&
      originalTokens >= minTokens
    ) {
      cacheBlocks = injectAnthropicCacheControl(
        [{ type: "text", text: systemPrompt }],
        ctx.model,
      );
    }

    return {
      staticPrefix: systemPrompt,
      dynamicTail: "",
      combined: systemPrompt,
      cacheBlocks,
      // Prompt is unchanged — this transform never grows or shrinks tokens.
      content: systemPrompt,
      originalTokens,
      compressedTokens: originalTokens,
      ratio: 1,
      transforms: cacheBlocks ? ["cache-hint"] : [],
      ccrHashes: [],
      cacheHit: false,
    };
  } catch {
    return {
      staticPrefix: systemPrompt,
      dynamicTail: "",
      combined: systemPrompt,
      content: systemPrompt,
      originalTokens,
      compressedTokens: originalTokens,
      ratio: 1,
      transforms: [],
      ccrHashes: [],
      cacheHit: false,
    };
  }
}
