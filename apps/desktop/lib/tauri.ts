import type { ProviderId } from "@zintus/types";

const SERVICE = "com.zintus.desktop";

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function getKey(providerId: ProviderId): Promise<string | null> {
  if (!isTauri()) {
    return null;
  }
  const { getPassword } = await import("tauri-plugin-keyring-api");
  try {
    return await getPassword(SERVICE, providerId);
  } catch {
    return null;
  }
}

export async function setKey(
  providerId: ProviderId,
  key: string,
): Promise<void> {
  if (!isTauri()) {
    throw new Error("Keyring is only available in the desktop app");
  }
  const { setPassword } = await import("tauri-plugin-keyring-api");
  await setPassword(SERVICE, providerId, key);
}

export async function deleteKey(providerId: ProviderId): Promise<void> {
  if (!isTauri()) {
    return;
  }
  const { deletePassword } = await import("tauri-plugin-keyring-api");
  try {
    await deletePassword(SERVICE, providerId);
  } catch {
    // no-op when missing
  }
}

export async function hasKey(providerId: ProviderId): Promise<boolean> {
  if (providerId === "ollama" || providerId === "lmstudio") {
    return true;
  }
  const key = await getKey(providerId);
  return Boolean(key);
}
