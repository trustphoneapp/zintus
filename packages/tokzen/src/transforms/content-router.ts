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
      // Quota dial: only summarize prose under quota pressure (level 3–4).
      // At high quota (level 1–2) prose is left intact.
      return (ctx.level ?? 4) >= 3 ? compressProse(content, ctx) : noop();
    case "unknown":
      return noop();
  }
}

/** Min tokens before a user/tool message's structured content is compressed.
 *  Higher than MIN_COMPRESS_TOKENS so short conversational messages stay verbatim. */
export const USER_CONTENT_MIN_TOKENS = 500;

/** Structured content worth compressing inside user/tool messages. Prose is
 *  excluded on purpose — a user's actual question must never be summarized away. */
const USER_COMPRESSIBLE: ReadonlySet<ContentType> = new Set([
  "json",
  "code",
  "log",
  "diff",
]);

/**
 * Compress large STRUCTURED content a user (or tool) pasted, while preserving the
 * surrounding conversational text. Compresses each fenced ```block``` over the
 * threshold; with no fences, compresses the whole message only when it is itself
 * large AND structured (code/json/log/diff). Returns the original otherwise.
 */
export async function compressUserContent(
  content: string,
  ctx: CompressContext,
  minTokens = USER_CONTENT_MIN_TOKENS,
): Promise<CompressResult> {
  const totalTokens = countTokensFast(content);
  const noop: CompressResult = {
    content,
    originalTokens: totalTokens,
    compressedTokens: totalTokens,
    ratio: 1,
    transforms: [],
    ccrHashes: [],
    cacheHit: false,
  };

  // 1) Fenced blocks: compress each large block, keep surrounding prose verbatim.
  const blocks = [...content.matchAll(/```([\w.+-]*)\n([\s\S]*?)```/g)];
  if (blocks.length > 0) {
    const sub: CompressResult[] = [];
    let out = "";
    let last = 0;
    for (const m of blocks) {
      const idx = m.index ?? 0;
      out += content.slice(last, idx);
      const body = m[2] ?? "";
      if (countTokensFast(body) >= minTokens) {
        const r = await routeAndCompress(body, ctx);
        sub.push(r);
        out += "```" + (m[1] ?? "") + "\n" + r.content + "\n```";
      } else {
        out += m[0];
      }
      last = idx + m[0].length;
    }
    out += content.slice(last);
    if (sub.length === 0) return noop;
    const compressedTokens = countTokensFast(out);
    return {
      content: out,
      originalTokens: totalTokens,
      compressedTokens,
      ratio: totalTokens === 0 ? 1 : compressedTokens / totalTokens,
      transforms: [...new Set(sub.flatMap((r) => r.transforms))],
      ccrHashes: [...new Set(sub.flatMap((r) => r.ccrHashes))],
      cacheHit: false,
    };
  }

  // 2) No fences: compress the whole message only if large AND structured.
  if (totalTokens >= minTokens && USER_COMPRESSIBLE.has(detectContentType(content))) {
    return routeAndCompress(content, ctx);
  }
  return noop;
}
