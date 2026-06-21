// MIT License — see LICENSE file
import type { Message, Provider } from "../pipeline/types.js";

export interface NormalizedRequest {
  provider: Provider;
  model: string;
  messages: Message[];
  systemPrompt?: string;
  stream?: boolean;
  temperature?: number;
  maxTokens?: number;
  tools?: unknown[];
  rawBody: unknown;
}

interface OpenAIMessage {
  role: string;
  content: string | Array<{ type: string; text?: string }>;
}

interface AnthropicMessage {
  role: string;
  content: string | Array<{ type: string; text?: string }>;
}

function extractText(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === "string") return content;
  return content
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
}

/** Normalize OpenAI-compatible wire format to internal messages. */
export function normalizeOpenAI(body: Record<string, unknown>): NormalizedRequest {
  const rawMessages = (body["messages"] as OpenAIMessage[] | undefined) ?? [];
  const systemMessage = rawMessages.find((m) => m.role === "system");
  const messages: Message[] = rawMessages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role as Message["role"],
      content: extractText(m.content),
    }));

  return {
    provider: "openai",
    model: (body["model"] as string | undefined) ?? "gpt-4o",
    messages,
    systemPrompt: systemMessage ? extractText(systemMessage.content) : undefined,
    stream: Boolean(body["stream"]),
    temperature: body["temperature"] as number | undefined,
    maxTokens: (body["max_tokens"] as number | undefined),
    tools: body["tools"] as unknown[] | undefined,
    rawBody: body,
  };
}

/** Normalize Anthropic wire format to internal messages. */
export function normalizeAnthropic(body: Record<string, unknown>): NormalizedRequest {
  const rawMessages = (body["messages"] as AnthropicMessage[] | undefined) ?? [];
  const messages: Message[] = rawMessages.map((m) => ({
    role: m.role as Message["role"],
    content: extractText(m.content),
  }));

  const systemContent = body["system"];
  const systemPrompt =
    typeof systemContent === "string"
      ? systemContent
      : Array.isArray(systemContent)
      ? extractText(systemContent as Array<{ type: string; text?: string }>)
      : undefined;

  return {
    provider: "anthropic",
    model: (body["model"] as string | undefined) ?? "claude-sonnet-4-6",
    messages,
    systemPrompt,
    stream: Boolean(body["stream"]),
    temperature: body["temperature"] as number | undefined,
    maxTokens: (body["max_tokens"] as number | undefined),
    tools: body["tools"] as unknown[] | undefined,
    rawBody: body,
  };
}

/** Detect provider from request headers and path. */
export function detectProvider(
  url: URL,
  headers: Headers,
): Provider {
  const host = headers.get("x-tokzen-provider") ?? url.hostname;
  if (host.includes("anthropic") || headers.get("anthropic-version")) return "anthropic";
  if (host.includes("googleapis") || host.includes("gemini")) return "gemini";
  if (host.includes("groq")) return "groq";
  return "openai";
}

/** Reconstruct provider-specific wire format from compressed messages. */
export function denormalizeToOpenAI(
  normalized: NormalizedRequest,
  compressedMessages: Message[],
  compressedSystem?: string,
): Record<string, unknown> {
  const raw = normalized.rawBody as Record<string, unknown>;
  const wireMessages: OpenAIMessage[] = [];

  if (compressedSystem) {
    wireMessages.push({ role: "system", content: compressedSystem });
  }

  wireMessages.push(
    ...compressedMessages.filter((m) => m.role !== "system").map((m) => ({
      role: m.role,
      content: m.content,
    })),
  );

  return { ...raw, messages: wireMessages };
}

export function denormalizeToAnthropic(
  normalized: NormalizedRequest,
  compressedMessages: Message[],
  compressedSystem?: string,
): Record<string, unknown> {
  const raw = normalized.rawBody as Record<string, unknown>;
  return {
    ...raw,
    system: compressedSystem ?? normalized.systemPrompt,
    messages: compressedMessages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role, content: m.content })),
  };
}
