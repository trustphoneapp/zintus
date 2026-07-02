import type { ProviderId } from "./provider-id.js";
import type { ChatMessage } from "./route.js";
import type { StreamChatOptions, StreamChatResult } from "./stream.js";

export type { ProviderId } from "./provider-id.js";

export const PROVIDER_IDS = [
  "cerebras",
  "groq",
  "gemini",
  "openrouter",
  "cohere",
  "mistral",
  "deepseek",
  "fireworks",
  "xai",
  "huggingface",
  "together",
  "sambanova",
  "nvidia",
  "novita",
  "moonshot",
  "zai",
  "qwen",
  "openai",
  "anthropic",
  "perplexity",
  "lmstudio",
  "ollama",
] as const satisfies readonly ProviderId[];

export interface Provider {
  id: ProviderId;
  name: string;
  color: string;
  priority: number;
  keyRegex: RegExp | null;
  defaultModel: string;
  streamChat(
    messages: ChatMessage[],
    options?: StreamChatOptions,
  ): Promise<StreamChatResult>;
  validateKey(key: string): Promise<boolean>;
}

export function isProviderId(value: string): value is ProviderId {
  return PROVIDER_IDS.includes(value as ProviderId);
}
