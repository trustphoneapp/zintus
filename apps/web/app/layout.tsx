import type { Metadata } from "next";
import { Inter, JetBrains_Mono, Lora, Plus_Jakarta_Sans, Syne } from "next/font/google";
import { headers } from "next/headers";
import "@zintus/ui/globals.css";
import "./globals.css";
import { ThemeProvider } from "@/components/marketing/ThemeProvider";
import { GalaxyBackground } from "./components/GalaxyBackground";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const lora = Lora({
  subsets: ["latin"],
  variable: "--font-lora",
  display: "swap",
});

const plusJakartaSans = Plus_Jakarta_Sans({
  subsets: ["latin"],
  variable: "--font-plus-jakarta-sans",
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

const syne = Syne({
  subsets: ["latin"],
  variable: "--font-syne",
  display: "swap",
  weight: ["400", "600", "700", "800"],
});

export const metadata: Metadata = {
  metadataBase: new URL("https://www.zintus.ai"),
  title: "Zintus — Free AI Router | 12 Providers, Zero Markup",
  description:
    "Route prompts across Cerebras, Groq, Gemini, DeepSeek and 8 more free AI providers. Smart quota routing, <5ms latency, your keys on your device. Free forever.",
  keywords: [
    "free AI API",
    "AI router",
    "BYOK",
    "Groq free tier",
    "Gemini free API",
    "OpenRouter alternative",
    "free LLM API",
  ],
  openGraph: {
    title: "Zintus — Free AI Router",
    description:
      "12 free AI providers. Smart routing. Your keys. Zero markup.",
    url: "https://www.zintus.ai",
    siteName: "Zintus",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Zintus — Free AI Router",
    description: "Route smarter. Pay nothing.",
  },
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // The per-request CSP nonce set by proxy.ts. Forwarded to next-themes so its
  // anti-FOUC inline <script> carries the nonce and isn't blocked by the
  // 'strict-dynamic' script-src (which would otherwise log a CSP violation and
  // flash the wrong theme on first paint). Reading headers() also opts the tree
  // into dynamic rendering so the live nonce is stamped into the HTML instead of
  // a stale build-time value.
  const nonce = (await headers()).get("x-nonce") ?? undefined;

  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${inter.variable} ${plusJakartaSans.variable} ${jetbrainsMono.variable} ${lora.variable} ${syne.variable}`}
    >
      <body className={plusJakartaSans.className}>
        <GalaxyBackground />
        <ThemeProvider nonce={nonce}>{children}</ThemeProvider>
      </body>
    </html>
  );
}
