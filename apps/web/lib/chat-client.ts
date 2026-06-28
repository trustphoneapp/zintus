import type {
  AppConfig,
  ContentBlock,
  ContextMode,
  ProviderId,
  ToolCallContentBlock,
  ToolChoice,
  ToolDefinition,
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
    signal: params.signal,
    onChunk: params.onChunk,
  });

  return { ...result, source: "gateway" };
}
