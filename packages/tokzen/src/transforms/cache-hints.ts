// MIT License — see LICENSE file
import { countTokensFast } from "../tokenizer/count.js";
import type { Provider } from "../pipeline/types.js";

// Minimum tokens required for provider cache to activate
const CACHE_MIN_TOKENS: Record<Provider, number> = {
  anthropic: 1024,   // Claude 3.x; 2048 for Sonnet 4.x+ — we use the conservative floor
  openai: 1024,
  gemini: 1024,      // Gemini Flash 2.5; 4096 for Pro
  groq: 0,           // No cache hints
  generic: 0,
};

export interface CacheHintOptions {
  provider: Provider;
  model?: string;
}

export interface AnthropicBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

/**
 * Returns the minimum token threshold for cache activation for a given
 * provider/model combination.
 */
export function getCacheMinTokens(provider: Provider, model?: string): number {
  if (provider === "anthropic") {
    // Claude Sonnet 4.x requires 2048
    if (model && /sonnet-4|claude-4/i.test(model)) return 2048;
    return 1024;
  }
  if (provider === "gemini") {
    if (model && /pro/i.test(model)) return 4096;
    return 1024;
  }
  return CACHE_MIN_TOKENS[provider] ?? 0;
}

/**
 * Inject cache_control breakpoints into Anthropic-format message blocks.
 * Only annotates the last block of static content if it exceeds the minimum.
 */
export function injectAnthropicCacheControl(
  blocks: AnthropicBlock[],
  model?: string,
): AnthropicBlock[] {
  const minTokens = getCacheMinTokens("anthropic", model);
  const totalText = blocks.map((b) => b.text).join("");
  if (countTokensFast(totalText) < minTokens) return blocks;

  // Mark the last block as cacheable (up to 4 breakpoints allowed)
  return blocks.map((block, i) => {
    if (i === blocks.length - 1) {
      return { ...block, cache_control: { type: "ephemeral" as const } };
    }
    return block;
  });
}

/**
 * For OpenAI: just ensure static content comes first (auto-cache is implicit).
 * For Gemini: same breakpoint annotation as Anthropic.
 * For Groq/generic: no-op.
 */
export function applyProviderCacheHints(
  systemPrompt: string,
  opts: CacheHintOptions,
): string | AnthropicBlock[] {
  const { provider, model } = opts;

  if (provider === "anthropic" || provider === "gemini") {
    const minTokens = getCacheMinTokens(provider, model);
    if (countTokensFast(systemPrompt) < minTokens) return systemPrompt;
    // Return as structured block with cache_control on the last segment
    return [{ type: "text" as const, text: systemPrompt, cache_control: { type: "ephemeral" as const } }];
  }

  // OpenAI/Groq/generic: return as-is (just stable ordering matters)
  return systemPrompt;
}
