// MIT License — see LICENSE file
import { countTokensFast } from "../tokenizer/count.js";
import type { ContentType, CompressContext, CompressResult } from "../pipeline/types.js";
import { compressJSON } from "../compressors/json.js";
import { compressCode } from "../compressors/code.js";
import { compressLog } from "../compressors/log.js";
import { compressDiff } from "../compressors/diff.js";
import { compressProse } from "../compressors/prose.js";

const MIN_COMPRESS_TOKENS = 200;

/** Detect content type from content heuristics. Detection order: JSON → diff → log → code → prose. */
export function detectContentType(content: string): ContentType {
  const trimmed = content.trimStart();

  // JSON: starts with { or [
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      JSON.parse(content);
      return "json";
    } catch {
      // Not valid JSON
    }
  }

  // Diff: git diff format
  if (trimmed.startsWith("diff --git") || trimmed.startsWith("@@ -")) {
    return "diff";
  }

  // Log: contains timestamps + log levels
  if (
    /\b(ERROR|WARN|INFO|DEBUG|TRACE|FATAL|CRITICAL)\b/.test(content) &&
    /\d{4}-\d{2}-\d{2}|\[\d+\]|\+\d+ms/.test(content)
  ) {
    return "log";
  }

  // Code: contains programming keywords
  if (
    /\b(function|class|import|export|def|fn|const|let|var|async|await|return|interface|type\s+\w+\s*=)\b/.test(
      content,
    )
  ) {
    return "code";
  }

  // Prose fallback
  if (content.trim().length > 0) return "prose";

  return "unknown";
}

/**
 * Routes a content block to the appropriate compressor based on content type.
 * Skips compression for content under MIN_COMPRESS_TOKENS.
 */
export async function routeAndCompress(
  content: string,
  ctx: CompressContext,
): Promise<CompressResult> {
  const tokenCount = countTokensFast(content);
  const noop = (): CompressResult => ({
    content,
    originalTokens: tokenCount,
    compressedTokens: tokenCount,
    ratio: 1,
    transforms: [],
    ccrHashes: [],
    cacheHit: false,
  });

  if (tokenCount < MIN_COMPRESS_TOKENS) return noop();

  const type = detectContentType(content);

  switch (type) {
    case "json":
      return compressJSON(content, ctx);
    case "diff":
      return compressDiff(content, ctx);
    case "log":
      return compressLog(content, ctx);
    case "code":
      return compressCode(content, ctx);
    case "prose":
      return compressProse(content, ctx);
    case "unknown":
      return noop();
  }
}
