import type { ChatMessage, TokenUsage } from "@multipleai/types";

/**
 * Local token estimation used ONLY when a provider does not report usage.
 *
 * This is a heuristic, not a tokenizer. For BPE-based models English text runs
 * ~3.5–4.5 characters per token; we use 4 plus a small per-message overhead for
 * role/formatting framing. Estimates are always tagged `source: "estimate"` so
 * downstream quota logic can treat them with appropriate caution. Replace with
 * a real tokenizer (e.g. tiktoken / model-specific) if exact accounting is
 * required for billing.
 */
const CHARS_PER_TOKEN = 4;
const PER_MESSAGE_OVERHEAD_TOKENS = 4;

export function estimateTokensFromText(text: string): number {
  if (!text) {
    return 0;
  }
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function estimateInputTokens(messages: ChatMessage[]): number {
  let total = 0;
  for (const message of messages) {
    total += estimateTokensFromText(message.content) + PER_MESSAGE_OVERHEAD_TOKENS;
  }
  return total;
}

/**
 * Build a usage record from estimates. Used as a last resort when the provider
 * stream completed without reporting real usage numbers.
 */
export function estimateUsage(
  messages: ChatMessage[],
  outputText: string,
): TokenUsage {
  const inputTokens = estimateInputTokens(messages);
  const outputTokens = estimateTokensFromText(outputText);
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    source: "estimate",
  };
}

/**
 * Normalize provider-reported usage fields (OpenAI-style `prompt_tokens` /
 * `completion_tokens`, or Gemini-style `promptTokenCount` /
 * `candidatesTokenCount`) into a `TokenUsage`. Returns null when no usable
 * numbers are present so callers can fall back to estimation.
 */
export function usageFromProviderFields(fields: {
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
}): TokenUsage | null {
  const input = numberOrNull(fields.inputTokens);
  const output = numberOrNull(fields.outputTokens);
  const total = numberOrNull(fields.totalTokens);

  if (input == null && output == null && total == null) {
    return null;
  }

  const inputTokens = input ?? (total != null && output != null ? total - output : 0);
  const outputTokens = output ?? (total != null && input != null ? total - input : 0);
  return {
    inputTokens: Math.max(0, inputTokens),
    outputTokens: Math.max(0, outputTokens),
    totalTokens: total ?? Math.max(0, inputTokens) + Math.max(0, outputTokens),
    source: "provider",
  };
}

function numberOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
