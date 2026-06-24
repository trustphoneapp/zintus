/**
 * Zintus Cloud client for mobile — session cookie stored in MMKV (never AsyncStorage).
 * Token obtained via mobile deep-link flow: zintus://auth?token=<one_time_token>
 */

import { createMMKV } from "react-native-mmkv";

const storage = createMMKV({ id: "zintus.config" });
const SESSION_TOKEN_KEY = "zintus_cloud_cookie";

const RELAY_URL = (
  process.env.EXPO_PUBLIC_RELAY_URL ?? "https://relay.zintus.ai"
).replace(/\/$/, "");

// ── Token storage (MMKV, never AsyncStorage) ──────────────────────────────

export function getCloudSessionToken(): string | null {
  return storage.getString(SESSION_TOKEN_KEY) || null;
}

export function setCloudSessionToken(token: string): void {
  storage.set(SESSION_TOKEN_KEY, token);
}

export function clearCloudSessionToken(): void {
  storage.set(SESSION_TOKEN_KEY, "");
}

export function isCloudAuthenticated(): boolean {
  return Boolean(getCloudSessionToken());
}

// ── Mobile deep-link token exchange ──────────────────────────────────────

/** Exchange the one-time deep-link token for a session token. */
export async function exchangeDeepLinkToken(
  token: string,
): Promise<{ ok: boolean; email?: string }> {
  const res = await fetch(`${RELAY_URL}/api/auth/mobile-verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  }).catch(() => null);

  if (!res?.ok) return { ok: false };

  const data = (await res.json()) as {
    session_token?: string;
    email?: string;
  };
  if (!data.session_token) return { ok: false };

  setCloudSessionToken(data.session_token);
  return { ok: true, email: data.email };
}

// ── Authenticated relay API calls ─────────────────────────────────────────

function authHeaders(): HeadersInit {
  const token = getCloudSessionToken();
  return {
    "Content-Type": "application/json",
    ...(token ? { Cookie: `zintus_session=${token}` } : {}),
  };
}

export interface CloudSession {
  id: string;
  name: string;
  last_seen: number | null;
  online: 0 | 1;
}

export async function fetchCloudSessions(): Promise<CloudSession[]> {
  const res = await fetch(`${RELAY_URL}/api/sessions`, {
    headers: authHeaders(),
  }).catch(() => null);
  if (!res?.ok) return [];
  const { sessions } = (await res.json()) as { sessions: CloudSession[] };
  return sessions;
}

export interface LocalRuntimeStatus {
  detected: boolean;
  models?: string[];
}

export interface LocalRuntimes {
  ollama?: LocalRuntimeStatus;
  lmstudio?: LocalRuntimeStatus;
}

export interface SessionStatus {
  ok?: boolean;
  online?: boolean;
  strategy?: string;
  paused?: boolean;
  providers?: Array<{
    id: string;
    name: string;
    remainingRatio?: number;
  }>;
  savings?: { estimatedUsdSaved?: number };
  /** Gateway's x25519 public key (raw 32B, base64) for E2E BYOK key push. */
  gatewayPublicKey?: string;
  /** Local runtimes detected on the gateway host (ollama/lmstudio). */
  localRuntimes?: LocalRuntimes;
}

export async function fetchSessionStatus(sessionId: string): Promise<SessionStatus | null> {
  const res = await fetch(`${RELAY_URL}/api/sessions/${sessionId}/status`, {
    headers: authHeaders(),
  }).catch(() => null);
  if (!res?.ok) return null;
  return res.json();
}

export async function sendCloudControl(
  sessionId: string,
  action: string,
  value?: unknown,
): Promise<boolean> {
  const res = await fetch(`${RELAY_URL}/api/sessions/${sessionId}/control`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ action, value }),
  }).catch(() => null);
  return Boolean(res?.ok);
}

export async function cloudSignOut(): Promise<void> {
  await fetch(`${RELAY_URL}/api/auth/signout`, {
    method: "POST",
    headers: authHeaders(),
  }).catch(() => {});
  clearCloudSessionToken();
}

/** URL to open in expo-web-browser for mobile OAuth login. */
export function mobileLoginUrl(): string {
  return `${RELAY_URL}/login?mobile=true`;
}

export { RELAY_URL };
