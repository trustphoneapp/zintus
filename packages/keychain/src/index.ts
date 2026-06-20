import {
  isProviderId,
  PROVIDER_IDS,
  type ProviderId,
} from "@zintus/types";
import {
  deleteKey,
  getKey,
  listKeys as listStoredKeys,
  setKey,
} from "./storage.js";

export const PROVIDERS = PROVIDER_IDS;
export type Provider = ProviderId;

export function isValidProvider(value: string): value is ProviderId {
  return isProviderId(value);
}

export { deleteKey, getKey, setKey };
export type { Keychain, KeychainEntry } from "./keychain.js";
export { createKeychain } from "./factory.js";

export async function removeKey(provider: ProviderId): Promise<boolean> {
  const existing = await getKey(provider);
  if (!existing) {
    return false;
  }
  await deleteKey(provider);
  return true;
}

export async function listKeys(): Promise<
  Array<{ provider: ProviderId; masked: string }>
> {
  const ids = await listStoredKeys();
  const results: Array<{ provider: ProviderId; masked: string }> = [];

  for (const id of ids) {
    const key = await getKey(id);
    if (!key) {
      continue;
    }
    const visible =
      key.length <= 8 ? "****" : `${key.slice(0, 4)}…${key.slice(-4)}`;
    results.push({ provider: id, masked: visible });
  }

  return results.sort((a, b) => a.provider.localeCompare(b.provider));
}
