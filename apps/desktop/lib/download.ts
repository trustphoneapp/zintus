/**
 * Save in-memory text content to a file from the desktop app.
 *
 * This reuses the SAME mechanism the chat header's "Export" already uses to save
 * a thread to markdown (see ChatPanel.exportThread): a Blob + object-URL anchor
 * click, which the Tauri WebView honors as a normal browser download. Keeping a
 * single helper means artifact Download and thread Export behave identically.
 *
 * Honesty: this writes exactly the bytes passed in (the model's own output) —
 * nothing is fetched or executed.
 *
 * [HUMAN] A native Tauri save dialog (let the user pick the path/name via the OS
 * sheet) would need the `@tauri-apps/plugin-dialog` + `@tauri-apps/plugin-fs`
 * plugins added to package.json, Cargo.toml, capabilities/default.json and the
 * Rust builder — none are installed today, and that native wiring can't be
 * compiled or exercised in this environment. When added, swap the anchor path
 * below for `save()` + `writeTextFile()` behind an `isTauri()` guard.
 */
export function saveTextFile(name: string, content: string, type: string): void {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
