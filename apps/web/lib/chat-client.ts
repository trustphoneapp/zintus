import type { AppConfig, ContextMode, ProviderId } from "@zintus/types";
import { fetchGatewayHealth, streamGatewayChat } from "./gateway";

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
  signal?: AbortSignal;
  onChunk: (text: string) => void;
}): Promise<StreamChatResult> {
  const gatewayUp = await isGatewayAvailable();

  if (!gatewayUp) {
    throw new Error(
      "Gateway is offline. In the project root run: bun run dev:gateway — then add keys with: bun run dev:cli -- keys set groq <your-key>",
    );
  }

  const result = await streamGatewayChat({
    messages: params.messages,
    providerId: params.providerId,
    defaultProvider: params.settings?.defaultProvider,
    strategy: params.settings?.routingStrategy,
    mode: params.mode ?? params.settings?.contextMode,
    threadId: params.threadId,
    signal: params.signal,
    onChunk: params.onChunk,
  });

  return { ...result, source: "gateway" };
}
