# Desktop Release Checklist — Zintus (Tauri v2)

Per-surface, command-level checklist to ship the **Zintus desktop** app
(`apps/desktop/`, Tauri v2 + Next.js) as signed, installable builds on macOS,
Windows, and Linux.

> Scope: this file is the *how-to-cut-a-release* runbook. Store/compliance
> readiness lives in [`STORE-READINESS.md`](./STORE-READINESS.md). The
> tag-driven CI is `.github/workflows/release-desktop.yml`; signing-secret
> names are in [`store/SECRETS.md`](./store/SECRETS.md); macOS distribution
> rationale is in [`store/mac-distribution.md`](./store/mac-distribution.md).

## Legend

| Mark | Meaning |
|---|---|
| ✅ CI | Runs unattended in `release-desktop.yml` today (no human, no cert). |
| 🔑 [HUMAN] | Needs a cert / paid account / Apple-Microsoft-distro asset the build sandbox does **not** have. Cannot be automated here. |
| 🖥️ [HUMAN-device] | Needs a *clean* physical/VM machine of that OS to verify. |

---

## 0. Current config snapshot (grounded in the repo, 2026-06-26)

Read from `apps/desktop/src-tauri/tauri.conf.json`, `Cargo.toml`,
`package.json`, `src/lib.rs`, `capabilities/default.json`, and
`.github/workflows/release-desktop.yml`:

| Fact | Value | Notes |
|---|---|---|
| `productName` | `Zintus` | |
| `version` | `0.2.0` | Matches `package.json` **and** `Cargo.toml` ✅ (all three must stay in lockstep). |
| `identifier` | `app.zintus.desktop` | Present and valid — **not** empty. |
| `bundle.targets` | `"all"` | → macOS `app`+`dmg`, Windows `nsis`+`msi`, Linux `deb`+`rpm`+`appimage`. |
| `bundle.publisher` | `YS Ventures LLC` | |
| `bundle.icon` | `32x32.png, 128x128.png, 128x128@2x.png, icon.icns, icon.ico` | **Multi-resolution but low-fidelity placeholders** (updated 2026-06-26: `icon.icns` ~12.6 KB, `icon.ico` = 6 sizes incl. 16/32 px ~2 KB — no longer single-size stubs, but tiny/low-detail). Still regenerate from a real 1024² master before any public release (see §1). |
| `bundle.createUpdaterArtifacts` | `false` | Auto-update fully OFF. |
| `plugins.updater` block | **absent** | `tauri-plugin-updater` is compiled in (`Cargo.toml`) + granted (`updater:default`) + registered (`lib.rs`), but inert without endpoints/pubkey. |
| `bundle.macOS` block | **absent** | No `signingIdentity`/`entitlements`/`hardenedRuntime`/`minimumSystemVersion` set → Tauri defaults + env-supplied identity apply (see §2). |
| `bundle.windows.signCommand` | **absent** | ⚠️ Windows ships **UNSIGNED** even though `AZURE_*` env is wired (see §3.2). |
| App menu / shortcuts | `Cmd/Ctrl+Enter` (send) + ⌘N/⌘,/⌘⇧F **frontend keydowns** (`AppShell.tsx:64-83`) | **No native Tauri menu** (`lib.rs` has no `MenuBuilder`); the JS shortcuts exist but ⌘⇧F "Find" is a **stub** that just navigates to `/chat` (no search). Corrected 2026-06-26 — prior "not present" was wrong (see §2.6). |
| CSP `connect-src` | `localhost:8787` + `localhost:8788` + provider hosts | Local gateway + direct provider domains; no `api.anthropic.com`/`api.openai.com` (those route through the gateway). |
| CI matrix | `universal-apple-darwin` / `x86_64-pc-windows-msvc` / `x86_64-unknown-linux-gnu` | macOS is **universal** (Intel + Apple Silicon). No arm64 Windows, no aarch64 Linux. |

### Pre-flight (every release) ✅ CI-checkable

```bash
# 1. Bump the version in ALL THREE (DESKTOP.md: they must match) before tagging:
#    apps/desktop/src-tauri/tauri.conf.json -> "version"
#    apps/desktop/package.json              -> "version"
#    apps/desktop/src-tauri/Cargo.toml      -> version
# 2. Sanity build the frontend + typecheck (the CI does this first too):
cd apps/desktop
bun install
bun run typecheck          # 0 errors (DESKTOP.md "when you're done")
bun run build              # next build -> ../out (frontendDist)
# 3. Local native dry build (unsigned) to catch bundler errors early:
bun run tauri build        # uses bundle.targets="all" for the host OS
```

The tag drives everything else:

```bash
git tag desktop-v0.2.0 && git push origin desktop-v0.2.0   # tag MUST equal version, desktop-v prefix
```

---

## 1. App icons — replace placeholders with a real 1024² set 🔑 [HUMAN] (asset), ✅ CI (generation)

The five icons currently in `src-tauri/icons/` are byte-tiny placeholders and
**must not** ship. Provide one square **1024×1024 PNG** master
(`icon-1024.png`, no alpha-channel surprises) and regenerate.

**Fastest path — Tauri's generator** (writes the whole cross-platform set,
incl. a multi-resolution `.icns` and `.ico`, into `src-tauri/icons/`):

```bash
cd apps/desktop
bun run tauri icon path/to/icon-1024.png
```

**Manual macOS `.icns` (what `tauri icon` does under the hood)** — required
sizes per Apple's iconset convention, built with `sips` + `iconutil`:

```bash
mkdir Zintus.iconset
sips -z 16 16     icon-1024.png --out Zintus.iconset/icon_16x16.png
sips -z 32 32     icon-1024.png --out Zintus.iconset/icon_16x16@2x.png
sips -z 32 32     icon-1024.png --out Zintus.iconset/icon_32x32.png
sips -z 64 64     icon-1024.png --out Zintus.iconset/icon_32x32@2x.png
sips -z 128 128   icon-1024.png --out Zintus.iconset/icon_128x128.png
sips -z 256 256   icon-1024.png --out Zintus.iconset/icon_128x128@2x.png
sips -z 256 256   icon-1024.png --out Zintus.iconset/icon_256x256.png
sips -z 512 512   icon-1024.png --out Zintus.iconset/icon_256x256@2x.png
sips -z 512 512   icon-1024.png --out Zintus.iconset/icon_512x512.png
cp                icon-1024.png      Zintus.iconset/icon_512x512@2x.png
iconutil -c icns Zintus.iconset -o src-tauri/icons/icon.icns
```

**Windows `.ico`** must be **multi-size** — Microsoft's minimum set is
**16, 24, 32, 48, 256** (256 px stored as PNG inside the `.ico`); the
high-DPI set adds 20/40/60 and 72. `tauri icon` produces this; a 321-byte
single-size `.ico` (current state) will look broken at taskbar/Explorer DPIs.

- [ ] 🔑 1024² master committed and `bun run tauri icon` re-run.
- [ ] Verify the generated `.icns`/`.ico` are now hundreds of KB, not bytes.

---

## 2. macOS — Developer ID, notarized direct download

Target: `.dmg` + `.app` for direct download via GitHub Releases (Mac App Store
is **out of scope / Phase 2** per `store/mac-distribution.md`).

### 2.1 One-time prerequisites 🔑 [HUMAN]
- [ ] Apple Developer Program membership ($99/yr).
- [ ] **Developer ID Application** certificate created; export `.p12`.
- [ ] App Store Connect **API key** (`.p8` + key id + issuer id) **or** an
      app-specific password for `notarytool` auth (API key preferred).
- [ ] Add secrets so `tauri-action` signs unattended (names in `SECRETS.md`):
      `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`,
      `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` (→ `APPLE_PASSWORD`), `APPLE_TEAM_ID`.
      Base64 the cert: `openssl base64 -A -in cert.p12`.

### 2.2 What Tauri does automatically (once the cert env exists) ✅
With `APPLE_SIGNING_IDENTITY` + cert env present, `tauri build` /
`tauri-action`:
1. **Code-signs** the `.app` with the Developer ID Application identity and
   applies **Hardened Runtime** + a default entitlements set sufficient for the
   WebView (Tauri does this automatically for Developer ID signing — you only
   add `bundle.macOS.entitlements` for *extra* entitlements).
2. **Notarizes** via `notarytool submit … --wait` (Tauri uses `notarytool`;
   `altool` was retired Nov 1 2023).
3. **Staples** the ticket (`stapler`) unless `--skip-stapling` is passed.

> The repo sets **no** `bundle.macOS` block, so signing identity comes purely
> from the `APPLE_SIGNING_IDENTITY` env, and Hardened Runtime / min-version /
> entitlements use Tauri defaults (default min macOS 10.13). That's fine for
> Developer ID; add a `bundle.macOS.entitlements` plist only if the embedded
> terminal/PTY or any native API trips a hardened-runtime denial.

### 2.3 Manual signing/notarization (if you ever sign a local build) 🔑 [HUMAN]

```bash
# 1. Sign with Hardened Runtime (Tauri does this in CI; manual form shown):
codesign --force --deep --options runtime --timestamp \
  --sign "Developer ID Application: YS Ventures LLC (TEAMID)" \
  src-tauri/target/universal-apple-darwin/release/bundle/macos/Zintus.app
# 2. Notarize the .dmg and WAIT for Apple's verdict:
xcrun notarytool submit \
  src-tauri/target/universal-apple-darwin/release/bundle/dmg/Zintus_0.2.0_universal.dmg \
  --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD" \
  --wait
# 3. Staple so Gatekeeper verifies OFFLINE:
xcrun stapler staple src-tauri/target/.../dmg/Zintus_0.2.0_universal.dmg
```

### 2.4 Verify signature + notarization 🔑 [HUMAN]

```bash
codesign --verify --deep --strict --verbose=2 Zintus.app   # "valid on disk"
codesign -d --entitlements - Zintus.app                    # confirm runtime/entitlements
spctl --assess --type execute --verbose=2 Zintus.app       # "accepted, source=Notarized Developer ID"
xcrun stapler validate Zintus_0.2.0_universal.dmg          # "The validate action worked!"
```

### 2.5 Gatekeeper clean-machine test 🖥️ [HUMAN-device]
- [ ] On a Mac that has **never** seen the app, download the `.dmg` *through a
      browser* (so the quarantine xattr is set), open it, drag to /Applications,
      launch. **No** "developer cannot be verified" / "damaged" warning.
- [ ] `xattr -p com.apple.quarantine Zintus.app` shows the flag was cleared by
      Gatekeeper after first launch (proves the staple worked).
- [ ] DMG install test: window opens with the /Applications drag target; app
      runs from /Applications, not just from the mounted image.

### 2.6 App menu + keyboard shortcuts
Tauri v2 **auto-applies a default macOS menu** (`enable_macos_default_menu`
defaults to `true`), so today you already get: **App menu** (About, Services,
Hide / Hide Others / Show All, **Quit ⌘Q**), **Edit** (Undo/Redo/Cut/Copy/Paste/
Select All), **Window** (Minimize, Zoom, **Close ⌘W**), View, Help. `lib.rs`
sets **no** custom menu, so those are the *only* items.

**Native menu not implemented** — these exist as frontend `keydown` handlers
(`AppShell.tsx:64-83`) but have **no native `MenuBuilder` items in `lib.rs`**, and
⌘⇧F "Find" is a stub (navigates to `/chat`, no search). To build: native menu +
a real Find:

| Shortcut | Action | Status |
|---|---|---|
| ⌘N | New chat | 🟡 present as a **frontend keydown** (`AppShell.tsx:64-83`), **not** a native menu item |
| ⌘⇧F | Find / search | ⚠️ keydown exists but is a **stub** — just navigates to `/chat`, no search UI; no native menu item |
| ⌘, | Preferences/Settings | 🟡 present as a **frontend keydown**, **not** a native menu item (macOS-conventional Preferences menu still absent) |
| ⌘W | Close window | ✅ provided by default Window menu |
| ⌘Q | Quit | ✅ provided by default App menu |
| ⌘↵ | Send message | ✅ implemented (`ChatPanel.tsx`) |

- [ ] Decide before GA: add `New`/`Find`/`Preferences` items + accelerators, or
      explicitly defer. macOS reviewers/users expect at least a Preferences (⌘,).

### macOS gate
- [ ] 🔑 Signed (Developer ID) + notarized + stapled, verified by §2.4.
- [ ] 🖥️ Clean-Mac Gatekeeper + DMG install pass (§2.5).
- [ ] Menu/shortcut decision recorded (§2.6).

---

## 3. Windows — Authenticode-signed MSI + EXE

`bundle.targets="all"` → on Windows this produces **MSI** (WiX) **and** **NSIS**
`.exe`. Both currently ship **unsigned**.

### 3.1 Multi-size icon
- [ ] `icon.ico` regenerated per §1 (16/24/32/48/256) — verify the taskbar,
      Start-menu, Alt-Tab, and Explorer (large-icons view) renders are crisp at
      100 %, 150 %, and 200 % display scaling. 🖥️ [HUMAN-device]

### 3.2 Authenticode signing — the real blocker 🔑 [HUMAN]
The workflow passes `AZURE_CLIENT_ID/SECRET/TENANT_ID`, **but Tauri will not
sign until `bundle.windows.signCommand` exists** — passing env alone does
nothing. Pick ONE:

**(a) Azure Trusted Signing (a.k.a. Artifact Signing)** — Microsoft's
recommended non-Store path (~$10/mo, no hardware token, CI-native):
```jsonc
// tauri.conf.json -> bundle.windows
"signCommand": "trusted-signing-cli -e https://wus2.codesigning.azure.net -a <Account> -c <Profile> -d Zintus %1"
```

**(b) Traditional OV `.pfx` via signtool:**
```jsonc
// tauri.conf.json -> bundle.windows
"signCommand": "signtool sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 /f cert.pfx /p <pw> %1"
```
…and add `WINDOWS_CERTIFICATE` / `WINDOWS_CERTIFICATE_PASSWORD` secrets.

Verify after signing 🔑:
```powershell
signtool verify /pa /v .\Zintus_0.2.0_x64_en-US.msi
Get-AuthenticodeSignature .\Zintus_0.2.0_x64-setup.exe   # Status: Valid
```

### 3.3 SmartScreen reality — signing ≠ instant trust
Per Microsoft (smartscreen-reputation, updated 2026-05): a **newly signed**
binary can still show **"Windows protected your PC"** until its file-hash /
publisher-certificate reputation accrues — there is no submit-for-review path
for consumer endpoints; reputation builds **organically over download volume**
(weeks, hundreds of clean installs). **EV no longer bypasses SmartScreen**
(behavior removed years ago) — OV is sufficient; don't pay the EV premium to
"skip" the warning. On Windows 11, **Smart App Control** may block *unsigned*
binaries outright. Document this expectation on `/download` ("beta") and plan
the **Microsoft Store** as the later path that fully avoids the warning
(Store-distributed apps are re-signed by Microsoft).
- [ ] `/download` copy honest about first-run SmartScreen for signed-but-new builds.
- [ ] Microsoft Store tracked as a Phase-2 option (not required for direct download).

### 3.4 Keyring (Credential Manager)
The Rust `keyring` crate is built with `windows-native` → secrets land in the
**Windows Credential Manager** under service `com.zintus.desktop`.
- [ ] 🖥️ Save a provider key in-app; confirm it appears in *Credential Manager →
      Windows Credentials* and survives an app restart; deleting in-app removes it.

### 3.5 Network / local gateway + firewall
The webview connects to the local gateway (`localhost:8787/8788`, allowed by
CSP). The desktop app is a **client**, not a listening server, so it should not
trigger the inbound Windows Defender Firewall prompt; the gateway (`zintus
serve`, separate process) is what listens.
- [ ] 🖥️ Confirm chat reaches a running local gateway with the firewall at
      defaults; if a prompt appears, confirm it's the gateway process, and that
      "Gateway offline — run `zintus serve`" shows when it isn't running.

### 3.6 Install / uninstall / shell integration 🖥️ [HUMAN-device]
- [ ] MSI and NSIS each install to *Program Files*, create Start-menu +
      (optional) desktop shortcuts with the new icon, and launch.
- [ ] Uninstall via *Settings → Apps* (and NSIS uninstaller) removes binaries +
      shortcuts; confirm leftover behavior for the keyring entry is intentional.
- [ ] Pin to taskbar — icon crisp at high DPI.
- [ ] Crash/log location noted for support: app logs under
      `%APPDATA%\app.zintus.desktop\` (Tauri identifier dir); WebView2 crash
      dumps under the user's `%LOCALAPPDATA%`. Verify the actual paths on-device.

### Windows gate
- [ ] 🔑 `signCommand` added + Authenticode signature valid (§3.2).
- [ ] 🖥️ Install/uninstall/keyring/firewall/DPI-icon checks pass.
- [ ] SmartScreen expectation documented (§3.3).

---

## 4. Linux — AppImage + .deb + .rpm

`bundle.targets="all"` → on Linux produces **`.AppImage` + `.deb` + `.rpm`**.
No code-signing/notarization concept; direct download from Releases.

### 4.1 Build dependencies (Tauri v2 = WebKitGTK **4.1**)
CI installs `libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf`
on `ubuntu-latest`. Build on the **oldest** base you intend to support (Ubuntu
22.04 / Debian 12 ship WebKitGTK 4.1) to keep the glibc floor low — building on
a newer base raises the minimum glibc of the artifact.
- [ ] Runtime dep documented for users: **WebKitGTK 4.1** (`libwebkit2gtk-4.1-0`)
      must be present; `.deb`/`.rpm` declare it, AppImage users may need it
      installed. AppImage also needs **FUSE** (`libfuse2`) on some distros.

### 4.2 `.desktop` entry + icon integration
- [ ] `.deb`/`.rpm` install a `app.zintus.desktop.desktop` launcher + hicolor
      icons; Zintus appears in the GNOME/KDE app grid with the real icon (after
      §1). 🖥️ [HUMAN-device]

### 4.3 Install / uninstall tests 🖥️ [HUMAN-device]
```bash
# Debian/Ubuntu
sudo apt install ./Zintus_0.2.0_amd64.deb   && zintus   # launches; then:
sudo apt remove zintus
# Fedora/RHEL
sudo dnf install ./Zintus-0.2.0-1.x86_64.rpm && zintus
sudo dnf remove zintus
# AppImage (no install)
chmod +x Zintus_0.2.0_amd64.AppImage && ./Zintus_0.2.0_amd64.AppImage
```

### 4.4 Keyring (Secret Service)
Built with `sync-secret-service` → keys go to the **Secret Service**
(GNOME Keyring / KWallet) via D-Bus.
- [ ] 🖥️ A Secret Service provider must be running + unlocked; save a key,
      confirm via `secret-tool search service com.zintus.desktop`, restart, key
      persists. On a headless/minimal session with no keyring daemon, confirm the
      app degrades with a clear error rather than crashing.

### 4.5 Display server (Wayland + X11) + terminal/PTY 🖥️ [HUMAN-device]
- [ ] Launch under **Wayland** and under **X11/XWayland**; window, input, and
      HiDPI scaling work in both.
- [ ] Embedded terminal (`tauri-plugin-pty`, `default_shell` → `$SHELL` or
      `/bin/bash`) opens a working shell on each distro.

### 4.6 Auto-update decision
- [ ] Confirmed OFF for Linux too (`createUpdaterArtifacts: false`, no
      `plugins.updater`). AppImage self-update / distro repos are **deferred**;
      users re-download from Releases. Record this as a deliberate decision, not a
      gap. (Enabling later is a one-time `tauri signer generate` + `plugins.updater`
      block + secrets — see `DESKTOP.md`; don't flip on without a real pubkey.)

### 4.7 Distro caveats / acceptance
- [ ] **Ubuntu 22.04/24.04 LTS** (`.deb`) — primary target, launches + chats.
- [ ] **Fedora (current)** (`.rpm`) — launches + chats.
- [ ] **Arch / generic** via **AppImage** — launches (with FUSE present).
- [ ] Note WebKitGTK availability differs per distro/version; the AppImage is the
      fallback for distros without 4.1 packaged.

### Linux gate
- [ ] 🖥️ Launches on Ubuntu LTS **and** Fedora **and** one Arch/AppImage host.
- [ ] Secret Service + PTY + Wayland/X11 verified.

---

## 5. Final verification matrix

| Gate | Command / action | Who runs it |
|---|---|---|
| Versions in lockstep | grep `version` in the 3 files match the `desktop-v*` tag | ✅ CI (assertable) |
| Frontend typecheck | `cd apps/desktop && bun run typecheck` | ✅ CI |
| Frontend build | `bun run build` (→ `../out`) | ✅ CI |
| Native bundles build (all 3 OS) | `tauri-action --target <triple>` (matrix) | ✅ CI |
| Real icons present | `tauri icon icon-1024.png`; assert `.icns`/`.ico` size » 1 KB | 🔑 [HUMAN] asset, ✅ CI check |
| macOS signed | `codesign --verify --deep --strict Zintus.app` | 🔑 [HUMAN] (needs Developer ID cert) |
| macOS notarized+stapled | `xcrun stapler validate …dmg`; `spctl --assess --type execute` | 🔑 [HUMAN] |
| macOS Gatekeeper clean-machine | download via browser → open on a fresh Mac, no warning | 🖥️ [HUMAN-device] |
| Windows `signCommand` set | grep `bundle.windows.signCommand` in `tauri.conf.json` | ✅ CI check; 🔑 cert to actually sign |
| Windows signed | `signtool verify /pa Zintus…msi` → Valid | 🔑 [HUMAN] (needs Authenticode cert) |
| Windows install/uninstall/DPI/keyring | manual on a clean Windows VM | 🖥️ [HUMAN-device] |
| Linux install/remove (deb+rpm) | `apt install/remove`, `dnf install/remove` | 🖥️ [HUMAN-device] |
| Linux AppImage launch | `chmod +x … && ./…AppImage` (FUSE present) | 🖥️ [HUMAN-device] |
| Linux Secret Service | `secret-tool search service com.zintus.desktop` | 🖥️ [HUMAN-device] |
| Updater stays OFF | grep `createUpdaterArtifacts: false`, no `plugins.updater` | ✅ CI check |

**Bottom line:** everything through *unsigned cross-OS bundles* is automatable
and runs in CI today. Everything that makes a build *trustworthy and
installable without scary warnings* — Developer ID signing/notarization
(macOS), Authenticode `signCommand`+cert (Windows), and clean-machine install
verification (all three) — is **🔑/🖥️ [HUMAN]** and blocked on certs/accounts/
devices the sandbox does not have.

---

## Sources (accessed 2026-06-26)

- Tauri v2 — macOS code signing: https://v2.tauri.app/distribute/sign/macos/
- Tauri v2 — Windows code signing (`signCommand`, Trusted Signing): https://v2.tauri.app/distribute/sign/windows/
- Tauri v2 — macOS Application Bundle (entitlements/hardenedRuntime/minimumSystemVersion): https://v2.tauri.app/distribute/macos-application-bundle/
- Tauri v2 — Distribute overview + bundle targets: https://v2.tauri.app/distribute/
- Tauri v2 — Configuration reference (bundle targets `["deb","rpm","appimage","nsis","msi","app","dmg"]` or `"all"`): https://v2.tauri.app/reference/config/
- Tauri v2 — Window Menu / default menu (`enable_macos_default_menu`, predefined items): https://v2.tauri.app/learn/window-menu/
- Tauri v2 — Linux prerequisites (WebKitGTK 4.1): https://v2.tauri.app/start/prerequisites/
- Tauri v2 — AppImage / Debian / RPM: https://v2.tauri.app/distribute/appimage/ , https://v2.tauri.app/distribute/debian/ , https://v2.tauri.app/distribute/rpm/
- Apple — Notarizing macOS software before distribution: https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution
- Apple — Customizing the notarization workflow (`notarytool` / `stapler`): https://developer.apple.com/documentation/security/customizing-the-notarization-workflow
- Apple — Signing Mac software with Developer ID: https://developer.apple.com/developer-id/
- Microsoft — SmartScreen reputation for Windows app developers (updated 2026-05-04; EV no longer bypasses, reputation by download volume, Smart App Control): https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation
- Microsoft — Construct your Windows app's icon (multi-size `.ico`): https://learn.microsoft.com/en-us/windows/apps/design/iconography/app-icon-construction
- Microsoft — Icons design basics (16/24/32/48/256): https://learn.microsoft.com/en-us/windows/win32/uxguide/vis-icons
- Azure — Trusted Signing: https://learn.microsoft.com/en-us/azure/trusted-signing/
</content>
</invoke>
