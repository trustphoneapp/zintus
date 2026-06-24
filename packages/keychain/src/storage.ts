import { createRequire } from "node:module";
import type { Entry as KeyringEntry } from "@napi-rs/keyring";
import type { ProviderId } from "@zintus/types";
import { isProviderId, PROVIDER_IDS } from "@zintus/types";

const SERVICE = "zintus";
const MANIFEST_ACCOUNT = "__manifest__";

// ── Backend selection ───────────────────────────────────────────────────────
// The OS keychain relies on @napi-rs/keyring (a native module) plus an OS Secret
// Service. On headless Linux / CI either can be missing: the native binding can
// fail to load at *import* time, or the Secret Service is absent so reads/writes
// *throw*. Previously this crashed whole modules (and, when imported by a test,
// errored the entire test file). We now:
//   (a) lazy-load the native binding via createRequire — a top-level static
//       import would execute on module eval and crash it if the binding fails;
//   (b) probe the backend once and fall back to a process-local in-memory store
//       when the keychain is unavailable, or when CI_KEYCHAIN=memory / CI is set.
// Local/production with a working keychain keep real, persistent storage and the
// original error semantics.

const memoryStore = new Map<string, string>();

function isTruthyEnv(value: string | undefined): boolean {
  return value !== undefined && value !== "" && value !== "false" && value !== "0";
}

function forceMemory(): boolean {
  return process.env.CI_KEYCHAIN === "memory" || isTruthyEnv(process.env.CI);
}

// Lazy, cached native-binding load. `undefined` = not tried yet, `null` = failed.
let entryCtor: typeof KeyringEntry | null | undefined;
function loadEntryCtor(): typeof KeyringEntry | null {
  if (entryCtor !== undefined) return entryCtor;
  try {
    const require = createRequire(import.meta.url);
    entryCtor = (require("@napi-rs/keyring") as typeof import("@napi-rs/keyring"))
      .Entry;
  } catch {
    entryCtor = null; // native binding unavailable (e.g. headless Linux/CI)
  }
  return entryCtor;
}

let warnedMemory = false;
function warnMemoryOnce(): void {
  if (warnedMemory) return;
  warnedMemory = true;
  console.warn(
    "[keychain] OS keychain unavailable — using an in-memory fallback " +
      "(keys are not persisted). On a desktop this should not happen; on " +
      "headless Linux start a Secret Service or set CI_KEYCHAIN=memory.",
  );
}

// One-time decision: real OS keychain vs in-memory fallback.
let memoryDecision: boolean | undefined;
function usingMemory(): boolean {
  if (memoryDecision !== undefined) return memoryDecision;

  if (forceMemory()) {
    memoryDecision = true;
    warnMemoryOnce();
    return true;
  }

  const Ctor = loadEntryCtor();
  if (!Ctor) {
    memoryDecision = true;
    warnMemoryOnce();
    return true;
  }

  // Probe: reading a missing account returns null on a healthy backend, but
  // throws when the Secret Service is dead. Decide once for the whole process.
  try {
    new Ctor(SERVICE, "__probe__").getPassword();
    memoryDecision = false;
  } catch {
    memoryDecision = true;
    warnMemoryOnce();
  }
  return memoryDecision;
}

function backendGet(account: string): string | null {
  if (usingMemory()) {
    return memoryStore.get(account) ?? null;
  }
  return new (loadEntryCtor() as typeof KeyringEntry)(SERVICE, account).getPassword() ?? null;
}

function backendSet(account: string, value: string): void {
  if (usingMemory()) {
    memoryStore.set(account, value);
    return;
  }
  new (loadEntryCtor() as typeof KeyringEntry)(SERVICE, account).setPassword(value);
}

function backendDelete(account: string): void {
  if (usingMemory()) {
    memoryStore.delete(account);
    return;
  }
  new (loadEntryCtor() as typeof KeyringEntry)(SERVICE, account).deletePassword();
}

function readManifest(): string[] {
  try {
    const raw = backendGet(MANIFEST_ACCOUNT);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((value): value is string => typeof value === "string");
  } catch {
    return [];
  }
}

/**
 * The OS keychain backend can be absent — most often on headless Linux with no
 * Secret Service (gnome-keyring/KWallet) running, or in CI/containers. Turn the
 * opaque native error into actionable guidance instead of a raw stack.
 */
function keychainError(error: unknown): Error {
  const cause = error instanceof Error ? error.message : String(error);
  return new Error(
    "OS keychain is unavailable. On macOS/Windows it should work out of the " +
      "box; on headless Linux start a Secret Service (e.g. `gnome-keyring` + " +
      "`dbus`), set CI_KEYCHAIN=memory for an in-memory fallback, or run the " +
      "gateway/CLI on a machine that has one. " +
      `Cause: ${cause}`,
  );
}

// Best-effort: the manifest just speeds up `listKeys`; discovery still works by
// scanning known provider ids, so a manifest write must never break `setKey`.
function writeManifest(ids: string[]): void {
  try {
    backendSet(MANIFEST_ACCOUNT, JSON.stringify(Array.from(new Set(ids))));
  } catch {
    // ignore — listKeys() falls back to scanning PROVIDER_IDS
  }
}

export async function setKey(providerId: ProviderId, key: string): Promise<void> {
  if (!isProviderId(providerId)) {
    throw new Error(`Unknown provider: ${providerId}`);
  }

  try {
    backendSet(providerId, key);
  } catch (error) {
    throw keychainError(error);
  }
  const manifest = readManifest();
  if (!manifest.includes(providerId)) {
    writeManifest([...manifest, providerId]);
  }
}

export async function getKey(providerId: ProviderId): Promise<string | null> {
  if (!isProviderId(providerId)) {
    return null;
  }

  try {
    return backendGet(providerId);
  } catch {
    return null;
  }
}

export async function deleteKey(providerId: ProviderId): Promise<void> {
  if (!isProviderId(providerId)) {
    return;
  }

  try {
    backendDelete(providerId);
  } catch {
    // Entry may already be absent.
  }

  writeManifest(readManifest().filter((id) => id !== providerId));
}

export async function listKeys(): Promise<ProviderId[]> {
  const manifest = readManifest().filter(isProviderId);

  const discovered = await Promise.all(
    PROVIDER_IDS.map(async (providerId: ProviderId) => {
      const key = await getKey(providerId);
      return key ? providerId : null;
    }),
  );

  return Array.from(new Set([...manifest, ...discovered.filter(Boolean)])) as ProviderId[];
}

/** Set/get/delete a sentinel key to confirm the keychain backend is accessible. */
export function probeKeychain(): { ok: boolean; error?: string } {
  const PROBE_ACCOUNT = "__doctor_probe__";
  const PROBE_VALUE = "zintus-probe";
  try {
    backendSet(PROBE_ACCOUNT, PROBE_VALUE);
    const got = backendGet(PROBE_ACCOUNT);
    backendDelete(PROBE_ACCOUNT);
    if (got !== PROBE_VALUE) {
      return { ok: false, error: "Keychain read-back mismatch" };
    }
    return { ok: true };
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    return { ok: false, error: cause };
  }
}
