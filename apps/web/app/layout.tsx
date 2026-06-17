import type { Metadata } from "next";
import { Inter, JetBrains_Mono, Lora, Plus_Jakarta_Sans } from "next/font/google";
import "@multipleai/ui/globals.css";
import "./globals.css";
import { ThemeProvider } from "@/components/marketing/ThemeProvider";

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

export const metadata: Metadata = {
  title: "MultipleAI — Use the best free AIs from one place",
  description:
    "MultipleAI connects you to 12 free AI services in one chat. Ask once and it automatically picks a fast, available model — and switches when one runs out. Free and open source.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${inter.variable} ${plusJakartaSans.variable} ${jetbrainsMono.variable} ${lora.variable}`}
    >
      <body className={plusJakartaSans.className}>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
