import type { SessionPayload } from "./auth.js";

type GithubEnv = { KV: KVNamespace; GITHUB_CLIENT_ID?: string; GITHUB_CLIENT_SECRET?: string; GITHUB_CALLBACK_URL?: string; RELAY_ENCRYPTION_KEY?: string };

const enc = new TextEncoder();
async function keyFor(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(secret));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function seal(value: string, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await keyFor(secret), enc.encode(value));
  const bytes = new Uint8Array(iv.length + ciphertext.byteLength);
  bytes.set(iv); bytes.set(new Uint8Array(ciphertext), iv.length);
  return btoa(String.fromCharCode(...bytes));
}

async function open(value: string, secret: string): Promise<string | null> {
  try {
    const bytes = Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12) }, await keyFor(secret), bytes.slice(12));
    return new TextDecoder().decode(plaintext);
  } catch { return null; }
}

export function githubConfigured(env: GithubEnv): boolean {
  return Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET && env.GITHUB_CALLBACK_URL && env.RELAY_ENCRYPTION_KEY);
}

export async function startGithubAuthorization(env: GithubEnv, session: SessionPayload): Promise<string> {
  if (!githubConfigured(env)) throw new Error("GitHub connector is not configured");
  const state = crypto.randomUUID();
  await env.KV.put(`github:oauth:${state}`, JSON.stringify({ userId: session.user_id, sessionId: session.session_id }), { expirationTtl: 600 });
  const params = new URLSearchParams({ client_id: env.GITHUB_CLIENT_ID!, redirect_uri: env.GITHUB_CALLBACK_URL!, state });
  return `https://github.com/login/oauth/authorize?${params}`;
}

export async function completeGithubAuthorization(env: GithubEnv, state: string, code: string, sessionId: string): Promise<string | null> {
  const raw = await env.KV.get(`github:oauth:${state}`);
  if (!raw || !githubConfigured(env)) return null;
  await env.KV.delete(`github:oauth:${state}`);
  const owner = JSON.parse(raw) as { userId?: string; sessionId?: string };
  if (!owner.userId || !owner.sessionId || owner.sessionId !== sessionId) return null;
  const response = await fetch("https://github.com/login/oauth/access_token", { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code, redirect_uri: env.GITHUB_CALLBACK_URL }) });
  if (!response.ok) return null;
  const payload = await response.json() as { access_token?: string };
  if (!payload.access_token) return null;
  await env.KV.put(`github:token:${owner.userId}`, await seal(payload.access_token, env.RELAY_ENCRYPTION_KEY!), { expirationTtl: 60 * 60 * 24 * 30 });
  return owner.userId;
}

export async function githubToken(env: GithubEnv, userId: string): Promise<string | null> {
  const sealed = await env.KV.get(`github:token:${userId}`);
  return sealed && env.RELAY_ENCRYPTION_KEY ? open(sealed, env.RELAY_ENCRYPTION_KEY) : null;
}

export async function disconnectGithub(env: GithubEnv, userId: string): Promise<void> { await env.KV.delete(`github:token:${userId}`); }
