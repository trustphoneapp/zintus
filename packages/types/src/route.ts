import type { ProviderId } from "./provider-id.js";
import type { ContextMode, RoutingStrategy } from "./config.js";
import type { TraceAttempt } from "./trace.js";

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
  /** Request provider-native web search (Gemini grounding / OpenRouter tool). */
  webSearch?: boolean;
  /** Per-request attempt callback. Fires for each provider attempt. */
  onAttempt?: (event: TraceAttempt) => void;
  /**
   * Abort signal propagated to the provider fetch. Lets a connect/idle timeout
   * or a client disconnect cancel an in-flight upstream request instead of
   * leaking the socket and holding the in-flight quota reservation open.
   */
  signal?: AbortSignal;
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
