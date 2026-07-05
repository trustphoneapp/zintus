# R5 — Distribution, signing, and updates per platform

Researched 2026-07-05. Current state: `tauri.conf.json` has `createUpdaterArtifacts:
false`, macOS `Entitlements.plist` only; `release-desktop.yml` builds
universal-apple-darwin / x86_64-pc-windows-msvc / x86_64-unknown-linux-gnu and
uploads unsigned artifacts to a GitHub Release.

## Windows

- **Installer format:** NSIS (`.exe`) — chosen over MSI/WiX because it supports
  per-user install without elevation (default → `%LOCALAPPDATA%`) and, unlike
  MSI, can be cross-compiled if we ever need it. We build on `windows-latest`
  runners so both work, but NSIS is the Tauri-recommended path.
  Source: https://v2.tauri.app/distribute/windows-installer/ (checked 2026-07-05).
- **WebView2 runtime:** ship the default `downloadBootstrapper` install mode
  (0 MB added; downloads Evergreen runtime if missing). Windows 10/11 targets
  virtually always have it (ships with Windows 11 and via Windows Update).
  Explicitly configure it rather than relying on defaults. `offlineInstaller`
  (+127 MB) rejected for a chat app; `skip` rejected as unsafe.
- **Code signing — [HUMAN]:** unsigned NSIS installers hit the SmartScreen scare
  wall; this is a de facto launch blocker for public distribution.
  Options (source: https://v2.tauri.app/distribute/sign/windows/, checked
  2026-07-05):
  1. **Azure Trusted/Artifact Signing** — recommended: cloud signing, no cert file
     to protect; needs an Azure account + App Registration; CI signs via
     `signCommand` in `tauri.conf.json` with `AZURE_CLIENT_ID` /
     `AZURE_CLIENT_SECRET` / `AZURE_TENANT_ID` GitHub secrets.
  2. OV cert (.pfx in GH secrets, base64) — cheaper, SmartScreen reputation builds
     slowly.
  3. EV cert — immediate SmartScreen trust, most expensive/strict.
  Code side (S5): wire `signCommand` scaffolding + document the secrets; actual
  enrollment is [HUMAN].
- **MS Store:** out of scope for v1 (separate MSIX pipeline + store policies);
  note in WINDOWS-LAUNCH as a later channel.

## Linux

- **Formats:** ship **.deb + AppImage** (current workflow already produces
  bundles on ubuntu runner). rpm optional later; Flatpak deferred (needs manifest
  + runtime work).
- **AppImage caveat:** webkit2gtk is NOT bundled inside the AppImage — hosts still
  need the runtime era of the build system; build on the oldest supported base
  (Ubuntu 22.04) to keep the glibc floor low.
  Source: https://v2.tauri.app/distribute/appimage/ (checked 2026-07-05).
  ⚠ Current CI uses `ubuntu-latest` (24.04) — S5 pins the Linux job to
  `ubuntu-22.04` to match the declared floor (R3).
- **.deb dependencies:** Tauri auto-adds webkit2gtk-4.1/gtk deps; the `keyring`
  crate's `sync-secret-service` backend additionally needs a Secret Service
  provider at runtime (gnome-keyring/KWallet) and `libsecret` tooling —
  S5 adds `bundle.linux.deb.depends` accordingly and R6/LINUX-LAUNCH documents
  headless/no-keyring behavior.
- **Signing:** Linux artifacts are conventionally unsigned; integrity via GitHub
  Release checksums (S5 adds a SHA256SUMS step). AppImage signing/zsync deferred.

## Auto-update (all platforms)

Source: https://v2.tauri.app/plugin/updater/ (checked 2026-07-05).
- Requires `tauri-plugin-updater`, `createUpdaterArtifacts: true`, a minisign-style
  keypair from `tauri signer generate`; public key in tauri.conf.json, private key
  + optional password as CI env (`TAURI_SIGNING_PRIVATE_KEY[_PASSWORD]`) — **key
  generation and secret storage are [HUMAN]** (losing the key orphans installs).
- Artifacts: Windows NSIS `.exe` + `.sig`; macOS `app.tar.gz` + `.sig`; Linux
  AppImage + `.sig`. Endpoint: static JSON manifest (version, platforms.{target}
  .url/.signature) — we already own releases.zintus.ai (CSP allows it), so the
  manifest lives there.
- S5 scope: add the plugin + config + endpoint scaffolding **disabled** behind the
  absence of the pubkey, so flipping it on is config-only after [HUMAN] keygen.

## macOS (baseline check only)

- Current pipeline produces unsigned, un-notarized .app/.dmg — fine for local
  use, Gatekeeper-blocked for public distribution. Already tracked in the macOS
  HUMAN-CHECKLIST (Developer ID cert + notarytool). No new work here beyond
  keeping updater artifacts in mind.

## [HUMAN] consolidated (feeds P1/P3)

1. Azure Trusted Signing (or OV/EV cert) enrollment + 3 GitHub secrets.
2. `tauri signer generate` updater keypair; store private key + password as GH
   secrets; commit pubkey.
3. Host the update manifest at releases.zintus.ai (static JSON).
4. macOS Developer ID + notarization credentials (pre-existing item).
5. Real-hardware smoke pass per platform before first public release.
