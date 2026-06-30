/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./app/**/*.{js,jsx,ts,tsx}", "./components/**/*.{js,jsx,ts,tsx}"],
  presets: [require("nativewind/preset")],
  // 'class' (not 'media') so NativeWind allows manually setting the color
  // scheme — required on web; the app is dark-only and applies it itself.
  darkMode: "class",
  theme: {
    extend: {
      // Brand palette — mirrors lib/theme.ts COLORS (violet hue-295 system,
      // hex approximations of the canonical oklch tokens).
      colors: {
        surface: "#14121c",
        panel: "#1c1928",
        elevated: "#232032",
        accent: "#6366f1",
        "accent-bright": "#a78bfa",
        "purple-light": "#a78bfa",
        "on-accent": "#ffffff",
        ink: "#f5f4f8",
        sub: "#c6c3d0",
        muted: "#908d9e",
        border: "#2a2738",
        "user-bubble": "#27272b",
        "user-bubble-border": "#34343a",
        "user-text": "#f0f0f6",
        "send-disabled": "#3b3858",
        good: "#3ddc97",
        warn: "#e0b341",
        error: "#f4756b",
      },
    },
  },
  plugins: [],
};
