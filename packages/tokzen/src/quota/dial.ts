// BUSL-1.1 License — Business Source License 1.1
// Additional Use Grant: free for personal, non-commercial use until 2028-01-01
// See LICENSE file for full terms.
import { QuotaController, type AggressivenessLevel } from "./controller.js";
import type { CompressContext } from "../pipeline/types.js";
import type { CompressInput, CompressOutput } from "../pipeline/pipeline.js";
import { compress } from "../pipeline/pipeline.js";

export interface DialOptions {
  mlEnabled?: boolean;
}

/**
 * Quota-aware compress dispatcher: selects what to compress based on quota level.
 *
 * Level 1 (>50% remaining): CacheAligner only, no content compression.
 * Level 2 (30–50%): + JSON / log / diff compression, no CCR yet.
 * Level 3 (15–30%): + code compression, CCR for conversation history.
 * Level 4 (<15%): + prose compression, aggressive CCR, optional ML.
 */
export async function dialCompress(
  input: CompressInput,
  ctx: CompressContext,
  opts: DialOptions = {},
): Promise<CompressOutput> {
  const quotaRemaining = ctx.quotaRemaining ?? 1.0;
  const level: AggressivenessLevel = QuotaController.getLevel(quotaRemaining);

  // At level 1, only run CacheAligner (strip dynamic content from system prompt)
  if (level === 1) {
    const { alignCache } = await import("../transforms/cache-aligner.js");
    const systemMsg = input.messages.find((m) => m.role === "system");
    if (!systemMsg) {
      return { messages: input.messages, totalResult: emptyResult(input) };
    }
    const aligned = alignCache(systemMsg.content, ctx);
    const messages = input.messages.map((m) =>
      m === systemMsg ? { ...m, content: aligned.combined } : m,
    );
    return {
      messages,
      totalResult: aligned,
    };
  }

  // Level 2–4: route through full pipeline (ContentRouter respects content type)
  // For prose: only compress at level 3–4
  const adjustedCtx: CompressContext = {
    ...ctx,
    // Signal the content router to skip prose below level 3
    tokenBudget: level <= 2 ? undefined : ctx.tokenBudget,
  };

  const result = await compress(input, adjustedCtx);

  // Level 4 + ML enabled: optionally run ML prose compressor
  if (level === 4 && opts.mlEnabled) {
    try {
      const { createMLCompressor } = await import("../ml/llmlingua.js");
      const ml = createMLCompressor();
      const mlMessages = await Promise.all(
        result.messages.map(async (msg) => {
          if (msg.role === "user" || msg.role === "tool") return msg;
          const mlResult = await ml.compress(msg.content, adjustedCtx);
          return { ...msg, content: mlResult.content };
        }),
      );
      return { ...result, messages: mlMessages };
    } catch {
      // Silent fallback — ML unavailable
    }
  }

  return result;
}

function emptyResult(_input: CompressInput): CompressOutput["totalResult"] {
  return {
    content: "",
    originalTokens: 0,
    compressedTokens: 0,
    ratio: 1,
    transforms: [],
    ccrHashes: [],
    cacheHit: false,
  };
}
