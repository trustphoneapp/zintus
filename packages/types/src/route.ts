import type { ProviderId } from "./provider-id.js";
import type { ContextMode, RoutingStrategy } from "./config.js";
import type { TraceAttempt } from "./trace.js";

/** Multimodal content blocks. A message's `content` is either a plain string
 *  (the original, still-valid shape) or an ordered array of blocks. */
export interface TextContentBlock {
  type: "text";
  text: string;
}

/** A processed, EXIF-stripped image ready for a vision model. `data` is raw
 *  base64 with NO `data:` prefix. Image bytes NEVER go to the relay and are
 *  NEVER logged (use `sanitizeForLogs`). */
export interface ImageContentBlock {
  type: "image";
  data: string;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  bytes: number;
  width?: number;
  height?: number;
  exifStripped: true;
  name?: string;
}

export type ContentBlock = TextContentBlock | ImageContentBlock;

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  /** Plain text (original shape) OR an ordered array of content blocks. */
  content: string | ContentBlock[];
}

/** True when `content` is the block-array shape rather than a plain string. */
export function isContentBlockArray(
  content: string | ContentBlock[],
): content is ContentBlock[] {
  return Array.isArray(content);
}

/** Flatten content to its text — concatenates text blocks, ignores images. Use
 *  ONLY where a string is required and images are not consumed (a stopgap for
 *  string-only consumers; real image handling lives in the gateway/providers). */
export function textOf(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((b): b is TextContentBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

/** Number of image blocks across all messages. */
export function imageCount(messages: ChatMessage[]): number {
  let n = 0;
  for (const m of messages) {
    if (isContentBlockArray(m.content)) {
      for (const b of m.content) if (b.type === "image") n += 1;
    }
  }
  return n;
}

/** True when any message carries at least one image block. */
export function hasImages(messages: ChatMessage[]): boolean {
  return imageCount(messages) > 0;
}

/** True when the request needs a vision-capable model (any image present). */
export function requiresVision(messages: ChatMessage[]): boolean {
  return hasImages(messages);
}

/** Copy of `messages` with image `data` elided — for logs/traces. NEVER log raw
 *  image bytes. */
export function sanitizeForLogs(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) =>
    isContentBlockArray(m.content)
      ? {
          ...m,
          content: m.content.map((b) =>
            b.type === "image"
              ? { ...b, data: `<${b.bytes}B ${b.mimeType} elided>` }
              : b,
          ),
        }
      : m,
  );
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
  /** Drop providers that may train on user data (privacy mode). */
  blockTrainingProviders?: boolean;
  /** Providers the user explicitly allows even when blockTrainingProviders is on. */
  allowTrainingProviders?: ProviderId[];
  /**
   * Per-request BYOK keys (provider -> key), used in preference to the gateway's
   * configured keys for this request only. For the LOCAL gateway: lets a browser
   * client supply keys without server-side key storage. Never logged, never
   * persisted. Must never be forwarded to the relay.
   */
  keys?: Partial<Record<ProviderId, string>>;
  /** Per-request attempt callback. Fires for each provider attempt. */
  onAttempt?: (event: TraceAttempt) => void;
  /**
   * Abort signal propagated to the provider fetch. Lets a connect/idle timeout
   * or a client disconnect cancel an in-flight upstream request instead of
   * leaking the socket and holding the in-flight quota reservation open.
   */
  signal?: AbortSignal;
  /**
   * Per-request usage callback. Fires once, when the winning provider's stream
   * completes successfully, carrying the final token counts and latency. Used to
   * surface the per-response transparency strip without a second round-trip.
   */
  onUsage?: (usage: RouteUsage) => void;
}

export interface RouteUsage {
  providerId: ProviderId;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
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
  /**
   * Privacy-mode honesty signal. `undefined` when `blockTrainingProviders` was
   * not requested. `true` when the winning provider is privacy-safe (does not
   * train, or was explicitly allowed). `false` when private mode could NOT be
   * honored — every available provider may train (or has an "unknown" policy)
   * and one was used anyway because filtering would have stranded the request.
   * Surfaces MUST render a "Private Mode not honored — used <provider>" signal
   * when this is `false`; silently using a training provider is the bug this
   * field exists to prevent.
   */
  privacyHonored?: boolean;
}
