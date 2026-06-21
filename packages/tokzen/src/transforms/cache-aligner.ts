// MIT License — see LICENSE file
import { countTokensFast } from "../tokenizer/count.js";
import { getCacheMinTokens, injectAnthropicCacheControl } from "./cache-hints.js";
import type { CompressContext, CompressResult } from "../pipeline/types.js";
import type { AnthropicBlock } from "./cache-hints.js";

// Dynamic content patterns to move to tail section
const ISO_DATE_RE = /\b\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?\b/g;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const TEMPLATE_VAR_RE = /\{\{?\s*\w+\s*\}?\}/g;
const SESSION_TOKEN_RE = /\b(sess[-_]?[0-9a-z]{16,}|tok[-_]?[0-9a-z]{16,}|sk[-_][a-z0-9]{20,})\b/gi;

interface AlignResult {
  staticPrefix: string;
  dynamicTail: string;
  combined: string;
  cacheBlocks?: AnthropicBlock[];
}

function extractDynamic(text: string): { static_: string; dynamic: string[] } {
  const dynamic: string[] = [];

  // Extract dynamic lines (lines containing date/UUID/template/token patterns)
  const lines = text.split("\n");
  const staticLines: string[] = [];
  const dynamicLines: string[] = [];

  for (const line of lines) {
    const isDynamic =
      ISO_DATE_RE.test(line) ||
      UUID_RE.test(line) ||
      TEMPLATE_VAR_RE.test(line) ||
      SESSION_TOKEN_RE.test(line);

    // Reset lastIndex for global regexes
    ISO_DATE_RE.lastIndex = 0;
    UUID_RE.lastIndex = 0;
    TEMPLATE_VAR_RE.lastIndex = 0;
    SESSION_TOKEN_RE.lastIndex = 0;

    if (isDynamic) {
      dynamicLines.push(line);
      dynamic.push(line);
    } else {
      staticLines.push(line);
    }
  }

  return {
    static_: staticLines.join("\n").trim(),
    dynamic,
  };
}

/**
 * Stabilizes the system prompt prefix so that provider KV cache hits across
 * requests. Moves all dynamic content (dates, UUIDs, template vars) to a
 * tail section after a "---" divider.
 */
export function alignCache(
  systemPrompt: string,
  ctx: CompressContext,
): AlignResult & CompressResult {
  const originalTokens = countTokensFast(systemPrompt);

  try {
    const { static_, dynamic } = extractDynamic(systemPrompt);

    const hasDynamic = dynamic.length > 0;
    const dynamicTail = hasDynamic ? dynamic.join("\n") : "";
    const combined = hasDynamic
      ? `${static_}\n---\n${dynamicTail}`
      : static_;

    const minTokens = getCacheMinTokens(ctx.provider, ctx.model);
    const staticTokens = countTokensFast(static_);

    let cacheBlocks: AnthropicBlock[] | undefined;
    if (
      (ctx.provider === "anthropic" || ctx.provider === "gemini") &&
      staticTokens >= minTokens
    ) {
      cacheBlocks = injectAnthropicCacheControl(
        [{ type: "text", text: static_ }],
        ctx.model,
      );
    }

    const compressedTokens = countTokensFast(combined);

    return {
      staticPrefix: static_,
      dynamicTail,
      combined,
      cacheBlocks,
      content: combined,
      originalTokens,
      compressedTokens,
      ratio: originalTokens === 0 ? 1 : compressedTokens / originalTokens,
      transforms: hasDynamic ? ["cache-align"] : [],
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
