#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::{SocketAddr, TcpStream};
use std::sync::Mutex;
use std::time::Duration;

use keyring::Entry;
use tauri::{Manager, RunEvent};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

// OS-keychain service name. Must match the gateway/CLI keychain service
// (`packages/keychain/src/storage.ts`, `const SERVICE = "zintus"`) so a key the
// user enters in the desktop app lands in the SAME OS-keychain entry the local
// gateway reads for the chat path. Entries are keyed by provider id (the
// `provider_id` account below), mirroring the gateway's `Entry(SERVICE, id)`
// layout. Previously this was "com.zintus.desktop", which made desktop-entered
// keys invisible to the gateway even once the invoke path was fixed.
const SERVICE: &str = "zintus";

// The port `zintus serve` listens on by default — matches the frontend's
// DEFAULT_GATEWAY_URL (apps/desktop/lib/gateway.ts, http://localhost:8788).
const GATEWAY_PORT: u16 = 8788;

/// Handle to the gateway sidecar we spawned (None when an external gateway was
/// already running, or the spawn failed). Killed on app exit so we never leave
/// an orphaned `zintus serve` behind — but ONLY for the process WE started; a
/// user-run gateway is never touched.
struct GatewaySidecar(Mutex<Option<CommandChild>>);

fn keyring_entry(provider_id: &str) -> Result<Entry, String> {
  Entry::new(SERVICE, provider_id).map_err(keyring_error)
}

/// Human-readable keyring failures. On Linux the common real-world failure is
/// no Secret Service on the bus (minimal WMs, headless sessions) — say what to
/// install instead of surfacing a D-Bus error string (R6 item 11).
fn keyring_error(error: keyring::Error) -> String {
  #[cfg(all(unix, not(target_os = "macos")))]
  if matches!(
    error,
    keyring::Error::PlatformFailure(_) | keyring::Error::NoStorageAccess(_)
  ) {
    return format!(
      "no secure key storage available — enable GNOME Keyring or KWallet (Secret Service) and retry ({error})"
    );
  }
  error.to_string()
}

#[tauri::command]
fn keyring_get(provider_id: String) -> Result<Option<String>, String> {
  match keyring_entry(&provider_id)?.get_password() {
    Ok(value) => Ok(Some(value)),
    Err(keyring::Error::NoEntry) => Ok(None),
    Err(error) => Err(keyring_error(error)),
  }
}

#[tauri::command]
fn keyring_set(provider_id: String, key: String) -> Result<(), String> {
  keyring_entry(&provider_id)?
    .set_password(&key)
    .map_err(keyring_error)
}

#[tauri::command]
fn keyring_delete(provider_id: String) -> Result<(), String> {
  match keyring_entry(&provider_id)?.delete_credential() {
    Ok(()) => Ok(()),
    Err(keyring::Error::NoEntry) => Ok(()),
    Err(error) => Err(keyring_error(error)),
  }
}

/// Open an external URL in the user's default browser (cloud sign-in, Stripe
/// checkout, provider key consoles). https-only — the webview can never launch
/// arbitrary programs; this command is the only opener the frontend gets.
/// Delegates to the official opener plugin (ShellExecuteW on Windows — the old
/// hand-rolled `rundll32 url.dll` path was legacy and breaks on hardened
/// systems; `open`/`xdg-open` equivalents elsewhere — R6 item 9).
#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
  if !url.starts_with("https://") {
    return Err("only https URLs can be opened".to_string());
  }
  tauri_plugin_opener::open_url(&url, None::<&str>).map_err(|error| error.to_string())
}

/// Resolve a sensible default shell per OS for the embedded terminal. The
/// webview cannot read host env (`$SHELL`/`%COMSPEC%`), so the backend does it:
/// honor the user's login shell on macOS/Linux, fall back to a shell that is
/// guaranteed to exist on each platform.
#[tauri::command]
fn default_shell() -> String {
  #[cfg(target_os = "windows")]
  {
    // NOT %COMSPEC%: it always points at cmd.exe, a poor default terminal.
    // Windows PowerShell ships at a fixed path on every supported Windows;
    // cmd stays the last-resort fallback (R6 item 8).
    match std::env::var("SystemRoot") {
      Ok(root) => format!("{root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"),
      Err(_) => std::env::var("COMSPEC").unwrap_or_else(|_| "powershell.exe".into()),
    }
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

/// True when something is already listening on the gateway port — either a
/// user-run `zintus serve` or a previous sidecar. We must NOT double-start:
/// the second instance would fail to bind and exit noisily.
fn gateway_already_running() -> bool {
  let addr: SocketAddr = ([127, 0, 0, 1], GATEWAY_PORT).into();
  TcpStream::connect_timeout(&addr, Duration::from_millis(400)).is_ok()
}

/// Start the bundled gateway (`zintus serve`) as a Tauri sidecar. This is what
/// makes the desktop app self-contained: no terminal, no `zintus serve` by
/// hand. Failure is NON-FATAL — the app still works against a manually run
/// gateway, and the shell's offline banner tells the user what's wrong.
fn spawn_gateway(app: &tauri::AppHandle) {
  if gateway_already_running() {
    eprintln!("[zintus] gateway already listening on :{GATEWAY_PORT} — not starting the sidecar");
    return;
  }
  let command = match app.shell().sidecar("zintus") {
    // ZINTUS_PARENT_PID arms the gateway's parent-watch: it self-exits when
    // this process dies, covering crash/force-quit paths where RunEvent::Exit
    // (our kill below) never runs.
    Ok(command) => command
      .args(["serve"])
      .env("ZINTUS_PARENT_PID", std::process::id().to_string()),
    Err(error) => {
      eprintln!("[zintus] gateway sidecar unavailable ({error}) — run `zintus serve` manually");
      return;
    }
  };
  match command.spawn() {
    Ok((_events, child)) => {
      eprintln!("[zintus] started gateway sidecar (pid {})", child.pid());
      if let Some(state) = app.try_state::<GatewaySidecar>() {
        *state.0.lock().unwrap() = Some(child);
      }
    }
    Err(error) => {
      eprintln!("[zintus] failed to start gateway sidecar ({error}) — run `zintus serve` manually");
    }
  }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let app = tauri::Builder::default()
    .plugin(tauri_plugin_shell::init())
    .plugin(tauri_plugin_pty::init())
    // NOTE: no updater plugin. It was registered here once, but with no
    // plugins.updater config (endpoint + signing pubkey) it PANICS at startup
    // in a bundled build ("invalid type: null") — first caught by the packaged
    // smoke on 2026-07-02. Re-add together with a real update endpoint,
    // signing keys, and createUpdaterArtifacts: true.
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_fs::init())
    // Only reachable through the https-gated open_external command below —
    // no JS-side opener capability is granted.
    .plugin(tauri_plugin_opener::init())
    .manage(GatewaySidecar(Mutex::new(None)))
    .invoke_handler(tauri::generate_handler![
      keyring_get,
      keyring_set,
      keyring_delete,
      default_shell,
      open_external
    ])
    .setup(|app| {
      spawn_gateway(&app.handle().clone());
      Ok(())
    })
    .build(tauri::generate_context!())
    .expect("error while building tauri application");

  app.run(|app_handle, event| {
    if let RunEvent::Exit = event {
      // Kill only the sidecar WE spawned; a user-run gateway is untouched.
      if let Some(state) = app_handle.try_state::<GatewaySidecar>() {
        if let Some(child) = state.0.lock().unwrap().take() {
          let _ = child.kill();
        }
      }
    }
  });
}
