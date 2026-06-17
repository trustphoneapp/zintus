import { Entry } from "@napi-rs/keyring";
import type { ProviderId } from "@multipleai/types";
import { isProviderId, PROVIDER_IDS } from "@multipleai/types";

const SERVICE = "multipleai";
const MANIFEST_ACCOUNT = "__manifest__";

function manifestEntry(): Entry {
  return new Entry(SERVICE, MANIFEST_ACCOUNT);
}

function providerEntry(providerId: string): Entry {
  return new Entry(SERVICE, providerId);
}

function readManifest(): string[] {
  try {
    const raw = manifestEntry().getPassword();
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
      "`dbus`), or run the gateway/CLI on a machine that has one. " +
      `Cause: ${cause}`,
  );
}

// Best-effort: the manifest just speeds up `listKeys`; discovery still works by
// scanning known provider ids, so a manifest write must never break `setKey`.
function writeManifest(ids: string[]): void {
  try {
    manifestEntry().setPassword(JSON.stringify(Array.from(new Set(ids))));
  } catch {
    // ignore — listKeys() falls back to scanning PROVIDER_IDS
  }
}

export async function setKey(providerId: ProviderId, key: string): Promise<void> {
  if (!isProviderId(providerId)) {
    throw new Error(`Unknown provider: ${providerId}`);
  }

  try {
    providerEntry(providerId).setPassword(key);
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
    return providerEntry(providerId).getPassword() ?? null;
  } catch {
    return null;
  }
}

export async function deleteKey(providerId: ProviderId): Promise<void> {
  if (!isProviderId(providerId)) {
    return;
  }

  try {
    providerEntry(providerId).deletePassword();
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
