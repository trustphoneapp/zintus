import type { ProviderId } from "@multipleai/types";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri) {
    throw new Error("Keyring commands are only available in the Tauri shell.");
  }

  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
  return tauriInvoke<T>(command, args);
}

export async function getProviderKey(providerId: ProviderId): Promise<string | null> {
  return invoke<string | null>("keyring_get", { providerId });
}

export async function setProviderKey(
  providerId: ProviderId,
  key: string,
): Promise<void> {
  await invoke("keyring_set", { providerId, key });
}

export async function deleteProviderKey(providerId: ProviderId): Promise<void> {
  await invoke("keyring_delete", { providerId });
}

export function isDesktopShell(): boolean {
  return isTauri;
}
