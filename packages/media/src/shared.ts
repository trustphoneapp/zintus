/**
 * Runtime-agnostic image core: magic-byte mime detection, header dimension
 * reads, container-level metadata stripping (EXIF/GPS/XMP/text), base64, and
 * the typed error surface. Imported by BOTH the browser and the node paths.
 *
 * SECURITY INVARIANTS (enforced here, relied on by callers):
 *  - The accepted mime is ALWAYS derived from the bytes' magic number, never
 *    from a caller-supplied `mimeType` hint. SVG/GIF/PDF/video/unknown are
 *    rejected. SVG is rejected on purpose (XML/script execution surface).
 *  - `image.data` (base64) and the raw bytes are NEVER placed in a thrown
 *    error message and NEVER logged. Error messages carry only sizes, counts,
 *    dimensions and mime labels.
 */

/** The only mime types this package will ever emit / accept. */
export type AcceptedMime = "image/jpeg" | "image/png" | "image/webp";

export type ImageInput = Blob | ArrayBuffer | Uint8Array | { path: string };

export interface ProcessImageOptions {
  /** Optional display name carried onto the output block. */
  name?: string;
  /**
   * Advisory only. The real type is ALWAYS sniffed from the bytes' magic
   * number; this hint never overrides detection (security: don't trust the
   * caller's label). Present for API completeness.
   */
  mimeType?: string;
  /** Reject inputs larger than this BEFORE any processing. Default 15 MiB. */
  maxInputBytes?: number;
  /** Processed output must be <= this. Default 4 MiB. */
  maxOutputBytes?: number;
  /** Longest output edge. Default 2048. */
  maxLongestEdge?: number;
}

export const DEFAULT_MAX_INPUT_BYTES = 15 * 1024 * 1024;
export const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
export const DEFAULT_MAX_LONGEST_EDGE = 2048;

export interface ResolvedOptions {
  name: string | undefined;
  maxInputBytes: number;
  maxOutputBytes: number;
  maxLongestEdge: number;
}

export function resolveOptions(options?: ProcessImageOptions): ResolvedOptions {
  return {
    name: options?.name,
    maxInputBytes: options?.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES,
    maxOutputBytes: options?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    maxLongestEdge: options?.maxLongestEdge ?? DEFAULT_MAX_LONGEST_EDGE,
  };
}

export type MediaErrorCode =
  | "EMPTY_INPUT"
  | "INPUT_TOO_LARGE"
  | "OUTPUT_TOO_LARGE"
  | "DIMENSIONS_TOO_LARGE"
  | "UNSUPPORTED_TYPE"
  | "UNSUPPORTED_INPUT"
  | "DECODE_FAILED";

/**
 * The single typed error this package throws. `message` is always safe to log
 * (sizes / dimensions / mime labels only — never image bytes or base64).
 */
export class MediaError extends Error {
  readonly code: MediaErrorCode;
  constructor(code: MediaErrorCode, message: string) {
    super(message);
    this.name = "MediaError";
    this.code = code;
  }
}

export interface Dimensions {
  width: number;
  height: number;
}

// ── input normalization (no node:fs here — keeps this browser-safe) ─────────

export function isPathInput(input: ImageInput): input is { path: string } {
  return (
    typeof input === "object" &&
    input !== null &&
    "path" in input &&
    typeof (input as { path: unknown }).path === "string"
  );
}

/** Normalize the browser-safe inputs. `{ path }` is rejected here (node only). */
export async function bytesFromBlobLike(input: ImageInput): Promise<Uint8Array> {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (typeof Blob !== "undefined" && input instanceof Blob) {
    return new Uint8Array(await input.arrayBuffer());
  }
  if (isPathInput(input)) {
    throw new MediaError(
      "UNSUPPORTED_INPUT",
      "{ path } input is only supported in Node/Bun, not in the browser",
    );
  }
  throw new MediaError("UNSUPPORTED_INPUT", "unsupported image input value");
}

// ── base64 (raw, NO data: prefix) ───────────────────────────────────────────

export function toBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
  }
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// ── byte helpers ────────────────────────────────────────────────────────────

function dv(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function startsWith(bytes: Uint8Array, sig: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i++) {
    if (bytes[offset + i] !== sig[i]) return false;
  }
  return true;
}

function fourCC(view: DataView, off: number): string {
  return String.fromCharCode(
    view.getUint8(off),
    view.getUint8(off + 1),
    view.getUint8(off + 2),
    view.getUint8(off + 3),
  );
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// ── mime detection (magic bytes only) ───────────────────────────────────────

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

function describeRejected(bytes: Uint8Array): string {
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif";
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46])) return "application/pdf";
  if (startsWith(bytes, [0x42, 0x4d])) return "image/bmp";
  if (
    startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) ||
    startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])
  ) {
    return "image/tiff";
  }
  if (looksLikeSvgOrXml(bytes)) return "image/svg+xml";
  return "unknown";
}

function looksLikeSvgOrXml(bytes: Uint8Array): boolean {
  const head = new TextDecoder("latin1")
    .decode(bytes.subarray(0, 256))
    .toLowerCase();
  const trimmed = head.replace(/^[\s﻿]+/, "");
  return (
    trimmed.startsWith("<?xml") ||
    trimmed.startsWith("<svg") ||
    (trimmed.startsWith("<") && trimmed.includes("<svg"))
  );
}

/**
 * Return the accepted mime derived from magic bytes, or throw UNSUPPORTED_TYPE.
 * Only image/jpeg, image/png and image/webp are accepted — everything else
 * (svg, gif, pdf, video, unknown binary) is rejected.
 */
export function detectMime(bytes: Uint8Array): AcceptedMime {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, PNG_SIG)) return "image/png";
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)
  ) {
    return "image/webp";
  }
  throw new MediaError(
    "UNSUPPORTED_TYPE",
    `unsupported image type (${describeRejected(bytes)}); accepted: image/jpeg, image/png, image/webp`,
  );
}

// ── dimensions (header reads, no pixel decode) ──────────────────────────────

const SOF_EXCLUDED = new Set([0xc4, 0xc8, 0xcc]); // DHT, JPG, DAC are NOT SOF

function readJpegDimensions(bytes: Uint8Array): Dimensions {
  const view = dv(bytes);
  const len = bytes.length;
  let i = 2;
  while (i + 4 <= len) {
    if (view.getUint8(i) !== 0xff) throw new MediaError("DECODE_FAILED", "malformed JPEG marker");
    const marker = view.getUint8(i + 1);
    if (marker === 0xd9 || marker === 0xda) break; // EOI / SOS — no SOF beyond
    if (marker >= 0xd0 && marker <= 0xd7) {
      i += 2;
      continue;
    }
    const segLen = view.getUint16(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && !SOF_EXCLUDED.has(marker)) {
      const ds = i + 4;
      if (ds + 5 > len) throw new MediaError("DECODE_FAILED", "truncated JPEG SOF");
      return { height: view.getUint16(ds + 1), width: view.getUint16(ds + 3) };
    }
    i += 2 + segLen;
  }
  throw new MediaError("DECODE_FAILED", "no JPEG frame header");
}

function readPngDimensions(bytes: Uint8Array): Dimensions {
  if (bytes.length < 24) throw new MediaError("DECODE_FAILED", "truncated PNG header");
  const view = dv(bytes);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function readWebpDimensions(bytes: Uint8Array): Dimensions {
  const view = dv(bytes);
  const len = bytes.length;
  let vp8: Dimensions | undefined;
  let i = 12;
  while (i + 8 <= len) {
    const cc = fourCC(view, i);
    const size = view.getUint32(i + 4, true);
    const ds = i + 8;
    const padded = size + (size & 1);
    if (ds + size > len) throw new MediaError("DECODE_FAILED", "truncated WebP chunk");
    if (cc === "VP8X") {
      const w = (view.getUint8(ds + 4) | (view.getUint8(ds + 5) << 8) | (view.getUint8(ds + 6) << 16)) + 1;
      const h = (view.getUint8(ds + 7) | (view.getUint8(ds + 8) << 8) | (view.getUint8(ds + 9) << 16)) + 1;
      return { width: w, height: h }; // extended header is authoritative
    }
    if (cc === "VP8L" && vp8 === undefined) {
      const b = view.getUint32(ds + 1, true);
      vp8 = { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
    }
    if (cc === "VP8 " && vp8 === undefined) {
      vp8 = {
        width: view.getUint16(ds + 6, true) & 0x3fff,
        height: view.getUint16(ds + 8, true) & 0x3fff,
      };
    }
    i = ds + padded;
  }
  if (vp8) return vp8;
  throw new MediaError("DECODE_FAILED", "no WebP frame header");
}

export function readDimensions(mime: AcceptedMime, bytes: Uint8Array): Dimensions {
  switch (mime) {
    case "image/jpeg":
      return readJpegDimensions(bytes);
    case "image/png":
      return readPngDimensions(bytes);
    case "image/webp":
      return readWebpDimensions(bytes);
  }
}

// ── metadata stripping (container surgery — genuinely removes EXIF/GPS/XMP) ──

/** Strip every APPn (incl. APP1/EXIF, APP1/XMP, APP2/ICC) and COM segment. */
function stripJpeg(bytes: Uint8Array): Uint8Array {
  const view = dv(bytes);
  const len = bytes.length;
  const parts: Uint8Array[] = [bytes.subarray(0, 2)]; // SOI
  let i = 2;
  while (i + 2 <= len) {
    if (view.getUint8(i) !== 0xff) throw new MediaError("DECODE_FAILED", "malformed JPEG marker");
    const marker = view.getUint8(i + 1);
    if (marker === 0xd9) {
      parts.push(bytes.subarray(i, i + 2)); // EOI
      break;
    }
    if (marker === 0xda) {
      parts.push(bytes.subarray(i, len)); // SOS + entropy data + trailer, verbatim
      break;
    }
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      parts.push(bytes.subarray(i, i + 2)); // standalone marker, keep
      i += 2;
      continue;
    }
    if (i + 4 > len) throw new MediaError("DECODE_FAILED", "truncated JPEG segment");
    const segEnd = i + 2 + view.getUint16(i + 2);
    if (segEnd > len) throw new MediaError("DECODE_FAILED", "truncated JPEG segment");
    const isMetadata = (marker >= 0xe0 && marker <= 0xef) || marker === 0xfe; // APPn / COM
    if (!isMetadata) parts.push(bytes.subarray(i, segEnd));
    i = segEnd;
  }
  return concat(parts);
}

// Keep image-critical + render-affecting chunks; drop everything else
// (eXIf, tEXt, zTXt, iTXt, tIME, dSIG, private/unknown ancillary => metadata).
const PNG_KEEP = new Set([
  "IHDR",
  "PLTE",
  "IDAT",
  "IEND",
  "tRNS",
  "gAMA",
  "cHRM",
  "sRGB",
  "iCCP",
  "bKGD",
  "sBIT",
  "pHYs",
]);

function stripPng(bytes: Uint8Array): Uint8Array {
  const view = dv(bytes);
  const len = bytes.length;
  const parts: Uint8Array[] = [bytes.subarray(0, 8)]; // signature
  let i = 8;
  while (i + 8 <= len) {
    const clen = view.getUint32(i);
    const type = fourCC(view, i + 4);
    const total = 12 + clen; // length(4) + type(4) + data + crc(4)
    if (i + total > len) throw new MediaError("DECODE_FAILED", "truncated PNG chunk");
    if (PNG_KEEP.has(type)) parts.push(bytes.subarray(i, i + total));
    i += total;
    if (type === "IEND") break;
  }
  return concat(parts);
}

const VP8X_EXIF_FLAG = 0x08;
const VP8X_XMP_FLAG = 0x04;

function stripWebp(bytes: Uint8Array): Uint8Array {
  const view = dv(bytes);
  const len = bytes.length;
  const body: Uint8Array[] = [];
  let i = 12;
  while (i + 8 <= len) {
    const cc = fourCC(view, i);
    const size = view.getUint32(i + 4, true);
    const ds = i + 8;
    const padded = size + (size & 1);
    if (ds + size > len) throw new MediaError("DECODE_FAILED", "truncated WebP chunk");
    if (cc === "EXIF" || cc === "XMP ") {
      i = ds + padded;
      continue; // drop metadata chunk
    }
    const chunk = bytes.subarray(i, ds + padded).slice();
    if (cc === "VP8X" && chunk.length >= 9) {
      const cdv = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      cdv.setUint8(8, cdv.getUint8(8) & ~(VP8X_EXIF_FLAG | VP8X_XMP_FLAG));
    }
    body.push(chunk);
    i = ds + padded;
  }
  const joined = concat(body);
  const out = new Uint8Array(12 + joined.length);
  out.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  new DataView(out.buffer).setUint32(4, 4 + joined.length, true); // "WEBP" + body
  out.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
  out.set(joined, 12);
  return out;
}

/**
 * Remove all metadata segments/chunks from the container WITHOUT decoding
 * pixels. Genuinely strips EXIF (incl. GPS location), XMP, ICC text, comments
 * and PNG text chunks. Returns valid bytes of the same `mime`.
 */
export function stripMetadata(mime: AcceptedMime, bytes: Uint8Array): Uint8Array {
  switch (mime) {
    case "image/jpeg":
      return stripJpeg(bytes);
    case "image/png":
      return stripPng(bytes);
    case "image/webp":
      return stripWebp(bytes);
  }
}

// ── runtime capability probe ────────────────────────────────────────────────

/**
 * True only when the runtime can genuinely decode/resize/re-encode pixels via
 * Web canvas APIs (browsers). Bun and Node return false (they have no canvas),
 * so they take the metadata-strip path.
 */
export function hasCanvasSupport(): boolean {
  return (
    typeof createImageBitmap === "function" &&
    typeof OffscreenCanvas === "function"
  );
}
