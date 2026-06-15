import type { ProviderId } from "@multipleai/types";
import { deleteKey, getKey, listKeys, setKey } from "./storage.js";
import type { Keychain } from "./keychain.js";

export function createKeychain(): Keychain {
  return {
    async get(providerId: string) {
      return getKey(providerId as ProviderId);
    },
    async set(providerId: string, key: string) {
      await setKey(providerId as ProviderId, key);
    },
    async delete(providerId: string) {
      await deleteKey(providerId as ProviderId);
    },
    async list() {
      const keys = await listKeys();
      return keys.map((providerId) => providerId as string);
    },
  };
}
