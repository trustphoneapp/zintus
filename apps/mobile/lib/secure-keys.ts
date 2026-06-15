import * as SecureStore from "expo-secure-store";
import type { ProviderId } from "@multipleai/types";

export async function getProviderKey(providerId: ProviderId): Promise<string | null> {
  return SecureStore.getItemAsync(`key:${providerId}`);
}

export async function setProviderKey(
  providerId: ProviderId,
  key: string,
): Promise<void> {
  await SecureStore.setItemAsync(`key:${providerId}`, key);
}

export async function deleteProviderKey(providerId: ProviderId): Promise<void> {
  await SecureStore.deleteItemAsync(`key:${providerId}`);
}
