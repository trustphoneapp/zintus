"use client";

import { useEffect, useState } from "react";

export type DesktopPlatform = "mac" | "windows" | "linux";

/**
 * Which desktop OS the webview runs on. UA-based (navigator.platform is
 * deprecated): WebView2 carries "Windows NT", WKWebView "Macintosh",
 * WebKitGTK "X11; Linux"/"Wayland".
 */
export function desktopPlatform(
  ua: string | undefined = typeof navigator === "undefined" ? undefined : navigator.userAgent,
): DesktopPlatform {
  if (ua === undefined) return "mac";
  if (/Windows/i.test(ua)) return "windows";
  if (/Mac/i.test(ua)) return "mac";
  return "linux";
}

/**
 * Stamps `data-platform` on <html>. Platform chrome (titlebar strip height,
 * Windows caption buttons, top-bar padding) is pure CSS keyed on this
 * attribute (globals.css). Runs from lib/boot.ts before hydration paints
 * interactive UI; until then the CSS defaults are platform-neutral.
 */
export function stampPlatform(
  root: { dataset: Record<string, string | undefined> } | undefined = typeof document ===
  "undefined"
    ? undefined
    : document.documentElement,
  ua?: string,
): void {
  if (!root) return;
  root.dataset["platform"] = desktopPlatform(ua);
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
