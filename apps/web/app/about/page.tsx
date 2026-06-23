import type { Metadata } from "next";
import { PlaceholderPage } from "@/app/_components/PlaceholderPage";

export const metadata: Metadata = { title: "About — Zintus" };

export default function AboutPage() {
  return (
    <PlaceholderPage title="About Zintus">
      <p>
        Zintus is built by YS Ventures LLC — a source-available AI router that sends
        your prompts directly to 12 free AI providers from your own device, with
        smart quota routing, automatic fallback, and zero markup.
      </p>
      <p style={{ marginTop: "1rem" }}>Made with ❤️ in Pittsburgh, PA.</p>
    </PlaceholderPage>
  );
}
