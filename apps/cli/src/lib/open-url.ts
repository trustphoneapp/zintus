import { exec } from "node:child_process";

/**
 * Open a URL in the system default browser — cross-platform.
 * Best-effort; never throws (cloud login still works if browser fails to open).
 */
export async function openUrl(url: string): Promise<void> {
  const command =
    process.platform === "win32"
      ? `start "" "${url}"`
      : process.platform === "darwin"
        ? `open "${url}"`
        : `xdg-open "${url}"`;

  await new Promise<void>((resolve) => {
    exec(command, () => resolve());
  });
}
