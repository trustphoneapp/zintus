/**
 * Zintus Cloud API client for web dashboard pages.
 * Calls the relay worker at NEXT_PUBLIC_RELAY_URL (or same-origin /api/relay).
 */

export const RELAY_URL = (
  process.env.NEXT_PUBLIC_RELAY_URL ?? "https://relay.zintus.ai"
).replace(/\/$/, "");

function relayFetch(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return fetch(`${RELAY_URL}${path}`, {
    ...init,
    credentials: "include",
  });
}

// ── Auth ──────────────────────────────────────────────────────────────────

export async function sendMagicLink(
  email: string,
  redirectTo?: string,
): Promise<{ ok: boolean; error?: string }> {
  // redirectTo matters for the desktop/CLI device flow: without it the email
  // link lands on the dashboard and cli-callback never runs, so the app polls
  // until its state expires. The relay validates it against an allow-list.
  const res = await relayFetch("/api/auth/magic-link", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, ...(redirectTo ? { redirectTo } : {}) }),
  });
  if (!res.ok) {
    const { error } = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: error ?? "Failed to send magic link" };
  }
  return { ok: true };
}

/** Sign in with the 6-digit code from the sign-in email (wrong-device path).
 *  On success the relay sets the session cookie; caller navigates to
 *  the returned redirect target. */
export async function verifyEmailCode(
  email: string,
  code: string,
): Promise<{ ok: boolean; redirectTo?: string; error?: string }> {
  const res = await relayFetch("/api/auth/verify-code", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, code }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    redirect_to?: string;
    error?: string;
  };
  if (!res.ok || !body.ok) {
    return { ok: false, error: body.error ?? "Invalid or expired code" };
  }
  return { ok: true, redirectTo: body.redirect_to };
}

export function googleSignInUrl(redirectTo?: string): string {
  const params = redirectTo ? `?redirect_to=${encodeURIComponent(redirectTo)}` : "";
  return `${RELAY_URL}/api/auth/google${params}`;
}

export async function signOut(): Promise<void> {
  await relayFetch("/api/auth/signout", { method: "POST" });
}

export async function getMe(): Promise<{
  authenticated: boolean;
  email?: string;
  user_id?: string;
}> {
  const res = await relayFetch("/api/auth/me").catch(() => null);
  if (!res?.ok) return { authenticated: false };
  return res.json();
}

/**
 * Self-service account deletion. Calls the authenticated relay endpoint, which
 * deletes the signed-in user's account + all their data (sessions, subscription,
 * usage, quota) and clears the session cookie. The user id is resolved entirely
 * from the session on the relay — never sent from here — so a user can only ever
 * delete their own account. Returns true on success (HTTP 200).
 */
export async function deleteAccount(): Promise<boolean> {
  const res = await relayFetch("/api/account", { method: "DELETE" }).catch(() => null);
  return Boolean(res?.ok);
}

// ── Sessions ──────────────────────────────────────────────────────────────

export interface GatewaySession {
  id: string;
  name: string;
  last_seen: number | null;
  online: 0 | 1;
}

export async function listSessions(): Promise<GatewaySession[]> {
  const res = await relayFetch("/api/sessions");
  if (!res.ok) return [];
  const { sessions } = (await res.json()) as { sessions: GatewaySession[] };
  return sessions;
}

export async function createSession(name?: string): Promise<{
  session_id: string;
  gateway_secret: string;
} | null> {
  const res = await relayFetch("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: name ?? "My Gateway" }),
  });
  if (!res.ok) return null;
  return res.json();
}

export async function deleteSession(sessionId: string): Promise<boolean> {
  const res = await relayFetch(`/api/sessions/${sessionId}`, { method: "DELETE" });
  return res.ok;
}

// ── Relay ─────────────────────────────────────────────────────────────────

export async function getSessionStatus(sessionId: string): Promise<unknown> {
  const res = await relayFetch(`/api/sessions/${sessionId}/status`);
  if (!res.ok) return null;
  return res.json();
}

export async function sendControl(
  sessionId: string,
  action: string,
  value?: unknown,
): Promise<boolean> {
  const res = await relayFetch(`/api/sessions/${sessionId}/control`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, value }),
  });
  return res.ok;
}

export function createSessionStream(
  sessionId: string,
  onEvent: (event: string, data: unknown) => void,
): () => void {
  const es = new EventSource(
    `${RELAY_URL}/api/sessions/${sessionId}/stream`,
    { withCredentials: true },
  );

  es.onmessage = (e) => {
    try {
      onEvent("message", JSON.parse(e.data as string));
    } catch {}
  };

  const forwardEvent = (eventName: string) => {
    es.addEventListener(eventName, (e) => {
      try {
        onEvent(eventName, JSON.parse((e as MessageEvent).data as string));
      } catch {}
    });
  };

  forwardEvent("status");
  forwardEvent("gateway_online");
  forwardEvent("gateway_offline");
  forwardEvent("request_routed");
  forwardEvent("quota_warning");
  forwardEvent("provider_failed");
  forwardEvent("key_invalid");

  return () => es.close();
}

// ── CLI complete callback ─────────────────────────────────────────────────

export async function completeCliLogin(
  state: string,
  session_id: string,
  gateway_secret: string,
): Promise<boolean> {
  const res = await relayFetch("/api/auth/cli-complete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ state, session_id, gateway_secret }),
  });
  return res.ok;
}
