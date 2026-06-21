// MIT License — see LICENSE file
import { encode } from "gpt-tokenizer";

/** Fast local estimation — no API call, works for all providers. */
export function countTokensFast(text: string, _model?: string): number {
  try {
    return encode(text).length;
  } catch {
    // Fallback: rough 4-chars-per-token heuristic
    return Math.ceil(text.length / 4);
  }
}

export interface CountTokensExactOptions {
  apiKey?: string;
  model?: string;
}

/** Exact count via Anthropic's count_tokens endpoint (free, no inference cost). */
export async function countTokensExact(
  messages: Array<{ role: string; content: string }>,
  opts: CountTokensExactOptions = {},
): Promise<number> {
  try {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: opts.apiKey });
    const response = await client.messages.countTokens({
      model: opts.model ?? "claude-sonnet-4-6",
      messages: messages as Parameters<typeof client.messages.countTokens>[0]["messages"],
    });
    return response.input_tokens;
  } catch {
    // Fall back to fast estimation if API unavailable
    const text = messages.map((m) => m.content).join(" ");
    return countTokensFast(text);
  }
}

export function isWithinBudget(
  text: string,
  budget: number,
  model?: string,
): boolean {
  return countTokensFast(text, model) <= budget;
}

export function estimateSavings(
  original: string,
  compressed: string,
): { originalTokens: number; compressedTokens: number; savedTokens: number; ratio: number } {
  const originalTokens = countTokensFast(original);
  const compressedTokens = countTokensFast(compressed);
  const savedTokens = Math.max(0, originalTokens - compressedTokens);
  const ratio = originalTokens === 0 ? 1 : compressedTokens / originalTokens;
  return { originalTokens, compressedTokens, savedTokens, ratio };
}
