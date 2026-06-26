/**
 * Canonical production origin for the marketing site, used by metadata routes
 * (robots.ts, sitemap.ts) and any absolute-URL generation.
 *
 * Defaults to the production www host (matches `metadataBase` in app/layout.tsx).
 * Override with `NEXT_PUBLIC_SITE_URL` for previews/staging. The value is
 * normalized to have no trailing slash so callers can append `/path` safely.
 */
export const SITE_URL = (
  process.env.NEXT_PUBLIC_SITE_URL ?? "https://www.zintus.ai"
).replace(/\/+$/, "");

/**
 * Public, crawlable marketing/content routes. Kept in one place so robots.ts,
 * sitemap.ts, and the SEO test agree on the same source of truth. Anything not
 * listed here (auth, dashboard, app shell, API, referral links) is intentionally
 * excluded from indexing.
 */
export const PUBLIC_ROUTES = [
  "/",
  "/pricing",
  "/docs",
  "/developers",
  "/download",
  "/changelog",
  "/about",
  "/contact",
  "/privacy",
  "/terms",
  "/security",
  // Public, login-free account-deletion page. Required by Google Play / the App
  // Store to be reachable without signing in (see docs/store/play-listing.md §5),
  // so it is intentionally crawlable rather than under DISALLOWED_ROUTES.
  "/account/delete",
] as const;
// Note: /blog is intentionally excluded. It is a "Coming soon" stub marked
// noindex (see app/blog/page.tsx) — keeping it out of the sitemap avoids
// advertising a thin placeholder until it has real content.

/** Private/app route prefixes that must never be indexed. */
export const DISALLOWED_ROUTES = [
  "/api/",
  "/auth/",
  "/login",
  "/dashboard",
  "/chat",
  "/compare",
  "/research",
  "/settings",
  "/usage",
  "/terminal",
  "/providers",
  "/r/",
] as const;
