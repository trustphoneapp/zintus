import type { ProviderId } from "./provider-id.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface RouteRequest {
  messages: ChatMessage[];
  model?: string;
  provider?: ProviderId;
  stream?: boolean;
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
