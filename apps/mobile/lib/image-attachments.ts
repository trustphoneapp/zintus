import type { ContentBlock, ImageContentBlock, ProviderId } from "@zintus/types";
import { supportsVision } from "@zintus/providers";

/**
 * Pure logic for the chat composer's IMAGE attachments — mirrors
 * apps/web/lib/image-attachments.ts so mobile sends the SAME honest multimodal
 * shape. Kept free of React Native / native modules so it unit-tests under bun
 * (the actual pick+process lives in lib/image-picker.ts).
 *
 * SECURITY: nothing here logs image bytes/base64. `ImageContentBlock.data` only
 * ever lands in the message `content` sent to the gateway — never the relay,
 * never a log.
 */

/** Max images per chat turn — mirrors the gateway's 413 cap. */
export const MAX_IMAGES_PER_MESSAGE = 4;

/** Remaining image slots given how many are already attached (never negative). */
export function imageSlotsRemaining(current: number): number {
  return Math.max(0, MAX_IMAGES_PER_MESSAGE - current);
}

/**
 * Build a user message `content` array for a turn that carries images: a single
 * leading TEXT block, then the processed image blocks IN ORDER. Never injects an
 * `[Image: name]` string — the gateway reads images from these blocks. Mirrors
 * web's `buildImageMessageContent`.
 */
export function buildImageMessageContent(
  text: string,
  blocks: ImageContentBlock[],
): ContentBlock[] {
  return [{ type: "text", text }, ...blocks];
}

/**
 * Whether an explicitly-selected provider can accept image input.
 * - Auto routing (no explicit provider) → `true`: the router picks a
 *   vision-capable provider, or the gateway returns a handled 422.
 * - A concrete non-vision provider → `false`: the composer warns before sending
 *   so we don't burn a request the provider can't serve.
 */
export function providerCanSeeImages(
  provider: ProviderId | "auto" | null | undefined,
  model?: string,
): boolean {
  if (!provider || provider === "auto") return true;
  return supportsVision(provider, model);
}

/** Human-readable size for a processed image block (e.g. "182 KB", "1.3 MB"). */
export function formatImageBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Exact byte length of a base64 string's decoded payload (no decoding). */
export function base64ByteLength(base64: string): number {
  const len = base64.length;
  if (len === 0) return 0;
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((len * 3) / 4) - padding;
}
