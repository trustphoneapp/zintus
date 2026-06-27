import { describe, expect, test } from "bun:test";
import { ChatMessageSchema } from "./index.js";

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
});
