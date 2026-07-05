# R6 — Functionality audit: platform branches & macOS assumptions

Audited 2026-07-05 on feat/desktop-xplat-parity (612b2c07). Format: location →
what Windows/Linux get today → required action.

## Frontend

1. **`AppShell.tsx:106-113` platform detection** — `isMac` defaults `true` pre-
   mount → Windows/Linux first paint shows mac chrome, then reflows. Also uses
   deprecated `navigator.platform`. → S2: detect via userAgent w/ platform
   fallback; render platform-neutral titlebar strip until mounted.
2. **`AppShell.tsx:335-338` titlebar strip** — non-mac gets a 12px strip; fine
   once Linux keeps its native titlebar; Windows (decorations:false per R1) needs
   the strip to be the drag surface. → S2.
3. **`AppShell.tsx:~1003` top bar** — non-mac reserves `padding-right: 150px` for
   OS caption buttons that Tauri does not overlay (R1 finding 3): today that is
   dead space under (Linux) or beside nothing (Windows). → S2: Windows renders
   custom min/max/close in that zone (Fluent 46×32 hit targets, R4); Linux
   reserves 0 and keeps native decorations.
4. **`AppShell.tsx:288-300` shortcuts** — uses `metaKey || ctrlKey`: works.
   Cmd+W/Cmd+Q come from the macOS default menu only; Windows/Linux rely on
   Alt+F4 / native close. → S2 adds Ctrl+W (close window) on non-mac since the
   Windows build is undecorated. Low risk.
5. **`lib/platform.ts`** — `⌘`/`Ctrl+` glyphs already platform-correct; same
   deprecated-`navigator.platform` cleanup as (1). → S2.
6. **`ChatPanel.tsx:210` mic sources** — enumeration written around macOS
   Continuity devices; `getUserMedia` on WebView2/WebKitGTK needs a runtime
   permission path that only real hardware verifies. → PLATFORM-PARITY 🟡 +
   launch-doc smoke item; no code change until tested.
7. **Fonts** — bundled via next/font; no platform gap. ✅

## Rust / config

8. **`lib.rs default_shell`** — Windows: `COMSPEC` → effectively always cmd.exe
   though the comment implies PowerShell. → S4 decision: default to
   `pwsh.exe`→`powershell.exe`→`COMSPEC` chain (modern default, falls back
   safely); macOS/Linux `$SHELL` fallback unchanged.
9. **`lib.rs open_external`** — Windows uses legacy `rundll32 url.dll,…`
   (functional but deprecated pattern; fails on some hardened systems). → S4:
   replace with `cmd /C start "" <url>`-safe variant or the maintained
   `tauri-plugin-opener`; https-only guard stays.
10. **`tauri-plugin-pty` terminal** — ConPTY on Windows: default shell decision
    in (8) feeds it; xterm.js rendering on WebView2 unverified. → S6 smoke.
11. **`keyring` crate** — backends configured for all 3 (`apple-native`,
    `windows-native`, `sync-secret-service`). Linux needs a running Secret
    Service (gnome-keyring/KWallet); headless/minimal WMs fail. → S4: map the
    NoEntry/platform errors to a graceful in-app message; S5 adds deb deps.
12. **Capabilities (`capabilities/default.json`)** — no `core:window:allow-
    minimize/allow-toggle-maximize/allow-close/allow-start-dragging` →
    the S2 custom caption buttons would be permission-denied. → S2 adds them.
13. **`tauri.conf.json`** — single window config; `titleBarStyle`/`hiddenTitle`
    are inert off-macOS (R1). → S2: `tauri.windows.conf.json` with
    `decorations:false`; base config untouched for macOS/Linux. S5: bundle
    sections (NSIS webviewInstallMode, linux deb depends, updater scaffold).

## Build / CI

14. **`scripts/stage-sidecar.ts`** — already correct for win32 (.exe), linux,
    and the macOS universal lipo path. ✅ (verify in CI on real runners — S6.)
15. **`release-desktop.yml`** — 3-OS matrix exists; Linux job runs
    `ubuntu-latest` (24.04) which raises the glibc/webkit floor above the
    declared Ubuntu 22.04 (R3/R5). → S5: pin `ubuntu-22.04`. No job launches the
    built app anywhere. → S6.
16. **Windows CLI sidecar source** — `build-binaries.ts --host` path exists for
    win32 per (14); CI must actually exercise it on the windows runner. → S6
    asserts sidecar spawn.

## Non-issues verified

- Shortcut glyphs, bundled fonts, keyring feature flags, sidecar naming — all
  already cross-platform.
- `windows_subsystem = "windows"` attribute present (no console window). ✅
