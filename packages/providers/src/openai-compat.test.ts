import { afterEach, describe, expect, test } from "bun:test";
import type { ChatMessage, ResolvedResponseFormat } from "@zintus/types";
import {
  createOpenAiCompatProvider,
  normalizeOpenAiStrictSchema,
  toOpenAiMessages,
  toOpenAiResponseFormat,
} from "./openai-compat.js";

describe("toOpenAiMessages", () => {
  test("passes plain string content through unchanged", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hello" },
    ];

    expect(toOpenAiMessages(messages)).toEqual([
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hello" },
    ]);
  });

  test("collapses a text-only block array to joined text", () => {
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "line one" },
          { type: "text", text: "line two" },
        ],
      },
    ];

    expect(toOpenAiMessages(messages)).toEqual([
      { role: "user", content: "line one\nline two" },
    ]);
  });

  test("maps an assistant tool_call turn to tool_calls shape", () => {
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: "call_1",
            name: "get_weather",
            arguments: { city: "Paris" },
          },
        ],
      },
    ];

    expect(toOpenAiMessages(messages)).toEqual([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "get_weather",
              arguments: JSON.stringify({ city: "Paris" }),
            },
          },
        ],
      },
    ]);
  });

  test("keeps assistant text alongside tool_calls", () => {
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me check." },
          {
            type: "tool_call",
            id: "call_1",
            name: "get_weather",
            arguments: { city: "Paris" },
          },
        ],
      },
    ];

    const [out] = toOpenAiMessages(messages);
    expect(out?.content).toBe("Let me check.");
    expect(out?.tool_calls).toHaveLength(1);
  });

  test("emits a separate role:tool message per tool_result", () => {
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolCallId: "call_1",
            content: "18C and sunny",
          },
        ],
      },
    ];

    expect(toOpenAiMessages(messages)).toEqual([
      { role: "tool", tool_call_id: "call_1", content: "18C and sunny" },
    ]);
  });

  test("maps an image block to an image_url data-URL content part", () => {
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "What is this?" },
          {
            type: "image",
            data: "QUJD",
            mimeType: "image/png",
            bytes: 3,
            exifStripped: true,
          },
        ],
      },
    ];

    expect(toOpenAiMessages(messages)).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "What is this?" },
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,QUJD" },
          },
        ],
      },
    ]);
  });

  test("preserves text/image ordering across multiple blocks", () => {
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "image",
            data: "AAA",
            mimeType: "image/jpeg",
            bytes: 2,
            exifStripped: true,
          },
          { type: "text", text: "between" },
          {
            type: "image",
            data: "BBB",
            mimeType: "image/webp",
            bytes: 2,
            exifStripped: true,
          },
        ],
      },
    ];

    const [out] = toOpenAiMessages(messages);
    expect(out?.content).toEqual([
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,AAA" } },
      { type: "text", text: "between" },
      { type: "image_url", image_url: { url: "data:image/webp;base64,BBB" } },
    ]);
  });

  test("a string-content image-less turn still passes through as a string", () => {
    expect(
      toOpenAiMessages([{ role: "user", content: "just text" }]),
    ).toEqual([{ role: "user", content: "just text" }]);
  });

  test("emits tool messages plus a user message for remaining text", () => {
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: [
          { type: "tool_result", toolCallId: "call_1", content: "result-a" },
          { type: "tool_result", toolCallId: "call_2", content: "result-b" },
          { type: "text", text: "thanks" },
        ],
      },
    ];

    expect(toOpenAiMessages(messages)).toEqual([
      { role: "tool", tool_call_id: "call_1", content: "result-a" },
      { role: "tool", tool_call_id: "call_2", content: "result-b" },
      { role: "user", content: "thanks" },
    ]);
  });

  test("a turn with BOTH image and tool_result keeps the image (never dropped)", () => {
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: [
          { type: "tool_result", toolCallId: "call_1", content: "tool output" },
          { type: "text", text: "and here is the picture" },
          {
            type: "image",
            data: "QUJD",
            mimeType: "image/png",
            bytes: 3,
            exifStripped: true,
          },
        ],
      },
    ];

    // The tool_result still emits its own role:"tool" message, AND the image is
    // preserved as image_url content parts rather than silently dropped.
    expect(toOpenAiMessages(messages)).toEqual([
      { role: "tool", tool_call_id: "call_1", content: "tool output" },
      {
        role: "user",
        content: [
          { type: "text", text: "and here is the picture" },
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,QUJD" },
          },
        ],
      },
    ]);
  });
});

describe("normalizeOpenAiStrictSchema", () => {
  test("adds additionalProperties:false and required-all, widening formerly-optional fields to allow null", () => {
    // An optional-field schema (only `name` required) would hard-400 under
    // strict:true. Normalization forces required = ALL property keys, and each
    // formerly-optional key's `type` is widened to include "null" so the model
    // isn't forced to fabricate a value (OpenAI's documented strict recipe).
    const normalized = normalizeOpenAiStrictSchema({
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string" },
        age: { type: "number" },
        address: {
          type: "object",
          properties: { city: { type: "string" }, zip: { type: "string" } },
        },
      },
    });

    expect(normalized).toEqual({
      type: "object",
      required: ["name", "age", "address"],
      additionalProperties: false,
      properties: {
        // `name` was required → unchanged.
        name: { type: "string" },
        // `age`/`address` were optional → required-all + null-widened.
        age: { type: ["number", "null"] },
        address: {
          type: ["object", "null"],
          required: ["city", "zip"],
          additionalProperties: false,
          // `address` had no `required`, so city/zip were optional → null too.
          properties: {
            city: { type: ["string", "null"] },
            zip: { type: ["string", "null"] },
          },
        },
      },
    });
  });

  test("required fields keep their narrow type; only optional fields gain null", () => {
    const normalized = normalizeOpenAiStrictSchema({
      type: "object",
      required: ["keep"],
      properties: {
        keep: { type: "string" },
        drop: { type: "integer" },
      },
    });
    expect(normalized).toEqual({
      type: "object",
      required: ["keep", "drop"],
      additionalProperties: false,
      properties: {
        keep: { type: "string" },
        drop: { type: ["integer", "null"] },
      },
    });
  });

  test("optional field with no `type` (anyOf union) is left un-widened", () => {
    const normalized = normalizeOpenAiStrictSchema({
      type: "object",
      properties: {
        u: { anyOf: [{ type: "string" }, { type: "number" }] },
      },
    });
    expect(normalized).toEqual({
      type: "object",
      required: ["u"],
      additionalProperties: false,
      // No single `type` to widen — union node untouched (branches still normalized).
      properties: {
        u: { anyOf: [{ type: "string" }, { type: "number" }] },
      },
    });
  });

  test("recurses into array items and does not mutate the input", () => {
    const input = {
      type: "object",
      properties: {
        tags: {
          type: "array",
          items: { type: "object", properties: { id: { type: "number" } } },
        },
      },
    };
    const before = JSON.stringify(input);
    const normalized = normalizeOpenAiStrictSchema(input);

    expect(
      (normalized.properties as Record<string, Record<string, unknown>>).tags
        .items,
    ).toEqual({
      type: "object",
      required: ["id"],
      additionalProperties: false,
      // `id` was optional inside the array item object → null-widened.
      properties: { id: { type: ["number", "null"] } },
    });
    // input untouched (pure transform).
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe("toOpenAiResponseFormat", () => {
  test("json_schema → response_format json_schema with strict + name + normalized schema", () => {
    const rf: ResolvedResponseFormat = {
      level: "json_schema",
      name: "weather",
      schema: { type: "object", properties: { temp: { type: "number" } } },
    };
    expect(toOpenAiResponseFormat(rf)).toEqual({
      type: "json_schema",
      json_schema: {
        name: "weather",
        // Normalized for OpenAI strict: additionalProperties:false + required-all,
        // and the optional `temp` is null-widened (it had no `required`).
        schema: {
          type: "object",
          required: ["temp"],
          additionalProperties: false,
          properties: { temp: { type: ["number", "null"] } },
        },
        strict: true,
      },
    });
  });

  test("json_object → response_format json_object (no schema)", () => {
    const rf: ResolvedResponseFormat = { level: "json_object", name: "x" };
    expect(toOpenAiResponseFormat(rf)).toEqual({ type: "json_object" });
  });

  test("prompt → undefined (adapter emits nothing)", () => {
    expect(
      toOpenAiResponseFormat({ level: "prompt", name: "x" }),
    ).toBeUndefined();
  });

  test("undefined → undefined", () => {
    expect(toOpenAiResponseFormat(undefined)).toBeUndefined();
  });
});

describe("openai-compat streamChat — response_format body field", () => {
  const realFetch = globalThis.fetch;
  let lastBody: Record<string, unknown> | undefined;

  // Stub fetch: capture the JSON body and return a minimal valid SSE response so
  // streamChat can build its result without a real network call.
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

  const provider = createOpenAiCompatProvider({
    id: "groq",
    name: "Test",
    color: "#000",
    priority: 1,
    keyRegex: null,
    defaultModel: "test-model",
    baseUrl: "https://example.test/v1",
  });

  test("json_schema level emits response_format json_schema strict (normalized)", async () => {
    stubFetch();
    await provider.streamChat([{ role: "user", content: "hi" }], {
      responseFormat: {
        level: "json_schema",
        name: "person",
        // Optional field `nick` (not in required) must survive as required-all.
        schema: {
          type: "object",
          required: ["name"],
          properties: {
            name: { type: "string" },
            nick: { type: "string" },
          },
        },
      },
    });
    expect(lastBody?.response_format).toEqual({
      type: "json_schema",
      json_schema: {
        name: "person",
        schema: {
          type: "object",
          required: ["name", "nick"],
          additionalProperties: false,
          properties: {
            name: { type: "string" },
            // `nick` was optional → kept required but widened to allow null.
            nick: { type: ["string", "null"] },
          },
        },
        strict: true,
      },
    });
  });

  test("json_object level emits response_format json_object", async () => {
    stubFetch();
    await provider.streamChat([{ role: "user", content: "hi" }], {
      responseFormat: { level: "json_object", name: "x" },
    });
    expect(lastBody?.response_format).toEqual({ type: "json_object" });
  });

  test("prompt level emits no response_format", async () => {
    stubFetch();
    await provider.streamChat([{ role: "user", content: "hi" }], {
      responseFormat: { level: "prompt", name: "x" },
    });
    expect(lastBody).not.toHaveProperty("response_format");
  });

  test("no responseFormat leaves the body unchanged (no response_format key)", async () => {
    stubFetch();
    await provider.streamChat([{ role: "user", content: "hi" }], {});
    expect(lastBody).not.toHaveProperty("response_format");
  });
});

describe("openai-compat streamChat — strict tool parameters", () => {
  const realFetch = globalThis.fetch;
  let lastBody: Record<string, unknown> | undefined;

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

  const provider = createOpenAiCompatProvider({
    id: "groq",
    name: "Test",
    color: "#000",
    priority: 1,
    keyRegex: null,
    defaultModel: "test-model",
    baseUrl: "https://example.test/v1",
  });

  type WireTool = {
    type: string;
    function: { name: string; parameters: Record<string, unknown>; strict?: boolean };
  };

  test("strict:true tool parameters are normalized for OpenAI strict", async () => {
    stubFetch();
    await provider.streamChat([{ role: "user", content: "hi" }], {
      tools: [
        {
          name: "lookup",
          description: "look something up",
          strict: true,
          // Optional `unit` (not in required) + no additionalProperties:false →
          // a raw forward would 400 under strict. Must be normalized.
          parameters: {
            type: "object",
            required: ["city"],
            properties: {
              city: { type: "string" },
              unit: { type: "string" },
            },
          },
        },
      ],
    });
    const tools = lastBody?.tools as WireTool[];
    expect(tools[0]).toEqual({
      type: "function",
      function: {
        name: "lookup",
        description: "look something up",
        strict: true,
        parameters: {
          type: "object",
          required: ["city", "unit"],
          additionalProperties: false,
          properties: {
            city: { type: "string" },
            // optional → required-all + null-widened.
            unit: { type: ["string", "null"] },
          },
        },
      },
    });
  });

  test("non-strict tool parameters are forwarded verbatim (no normalization)", async () => {
    stubFetch();
    const rawParams = {
      type: "object",
      required: ["city"],
      properties: {
        city: { type: "string" },
        unit: { type: "string" },
      },
    };
    await provider.streamChat([{ role: "user", content: "hi" }], {
      tools: [
        {
          name: "lookup",
          description: "look something up",
          parameters: rawParams,
        },
      ],
    });
    const tools = lastBody?.tools as WireTool[];
    // Untouched: no additionalProperties:false, original required, no strict.
    expect(tools[0]).toEqual({
      type: "function",
      function: {
        name: "lookup",
        description: "look something up",
        parameters: rawParams,
      },
    });
  });
});
