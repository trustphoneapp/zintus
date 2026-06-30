// Single source of truth for the Zintus brand palette on mobile.
// Mirrors tailwind.config.js so StyleSheet-based screens and NativeWind
// className-based screens stay visually aligned. Neutral, professional accent
// (ChatGPT/Claude-style monochrome): the accent is a near-white used as a
// button/active fill on the dark UI, with dark text on top (onAccent).
export const COLORS = {
  surface: "#0b0f14",
  panel: "#111827",
  accent: "#e2e8f0",
  accentBright: "#f4f6f8",
  onAccent: "#0b0f14",
  muted: "#6b7280",
  ink: "#e8eef5",
  border: "#1f2937",
  error: "#f87171",
  warn: "#f59e0b",
  good: "#34d399",
} as const;
