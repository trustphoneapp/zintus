import type { ContentBlock, ImageContentBlock, ProviderId } from "@zintus/types";
import { supportsVision } from "@zintus/providers";

/**
 * Pure logic for the desktop chat composer's image attachments. A direct mirror
 * of `apps/web/lib/image-attachments.ts` so desktop reaches image-input parity
 * with web through the SAME decisions. Kept free of React and DOM so it can be
 * unit-tested directly (the canvas path of `@zintus/media` can't run under
 * bun:test, but every decision here can).
 *
 * SECURITY: nothing in this module logs image bytes or base64. `ImageContentBlock.data`
 * is only ever placed into the message `content` that goes to the gateway.
 */

/** The only image MIME types the composer accepts — mirrors @zintus/media and the
 *  gateway's edge schema. svg/gif/bmp/pdf/video are rejected. */
export const ACCEPTED_IMAGE_MIMES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;
export type AcceptedImageMime = (typeof ACCEPTED_IMAGE_MIMES)[number];

/** Max images per chat turn — mirrors the gateway's 413 cap (apps/gateway/src/handler.ts). */
export const MAX_IMAGES_PER_MESSAGE = 4;

/** True when a file's MIME is an image type we accept. svg/gif/etc. are rejected. */
export function acceptImageFile(mime: string): mime is AcceptedImageMime {
  return (ACCEPTED_IMAGE_MIMES as readonly string[]).includes(mime);
}

/** True for any `image/*` MIME — used to branch image-vs-text in the picker before
 *  the stricter {@link acceptImageFile} gate decides accept/reject. */
export function isImageMime(mime: string): boolean {
  return mime.startsWith("image/");
}

/** Remaining image slots given how many are already attached (never negative). */
export function imageSlotsRemaining(current: number): number {
  return Math.max(0, MAX_IMAGES_PER_MESSAGE - current);
}

/**
 * Build a user message `content` array for a turn that carries images: a single
 * leading TEXT block, then the processed image blocks IN ORDER.
 *
 * This is the honest multimodal path: images ride as real `ImageContentBlock`s.
 * It NEVER injects an `[Image: name]` string into the prompt — the gateway reads
 * images from these blocks, not from a separate field or a fake text note.
 */
export function buildImageMessageContent(
  text: string,
  blocks: ImageContentBlock[],
): ContentBlock[] {
  return [{ type: "text", text }, ...blocks];
}

/**
 * Whether an explicitly-selected provider can accept image input.
 * - No explicit provider (auto routing) → `true`: the router picks a
 *   vision-capable provider, or the gateway returns a handled 422.
 * - Ollama → `true`: vision is RUNTIME-resolved at the gateway against the
 *   installed models (llava/moondream/…); it serves when one exists and 422s
 *   with a "what to pull" suggestion when none does. A static `false` here
 *   would block users who DO have a local vision model installed.
 * - Any other concrete non-vision provider → `false`: the UI warns before
 *   sending so we don't waste a request the provider can't serve.
 */
export function providerCanSeeImages(
  provider: ProviderId | null | undefined,
  model?: string,
): boolean {
  if (!provider) return true;
  if (provider === "ollama") return true;
  return supportsVision(provider, model);
}

/** Human-readable size for a processed image block (e.g. "182 KB", "1.3 MB"). */
export function formatImageBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
