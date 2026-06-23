/**
 * Zintus Cloud API client for web dashboard pages.
 * Calls the relay worker at NEXT_PUBLIC_RELAY_URL (or same-origin /api/relay).
 */

const RELAY_URL = (
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

export async function sendMagicLink(email: string): Promise<{ ok: boolean; error?: string }> {
  const res = await relayFetch("/api/auth/magic-link", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  if (!res.ok) {
    const { error } = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: error ?? "Failed to send magic link" };
  }
  return { ok: true };
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
