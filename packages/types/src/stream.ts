export interface StreamChatOptions {
  model?: string;
  apiKey?: string;
  signal?: AbortSignal;
  temperature?: number;
  maxTokens?: number;
}

export interface RateLimitInfo {
  limitRequests?: string;
  remainingRequests?: string;
  resetRequests?: string;
  limitTokens?: string;
  remainingTokens?: string;
  resetTokens?: string;
}

export interface StreamChunk {
  content?: string;
  done?: boolean;
  rateLimit?: RateLimitInfo;
}

export interface StreamChatResult {
  stream: AsyncIterable<StreamChunk>;
  rateLimit?: RateLimitInfo;
}
