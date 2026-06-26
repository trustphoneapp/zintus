import type { AppConfig, ContextMode, ProviderId } from "@zintus/types";
import {
  fetchGatewayHealth,
  streamGatewayChat,
  type ChatMeta,
  type CompressionStats,
} from "./gateway";

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface StreamChatResult {
  providerId: ProviderId;
  model: string;
  threadId?: string;
  traceId?: string;
  compileTokens?: number;
  meta?: ChatMeta;
  compression?: CompressionStats;
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
  images?: Array<{ data: string; mimeType: string; name: string }>;
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
    images: params.images,
    signal: params.signal,
    onChunk: params.onChunk,
  });

  return { ...result, source: "gateway" };
}
