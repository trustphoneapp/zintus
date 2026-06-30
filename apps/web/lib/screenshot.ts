/**
 * Real browser screen capture for the composer's "Take a screenshot" action.
 *
 * Uses the Screen Capture API (`getDisplayMedia`) — the user picks a screen,
 * window, or tab via the browser's native prompt; we grab a single frame and
 * return it as a PNG File. The caller runs it through @zintus/media (resize +
 * EXIF strip) exactly like any attached image, so the same vision guard and
 * "never silently drop" rules apply. No capture data is logged.
 *
 * Support is Chromium/Firefox desktop only; `screenshotSupported()` lets the UI
 * disable the control honestly elsewhere rather than fail at click time.
 */

export function screenshotSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getDisplayMedia === "function" &&
    typeof window !== "undefined" &&
    typeof window.HTMLCanvasElement !== "undefined"
  );
}

/** Error whose message is safe to surface to the user (no capture bytes). */
export class ScreenshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScreenshotError";
  }
}

/**
 * Prompt for a screen/window/tab and return one captured frame as a PNG File,
 * or throw a ScreenshotError. Resolves only after the frame is drawn; always
 * stops the capture track so the browser's "sharing" indicator clears.
 */
export async function captureScreenshotFile(): Promise<File> {
  if (!screenshotSupported()) {
    throw new ScreenshotError(
      "Screen capture isn't available in this browser — try Chrome, Edge, or Firefox on desktop.",
    );
  }

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: false,
    });
  } catch (err) {
    // The user cancelling the picker lands here too — treat it as a quiet abort.
    if (err instanceof DOMException && err.name === "NotAllowedError") {
      throw new ScreenshotError("Screen capture was cancelled.");
    }
    throw new ScreenshotError("Couldn't start screen capture.");
  }

  try {
    const video = document.createElement("video");
    video.srcObject = stream;
    video.muted = true;
    await video.play();

    // One animation frame so the first real frame is decoded before we draw.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    const width = video.videoWidth;
    const height = video.videoHeight;
    if (width === 0 || height === 0) {
      throw new ScreenshotError("Captured an empty frame — try again.");
    }

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new ScreenshotError("Couldn't read the captured frame.");
    ctx.drawImage(video, 0, 0, width, height);

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), "image/png"),
    );
    if (!blob) throw new ScreenshotError("Couldn't encode the screenshot.");

    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    return new File([blob], `screenshot-${stamp}.png`, { type: "image/png" });
  } finally {
    for (const track of stream.getTracks()) track.stop();
  }
}
