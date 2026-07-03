import type { ProviderId } from "@zintus/types";

// The OS-keyring service name is owned by the Rust backend
// (`src-tauri/src/lib.rs`, the `SERVICE` const). It is intentionally "zintus" —
// the SAME service the gateway/CLI keychain uses
// (`packages/keychain/src/storage.ts`) — so a key entered in the desktop app
// lands in the exact OS-keychain entry the local gateway reads for the chat
// path (entries are addressed by provider id, matching the gateway's
// `Entry(SERVICE, providerId)` layout). There is no service constant here on
// purpose: the Rust commands below own the service so there is a single source
// of truth and no JS/Rust drift.

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

// Call the app's OWN Rust keyring commands registered in
// `src-tauri/src/lib.rs` (`keyring_get` / `keyring_set` / `keyring_delete`) via
// Tauri's `invoke`. The previous `tauri-plugin-keyring-api` path was a no-op:
// that plugin was never added to Cargo.toml, registered on the Builder, or
// granted a capability, so every call threw at runtime and BYOK key entry
// silently failed. Tauri maps snake_case Rust params to camelCase JS keys by
// default, so the Rust `provider_id` parameter is passed as `providerId`.
async function invokeTauri<T>(
  command: string,
  args: Record<string, unknown>,
): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

export async function getKey(providerId: ProviderId): Promise<string | null> {
  if (!isTauri()) {
    return null;
  }
  try {
    // Rust: `keyring_get(provider_id: String) -> Result<Option<String>, _>`.
    return await invokeTauri<string | null>("keyring_get", { providerId });
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
  // Rust: `keyring_set(provider_id: String, key: String) -> Result<(), _>`.
  await invokeTauri<void>("keyring_set", { providerId, key });
}

export async function deleteKey(providerId: ProviderId): Promise<void> {
  if (!isTauri()) {
    return;
  }
  try {
    // Rust: `keyring_delete(provider_id: String) -> Result<(), _>`.
    await invokeTauri<void>("keyring_delete", { providerId });
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

/**
 * Open an https URL in the user's default browser. Packaged app: routed
 * through the Rust `open_external` command (https-only, see lib.rs). Dev
 * browser (`next dev`): plain window.open.
 */
export async function openExternal(url: string): Promise<void> {
  if (!url.startsWith("https://")) {
    throw new Error("only https URLs can be opened");
  }
  if (isTauri()) {
    await invokeTauri<void>("open_external", { url });
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}
