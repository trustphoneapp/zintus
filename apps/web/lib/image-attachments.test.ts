import { describe, test, expect } from "bun:test";
import type { ImageContentBlock } from "@zintus/types";
import { processImage } from "@zintus/media";
import {
  acceptImageFile,
  isImageMime,
  imageSlotsRemaining,
  buildImageMessageContent,
  providerCanSeeImages,
  formatImageBytes,
  MAX_IMAGES_PER_MESSAGE,
} from "./image-attachments";

// A reusable, schema-shaped processed image block (no real bytes needed for the
// pure-logic tests). `data` is raw base64 with NO `data:` prefix.
function block(over: Partial<ImageContentBlock> = {}): ImageContentBlock {
  return {
    type: "image",
    data: "AAAA",
    mimeType: "image/png",
    bytes: 1024,
    width: 8,
    height: 8,
    exifStripped: true,
    ...over,
  };
}

describe("acceptImageFile — picker accept gate", () => {
  test("accepts jpeg, png and webp", () => {
    expect(acceptImageFile("image/jpeg")).toBe(true);
    expect(acceptImageFile("image/png")).toBe(true);
    expect(acceptImageFile("image/webp")).toBe(true);
  });

  test("rejects svg, gif and other non-accepted types", () => {
    for (const mime of [
      "image/svg+xml",
      "image/gif",
      "image/bmp",
      "image/tiff",
      "application/pdf",
      "text/plain",
      "",
    ]) {
      expect(acceptImageFile(mime)).toBe(false);
    }
  });

  test("isImageMime branches image vs non-image before the strict gate", () => {
    expect(isImageMime("image/gif")).toBe(true); // an image, but acceptImageFile rejects it
    expect(acceptImageFile("image/gif")).toBe(false);
    expect(isImageMime("text/markdown")).toBe(false);
  });
});

describe("buildImageMessageContent — text first, images in order", () => {
  test("puts the text block first, then images in attachment order", () => {
    const a = block({ name: "a.png", bytes: 1 });
    const b = block({ name: "b.jpg", mimeType: "image/jpeg", bytes: 2 });
    const c = block({ name: "c.webp", mimeType: "image/webp", bytes: 3 });
    const content = buildImageMessageContent("what are these?", [a, b, c]);

    expect(content[0]).toEqual({ type: "text", text: "what are these?" });
    expect(content.slice(1)).toEqual([a, b, c]);
    expect(content.map((x) => x.type)).toEqual(["text", "image", "image", "image"]);
  });

  test("keeps a leading text block even when the prompt is empty", () => {
    const content = buildImageMessageContent("", [block()]);
    expect(content[0]).toEqual({ type: "text", text: "" });
    expect(content[1]?.type).toBe("image");
  });

  test("NEVER injects an `[Image:` note into the content", () => {
    const content = buildImageMessageContent("look", [
      block({ name: "secret-vacation.png" }),
      block({ name: "passport.jpg", mimeType: "image/jpeg" }),
    ]);
    const serialized = JSON.stringify(content);
    expect(serialized).not.toContain("[Image:");
    expect(serialized).not.toContain("[Image ");
    // the only text in the message is exactly what the user typed
    const textBlocks = content.filter((b) => b.type === "text");
    expect(textBlocks).toEqual([{ type: "text", text: "look" }]);
  });
});

describe("imageSlotsRemaining — max-4 enforcement", () => {
  test("counts down from the max and never goes negative", () => {
    expect(MAX_IMAGES_PER_MESSAGE).toBe(4);
    expect(imageSlotsRemaining(0)).toBe(4);
    expect(imageSlotsRemaining(3)).toBe(1);
    expect(imageSlotsRemaining(4)).toBe(0);
    expect(imageSlotsRemaining(5)).toBe(0); // already over — block the next add
  });
});

describe("providerCanSeeimages — unsupported-provider predicate", () => {
  test("auto / no provider is allowed (router decides)", () => {
    expect(providerCanSeeImages(null)).toBe(true);
    expect(providerCanSeeImages(undefined)).toBe(true);
  });

  test("a non-vision provider is rejected, a vision provider is allowed", () => {
    expect(providerCanSeeImages("groq")).toBe(false);
    expect(providerCanSeeImages("cerebras")).toBe(false);
    expect(providerCanSeeImages("gemini")).toBe(true);
  });

  test("is model-aware (a known Gemini vision model passes)", () => {
    expect(providerCanSeeImages("gemini", "gemini-2.5-flash")).toBe(true);
    // an unmapped model id is not assumed vision-capable
    expect(providerCanSeeImages("openrouter", "meta-llama/llama-3.3-70b-instruct:free")).toBe(false);
  });
});

describe("formatImageBytes", () => {
  test("formats B / KB / MB", () => {
    expect(formatImageBytes(512)).toBe("512 B");
    expect(formatImageBytes(186_368)).toBe("182 KB");
    expect(formatImageBytes(2 * 1024 * 1024)).toBe("2.0 MB");
  });
});

// ── Integration: a REAL processed block flows into the content contract ──────
// Under bun:test there is no canvas, so @zintus/media takes the Node path
// (validate magic bytes + strip EXIF/GPS, no pixel resize). The browser canvas
// path the web app actually uses at runtime cannot run here; this proves the
// block SHAPE that path also produces is content-contract-valid and `[Image:`-free.
const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
const be16 = (n: number): number[] => [(n >> 8) & 0xff, n & 0xff];

/** Minimal but structurally valid 8x8 JPEG carrying an APP1/EXIF GPS segment. */
function jpegWithExif(): Uint8Array {
  const out: number[] = [0xff, 0xd8]; // SOI
  const exif = [...ascii("Exif"), 0, 0, ...ascii("GPS-SECRET-LOCATION")];
  out.push(0xff, 0xe1, ...be16(exif.length + 2), ...exif); // APP1/EXIF
  const sof = [8, ...be16(8), ...be16(8), 1, 1, 0x11, 0]; // SOF0 8x8, 1 component
  out.push(0xff, 0xc0, ...be16(sof.length + 2), ...sof);
  const sos = [1, 1, 0, 0, 0x3f, 0]; // SOS
  out.push(0xff, 0xda, ...be16(sos.length + 2), ...sos);
  out.push(0x00, 0xd2, 0x80); // a little entropy data
  out.push(0xff, 0xd9); // EOI
  return new Uint8Array(out);
}

describe("processImage → buildImageMessageContent (real pipeline, Node path)", () => {
  test("produces a content-valid, EXIF-stripped image block with no `data:` prefix", async () => {
    const input = jpegWithExif();
    // @zintus/media accepts a Uint8Array directly (a valid ImageInput). The web
    // app passes a File/Blob — also valid — but that triggers the browser canvas
    // path, which cannot run under bun:test; both paths emit the same block shape.
    const processed = await processImage(input, { name: "trip.jpg" });

    expect(processed.type).toBe("image");
    expect(processed.mimeType).toBe("image/jpeg");
    expect(processed.exifStripped).toBe(true);
    expect(processed.data.length).toBeGreaterThan(0);
    expect(processed.data.startsWith("data:")).toBe(false); // raw base64 only
    expect(processed.bytes).toBeGreaterThan(0);
    // EXIF/GPS was genuinely removed: the processed container is smaller.
    expect(processed.bytes).toBeLessThan(input.byteLength);

    const content = buildImageMessageContent("where was this taken?", [processed]);
    expect(content[0]).toEqual({ type: "text", text: "where was this taken?" });
    expect(content[1]).toBe(processed);
    expect(JSON.stringify(content)).not.toContain("[Image:");
  });
});
