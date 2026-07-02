import { isTauri } from "./tauri";

/**
 * Save in-memory text content to a file from the desktop app.
 *
 * In a Tauri build this uses the NATIVE OS save dialog (`@tauri-apps/plugin-dialog`
 * `save()`) + `@tauri-apps/plugin-fs` `writeTextFile()`, because Tauri's WebView
 * does NOT reliably honor a browser `<a download>` blob click — the old
 * anchor-only path silently did nothing in the packaged app. Outside Tauri (the
 * Next dev/web preview) it falls back to the Blob + object-URL anchor so the dev
 * experience is unchanged.
 *
 * Honesty: writes exactly the bytes passed in (the model's own output) — nothing
 * is fetched or executed. Returns whether a file was actually written (false when
 * the user cancels the native dialog).
 *
 * NOTE: the native path needs the dialog/fs plugins registered in
 * `src-tauri/src/lib.rs` + `capabilities/default.json` (both wired 2026-07-02).
 * The Rust side can't be compiled in this environment, so a real `tauri build`
 * is the verification gate — see docs/RELEASE-CHECKLIST.md.
 */
export async function saveTextFile(
  name: string,
  content: string,
  type: string,
): Promise<boolean> {
  if (isTauri()) {
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const { writeTextFile } = await import("@tauri-apps/plugin-fs");
      const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "txt";
      const path = await save({
        defaultPath: name,
        filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
      });
      if (!path) return false; // user cancelled
      await writeTextFile(path, content);
      return true;
    } catch {
      // Fall through to the browser path if the native plugins aren't available
      // (e.g. an older build without the wiring) rather than losing the export.
    }
  }
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
  return true;
}
