/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./app/**/*.{js,jsx,ts,tsx}", "./components/**/*.{js,jsx,ts,tsx}"],
  presets: [require("nativewind/preset")],
  theme: {
    extend: {
      colors: {
        surface: "#0b0f14",
        panel: "#111827",
        accent: "#0ea5e9",
        muted: "#6b7280",
        ink: "#e8eef5",
      },
    },
  },
  plugins: [],
};
