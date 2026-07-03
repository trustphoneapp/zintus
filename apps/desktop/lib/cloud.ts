/**
 * Zintus Cloud client for the DESKTOP app.
 *
 * Auth model: the same browser device-flow the CLI uses (relay
 * `/api/auth/cli-login` → user signs in on the web dashboard →
 * `/api/auth/cli-status` completes) — but the desktop keeps the USER
 * `session_token` the relay now returns from that flow, and presents it as
 * `Authorization: Bearer …` (the relay's requireSession accepts bearer for
 * native clients that can't hold cross-origin cookies).
 *
 * Token storage: OS keyring in the packaged app (same Rust commands as BYOK
 * keys, account "zintus-cloud-session" — NOT a ProviderId, so the gateway's
 * provider scan never sees it), localStorage fallback in `next dev`.
 */

import { isTauri } from "./tauri";

export const RELAY_URL = (
  process.env.NEXT_PUBLIC_RELAY_URL ?? "https://relay.zintus.ai"
).replace(/\/$/, "");

export const WEB_URL = (
  process.env.NEXT_PUBLIC_WEB_URL ?? "https://www.zintus.ai"
).replace(/\/$/, "");

/** Keyring account (packaged app) / localStorage key (dev) for the token. */
const TOKEN_ACCOUNT = "zintus-cloud-session";
const EMAIL_KEY = "zintus:cloud-email";

async function invokeTauri<T>(command: string, args: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

// In-memory cache so hot paths (auth headers per request) skip keyring IPC.
let cachedToken: string | null | undefined;

export async function getSessionToken(): Promise<string | null> {
  if (cachedToken !== undefined) return cachedToken;
  if (isTauri()) {
    try {
      cachedToken = await invokeTauri<string | null>("keyring_get", {
        providerId: TOKEN_ACCOUNT,
      });
    } catch {
      cachedToken = null;
    }
  } else {
    cachedToken =
      typeof localStorage !== "undefined" ? localStorage.getItem(TOKEN_ACCOUNT) : null;
  }
  return cachedToken;
}

export async function setSessionToken(token: string): Promise<void> {
  cachedToken = token;
  if (isTauri()) {
    await invokeTauri<void>("keyring_set", { providerId: TOKEN_ACCOUNT, key: token });
  } else if (typeof localStorage !== "undefined") {
    localStorage.setItem(TOKEN_ACCOUNT, token);
  }
}

export async function clearSessionToken(): Promise<void> {
  cachedToken = null;
  if (isTauri()) {
    try {
      await invokeTauri<void>("keyring_delete", { providerId: TOKEN_ACCOUNT });
    } catch {
      // Nothing to delete is fine.
    }
  } else if (typeof localStorage !== "undefined") {
    localStorage.removeItem(TOKEN_ACCOUNT);
  }
}

export function getCloudEmail(): string | null {
  return typeof localStorage !== "undefined" ? localStorage.getItem(EMAIL_KEY) : null;
}

function setCloudEmail(email: string | null): void {
  if (typeof localStorage === "undefined") return;
  if (email) localStorage.setItem(EMAIL_KEY, email);
  else localStorage.removeItem(EMAIL_KEY);
}

/** Authenticated fetch against the relay. Callers own response handling. */
export async function relayFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = await getSessionToken();
  return fetch(`${RELAY_URL}${path}`, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
}

// ── Device-flow sign-in ────────────────────────────────────────────────────

export interface DeviceLogin {
  /** URL to open in the user's browser. */
  loginUrl: string;
  /** Resolves with the signed-in email, or null on timeout/failure. */
  completion: Promise<{ email: string } | null>;
  /** Stop polling (user cancelled). */
  cancel: () => void;
}

const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 5 * 60_000; // matches the relay's 300s state TTL

/**
 * Start the browser sign-in. Registers a state token with the relay, hands
 * back the login URL (caller opens it), and polls until the dashboard
 * completes the flow — at which point the user session token is stored.
 */
export async function startDeviceLogin(): Promise<DeviceLogin | null> {
  const state = crypto.randomUUID();
  const reg = await fetch(`${RELAY_URL}/api/auth/cli-login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ state }),
  }).catch(() => null);
  if (!reg?.ok) return null;

  let cancelled = false;
  const completion = (async () => {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (!cancelled && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      const res = await fetch(`${RELAY_URL}/api/auth/cli-status?state=${state}`).catch(
        () => null,
      );
      if (!res) continue;
      if (res.status === 202) continue; // still pending
      if (!res.ok) return null; // expired/unknown state
      const data = (await res.json()) as {
        status?: string;
        session_token?: string;
        email?: string;
      };
      if (data.status !== "complete" || !data.session_token) return null;
      await setSessionToken(data.session_token);
      setCloudEmail(data.email ?? null);
      return { email: data.email ?? "" };
    }
    return null;
  })();

  return {
    loginUrl: `${WEB_URL}/login?cli=true&state=${state}`,
    completion,
    cancel: () => {
      cancelled = true;
    },
  };
}

export async function signOut(): Promise<void> {
  // Best-effort server-side revocation; local clear always happens.
  await relayFetch("/api/auth/signout", { method: "POST" }).catch(() => null);
  await clearSessionToken();
  setCloudEmail(null);
}

export async function getMe(): Promise<{ authenticated: boolean; email?: string }> {
  const token = await getSessionToken();
  if (!token) return { authenticated: false };
  const res = await relayFetch("/api/auth/me").catch(() => null);
  if (!res?.ok) return { authenticated: false };
  return res.json();
}
