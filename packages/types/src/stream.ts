export interface StreamChatOptions {
  model?: string;
  apiKey?: string;
  signal?: AbortSignal;
  temperature?: number;
  maxTokens?: number;
  cacheHints?: CacheHints;
  /**
   * Request provider-native web search for this turn. Providers that support it
   * (Gemini grounding, OpenRouter web_search) add the relevant tool; others
   * ignore it. Groq's native search is selected via the model name instead.
   */
  webSearch?: boolean;
}

/**
 * Hints for provider-native caching. Currently only Gemini's managed
 * `cachedContent` resource is supported; other providers ignore this.
 */
export interface CacheHints {
  cachedContentHandle?: string;
}

export interface RateLimitInfo {
  limitRequests?: string;
  remainingRequests?: string;
  resetRequests?: string;
  limitTokens?: string;
  remainingTokens?: string;
  resetTokens?: string;
}

/**
 * Token usage for a single completion. `source` distinguishes numbers reported
 * by the provider API ("provider") from locally computed fallbacks ("estimate")
 * so callers never silently treat an estimate as ground truth.
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  source: "provider" | "estimate";
}

export interface StreamChunk {
  content?: string;
  done?: boolean;
  rateLimit?: RateLimitInfo;
  usage?: TokenUsage;
}

export interface StreamChatResult {
  stream: AsyncIterable<StreamChunk>;
  rateLimit?: RateLimitInfo;
  usage?: TokenUsage;
}
