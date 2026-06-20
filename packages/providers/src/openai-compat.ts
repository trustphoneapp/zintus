import type {
  ChatMessage,
  Provider,
  RateLimitInfo,
  StreamChatOptions,
  StreamChatResult,
} from "@zintus/types";
import {
  assertOkResponse,
  parseGroqRateLimitHeaders,
  parseOpenAiSseStream,
  validateWithFetch,
} from "./utils.js";

export interface OpenAiCompatConfig {
  id: Provider["id"];
  name: string;
  color: string;
  priority: number;
  keyRegex: RegExp | null;
  defaultModel: string;
  baseUrl: string;
  includeRateLimit?: boolean;
  validatePath?: string;
}

export function createOpenAiCompatProvider(
  config: OpenAiCompatConfig,
): Provider {
  const {
    id,
    name,
    color,
    priority,
    keyRegex,
    defaultModel,
    baseUrl,
    includeRateLimit = false,
    validatePath = "/models",
  } = config;

  return {
    id,
    name,
    color,
    priority,
    keyRegex,
    defaultModel,

    async streamChat(
      messages: ChatMessage[],
      options: StreamChatOptions = {},
    ): Promise<StreamChatResult> {
      const apiKey = options.apiKey;
      if (keyRegex && !apiKey) {
        throw new Error(`${name} requires an API key`);
      }

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (apiKey) {
        headers.Authorization = `Bearer ${apiKey}`;
      }

      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        signal: options.signal,
        body: JSON.stringify({
          model: options.model ?? defaultModel,
          messages,
          stream: true,
          // Ask OpenAI-compatible providers to emit a final usage chunk so we
          // record real token counts instead of estimating. Providers that do
          // not support this field ignore it.
          stream_options: { include_usage: true },
          temperature: options.temperature,
          max_tokens: options.maxTokens,
        }),
      });

      const parseRateLimit = includeRateLimit
        ? parseGroqRateLimitHeaders
        : undefined;
      await assertOkResponse(response, name, parseRateLimit);

      const rateLimit: RateLimitInfo | undefined = includeRateLimit
        ? parseGroqRateLimitHeaders(response.headers)
        : undefined;

      if (!response.body) {
        throw new Error(`${name} returned an empty response body`);
      }

      const baseStream = parseOpenAiSseStream(response.body);
      const stream = includeRateLimit
        ? (async function* () {
            for await (const chunk of baseStream) {
              yield rateLimit ? { ...chunk, rateLimit } : chunk;
            }
          })()
        : baseStream;

      return { stream, rateLimit };
    },

    async validateKey(key: string): Promise<boolean> {
      if (keyRegex && !keyRegex.test(key)) {
        return false;
      }

      if (!keyRegex) {
        return true;
      }

      return validateWithFetch(`${baseUrl}${validatePath}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${key}` },
      });
    },
  };
}
