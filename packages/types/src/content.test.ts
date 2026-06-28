import { describe, expect, test } from "bun:test";
import {
  hasImages,
  hasToolTurns,
  imageCount,
  isContentBlockArray,
  requiresTools,
  requiresVision,
  sanitizeForLogs,
  textOf,
  type ChatMessage,
  type ImageContentBlock,
  type ToolCallContentBlock,
  type ToolDefinition,
  type ToolResultContentBlock,
} from "./index.js";

const img: ImageContentBlock = {
  type: "image",
  data: "BASE64DATA",
  mimeType: "image/png",
  bytes: 2048,
  exifStripped: true,
  name: "shot.png",
};

describe("content-block helpers", () => {
  test("isContentBlockArray distinguishes string vs blocks", () => {
    expect(isContentBlockArray("hi")).toBe(false);
    expect(isContentBlockArray([{ type: "text", text: "hi" }])).toBe(true);
  });

  test("textOf flattens text blocks and ignores images", () => {
    expect(textOf("plain")).toBe("plain");
    expect(
      textOf([{ type: "text", text: "a" }, img, { type: "text", text: "b" }]),
    ).toBe("a\nb");
  });

  test("imageCount / hasImages / requiresVision", () => {
    const withImg: ChatMessage[] = [
      { role: "user", content: [{ type: "text", text: "q" }, img] },
    ];
    const textOnly: ChatMessage[] = [{ role: "user", content: "just text" }];
    expect(imageCount(withImg)).toBe(1);
    expect(hasImages(withImg)).toBe(true);
    expect(requiresVision(withImg)).toBe(true);
    expect(hasImages(textOnly)).toBe(false);
    expect(requiresVision(textOnly)).toBe(false);
  });

  test("sanitizeForLogs elides image data but keeps the byte count", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: [{ type: "text", text: "q" }, img] },
    ];
    const content = sanitizeForLogs(msgs)[0]!.content;
    expect(isContentBlockArray(content)).toBe(true);
    if (isContentBlockArray(content)) {
      const block = content[1]!;
      expect(block.type).toBe("image");
      if (block.type === "image") {
        expect(block.data).not.toContain("BASE64DATA");
        expect(block.data).toContain("2048B");
      }
    }
  });
});

const toolCall: ToolCallContentBlock = {
  type: "tool_call",
  id: "call_abc",
  name: "get_weather",
  arguments: { city: "Paris", secret: "SHOULD_NOT_LEAK" },
};

const toolResult: ToolResultContentBlock = {
  type: "tool_result",
  toolCallId: "call_abc",
  content: "{\"tempC\":21,\"token\":\"SHOULD_NOT_LEAK\"}",
};

describe("tool-call helpers", () => {
  test("requiresTools reflects presence of tool definitions", () => {
    const tools: ToolDefinition[] = [
      { name: "get_weather", description: "weather", parameters: { type: "object" } },
    ];
    expect(requiresTools({ tools })).toBe(true);
    expect(requiresTools({ tools: [] })).toBe(false);
    expect(requiresTools({})).toBe(false);
  });

  test("hasToolTurns detects tool_call / tool_result blocks", () => {
    const callTurn: ChatMessage[] = [
      { role: "assistant", content: [toolCall] },
    ];
    const resultTurn: ChatMessage[] = [
      { role: "user", content: [{ type: "text", text: "ok" }, toolResult] },
    ];
    const plain: ChatMessage[] = [{ role: "user", content: "hi" }];
    expect(hasToolTurns(callTurn)).toBe(true);
    expect(hasToolTurns(resultTurn)).toBe(true);
    expect(hasToolTurns(plain)).toBe(false);
  });

  test("textOf skips tool_call and tool_result blocks", () => {
    expect(
      textOf([{ type: "text", text: "before" }, toolCall, toolResult, {
        type: "text",
        text: "after",
      }]),
    ).toBe("before\nafter");
  });

  test("sanitizeForLogs elides tool arguments and result payloads", () => {
    const msgs: ChatMessage[] = [
      { role: "assistant", content: [toolCall] },
      { role: "user", content: [toolResult] },
    ];
    const sanitized = sanitizeForLogs(msgs);
    const callBlock = (sanitized[0]!.content as typeof msgs[0]["content"]);
    const resultBlock = (sanitized[1]!.content as typeof msgs[1]["content"]);
    expect(JSON.stringify(callBlock)).not.toContain("SHOULD_NOT_LEAK");
    expect(JSON.stringify(resultBlock)).not.toContain("SHOULD_NOT_LEAK");
    // The non-sensitive correlation handles + names are preserved for debugging.
    expect(JSON.stringify(callBlock)).toContain("get_weather");
    expect(JSON.stringify(resultBlock)).toContain("call_abc");
  });
});
