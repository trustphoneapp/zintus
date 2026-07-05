import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { AppShell } from "./_components/AppShell";
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
      {/* NOTE: no inline <head> scripts. The static export streams head
          content through the RSC payload and React's client insertion never
          EXECUTES inline scripts (verified by the S6 selftest — theme/
          platform/hairline scripts silently did nothing). That boot logic
          lives in lib/boot.ts (module scope of the first client chunk,
          imported by AppShell); CSS fallbacks cover the pre-JS frames. */}
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
