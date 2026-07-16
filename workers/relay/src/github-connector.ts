import type { SessionPayload } from "./auth.js";
import {
  githubCredentialFromPayload,
  sealGithubCredential,
  type GithubTokenPayload,
  type StoredGithubCredential,
} from "./github-credential-codec.js";

export type GithubEnv = {
  KV: KVNamespace;
  GITHUB_CREDENTIALS: DurableObjectNamespace;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GITHUB_CALLBACK_URL?: string;
  RELAY_ENCRYPTION_KEY?: string;
};

export const GITHUB_REST_API_VERSION = "2026-03-10";

const oauthKey = (state: string) => `github:oauth:${state}`;
const oauthOwnerKey = (userId: string) => `github:oauth-user:${userId}`;

function credentialStub(env: GithubEnv, userId: string): DurableObjectStub | null {
  if (!env.GITHUB_CREDENTIALS) return null;
  return env.GITHUB_CREDENTIALS.get(env.GITHUB_CREDENTIALS.idFromName(userId));
}

async function brokerRequest(env: GithubEnv, userId: string, path: string, init?: RequestInit): Promise<Response | null> {
  const stub = credentialStub(env, userId);
  if (!stub) return null;
  try {
    return await stub.fetch(new Request(`https://github-credentials.internal${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        "X-Zintus-GitHub-User": userId,
        ...init?.headers,
      },
    }));
  } catch {
    return null;
  }
}

async function installCredential(env: GithubEnv, userId: string, credential: StoredGithubCredential, nowMs: number): Promise<boolean> {
  if (!env.RELAY_ENCRYPTION_KEY) return false;
  const sealedCredential = await sealGithubCredential(JSON.stringify(credential), env.RELAY_ENCRYPTION_KEY);
  const result = await brokerRequest(env, userId, "/install", {
    method: "POST",
    body: JSON.stringify({ sealedCredential, nowMs }),
  });
  return result?.ok === true;
}

export function githubConfigured(env: GithubEnv): boolean {
  return Boolean(env.GITHUB_CREDENTIALS && env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET && env.GITHUB_CALLBACK_URL && env.RELAY_ENCRYPTION_KEY);
}

export function githubApiHeaders(accessToken: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${accessToken}`,
    "X-GitHub-Api-Version": GITHUB_REST_API_VERSION,
    "User-Agent": "Zintus-Engineer",
  };
}

export async function startGithubAuthorization(env: GithubEnv, session: SessionPayload): Promise<string> {
  if (!githubConfigured(env)) throw new Error("GitHub connector is not configured");
  const state = crypto.randomUUID();
  const previousState = await env.KV.get(oauthOwnerKey(session.user_id));
  if (previousState) await env.KV.delete(oauthKey(previousState));
  await env.KV.put(oauthKey(state), JSON.stringify({ userId: session.user_id, sessionId: session.session_id }), { expirationTtl: 600 });
  await env.KV.put(oauthOwnerKey(session.user_id), state, { expirationTtl: 600 });
  const params = new URLSearchParams({ client_id: env.GITHUB_CLIENT_ID!, redirect_uri: env.GITHUB_CALLBACK_URL!, state });
  return `https://github.com/login/oauth/authorize?${params}`;
}

export async function completeGithubAuthorization(env: GithubEnv, state: string, code: string, sessionId: string): Promise<string | null> {
  const raw = await env.KV.get(oauthKey(state));
  if (!raw || !githubConfigured(env)) return null;
  await env.KV.delete(oauthKey(state));
  let owner: { userId?: string; sessionId?: string };
  try { owner = JSON.parse(raw) as typeof owner; } catch { return null; }
  if (!owner.userId || !owner.sessionId || owner.sessionId !== sessionId) return null;
  if (await env.KV.get(oauthOwnerKey(owner.userId)) === state) await env.KV.delete(oauthOwnerKey(owner.userId));
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code, redirect_uri: env.GITHUB_CALLBACK_URL }),
  });
  if (!response.ok) return null;
  const nowMs = Date.now();
  const credential = githubCredentialFromPayload(await response.json() as GithubTokenPayload, nowMs);
  if (!credential) return null;
  if (!(await installCredential(env, owner.userId, credential, nowMs))) return null;
  return owner.userId;
}

export async function githubToken(env: GithubEnv, userId: string, options: { forceRefresh?: boolean; nowMs?: number } = {}): Promise<string | null> {
  const nowMs = options.nowMs ?? Date.now();
  const params = new URLSearchParams({ nowMs: String(nowMs) });
  if (options.forceRefresh) params.set("forceRefresh", "1");
  const result = await brokerRequest(env, userId, `/token?${params}`);
  if (!result?.ok) return null;
  let body: { accessToken?: unknown };
  try { body = await result.json() as typeof body; } catch { return null; }
  return typeof body.accessToken === "string" && body.accessToken.length > 0 && body.accessToken.length <= 4_096
    ? body.accessToken
    : null;
}

export async function githubApiRequest(env: GithubEnv, userId: string, url: string): Promise<Response | null> {
  const accessToken = await githubToken(env, userId);
  if (!accessToken) return null;
  let response = await fetch(url, { headers: githubApiHeaders(accessToken) });
  if (response.status !== 401) return response;
  const refreshedToken = await githubToken(env, userId, { forceRefresh: true });
  if (!refreshedToken || refreshedToken === accessToken) return response;
  response = await fetch(url, { headers: githubApiHeaders(refreshedToken) });
  return response;
}

export async function disconnectGithub(env: GithubEnv, userId: string): Promise<void> {
  const revoked = await brokerRequest(env, userId, "/disconnect", { method: "POST", body: "{}" });
  if (!revoked?.ok) throw new Error("GitHub credential revocation failed");
  const pendingState = await env.KV.get(oauthOwnerKey(userId));
  await Promise.all([
    env.KV.delete(`github:token:${userId}`),
    env.KV.delete(oauthOwnerKey(userId)),
    ...(pendingState ? [env.KV.delete(oauthKey(pendingState))] : []),
  ]);
}
