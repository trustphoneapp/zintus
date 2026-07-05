// Shared HTTP security helpers for the relay: CORS origin allow-listing and
// redirect-target validation. Extracted from index.ts so tests exercise the
// REAL implementation instead of a hand-copied duplicate that can drift.

export const ALLOWED_ORIGINS = [
  "https://www.zintus.ai",
  "https://zintus.ai",
  "https://relay.zintus.ai",
  "http://localhost:3000",
  "http://localhost:3001",
  // Packaged desktop webviews (Tauri): macOS/Linux + Windows origins. These
  // clients authenticate with Authorization: Bearer (no cookies), so allowing
  // their fixed origins adds no cookie-CSRF surface.
  "tauri://localhost",
  "http://tauri.localhost",
];

export const ALLOWED_REDIRECT_ORIGINS = [
  "https://www.zintus.ai",
  "https://zintus.ai",
  // The relay's own host: the mobile sign-in flow finishes OAuth/magic-link on
  // the relay, then redirects back to the relay's GET /api/auth/mobile-redirect
  // to mint the deep-link OTP. Without this entry that redirect_to would fail
  // validation and bounce to the dashboard, breaking mobile auth (bug B8). The
  // relay only owns its own trusted endpoints here, so this is not an
  // open-redirect surface.
  "https://relay.zintus.ai",
  "http://localhost:3000",
  "http://localhost:3001",
];

/** Reflect the request origin only if allow-listed; otherwise fall back to the
 *  canonical origin. Never echoes an arbitrary origin. */
export function corsOrigin(origin: string | null): string {
  return origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]!;
}

/** Validate an OAuth/magic-link redirect target against the allow-list, so an
 *  attacker can't redirect users to an arbitrary origin. Falls back to the
 *  dashboard on anything unknown or unparseable (open-redirect guard). */
export function validateRedirectTo(url: string | null | undefined): string {
  const DEFAULT = "https://www.zintus.ai/dashboard";
  if (!url) return DEFAULT;
  try {
    const parsed = new URL(url);
    return ALLOWED_REDIRECT_ORIGINS.some((a) => parsed.origin === new URL(a).origin)
      ? url
      : DEFAULT;
  } catch {
    return DEFAULT;
  }
}
