/**
 * Tiny persistent thumbnail for a sent image bubble. The full processed bytes
 * ride ONLY in the gateway request (never thread history — see UiImageMeta);
 * blob preview URLs die with the session, which left restored threads showing
 * broken images. This produces a deliberate small exception: a ≤THUMB_PX JPEG
 * data URI (a few KB) that survives relaunch. DOM/canvas code — kept out of
 * image-attachments.ts so that module stays unit-testable under bun.
 */

// 320px covers the bubble's 120 CSS px at 2x retina (240 device px) with room
// to spare — the persisted fallback stays sharp instead of upscaled mush.
// ~15-25 KB JPEG per image, ≤4 per message.
export const THUMB_PX = 320;

export async function fileToThumb(
  file: Blob,
  maxPx = THUMB_PX,
): Promise<string | null> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxPx / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    // JPEG at 0.7 keeps a 96px thumb around 2-4 KB — cheap enough to persist
    // per message (≤4 images/turn) without bloating the thread store.
    return canvas.toDataURL("image/jpeg", 0.7);
  } catch {
    return null; // No thumb is honest — the bubble falls back to name metadata.
  }
}
