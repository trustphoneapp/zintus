/// <reference types="node" />
import type {
  ChatMessage,
  Provider,
  StreamChatOptions,
  StreamChatResult,
} from "@multipleai/types";
import { assertOkResponse } from "../utils.js";

const DEFAULT_OLLAMA_URL = "http://localhost:11434";

export const ollamaProvider: Provider = {
  id: "ollama",
  name: "Ollama",
  color: "#8B5CF6",
  priority: 99,
  keyRegex: null,
  defaultModel: "llama3.3",

  async streamChat(
    messages: ChatMessage[],
    options: StreamChatOptions = {},
  ): Promise<StreamChatResult> {
    const baseUrl = process.env.OLLAMA_HOST ?? DEFAULT_OLLAMA_URL;
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: options.signal,
      body: JSON.stringify({
        model: options.model ?? ollamaProvider.defaultModel,
        messages,
        stream: true,
        options: {
          temperature: options.temperature,
          num_predict: options.maxTokens,
        },
      }),
    });

    await assertOkResponse(response, "Ollama");

    if (!response.body) {
      throw new Error("Ollama returned an empty response body");
    }

    const stream = (async function* () {
      const reader = response.body!.getReader();
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
            if (!trimmed) {
              continue;
            }

            try {
              const parsed = JSON.parse(trimmed) as {
                message?: { content?: string };
                done?: boolean;
              };
              if (parsed.message?.content) {
                yield { content: parsed.message.content };
              }
              if (parsed.done) {
                yield { done: true };
              }
            } catch {
              // Skip malformed NDJSON lines.
            }
          }
        }

        yield { done: true };
      } finally {
        reader.releaseLock();
      }
    })();

    return { stream };
  },

  async validateKey(): Promise<boolean> {
    const baseUrl = process.env.OLLAMA_HOST ?? DEFAULT_OLLAMA_URL;
    try {
      const response = await fetch(`${baseUrl}/api/tags`);
      return response.ok;
    } catch {
      return false;
    }
  },
};
