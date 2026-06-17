import type { ProviderId } from "./provider-id.js";
import type { ContextMode, RoutingStrategy } from "./config.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface RouteRequest {
  messages: ChatMessage[];
  model?: string;
  provider?: ProviderId;
  mode?: ContextMode;
  stream?: boolean;
  threadId?: string;
  /** Gemini cached-content resource name, when the caller manages one. */
  cachedContentHandle?: string;
  stickySessionKey?: string;
  stickySessionTtlMs?: number;
  virtualKey?: string;
  providerWeights?: Record<string, number>;
  /** Per-request routing strategy override (else the router's configured default). */
  strategy?: RoutingStrategy | "weighted";
  temperature?: number;
  maxTokens?: number;
}

export interface RouteResponse {
  providerId: ProviderId;
  model: string;
  content?: string;
  stream?: ReadableStream<Uint8Array>;
}

export interface RouteStreamResult {
  providerId: ProviderId;
  model: string;
  stream: AsyncIterable<string>;
}
