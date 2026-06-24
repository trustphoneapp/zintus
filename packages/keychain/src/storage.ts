import { Entry } from "@napi-rs/keyring";
import type { ProviderId } from "@zintus/types";
import { isProviderId, PROVIDER_IDS } from "@zintus/types";

const SERVICE = "zintus";
const MANIFEST_ACCOUNT = "__manifest__";

// ── Backend selection ───────────────────────────────────────────────────────
// The OS keychain backend can be absent — most often on headless Linux with no
// Secret Service (gnome-keyring/KWallet) running, or in CI/containers, where
// constructing/accessing an `Entry` throws. In those environments we fall back
// to a process-local in-memory store so the keychain API stays usable (e.g. the
// full test suite passes on a headless runner) without ever touching the OS.
//
// Enabled when CI_KEYCHAIN=memory, or whenever a generic CI=true is set (GitHub
// Actions and most CIs set this automatically). Local/production runs keep using
// the real OS keychain and its original error semantics.
const memoryStore = new Map<string, string>();

function isTruthyEnv(value: string | undefined): boolean {
  return value !== undefined && value !== "" && value !== "false" && value !== "0";
}

function useMemoryBackend(): boolean {
  return process.env.CI_KEYCHAIN === "memory" || isTruthyEnv(process.env.CI);
}

let warnedMemory = false;
function warnMemoryOnce(): void {
  if (warnedMemory) return;
  warnedMemory = true;
  console.warn(
    "[keychain] OS Secret Service unavailable / CI detected — using an " +
      "in-memory keychain fallback (keys are not persisted).",
  );
}

// Backend-aware primitives. In memory mode they never construct an `Entry`, so
// they cannot throw on a headless runner; otherwise they hit the real keychain.
function kcGet(account: string): string | null {
  if (useMemoryBackend()) {
    warnMemoryOnce();
    return memoryStore.get(account) ?? null;
  }
  return new Entry(SERVICE, account).getPassword() ?? null;
}

function kcSet(account: string, value: string): void {
  if (useMemoryBackend()) {
    warnMemoryOnce();
    memoryStore.set(account, value);
    return;
  }
  new Entry(SERVICE, account).setPassword(value);
}

function kcDelete(account: string): void {
  if (useMemoryBackend()) {
    warnMemoryOnce();
    memoryStore.delete(account);
    return;
  }
  new Entry(SERVICE, account).deletePassword();
}

function readManifest(): string[] {
  try {
    const raw = kcGet(MANIFEST_ACCOUNT);
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
    kcSet(MANIFEST_ACCOUNT, JSON.stringify(Array.from(new Set(ids))));
  } catch {
    // ignore — listKeys() falls back to scanning PROVIDER_IDS
  }
}

export async function setKey(providerId: ProviderId, key: string): Promise<void> {
  if (!isProviderId(providerId)) {
    throw new Error(`Unknown provider: ${providerId}`);
  }

  try {
    kcSet(providerId, key);
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
    return kcGet(providerId);
  } catch {
    return null;
  }
}

export async function deleteKey(providerId: ProviderId): Promise<void> {
  if (!isProviderId(providerId)) {
    return;
  }

  try {
    kcDelete(providerId);
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
    kcSet(PROBE_ACCOUNT, PROBE_VALUE);
    const got = kcGet(PROBE_ACCOUNT);
    kcDelete(PROBE_ACCOUNT);
    if (got !== PROBE_VALUE) {
      return { ok: false, error: "Keychain read-back mismatch" };
    }
    return { ok: true };
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    return { ok: false, error: cause };
  }
}
