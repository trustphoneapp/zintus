"use client";

import { useEffect, useState } from "react";

export type DesktopPlatform = "mac" | "windows" | "linux";

/**
 * Which desktop OS the webview runs on. UA-based (navigator.platform is
 * deprecated): WebView2 carries "Windows NT", WKWebView "Macintosh",
 * WebKitGTK "X11; Linux"/"Wayland". Must stay the mirror of
 * PLATFORM_INIT_SCRIPT (lib/platform-init.ts) — the unit test pins them.
 */
export function desktopPlatform(): DesktopPlatform {
  if (typeof navigator === "undefined") return "mac";
  const ua = navigator.userAgent;
  if (/Windows/i.test(ua)) return "windows";
  if (/Mac/i.test(ua)) return "mac";
  return "linux";
}

/** True on macOS (webview). SSR has no navigator — callers use the hook below. */
export function isMacPlatform(): boolean {
  return typeof navigator !== "undefined" && desktopPlatform() === "mac";
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
