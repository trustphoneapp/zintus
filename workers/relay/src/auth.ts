/**
 * relay_token helpers — short-lived, in-KV tokens that authenticate
 * the gateway WebSocket after the initial gateway_secret handshake.
 *
 * relay_token lifecycle:
 *   1. Gateway registers with gateway_secret → DO verifies hash → issues relay_token
 *   2. relay_token stored in KV (1h TTL, keyed by SHA-256 hash)
 *   3. On reconnect gateway sends relay_token in sec-websocket-protocol header
 *   4. DO verifies hash matches KV entry → allows connection
 *   5. Session delete → KV entry removed immediately
 */

import type { Env } from "./types.js";

const RELAY_TOKEN_TTL_SECONDS = 3600; // 1 hour

function kvRelayKey(tokenHash: string): string {
  return `relay:${tokenHash}`;
}

/** Compute SHA-256 hex of a string value. */
async function sha256Hex(value: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Issue a relay_token for session_id. Stores hash in KV; returns plaintext token. */
export async function issueRelayToken(
  kv: KVNamespace,
  session_id: string,
): Promise<string> {
  const token = crypto.randomUUID() + "-" + crypto.randomUUID();
  const hash = await sha256Hex(token);
  await kv.put(kvRelayKey(hash), JSON.stringify({ session_id }), {
    expirationTtl: RELAY_TOKEN_TTL_SECONDS,
  });
  return token;
}

/** Verify a relay_token. Returns session_id on success, null if invalid/expired. */
export async function verifyRelayToken(
  kv: KVNamespace,
  token: string,
): Promise<string | null> {
  const hash = await sha256Hex(token);
  const raw = await kv.get(kvRelayKey(hash));
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as { session_id: string };
    return data.session_id ?? null;
  } catch {
    return null;
  }
}

/** Invalidate a relay_token immediately (call on session delete or sign-out). */
export async function revokeRelayToken(
  kv: KVNamespace,
  token: string,
): Promise<void> {
  const hash = await sha256Hex(token);
  await kv.delete(kvRelayKey(hash));
}

/** Verify that raw_secret hashes to the stored hash. */
export async function verifyGatewaySecret(
  rawSecret: string,
  storedHash: string,
): Promise<boolean> {
  const hash = await sha256Hex(rawSecret);
  return hash === storedHash;
}

/** Hash a gateway_secret for storage in D1. */
export { sha256Hex };

// ── User session tokens ────────────────────────────────────────────────────

const SESSION_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

function kvSessionKey(tokenHash: string): string {
  return `sess:${tokenHash}`;
}

export interface SessionPayload {
  session_id: string;
  user_id: string;
  email: string;
}

/** Issue a user session token. Returns plaintext token; caller sets cookie. */
export async function issueSessionToken(
  kv: KVNamespace,
  payload: SessionPayload,
): Promise<string> {
  const token = crypto.randomUUID() + "-" + crypto.randomUUID();
  const hash = await sha256Hex(token);
  await kv.put(kvSessionKey(hash), JSON.stringify(payload), {
    expirationTtl: SESSION_TOKEN_TTL_SECONDS,
  });
  return token;
}

/** Verify a user session token from the cookie. Returns payload or null. */
export async function verifySessionToken(
  kv: KVNamespace,
  token: string,
): Promise<SessionPayload | null> {
  const hash = await sha256Hex(token);
  const raw = await kv.get(kvSessionKey(hash));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SessionPayload;
  } catch {
    return null;
  }
}

/** Revoke a user session token (sign-out). */
export async function revokeSessionToken(
  kv: KVNamespace,
  token: string,
): Promise<void> {
  const hash = await sha256Hex(token);
  await kv.delete(kvSessionKey(hash));
}

/** Parse the session token from the Cookie header. */
export function parseSessionCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name?.trim() === "zintus_session") {
      return rest.join("=").trim() || null;
    }
  }
  return null;
}

/** Build the Set-Cookie header value for the session token. */
export function buildSessionCookie(token: string, secure: boolean): string {
  const maxAge = SESSION_TOKEN_TTL_SECONDS;
  const parts = [
    `zintus_session=${token}`,
    `Max-Age=${maxAge}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

/** Build a clearing Set-Cookie (sign-out). */
export function clearSessionCookie(secure: boolean): string {
  const parts = [
    "zintus_session=",
    "Max-Age=0",
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}
