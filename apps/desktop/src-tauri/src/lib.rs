#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use keyring::Entry;

// OS-keychain service name. Must match the gateway/CLI keychain service
// (`packages/keychain/src/storage.ts`, `const SERVICE = "zintus"`) so a key the
// user enters in the desktop app lands in the SAME OS-keychain entry the local
// gateway reads for the chat path. Entries are keyed by provider id (the
// `provider_id` account below), mirroring the gateway's `Entry(SERVICE, id)`
// layout. Previously this was "com.zintus.desktop", which made desktop-entered
// keys invisible to the gateway even once the invoke path was fixed.
const SERVICE: &str = "zintus";

fn keyring_entry(provider_id: &str) -> Result<Entry, String> {
  Entry::new(SERVICE, provider_id).map_err(|error| error.to_string())
}

#[tauri::command]
fn keyring_get(provider_id: String) -> Result<Option<String>, String> {
  match keyring_entry(&provider_id)?.get_password() {
    Ok(value) => Ok(Some(value)),
    Err(keyring::Error::NoEntry) => Ok(None),
    Err(error) => Err(error.to_string()),
  }
}

#[tauri::command]
fn keyring_set(provider_id: String, key: String) -> Result<(), String> {
  keyring_entry(&provider_id)?
    .set_password(&key)
    .map_err(|error| error.to_string())
}

#[tauri::command]
fn keyring_delete(provider_id: String) -> Result<(), String> {
  match keyring_entry(&provider_id)?.delete_credential() {
    Ok(()) => Ok(()),
    Err(keyring::Error::NoEntry) => Ok(()),
    Err(error) => Err(error.to_string()),
  }
}

/// Resolve a sensible default shell per OS for the embedded terminal. The
/// webview cannot read host env (`$SHELL`/`%COMSPEC%`), so the backend does it:
/// honor the user's login shell on macOS/Linux, fall back to a shell that is
/// guaranteed to exist on each platform.
#[tauri::command]
fn default_shell() -> String {
  #[cfg(target_os = "windows")]
  {
    std::env::var("COMSPEC").unwrap_or_else(|_| "powershell.exe".into())
  }
  #[cfg(target_os = "macos")]
  {
    std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into())
  }
  #[cfg(not(any(target_os = "windows", target_os = "macos")))]
  {
    std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into())
  }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_pty::init())
    .plugin(tauri_plugin_updater::Builder::new().build())
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_fs::init())
    .invoke_handler(tauri::generate_handler![
      keyring_get,
      keyring_set,
      keyring_delete,
      default_shell
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
