import type { Metadata } from "next";
import { PlaceholderPage } from "@/app/_components/PlaceholderPage";

export const metadata: Metadata = { title: "Privacy — Zintus" };

export default function PrivacyPage() {
  return (
    <PlaceholderPage title="Privacy">
      <p>
        Your prompts go directly from your device to the AI provider — Zintus never
        sees them. API keys are stored in your OS keychain or your browser&apos;s
        encrypted storage, not on our servers.
      </p>
      <p style={{ marginTop: "1rem" }}>
        Our full privacy policy is coming soon — check back shortly.
      </p>
    </PlaceholderPage>
  );
}
