import type { RateLimitInfo, StreamChunk } from "@multipleai/types";
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
          if (data === "[DONE]") {
            yield { done: true };
          }
          continue;
        }

        try {
          const parsed = JSON.parse(data) as {
            choices?: Array<{
              delta?: { content?: string };
              finish_reason?: string | null;
            }>;
            usage?: OpenAiUsageFields;
          };
          const content = parsed.choices?.[0]?.delta?.content;
          const finished = parsed.choices?.[0]?.finish_reason != null;

          if (content) {
            yield { content };
          }
          const usageChunk = toUsageChunk(parsed.usage);
          if (usageChunk) {
            yield usageChunk;
          }
          if (finished) {
            yield { done: true };
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
