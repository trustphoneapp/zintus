# Zintus Desktop — Platform Parity Matrix

Single source of truth for "same buttons, same dimensions, same CSS, same
functionality" across macOS / Windows / Linux. Grounded in
`docs/launch/research/R1–R6` (2026-07-05). Legend: ✅ parity · 🟡 divergent by
design (rationale recorded) · ❌ gap (has an S-task) · [HUMAN] needs
accounts/keys/hardware.

## Declared support floor (R3)

- Windows 10 1809+ / Windows 11, Evergreen WebView2
- macOS 13 Ventura+
- Linux: webkit2gtk-4.1 ≥ 2.40 (Ubuntu 22.04+, Debian 12+, Fedora 38+, patched)

## UI tokens (identical on all platforms — R4 decision)

| Token | Value | Notes |
|---|---|---|
| Global button | ~34px tall (8px 15px pad, 13px/600), radius 9px | meets Fluent 32, macOS ~28, GNOME 24–36, WCAG 24 floors |
| Hairline edges | exactly 1 device pixel on every display | `--hairline` = 1/dPR via JS (S1); 0.5px@2x, 1px@1x, 0.8px@1.25x … |
| Radii | 6/10/16/24 (+9 buttons, 999 pills) | shared tokens |
| Fonts | Inter + JetBrains Mono, bundled (next/font) | identical glyph outlines everywhere |
| Font smoothing | macOS-only CSS (antialiased @2x, auto @1x) | inert on Win/Linux by design; ClearType/FreeType native (R2) |
| Focus ring | `--c-focus` 2px+4px | identical |
| Shadows | `--shadow-*` w/ hairline ring | identical |

## Window chrome (R1 decision)

| Aspect | macOS | Windows | Linux |
|---|---|---|---|
| Titlebar | ✅ Overlay + traffic lights (unchanged) | ❌→S2 custom: decorations:false + Zintus caption buttons (Fluent 46×32 targets) | 🟡 native titlebar kept (SSD); CSD deferred — Wayland/X11 resize risk |
| Snap Layouts flyout | n/a | 🟡 lost with custom chrome; drag-to-edge + Win+Arrow work; decorum plugin = revisit path | n/a |
| Drag regions | ✅ | S2 (strip + top bar) | native |
| SSR platform flash | — | ❌→S2 (isMac defaults true) | ❌→S2 |

## Rendering (R2/R3)

| Aspect | macOS | Windows | Linux |
|---|---|---|---|
| Hairline crispness | ✅ (2x today; 1x fixed 612b2c07) | ❌→S1 (1.25/1.5/1.75 dPR need JS hairline) | ❌→S1 |
| color-mix/oklch/backdrop-filter | ✅ 13+ | ✅ Evergreen | ✅ ≥2.40; S3 adds literal fallbacks on load-bearing uses |
| Text rasterizer | Core Text (softest at 1x — engine limit) | ClearType (crispest) | FreeType (system settings) |

## Functionality (R6)

| Feature | macOS | Windows | Linux |
|---|---|---|---|
| Gateway sidecar spawn | ✅ | ✅ staged (.exe) — S6 CI-verifies | ✅ staged — S6 CI-verifies |
| Terminal (pty) | ✅ zsh | S4: pwsh→powershell→cmd chain; ConPTY smoke in S6 | ✅ $SHELL/bash |
| Key storage | ✅ Keychain | ✅ Credential Manager | 🟡 needs Secret Service; S4 graceful error, S5 deb deps |
| open_external | ✅ open | ❌→S4 (rundll32 → modern) | ✅ xdg-open |
| Shortcuts | ✅ ⌘ (menu-backed) | S2: Ctrl glyphs ✅, +Ctrl+W close | same as Windows |
| Mic/voice input | ✅ | [HUMAN] hardware smoke (WebView2 permission path) | [HUMAN] hardware smoke |
| Menubar-only actions | ✅ native menu | 🟡 no menu — all actions reachable in-app; verified in S6 metrics pass | 🟡 same |

## Distribution (R5)

| Aspect | macOS | Windows | Linux |
|---|---|---|---|
| Installer | .dmg | NSIS per-user, WebView2 downloadBootstrapper (S5) | .deb + AppImage; CI pinned ubuntu-22.04 (S5) |
| Signing | [HUMAN] Dev ID + notarize | [HUMAN] Azure Trusted Signing / OV+; scaffold in S5 | checksums (S5) |
| Auto-update | scaffold only (S5), off until [HUMAN] keygen | same | same |
| CI build | ✅ | ✅ | ✅ (repin) |
| CI launch+metrics verification | ❌→S6 | ❌→S6 | ❌→S6 |
