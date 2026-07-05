# R1 — Window chrome semantics per OS (Tauri 2.11.5)

Researched 2026-07-05 against the Tauri v2 docs and plugin repos. Pinned versions:
`tauri 2.11.5`, `tao 0.35.3` (apps/desktop/src-tauri/Cargo.lock).

## Findings

1. **`titleBarStyle` is macOS-only.** The three variants (Visible / Transparent /
   Overlay) apply exclusively to macOS. On Windows and Linux the option is ignored.
   Source: https://tauri.app/reference/config/ (WindowConfig → titleBarStyle,
   checked 2026-07-05).
2. **`hiddenTitle` is likewise macOS-only** (NSWindow title visibility). Windows and
   Linux show the native titlebar with the window title "Zintus".
3. **Consequence for the current config** (`apps/desktop/src-tauri/tauri.conf.json`
   sets only `titleBarStyle: "Overlay"` + `hiddenTitle: true`): Windows and Linux
   builds today render a full native titlebar *above* the app's own top bar —
   double chrome. The comment in `AppShell.tsx:106-109` claiming Windows/Linux
   "overlay native caption buttons top-RIGHT" describes behavior Tauri does not
   provide; the reserved top-right space is currently dead space under a native
   titlebar.
4. **The supported Windows pattern is `decorations: false` + custom controls.**
   Official guidance: hide the native frame and build the titlebar in HTML/CSS/JS;
   dragging via `data-tauri-drag-region` (applies only to the element itself, not
   children — interactive children stay clickable); window controls via
   `appWindow.minimize()/toggleMaximize()/close()`, which require the matching
   `core:window:allow-*` capabilities.
   Source: https://v2.tauri.app/learn/window-customization/ (checked 2026-07-05).
5. **Snap Layouts caveat (Windows 11):** with `decorations: false`, the hover
   flyout on the maximize button is lost (it is native chrome). Drag-to-edge
   snapping and Win+Arrow / Win+Z continue to work — they are shell features, not
   titlebar features. Plugins exist to restore the flyout:
   - `tauri-plugin-decorum` (https://github.com/clearlysid/tauri-plugin-decorum):
     Tauri v2, preserves Snap Layout, but explicitly in maintenance mode; last
     release v1.1.0 (2024-09-04); no Linux support.
   - `tauri-plugin-frame` / `tauri-plugin-snap-layout`: younger forks/alternatives,
     smaller adoption.
6. **Platform-specific config merging exists:** `tauri.windows.conf.json` /
   `tauri.linux.conf.json` / `tauri.macos.conf.json` merge over `tauri.conf.json`
   per target, so `decorations` can differ per OS without runtime branching.
   Source: https://tauri.app/reference/config/ (configuration files section).
7. **Undecorated-window mechanics on Windows:** resize borders and the DWM shadow
   on an undecorated window come from the window `shadow` setting (default true in
   Tauri v2); tao implements WM_NCHITTEST-based edge resizing for undecorated
   windows. Must be verified in CI/smoke on a real Windows runner (S6).
8. **Linux reality check:** custom CSD in WebKitGTK means hand-implementing drag,
   resize edges, and shading across X11 *and* Wayland compositors; Tauri docs do
   not provide a supported resize story for undecorated Linux windows. Most Tauri
   apps ship native server-side decorations on Linux.

## Decision

- **macOS — unchanged.** Keep `titleBarStyle: Overlay` + `hiddenTitle`; traffic
  lights float over the sidebar as today. Zero regression tolerance here.
- **Windows — `decorations: false` via `tauri.windows.conf.json` + custom caption
  buttons** (minimize / maximize-toggle / close) rendered by AppShell in the
  reserved top-right strip, wired to the `@tauri-apps/api/window` methods with the
  three `core:window:allow-*` permissions added. Buttons follow Fluent caption
  metrics (46×32 hit targets, centered 10px glyphs) but Zintus colors, so the app
  reads native-shaped while staying on-brand.
  **No decorum dependency in v1**: it is a maintenance-mode native plugin; the only
  thing it buys is the Snap-Layouts hover flyout. Drag-to-edge and Win+Arrow/Win+Z
  still work without it. Logged as 🟡 divergent-by-design in PLATFORM-PARITY with
  decorum as the revisit path if users complain.
- **Linux — keep native decorations (SSD).** No custom titlebar in v1: undecorated
  resize/drag on Wayland+X11 is unsupported territory and a launch risk. The native
  titlebar shows "Zintus" + native controls; the app's top bar remains a toolbar.
  Double chrome on Linux is accepted and logged 🟡 divergent-by-design (GNOME users
  see the same pattern in many Electron/Tauri apps); revisit CSD post-launch.
- **SSR flash fix (all platforms):** `AppShell` defaults `isMac = true` before
  mount, so Windows/Linux briefly render mac layout. Fix: derive platform once from
  `navigator.userAgent`/`platform` in a layout-effect *and* persist the last-known
  platform (localStorage) to make the first SSR paint correct after first run;
  simplest correct v1: render platform-neutral chrome until mounted (no reserved
  corners), then swap — measure flicker in S2 and pick.
