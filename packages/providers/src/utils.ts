import type { RateLimitInfo, StreamChunk } from "@zintus/types";
import { usageFromProviderFields } from "./token-estimate.js";

interface OpenAiUsageFields {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

function toUsageChunk(usage: OpenAiUsageFields | undefined): StreamChunk | null {
  if (!usage) {
    return null;
  }
  const normalized = usageFromProviderFields({
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
  });
  return normalized ? { usage: normalized } : null;
}

/** A streamed OpenAI `delta.tool_calls[]` fragment. `id`/`function.name` arrive on
 *  the first fragment for a given `index`; `function.arguments` arrives as partial
 *  JSON string fragments spread across many deltas. */
interface OpenAiToolCallDelta {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

/** Per-`index` accumulator for a streamed tool call. */
interface ToolCallAccumulator {
  id: string;
  name: string;
  args: string;
}

/** Map OpenAI's `finish_reason` to the internal `StreamChunk.finishReason`. */
function mapFinishReason(
  reason: string,
): NonNullable<StreamChunk["finishReason"]> | undefined {
  if (
    reason === "tool_calls" ||
    reason === "stop" ||
    reason === "length" ||
    reason === "content_filter"
  ) {
    return reason;
  }
  return undefined;
}

/** Drain accumulated tool-call fragments into `toolCall` chunks, in `index` order.
 *  Parses each buffered argument string; on malformed JSON the call is emitted with
 *  `arguments: {}` rather than throwing, so one bad payload never kills the stream. */
function drainToolCalls(
  toolCalls: Map<number, ToolCallAccumulator>,
): StreamChunk[] {
  const out: StreamChunk[] = [];
  const indices = [...toolCalls.keys()].sort((a, b) => a - b);
  for (const index of indices) {
    const acc = toolCalls.get(index);
    if (!acc) {
      continue;
    }
    let parsedArgs: Record<string, unknown> = {};
    if (acc.args) {
      try {
        const parsed = JSON.parse(acc.args) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          parsedArgs = parsed as Record<string, unknown>;
        }
      } catch {
        parsedArgs = {};
      }
    }
    out.push({
      toolCall: {
        type: "tool_call",
        id: acc.id,
        name: acc.name,
        arguments: parsedArgs,
      },
    });
  }
  return out;
}

/** Fold a batch of `delta.tool_calls` fragments into the per-`index` accumulators. */
function accumulateToolCalls(
  toolCalls: Map<number, ToolCallAccumulator>,
  deltas: OpenAiToolCallDelta[],
): void {
  for (const delta of deltas) {
    if (typeof delta.index !== "number") {
      continue;
    }
    let acc = toolCalls.get(delta.index);
    if (!acc) {
      acc = { id: "", name: "", args: "" };
      toolCalls.set(delta.index, acc);
    }
    if (delta.id) {
      acc.id = delta.id;
    }
    if (delta.function?.name) {
      acc.name = delta.function.name;
    }
    if (delta.function?.arguments) {
      acc.args += delta.function.arguments;
    }
  }
}

export function parseGroqRateLimitHeaders(
  headers: Headers,
): RateLimitInfo | undefined {
  const resetRequests = headers.get("x-ratelimit-reset-requests");
  if (!resetRequests) {
    return undefined;
  }

  return {
    limitRequests: headers.get("x-ratelimit-limit-requests") ?? undefined,
    remainingRequests:
      headers.get("x-ratelimit-remaining-requests") ?? undefined,
    resetRequests,
    limitTokens: headers.get("x-ratelimit-limit-tokens") ?? undefined,
    remainingTokens:
      headers.get("x-ratelimit-remaining-tokens") ?? undefined,
    resetTokens: headers.get("x-ratelimit-reset-tokens") ?? undefined,
  };
}

export async function* parseOpenAiSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<StreamChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  // Tool-call fragments accumulate by `index` ACROSS many SSE lines until a
  // `finish_reason` (or stream end) tells us they're complete.
  const toolCalls = new Map<number, ToolCallAccumulator>();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) {
          continue;
        }

        const data = trimmed.slice(5).trim();
        if (!data || data === "[DONE]") {
          // `done` is NOT emitted here: it fires exactly once at true stream end
          // (after any trailing usage frame), so usage never trails a terminal
          // `done`. `[DONE]` is the provider's marker that the next frames (if
          // any) are over; the loop break + stream-end yield handle termination.
          continue;
        }

        try {
          const parsed = JSON.parse(data) as {
            choices?: Array<{
              delta?: {
                content?: string;
                tool_calls?: OpenAiToolCallDelta[];
              };
              finish_reason?: string | null;
            }>;
            usage?: OpenAiUsageFields;
          };
          const choice = parsed.choices?.[0];
          const content = choice?.delta?.content;
          const toolCallDeltas = choice?.delta?.tool_calls;
          const finishReason = choice?.finish_reason;

          if (content) {
            yield { content };
          }
          if (toolCallDeltas && toolCallDeltas.length > 0) {
            accumulateToolCalls(toolCalls, toolCallDeltas);
          }
          const usageChunk = toUsageChunk(parsed.usage);
          if (usageChunk) {
            yield usageChunk;
          }
          if (finishReason != null) {
            // Flush any buffered tool calls before the terminal signal.
            const drainedToolCalls = toolCalls.size > 0;
            if (finishReason === "tool_calls" || drainedToolCalls) {
              for (const toolChunk of drainToolCalls(toolCalls)) {
                yield toolChunk;
              }
              toolCalls.clear();
            }
            // If any tool calls were drained this stream, the turn is a tool
            // turn — emit "tool_calls" even when the provider mislabeled
            // finish_reason as "stop" (some OpenAI-compatible providers do).
            const mapped =
              drainedToolCalls || finishReason === "tool_calls"
                ? "tool_calls"
                : mapFinishReason(finishReason);
            if (mapped) {
              yield { finishReason: mapped };
            }
            // `done` is emitted exactly once at true stream end (below), AFTER
            // any trailing usage frame — never here.
          }
        } catch {
          // Skip malformed SSE chunks.
        }
      }
    }

    if (buffer.trim()) {
      const trimmed = buffer.trim();
      if (trimmed.startsWith("data:")) {
        const data = trimmed.slice(5).trim();
        if (data && data !== "[DONE]") {
          try {
            const parsed = JSON.parse(data) as {
              choices?: Array<{ delta?: { content?: string } }>;
              usage?: OpenAiUsageFields;
            };
            const content = parsed.choices?.[0]?.delta?.content;
            if (content) {
              yield { content };
            }
            const usageChunk = toUsageChunk(parsed.usage);
            if (usageChunk) {
              yield usageChunk;
            }
          } catch {
            // Skip malformed trailing chunk.
          }
        }
      }
    }

    // Stream ended without an explicit `finish_reason` but with buffered tool
    // calls (some providers close the connection in lieu of a terminal frame).
    if (toolCalls.size > 0) {
      for (const toolChunk of drainToolCalls(toolCalls)) {
        yield toolChunk;
      }
      toolCalls.clear();
      yield { finishReason: "tool_calls" };
    }

    yield { done: true };
  } finally {
    reader.releaseLock();
  }
}

export async function validateWithFetch(
  url: string,
  init: RequestInit,
): Promise<boolean> {
  try {
    const response = await fetch(url, init);
    return response.ok;
  } catch {
    return false;
  }
}

export class ProviderHttpError extends Error {
  readonly status: number;
  readonly rateLimit?: RateLimitInfo;

  constructor(
    message: string,
    status: number,
    rateLimit?: RateLimitInfo,
  ) {
    super(message);
    this.name = "ProviderHttpError";
    this.status = status;
    this.rateLimit = rateLimit;
  }
}

export async function assertOkResponse(
  response: Response,
  providerName: string,
  parseRateLimit?: (headers: Headers) => RateLimitInfo | undefined,
): Promise<void> {
  if (response.ok) {
    return;
  }

  const body = await response.text().catch(() => "");
  const rateLimit = parseRateLimit?.(response.headers);
  throw new ProviderHttpError(
    `${providerName} API error (${response.status}): ${body || response.statusText}`,
    response.status,
    rateLimit,
  );
}
