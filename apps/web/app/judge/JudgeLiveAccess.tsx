"use client";

/**
 * The online Engineer session is issued server-side when the dedicated Premium
 * flag is enabled. The browser never handles an OpenAI key or gateway bearer.
 */
export function PremiumPreviewAccess(_props: { pendingRequest?: string; redirectTo?: string } = {}) {
  return <div className="judge-live-form" role="status" aria-live="polite">
    <strong>Opening your Premium Engineering workspace…</strong>
    <p>Server-side OpenAI access · fixed run budget · no browser API key · no publication permission</p>
  </div>;
}
