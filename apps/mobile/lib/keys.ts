import * as SecureStore from "expo-secure-store";
import type { ProviderId } from "@multipleai/types";

const KEY_PREFIX = "multipleai:key:";

function storageKey(providerId: ProviderId): string {
  return `${KEY_PREFIX}${providerId}`;
}

export async function getApiKey(providerId: ProviderId): Promise<string | null> {
  return SecureStore.getItemAsync(storageKey(providerId));
}

export async function setApiKey(
  providerId: ProviderId,
  apiKey: string,
): Promise<void> {
  await SecureStore.setItemAsync(storageKey(providerId), apiKey);
}

export async function deleteApiKey(providerId: ProviderId): Promise<void> {
  await SecureStore.deleteItemAsync(storageKey(providerId));
}

export async function hasApiKey(providerId: ProviderId): Promise<boolean> {
  const value = await getApiKey(providerId);
  return Boolean(value?.trim());
}
