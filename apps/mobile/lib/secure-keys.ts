import { Platform } from "react-native";
import type { ProviderId } from "@zintus/types";
import {
  deleteApiKey,
  getApiKey,
  hasApiKey,
  setApiKey,
} from "./keys";

/** @deprecated Use getApiKey from ./keys */
export const getProviderKey = getApiKey;

/** @deprecated Use setApiKey from ./keys */
export const setProviderKey = setApiKey;

/** @deprecated Use deleteApiKey from ./keys */
export const deleteProviderKey = deleteApiKey;

export { getApiKey, setApiKey, deleteApiKey, hasApiKey };

const LEGACY_PREFIX = "key:";

/** Migrate keys saved under the old `key:<provider>` namespace. No-op on web:
 *  there are no legacy native SecureStore entries there, and web's SecureStore
 *  rejects the legacy `key:` prefix (colon is not an allowed key character). */
export async function migrateLegacyKeys(): Promise<void> {
  if (Platform.OS === "web") return;
  const { listProviders } = await import("@zintus/providers");
  for (const provider of listProviders()) {
    const legacy = await import("expo-secure-store").then((mod) =>
      mod.getItemAsync(`${LEGACY_PREFIX}${provider.id}`),
    );
    if (!legacy?.trim()) {
      continue;
    }
    const current = await getApiKey(provider.id);
    if (!current) {
      await setApiKey(provider.id, legacy);
    }
    await import("expo-secure-store").then((mod) =>
      mod.deleteItemAsync(`${LEGACY_PREFIX}${provider.id}`),
    );
  }
}
