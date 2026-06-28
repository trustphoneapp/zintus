import { describe, expect, test } from "bun:test";
import {
  ChatMessageSchema,
  ChatCompletionRequestSchema,
  ResponseFormatSchema,
  ToolChoiceSchema,
  validateJson,
  extractJsonObject,
  repairInstruction,
} from "./index.js";

function imageBlock(over: Record<string, unknown> = {}) {
  return {
    type: "image",
    data: "AAAA", // raw base64 (content irrelevant for schema validation)
    mimeType: "image/png",
    bytes: 1024,
    exifStripped: true,
    ...over,
  };
}

const ok = (content: unknown) =>
  ChatMessageSchema.safeParse({ role: "user", content }).success;

describe("ChatMessageSchema content (string | ContentBlock[])", () => {
  test("plain string content validates (backward compatible)", () => {
    expect(ok("hi")).toBe(true);
  });

  test("a text + image block array validates", () => {
    expect(ok([{ type: "text", text: "what is this?" }, imageBlock()])).toBe(true);
  });

  test("an empty block array is rejected", () => {
    expect(ok([])).toBe(false);
  });

  test("unsupported mime types are rejected (svg/gif/video/pdf)", () => {
    for (const mimeType of [
      "image/svg+xml",
      "image/gif",
      "video/mp4",
      "application/pdf",
    ]) {
      expect(ok([imageBlock({ mimeType })])).toBe(false);
    }
  });

  test("only jpeg/png/webp are accepted", () => {
    for (const mimeType of ["image/jpeg", "image/png", "image/webp"]) {
      expect(ok([imageBlock({ mimeType })])).toBe(true);
    }
  });

  test("a false or missing exifStripped flag is rejected", () => {
    expect(ok([imageBlock({ exifStripped: false })])).toBe(false);
    // omit the flag entirely
    expect(
      ok([{ type: "image", data: "AAAA", mimeType: "image/png", bytes: 1024 }]),
    ).toBe(false);
  });

  test("an oversized image (> 4MB processed) is rejected", () => {
    expect(ok([imageBlock({ bytes: 4 * 1024 * 1024 + 1 })])).toBe(false);
  });

  test("a data: URI prefix on image.data is rejected (raw base64 only)", () => {
    expect(ok([imageBlock({ data: "data:image/png;base64,AAAA" })])).toBe(false);
  });

  // The multi-turn tool loop replays tool_call + tool_result content blocks; these
  // MUST validate at the edge or a continuation turn 400s (the headline tool bug).
  test("tool_call and tool_result content blocks validate", () => {
    expect(
      ok([
        { type: "tool_call", id: "call_1", name: "get_weather", arguments: { city: "Paris" } },
      ]),
    ).toBe(true);
    expect(
      ok([{ type: "tool_result", toolCallId: "call_1", content: "{\"tempC\":21}" }]),
    ).toBe(true);
  });

  test("an OpenAI-native tool message (role:tool + tool_call_id) validates", () => {
    expect(
      ChatMessageSchema.safeParse({
        role: "tool",
        tool_call_id: "call_1",
        content: "{\"tempC\":21}",
      }).success,
    ).toBe(true);
  });

  // The gateway EMITS an OpenAI-native assistant turn with top-level `tool_calls`
  // and `content:null`. A stock OpenAI client echoes that turn back, so the
  // schema MUST accept it (otherwise the call is lost on the round-trip).
  test("an OpenAI-native assistant tool_calls turn (content:null) validates", () => {
    expect(
      ChatMessageSchema.safeParse({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"Paris"}' },
          },
        ],
      }).success,
    ).toBe(true);
  });

  test("an assistant turn with text content AND tool_calls validates", () => {
    expect(
      ChatMessageSchema.safeParse({
        role: "assistant",
        content: "Let me check the weather.",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"Paris"}' },
          },
        ],
      }).success,
    ).toBe(true);
  });

  test("a content:null message WITHOUT tool_calls is still rejected", () => {
    expect(
      ChatMessageSchema.safeParse({ role: "assistant", content: null }).success,
    ).toBe(false);
  });
});

describe("ChatCompletionRequestSchema tools / tool_choice", () => {
  const weatherTool = {
    name: "get_weather",
    description: "Get the weather for a city",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  };

  test("a valid tools array validates", () => {
    const parsed = ChatCompletionRequestSchema.safeParse({
      messages: [{ role: "user", content: "weather in Paris?" }],
      tools: [weatherTool, { ...weatherTool, name: "tool-2", strict: true }],
    });
    expect(parsed.success).toBe(true);
  });

  test("a tool name outside ^[a-zA-Z0-9_-]{1,64}$ is rejected", () => {
    for (const name of ["bad name", "has.dot", "", "a".repeat(65)]) {
      const parsed = ChatCompletionRequestSchema.safeParse({
        messages: [{ role: "user", content: "hi" }],
        tools: [{ ...weatherTool, name }],
      });
      expect(parsed.success).toBe(false);
    }
  });

  test("tool_choice variants validate (mode strings + forced tool)", () => {
    for (const choice of ["auto", "required", "none", { type: "tool", name: "get_weather" }]) {
      expect(ToolChoiceSchema.safeParse(choice).success).toBe(true);
    }
    // Invalid: unknown mode and a forced-tool object missing the type literal.
    expect(ToolChoiceSchema.safeParse("sometimes").success).toBe(false);
    expect(ToolChoiceSchema.safeParse({ name: "get_weather" }).success).toBe(false);
  });
});

describe("ResponseFormatSchema", () => {
  const personSchema = {
    type: "object",
    properties: { name: { type: "string" } },
    required: ["name"],
  };

  test("json_schema WITH a schema validates", () => {
    expect(
      ResponseFormatSchema.safeParse({ type: "json_schema", schema: personSchema }).success,
    ).toBe(true);
  });

  test("json_schema WITHOUT a schema is rejected", () => {
    const parsed = ResponseFormatSchema.safeParse({ type: "json_schema" });
    expect(parsed.success).toBe(false);
  });

  test("json_object validates (no schema required)", () => {
    expect(ResponseFormatSchema.safeParse({ type: "json_object" }).success).toBe(true);
  });

  test("text validates", () => {
    expect(ResponseFormatSchema.safeParse({ type: "text" }).success).toBe(true);
  });

  test("maxRepairAttempts is bounded to 0..2", () => {
    expect(
      ResponseFormatSchema.safeParse({ type: "json_object", maxRepairAttempts: 2 }).success,
    ).toBe(true);
    expect(
      ResponseFormatSchema.safeParse({ type: "json_object", maxRepairAttempts: 3 }).success,
    ).toBe(false);
    expect(
      ResponseFormatSchema.safeParse({ type: "json_object", maxRepairAttempts: -1 }).success,
    ).toBe(false);
  });

  test("ChatCompletionRequestSchema accepts response_format", () => {
    const parsed = ChatCompletionRequestSchema.safeParse({
      messages: [{ role: "user", content: "give me JSON" }],
      response_format: { type: "json_schema", schema: personSchema },
    });
    expect(parsed.success).toBe(true);
  });

  test("ChatCompletionRequestSchema rejects a json_schema response_format without a schema", () => {
    const parsed = ChatCompletionRequestSchema.safeParse({
      messages: [{ role: "user", content: "give me JSON" }],
      response_format: { type: "json_schema" },
    });
    expect(parsed.success).toBe(false);
  });
});

describe("validateJson", () => {
  const schema = {
    type: "object",
    properties: { name: { type: "string" }, age: { type: "number" } },
    required: ["name", "age"],
    additionalProperties: false,
  };

  test("a conforming object passes with no issues", () => {
    const r = validateJson(schema, { name: "Ada", age: 36 });
    expect(r.valid).toBe(true);
    expect(r.issues).toEqual([]);
  });

  test("a missing required field fails with a path", () => {
    const r = validateJson(schema, { name: "Ada" });
    expect(r.valid).toBe(false);
    expect(r.issues.length).toBeGreaterThan(0);
    // Ajv reports the path/message; at minimum a message must be present.
    expect(r.issues.some((i) => i.message.length > 0)).toBe(true);
  });

  test("a wrong-typed field fails with a path", () => {
    const r = validateJson(schema, { name: "Ada", age: "old" });
    expect(r.valid).toBe(false);
    expect(r.issues.some((i) => i.path === "/age")).toBe(true);
  });

  test("an uncompilable schema returns invalid (does not throw)", () => {
    // `type` must be a known JSON-Schema type; a bogus one makes Ajv refuse to compile.
    const bad = { type: "not-a-real-type" } as Record<string, unknown>;
    let r: ReturnType<typeof validateJson>;
    expect(() => {
      r = validateJson(bad, { anything: true });
    }).not.toThrow();
    expect(r!.valid).toBe(false);
    expect(r!.issues[0]?.path).toBe("/");
    expect(r!.issues[0]?.message).toContain("uncompilable schema");
  });
});

describe("extractJsonObject", () => {
  test("parses a fenced ```json block", () => {
    const r = extractJsonObject('Here you go:\n```json\n{"a":1}\n```\nThanks!');
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ a: 1 });
  });

  test("parses a prose-wrapped object", () => {
    const r = extractJsonObject('Sure! The result is {"name":"Ada","age":36} as requested.');
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ name: "Ada", age: 36 });
  });

  test("parses a top-level array", () => {
    const r = extractJsonObject("[1, 2, 3]");
    expect(r.ok).toBe(true);
    expect(r.value).toEqual([1, 2, 3]);
  });

  test("braces inside string values do not break balancing", () => {
    const r = extractJsonObject('prefix {"text":"a } b { c"} suffix');
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ text: "a } b { c" });
  });

  test("garbage with no JSON returns ok:false", () => {
    expect(extractJsonObject("no json here at all").ok).toBe(false);
    expect(extractJsonObject("").ok).toBe(false);
  });
});

describe("repairInstruction", () => {
  test("mentions the listed issues and demands JSON-only output", () => {
    const msg = repairInstruction('{"age":"old"}', [
      { path: "/age", message: "must be number" },
    ]);
    expect(msg).toContain("/age");
    expect(msg).toContain("must be number");
    expect(msg).toContain('{"age":"old"}');
    expect(msg.toLowerCase()).toContain("only");
  });
});
