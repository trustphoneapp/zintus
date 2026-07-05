# Zintus Desktop — Windows launch checklist

Mirrors docs/desktop-v1/HUMAN-CHECKLIST.md for the Windows build. Code items are
tracked as S-tasks on feat/desktop-xplat-parity; below is what stands between a
green CI build and a public Windows release. Ordered top to bottom.

Support floor: Windows 10 1809+ / Windows 11, Evergreen WebView2 (auto-installed
by the NSIS bootstrapper when missing).

## 1. Code signing — the launch blocker [HUMAN]

Unsigned NSIS installers hit the SmartScreen wall; do not ship one.

- [ ] Pick the signing path (R5 recommends **Azure Trusted Signing**):
      Azure account → Trusted Signing resource + identity validation →
      App Registration → add GitHub secrets `AZURE_CLIENT_ID`,
      `AZURE_CLIENT_SECRET`, `AZURE_TENANT_ID`. (Alternative: OV/EV .pfx →
      base64 → GH secrets.)
- [ ] Flip the `signCommand` scaffold in `tauri.windows.conf.json` (S5) to
      active and run one signed CI build.
- [ ] Verify: download installer on a clean Windows VM → no SmartScreen block →
      installs per-user without elevation → app launches.

## 2. Real-hardware smoke [HUMAN] (30 min, one Windows 11 machine)

- [ ] Display scaling: set 100% → 125% → 150% → confirm button edges stay
      crisp (hairline = 1 device px, S1) and text is ClearType-sharp.
- [ ] Window chrome (S2): drag by titlebar strip, min/max/close buttons,
      double-click-maximize, drag-to-edge snap, Win+Arrow.
- [ ] Chat roundtrip: gateway sidecar auto-starts (zintus.exe), one BYOK or
      Ollama turn streams, receipt renders.
- [ ] Terminal: opens, default shell (pwsh/powershell fallback, S4), echo test.
- [ ] Keys: save a provider key → Credential Manager entry exists → survives
      relaunch.
- [ ] Mic button: WebView2 permission prompt appears and recording works —
      first time this path runs on real hardware.
- [ ] Sign-in: open_external opens the default browser (S4 fix).

## 3. Release

- [ ] Tag (`git tag desktop-vX.Y.Z && git push --tags`) → release-desktop.yml
      windows job produces signed `Zintus_X.Y.Z_x64-setup.exe`.
- [ ] Spot-check the GitHub Release assets + SHA256SUMS (S5).

## 4. Update feed (shared with macOS/Linux) [HUMAN]

- [ ] `latest.json` at releases.zintus.ai (existing in-app check reads it).
- [ ] Auto-update stays OFF until `tauri signer generate` keypair exists and
      its secrets are in CI (S5 scaffold; unconfigured updater must never ship
      enabled — packaged builds panic).

## Later channels (not v1)

- MS Store (MSIX + store policies), winget manifest, ARM64 Windows build.
