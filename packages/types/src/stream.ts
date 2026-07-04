import type {
  ResolvedResponseFormat,
  ToolCallContentBlock,
  ToolChoice,
  ToolDefinition,
} from "./route.js";

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
  /** Tool/function definitions the model may call this turn. Adapters that lack a
   *  tool mapping ignore these; the router gate ensures only tool-capable models
   *  receive a tools-bearing request. */
  tools?: ToolDefinition[];
  /** How the model may use `tools` this turn (default "auto"). */
  toolChoice?: ToolChoice;
  /** Resolved structured-output instruction for THIS provider call. The router has
   *  already downgraded the caller's request to the level this provider/model can
   *  serve, so the adapter only emits its native field for `level`. */
  responseFormat?: ResolvedResponseFormat;
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
  /** Reasoning/"thinking" tokens when the provider reports them separately
   *  (OpenAI `completion_tokens_details.reasoning_tokens`, Gemini
   *  `thoughtsTokenCount`). Billed at the output rate. Absent means
   *  "not reported", never zero — callers must not default this to 0 when
   *  deciding whether a model reasons. */
  reasoningTokens?: number;
  /** Input tokens served from the provider's prompt cache (OpenAI
   *  `prompt_tokens_details.cached_tokens`, Gemini `cachedContentTokenCount`).
   *  A subset of `inputTokens`, billed at a discounted rate. */
  cacheReadTokens?: number;
  /** Tokens written to the provider's prompt cache (Anthropic-style
   *  `cache_creation_input_tokens`). Billed at a premium on some providers. */
  cacheWriteTokens?: number;
  source: "provider" | "estimate";
}

export interface StreamChunk {
  content?: string;
  /** The model that ACTUALLY served this stream, when the provider reports it
   *  (e.g. Ollama's per-line `model`). Lets receipts show the real model when
   *  a local runtime substitutes for a catalog placeholder. */
  servedModel?: string;
  done?: boolean;
  rateLimit?: RateLimitInfo;
  usage?: TokenUsage;
  /** A completed tool call from the model. Always carries fully-parsed `arguments`
   *  (the OpenAI adapter accumulates streamed fragments then parses; Gemini arrives
   *  whole). Multiple tool calls in one assistant turn are emitted as separate
   *  chunks. The text path is unaffected — a chunk carries `content` OR `toolCall`. */
  toolCall?: ToolCallContentBlock;
  /** Why generation stopped, when the provider reports it. `"tool_calls"` signals
   *  the assistant turn ended to await tool results. */
  finishReason?: "stop" | "tool_calls" | "length" | "content_filter";
}

export interface StreamChatResult {
  stream: AsyncIterable<StreamChunk>;
  rateLimit?: RateLimitInfo;
  usage?: TokenUsage;
}
