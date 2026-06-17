import type {
  ChatMessage,
  Provider,
  StreamChatOptions,
  StreamChatResult,
  StreamChunk,
} from "@multipleai/types";
import { assertOkResponse, validateWithFetch } from "../utils.js";
import { usageFromProviderFields } from "../token-estimate.js";

const GEMINI_BASE =
  "https://generativelanguage.googleapis.com/v1beta/models";

function splitGeminiMessages(messages: ChatMessage[]) {
  const systemParts = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content);
  const contents = messages
    .filter((message) => message.role !== "system")
    .map((message) => ({
      role: message.role === "assistant" ? "model" : "user",
      parts: [{ text: message.content }],
    }));

  return {
    systemInstruction: systemParts.length
      ? { parts: [{ text: systemParts.join("\n\n") }] }
      : undefined,
    contents,
  };
}

async function* parseGeminiSseStream(
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
        if (!data) {
          continue;
        }

        try {
          const parsed = JSON.parse(data) as {
            candidates?: Array<{
              content?: { parts?: Array<{ text?: string }> };
            }>;
            usageMetadata?: {
              promptTokenCount?: number;
              candidatesTokenCount?: number;
              totalTokenCount?: number;
            };
          };
          const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text) {
            yield { content: text };
          }
          if (parsed.usageMetadata) {
            const usage = usageFromProviderFields({
              inputTokens: parsed.usageMetadata.promptTokenCount,
              outputTokens: parsed.usageMetadata.candidatesTokenCount,
              totalTokens: parsed.usageMetadata.totalTokenCount,
            });
            if (usage) {
              yield { usage };
            }
          }
        } catch {
          // Skip malformed SSE chunks.
        }
      }
    }

    yield { done: true };
  } finally {
    reader.releaseLock();
  }
}

export const geminiProvider: Provider = {
  id: "gemini",
  name: "Gemini",
  color: "#3B82F6",
  priority: 3,
  keyRegex: /^AIza[a-zA-Z0-9_-]{35}/,
  defaultModel: "gemini-2.5-flash",

  async streamChat(
    messages: ChatMessage[],
    options: StreamChatOptions = {},
  ): Promise<StreamChatResult> {
    const apiKey = options.apiKey;
    if (!apiKey) {
      throw new Error("Gemini requires an API key");
    }

    const model = options.model ?? geminiProvider.defaultModel;
    const url = `${GEMINI_BASE}/${model}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: options.signal,
      body: JSON.stringify({
        ...splitGeminiMessages(messages),
        cachedContent: options.cacheHints?.cachedContentHandle,
        generationConfig: {
          temperature: options.temperature,
          maxOutputTokens: options.maxTokens,
        },
      }),
    });

    await assertOkResponse(response, "Gemini");

    if (!response.body) {
      throw new Error("Gemini returned an empty response body");
    }

    return { stream: parseGeminiSseStream(response.body) };
  },

  async validateKey(key: string): Promise<boolean> {
    if (!geminiProvider.keyRegex?.test(key)) {
      return false;
    }

    return validateWithFetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`,
      { method: "GET" },
    );
  },
};
