import type {
  ChatMessage,
  ContentBlock,
  JsonSchema,
  Provider,
  StreamChatOptions,
  StreamChatResult,
  StreamChunk,
  ToolChoice,
} from "@zintus/types";
import { isContentBlockArray, textOf } from "@zintus/types";
import { assertOkResponse, validateWithFetch } from "../utils.js";
import { usageFromProviderFields } from "../token-estimate.js";

const GEMINI_BASE =
  "https://generativelanguage.googleapis.com/v1beta/models";

type GeminiPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } }
  | { functionCall: { name: string; args: Record<string, unknown> } }
  | { functionResponse: { name: string; response: { result: unknown } } };

/** JSON-Schema keywords Gemini's OpenAPI-3 `Schema` subset truly REJECTS — these
 *  are the ONLY keys stripped. We switched from an allow-list to this strip-list
 *  so legal-but-uncommon keywords Gemini DOES accept (`pattern`, `minLength`,
 *  `maxLength`, `multipleOf`, `exclusiveMinimum/Maximum`, …) survive rather than
 *  silently degrading the constrained decode (a stripped constraint = wasted
 *  repair round-trips). `oneOf` is REMAPPED to `anyOf` (Gemini's Schema has no
 *  `oneOf`/`allOf`, only `anyOf`). `$ref` cannot be resolved here so it is
 *  stripped — UNLESS that would empty the node, in which case the bare `$ref` is
 *  left intact rather than emitting a typeless `{}` that Gemini 400s. */
const STRIPPED_SCHEMA_KEYS = new Set([
  "$schema",
  "$id",
  "$ref",
  "additionalProperties",
]);

/** Translate a JSON Schema into Gemini's OpenAPI subset: strip only the keywords
 *  Gemini rejects, remap `oneOf`→`anyOf`, and recurse into `properties`, `items`,
 *  and `anyOf`/`oneOf`/`allOf` branches. Never emits a typeless node for a legal
 *  `oneOf`/`$ref` schema (the old allow-list collapsed those to `{}` → Gemini
 *  400, which does NOT fail over). Pure transform — never mutates the input. */
export function normalizeSchema(schema: JsonSchema): JsonSchema {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (STRIPPED_SCHEMA_KEYS.has(key)) continue;
    if (key === "properties" && value && typeof value === "object") {
      const props: Record<string, unknown> = {};
      for (const [propName, propSchema] of Object.entries(
        value as Record<string, JsonSchema>,
      )) {
        props[propName] = normalizeSchema(propSchema);
      }
      out[key] = props;
    } else if (key === "items") {
      // Gemini's `items` MUST be a single Schema, never a JSON-Schema tuple
      // array — collapse a tuple `items:[a,b]` to its first element's schema
      // (and drop an empty tuple) so an array never reaches the wire.
      if (Array.isArray(value)) {
        if (value.length > 0) {
          out[key] = normalizeSchema(value[0] as JsonSchema);
        }
      } else {
        out[key] = normalizeSchema(value as JsonSchema);
      }
    } else if (key === "oneOf" && Array.isArray(value)) {
      // Gemini has no `oneOf` — emit the union as `anyOf`, which it accepts, so a
      // discriminated-union schema constrains decoding instead of 400-ing.
      out.anyOf = value.map((v) => normalizeSchema(v as JsonSchema));
    } else if ((key === "anyOf" || key === "allOf") && Array.isArray(value)) {
      out[key] = value.map((v) => normalizeSchema(v as JsonSchema));
    } else {
      out[key] = value;
    }
  }
  // A node that was nothing but an unresolvable `$ref` would collapse to a
  // typeless `{}` here — which Gemini rejects. Keep the original `$ref` so the
  // request still carries the reference rather than 400-ing opaquely.
  if (
    Object.keys(out).length === 0 &&
    typeof (schema as Record<string, unknown>).$ref === "string"
  ) {
    return { $ref: (schema as Record<string, unknown>).$ref } as JsonSchema;
  }
  return out as JsonSchema;
}

/** Map our internal `ToolChoice` to Gemini's `functionCallingConfig`. */
function geminiFunctionCallingConfig(toolChoice: ToolChoice) {
  if (toolChoice === "auto") return { mode: "AUTO" };
  if (toolChoice === "required") return { mode: "ANY" };
  if (toolChoice === "none") return { mode: "NONE" };
  // { type: "tool"; name } — force a specific function.
  return { mode: "ANY", allowedFunctionNames: [toolChoice.name] };
}

/** Recover a function name from a synthesized id (`call_<name>_<index>`) when no
 *  prior call mapped it. The name may itself contain underscores, so match the
 *  trailing `_<digits>` index lazily. */
function nameFromSynthId(id: string): string {
  const match = /^call_(.+)_\d+$/.exec(id);
  return match ? match[1]! : id;
}

/** Build a `toolCallId → function name` map from the assistant `functionCall`s
 *  earlier in the SAME messages array. Gemini correlates tool results by NAME,
 *  not id, so a later `tool_result` block resolves its function via this map. */
function buildToolNameMap(messages: ChatMessage[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const message of messages) {
    if (message.role === "assistant" && isContentBlockArray(message.content)) {
      for (const block of message.content) {
        if (block.type === "tool_call") map.set(block.id, block.name);
      }
    }
  }
  return map;
}

function resolveToolName(
  toolCallId: string,
  nameById: Map<string, string>,
): string {
  return nameById.get(toolCallId) ?? nameFromSynthId(toolCallId);
}

/** Map a USER message's content to Gemini parts — text → {text}, image →
 *  {inlineData}, tool_result → {functionResponse}, order preserved. */
function userParts(
  content: string | ContentBlock[],
  nameById: Map<string, string>,
): GeminiPart[] {
  if (typeof content === "string") return [{ text: content }];
  return content.map((block) => {
    if (block.type === "image") {
      return { inlineData: { mimeType: block.mimeType, data: block.data } };
    }
    if (block.type === "tool_result") {
      // Gemini wants the result under `response`; parse JSON when the client
      // stringified a structured payload, else pass the raw string.
      let result: unknown = block.content;
      try {
        result = JSON.parse(block.content);
      } catch {
        // Keep the raw string when it is not JSON.
      }
      return {
        functionResponse: {
          name: resolveToolName(block.toolCallId, nameById),
          response: { result },
        },
      };
    }
    if (block.type === "tool_call") {
      return {
        functionCall: { name: block.name, args: block.arguments },
      };
    }
    return { text: block.text };
  });
}

/** Map an ASSISTANT (`model`) message's content to Gemini parts — text → {text},
 *  tool_call → {functionCall}, alongside any text, order preserved. */
function assistantParts(content: string | ContentBlock[]): GeminiPart[] {
  if (typeof content === "string") return [{ text: content }];
  const parts: GeminiPart[] = [];
  for (const block of content) {
    if (block.type === "text") {
      parts.push({ text: block.text });
    } else if (block.type === "tool_call") {
      parts.push({ functionCall: { name: block.name, args: block.arguments } });
    }
    // image/tool_result are not valid on an assistant turn — ignore.
  }
  return parts.length ? parts : [{ text: "" }];
}

/** Shared empty map for the common no-tool path — `userParts` only ever READS
 *  it (inside the `tool_result` branch), so a single immutable instance is safe
 *  and avoids a per-request allocation. */
const EMPTY_NAME_MAP: Map<string, string> = new Map();

export function splitGeminiMessages(messages: ChatMessage[]) {
  // The id→name map is only consulted to resolve a `tool_result`'s function
  // name. Skip the per-message/per-block walk that builds it on the common case
  // (plain chat with no tool turns) — that cost scales with conversation length.
  const hasToolTurns = messages.some(
    (message) =>
      isContentBlockArray(message.content) &&
      message.content.some(
        (block) => block.type === "tool_call" || block.type === "tool_result",
      ),
  );
  const nameById = hasToolTurns ? buildToolNameMap(messages) : EMPTY_NAME_MAP;
  const systemParts = messages
    .filter((message) => message.role === "system")
    .map((message) => {
      // Images are not allowed in a system message — reject, never silently drop.
      if (
        isContentBlockArray(message.content) &&
        message.content.some((block) => block.type === "image")
      ) {
        throw new Error("Image content is not allowed in a system message");
      }
      return textOf(message.content);
    });
  const contents = messages
    .filter((message) => message.role !== "system")
    .map((message) => ({
      role: message.role === "assistant" ? "model" : "user",
      // Assistant turns carry text + functionCall; user turns carry text +
      // images + functionResponse.
      parts:
        message.role === "assistant"
          ? assistantParts(message.content)
          : userParts(message.content, nameById),
    }));

  return {
    systemInstruction: systemParts.length
      ? { parts: [{ text: systemParts.join("\n\n") }] }
      : undefined,
    contents,
  };
}

export async function* parseGeminiSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<StreamChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  // Gemini issues no call ids — synthesize `call_<name>_<index>` where index is
  // the count of functionCalls seen across this whole stream.
  let functionCallIndex = 0;
  let sawFunctionCall = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) {
          continue;
        }

        const data = trimmed.slice(5).trim();
        if (!data) {
          continue;
        }

        try {
          const parsed = JSON.parse(data) as {
            candidates?: Array<{
              content?: {
                parts?: Array<{
                  text?: string;
                  functionCall?: { name: string; args?: Record<string, unknown> };
                }>;
              };
              finishReason?: string;
            }>;
            usageMetadata?: {
              promptTokenCount?: number;
              candidatesTokenCount?: number;
              totalTokenCount?: number;
            };
          };
          const candidate = parsed.candidates?.[0];
          // Iterate ALL parts: text parts stream as content, functionCall parts
          // become synthesized tool calls.
          for (const part of candidate?.content?.parts ?? []) {
            if (typeof part.text === "string" && part.text) {
              yield { content: part.text };
            } else if (part.functionCall) {
              const name = part.functionCall.name;
              const id = `call_${name}_${functionCallIndex}`;
              functionCallIndex += 1;
              sawFunctionCall = true;
              yield {
                toolCall: {
                  type: "tool_call",
                  id,
                  name,
                  arguments: part.functionCall.args ?? {},
                },
              };
            }
          }
          // Gemini may report finishReason "STOP" even with a functionCall
          // present — when any call was emitted this stream, the turn ended to
          // await tool results.
          if (candidate?.finishReason) {
            if (sawFunctionCall) {
              yield { finishReason: "tool_calls" };
            } else if (candidate.finishReason === "STOP") {
              yield { finishReason: "stop" };
            } else if (candidate.finishReason === "MAX_TOKENS") {
              yield { finishReason: "length" };
            } else if (candidate.finishReason === "SAFETY") {
              yield { finishReason: "content_filter" };
            }
          }
          if (parsed.usageMetadata) {
            const usage = usageFromProviderFields({
              inputTokens: parsed.usageMetadata.promptTokenCount,
              outputTokens: parsed.usageMetadata.candidatesTokenCount,
              totalTokens: parsed.usageMetadata.totalTokenCount,
            });
            if (usage) {
              yield { usage };
            }
          }
        } catch {
          // Skip malformed SSE chunks.
        }
      }
    }

    yield { done: true };
  } finally {
    reader.releaseLock();
  }
}

export const geminiProvider: Provider = {
  id: "gemini",
  name: "Gemini",
  color: "#3B82F6",
  priority: 3,
  keyRegex: /^AIza[a-zA-Z0-9_-]{35}/,
  defaultModel: "gemini-2.5-flash",

  async streamChat(
    messages: ChatMessage[],
    options: StreamChatOptions = {},
  ): Promise<StreamChatResult> {
    const apiKey = options.apiKey;
    if (!apiKey) {
      throw new Error("Gemini requires an API key");
    }

    const model = options.model ?? geminiProvider.defaultModel;
    const url = `${GEMINI_BASE}/${model}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;

    // `tools` is a single array shared by native search grounding and function
    // declarations — they co-exist, so MERGE rather than overwrite.
    const geminiTools: Array<Record<string, unknown>> = [];
    if (options.webSearch) {
      // Native Google Search grounding (free on 2.5 Flash) when requested.
      geminiTools.push({ googleSearch: {} });
    }
    if (options.tools?.length) {
      geminiTools.push({
        functionDeclarations: options.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: normalizeSchema(tool.parameters),
        })),
      });
    }
    const toolConfig = options.tools?.length
      ? {
          functionCallingConfig: geminiFunctionCallingConfig(
            options.toolChoice ?? "auto",
          ),
        }
      : undefined;

    // Structured output: the router already resolved the caller's request to the
    // level this model can serve. Both levels ask Gemini for JSON via
    // `responseMimeType`; `json_schema` additionally constrains decoding with a
    // normalized `responseSchema` (Gemini's OpenAPI subset). `prompt` emits
    // nothing — the engine handles coercion + validation. Merge into
    // generationConfig WITHOUT clobbering temperature/maxOutputTokens.
    const structuredConfig: Record<string, unknown> = {};
    if (options.responseFormat?.level === "json_schema") {
      structuredConfig.responseMimeType = "application/json";
      if (options.responseFormat.schema) {
        structuredConfig.responseSchema = normalizeSchema(
          options.responseFormat.schema,
        );
      }
    } else if (options.responseFormat?.level === "json_object") {
      structuredConfig.responseMimeType = "application/json";
    }

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: options.signal,
      body: JSON.stringify({
        ...splitGeminiMessages(messages),
        cachedContent: options.cacheHints?.cachedContentHandle,
        ...(geminiTools.length ? { tools: geminiTools } : {}),
        ...(toolConfig ? { toolConfig } : {}),
        generationConfig: {
          temperature: options.temperature,
          maxOutputTokens: options.maxTokens,
          ...structuredConfig,
        },
      }),
    });

    await assertOkResponse(response, "Gemini");

    if (!response.body) {
      throw new Error("Gemini returned an empty response body");
    }

    return { stream: parseGeminiSseStream(response.body) };
  },

  async validateKey(key: string): Promise<boolean> {
    if (!geminiProvider.keyRegex?.test(key)) {
      return false;
    }

    return validateWithFetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`,
      { method: "GET" },
    );
  },
};
