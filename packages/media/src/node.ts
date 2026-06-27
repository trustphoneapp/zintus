/**
 * Node/Bun image path. No canvas is available (Bun/Node ship no
 * createImageBitmap/OffscreenCanvas) and `sharp` is not an installed,
 * browser-safe dependency, so this path does NOT decode pixels. It:
 *   - validates the type from magic bytes,
 *   - enforces the input-size cap BEFORE processing,
 *   - reads true dimensions from the header,
 *   - GENUINELY strips EXIF/GPS/XMP/text metadata via container surgery
 *     (=> exifStripped:true is honest),
 *   - enforces the output-size cap.
 *
 * LIMITATION (documented, not silent): without a pixel codec it cannot
 * downscale or re-compress. An image whose longest edge exceeds
 * `maxLongestEdge`, or whose stripped size exceeds `maxOutputBytes`, is
 * REJECTED with a clear typed error rather than silently passed through.
 * (The browser path resizes/re-compresses via canvas.)
 */
import type { ImageContentBlock } from "@zintus/types";
import {
  bytesFromBlobLike,
  detectMime,
  isPathInput,
  MediaError,
  readDimensions,
  resolveOptions,
  stripMetadata,
  toBase64,
  type ImageInput,
  type ProcessImageOptions,
} from "./shared.js";

async function toBytesNode(input: ImageInput): Promise<Uint8Array> {
  if (isPathInput(input)) {
    const { readFile } = await import("node:fs/promises");
    const buf = await readFile(input.path);
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  return bytesFromBlobLike(input);
}

function baseName(p: string): string | undefined {
  const seg = p.split(/[\\/]/).pop();
  return seg && seg.length > 0 ? seg : undefined;
}

export async function processImageNode(
  input: ImageInput,
  options?: ProcessImageOptions,
): Promise<ImageContentBlock> {
  const opts = resolveOptions(options);
  const derivedName = isPathInput(input) ? baseName(input.path) : undefined;

  const bytes = await toBytesNode(input);

  if (bytes.length === 0) {
    throw new MediaError("EMPTY_INPUT", "image input is empty (0 bytes)");
  }
  // Enforce the input cap BEFORE any parsing/processing.
  if (bytes.length > opts.maxInputBytes) {
    throw new MediaError(
      "INPUT_TOO_LARGE",
      `input ${bytes.length} bytes exceeds maxInputBytes ${opts.maxInputBytes}`,
    );
  }

  const mime = detectMime(bytes);
  const { width, height } = readDimensions(mime, bytes);

  const longest = Math.max(width, height);
  if (longest > opts.maxLongestEdge) {
    throw new MediaError(
      "DIMENSIONS_TOO_LARGE",
      `longest edge ${longest}px exceeds maxLongestEdge ${opts.maxLongestEdge}px; ` +
        `this (Node) build cannot downscale without an image codec — resize the source first`,
    );
  }

  const stripped = stripMetadata(mime, bytes);

  if (stripped.length > opts.maxOutputBytes) {
    throw new MediaError(
      "OUTPUT_TOO_LARGE",
      `processed image ${stripped.length} bytes exceeds maxOutputBytes ${opts.maxOutputBytes}; ` +
        `this (Node) build cannot re-compress without an image codec`,
    );
  }

  const name = opts.name ?? derivedName;
  return {
    type: "image",
    data: toBase64(stripped),
    mimeType: mime,
    bytes: stripped.length,
    width,
    height,
    exifStripped: true,
    ...(name !== undefined ? { name } : {}),
  };
}
