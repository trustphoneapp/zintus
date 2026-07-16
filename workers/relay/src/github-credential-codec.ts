export const GITHUB_TOKEN_RECORD_VERSION = 2 as const;
export const GITHUB_LEGACY_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;
export const GITHUB_MAX_TOKEN_LENGTH = 4_096;

export interface StoredGithubCredential {
  version: typeof GITHUB_TOKEN_RECORD_VERSION;
  accessToken: string;
  refreshToken: string | null;
  accessExpiresAt: number | null;
  refreshExpiresAt: number | null;
  tokenType: string | null;
  scope: string | null;
  updatedAt: number;
}

export interface GithubTokenPayload {
  access_token?: unknown;
  expires_in?: unknown;
  refresh_token?: unknown;
  refresh_token_expires_in?: unknown;
  token_type?: unknown;
  scope?: unknown;
}

const encoder = new TextEncoder();

async function encryptionKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function sealGithubCredential(value: string, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await encryptionKey(secret), encoder.encode(value));
  const bytes = new Uint8Array(iv.length + ciphertext.byteLength);
  bytes.set(iv);
  bytes.set(new Uint8Array(ciphertext), iv.length);
  return btoa(String.fromCharCode(...bytes));
}

export async function openGithubCredential(value: string, secret: string): Promise<string | null> {
  try {
    const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
    if (bytes.length <= 12) return null;
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes.slice(0, 12) },
      await encryptionKey(secret),
      bytes.slice(12),
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    return null;
  }
}

function safeToken(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= GITHUB_MAX_TOKEN_LENGTH ? value : null;
}

function positiveSeconds(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function githubCredentialFromPayload(payload: GithubTokenPayload, nowMs: number): StoredGithubCredential | null {
  const accessToken = safeToken(payload.access_token);
  if (!accessToken) return null;
  const refreshToken = safeToken(payload.refresh_token);
  const accessSeconds = positiveSeconds(payload.expires_in);
  const refreshSeconds = positiveSeconds(payload.refresh_token_expires_in);
  return {
    version: GITHUB_TOKEN_RECORD_VERSION,
    accessToken,
    refreshToken,
    accessExpiresAt: accessSeconds === null ? null : nowMs + accessSeconds * 1_000,
    refreshExpiresAt: refreshToken && refreshSeconds !== null ? nowMs + refreshSeconds * 1_000 : null,
    tokenType: typeof payload.token_type === "string" ? payload.token_type.slice(0, 100) : null,
    scope: typeof payload.scope === "string" ? payload.scope.slice(0, 2_000) : null,
    updatedAt: nowMs,
  };
}

export function parseGithubCredential(value: string, nowMs: number): { credential: StoredGithubCredential; legacy: boolean } | null {
  try {
    const parsed = JSON.parse(value) as Partial<StoredGithubCredential>;
    const accessToken = safeToken(parsed.accessToken);
    if (parsed.version !== GITHUB_TOKEN_RECORD_VERSION || !accessToken) return null;
    const refreshToken = parsed.refreshToken === null ? null : safeToken(parsed.refreshToken);
    const finiteExpiry = (candidate: unknown): number | null =>
      typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0 ? candidate : null;
    return {
      credential: {
        version: GITHUB_TOKEN_RECORD_VERSION,
        accessToken,
        refreshToken,
        accessExpiresAt: finiteExpiry(parsed.accessExpiresAt),
        refreshExpiresAt: finiteExpiry(parsed.refreshExpiresAt),
        tokenType: typeof parsed.tokenType === "string" ? parsed.tokenType.slice(0, 100) : null,
        scope: typeof parsed.scope === "string" ? parsed.scope.slice(0, 2_000) : null,
        updatedAt: finiteExpiry(parsed.updatedAt) ?? nowMs,
      },
      legacy: false,
    };
  } catch {
    const accessToken = safeToken(value);
    return accessToken ? {
      credential: {
        version: GITHUB_TOKEN_RECORD_VERSION,
        accessToken,
        refreshToken: null,
        accessExpiresAt: null,
        refreshExpiresAt: null,
        tokenType: null,
        scope: null,
        updatedAt: nowMs,
      },
      legacy: true,
    } : null;
  }
}

export function githubCredentialTtlSeconds(credential: StoredGithubCredential, nowMs: number): number {
  const lastExpiry = credential.refreshToken && credential.refreshExpiresAt
    ? credential.refreshExpiresAt
    : credential.accessExpiresAt;
  return lastExpiry === null
    ? GITHUB_LEGACY_TOKEN_TTL_SECONDS
    : Math.max(60, Math.ceil((lastExpiry - nowMs) / 1_000));
}
