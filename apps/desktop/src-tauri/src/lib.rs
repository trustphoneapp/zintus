#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use keyring::Entry;

const SERVICE: &str = "com.multipleai.desktop";

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

#[tauri::command]
fn greet(name: &str) -> String {
  format!("Hello, {name}!")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_pty::init())
    .invoke_handler(tauri::generate_handler![
      greet,
      keyring_get,
      keyring_set,
      keyring_delete
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
