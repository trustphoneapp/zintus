import type {
  AppConfig,
  ContentBlock,
  ContextMode,
  ProviderId,
  ToolCallContentBlock,
  ToolChoice,
  ToolDefinition,
  ResponseFormat,
} from "@zintus/types";
import {
  fetchGatewayHealth,
  streamGatewayChat,
  type ChatMeta,
  type CompressionStats,
} from "./gateway";

export { UnsupportedCapabilityError } from "./gateway";

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  /** Plain text, OR an ordered content-block array (text first, then images). */
  content: string | ContentBlock[];
}

function isEmptyContent(content: string | ContentBlock[]): boolean {
  if (typeof content === "string") return content.trim() === "";
  return content.length === 0;
}

/**
 * Clean a store-derived conversation before it is sent to the gateway. The
 * tool-execution loop can leave the message store with empty-content assistant
 * bubbles (a tool round with no preamble text) and/or two adjacent assistant
 * turns (one per round). Replaying that verbatim produces a malformed multi-turn
 * conversation (empty assistant content + adjacent same-role turns) that strict
 * role-alternation providers (e.g. Gemini) reject. This returns a cleaned COPY:
 *   (a) drops any assistant turn whose content is empty (blank string or empty
 *       block array);
 *   (b) merges adjacent same-role turns whose content are both strings (joined
 *       with a newline); non-string (ContentBlock[]) turns are pushed un-merged.
 * Order is preserved and the input is never mutated.
 */
export function sanitizeSendHistory(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    if (m.role === "assistant" && isEmptyContent(m.content)) continue;
    const last = out[out.length - 1];
    if (
      last &&
      last.role === m.role &&
      typeof last.content === "string" &&
      typeof m.content === "string"
    ) {
      last.content = `${last.content}\n${m.content}`;
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  return out;
}

export interface StreamChatResult {
  providerId: ProviderId;
  model: string;
  threadId?: string;
  traceId?: string;
  compileTokens?: number;
  meta?: ChatMeta;
  compression?: CompressionStats;
  /** Tool calls the model made this turn (empty for a normal text turn). The
   *  caller runs the tools and sends results back as tool_result blocks. */
  toolCalls?: ToolCallContentBlock[];
  source: "gateway";
}

export async function isGatewayAvailable(): Promise<boolean> {
  const health = await fetchGatewayHealth();
  return Boolean(health?.ok);
}

export async function streamChat(params: {
  messages: ChatMessage[];
  providerId?: ProviderId;
  /** Specific model id (catalog "Use this model"); else the provider default. */
  model?: string;
  mode?: ContextMode;
  threadId?: string;
  apiKeys?: Partial<Record<ProviderId, string>>;
  settings?: AppConfig;
  webSearch?: boolean;
  temperature?: number;
  /** Tool/function definitions for this turn. Requires a tool-capable provider —
   *  the gateway returns a structured 422 otherwise. */
  tools?: ToolDefinition[];
  toolChoice?: ToolChoice;
  /** Structured-output request (e.g. { type: "json_object" }). */
  responseFormat?: ResponseFormat;
  signal?: AbortSignal;
  onChunk: (text: string) => void;
}): Promise<StreamChatResult> {
  const gatewayUp = await isGatewayAvailable();

  if (!gatewayUp) {
    throw new Error(
      "No gateway connected. Zintus is local-first — start your gateway with `zintus serve`, then add a provider key (zintus keys set groq <your-key>). Self-host guide: /docs#self-host",
    );
  }

  const result = await streamGatewayChat({
    messages: params.messages,
    providerId: params.providerId,
    model: params.model,
    defaultProvider: params.settings?.defaultProvider,
    strategy: params.settings?.routingStrategy,
    mode: params.mode ?? params.settings?.contextMode,
    threadId: params.threadId,
    webSearch: params.webSearch,
    blockTraining: params.settings?.blockTrainingProviders,
    allowTraining: params.settings?.allowTrainingProviders,
    keys: params.apiKeys,
    temperature: params.temperature,
    tools: params.tools,
    toolChoice: params.toolChoice,
    responseFormat: params.responseFormat,
    signal: params.signal,
    onChunk: params.onChunk,
  });

  return { ...result, source: "gateway" };
}
