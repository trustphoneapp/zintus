// BUSL-1.1 License — Business Source License 1.1
// Additional Use Grant: free for personal, non-commercial use until 2028-01-01
// See LICENSE file for full terms.

/**
 * ML prose compressor using LLMLingua-2 via @atjsh/llmlingua-2.
 * Lazy-loaded on first use to keep base package light.
 * Falls back silently to deterministic prose compressor on any failure.
 *
 * NEVER import @atjsh/llmlingua-2 at module load time.
 * Only fires for "prose" content type at quota Level 3–4 or when
 * TOKZEN_ML_ENABLED=true is explicitly set.
 */
import { countTokensFast } from "../tokenizer/count.js";
import { compressProse } from "../compressors/prose.js";
import type { CompressContext, CompressResult } from "../pipeline/types.js";

export interface MLCompressor {
  compress(content: string, ctx?: Partial<CompressContext>): Promise<CompressResult>;
}

let _mlCompressor: MLCompressor | null = null;
let _loadAttempted = false;

async function tryLoadML(): Promise<MLCompressor | null> {
  if (_loadAttempted) return _mlCompressor;
  _loadAttempted = true;

  try {
    // Dynamic import — @atjsh/llmlingua-2 is an optional peer dep (may not be installed).
    // Use indirect import to bypass TypeScript module resolution for the optional dep.
    const importFn = new Function("pkg", "return import(pkg)") as (pkg: string) => Promise<unknown>;
    const mod = await importFn("@atjsh/llmlingua-2").catch(() => null) as Record<string, unknown> | null;
    if (!mod) return null;
    const { LLMLingua2 } = mod as { LLMLingua2: new() => { compress(text: string, ratio?: number): Promise<string> } };
    const instance = new LLMLingua2();

    _mlCompressor = {
      async compress(content, ctx): Promise<CompressResult> {
        const originalTokens = countTokensFast(content);
        try {
          const targetRatio = 0.5; // Keep 50% of tokens
          const compressed = await instance.compress(content, targetRatio);
          const compressedTokens = countTokensFast(compressed);
          return {
            content: compressed,
            originalTokens,
            compressedTokens,
            ratio: originalTokens === 0 ? 1 : compressedTokens / originalTokens,
            transforms: ["llmlingua-2"],
            ccrHashes: [],
            cacheHit: false,
          };
        } catch {
          // Fall back to deterministic on model inference error
          return compressProse(content, ctx);
        }
      },
    };
    return _mlCompressor;
  } catch {
    // @atjsh/llmlingua-2 not installed — silent fallback
    console.warn("[tokzen] @atjsh/llmlingua-2 not available, using deterministic prose compressor");
    _mlCompressor = null;
    return null;
  }
}

/**
 * Create an ML compressor that lazy-loads LLMLingua-2 on first use.
 * Always falls back to deterministic TF-IDF prose compressor on failure.
 */
export function createMLCompressor(): MLCompressor {
  return {
    async compress(content: string, ctx?: Partial<CompressContext>): Promise<CompressResult> {
      try {
        const ml = await tryLoadML();
        if (ml) {
          return ml.compress(content, ctx);
        }
      } catch {
        // Silent fallback
      }

      // Always fall back to deterministic prose compressor
      return compressProse(content, ctx);
    },
  };
}
