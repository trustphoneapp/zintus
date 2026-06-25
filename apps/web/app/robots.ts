import type { MetadataRoute } from "next";
import { DISALLOWED_ROUTES, SITE_URL } from "@/lib/site";

// Next.js App Router metadata convention (MetadataRoute.Robots):
// https://nextjs.org/docs/app/api-reference/file-conventions/metadata/robots
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      // Keep auth, dashboard, app shell, API, and referral links out of indexes.
      disallow: [...DISALLOWED_ROUTES],
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
