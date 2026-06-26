import type { Metadata } from "next";
import { PlaceholderPage } from "@/app/_components/PlaceholderPage";

// Thin "Coming soon" stub: keep it out of search indexes (and the sitemap)
// until it has real content. robots.index:false renders
// <meta name="robots" content="noindex, follow" />.
// https://nextjs.org/docs/app/api-reference/functions/generate-metadata#robots
export const metadata: Metadata = {
  title: "Blog — Zintus",
  robots: { index: false, follow: true },
};

export default function BlogPage() {
  return (
    <PlaceholderPage title="Blog">
      <p>Coming soon.</p>
    </PlaceholderPage>
  );
}
