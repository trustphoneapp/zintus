import type { MetadataRoute } from "next";
import { PUBLIC_ROUTES, SITE_URL } from "@/lib/site";

// Next.js App Router metadata convention (MetadataRoute.Sitemap):
// https://nextjs.org/docs/app/api-reference/file-conventions/metadata/sitemap
export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();

  const priorityFor = (route: string): number => {
    if (route === "/") return 1;
    if (route === "/pricing" || route === "/docs") return 0.9;
    if (route === "/download" || route === "/changelog") return 0.8;
    return 0.6;
  };

  const changeFrequencyFor = (
    route: string,
  ): MetadataRoute.Sitemap[number]["changeFrequency"] => {
    if (route === "/changelog" || route === "/blog") return "weekly";
    if (route === "/" || route === "/pricing" || route === "/docs") return "monthly";
    return "yearly";
  };

  return PUBLIC_ROUTES.map((route) => ({
    url: `${SITE_URL}${route === "/" ? "" : route}`,
    lastModified,
    changeFrequency: changeFrequencyFor(route),
    priority: priorityFor(route),
  }));
}
