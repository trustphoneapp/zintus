import { describe, expect, test } from "bun:test";
import {
  hasImages,
  imageCount,
  isContentBlockArray,
  requiresVision,
  sanitizeForLogs,
  textOf,
  type ChatMessage,
  type ImageContentBlock,
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
