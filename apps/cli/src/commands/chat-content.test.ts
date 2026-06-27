import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_IMAGES,
  buildChatContent,
  loadImages,
  normalizeChatError,
} from "./chat-content.js";

// Build a minimal but structurally valid 1x1 PNG (signature + IHDR + IDAT +
// IEND) with self-consistent chunk lengths. @zintus/media's Node path validates
// the magic bytes, reads dimensions from the header, and strips metadata via
// container surgery (it does NOT decode pixels or verify CRCs), so a chunk-
// correct buffer is sufficient and avoids depending on a memorized base64 blob.
function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4); // CRC is not checked by the metadata-strip path
  return Buffer.concat([len, Buffer.from(type, "latin1"), data, crc]);
}

function makeMinimalPng(): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(1, 0); // width = 1
  ihdrData.writeUInt32BE(1, 4); // height = 1
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 6; // color type (RGBA)
  // bytes 10-12 (compression / filter / interlace) stay 0
  const idat = Buffer.from([0x08, 0xd7, 0x63, 0x60, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01]);
  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdrData),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

let dir: string;
let pngPath: string;
let pngPath2: string;
let txtPath: string; // not an image at all (unknown bytes)
let fakePngPath: string; // .png name, GIF magic bytes (unsupported image type)
let missingPath: string; // never created

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "zintus-cli-image-test-"));
  const png = makeMinimalPng();
  pngPath = join(dir, "a.png");
  pngPath2 = join(dir, "b.png");
  txtPath = join(dir, "note.txt");
  fakePngPath = join(dir, "fake.png");
  missingPath = join(dir, "does-not-exist.png");
  await writeFile(pngPath, png);
  await writeFile(pngPath2, png);
  await writeFile(txtPath, "this is plainly not an image");
  // GIF magic bytes under a .png name — magic-byte detection must still reject.
  await writeFile(fakePngPath, Buffer.from("GIF89a;", "latin1"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("loadImages", () => {
  it("processes a valid image path into one EXIF-stripped image block", async () => {
    const blocks = await loadImages([pngPath]);
    expect(blocks).toHaveLength(1);
    const block = blocks[0]!;
    expect(block.type).toBe("image");
    expect(block.mimeType).toBe("image/png");
    expect(block.exifStripped).toBe(true);
    expect(typeof block.data).toBe("string");
    expect(block.data.length).toBeGreaterThan(0);
    // Derived display name comes from the file's basename.
    expect(block.name).toBe("a.png");
  });

  it("accepts up to 4 images, preserving the given order", async () => {
    const blocks = await loadImages([pngPath, pngPath2, pngPath, pngPath2]);
    expect(blocks).toHaveLength(4);
    expect(blocks.every((b) => b.type === "image")).toBe(true);
  });

  it("rejects a 5th image with a clear, count-aware error (before any I/O)", async () => {
    const five = [pngPath, pngPath2, pngPath, pngPath2, missingPath];
    expect(five).toHaveLength(MAX_IMAGES + 1);
    // Note the 5th path doesn't even exist — the count guard must fire first,
    // proving the cap is checked before touching the filesystem.
    await expect(loadImages(five)).rejects.toThrow(/at most 4/i);
  });

  it("rejects a file that isn't an image at all", async () => {
    await expect(loadImages([txtPath])).rejects.toThrow(
      /unsupported image type/i,
    );
  });

  it("rejects by magic bytes — a .png name with GIF bytes is still refused", async () => {
    await expect(loadImages([fakePngPath])).rejects.toThrow(
      /unsupported image type/i,
    );
  });

  it("rejects a missing file with a 'not found' error naming the path", async () => {
    const promise = loadImages([missingPath]);
    await expect(promise).rejects.toThrow(/not found/i);
    await expect(promise).rejects.toThrow(/does-not-exist\.png/);
  });

  it("never leaks image base64 in a thrown error message", async () => {
    // The unsupported-type error must carry only the path + a mime label, never
    // any file bytes/base64.
    let message = "";
    try {
      await loadImages([fakePngPath]);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toContain("GIF89a");
    expect(message).not.toContain("base64");
  });
});

describe("buildChatContent", () => {
  it("returns the plain prompt string when there are no images (unchanged shape)", () => {
    expect(buildChatContent("hello world", [])).toBe("hello world");
  });

  it("orders the TEXT prompt first, then each image in order", async () => {
    const images = await loadImages([pngPath, pngPath2]);
    const content = buildChatContent("what is in these?", images);
    expect(Array.isArray(content)).toBe(true);
    const blocks = content as Exclude<typeof content, string>;
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toEqual({ type: "text", text: "what is in these?" });
    expect(blocks[1]!.type).toBe("image");
    expect(blocks[2]!.type).toBe("image");
  });

  it("never writes image base64 to stdout while loading + building content", async () => {
    const built = await loadImages([pngPath]);
    const data = built[0]!.data;
    expect(data.length).toBeGreaterThan(0);

    const captured: string[] = [];
    const realWrite = process.stdout.write.bind(process.stdout);
    const realLog = console.log;
    process.stdout.write = ((chunk: unknown) => {
      captured.push(String(chunk));
      return true;
    }) as unknown as typeof process.stdout.write;
    console.log = (...args: unknown[]) => {
      captured.push(args.map(String).join(" "));
    };
    try {
      const reloaded = await loadImages([pngPath]);
      buildChatContent("describe this image", reloaded);
    } finally {
      process.stdout.write = realWrite;
      console.log = realLog;
    }

    const out = captured.join("");
    expect(out).not.toContain(data);
    expect(out).not.toContain("base64");
  });
});

describe("normalizeChatError", () => {
  it("turns a bare `unsupported_capability` into an actionable vision error", () => {
    const message = normalizeChatError(new Error("unsupported_capability"));
    expect(message).toMatch(/vision-capable/i);
    expect(message).toMatch(/gemini/i);
    expect(message).toMatch(/openrouter/i);
    expect(message).toMatch(/ollama/i);
    // It must not just echo the raw code back at the user.
    expect(message).not.toBe("unsupported_capability");
  });

  it("passes any other error through verbatim", () => {
    expect(normalizeChatError(new Error("boom"))).toBe("boom");
    expect(normalizeChatError("plain string")).toBe("plain string");
  });
});
