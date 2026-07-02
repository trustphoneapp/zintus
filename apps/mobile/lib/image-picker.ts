import * as ImagePicker from "expo-image-picker";
import {
  ImageManipulator,
  SaveFormat,
} from "expo-image-manipulator";
import type { ImageContentBlock } from "@zintus/types";
import {
  MAX_IMAGES_PER_MESSAGE,
  base64ByteLength,
} from "./image-attachments";

/**
 * Native image capture/pick + on-device processing → honest
 * `ImageContentBlock`s. The EXIF strip is REAL: expo-image-manipulator decodes
 * to a bitmap and RE-ENCODES to JPEG, so the original EXIF/GPS/metadata is gone
 * from the output (that is what `exifStripped: true` asserts). We also resize to
 * a bounded longest edge and compress, mirroring the gateway/@zintus/media caps.
 *
 * SECURITY: image bytes/base64 are never logged; they only ride the message
 * content to the gateway. Nothing here touches the relay.
 */

/** Bounded output: longest edge + compression, matching @zintus/media defaults. */
const MAX_LONGEST_EDGE = 2048;
const JPEG_QUALITY = 0.8;
/** Reject a processed image larger than this (mirrors the gateway 4 MiB cap). */
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export type ImagePickResult =
  | { ok: true; blocks: ImageContentBlock[] }
  | { ok: false; reason: string };

/**
 * Resize (longest edge ≤ 2048), re-encode to JPEG (drops EXIF), and read base64.
 * Returns an `ImageContentBlock` or a reason string when it exceeds the cap.
 */
async function processAsset(
  asset: ImagePicker.ImagePickerAsset,
): Promise<ImageContentBlock | { error: string }> {
  const longest = Math.max(asset.width ?? 0, asset.height ?? 0);
  const context = ImageManipulator.manipulate(asset.uri);
  if (longest > MAX_LONGEST_EDGE) {
    // Resize by the longer dimension so aspect ratio is preserved.
    if ((asset.width ?? 0) >= (asset.height ?? 0)) {
      context.resize({ width: MAX_LONGEST_EDGE });
    } else {
      context.resize({ height: MAX_LONGEST_EDGE });
    }
  }
  const image = await context.renderAsync();
  const result = await image.saveAsync({
    format: SaveFormat.JPEG,
    compress: JPEG_QUALITY,
    base64: true,
  });
  const data = result.base64;
  if (!data) return { error: "Could not read the image data." };
  const bytes = base64ByteLength(data);
  if (bytes > MAX_OUTPUT_BYTES) {
    return {
      error: `Image is too large after compression (${Math.round(bytes / 1024 / 1024)} MB). Try a smaller image.`,
    };
  }
  return {
    type: "image",
    data,
    mimeType: "image/jpeg",
    bytes,
    width: result.width,
    height: result.height,
    exifStripped: true,
  };
}

/** Shared post-pick processing for library/camera results. */
async function toBlocks(
  result: ImagePicker.ImagePickerResult,
  slotsRemaining: number,
): Promise<ImagePickResult> {
  if (result.canceled) return { ok: true, blocks: [] };
  const assets = result.assets.slice(0, Math.max(0, slotsRemaining));
  const blocks: ImageContentBlock[] = [];
  for (const asset of assets) {
    const processed = await processAsset(asset);
    if ("error" in processed) return { ok: false, reason: processed.error };
    blocks.push(processed);
  }
  return { ok: true, blocks };
}

/**
 * Pick up to `slotsRemaining` images from the photo library (system photo
 * picker — no runtime permission needed on modern OSes). Text stays in the
 * composer; these become image blocks.
 */
export async function pickImagesFromLibrary(
  slotsRemaining = MAX_IMAGES_PER_MESSAGE,
): Promise<ImagePickResult> {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    allowsMultipleSelection: slotsRemaining > 1,
    selectionLimit: Math.max(1, slotsRemaining),
    quality: 1,
    exif: false,
  });
  return toBlocks(result, slotsRemaining);
}

/**
 * Capture one image from the camera. Requests camera permission in-context
 * (this user action); returns an honest reason when denied.
 */
export async function captureImageFromCamera(
  slotsRemaining = MAX_IMAGES_PER_MESSAGE,
): Promise<ImagePickResult> {
  const perm = await ImagePicker.requestCameraPermissionsAsync();
  if (!perm.granted) {
    return {
      ok: false,
      reason:
        "Camera permission was denied. Enable it in your device Settings to take a photo.",
    };
  }
  const result = await ImagePicker.launchCameraAsync({
    mediaTypes: ["images"],
    quality: 1,
    exif: false,
  });
  return toBlocks(result, slotsRemaining);
}
