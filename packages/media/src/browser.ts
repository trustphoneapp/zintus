/**
 * Browser image path. Uses Web canvas APIs (createImageBitmap + OffscreenCanvas)
 * to GENUINELY decode, downscale and RE-ENCODE. Re-encoding through a canvas
 * drops all source metadata, so `exifStripped:true` is honest, and it can
 * downscale to `maxLongestEdge` and re-compress (lower quality) to fit
 * `maxOutputBytes`.
 *
 * This path runs only where canvas exists (real browsers / workers). The test
 * runtime is Bun, which has no canvas, so coverage of this file comes from a
 * browser; the node path is what the bun:test suite exercises. Selection is
 * runtime-gated in index.ts via hasCanvasSupport().
 */
import type { ImageContentBlock } from "@zintus/types";
import {
  bytesFromBlobLike,
  detectMime,
  MediaError,
  resolveOptions,
  toBase64,
  type AcceptedMime,
  type ImageInput,
  type ProcessImageOptions,
} from "./shared.js";

// Quality ladder used when re-compressing lossy formats to fit the byte cap.
const QUALITY_LADDER = [0.9, 0.8, 0.7, 0.6, 0.5, 0.4];

async function encodeToFit(
  canvas: OffscreenCanvas,
  mime: AcceptedMime,
  maxOutputBytes: number,
): Promise<{ bytes: Uint8Array; mimeType: AcceptedMime }> {
  // PNG is lossless — a single encode; no quality dial to turn.
  if (mime === "image/png") {
    const blob = await canvas.convertToBlob({ type: "image/png" });
    return { bytes: new Uint8Array(await blob.arrayBuffer()), mimeType: "image/png" };
  }
  // JPEG / WebP: walk quality down until it fits (or take the smallest).
  let smallest: Uint8Array | undefined;
  for (const quality of QUALITY_LADDER) {
    const blob = await canvas.convertToBlob({ type: mime, quality });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (smallest === undefined || bytes.length < smallest.length) smallest = bytes;
    if (bytes.length <= maxOutputBytes) return { bytes, mimeType: mime };
  }
  // Could not fit; return the smallest we produced — caller enforces the cap.
  return { bytes: smallest ?? new Uint8Array(0), mimeType: mime };
}

export async function processImageBrowser(
  input: ImageInput,
  options?: ProcessImageOptions,
): Promise<ImageContentBlock> {
  const opts = resolveOptions(options);
  const bytes = await bytesFromBlobLike(input);

  if (bytes.length === 0) {
    throw new MediaError("EMPTY_INPUT", "image input is empty (0 bytes)");
  }
  if (bytes.length > opts.maxInputBytes) {
    throw new MediaError(
      "INPUT_TOO_LARGE",
      `input ${bytes.length} bytes exceeds maxInputBytes ${opts.maxInputBytes}`,
    );
  }

  // Sniff & reject (svg/gif/...) BEFORE handing bytes to createImageBitmap —
  // some engines will happily decode SVG, which is the exact attack surface
  // we refuse for v1.
  const mime = detectMime(bytes);

  let bitmap: ImageBitmap;
  try {
    // `.slice()` yields an ArrayBuffer-backed copy (a valid BlobPart) regardless
    // of whether `bytes` was a subview of a shared/offset buffer.
    bitmap = await createImageBitmap(new Blob([bytes.slice()], { type: mime }));
  } catch {
    throw new MediaError("DECODE_FAILED", `failed to decode ${mime} image`);
  }

  try {
    const longest = Math.max(bitmap.width, bitmap.height);
    const scale = longest > opts.maxLongestEdge ? opts.maxLongestEdge / longest : 1;
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new MediaError("DECODE_FAILED", "2d canvas context unavailable");
    ctx.drawImage(bitmap, 0, 0, width, height);

    const { bytes: outBytes, mimeType } = await encodeToFit(canvas, mime, opts.maxOutputBytes);
    if (outBytes.length === 0) {
      throw new MediaError("DECODE_FAILED", "re-encode produced no output");
    }
    if (outBytes.length > opts.maxOutputBytes) {
      throw new MediaError(
        "OUTPUT_TOO_LARGE",
        `processed image ${outBytes.length} bytes exceeds maxOutputBytes ${opts.maxOutputBytes} ` +
          `even at lowest quality`,
      );
    }

    return {
      type: "image",
      data: toBase64(outBytes),
      mimeType,
      bytes: outBytes.length,
      width,
      height,
      exifStripped: true,
      ...(opts.name !== undefined ? { name: opts.name } : {}),
    };
  } finally {
    bitmap.close();
  }
}
