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

function writeManifest(ids: string[]): void {
  manifestEntry().setPassword(JSON.stringify(Array.from(new Set(ids))));
}

export async function setKey(providerId: ProviderId, key: string): Promise<void> {
  if (!isProviderId(providerId)) {
    throw new Error(`Unknown provider: ${providerId}`);
  }

  providerEntry(providerId).setPassword(key);
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
