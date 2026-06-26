import type { AppConfig, ContextMode, ProviderId } from "@zintus/types";
import {
  streamGatewayChat,
  resolveGatewayUrl,
  type CompressionStats,
} from "./gateway";

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface StreamChatResult {
  providerId: ProviderId;
  model: string;
  source: "gateway";
  /** Tokzen savings for this response, when the gateway reported real compression. */
  compression?: CompressionStats;
}

export async function isGatewayAvailable(): Promise<boolean> {
  return (await resolveGatewayUrl()) != null;
}

/**
 * Desktop chat is gateway-only. All routing, failover, quota, cooldown and token
 * accounting live in the gateway/engine (the single source of truth shared with
 * the CLI). The desktop never runs its own router, so there is no second routing
 * implementation that can drift from the gateway's behavior.
 */
export async function streamChat(params: {
  messages: ChatMessage[];
  providerId?: ProviderId;
  mode?: ContextMode;
  settings: AppConfig;
  signal?: AbortSignal;
  onChunk: (text: string) => void;
}): Promise<StreamChatResult> {
  const result = await streamGatewayChat({
    messages: params.messages,
    providerId: params.providerId,
    defaultProvider: params.settings.defaultProvider,
    strategy: params.settings.routingStrategy,
    mode: params.mode ?? params.settings.contextMode,
    signal: params.signal,
    onChunk: params.onChunk,
  });
  return {
    providerId: result.providerId,
    model: result.model,
    source: "gateway",
    compression: result.compression,
  };
}
