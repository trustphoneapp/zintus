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

/** A model's request to invoke a tool, emitted on the assistant turn. `id` is the
 *  correlation handle the client echoes back in the matching ToolResultContentBlock.
 *  `arguments` is ALWAYS a parsed object at this layer — adapters parse OpenAI's
 *  streamed argument-string / read Gemini's object before constructing this. Tool
 *  arguments are user/tool data: NEVER sent to the relay and NEVER logged raw
 *  (use `sanitizeForLogs`). */
export interface ToolCallContentBlock {
  type: "tool_call";
  /** Provider-issued id where available (OpenAI tool_call.id). Gemini issues none —
   *  adapters synthesize `call_<name>_<index>`. */
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** The client's result for a prior tool_call, carried on the NEXT request. Rides on
 *  a `user` turn (no new `tool` role) — see the gateway normalizer. */
export interface ToolResultContentBlock {
  type: "tool_result";
  /** Must match a prior ToolCallContentBlock.id. */
  toolCallId: string;
  /** Result payload as text (JSON-stringified by the client when structured). */
  content: string;
  /** True when the tool failed — surfaced to the model so it can recover. */
  isError?: boolean;
}

export type ContentBlock =
  | TextContentBlock
  | ImageContentBlock
  | ToolCallContentBlock
  | ToolResultContentBlock;

/** A minimal JSON-Schema shape for tool input. Deliberately structural rather than
 *  a full draft validator — adapters pass it through to the provider (OpenAI
 *  `function.parameters` / Gemini `functionDeclarations[].parameters`, which is an
 *  OpenAPI-3 subset). Callers SHOULD use an object schema with `properties`. */
export interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema | JsonSchema[];
  required?: string[];
  enum?: unknown[];
  description?: string;
  additionalProperties?: boolean | JsonSchema;
  [keyword: string]: unknown;
}

/** A tool the model may call this turn. Provider-neutral; each adapter maps it to
 *  OpenAI `tools[].function` or Gemini `functionDeclarations`. */
export interface ToolDefinition {
  /** Stable, model-visible name. `^[a-zA-Z0-9_-]{1,64}$` (intersection of provider rules). */
  name: string;
  /** Prescriptive description — drives when the model calls it. */
  description: string;
  /** Object JSON Schema for the tool input. */
  parameters: JsonSchema;
  /** Request strict schema adherence where the provider supports it. Best-effort;
   *  ignored by providers that lack it. */
  strict?: boolean;
}

/** How the model may use tools this turn. Maps to OpenAI `tool_choice` /
 *  Gemini `functionCallingConfig.mode`. */
export type ToolChoice =
  | "auto"
  | "required"
  | "none"
  | { type: "tool"; name: string };

/** Caller-facing structured-output request. `json_schema` asks for schema-conformant
 *  JSON; `json_object` asks only for syntactically-valid JSON; `text` is the default
 *  free-form behavior. */
export interface ResponseFormat {
  type: "text" | "json_object" | "json_schema";
  /** Required when type === "json_schema". */
  schema?: JsonSchema;
  /** Human name for the schema (forwarded to providers that want one, e.g. OpenAI
   *  json_schema.name). Defaults to "response". */
  name?: string;
  /** When true, the request DEMANDS a provider that GUARANTEES schema conformance
   *  (provider-level `json_schema`). If none is eligible → hard-error. When
   *  false/undefined, best-effort (`json_object`/`prompt`) is permitted and the
   *  response is labeled `guaranteed:false`. Default: false. */
  strict?: boolean;
  /** Max validate→repair round-trips on a non-conforming response. 0 = validate
   *  once, no repair. Default 2, capped server-side at 2. */
  maxRepairAttempts?: number;
}

/** The provider-level seam: the router resolves the caller's ResponseFormat into the
 *  best level THIS provider/model can actually serve, so each adapter only emits its
 *  own native field for the level it is handed. `prompt` = no native support, coerce
 *  via a system instruction + post-validate (best-effort, never guaranteed). */
export interface ResolvedResponseFormat {
  level: "json_schema" | "json_object" | "prompt";
  schema?: JsonSchema;
  name: string;
}

/** True when the caller asked for any non-text structured output. */
export function requiresStructuredOutput(req: {
  responseFormat?: ResponseFormat;
}): boolean {
  return req.responseFormat != null && req.responseFormat.type !== "text";
}

/** True when the caller DEMANDS provider-guaranteed schema conformance — the router
 *  must route to a `json_schema`-level model or hard-error (never silently downgrade). */
export function requiresGuaranteedSchema(req: {
  responseFormat?: ResponseFormat;
}): boolean {
  return (
    req.responseFormat?.type === "json_schema" &&
    req.responseFormat.strict === true
  );
}

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

/** Flatten content to its text — concatenates text blocks, ignores image/tool
 *  blocks. Use ONLY where a string is required and non-text blocks are not consumed
 *  (a stopgap for string-only consumers; real image/tool handling lives in the
 *  gateway/providers). */
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

/** True when the caller supplied at least one tool definition for this turn. */
export function requiresTools(req: { tools?: ToolDefinition[] }): boolean {
  return (req.tools?.length ?? 0) > 0;
}

/** True when any message carries a tool_call or tool_result block — i.e. this is a
 *  continued tool turn whose history the provider must accept. */
export function hasToolTurns(messages: ChatMessage[]): boolean {
  for (const m of messages) {
    if (isContentBlockArray(m.content)) {
      for (const b of m.content) {
        if (b.type === "tool_call" || b.type === "tool_result") return true;
      }
    }
  }
  return false;
}

/** Copy of `messages` with image `data` elided — for logs/traces. NEVER log raw
 *  image bytes. */
export function sanitizeForLogs(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) =>
    isContentBlockArray(m.content)
      ? {
          ...m,
          content: m.content.map((b) => {
            if (b.type === "image") {
              return { ...b, data: `<${b.bytes}B ${b.mimeType} elided>` };
            }
            if (b.type === "tool_call") {
              return { ...b, arguments: { elided: `<args for ${b.name} elided>` } };
            }
            if (b.type === "tool_result") {
              return { ...b, content: `<tool_result for ${b.toolCallId} elided>` };
            }
            return b;
          }),
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
  /** Tool/function definitions the model may call this turn. Presence makes the
   *  request require a tool-capable model — the router hard-errors (never silently
   *  downgrades) if no candidate supports tools. */
  tools?: ToolDefinition[];
  /** How the model may use `tools` this turn (default "auto"). */
  toolChoice?: ToolChoice;
  /** Structured-output request. Absent ⇒ plain text (unchanged behavior). A strict
   *  `json_schema` request hard-errors if no provider can guarantee conformance. */
  responseFormat?: ResponseFormat;
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
   * Tool calls the model emitted this turn, surfaced on a channel PARALLEL to the
   * text `stream` so the (string) text path stays byte-identical for every existing
   * consumer. This is a LIVE array: it is populated as `stream` drains and is only
   * complete once `stream` has been fully consumed — read it AFTER draining. Empty/
   * undefined when the turn produced no tool calls. Tool calls correspond to a
   * `finishReason: "tool_calls"` turn; the assistant text (if any) still arrives via
   * `stream`. Surfaces run the tool-execution loop client-side and send results back
   * as `tool_result` blocks on the next request.
   */
  toolCalls?: ToolCallContentBlock[];
  /**
   * The structured-output level the winning provider+model ACTUALLY served this
   * turn — the resolved level from the router's `resolveResponseFormat`, not the
   * raw provider capability. `json_schema` means the provider guaranteed
   * schema-constrained decoding; `json_object` means native JSON mode only (no
   * schema enforcement); `prompt` means JSON was requested purely via prompt
   * coercion. `undefined` for a text/absent `responseFormat`. The engine uses
   * THIS to label `served_level`/`guaranteed` honestly — never recompute it from
   * the raw capability, which would over-claim (e.g. a `json_object` request to a
   * `json_schema`-capable provider must NOT be labeled `json_schema`/guaranteed).
   */
  resolvedStructuredLevel?: "json_schema" | "json_object" | "prompt";
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
