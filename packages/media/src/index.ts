/**
 * @zintus/media — turn raw image input into the `ImageContentBlock` shape the
 * vision pipeline consumes (raw base64, EXIF-stripped, size/dimension bounded).
 * Works in the browser (genuine canvas decode/resize/re-encode) and in
 * Node/Bun (genuine container-level EXIF/metadata strip). One public
 * `processImage`; the runtime is detected internally.
 *
 * Image bytes and the resulting base64 are NEVER logged and NEVER appear in a
 * thrown error message, and nothing is ever persisted. See shared.ts security
 * invariants.
 */
import type { ImageContentBlock } from "@zintus/types";
import { hasCanvasSupport } from "./shared.js";
import { processImageBrowser } from "./browser.js";
import { processImageNode } from "./node.js";

export type { ImageInput, ProcessImageOptions, MediaErrorCode } from "./shared.js";
export {
  MediaError,
  DEFAULT_MAX_INPUT_BYTES,
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_MAX_LONGEST_EDGE,
} from "./shared.js";
export type { ImageContentBlock } from "@zintus/types";

import type { ImageInput, ProcessImageOptions } from "./shared.js";

/**
 * Process an image into an `ImageContentBlock`:
 *  1. detect & validate the type from magic bytes (jpeg/png/webp only),
 *  2. enforce `maxInputBytes` BEFORE processing,
 *  3. resize so the longest edge <= `maxLongestEdge` (browser; Node rejects
 *     oversize — it has no pixel codec),
 *  4. strip EXIF/GPS/XMP metadata (browser: re-encode; Node: container surgery),
 *  5. enforce `maxOutputBytes` (browser re-compresses; Node rejects if over),
 *  6. emit raw base64 (NO `data:` prefix) with accurate bytes/width/height and
 *     `exifStripped: true`.
 *
 * Throws a typed {@link MediaError} on any rejection. Error messages never
 * contain image bytes or base64.
 */
export async function processImage(
  input: ImageInput,
  options?: ProcessImageOptions,
): Promise<ImageContentBlock> {
  if (hasCanvasSupport()) return processImageBrowser(input, options);
  return processImageNode(input, options);
}
