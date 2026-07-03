import { afterEach, describe, expect, test } from "bun:test";
import type { StreamChunk } from "@zintus/types";
import {
  geminiProvider,
  normalizeSchema,
  parseGeminiSseStream,
  splitGeminiMessages,
} from "./gemini.js";

/** Build a mock SSE ReadableStream from raw SSE text frames. */
function sseStream(frames: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
}

async function collect(
  gen: AsyncGenerator<StreamChunk>,
): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const chunk of gen) out.push(chunk);
  return out;
}

const img = (
  data: string,
  mimeType: "image/png" | "image/jpeg" = "image/png",
) => ({ type: "image" as const, data, mimeType, bytes: 100, exifStripped: true as const });

describe("splitGeminiMessages — vision mapping", () => {
  test("text-only messages map to {text} parts (unchanged)", () => {
    const out = splitGeminiMessages([{ role: "user", content: "hello" }]);
    expect(out.contents).toEqual([{ role: "user", parts: [{ text: "hello" }] }]);
    expect(out.systemInstruction).toBeUndefined();
  });

  test("a user text + image message becomes text + inlineData parts", () => {
    const out = splitGeminiMessages([
      {
        role: "user",
        content: [{ type: "text", text: "what is this?" }, img("AAA")],
      },
    ]);
    expect(out.contents[0]!.parts).toEqual([
      { text: "what is this?" },
      { inlineData: { mimeType: "image/png", data: "AAA" } },
    ]);
  });

  test("multiple images are included in order", () => {
    const out = splitGeminiMessages([
      { role: "user", content: [img("A"), img("B", "image/jpeg")] },
    ]);
    expect(out.contents[0]!.parts).toEqual([
      { inlineData: { mimeType: "image/png", data: "A" } },
      { inlineData: { mimeType: "image/jpeg", data: "B" } },
    ]);
  });

  test("system messages still go to systemInstruction (text)", () => {
    const out = splitGeminiMessages([
      { role: "system", content: "be terse" },
      { role: "user", content: "hi" },
    ]);
    expect(out.systemInstruction).toEqual({ parts: [{ text: "be terse" }] });
    expect(out.contents).toEqual([{ role: "user", parts: [{ text: "hi" }] }]);
  });

  test("an image in a system message is rejected (never silently dropped)", () => {
    expect(() =>
      splitGeminiMessages([
        { role: "system", content: [{ type: "text", text: "x" }, img("Z")] },
      ]),
    ).toThrow(/system message/);
  });

  test("assistant turns stay text-only", () => {
    const out = splitGeminiMessages([
      { role: "assistant", content: "prior answer" },
      { role: "user", content: "follow up" },
    ]);
    expect(out.contents[0]).toEqual({
      role: "model",
      parts: [{ text: "prior answer" }],
    });
  });
});

describe("splitGeminiMessages — tool mapping", () => {
  test("assistant tool_call → functionCall, user tool_result → functionResponse with resolved name", () => {
    const out = splitGeminiMessages([
      { role: "user", content: "weather in Paris?" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "checking" },
          {
            type: "tool_call",
            id: "call_get_weather_0",
            name: "get_weather",
            arguments: { city: "Paris" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolCallId: "call_get_weather_0",
            content: '{"tempC":21}',
          },
        ],
      },
    ]);

    // Assistant turn: text + functionCall parts.
    expect(out.contents[1]).toEqual({
      role: "model",
      parts: [
        { text: "checking" },
        { functionCall: { name: "get_weather", args: { city: "Paris" } } },
      ],
    });

    // User turn: functionResponse with the name resolved via the prior call,
    // and a JSON-parsed result payload.
    expect(out.contents[2]).toEqual({
      role: "user",
      parts: [
        {
          functionResponse: {
            name: "get_weather",
            response: { result: { tempC: 21 } },
          },
        },
      ],
    });
  });

  test("tool_result name falls back to parsing the synthesized id", () => {
    // No assistant call in this array — name must come from the id format.
    const out = splitGeminiMessages([
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolCallId: "call_search_docs_2",
            content: "raw text result",
          },
        ],
      },
    ]);
    expect(out.contents[0]!.parts).toEqual([
      {
        functionResponse: {
          name: "search_docs",
          // Non-JSON content is passed through as the raw string.
          response: { result: "raw text result" },
        },
      },
    ]);
  });

  test("no tool turns → name map is skipped, plain chat maps unchanged", () => {
    // The id→name map (a per-message/per-block walk) is only built when a
    // tool_call/tool_result block is present. A plain text-only conversation
    // takes the skip path and maps to text parts exactly as before.
    const out = splitGeminiMessages([
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: [{ type: "text", text: "hi there" }],
      },
      { role: "user", content: "thanks" },
    ]);

    expect(out.contents).toEqual([
      { role: "user", parts: [{ text: "hello" }] },
      { role: "model", parts: [{ text: "hi there" }] },
      { role: "user", parts: [{ text: "thanks" }] },
    ]);
  });
});

describe("normalizeSchema", () => {
  test("strips $schema / additionalProperties and recurses", () => {
    const normalized = normalizeSchema({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "urn:tool",
      type: "object",
      additionalProperties: false,
      required: ["city"],
      properties: {
        city: {
          type: "string",
          description: "City name",
          additionalProperties: false,
        },
        opts: {
          type: "array",
          items: { type: "string", $ref: "#/x" },
        },
      },
    });

    expect(normalized).toEqual({
      type: "object",
      required: ["city"],
      properties: {
        city: { type: "string", description: "City name" },
        opts: { type: "array", items: { type: "string" } },
      },
    });
  });

  test("keeps Gemini-supported format/nullable/anyOf/bounds/enum/default", () => {
    const normalized = normalizeSchema({
      type: "object",
      properties: {
        when: { type: "string", format: "date-time", nullable: true },
        count: { type: "integer", minimum: 0, maximum: 10, default: 1 },
        tags: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 5 },
        status: { type: "string", enum: ["on", "off"] },
        value: {
          anyOf: [
            { type: "string" },
            { type: "number", $ref: "#/x" },
          ],
        },
      },
    });

    expect(normalized).toEqual({
      type: "object",
      properties: {
        when: { type: "string", format: "date-time", nullable: true },
        count: { type: "integer", minimum: 0, maximum: 10, default: 1 },
        tags: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 5 },
        status: { type: "string", enum: ["on", "off"] },
        // anyOf branches are recursed (the $ref inside is stripped), the union
        // node keeps its type info instead of collapsing to description-only.
        value: { anyOf: [{ type: "string" }, { type: "number" }] },
      },
    });
  });

  test("collapses tuple-form items to a single schema (Gemini rejects arrays)", () => {
    const normalized = normalizeSchema({
      type: "array",
      items: [
        { type: "string", additionalProperties: false },
        { type: "number" },
      ],
    });

    // Tuple `items:[a,b]` collapses to the first element's normalized schema —
    // never an array on the wire.
    expect(normalized).toEqual({ type: "array", items: { type: "string" } });
    expect(Array.isArray((normalized as Record<string, unknown>).items)).toBe(
      false,
    );
  });

  test("drops an empty tuple items array entirely", () => {
    const normalized = normalizeSchema({ type: "array", items: [] });
    expect(normalized).toEqual({ type: "array" });
  });

  test("remaps oneOf → anyOf (Gemini has no oneOf) and recurses into branches", () => {
    const normalized = normalizeSchema({
      oneOf: [
        { type: "string", additionalProperties: false },
        { type: "object", properties: { n: { type: "number", $ref: "#/x" } } },
      ],
    });

    // The union node is preserved as `anyOf` (Gemini accepts it) instead of
    // collapsing to a typeless `{}` that 400s. Branches are normalized too.
    expect(normalized).toEqual({
      anyOf: [
        { type: "string" },
        { type: "object", properties: { n: { type: "number" } } },
      ],
    });
    expect(normalized).not.toHaveProperty("oneOf");
  });

  test("keeps Gemini-supported string/number constraints (pattern, length, multipleOf)", () => {
    const normalized = normalizeSchema({
      type: "object",
      properties: {
        code: { type: "string", pattern: "^[A-Z]{3}$", minLength: 3, maxLength: 3 },
        qty: { type: "number", multipleOf: 0.5, exclusiveMinimum: 0 },
      },
    });

    // These were silently stripped by the old allow-list — now they survive so
    // the constrained decode is as tight as the schema asks (fewer repair loops).
    expect(normalized).toEqual({
      type: "object",
      properties: {
        code: { type: "string", pattern: "^[A-Z]{3}$", minLength: 3, maxLength: 3 },
        qty: { type: "number", multipleOf: 0.5, exclusiveMinimum: 0 },
      },
    });
  });

  test("a bare $ref node is preserved, not emptied to a typeless {}", () => {
    // Stripping `$ref` would leave `{}` (typeless → Gemini 400). Keep the ref so
    // the request still carries the reference instead of failing opaquely.
    const normalized = normalizeSchema({ $ref: "#/$defs/Address" });
    expect(normalized).toEqual({ $ref: "#/$defs/Address" });
  });

  test("strips $ref when the node carries other type info (no typeless risk)", () => {
    const normalized = normalizeSchema({ type: "string", $ref: "#/$defs/X" });
    expect(normalized).toEqual({ type: "string" });
  });
});

describe("gemini streamChat — generationConfig structured output", () => {
  const realFetch = globalThis.fetch;
  let lastBody: Record<string, unknown> | undefined;
  const apiKey = "AIza" + "a".repeat(35);

  function stubFetch() {
    lastBody = undefined;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      lastBody = JSON.parse(init.body as string);
      return new Response("data: [DONE]\n\n", { status: 200 });
    }) as typeof fetch;
  }

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const genConfig = () =>
    lastBody?.generationConfig as Record<string, unknown> | undefined;

  test("json_schema level sets responseMimeType + normalized responseSchema", async () => {
    stubFetch();
    await geminiProvider.streamChat([{ role: "user", content: "hi" }], {
      apiKey,
      temperature: 0.4,
      maxTokens: 256,
      responseFormat: {
        level: "json_schema",
        name: "person",
        schema: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          additionalProperties: false,
          required: ["name"],
          properties: { name: { type: "string" } },
        },
      },
    });

    // responseSchema is normalized (Gemini-rejected keywords stripped) and
    // temperature/maxOutputTokens are preserved alongside it.
    expect(genConfig()).toEqual({
      temperature: 0.4,
      maxOutputTokens: 256,
      responseMimeType: "application/json",
      responseSchema: {
        type: "object",
        required: ["name"],
        properties: { name: { type: "string" } },
      },
    });
  });

  test("json_object level sets responseMimeType only (no responseSchema)", async () => {
    stubFetch();
    await geminiProvider.streamChat([{ role: "user", content: "hi" }], {
      apiKey,
      responseFormat: { level: "json_object", name: "x" },
    });
    expect(genConfig()?.responseMimeType).toBe("application/json");
    expect(genConfig()).not.toHaveProperty("responseSchema");
  });

  test("prompt level adds neither responseMimeType nor responseSchema", async () => {
    stubFetch();
    await geminiProvider.streamChat([{ role: "user", content: "hi" }], {
      apiKey,
      responseFormat: { level: "prompt", name: "x" },
    });
    expect(genConfig()).not.toHaveProperty("responseMimeType");
    expect(genConfig()).not.toHaveProperty("responseSchema");
  });

  test("no responseFormat leaves generationConfig structured fields unset", async () => {
    stubFetch();
    await geminiProvider.streamChat([{ role: "user", content: "hi" }], {
      apiKey,
    });
    expect(genConfig()).not.toHaveProperty("responseMimeType");
    expect(genConfig()).not.toHaveProperty("responseSchema");
  });
});

describe("parseGeminiSseStream — tool calls", () => {
  test("a functionCall part yields a toolCall with synthesized id + parsed args + finishReason tool_calls", async () => {
    const chunks = await collect(
      parseGeminiSseStream(
        sseStream([
          `data: ${JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      functionCall: {
                        name: "get_weather",
                        args: { city: "Paris" },
                      },
                    },
                  ],
                },
                finishReason: "STOP",
              },
            ],
          })}\n\n`,
        ]),
      ),
    );

    const toolCall = chunks.find((c) => c.toolCall)?.toolCall;
    expect(toolCall).toEqual({
      type: "tool_call",
      id: "call_get_weather_0",
      name: "get_weather",
      arguments: { city: "Paris" },
    });
    expect(chunks.some((c) => c.finishReason === "tool_calls")).toBe(true);
    expect(chunks.at(-1)).toEqual({ done: true });
  });

  test("text streaming still works (STOP → finishReason stop)", async () => {
    const chunks = await collect(
      parseGeminiSseStream(
        sseStream([
          `data: ${JSON.stringify({
            candidates: [{ content: { parts: [{ text: "hello " }] } }],
          })}\n`,
          `data: ${JSON.stringify({
            candidates: [
              { content: { parts: [{ text: "world" }] }, finishReason: "STOP" },
            ],
          })}\n`,
        ]),
      ),
    );

    expect(chunks.filter((c) => c.content).map((c) => c.content)).toEqual([
      "hello ",
      "world",
    ]);
    expect(chunks.some((c) => c.finishReason === "stop")).toBe(true);
    expect(chunks.some((c) => c.finishReason === "tool_calls")).toBe(false);
  });

  test("missing args default to an empty object", async () => {
    const chunks = await collect(
      parseGeminiSseStream(
        sseStream([
          `data: ${JSON.stringify({
            candidates: [
              {
                content: { parts: [{ functionCall: { name: "ping" } }] },
                finishReason: "STOP",
              },
            ],
          })}\n`,
        ]),
      ),
    );
    expect(chunks.find((c) => c.toolCall)?.toolCall).toEqual({
      type: "tool_call",
      id: "call_ping_0",
      name: "ping",
      arguments: {},
    });
  });
});

describe("parseGeminiSseStream — usage metadata details", () => {
  test("surfaces thoughts and cached-content token counts when reported", async () => {
    const chunks = await collect(
      parseGeminiSseStream(
        sseStream([
          `data: ${JSON.stringify({
            candidates: [
              { content: { parts: [{ text: "hi" }] }, finishReason: "STOP" },
            ],
            usageMetadata: {
              promptTokenCount: 40,
              candidatesTokenCount: 10,
              totalTokenCount: 50,
              thoughtsTokenCount: 6,
              cachedContentTokenCount: 25,
            },
          })}\n\n`,
        ]),
      ),
    );

    const usage = chunks.find((c) => c.usage)?.usage;
    expect(usage?.inputTokens).toBe(40);
    expect(usage?.reasoningTokens).toBe(6);
    expect(usage?.cacheReadTokens).toBe(25);
    expect(usage?.cacheWriteTokens).toBeUndefined();
  });

  test("detail fields stay absent when usageMetadata omits them", async () => {
    const chunks = await collect(
      parseGeminiSseStream(
        sseStream([
          `data: ${JSON.stringify({
            candidates: [
              { content: { parts: [{ text: "hi" }] }, finishReason: "STOP" },
            ],
            usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2 },
          })}\n\n`,
        ]),
      ),
    );

    const usage = chunks.find((c) => c.usage)?.usage;
    expect(usage).toBeDefined();
    expect("reasoningTokens" in (usage ?? {})).toBe(false);
    expect("cacheReadTokens" in (usage ?? {})).toBe(false);
  });
});
