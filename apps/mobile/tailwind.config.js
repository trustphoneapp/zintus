/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./app/**/*.{js,jsx,ts,tsx}", "./components/**/*.{js,jsx,ts,tsx}"],
  presets: [require("nativewind/preset")],
  theme: {
    extend: {
      colors: {
        surface: "#0b0f14",
        panel: "#111827",
        accent: "#e2e8f0",
        "accent-bright": "#f4f6f8",
        "on-accent": "#0b0f14",
        muted: "#6b7280",
        ink: "#e8eef5",
      },
    },
  },
  plugins: [],
};
