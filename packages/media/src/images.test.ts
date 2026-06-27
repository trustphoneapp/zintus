/**
 * Tests run under bun:test, i.e. the Node/Bun path (no canvas) — they exercise
 * the magic-byte validation, header dimension reads, container metadata strip,
 * and the size/dimension guards. The browser (canvas) path is selected only in
 * a real browser and is not reachable here.
 *
 * All fixtures are tiny synthetic buffers built in-process (no files, no
 * network). PNGs carry a genuinely valid zlib IDAT; JPEG/WebP are valid marker
 * streams (our node path validates structure + strips metadata without
 * decoding pixels).
 */
import { test, expect, describe } from "bun:test";
import { deflateSync } from "node:zlib";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processImage, MediaError } from "./index.js";
import { stripMetadata, detectMime, readDimensions } from "./shared.js";
import { ChatMessageSchema } from "@zintus/schemas";

// ── synthetic image builders ────────────────────────────────────────────────

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
const be16 = (n: number): number[] => [(n >> 8) & 0xff, n & 0xff];
const be32 = (n: number): number[] => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const le32 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
const le24 = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];

const PNG_GPS_SECRET = "GPSLOCATIONSECRET_PNG";
const JPEG_GPS_SECRET = "GPSLOCATIONSECRET_JPEG";
const WEBP_GPS_SECRET = "GPSWEBPSECRET_XYZ";

function crc32(buf: Uint8Array): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]!;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function pngChunk(type: string, data: number[]): number[] {
  const body = [...ascii(type), ...data];
  return [...be32(data.length), ...body, ...be32(crc32(new Uint8Array(body)))];
}

function buildPng(
  w: number,
  h: number,
  opts: { withExif?: boolean; withText?: boolean; realPixels?: boolean } = {},
): Uint8Array {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  const ihdr = pngChunk("IHDR", [...be32(w), ...be32(h), 8, 2, 0, 0, 0]); // 8-bit RGB
  const out: number[] = [...sig, ...ihdr];
  if (opts.withExif) out.push(...pngChunk("eXIf", ascii(PNG_GPS_SECRET)));
  if (opts.withText) out.push(...pngChunk("tEXt", [...ascii("Comment"), 0, ...ascii("hidden-pii")]));
  if (opts.realPixels === false) {
    out.push(...pngChunk("IDAT", [0x78, 0x9c, 0x63, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01]));
  } else {
    const raw = new Uint8Array(h * (1 + w * 3)); // filter byte (0) + RGB scanlines, all black
    out.push(...pngChunk("IDAT", [...deflateSync(raw)]));
  }
  out.push(...pngChunk("IEND", []));
  return new Uint8Array(out);
}

function buildJpeg(w: number, h: number, opts: { withExif?: boolean } = {}): Uint8Array {
  const out: number[] = [0xff, 0xd8]; // SOI
  if (opts.withExif !== false) {
    const payload = [...ascii("Exif"), 0, 0, ...ascii(JPEG_GPS_SECRET)];
    out.push(0xff, 0xe1, ...be16(payload.length + 2), ...payload); // APP1/EXIF
  }
  const sof = [8, ...be16(h), ...be16(w), 1, 1, 0x11, 0]; // SOF0, 1 component
  out.push(0xff, 0xc0, ...be16(sof.length + 2), ...sof);
  const sos = [1, 1, 0, 0, 0x3f, 0]; // SOS, 1 component
  out.push(0xff, 0xda, ...be16(sos.length + 2), ...sos);
  out.push(0x00, 0xd2, 0x80); // a little entropy-coded data
  out.push(0xff, 0xd9); // EOI
  return new Uint8Array(out);
}

function webpChunk(cc: string, data: number[]): number[] {
  const padded = data.length % 2 === 1 ? [...data, 0] : data;
  return [...ascii(cc), ...le32(data.length), ...padded];
}

function buildWebp(w: number, h: number, opts: { withExif?: boolean; withXmp?: boolean } = {}): Uint8Array {
  let flags = 0;
  if (opts.withExif !== false) flags |= 0x08;
  if (opts.withXmp) flags |= 0x04;
  const vp8x = [flags, 0, 0, 0, ...le24(w - 1), ...le24(h - 1)];
  const vp8l = [0x2f, 0x00, 0x00, 0x00, 0x00]; // minimal VP8L frame marker
  const chunks: number[] = [...webpChunk("VP8X", vp8x), ...webpChunk("VP8L", vp8l)];
  if (opts.withExif !== false) chunks.push(...webpChunk("EXIF", ascii(WEBP_GPS_SECRET)));
  if (opts.withXmp) chunks.push(...webpChunk("XMP ", ascii("<x:xmpmeta>pii</x:xmpmeta>")));
  const body = [...ascii("WEBP"), ...chunks];
  return new Uint8Array([...ascii("RIFF"), ...le32(body.length), ...body]);
}

const containsAscii = (bytes: Uint8Array, s: string): boolean =>
  Buffer.from(bytes).toString("latin1").includes(s);

// ── acceptance ──────────────────────────────────────────────────────────────

describe("processImage — accepted formats", () => {
  test("JPEG is accepted and produces an ImageContentBlock", async () => {
    const block = await processImage(buildJpeg(40, 30), { name: "photo.jpg" });
    expect(block.type).toBe("image");
    expect(block.mimeType).toBe("image/jpeg");
    expect(block.exifStripped).toBe(true);
    expect(block.width).toBe(40);
    expect(block.height).toBe(30);
    expect(block.name).toBe("photo.jpg");
    expect(block.data.startsWith("data:")).toBe(false);
    expect(block.bytes).toBeGreaterThan(0);
    // base64 round-trips and `bytes` is accurate
    expect(Buffer.from(block.data, "base64").length).toBe(block.bytes);
  });

  test("PNG is accepted with correct dimensions", async () => {
    const block = await processImage(buildPng(8, 12, { withExif: true }));
    expect(block.mimeType).toBe("image/png");
    expect(block.width).toBe(8);
    expect(block.height).toBe(12);
    expect(block.exifStripped).toBe(true);
    expect(Buffer.from(block.data, "base64").length).toBe(block.bytes);
  });

  test("WebP is accepted (node path strips metadata without a canvas)", async () => {
    // The node runtime supports WebP via container strip — assert directly.
    const block = await processImage(buildWebp(16, 16, { withExif: true }));
    expect(block.mimeType).toBe("image/webp");
    expect(block.width).toBe(16);
    expect(block.height).toBe(16);
    expect(block.exifStripped).toBe(true);
  });

  test("accepts ArrayBuffer and Uint8Array and Blob inputs equivalently", async () => {
    const png = buildPng(4, 4);
    const fromU8 = await processImage(png);
    const fromAb = await processImage(png.slice().buffer);
    const fromBlob = await processImage(new Blob([png.slice()]));
    expect(fromU8.bytes).toBe(fromAb.bytes);
    expect(fromU8.bytes).toBe(fromBlob.bytes);
    expect(fromU8.mimeType).toBe("image/png");
  });

  test("{ path } input is read from disk and the name is derived", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zintus-media-"));
    const file = join(dir, "diagram.png");
    try {
      writeFileSync(file, buildPng(6, 6));
      const block = await processImage({ path: file });
      expect(block.mimeType).toBe("image/png");
      expect(block.name).toBe("diagram.png");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── EXIF / metadata stripping is genuine ────────────────────────────────────

describe("metadata is genuinely stripped", () => {
  test("JPEG output no longer contains the EXIF GPS payload", async () => {
    const input = buildJpeg(20, 20, { withExif: true });
    expect(containsAscii(input, JPEG_GPS_SECRET)).toBe(true); // present before
    const block = await processImage(input);
    const out = Buffer.from(block.data, "base64");
    expect(containsAscii(out, JPEG_GPS_SECRET)).toBe(false); // gone after
    expect(containsAscii(out, "Exif")).toBe(false);
    expect(out[0]).toBe(0xff); // still a valid JPEG (SOI preserved)
    expect(out[1]).toBe(0xd8);
  });

  test("PNG output drops eXIf and tEXt chunks", async () => {
    const input = buildPng(10, 10, { withExif: true, withText: true });
    const out = stripMetadata("image/png", input);
    expect(containsAscii(out, PNG_GPS_SECRET)).toBe(false);
    expect(containsAscii(out, "eXIf")).toBe(false);
    expect(containsAscii(out, "tEXt")).toBe(false);
    expect(containsAscii(out, "hidden-pii")).toBe(false);
    // critical chunks survive
    expect(containsAscii(out, "IHDR")).toBe(true);
    expect(containsAscii(out, "IDAT")).toBe(true);
    expect(containsAscii(out, "IEND")).toBe(true);
  });

  test("WebP output drops EXIF/XMP chunks and clears the VP8X flags", async () => {
    const input = buildWebp(16, 16, { withExif: true, withXmp: true });
    const out = stripMetadata("image/webp", input);
    expect(containsAscii(out, WEBP_GPS_SECRET)).toBe(false);
    expect(containsAscii(out, "EXIF")).toBe(false);
    expect(containsAscii(out, "XMP ")).toBe(false);
    // VP8X flags byte (12 RIFF/WEBP header + 8 chunk header = offset 20) has the
    // EXIF (0x08) and XMP (0x04) bits cleared.
    expect(out[20]! & 0x0c).toBe(0);
    // RIFF size field is fixed up to match the new body length.
    const sizeField = new DataView(out.buffer, out.byteOffset).getUint32(4, true);
    expect(sizeField).toBe(out.length - 8);
  });
});

// ── rejections ──────────────────────────────────────────────────────────────

describe("processImage — rejections", () => {
  const expectMediaError = async (input: Uint8Array, code: string) => {
    try {
      await processImage(input);
      throw new Error("expected processImage to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(MediaError);
      expect((err as MediaError).code).toBe(code);
      return err as MediaError;
    }
  };

  test("SVG is rejected (XML/script attack surface)", async () => {
    await expectMediaError(new Uint8Array(ascii('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), "UNSUPPORTED_TYPE");
    await expectMediaError(new Uint8Array(ascii('<?xml version="1.0"?><svg></svg>')), "UNSUPPORTED_TYPE");
  });

  test("GIF is rejected", async () => {
    await expectMediaError(new Uint8Array([...ascii("GIF89a"), 0, 0, 0, 0]), "UNSUPPORTED_TYPE");
  });

  test("PDF and unknown binary are rejected", async () => {
    await expectMediaError(new Uint8Array(ascii("%PDF-1.7\n")), "UNSUPPORTED_TYPE");
    await expectMediaError(new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]), "UNSUPPORTED_TYPE");
  });

  test("empty input is rejected", async () => {
    await expectMediaError(new Uint8Array(0), "EMPTY_INPUT");
  });

  test("oversized input is rejected BEFORE processing (size check precedes mime detection)", async () => {
    // Not a valid image: if detection ran first this would be UNSUPPORTED_TYPE.
    // Getting INPUT_TOO_LARGE proves the byte-cap is enforced first.
    const junk = new Uint8Array(200).fill(0x7a);
    try {
      await processImage(junk, { maxInputBytes: 10 });
      throw new Error("expected throw");
    } catch (err) {
      expect((err as MediaError).code).toBe("INPUT_TOO_LARGE");
    }
  });

  test("node path rejects images whose longest edge exceeds maxLongestEdge", async () => {
    const big = buildPng(5000, 100, { realPixels: false });
    try {
      await processImage(big); // default maxLongestEdge 2048
      throw new Error("expected throw");
    } catch (err) {
      expect((err as MediaError).code).toBe("DIMENSIONS_TOO_LARGE");
    }
  });

  test("output larger than maxOutputBytes is rejected", async () => {
    try {
      await processImage(buildJpeg(20, 20, { withExif: false }), { maxOutputBytes: 1 });
      throw new Error("expected throw");
    } catch (err) {
      expect((err as MediaError).code).toBe("OUTPUT_TOO_LARGE");
    }
  });
});

// ── output contract / bounds ────────────────────────────────────────────────

describe("output contract", () => {
  test("exifStripped is always literally true", async () => {
    for (const input of [buildJpeg(10, 10), buildPng(10, 10), buildWebp(10, 10)]) {
      const block = await processImage(input);
      expect(block.exifStripped).toBe(true);
    }
  });

  test("output bytes never exceed maxOutputBytes; width/height are positive ints", async () => {
    const block = await processImage(buildPng(64, 48), { maxOutputBytes: 4 * 1024 * 1024 });
    expect(block.bytes).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(Number.isInteger(block.width)).toBe(true);
    expect(Number.isInteger(block.height)).toBe(true);
    expect(block.width!).toBeGreaterThan(0);
    expect(block.height!).toBeGreaterThan(0);
  });

  test("output validates against the PR1 zod ImageBlock schema (@zintus/schemas)", async () => {
    const block = await processImage(buildPng(12, 8, { withExif: true }), { name: "ok.png" });
    const parsed = ChatMessageSchema.safeParse({ role: "user", content: [block] });
    expect(parsed.success).toBe(true);
  });

  test("detectMime + readDimensions agree with processImage", () => {
    const jpeg = buildJpeg(33, 21);
    expect(detectMime(jpeg)).toBe("image/jpeg");
    expect(readDimensions("image/jpeg", jpeg)).toEqual({ width: 33, height: 21 });
  });
});

// ── no base64 / image bytes ever leak into error messages ───────────────────

describe("error messages never leak image data", () => {
  const assertNoLeak = (message: string, inputBytes: Uint8Array) => {
    const b64 = Buffer.from(inputBytes).toString("base64");
    for (let i = 0; i + 16 <= b64.length; i += 16) {
      expect(message.includes(b64.slice(i, i + 16))).toBe(false);
    }
    expect(message).not.toContain("SECRET");
  };

  test("OUTPUT_TOO_LARGE message carries sizes only, not the image", async () => {
    const input = buildJpeg(20, 20, { withExif: true });
    try {
      await processImage(input, { maxOutputBytes: 1 });
      throw new Error("expected throw");
    } catch (err) {
      assertNoLeak((err as MediaError).message, input);
    }
  });

  test("DIMENSIONS_TOO_LARGE message carries sizes only, not the image", async () => {
    const input = buildPng(5000, 80, { realPixels: false, withExif: true });
    try {
      await processImage(input);
      throw new Error("expected throw");
    } catch (err) {
      assertNoLeak((err as MediaError).message, input);
    }
  });
});
