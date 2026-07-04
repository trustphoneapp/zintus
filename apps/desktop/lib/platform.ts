"use client";

import { useEffect, useState } from "react";

/** True on macOS (webview). SSR has no navigator — callers use the hook below. */
export function isMacPlatform(): boolean {
  return typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);
}

/**
 * Platform-correct shortcut glyphs: "⌘N" on macOS, "Ctrl+N" elsewhere.
 * SSR renders the mac form; the post-mount swap is a benign reflow (same
 * pattern as AppShell's titlebar chrome).
 */
export function useShortcutGlyphs() {
  const [mac, setMac] = useState(true);
  useEffect(() => {
    setMac(isMacPlatform());
  }, []);
  return {
    mac,
    /** e.g. mod("N") → "⌘N" | "Ctrl+N" */
    mod: (key: string) => (mac ? `⌘${key}` : `Ctrl+${key}`),
    /** e.g. shiftMod("F") → "⌘⇧F" | "Ctrl+Shift+F" */
    shiftMod: (key: string) => (mac ? `⌘⇧${key}` : `Ctrl+Shift+${key}`),
    /** the send chord: "⌘↵" | "Ctrl+↵" */
    send: mac ? "⌘↵" : "Ctrl+↵",
  };
}
