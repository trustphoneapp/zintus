import { describe, expect, test } from "bun:test";
import type { ImageContentBlock } from "@zintus/types";
import {
  MAX_IMAGES_PER_MESSAGE,
  base64ByteLength,
  buildImageMessageContent,
  formatImageBytes,
  imageSlotsRemaining,
  providerCanSeeImages,
} from "./image-attachments";

const img: ImageContentBlock = {
  type: "image",
  data: "aGVsbG8=",
  mimeType: "image/jpeg",
  bytes: 5,
  exifStripped: true,
};

describe("mobile image-attachments", () => {
  test("slots remaining is bounded and non-negative", () => {
    expect(imageSlotsRemaining(0)).toBe(MAX_IMAGES_PER_MESSAGE);
    expect(imageSlotsRemaining(4)).toBe(0);
    expect(imageSlotsRemaining(9)).toBe(0);
  });

  test("buildImageMessageContent is text-first then images, no [Image:] fake", () => {
    const content = buildImageMessageContent("what is this?", [img, img]);
    expect(content[0]).toEqual({ type: "text", text: "what is this?" });
    expect(content).toHaveLength(3);
    expect(content.slice(1).every((b) => b.type === "image")).toBe(true);
    // Never injects a fake text placeholder for the image.
    expect(JSON.stringify(content)).not.toContain("[Image");
  });

  test("providerCanSeeImages: auto/undefined allowed, non-vision blocked, vision allowed", () => {
    expect(providerCanSeeImages("auto")).toBe(true);
    expect(providerCanSeeImages(undefined)).toBe(true);
    expect(providerCanSeeImages(null)).toBe(true);
    // gemini's default is vision-capable; groq's is not (registry-backed).
    expect(providerCanSeeImages("gemini")).toBe(true);
    expect(providerCanSeeImages("groq")).toBe(false);
  });

  test("formatImageBytes renders human sizes", () => {
    expect(formatImageBytes(500)).toBe("500 B");
    expect(formatImageBytes(2048)).toBe("2 KB");
    expect(formatImageBytes(1_600_000)).toBe("1.5 MB");
  });

  test("base64ByteLength computes decoded size without decoding", () => {
    expect(base64ByteLength("")).toBe(0);
    expect(base64ByteLength("aGVsbG8=")).toBe(5); // "hello"
    expect(base64ByteLength("aGVsbG8h")).toBe(6); // "hello!"
    expect(base64ByteLength("YWI=")).toBe(2); // "ab"
  });
});
