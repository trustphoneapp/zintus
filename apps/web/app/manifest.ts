import type { MetadataRoute } from "next";

// Next.js App Router metadata convention (MetadataRoute.Manifest):
// https://nextjs.org/docs/app/api-reference/file-conventions/metadata/manifest
//
// Auto-wired by Next as <link rel="manifest" href="/manifest.webmanifest">.
// The referenced icons are PLACEHOLDER Zintus marks (app/icon.svg + the generated
// app/apple-icon) pending the real brand asset — see those files. [HUMAN] no edit
// is needed here once the real assets land: the file-convention paths are stable.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Zintus",
    short_name: "Zintus",
    description:
      "Free AI router — 12 providers, smart quota routing, your keys on your device. Zero markup.",
    start_url: "/",
    display: "standalone",
    // Matches the app's dark violet brand background (see app/opengraph-image.tsx
    // and the dark token --color-bg). Used for the splash + browser UI chrome.
    background_color: "#0a0612",
    theme_color: "#0a0612",
    icons: [
      {
        src: "/icon.svg",
        type: "image/svg+xml",
        sizes: "any",
      },
      {
        src: "/apple-icon",
        type: "image/png",
        sizes: "180x180",
      },
    ],
  };
}
