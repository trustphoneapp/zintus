import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { AppShell } from "./_components/AppShell";
import { THEME_INIT_SCRIPT } from "@/lib/theme";
import { HAIRLINE_INIT_SCRIPT } from "@/lib/hairline";
import { PLATFORM_INIT_SCRIPT } from "@/lib/platform-init";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Zintus",
  description: "Cross-platform AI router — desktop",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${jetbrainsMono.variable}`}
      // data-theme is OWNED by THEME_INIT_SCRIPT + lib/theme.ts (set pre-paint,
      // toggled at runtime). Deliberately NOT a React prop: React would reconcile
      // the attribute back on any client re-render and stomp the user's theme.
      suppressHydrationWarning
    >
      <head>
        {/* Applies the persisted/system theme before first paint (no flash). */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        {/* Sets --hairline to exactly one device pixel before first paint and
            tracks monitor/scale changes (fractional Windows dPRs — R2). */}
        <script dangerouslySetInnerHTML={{ __html: HAIRLINE_INIT_SCRIPT }} />
        {/* Stamps data-platform (mac|windows|linux) pre-paint; platform chrome
            is CSS keyed on it — no wrong-OS first frame (R6 item 1). */}
        <script dangerouslySetInnerHTML={{ __html: PLATFORM_INIT_SCRIPT }} />
      </head>
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
