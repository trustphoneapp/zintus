import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_IMAGES,
  STRUCTURED_GUARANTEE_CAVEAT,
  buildChatContent,
  buildResponseFormat,
  formatQuotaUsage,
  formatStructuredOutput,
  formatTurnSummary,
  loadImages,
  loadJsonSchema,
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

describe("formatQuotaUsage", () => {
  it("omits the line entirely when there is no usage figure", () => {
    expect(formatQuotaUsage(undefined, 500_000)).toBeNull();
  });

  it("prints used/limit when the engine reports a real denominator", () => {
    expect(formatQuotaUsage(12_500, 500_000)).toBe("quota 12,500/500,000 tok");
  });

  it("says 'limit unknown' — never a fabricated 1,000,000 — when no cap is reported", () => {
    const nullLimit = formatQuotaUsage(12_500, null);
    const undefLimit = formatQuotaUsage(12_500, undefined);
    for (const line of [nullLimit, undefLimit]) {
      expect(line).toBe("quota 12,500 tok used today (limit unknown)");
      expect(line).not.toContain("1,000,000");
      expect(line).not.toContain("1000000");
    }
  });
});

describe("formatTurnSummary", () => {
  it("surfaces the route reason as a 'why:' headline when present", () => {
    const out = formatTurnSummary({
      providerLabel: "Groq",
      model: "llama-3.3-70b",
      routeReason: "cheapest healthy provider for strategy=cost",
      inputTokens: 100,
      outputTokens: 42,
      costUsd: 0,
      quotaUsed: 5_000,
      quotaLimit: 200_000,
    });
    expect(out).toContain("Groq · llama-3.3-70b");
    expect(out).toContain("why: cheapest healthy provider for strategy=cost");
    expect(out).toContain("100 in / 42 out tok");
    expect(out).toContain("$0 (free tier)");
    expect(out).toContain("quota 5,000/200,000 tok");
  });

  it("omits the route-reason line when the engine recorded none", () => {
    const out = formatTurnSummary({
      providerLabel: "openai",
      model: "gpt-4o-mini",
      outputTokens: 10,
      inputTokens: 3,
    });
    expect(out).not.toContain("why:");
  });

  it("never prints a fabricated 1,000,000 quota denominator", () => {
    const out = formatTurnSummary({
      providerLabel: "openai",
      model: "gpt-4o-mini",
      inputTokens: 10,
      outputTokens: 20,
      costUsd: 0.0012,
      quotaUsed: 7_777,
      quotaLimit: null,
    });
    expect(out).toContain("quota 7,777 tok used today (limit unknown)");
    expect(out).not.toContain("1,000,000");
    expect(out).not.toContain("1000000");
    expect(out).toContain("~$0.0012 est");
  });

  it("prints 'Private Mode: honored ✓' when block-training was honored", () => {
    const out = formatTurnSummary({
      providerLabel: "Groq",
      model: "llama-3.3-70b",
      inputTokens: 10,
      outputTokens: 20,
      privacyHonored: true,
    });
    expect(out).toContain("Private Mode: honored ✓");
    expect(out).not.toContain("NOT honored");
  });

  it("prints the honest NOT-honored line when a may-train provider was used", () => {
    const out = formatTurnSummary({
      providerLabel: "openai",
      model: "gpt-4o-mini",
      inputTokens: 10,
      outputTokens: 20,
      privacyHonored: false,
    });
    expect(out).toContain(
      "Private Mode: NOT honored ⚠ (a may-train provider was used)",
    );
    // Never claim "honored" when the flag is false (under-claim, like web).
    expect(out).not.toContain("Private Mode: honored");
  });

  it("omits the Private Mode line entirely when block-training wasn't requested", () => {
    const out = formatTurnSummary({
      providerLabel: "openai",
      model: "gpt-4o-mini",
      inputTokens: 10,
      outputTokens: 20,
    });
    expect(out).not.toContain("Private Mode");
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

describe("buildResponseFormat", () => {
  it("returns undefined when no structured output is requested (unchanged text path)", () => {
    expect(buildResponseFormat({})).toBeUndefined();
    expect(buildResponseFormat({ json: false })).toBeUndefined();
  });

  it("maps --json to a json_object response_format request", () => {
    expect(buildResponseFormat({ json: true })).toEqual({ type: "json_object" });
  });

  it("maps inline --json-schema to a json_schema request (strict defaults to false)", () => {
    const rf = buildResponseFormat({
      jsonSchema: '{"type":"object","properties":{"city":{"type":"string"}}}',
    });
    expect(rf).toEqual({
      type: "json_schema",
      schema: { type: "object", properties: { city: { type: "string" } } },
      strict: false,
    });
  });

  it("honors --strict (demand a guaranteeing provider) alongside --json-schema", () => {
    const rf = buildResponseFormat({
      jsonSchema: '{"type":"object"}',
      strict: true,
    });
    expect(rf).toMatchObject({ type: "json_schema", strict: true });
  });

  it("prefers a schema over a bare --json when both are passed", () => {
    const rf = buildResponseFormat({ json: true, jsonSchema: '{"type":"object"}' });
    expect(rf?.type).toBe("json_schema");
  });
});

describe("loadJsonSchema", () => {
  it("parses an inline JSON object schema", () => {
    expect(loadJsonSchema('{"type":"object","required":["x"]}')).toEqual({
      type: "object",
      required: ["x"],
    });
  });

  it("reads a schema from a file path", async () => {
    const schemaPath = join(dir, "schema.json");
    await writeFile(
      schemaPath,
      JSON.stringify({ type: "object", properties: { n: { type: "number" } } }),
    );
    expect(loadJsonSchema(schemaPath)).toEqual({
      type: "object",
      properties: { n: { type: "number" } },
    });
  });

  it("rejects a non-object schema (array / scalar) with a clear error", () => {
    expect(() => loadJsonSchema("[1,2,3]")).toThrow(/JSON object/i);
    expect(() => loadJsonSchema("42")).toThrow(/JSON object/i);
  });

  it("rejects malformed JSON with a clear, non-stack error", () => {
    expect(() => loadJsonSchema("{not json")).toThrow(/JSON Schema file path or inline JSON/i);
  });
});

describe("formatStructuredOutput", () => {
  it("pretty-prints valid parsed JSON (2-space indent) to the body", () => {
    const render = formatStructuredOutput({
      verdict: {
        requested: "json_object",
        servedLevel: "json_object",
        guaranteed: false,
        valid: true,
        repairAttempts: 0,
      },
      parsed: { city: "Paris", population: 2_100_000 },
      raw: '{"city":"Paris","population":2100000}',
    });
    expect(render.body).toBe(
      '{\n  "city": "Paris",\n  "population": 2100000\n}',
    );
    expect(render.warnings).toEqual([]);
    // Transparency note reports requested vs served + guaranteed.
    expect(render.notes.join("\n")).toContain(
      "requested json_object · served json_object · guaranteed: false",
    );
  });

  it("adds the Gemini-only honesty caveat whenever the level was not guaranteed", () => {
    const render = formatStructuredOutput({
      verdict: {
        requested: "json_schema",
        servedLevel: "json_object",
        guaranteed: false,
        valid: true,
        repairAttempts: 0,
      },
      parsed: { ok: true },
      raw: '{"ok":true}',
    });
    expect(render.notes).toContain(STRUCTURED_GUARANTEE_CAVEAT);
    expect(STRUCTURED_GUARANTEE_CAVEAT).toMatch(/only Gemini/i);
  });

  it("omits the caveat when the provider GUARANTEED schema conformance", () => {
    const render = formatStructuredOutput({
      verdict: {
        requested: "json_schema",
        servedLevel: "json_schema",
        guaranteed: true,
        valid: true,
        repairAttempts: 1,
      },
      parsed: { ok: true },
      raw: '{"ok":true}',
    });
    expect(render.notes).not.toContain(STRUCTURED_GUARANTEE_CAVEAT);
    expect(render.notes.join("\n")).toContain("guaranteed: true");
  });

  it("warns (NON-FATAL) and echoes the raw output when the result did not conform", () => {
    const raw = '{"city":123}';
    const render = formatStructuredOutput({
      verdict: {
        requested: "json_schema",
        servedLevel: "prompt",
        guaranteed: false,
        valid: false,
        repairAttempts: 2,
        issues: [{ path: "/city", message: "must be string" }],
      },
      parsed: undefined,
      raw,
    });
    // No throw: the body is the model's raw output, the failure is a warning.
    expect(render.body).toBe(raw);
    expect(render.warnings[0]).toMatch(/did not conform after 2 repair attempt/i);
    expect(render.warnings.join("\n")).toContain("/city: must be string");
  });

  it("falls back to raw text (no crash) when there is no engine verdict", () => {
    const render = formatStructuredOutput({
      verdict: undefined,
      parsed: undefined,
      raw: "not json at all",
    });
    expect(render.body).toBe("not json at all");
    expect(render.warnings).toEqual([]);
    expect(render.notes).toEqual([]);
  });
});
