import type { Metadata } from "next";
import { PlaceholderPage } from "@/app/_components/PlaceholderPage";

export const metadata: Metadata = { title: "Changelog — Zintus" };

export default function ChangelogPage() {
  return (
    <PlaceholderPage title="Changelog">
      <p>Coming soon — check back shortly.</p>
    </PlaceholderPage>
  );
}
