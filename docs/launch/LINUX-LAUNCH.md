# Zintus Desktop — Linux launch checklist

Mirrors docs/desktop-v1/HUMAN-CHECKLIST.md for the Linux build. Support floor:
webkit2gtk-4.1 ≥ 2.40 — Ubuntu 22.04+, Debian 12+, Fedora 38+ with normal
security updates (R3).

## 1. Packaging correctness (code — S5, verify in CI)

- [ ] CI linux job pinned to **ubuntu-22.04** (glibc/webkit floor; building on
      24.04 silently raises the floor — R5).
- [ ] `.deb` declares runtime deps incl. Secret Service bits (`libsecret`,
      keyring provider recommendation) beyond Tauri's auto webkit2gtk-4.1 deps.
- [ ] AppImage boots on a stock Ubuntu 22.04 live VM (webkit2gtk is NOT inside
      the AppImage — host runtime matters).

## 2. Real-hardware smoke [HUMAN] (one Ubuntu 22.04 or 24.04 machine/VM)

- [ ] Install .deb → launch; and run the AppImage directly.
- [ ] Window: native titlebar shows (SSD kept by design — R1); app top bar has
      no dead 150px gap (S2); resize/maximize native.
- [ ] Scaling: 100% and 200% (and 125% fractional on Wayland if available) →
      crisp hairlines (S1).
- [ ] Chat roundtrip: sidecar auto-starts, one turn streams.
- [ ] Keys: with GNOME keyring active → key saves + survives relaunch; on a
      minimal WM without Secret Service → graceful in-app error (S4), no crash.
- [ ] Terminal: opens with $SHELL, echo test.
- [ ] Mic: WebKitGTK permission path — first run on real hardware.
- [ ] open_external → xdg-open opens default browser.

## 3. Release

- [ ] Tag → release-desktop.yml linux job produces .deb + AppImage +
      SHA256SUMS (S5).
- [ ] Update feed: same latest.json as macOS/Windows; auto-update scaffold
      stays OFF until updater keys exist ([HUMAN], shared item).

## Divergences accepted for v1 (recorded in PLATFORM-PARITY)

- Native titlebar (no custom CSD) — double-chrome look accepted; CSD revisit
  post-launch.
- No rpm/Flatpak/ARM64 in v1.
