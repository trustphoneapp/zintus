import { createRequire } from "node:module";
import type { Entry as KeyringEntry } from "@napi-rs/keyring";
import type { ProviderId } from "@zintus/types";
import { isProviderId, PROVIDER_IDS } from "@zintus/types";

const SERVICE = "zintus";
const MANIFEST_ACCOUNT = "__manifest__";
// BYOK fallback keys live in a sidecar account so the PRIMARY key stays in the
// provider's own account exactly as before (single-key storage is byte-identical
// and `getKey`/`setKey`/storage.test.ts are untouched). The sidecar holds the
// ordered tail (keys 1..n) as a JSON array; key 0 is always the primary account.
function fallbackAccount(providerId: ProviderId): string {
  return `${providerId}::fallbacks`;
}

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
  // Compiled single-file binaries (bun build --compile) have no node_modules,
  // so createRequire can never resolve the napi package there. The per-platform
  // build entry embeds the right .node addon and registers its Entry here
  // BEFORE importing the CLI (see apps/cli/scripts/build-binaries.ts).
  const injected = (
    globalThis as { __ZINTUS_KEYRING_ENTRY__?: typeof KeyringEntry }
  ).__ZINTUS_KEYRING_ENTRY__;
  if (injected) {
    entryCtor = injected;
    return entryCtor;
  }
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

function readFallbacks(providerId: ProviderId): string[] {
  try {
    const raw = backendGet(fallbackAccount(providerId));
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

// Best-effort sidecar write; an empty tail deletes the sidecar so single-key
// storage leaves no trace (back-compat with the pre-fallback on-disk shape).
function writeFallbacks(providerId: ProviderId, keys: string[]): void {
  try {
    if (keys.length === 0) {
      backendDelete(fallbackAccount(providerId));
      return;
    }
    backendSet(fallbackAccount(providerId), JSON.stringify(keys));
  } catch {
    // ignore — getKeys() simply returns the primary key alone.
  }
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
  // setKey sets the SOLE/primary key — clear any fallback tail so the provider
  // is left with exactly one key (matches the "single key" contract).
  writeFallbacks(providerId, []);
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

/**
 * Ordered BYOK keys for a provider, primary first. A provider that was only ever
 * set via `setKey` reads back as a 1-element array (back-compat). Empty when no
 * key is stored. This is the list the router walks on an auth (401/403) failure.
 */
export async function getKeys(providerId: ProviderId): Promise<string[]> {
  if (!isProviderId(providerId)) {
    return [];
  }
  try {
    const primary = backendGet(providerId);
    const tail = readFallbacks(providerId);
    const all = primary ? [primary, ...tail] : tail;
    // Dedupe, order-preserving, drop empties — a stray duplicate key must not
    // cause a redundant retry of the same credential.
    return Array.from(new Set(all.filter((k) => k.length > 0)));
  } catch {
    return [];
  }
}

/**
 * Replace a provider's ordered key list (primary first). The first element is
 * stored as the primary (in the provider's own account, so `getKey` still reads
 * it); the rest go to the sidecar. An empty/blank list deletes every key. No
 * custody — keys never leave the local OS keychain.
 */
export async function setKeys(providerId: ProviderId, keys: string[]): Promise<void> {
  if (!isProviderId(providerId)) {
    throw new Error(`Unknown provider: ${providerId}`);
  }
  const cleaned = Array.from(
    new Set(keys.map((k) => k.trim()).filter((k) => k.length > 0)),
  );
  const [primary, ...tail] = cleaned;
  if (primary === undefined) {
    await deleteKey(providerId);
    return;
  }
  try {
    backendSet(providerId, primary);
  } catch (error) {
    throw keychainError(error);
  }
  writeFallbacks(providerId, tail);
  const manifest = readManifest();
  if (!manifest.includes(providerId)) {
    writeManifest([...manifest, providerId]);
  }
}

/** Remove the key at `index` from a provider's ordered list (re-promoting the
 *  next key to primary as needed). Out-of-range indices are a no-op. */
export async function deleteKeyAt(providerId: ProviderId, index: number): Promise<void> {
  const keys = await getKeys(providerId);
  if (index < 0 || index >= keys.length) {
    return;
  }
  keys.splice(index, 1);
  await setKeys(providerId, keys);
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
  // Drop the fallback tail too so no orphaned keys outlive the primary.
  writeFallbacks(providerId, []);

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
