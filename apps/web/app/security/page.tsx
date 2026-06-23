import type { Metadata } from "next";
import { PlaceholderPage } from "@/app/_components/PlaceholderPage";

export const metadata: Metadata = { title: "Security — Zintus" };

export default function SecurityPage() {
  return (
    <PlaceholderPage title="Security">
      <p>
        Zintus is built BYOK-first: your API keys live in your OS keychain or your
        browser&apos;s encrypted storage, never on our servers, and prompts go
        straight from your device to each provider.
      </p>
      <p style={{ marginTop: "1rem" }}>
        A full security policy and disclosure process is coming soon — check back
        shortly.
      </p>
    </PlaceholderPage>
  );
}
