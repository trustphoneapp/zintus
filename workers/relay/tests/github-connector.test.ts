import { afterEach, describe, expect, it } from "bun:test";
import type { SessionPayload } from "../src/auth.js";
import { GithubCredentialBroker } from "../src/GithubCredentialBroker.js";
import {
  GITHUB_REST_API_VERSION,
  completeGithubAuthorization,
  disconnectGithub,
  githubApiRequest,
  githubToken,
  startGithubAuthorization,
  type GithubEnv,
} from "../src/github-connector.js";

class MemoryKv {
  readonly values = new Map<string, string>();
  readonly puts: Array<{ key: string; value: string; options?: KVNamespacePutOptions }> = [];
  async get(key: string): Promise<string | null> { return this.values.get(key) ?? null; }
  async put(key: string, value: string, options?: KVNamespacePutOptions): Promise<void> {
    this.values.set(key, value);
    this.puts.push({ key, value, options });
  }
  async delete(key: string): Promise<void> { this.values.delete(key); }
}

class MemoryDurableStorage {
  readonly values = new Map<string, unknown>();
  alarm: number | null = null;
  private transactionTail: Promise<void> = Promise.resolve();

  async get<T>(key: string): Promise<T | undefined> { return this.values.get(key) as T | undefined; }
  async put(keyOrValues: string | Record<string, unknown>, value?: unknown): Promise<void> {
    if (typeof keyOrValues === "string") this.values.set(keyOrValues, value);
    else for (const [key, entry] of Object.entries(keyOrValues)) this.values.set(key, entry);
  }
  async delete(keyOrKeys: string | string[]): Promise<boolean> {
    if (Array.isArray(keyOrKeys)) return keyOrKeys.map((key) => this.values.delete(key)).some(Boolean);
    return this.values.delete(keyOrKeys);
  }
  async setAlarm(scheduledTime: number): Promise<void> { this.alarm = scheduledTime; }
  async transaction<T>(callback: (transaction: MemoryDurableStorage) => Promise<T>): Promise<T> {
    const previous = this.transactionTail;
    let release!: () => void;
    this.transactionTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await callback(this); }
    finally { release(); }
  }
}

class SharedBrokerBackend {
  private readonly objects = new Map<string, { broker: GithubCredentialBroker; storage: MemoryDurableStorage }>();

  constructor(private readonly kv: MemoryKv, private readonly secrets: Pick<GithubEnv, "GITHUB_CLIENT_ID" | "GITHUB_CLIENT_SECRET" | "RELAY_ENCRYPTION_KEY">) {}

  namespace(): DurableObjectNamespace {
    // Each call returns a distinct namespace wrapper, simulating a separate
    // stateless Worker runtime while both resolve to the same per-user DO.
    return {
      idFromName: (name: string) => name,
      get: (id: string) => ({
        fetch: (input: RequestInfo | URL, init?: RequestInit) => {
          const request = input instanceof Request ? input : new Request(input, init);
          return this.object(String(id)).broker.fetch(request);
        },
      }),
    } as unknown as DurableObjectNamespace;
  }

  storage(userId: string): MemoryDurableStorage { return this.object(userId).storage; }

  private object(userId: string): { broker: GithubCredentialBroker; storage: MemoryDurableStorage } {
    const existing = this.objects.get(userId);
    if (existing) return existing;
    const storage = new MemoryDurableStorage();
    const broker = new GithubCredentialBroker(
      { storage } as unknown as DurableObjectState,
      { KV: this.kv as unknown as KVNamespace, ...this.secrets },
    );
    const created = { broker, storage };
    this.objects.set(userId, created);
    return created;
  }
}

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const session: SessionPayload = { session_id: "session-1", user_id: "user-1", email: "user@example.com" };

function environments(kv = new MemoryKv()): { envA: GithubEnv; envB: GithubEnv; kv: MemoryKv; backend: SharedBrokerBackend } {
  const common = {
    KV: kv as unknown as KVNamespace,
    GITHUB_CLIENT_ID: "github-client",
    GITHUB_CLIENT_SECRET: "github-client-secret",
    GITHUB_CALLBACK_URL: "https://relay.example.test/api/connectors/github/callback",
    RELAY_ENCRYPTION_KEY: "relay-encryption-key-with-test-entropy",
  };
  const backend = new SharedBrokerBackend(kv, common);
  return {
    envA: { ...common, GITHUB_CREDENTIALS: backend.namespace() },
    envB: { ...common, GITHUB_CREDENTIALS: backend.namespace() },
    kv,
    backend,
  };
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

async function authorize(env: GithubEnv, payload: Record<string, unknown>): Promise<void> {
  globalThis.fetch = (async () => json(payload)) as typeof fetch;
  const authorizationUrl = await startGithubAuthorization(env, session);
  const state = new URL(authorizationUrl).searchParams.get("state");
  expect(state).toBeTruthy();
  expect(await completeGithubAuthorization(env, state!, "authorization-code", session.session_id)).toBe(session.user_id);
}

async function sealLegacyToken(value: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  const key = await crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(value));
  const bytes = new Uint8Array(iv.length + ciphertext.byteLength);
  bytes.set(iv);
  bytes.set(new Uint8Array(ciphertext), iv.length);
  return btoa(String.fromCharCode(...bytes));
}

describe("GitHub Durable Object credential lifecycle", () => {
  it("stores credentials encrypted in the Durable Object and rotates them before access expiry", async () => {
    const { envA, kv, backend } = environments();
    const firstAccess = "ghu_initial_access_value";
    const firstRefresh = "ghr_initial_refresh_value";
    await authorize(envA, { access_token: firstAccess, expires_in: 120, refresh_token: firstRefresh, refresh_token_expires_in: 3_600 });

    expect(kv.values.has(`github:token:${session.user_id}`)).toBe(false);
    const encrypted = String(backend.storage(session.user_id).values.get("credential"));
    expect(encrypted).not.toContain(firstAccess);
    expect(encrypted).not.toContain(firstRefresh);
    expect(backend.storage(session.user_id).alarm).toBeGreaterThan(Date.now() + 3_500_000);

    let refreshCalls = 0;
    globalThis.fetch = (async (_url, init) => {
      refreshCalls += 1;
      const body = JSON.parse(String(init?.body)) as Record<string, string>;
      expect(body.grant_type).toBe("refresh_token");
      expect(body.refresh_token).toBe(firstRefresh);
      return json({ access_token: "ghu_rotated_access_value", expires_in: 3_600, refresh_token: "ghr_rotated_refresh_value", refresh_token_expires_in: 7_200 });
    }) as typeof fetch;

    expect(await githubToken(envA, session.user_id, { nowMs: Date.now() + 61_000 })).toBe("ghu_rotated_access_value");
    expect(refreshCalls).toBe(1);
    const rotated = String(backend.storage(session.user_id).values.get("credential"));
    expect(rotated).not.toContain("ghu_rotated_access_value");
    expect(rotated).not.toContain("ghr_rotated_refresh_value");
  });

  it("deduplicates concurrent refreshes submitted by two Worker runtimes", async () => {
    const { envA, envB } = environments();
    await authorize(envA, { access_token: "ghu_concurrent_old", expires_in: 120, refresh_token: "ghr_concurrent_old", refresh_token_expires_in: 3_600 });
    let refreshCalls = 0;
    globalThis.fetch = (async () => {
      refreshCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return json({ access_token: "ghu_concurrent_new", expires_in: 3_600, refresh_token: "ghr_concurrent_new", refresh_token_expires_in: 3_600 });
    }) as typeof fetch;
    const nowMs = Date.now() + 61_000;
    const tokens = await Promise.all([
      ...Array.from({ length: 4 }, () => githubToken(envA, session.user_id, { nowMs })),
      ...Array.from({ length: 4 }, () => githubToken(envB, session.user_id, { nowMs })),
    ]);
    expect(new Set(tokens)).toEqual(new Set(["ghu_concurrent_new"]));
    expect(refreshCalls).toBe(1);
  });

  it("prevents an in-flight refresh in one runtime from resurrecting a disconnect in another", async () => {
    const { envA, envB, backend } = environments();
    await authorize(envA, { access_token: "ghu_race_old", expires_in: 120, refresh_token: "ghr_race_old", refresh_token_expires_in: 3_600 });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    globalThis.fetch = (async () => {
      started();
      await blocked;
      return json({ access_token: "ghu_race_new", expires_in: 3_600, refresh_token: "ghr_race_new", refresh_token_expires_in: 3_600 });
    }) as typeof fetch;

    const refreshing = githubToken(envA, session.user_id, { nowMs: Date.now() + 61_000 });
    await didStart;
    await disconnectGithub(envB, session.user_id);
    release();
    expect(await refreshing).toBeNull();
    expect(await githubToken(envA, session.user_id)).toBeNull();
    expect(backend.storage(session.user_id).values.has("credential")).toBe(false);
  });

  it("does not let an old in-flight refresh overwrite a newer authorization", async () => {
    const { envA, envB } = environments();
    await authorize(envA, { access_token: "ghu_old_install", expires_in: 120, refresh_token: "ghr_old_install", refresh_token_expires_in: 3_600 });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    globalThis.fetch = (async () => {
      started();
      await blocked;
      return json({ access_token: "ghu_stale_rotation", expires_in: 3_600, refresh_token: "ghr_stale_rotation", refresh_token_expires_in: 3_600 });
    }) as typeof fetch;
    const refreshing = githubToken(envA, session.user_id, { nowMs: Date.now() + 61_000 });
    await didStart;
    await authorize(envB, { access_token: "ghu_new_install", expires_in: 3_600, refresh_token: "ghr_new_install", refresh_token_expires_in: 7_200 });
    release();
    expect(await refreshing).toBeNull();
    expect(await githubToken(envB, session.user_id)).toBe("ghu_new_install");
  });

  it("fails closed and removes credentials when the rotating refresh token is expired", async () => {
    const { envA, backend } = environments();
    await authorize(envA, { access_token: "ghu_expiring_access", expires_in: 30, refresh_token: "ghr_expiring_refresh", refresh_token_expires_in: 30 });
    let networkCalls = 0;
    globalThis.fetch = (async () => { networkCalls += 1; return json({}); }) as typeof fetch;
    expect(await githubToken(envA, session.user_id, { nowMs: Date.now() + 31_000 })).toBeNull();
    expect(networkCalls).toBe(0);
    expect(backend.storage(session.user_id).values.has("credential")).toBe(false);
  });

  it("migrates a legacy encrypted KV token once into encrypted Durable Object storage", async () => {
    const { envA, kv, backend } = environments();
    const legacyAccess = "gho_legacy_access_value";
    const legacySealed = await sealLegacyToken(legacyAccess, envA.RELAY_ENCRYPTION_KEY!);
    kv.values.set(`github:token:${session.user_id}`, legacySealed);
    expect(await githubToken(envA, session.user_id)).toBe(legacyAccess);
    expect(kv.values.has(`github:token:${session.user_id}`)).toBe(false);
    const migrated = String(backend.storage(session.user_id).values.get("credential"));
    expect(migrated).not.toBe(legacySealed);
    expect(migrated).not.toContain(legacyAccess);
  });

  it("never resurrects an eventually-consistent stale legacy KV token after disconnect", async () => {
    const { envA, envB, kv } = environments();
    const legacyAccess = "gho_stale_after_disconnect";
    const legacySealed = await sealLegacyToken(legacyAccess, envA.RELAY_ENCRYPTION_KEY!);
    kv.values.set(`github:token:${session.user_id}`, legacySealed);
    await disconnectGithub(envA, session.user_id);

    // Model a stale KV replica returning the deleted legacy value later.
    kv.values.set(`github:token:${session.user_id}`, legacySealed);
    expect(await githubToken(envB, session.user_id)).toBeNull();
  });

  it("disconnect removes credentials and pending authorization state", async () => {
    const { envA, kv, backend } = environments();
    await authorize(envA, { access_token: "ghu_disconnect_access", refresh_token: "ghr_disconnect_refresh", expires_in: 3_600, refresh_token_expires_in: 7_200 });
    const pending = new URL(await startGithubAuthorization(envA, session)).searchParams.get("state")!;
    await disconnectGithub(envA, session.user_id);
    expect(backend.storage(session.user_id).values.has("credential")).toBe(false);
    expect(kv.values.has(`github:oauth-user:${session.user_id}`)).toBe(false);
    expect(kv.values.has(`github:oauth:${pending}`)).toBe(false);
  });

  it("returns stable generic errors without echoing malformed credential material", async () => {
    const { envA } = environments();
    const candidateSecret = "ghp_malformed_candidate_secret";
    const id = envA.GITHUB_CREDENTIALS.idFromName(session.user_id);
    const result = await envA.GITHUB_CREDENTIALS.get(id).fetch(new Request("https://github-credentials.internal/install", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Zintus-GitHub-User": session.user_id },
      body: JSON.stringify({ sealedCredential: candidateSecret, nowMs: Date.now() }),
    }));
    const body = await result.text();
    expect(result.status).toBe(400);
    expect(body).toContain("invalid_credential");
    expect(body).not.toContain(candidateSecret);
  });
});

describe("GitHub REST requests", () => {
  it("uses the consolidated REST version and retries one 401 with a rotated token", async () => {
    const { envA } = environments();
    await authorize(envA, { access_token: "ghu_api_old", expires_in: 3_600, refresh_token: "ghr_api_old", refresh_token_expires_in: 7_200 });
    const apiHeaders: Array<Record<string, string>> = [];
    let refreshCalls = 0;
    globalThis.fetch = (async (input, init) => {
      if (String(input).includes("login/oauth/access_token")) {
        refreshCalls += 1;
        return json({ access_token: "ghu_api_new", expires_in: 3_600, refresh_token: "ghr_api_new", refresh_token_expires_in: 7_200 });
      }
      apiHeaders.push(init?.headers as Record<string, string>);
      return apiHeaders.length === 1 ? new Response(null, { status: 401 }) : json({ ok: true });
    }) as typeof fetch;
    const response = await githubApiRequest(envA, session.user_id, "https://api.github.com/user/repos");
    expect(response?.status).toBe(200);
    expect(refreshCalls).toBe(1);
    expect(apiHeaders).toHaveLength(2);
    expect(apiHeaders.every((headers) => headers["X-GitHub-Api-Version"] === GITHUB_REST_API_VERSION)).toBe(true);
    expect(apiHeaders[0]?.Authorization).toBe("Bearer ghu_api_old");
    expect(apiHeaders[1]?.Authorization).toBe("Bearer ghu_api_new");
  });

  it("does not surface provider bodies or credential material when refresh fails", async () => {
    const { envA, backend } = environments();
    const oldAccess = "ghu_no_leak_access";
    const oldRefresh = "ghr_no_leak_refresh";
    await authorize(envA, { access_token: oldAccess, expires_in: 120, refresh_token: oldRefresh, refresh_token_expires_in: 3_600 });
    const providerSecret = "ghp_provider_error_secret";
    globalThis.fetch = (async () => json({ error: "bad_verification_code", error_description: providerSecret }, 400)) as typeof fetch;
    const result = await githubToken(envA, session.user_id, { nowMs: Date.now() + 61_000 });
    expect(result).toBeNull();
    const encrypted = String(backend.storage(session.user_id).values.get("credential"));
    expect(encrypted).not.toContain(oldAccess);
    expect(encrypted).not.toContain(oldRefresh);
    expect(encrypted).not.toContain(providerSecret);
  });
});

describe("GitHub credential deployment binding", () => {
  it("declares the Durable Object binding and additive migration", async () => {
    const wrangler = await Bun.file(new URL("../wrangler.toml", import.meta.url)).text();
    expect(wrangler).toContain('name = "GITHUB_CREDENTIALS"');
    expect(wrangler).toContain('class_name = "GithubCredentialBroker"');
    expect(wrangler).toContain('tag = "v3"');
    expect(wrangler).toContain('new_sqlite_classes = ["GithubCredentialBroker"]');
  });
});
