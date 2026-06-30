// Single source of truth for the Zintus brand palette on mobile.
// Mirrors tailwind.config.js so StyleSheet-based screens and NativeWind
// className-based screens stay visually aligned. The brand accent is the
// violet/indigo #6366f1 (white text on top), matching apps/web and the
// reference designs. React Native/NativeWind can't use oklch, so these are
// hex approximations of the canonical hue-295 tokens.
export const COLORS = {
  surface: "#14121c", // bg       oklch(15% 0.03 295)
  panel: "#1c1928", // surface  oklch(19% 0.035 295)
  elevated: "#232032", // elevated oklch(23% 0.04 295)
  accent: "#6366f1", // brand indigo/violet
  accentBright: "#a78bfa", // purple-light
  purpleLight: "#a78bfa", // alias (spec §1)
  onAccent: "#ffffff",
  ink: "#f5f4f8", // text
  sub: "#c6c3d0", // text-sub
  muted: "#908d9e", // text-muted
  border: "#2a2738",
  userBubble: "#27272b",
  userBubbleBorder: "#34343a",
  userText: "#f0f0f6",
  sendDisabled: "#3b3858", // muted accent for the disabled send button
  good: "#3ddc97", // green
  warn: "#e0b341",
  error: "#f4756b",
} as const;
