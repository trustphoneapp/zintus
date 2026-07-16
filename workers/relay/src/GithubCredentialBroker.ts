import {
  githubCredentialFromPayload,
  githubCredentialTtlSeconds,
  openGithubCredential,
  parseGithubCredential,
  sealGithubCredential,
  type GithubTokenPayload,
  type StoredGithubCredential,
} from "./github-credential-codec.js";

interface GithubCredentialBrokerEnv {
  KV: KVNamespace;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  RELAY_ENCRYPTION_KEY?: string;
}

const CREDENTIAL_KEY = "credential";
const GENERATION_KEY = "generation";
const EXPIRES_AT_KEY = "expires_at";
const LEGACY_MIGRATION_COMPLETE_KEY = "legacy_migration_complete";
const ACCESS_REFRESH_SKEW_MS = 60_000;
const PROVIDER_TIMEOUT_MS = 15_000;

interface InstallRequest {
  sealedCredential?: unknown;
  nowMs?: unknown;
}

interface CredentialSnapshot {
  credential: StoredGithubCredential;
  generation: number;
}

function legacyTokenKey(userId: string): string {
  return `github:token:${userId}`;
}

function safeNow(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : Date.now();
}

function response(body: Record<string, unknown>, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

/**
 * One globally unique instance per user. Durable generation checks make
 * refresh rotation, replacement, and revocation monotonic across Worker
 * isolates while credential bytes remain AES-GCM encrypted at rest.
 */
export class GithubCredentialBroker {
  private readonly state: DurableObjectState;
  private readonly env: GithubCredentialBrokerEnv;
  private refreshInFlight: Promise<string | null> | null = null;

  constructor(state: DurableObjectState, env: GithubCredentialBrokerEnv) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const userId = request.headers.get("X-Zintus-GitHub-User");
      if (!userId || userId.length > 200) return response({ error: "invalid_request" }, 400);

      if (request.method === "POST" && url.pathname === "/install") {
        const body = await request.json() as InstallRequest;
        const installed = await this.install(userId, body.sealedCredential, safeNow(body.nowMs));
        return installed ? response({ ok: true }) : response({ error: "invalid_credential" }, 400);
      }

      if (request.method === "GET" && url.pathname === "/token") {
        const nowMs = safeNow(Number(url.searchParams.get("nowMs")));
        const token = await this.token(userId, url.searchParams.get("forceRefresh") === "1", nowMs);
        return response({ accessToken: token });
      }

      if (request.method === "POST" && url.pathname === "/disconnect") {
        await this.revoke(userId);
        return response({ ok: true });
      }

      return response({ error: "not_found" }, 404);
    } catch {
      // Provider bodies, credential bytes, and exception detail never cross the
      // Durable Object boundary.
      return response({ error: "github_credential_operation_failed" }, 500);
    }
  }

  async alarm(): Promise<void> {
    const snapshot = await this.state.storage.transaction(async (transaction) => ({
      expiresAt: await transaction.get<number>(EXPIRES_AT_KEY),
      generation: (await transaction.get<number>(GENERATION_KEY)) ?? 0,
    }));
    const expiresAt = snapshot.expiresAt;
    if (expiresAt && expiresAt > Date.now()) {
      await this.state.storage.setAlarm(expiresAt);
      return;
    }
    await this.revokeStoredCredential(snapshot.generation);
  }

  private async install(userId: string, candidate: unknown, nowMs: number): Promise<boolean> {
    if (!this.env.RELAY_ENCRYPTION_KEY || typeof candidate !== "string") return false;
    const plaintext = await openGithubCredential(candidate, this.env.RELAY_ENCRYPTION_KEY);
    const parsed = plaintext ? parseGithubCredential(plaintext, nowMs) : null;
    if (!parsed || parsed.legacy) return false;
    const sealed = await sealGithubCredential(JSON.stringify(parsed.credential), this.env.RELAY_ENCRYPTION_KEY);
    const expiresAt = nowMs + githubCredentialTtlSeconds(parsed.credential, nowMs) * 1_000;
    await this.state.storage.transaction(async (transaction) => {
      const generation = (await transaction.get<number>(GENERATION_KEY)) ?? 0;
      await transaction.put({
        [GENERATION_KEY]: generation + 1,
        [CREDENTIAL_KEY]: sealed,
        [EXPIRES_AT_KEY]: expiresAt,
        [LEGACY_MIGRATION_COMPLETE_KEY]: true,
      });
    });
    await Promise.all([
      this.env.KV.delete(legacyTokenKey(userId)),
      this.state.storage.setAlarm(expiresAt),
    ]);
    this.refreshInFlight = null;
    return true;
  }

  private async token(userId: string, forceRefresh: boolean, nowMs: number): Promise<string | null> {
    const snapshot = await this.readCredential(userId, nowMs);
    if (!snapshot) return null;
    const { credential } = snapshot;
    const accessUsable = credential.accessExpiresAt === null || credential.accessExpiresAt > nowMs + ACCESS_REFRESH_SKEW_MS;
    if (!forceRefresh && accessUsable) return credential.accessToken;
    if (!credential.refreshToken) {
      if (credential.accessExpiresAt !== null && credential.accessExpiresAt <= nowMs) await this.revoke(userId);
      return accessUsable ? credential.accessToken : null;
    }
    if (this.refreshInFlight) return this.refreshInFlight;
    const operation = this.rotate(userId, credential, nowMs, snapshot.generation).finally(() => {
      if (this.refreshInFlight === operation) this.refreshInFlight = null;
    });
    this.refreshInFlight = operation;
    return operation;
  }

  private async rotate(userId: string, credential: StoredGithubCredential, nowMs: number, expectedGeneration: number): Promise<string | null> {
    if (!this.env.GITHUB_CLIENT_ID || !this.env.GITHUB_CLIENT_SECRET || !this.env.RELAY_ENCRYPTION_KEY || !credential.refreshToken) return null;
    if (credential.refreshExpiresAt !== null && credential.refreshExpiresAt <= nowMs) {
      await this.revokeIfGeneration(userId, expectedGeneration);
      return null;
    }

    let providerResponse: Response;
    try {
      providerResponse = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: this.env.GITHUB_CLIENT_ID,
          client_secret: this.env.GITHUB_CLIENT_SECRET,
          grant_type: "refresh_token",
          refresh_token: credential.refreshToken,
        }),
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      });
    } catch {
      return null;
    }
    if (!providerResponse.ok) return null;
    let payload: GithubTokenPayload;
    try { payload = await providerResponse.json() as GithubTokenPayload; }
    catch { return null; }
    const next = githubCredentialFromPayload(payload, nowMs);
    if (!next?.refreshToken) return null;
    const sealed = await sealGithubCredential(JSON.stringify(next), this.env.RELAY_ENCRYPTION_KEY);
    const expiresAt = nowMs + githubCredentialTtlSeconds(next, nowMs) * 1_000;
    const committed = await this.state.storage.transaction(async (transaction) => {
      const generation = (await transaction.get<number>(GENERATION_KEY)) ?? 0;
      if (generation !== expectedGeneration || !(await transaction.get<string>(CREDENTIAL_KEY))) return false;
      await transaction.put({ [CREDENTIAL_KEY]: sealed, [EXPIRES_AT_KEY]: expiresAt });
      return true;
    });
    if (!committed) return null;
    await Promise.all([
      this.env.KV.delete(legacyTokenKey(userId)),
      this.state.storage.setAlarm(expiresAt),
    ]);
    return next.accessToken;
  }

  private async readCredential(userId: string, nowMs: number): Promise<CredentialSnapshot | null> {
    if (!this.env.RELAY_ENCRYPTION_KEY) return null;
    const stored = await this.state.storage.transaction(async (transaction) => ({
      sealed: await transaction.get<string>(CREDENTIAL_KEY),
      generation: (await transaction.get<number>(GENERATION_KEY)) ?? 0,
    }));
    const sealed = stored.sealed;
    if (sealed) {
      const plaintext = await openGithubCredential(sealed, this.env.RELAY_ENCRYPTION_KEY);
      const parsed = plaintext ? parseGithubCredential(plaintext, nowMs) : null;
      if (parsed && !parsed.legacy) return { credential: parsed.credential, generation: stored.generation };
      await this.revokeStoredCredential(stored.generation);
      return null;
    }
    return this.migrateLegacyCredential(userId, nowMs);
  }

  private async migrateLegacyCredential(userId: string, nowMs: number): Promise<CredentialSnapshot | null> {
    if (!this.env.RELAY_ENCRYPTION_KEY) return null;
    const migration = await this.state.storage.transaction(async (transaction) => ({
      generation: (await transaction.get<number>(GENERATION_KEY)) ?? 0,
      complete: (await transaction.get<boolean>(LEGACY_MIGRATION_COMPLETE_KEY)) === true,
    }));
    if (migration.complete) return null;
    const expectedGeneration = migration.generation;
    const legacySealed = await this.env.KV.get(legacyTokenKey(userId));
    if (!legacySealed) {
      await this.completeLegacyMigration(expectedGeneration);
      return null;
    }
    const plaintext = await openGithubCredential(legacySealed, this.env.RELAY_ENCRYPTION_KEY);
    const parsed = plaintext ? parseGithubCredential(plaintext, nowMs) : null;
    if (!parsed) {
      await this.completeLegacyMigration(expectedGeneration);
      return null;
    }
    const sealed = await sealGithubCredential(JSON.stringify(parsed.credential), this.env.RELAY_ENCRYPTION_KEY);
    const expiresAt = nowMs + githubCredentialTtlSeconds(parsed.credential, nowMs) * 1_000;
    const committed = await this.state.storage.transaction(async (transaction) => {
      const generation = (await transaction.get<number>(GENERATION_KEY)) ?? 0;
      if (generation !== expectedGeneration
        || await transaction.get<string>(CREDENTIAL_KEY)
        || await transaction.get<boolean>(LEGACY_MIGRATION_COMPLETE_KEY)) return false;
      await transaction.put({
        [CREDENTIAL_KEY]: sealed,
        [EXPIRES_AT_KEY]: expiresAt,
        [LEGACY_MIGRATION_COMPLETE_KEY]: true,
      });
      return true;
    });
    if (!committed) return this.readCredential(userId, nowMs);
    await Promise.all([
      this.env.KV.delete(legacyTokenKey(userId)),
      this.state.storage.setAlarm(expiresAt),
    ]);
    return { credential: parsed.credential, generation: expectedGeneration };
  }

  private async completeLegacyMigration(expectedGeneration: number): Promise<void> {
    await this.state.storage.transaction(async (transaction) => {
      const generation = (await transaction.get<number>(GENERATION_KEY)) ?? 0;
      if (generation !== expectedGeneration || await transaction.get<string>(CREDENTIAL_KEY)) return;
      await transaction.put(LEGACY_MIGRATION_COMPLETE_KEY, true);
    });
  }

  private async revoke(userId: string): Promise<void> {
    await Promise.all([
      this.revokeStoredCredential(),
      this.env.KV.delete(legacyTokenKey(userId)),
    ]);
    this.refreshInFlight = null;
  }

  private async revokeIfGeneration(userId: string, expectedGeneration: number): Promise<void> {
    const revoked = await this.state.storage.transaction(async (transaction) => {
      const generation = (await transaction.get<number>(GENERATION_KEY)) ?? 0;
      if (generation !== expectedGeneration) return false;
      await transaction.put({
        [GENERATION_KEY]: generation + 1,
        [LEGACY_MIGRATION_COMPLETE_KEY]: true,
      });
      await transaction.delete([CREDENTIAL_KEY, EXPIRES_AT_KEY]);
      return true;
    });
    if (revoked) await this.env.KV.delete(legacyTokenKey(userId));
  }

  private async revokeStoredCredential(expectedGeneration?: number): Promise<void> {
    await this.state.storage.transaction(async (transaction) => {
      const generation = (await transaction.get<number>(GENERATION_KEY)) ?? 0;
      if (expectedGeneration !== undefined && generation !== expectedGeneration) return;
      await transaction.put({
        [GENERATION_KEY]: generation + 1,
        [LEGACY_MIGRATION_COMPLETE_KEY]: true,
      });
      await transaction.delete([CREDENTIAL_KEY, EXPIRES_AT_KEY]);
    });
  }
}
