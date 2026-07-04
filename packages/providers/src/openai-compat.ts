import type {
  ChatMessage,
  ContentBlock,
  Provider,
  RateLimitInfo,
  ResolvedResponseFormat,
  StreamChatOptions,
  StreamChatResult,
  ToolCallContentBlock,
  ToolChoice,
  ToolDefinition,
  ToolResultContentBlock,
} from "@zintus/types";
import { isContentBlockArray, textOf } from "@zintus/types";
import {
  assertOkResponse,
  parseGroqRateLimitHeaders,
  parseOpenAiSseStream,
  validateWithFetch,
} from "./utils.js";

/** An OpenAI multimodal content part. A user turn carrying image(s) becomes an
 *  ORDERED array of these (text + image_url) instead of a plain string. Image
 *  bytes ride inline as a `data:` URL — the OpenAI/OpenRouter/xAI/Mistral wire
 *  shape every OpenAI-compatible vision model accepts. */
type OpenAiContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

/** An OpenAI wire-format chat message. `tool` messages carry a `tool_call_id`;
 *  assistant messages that requested tools carry `tool_calls`. `content` is a
 *  plain string for text-only turns, `null` for a pure tool-call turn, or an
 *  ORDERED `OpenAiContentPart[]` for a turn carrying image(s). */
interface OpenAiWireMessage {
  role: string;
  content: string | null | OpenAiContentPart[];
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
}

/**
 * Map an ordered `ContentBlock[]` to OpenAI multimodal content parts, preserving
 * order: text blocks → `{type:"text"}`, image blocks → `{type:"image_url"}` with
 * the raw base64 wrapped as a `data:` URL. Non-text/non-image blocks (tool
 * blocks) are handled separately by the caller and skipped here.
 */
function toOpenAiContentParts(content: ContentBlock[]): OpenAiContentPart[] {
  const parts: OpenAiContentPart[] = [];
  for (const block of content) {
    if (block.type === "text") {
      parts.push({ type: "text", text: block.text });
    } else if (block.type === "image") {
      parts.push({
        type: "image_url",
        image_url: { url: `data:${block.mimeType};base64,${block.data}` },
      });
    }
  }
  return parts;
}

/** An OpenAI wire-format `tools[]` entry (function tool). */
interface OpenAiFunctionTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    strict?: true;
  };
}

/** OpenAI `tool_choice` wire shapes. */
type OpenAiToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "function"; function: { name: string } };

/**
 * Convert internal `ChatMessage[]` to OpenAI wire messages.
 *
 * - Plain string content passes through unchanged (string stays string).
 * - Text-only block arrays collapse to their joined text (`textOf` semantics).
 * - An assistant turn carrying `tool_call` blocks becomes a single assistant
 *   message with `tool_calls` (and the joined text, or `null` when empty).
 * - A turn carrying `tool_result` blocks emits a SEPARATE `{ role:"tool" }`
 *   message per result, plus a normal message for any remaining text.
 * - A (non-tool) turn carrying image block(s) emits an ORDERED
 *   `OpenAiContentPart[]` (text + `image_url` data-URLs) so any OpenAI-compatible
 *   vision model can SEE the image. The router still gates this on
 *   `supportsVision` — an image only reaches a model verified to accept it.
 */
export function toOpenAiMessages(
  messages: ChatMessage[],
): OpenAiWireMessage[] {
  const out: OpenAiWireMessage[] = [];

  for (const message of messages) {
    const { role, content } = message;

    if (!isContentBlockArray(content)) {
      out.push({ role, content });
      continue;
    }

    const toolResults = content.filter(
      (b): b is ToolResultContentBlock => b.type === "tool_result",
    );
    const toolCalls = content.filter(
      (b): b is ToolCallContentBlock => b.type === "tool_call",
    );
    const text = textOf(content);

    // Each tool result becomes its own `role:"tool"` message.
    for (const block of toolResults) {
      out.push({
        role: "tool",
        tool_call_id: block.toolCallId,
        content: block.content,
      });
    }

    const hasImage = content.some((b) => b.type === "image");

    if (toolCalls.length > 0) {
      out.push({
        role,
        content: text || null,
        tool_calls: toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        })),
      });
    } else if (hasImage) {
      // Image-bearing turn: emit ordered multimodal content parts (text +
      // image_url) so a vision-capable model can see the image(s). This branch
      // wins over the tool_result branch so an image is NEVER silently dropped on
      // a turn that also carries tool_result blocks — those were already emitted
      // as separate role:"tool" messages above, and `toOpenAiContentParts` skips
      // tool blocks, so they don't double up here.
      out.push({ role, content: toOpenAiContentParts(content) });
    } else if (toolResults.length > 0) {
      // Pure tool-result turn: only add a text message if text remains.
      if (text) {
        out.push({ role, content: text });
      }
    } else {
      // Text-only (or other-block) array: collapse to joined text.
      out.push({ role, content: text });
    }
  }

  return out;
}

/** Map an internal `ToolDefinition[]` to OpenAI `tools[]` function entries. */
function toOpenAiFunctionTools(
  tools: ToolDefinition[],
): OpenAiFunctionTool[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      // OpenAI strict tools demand the SAME schema shape as strict
      // `response_format`: `additionalProperties:false` + every key in
      // `required` (formerly-optional keys widened to allow null). A raw schema
      // with optional fields hard-400s. Only normalize when the caller opted into
      // `strict` — a non-strict tool's schema is forwarded untouched.
      parameters: tool.strict
        ? normalizeOpenAiStrictSchema(tool.parameters as Record<string, unknown>)
        : (tool.parameters as Record<string, unknown>),
      ...(tool.strict ? { strict: true as const } : {}),
    },
  }));
}

/** Map an internal `ToolChoice` to the OpenAI `tool_choice` wire shape. */
function toOpenAiToolChoice(
  choice: ToolChoice | undefined,
): OpenAiToolChoice | undefined {
  if (choice === undefined) {
    return undefined;
  }
  if (choice === "auto" || choice === "none" || choice === "required") {
    return choice;
  }
  return { type: "function", function: { name: choice.name } };
}

/** Widen a property schema's `type` to include `"null"` so a formerly-optional
 *  field that strict mode forces into `required` can be returned as `null`
 *  instead of FORCING the model to fabricate a value. A node with no single
 *  `type` (e.g. an `anyOf` union) is left untouched — there's nothing to widen.
 *  Pure: returns a new object, never mutates. */
function widenTypeWithNull(
  node: Record<string, unknown>,
): Record<string, unknown> {
  const type = node.type;
  if (typeof type === "string") {
    return type === "null" ? node : { ...node, type: [type, "null"] };
  }
  if (Array.isArray(type)) {
    return type.includes("null") ? node : { ...node, type: [...type, "null"] };
  }
  // No `type` (union/ref/typeless) — leave as-is.
  return node;
}

/**
 * Normalize a schema to satisfy OpenAI's Structured Outputs `strict:true`
 * contract: EVERY object node MUST set `additionalProperties:false` AND list
 * EVERY key of `properties` in `required`. OpenAI's recipe for a field the
 * caller wanted OPTIONAL is to keep it required but widen its `type` union to
 * include `"null"` — so we add `"null"` to any property that was NOT in the
 * original `required` set (otherwise strict forces the model to fabricate a
 * non-null value). Recurses through `properties`, `items`, and
 * `anyOf`/`oneOf`/`allOf` branches. Pure transform — never mutates the input.
 */
export function normalizeOpenAiStrictSchema(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return schema;
  }
  const out: Record<string, unknown> = { ...schema };

  const props = out.properties;
  if (props && typeof props === "object" && !Array.isArray(props)) {
    // Keys the caller ACTUALLY marked required — anything else was optional and
    // must be widened to allow null when strict's required-all rule promotes it.
    const originalRequired = new Set(
      Array.isArray(out.required) ? (out.required as string[]) : [],
    );
    const normalizedProps: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(
      props as Record<string, unknown>,
    )) {
      const normalizedChild = normalizeOpenAiStrictSchema(
        value as Record<string, unknown>,
      );
      normalizedProps[key] = originalRequired.has(key)
        ? normalizedChild
        : widenTypeWithNull(normalizedChild);
    }
    out.properties = normalizedProps;
    // OpenAI strict requires ALL property keys present in `required`.
    out.required = Object.keys(normalizedProps);
    out.additionalProperties = false;
  }

  if (out.items !== undefined) {
    const items = out.items;
    out.items = Array.isArray(items)
      ? items.map((v) =>
          normalizeOpenAiStrictSchema(v as Record<string, unknown>),
        )
      : normalizeOpenAiStrictSchema(items as Record<string, unknown>);
  }

  for (const keyword of ["anyOf", "oneOf", "allOf"] as const) {
    const branch = out[keyword];
    if (Array.isArray(branch)) {
      out[keyword] = branch.map((v) =>
        normalizeOpenAiStrictSchema(v as Record<string, unknown>),
      );
    }
  }

  return out;
}

/** OpenAI `response_format` wire shapes for structured output. */
type OpenAiResponseFormat =
  | { type: "json_object" }
  | {
      type: "json_schema";
      json_schema: {
        name: string;
        schema: Record<string, unknown>;
        strict: true;
      };
    };

/**
 * Map a router-resolved structured-output level to the OpenAI `response_format`
 * wire field. Returns `undefined` for `prompt` (and when unset), so the body
 * omits the field entirely — the engine handles prompt-coercion + validation
 * for that level and the adapter must not fake a native guarantee.
 */
export function toOpenAiResponseFormat(
  rf: ResolvedResponseFormat | undefined,
): OpenAiResponseFormat | undefined {
  if (!rf) {
    return undefined;
  }
  if (rf.level === "json_schema") {
    return {
      type: "json_schema",
      json_schema: {
        name: rf.name,
        // OpenAI strict requires additionalProperties:false + required-all on
        // every object node; normalize before sending or it hard-400s.
        schema: normalizeOpenAiStrictSchema(
          (rf.schema ?? {}) as Record<string, unknown>,
        ),
        strict: true,
      },
    };
  }
  if (rf.level === "json_object") {
    return { type: "json_object" };
  }
  // level === "prompt": no native field.
  return undefined;
}

export interface OpenAiCompatConfig {
  id: Provider["id"];
  name: string;
  color: string;
  priority: number;
  keyRegex: RegExp | null;
  defaultModel: string;
  baseUrl: string | (() => string);
  includeRateLimit?: boolean;
  validatePath?: string;
  /** Provider supports OpenRouter-style `openrouter:web_search` tool calls. */
  supportsNativeWebSearch?: boolean;
  /**
   * LOCAL runtimes only (LM Studio): `defaultModel` is a placeholder, not a
   * real catalog id — resolve it against GET {baseUrl}/models (first loaded
   * model) whenever the caller didn't pin a concrete model. Cloud providers
   * must NOT set this: their defaultModel is a real model.
   */
  dynamicLocalDefault?: boolean;
}

export function createOpenAiCompatProvider(
  config: OpenAiCompatConfig,
): Provider {
  const {
    id,
    name,
    color,
    priority,
    keyRegex,
    defaultModel,
    baseUrl: baseUrlOption,
    includeRateLimit = false,
    validatePath = "/models",
    supportsNativeWebSearch = false,
    dynamicLocalDefault = false,
  } = config;

  // Resolve per CALL so env overrides (tests, user config) apply after import —
  // a captured-at-import URL made the engine suite depend on whatever happened
  // to listen on the default port.
  const baseUrl = () =>
    typeof baseUrlOption === "function" ? baseUrlOption() : baseUrlOption;

  // 30s-cached first-loaded-model lookup for dynamicLocalDefault runtimes.
  let cachedLocalModel: { at: number; model: string | null } | null = null;
  async function resolveLocalDefault(): Promise<string | null> {
    if (cachedLocalModel && Date.now() - cachedLocalModel.at < 30_000) {
      return cachedLocalModel.model;
    }
    try {
      const res = await fetch(`${baseUrl()}/models`);
      if (!res.ok) return null;
      const data = (await res.json()) as { data?: Array<{ id?: string }> };
      const model = data.data?.find((m) => typeof m.id === "string" && m.id)?.id ?? null;
      cachedLocalModel = { at: Date.now(), model };
      return model;
    } catch {
      return null;
    }
  }

  return {
    id,
    name,
    color,
    priority,
    keyRegex,
    defaultModel,

    async streamChat(
      messages: ChatMessage[],
      options: StreamChatOptions = {},
    ): Promise<StreamChatResult> {
      const apiKey = options.apiKey;
      if (keyRegex && !apiKey) {
        throw new Error(`${name} requires an API key`);
      }

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (apiKey) {
        headers.Authorization = `Bearer ${apiKey}`;
      }

      // Build a SINGLE `tools` array, merging any OpenRouter web_search tool
      // with the caller's function tools — never let one overwrite the other.
      const tools: Array<OpenAiFunctionTool | Record<string, unknown>> = [];
      if (options.webSearch && supportsNativeWebSearch) {
        // OpenRouter native web search (Exa fallback under the hood). Other
        // OpenAI-compatible providers don't set this.
        tools.push({ type: "openrouter:web_search", engine: "auto" });
      }
      const hasFunctionTools = (options.tools?.length ?? 0) > 0;
      if (options.tools && hasFunctionTools) {
        tools.push(...toOpenAiFunctionTools(options.tools));
      }
      // `tool_choice` only travels alongside function tools.
      const toolChoice = hasFunctionTools
        ? toOpenAiToolChoice(options.toolChoice)
        : undefined;

      // Structured output: the router already resolved the caller's request to
      // the level THIS model can serve, so we only emit the native field for the
      // level we're handed. `prompt` emits nothing — the engine does the
      // prompt-coercion + validation and the adapter must not pretend.
      const responseFormat = toOpenAiResponseFormat(options.responseFormat);

      // Same substitution contract as the Ollama provider: only OUR placeholder
      // is resolved against what the local runtime actually loaded; a model the
      // user pinned explicitly still errors honestly.
      let model = options.model ?? defaultModel;
      if (dynamicLocalDefault && (!options.model || options.model === defaultModel)) {
        const resolved = await resolveLocalDefault();
        if (resolved) {
          model = resolved;
        } else if (cachedLocalModel?.model === null) {
          throw new Error(
            `${name} is running but has no model loaded — load one in the ${name} UI first.`,
          );
        }
      }

      const response = await fetch(`${baseUrl()}/chat/completions`, {
        method: "POST",
        headers,
        signal: options.signal,
        body: JSON.stringify({
          model,
          messages: toOpenAiMessages(messages),
          stream: true,
          // Ask OpenAI-compatible providers to emit a final usage chunk so we
          // record real token counts instead of estimating. Providers that do
          // not support this field ignore it.
          stream_options: { include_usage: true },
          ...(tools.length > 0 ? { tools } : {}),
          ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
          ...(responseFormat !== undefined
            ? { response_format: responseFormat }
            : {}),
          temperature: options.temperature,
          max_tokens: options.maxTokens,
        }),
      });

      const parseRateLimit = includeRateLimit
        ? parseGroqRateLimitHeaders
        : undefined;
      await assertOkResponse(response, name, parseRateLimit);

      const rateLimit: RateLimitInfo | undefined = includeRateLimit
        ? parseGroqRateLimitHeaders(response.headers)
        : undefined;

      if (!response.body) {
        throw new Error(`${name} returned an empty response body`);
      }

      const baseStream = parseOpenAiSseStream(response.body);
      const stream = includeRateLimit
        ? (async function* () {
            for await (const chunk of baseStream) {
              yield rateLimit ? { ...chunk, rateLimit } : chunk;
            }
          })()
        : baseStream;

      return { stream, rateLimit };
    },

    async validateKey(key: string): Promise<boolean> {
      if (keyRegex && !keyRegex.test(key)) {
        return false;
      }

      if (!keyRegex) {
        return true;
      }

      return validateWithFetch(`${baseUrl()}${validatePath}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${key}` },
      });
    },
  };
}
