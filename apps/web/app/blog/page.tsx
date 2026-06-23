import type { Metadata } from "next";
import { PlaceholderPage } from "@/app/_components/PlaceholderPage";

export const metadata: Metadata = { title: "Blog — Zintus" };

export default function BlogPage() {
  return (
    <PlaceholderPage title="Blog">
      <p>Coming soon.</p>
    </PlaceholderPage>
  );
}
