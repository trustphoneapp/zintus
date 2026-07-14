import type { MCPServerConfig, MCPTool } from "@zintus/mcp";

const STORAGE_KEY = "zintus:mcp-servers";

/**
 * One MCP server as the user configured it, persisted in THIS browser only
 * (localStorage, no custody — see the no-secret-baking note in lib/gateway.ts).
 *
 * The browser CANNOT host MCP: it stores the config and asks the user's local
 * gateway to test/discover/run the server. `tools` is a cache of what the last
 * successful `Test connection` discovered, so the tool list survives reloads.
 *
 * SECURITY: a server config can hold live credentials — an `Authorization:
 * Bearer …` header for a remote server, or secret values in a stdio server's
 * `env`. So the persisted blob is ENCRYPTED AT REST (AES-256-GCM, Web Crypto)
 * rather than written as plaintext JSON. See the vault section below.
 */
export interface StoredMcpServer {
  id: string;
  name: string;
  config: MCPServerConfig;
  /** Whether this server's tools are offered to the model at all. */
  enabled: boolean;
  /** Which tools are active: `"all"` (the default) or an explicit allow-list of
   *  tool names. A name not present in the server's discovered tools is ignored. */
  enabledTools: string[] | "all";
  /** Tools discovered by the last successful Test connection (display + filter). */
  tools?: MCPTool[];
  /** Epoch ms of the last successful connection. */
  lastConnectedAt?: number;
  /** Honest message from the last failed connection (cleared on success). */
  lastError?: string;
}

// ── At-rest encryption vault ─────────────────────────────────────────────────
//
// Provider API keys use a passphrase-derived AES-256-GCM vault (lib/crypto.ts).
// That mechanism CANNOT be reused verbatim here: it needs a user passphrase, and
// MCP configs are read/written transparently on page load with no prompt (the
// passphrase is never persisted). So we reuse the SAME cipher (AES-256-GCM, Web
// Crypto) and the same base64 envelope shape, keyed by a per-DEVICE key:
//
//   • Primary: a non-extractable CryptoKey stored in IndexedDB. It never appears
//     in localStorage and can't be exported, so a localStorage dump / profile
//     sync / extension that only reads localStorage cannot recover the secrets.
//   • Fallback (no IndexedDB — SSR / test runtimes / restricted browsers): a raw
//     key in localStorage. Weaker (co-located with the ciphertext) but keeps the
//     data readable with no loss; the plaintext-at-rest exposure is still gone.
//
// This is transparent at-rest hardening, NOT the same confidentiality as the
// passphrase vault (which a re-entered secret protects). It is the strongest
// option compatible with silent, no-prompt load/save.

const DEVKEY_DB = "zintus.web.mcp";
const DEVKEY_STORE = "vault";
const DEVKEY_ID = "device-key";
const DEVKEY_LS = "zintus.web.mcp-devkey"; // localStorage fallback (raw AES key)

interface Envelope {
  v: 1;
  iv: string;
  data: string;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function hasIndexedDb(): boolean {
  try {
    return typeof indexedDB !== "undefined" && indexedDB !== null;
  } catch {
    return false;
  }
}

/** Read/write the single device CryptoKey from IndexedDB. Rejects on any error
 *  so the caller can fall back to the localStorage key. */
function idbGet(): Promise<CryptoKey | null> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DEVKEY_DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(DEVKEY_STORE);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      try {
        const tx = db.transaction(DEVKEY_STORE, "readonly");
        const req = tx.objectStore(DEVKEY_STORE).get(DEVKEY_ID);
        req.onsuccess = () => {
          resolve((req.result as CryptoKey | undefined) ?? null);
          db.close();
        };
        req.onerror = () => {
          reject(req.error);
          db.close();
        };
      } catch (err) {
        db.close();
        reject(err);
      }
    };
  });
}

function idbPut(key: CryptoKey): Promise<void> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DEVKEY_DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(DEVKEY_STORE);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      try {
        const tx = db.transaction(DEVKEY_STORE, "readwrite");
        tx.objectStore(DEVKEY_STORE).put(key, DEVKEY_ID);
        tx.oncomplete = () => {
          resolve();
          db.close();
        };
        tx.onerror = () => {
          reject(tx.error);
          db.close();
        };
      } catch (err) {
        db.close();
        reject(err);
      }
    };
  });
}

let deviceKeyPromise: Promise<CryptoKey> | null = null;

/** Resolve the per-device AES-256-GCM key, generating + persisting it once.
 *  Prefers a non-extractable IndexedDB key; falls back to a raw localStorage key
 *  when IndexedDB is unavailable (or errors). Memoized per module load. */
function getDeviceKey(): Promise<CryptoKey> {
  if (deviceKeyPromise) return deviceKeyPromise;
  deviceKeyPromise = (async () => {
    if (hasIndexedDb()) {
      try {
        const existing = await idbGet();
        if (existing) return existing;
        // Non-extractable: usable for encrypt/decrypt but never exportable.
        const key = await crypto.subtle.generateKey(
          { name: "AES-GCM", length: 256 },
          false,
          ["encrypt", "decrypt"],
        );
        await idbPut(key);
        return key;
      } catch {
        // fall through to the localStorage-backed key
      }
    }
    return getLocalStorageKey();
  })();
  return deviceKeyPromise;
}

/** Fallback device key: raw AES-256 key stored (base64) in localStorage. Weaker
 *  than the IndexedDB path but keeps configs decryptable with no data loss. */
async function getLocalStorageKey(): Promise<CryptoKey> {
  const existing =
    typeof localStorage !== "undefined" ? localStorage.getItem(DEVKEY_LS) : null;
  if (existing) {
    return crypto.subtle.importKey(
      "raw",
      base64ToBytes(existing),
      { name: "AES-GCM" },
      false,
      ["encrypt", "decrypt"],
    );
  }
  const raw = crypto.getRandomValues(new Uint8Array(32));
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(DEVKEY_LS, bytesToBase64(raw));
  }
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

async function encryptServers(servers: StoredMcpServer[]): Promise<string> {
  const key = await getDeviceKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(JSON.stringify(servers));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
  const envelope: Envelope = {
    v: 1,
    iv: bytesToBase64(iv),
    data: bytesToBase64(new Uint8Array(cipher)),
  };
  return JSON.stringify(envelope);
}

async function decryptServers(envelope: Envelope): Promise<unknown> {
  const key = await getDeviceKey();
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(envelope.iv) },
    key,
    base64ToBytes(envelope.data),
  );
  return JSON.parse(new TextDecoder().decode(plain)) as unknown;
}

function isEnvelope(value: unknown): value is Envelope {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    typeof (value as Envelope).iv === "string" &&
    typeof (value as Envelope).data === "string"
  );
}

/** Keep only entries shaped like a server so a corrupt write can't crash the
 *  page; identical acceptance rule for legacy-plaintext and decrypted arrays. */
function filterValidServers(parsed: unknown): StoredMcpServer[] {
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (entry): entry is StoredMcpServer =>
      Boolean(entry) &&
      typeof entry === "object" &&
      typeof (entry as StoredMcpServer).id === "string" &&
      typeof (entry as StoredMcpServer).name === "string" &&
      Boolean((entry as StoredMcpServer).config),
  );
}

/** Generate a stable id for a new server. Uses crypto.randomUUID when present,
 *  falling back to a time+random token so it also works in non-DOM tests. */
export function newServerId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    // fall through to the manual token
  }
  return `mcp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Load all stored servers. Never throws: bad/absent JSON, a failed decrypt, or a
 * missing localStorage all yield `[]`.
 *
 * Transparent migration: a value written by an older build is a plaintext JSON
 * array. When we detect that shape we accept it AND immediately re-save it
 * encrypted, so the plaintext credentials are overwritten in place on first
 * load with no user-visible change and no data loss.
 */
export async function loadMcpServers(): Promise<StoredMcpServer[]> {
  if (typeof localStorage === "undefined") {
    return [];
  }
  let parsed: unknown;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return [];
  }

  // Legacy plaintext array → migrate to the encrypted envelope.
  if (Array.isArray(parsed)) {
    const servers = filterValidServers(parsed);
    try {
      await saveMcpServers(servers);
    } catch {
      // If encryption isn't available we still return the configs; the next
      // successful save will encrypt them.
    }
    return servers;
  }

  // Encrypted envelope → decrypt.
  if (isEnvelope(parsed)) {
    try {
      return filterValidServers(await decryptServers(parsed));
    } catch {
      // Wrong/rotated device key or corrupt ciphertext — treat as empty rather
      // than throwing into the UI (mirrors the provider vault's behavior).
      return [];
    }
  }

  return [];
}

/** Persist the full list, encrypted at rest. No-op when localStorage is
 *  unavailable (SSR/tests). Never writes plaintext credentials. */
export async function saveMcpServers(servers: StoredMcpServer[]): Promise<void> {
  if (typeof localStorage === "undefined") {
    return;
  }
  try {
    const envelope = await encryptServers(servers);
    localStorage.setItem(STORAGE_KEY, envelope);
  } catch {
    // Encryption/quota failure — drop silently; this is a local cache. We must
    // NOT fall back to writing plaintext, which is the exact bug we fixed.
  }
}

/** Append a new server (assigning an id when absent) and persist. Returns the
 *  stored record so the caller can reference its id. */
export async function addMcpServer(
  draft: Omit<StoredMcpServer, "id"> & { id?: string },
): Promise<StoredMcpServer> {
  const server: StoredMcpServer = { ...draft, id: draft.id ?? newServerId() };
  await saveMcpServers([...(await loadMcpServers()), server]);
  return server;
}

/** Merge `patch` into the server with `id` and persist. Returns the updated list. */
export async function updateMcpServer(
  id: string,
  patch: Partial<Omit<StoredMcpServer, "id">>,
): Promise<StoredMcpServer[]> {
  const next = (await loadMcpServers()).map((server) =>
    server.id === id ? { ...server, ...patch } : server,
  );
  await saveMcpServers(next);
  return next;
}

/** Remove the server with `id` and persist. Returns the updated list. */
export async function removeMcpServer(id: string): Promise<StoredMcpServer[]> {
  const next = (await loadMcpServers()).filter((server) => server.id !== id);
  await saveMcpServers(next);
  return next;
}

/** True when a server's tool is active given its enabledTools setting. */
export function isToolEnabled(server: StoredMcpServer, toolName: string): boolean {
  if (!server.enabled) {
    return false;
  }
  return server.enabledTools === "all" || server.enabledTools.includes(toolName);
}

/**
 * Toggle one tool on/off in a server's `enabledTools`, normalizing the `"all"`
 * sentinel into a concrete list when the user first deselects something. Pure —
 * returns the next `enabledTools` value (the caller persists it).
 */
export function toggleEnabledTool(
  server: StoredMcpServer,
  toolName: string,
): string[] | "all" {
  const allNames = (server.tools ?? []).map((t) => t.name);
  // Expand "all" into the concrete set so we can remove a single tool from it.
  const current =
    server.enabledTools === "all" ? allNames : server.enabledTools;
  const next = current.includes(toolName)
    ? current.filter((n) => n !== toolName)
    : [...current, toolName];
  // Collapse back to "all" when every discovered tool is selected again.
  if (allNames.length > 0 && next.length === allNames.length) {
    return "all";
  }
  return next;
}

/** The `mcp` field PR4 attaches to a chat request: only enabled servers, each
 *  with the concrete list of tools the model may call. */
export interface ActiveMcpServer {
  id: string;
  name: string;
  config: MCPServerConfig;
  /** Concrete tool names allowed for this server (never the `"all"` sentinel). */
  enabledTools: string[];
}

/**
 * Build the active-server payload for the chat request from stored servers.
 * Only `enabled` servers are included; `enabledTools` is resolved against the
 * server's discovered tools so `"all"` becomes the concrete list (and an enabled
 * server with no discovered tools yet contributes an empty list). Pure +
 * exported so PR4 and tests share one source of truth.
 */
export function activeMcpServersForChat(stored: StoredMcpServer[]): {
  servers: ActiveMcpServer[];
} {
  const servers = stored
    .filter((server) => server.enabled)
    .map((server) => {
      const allNames = (server.tools ?? []).map((t) => t.name);
      const enabledTools =
        server.enabledTools === "all"
          ? allNames
          : server.enabledTools.filter((name) => allNames.includes(name));
      return {
        id: server.id,
        name: server.name,
        config: server.config,
        enabledTools,
      };
    });
  return { servers };
}
