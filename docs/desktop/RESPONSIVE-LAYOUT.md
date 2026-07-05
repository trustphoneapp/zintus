# Zintus Desktop — responsive shell architecture

Why: Claude/Codex desktop stay usable at any window size — the sidebar
degrades gracefully and chrome condenses. Zintus previously had a hard
960×640 floor and a static sidebar. This doc is the contract; AppShell.tsx
implements it.

## Window floor

`minWidth 520 × minHeight 560` (tauri.conf.json + tauri.windows.conf.json).
Below-floor states don't exist; every breakpoint above renders fully usable.

## Breakpoints (window innerWidth, CSS px — same on every OS/dPR)

| Range | Sidebar mode | Behavior |
|---|---|---|
| ≥1024 | **full** (236px) | user's persisted collapse pref honored (`zintus:sidebar-collapsed`) |
| 720–1023 | **rail** (56px icon rail) | auto-compact; expanding via toggle is honored again once ≥1024 |
| <720 | **drawer** (0px) | sidebar hidden; toggle opens it as a fixed 236px overlay with scrim; closes on scrim click or on growing past 720 |

State model (AppShell): `collapsed` = persisted user preference (unchanged);
`winW` = live `resize` listener; `drawer = winW < 720`;
`compact = !drawer && (collapsed || winW < 1024)`; `drawerOpen` = overlay
visibility, force-closed when leaving drawer range. One `toggleSidebar()`
serves all modes (drawer → overlay open/close; otherwise → flip pref).

## Toggle placement (platform grammar)

- **macOS**: fixed button beside the traffic lights inside the 44px titlebar
  strip (`.strip-toggle`, shown only under `data-platform="mac"`), exactly
  where Claude/Codex put it. The old top-bar toggle is CSS-hidden on mac.
- **Windows/Linux**: toggle stays first in the top bar (`.topbar-toggle`) —
  matches Codex-on-Windows; caption buttons keep the top-right corner.

## Content behavior

- Main pane already `flex:1 minWidth:0`; chat column is intrinsically fluid.
- Top bar: center ⌘K trigger is `maxWidth:60%`, side controls are icons —
  fits at 520px. Revisit with a `<640px` condensation pass only if a real
  overflow shows up in the S6-style screenshot sweep.
- The drawer overlay z-order: scrim 140 < aside 150 < strip toggle 210 <
  caption buttons 200 (Windows never enters mac's strip-toggle path).

## Verification

- Visual sweep at 1280 / 900 / 640 / 520 widths (AppleScript resize +
  screenshots) on macOS; the desktop-verify CI selftest keeps asserting the
  fixed-geometry contract (topbar 52, icon buttons 32) which is
  width-independent.
