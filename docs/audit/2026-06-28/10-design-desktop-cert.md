# DESIGN + RUNBOOK — Desktop: code-fixed → runtime-certified & signed

Date: 2026-06-28 · Branch: `feat/multimodal-image-input` @ `6bcd097` · Scope: `apps/desktop`
Status of input: keyring frontend CODE-fixed (`d0d4e27`), `tauri.test.ts` wired (`6bcd097`).
**Nothing below has been certified by an actual Tauri/Rust build on any OS.** This doc is
the plan to get there.

---

## 0. Where the code actually stands today (verified this session)

| Concern | State in source | File:line |
|---|---|---|
| Keyring JS path | Now calls `invoke("keyring_get/set/delete")`, snake→camel arg map | `apps/desktop/lib/tauri.ts:24-65` |
| Keyring Rust cmds | `keyring_get/set/delete` exist, registered in `invoke_handler` | `apps/desktop/src-tauri/src/lib.rs:18-41,68-73` |
| Service name (desktop) | `const SERVICE = "zintus"` | `apps/desktop/src-tauri/src/lib.rs:12` |
| Service name (gateway/CLI) | `const SERVICE = "zintus"` | `packages/keychain/src/storage.ts:6` |
| **Service names MATCH** | ✅ both `"zintus"`, both keyed by provider id | — |
| Keyring crate (desktop) | `keyring v3` `apple-native,windows-native,sync-secret-service` | `apps/desktop/src-tauri/Cargo.toml:17` |
| Keyring crate (gateway) | `@napi-rs/keyring ^1.3.0` (wraps an OLDER keyring-rs) | `packages/keychain/package.json:16` |
| Capability grant | `["core:default","pty:default","updater:default"]` — **no keyring perm needed** (custom `#[tauri::command]`s are allowed by `core:default`'s invoke, not a plugin permission) | `apps/desktop/src-tauri/capabilities/default.json:6` |
| Capability identifier | `com.zintus.desktop` (capability file id, NOT the keychain service — unrelated) | `capabilities/default.json:3` |
| Bundle identifier | `app.zintus.desktop` | `tauri.conf.json:5` |
| Native menu | **None** — no `MenuBuilder` in `lib.rs`; macOS gets Tauri's auto default menu only | `lib.rs` (absent) |
| Find (⌘⇧F) | Fake — `router.push("/chat")`, no search UI | `app/_components/AppShell.tsx:75-79` |
| ⌘N / ⌘, shortcuts | JS keydown handlers (work, but not native menu items) | `AppShell.tsx:64-83` |
| Export (chat) | `Blob`+`a.download` — unverified in WKWebView/WebKitGTK | `app/_components/ChatPanel.tsx:218-233` |
| Export (research) | `Blob`+`a.download` — same risk | `app/research/page.tsx:101-111` |
| PTY | `tauri-plugin-pty` + Rust `default_shell()` | `TerminalPane.tsx:83-108`, `lib.rs:47-61` |
| Updater | plugin compiled+registered, **no `plugins.updater` block**, `createUpdaterArtifacts:false`, no JS caller → inert | `lib.rs:67`, `tauri.conf.json:38`, `Cargo.toml:21` |
| Gateway token in bundle | build-time `NEXT_PUBLIC_GATEWAY_TOKEN` only (no in-app UI) | `lib/gateway.ts:5` |
| key→gateway "sync" | **Does not exist as network code** — and does not NEED to: both sides read the SAME OS keychain entry. The STORE-READINESS x25519-relay claim is fiction. | (no such file) |
| Gateway CORS for desktop | `tauri://localhost`, `http(s)://tauri.localhost` allow-listed in loopback mode; PNA `Allow-Private-Network:true` for allow-listed origins | `apps/gateway/src/auth.ts:46-52,89-100`, `route-options.test.ts:337-384` |
| CSP connect-src | `localhost:8787/8788` + 9 provider hosts (provider hosts vestigial — desktop only calls gateway) | `tauri.conf.json:24` |
| Icons | `icon.icns` 12.6 KB, `icon.ico` 1981 B, `32x32.png` 104 B — below a real multi-res bar | `src-tauri/icons/` |
| Release CI | `release-desktop.yml` builds all 3 OSes on `desktop-v*` tags, signing env wired (secrets-gated) | `.github/workflows/release-desktop.yml` |
| PR CI for desktop | `apps` job only `typecheck`s; `build-apps` only does **Next.js** build — **no Rust/Tauri compile on PRs** | `.github/workflows/ci.yml:108-135,207-230` |

### The single most important uncertified claim
`lib/tauri.ts:3-11` and `lib.rs:5-12` both assert that a key written by the desktop
Rust `keyring v3` Entry lands in the **exact** OS-keychain entry the gateway reads via
`@napi-rs/keyring ^1.3.0`. The service string matches (`"zintus"`) and the account is the
provider id on both sides. **But the two crates are different implementations at different
major versions.** Whether they produce byte-compatible credential records is an
implementation detail that varies per OS and can ONLY be proven by a real
desktop-write → gateway-read round-trip on each OS (see §5, RISK-1). This is the
load-bearing certification of the whole desktop standalone story.

---

## 1. Certification ladder (what each rung requires)

```
R0  code-fixed              ← we are here (TS compiles, tauri.test.ts green)
R1  compiles native         ← cargo/tauri build succeeds per OS (needs Rust toolchain on that OS)
R2  runs                    ← bundle launches, webview loads, gateway health OK
R3  keyring round-trips     ← set→restart→get in the SAME process (desktop only)
R4  cross-crate interop     ← desktop write → gateway READ the same key (THE proof)  [RISK-1]
R5  feature-certified       ← menu, Find, export, PTY, updater, CSP/PNA all pass
R6  signed                  ← Gatekeeper/SmartScreen/Linux acceptance  [HUMAN certs]
R7  shipped                 ← tagged release, clean-machine install passes
```
R1–R5 are **per-OS and per-toolchain**: a green macOS build certifies nothing on
Windows/Linux. R0 (current) tells us nothing about R1+.

---

## 2. PER-OS BUILD & RUNTIME-CERTIFICATION RUNBOOK

Common preconditions (any OS):
- Rust ≥ 1.77.2 (`Cargo.toml:7`), Bun, repo `bun install` at root.
- A running gateway with keys reachable: `zintus serve` (default `http://localhost:8788`,
  `lib/gateway.ts:3`). For the R4 interop test the gateway MUST run on the SAME machine and
  SAME user account as the desktop app (shared OS keychain).
- Build commands run from `apps/desktop`. `tauri build` runs `bun run build` first via
  `beforeBuildCommand` (`tauri.conf.json:9`).

Each section lists: build → launch → the pass/fail checks. Mark each check P/F; any F blocks
that OS at the named rung.

### 2A. macOS (Apple silicon + Intel; ship universal)

Build:
```bash
cd apps/desktop
rustup target add aarch64-apple-darwin x86_64-apple-darwin
bun run build                       # Next static export → ../out
bun tauri build --target universal-apple-darwin
# artifacts: src-tauri/target/universal-apple-darwin/release/bundle/{macos/Zintus.app,dmg/*.dmg}
```
Launch: open `Zintus.app` (first run on the build machine; Gatekeeper bypass via right-click
→ Open while unsigned).

Checks:
| # | Check | How | Pass |
|---|---|---|---|
| M-R1 | native compile | build exits 0, `.app`+`.dmg` produced | both present |
| M-R2 | launches + webview | app window opens, nav renders, no white screen | UI visible |
| M-R2b | gateway health | with `zintus serve` up, header shows online (no "Gateway offline" banner `AppShell.tsx:157`) | online |
| M-R3 | keyring set/get round-trip | Providers screen (`ProvidersScreen.tsx:80-85`): enter a key for e.g. `groq`, Save → row shows "Key configured" (`:160`); **quit + relaunch** → still "Key configured" | persists across restart |
| M-R4 | **key→gateway interop** | after M-R3, in the SAME user session run `zintus keys list` (CLI reads `packages/keychain`) → the provider appears; then send a chat in-app through that provider and get a real completion | CLI sees key AND chat works |
| M-R5a | native menu | menubar has App/File/Edit/View/Window with working items (post-fix §3) | items fire |
| M-R5b | Find | ⌘⇧F opens a real in-app search, not a chat redirect | search UI |
| M-R5c | export | Chat "Export" (`ChatPanel.tsx:218`) writes a readable `.md` to disk via a real save dialog | file on disk |
| M-R5d | PTY | Terminal tab spawns `$SHELL` (`lib.rs:55`), accepts input, echoes output | live shell |
| M-R5e | CSP/PNA | DevTools console clean of CSP violations; chat POST to gateway succeeds (origin `tauri://localhost` accepted, `auth.ts:50`) | no CSP errors, 200 |
| M-R5f | updater | inert by design — assert no update prompt and no network call to a feed | silent |
| M-R6 | signed | see §4A (Developer ID + notarytool); `spctl -a -vv Zintus.app` → "accepted, source=Notarized Developer ID" | accepted |

### 2B. Windows (x86_64-pc-windows-msvc)

Build (on a Windows host — cross-compile from mac is not supported for this stack):
```powershell
cd apps/desktop
bun run build
bun tauri build --target x86_64-pc-windows-msvc
# artifacts: src-tauri\target\x86_64-pc-windows-msvc\release\bundle\{msi\*.msi, nsis\*-setup.exe}
```
Launch: run the `.msi` (or NSIS `-setup.exe`) installer on a CLEAN Windows VM, then start
Zintus from the Start menu.

Checks (same rung meanings):
| # | Check | Windows specifics | Pass |
|---|---|---|---|
| W-R1 | compile | MSVC build toolchain + WebView2 present; `.msi` and `.exe` produced | both present |
| W-R2 | launch | WebView2 runtime auto-bootstrapped or present; window renders | UI visible |
| W-R3 | keyring | key stored in **Windows Credential Manager**; persists across relaunch | persists |
| W-R4 | **interop** | `zintus keys list` on the SAME Windows user sees the desktop-written key; chat works. **Highest interop risk OS** — keyring-rs v3 vs @napi-rs v1 credential target-naming on Credential Manager differs by version. | CLI sees key AND chat works |
| W-R5a | menu | Windows has no global menubar — confirm in-window menu or the ⌘/Ctrl shortcuts (`AppShell.tsx:64-83`) work; Find non-fake | works |
| W-R5d | PTY | spawns `%COMSPEC%`→fallback `powershell.exe` (`lib.rs:51`) | live shell |
| W-R5c | export | save dialog writes `.md` | file on disk |
| W-R5e | CSP/PNA | chat POST to gateway 200; origin accepted | 200 |
| W-R6 | signed | §4B Authenticode; **SmartScreen** does not hard-block; `signtool verify /pa` passes | verified, no block |

### 2C. Linux (x86_64-unknown-linux-gnu)

Build (needs WebKitGTK 4.1; matches CI deps `release-desktop.yml:36-40`):
```bash
sudo apt-get install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf
cd apps/desktop
bun run build
bun tauri build --target x86_64-unknown-linux-gnu
# artifacts: target/.../bundle/{deb/*.deb, rpm/*.rpm, appimage/*.AppImage}
```
Launch: AppImage needs FUSE (`./Zintus_*.AppImage`) or install the `.deb`. A **Secret Service**
(gnome-keyring/KWallet) must be running for the keyring; headless has none.

Checks:
| # | Check | Linux specifics | Pass |
|---|---|---|---|
| L-R1 | compile | WebKitGTK 4.1 present; deb/rpm/AppImage produced | all present |
| L-R2 | launch | AppImage runs (FUSE) / `.deb` installs and runs | UI visible |
| L-R3 | keyring | Secret Service running → set/get/restart persists | persists |
| L-R4 | **interop** | gateway uses `@napi-rs/keyring` `sync` Secret Service; desktop uses keyring v3 `sync-secret-service` (`Cargo.toml:17`). **Attribute-schema compatibility on Secret Service is the #1 Linux risk** — a key written by one may not be found by the other if collection/attributes differ. Round-trip desktop-write → `zintus keys list`. | CLI sees the EXACT key |
| L-R3b | no Secret Service | with no keyring daemon, expect `keyring_set` to error and the UI to surface it (not crash); gateway then falls back to in-memory with a warning (`storage.ts:46-55`) | graceful error |
| L-R5d | PTY | spawns `$SHELL`→`/bin/bash` (`lib.rs:59`) | live shell |
| L-R5c | export | save dialog / GTK file chooser writes `.md` | file on disk |
| L-R5e | CSP/PNA | chat 200; WebKitGTK enforces CSP — check for console violations | 200, clean |
| L-R6 | signed | §4C — no OS notarization; ship checksums + (optional) GPG-signed AppImage | checksums published |

---

## 3. Feature gaps to close BEFORE R5 can pass (codeable now)

These are code changes the audit flagged; they don't need the toolchain to WRITE, but their
certification (R5) needs it.

### 3.1 Native menu — `src-tauri/src/lib.rs`
Add a `Menu` built with `tauri::menu::{MenuBuilder, SubmenuBuilder, MenuItem, PredefinedMenuItem}`
in `run()` before `.run(...)` (around `lib.rs:64-74`), and an `.on_menu_event` handler that
emits Tauri events the webview listens for (mirror the existing JS shortcuts so menu + keys
agree). Spec (from prior audit, keep it):
- **App**: About, Preferences `⌘,`, Quit `⌘Q`
- **File**: New Chat `⌘N`
- **Edit**: default (Cut/Copy/Paste/SelectAll predefined)
- **View**: Find `⌘⇧F` → emits `menu:find` (real search, see 3.2)
- **Window**: Minimize, Zoom, Close `⌘W`
Wire menu events → webview nav via `app.emit("menu:navigate", path)`; have `AppShell` listen
and route. **Touchpoint:** `lib.rs:64` (insert before `.run`). No new Cargo dep (menu is in core `tauri`).

### 3.2 Real Find — `app/_components/AppShell.tsx:75-79`
Replace the `router.push("/chat")` stub with a command-palette / thread+message search overlay.
Listen for both the JS ⌘⇧F keydown AND the `menu:find` event from 3.1. **Touchpoint:**
`AppShell.tsx:75-79` (the `(e.key === "f"...)` branch) + a new search component.

### 3.3 Export → real filesystem — `ChatPanel.tsx:218-233`, `research/page.tsx:101-111`
`Blob`+`a.download` is unreliable in WKWebView/WebKitGTK. Switch to `@tauri-apps/plugin-dialog`
(`save()`) + `@tauri-apps/plugin-fs` (`writeTextFile`) when `isTauri()`, keep the Blob path as
the browser-dev fallback. **Requires**: add `tauri-plugin-dialog` + `tauri-plugin-fs` to
`Cargo.toml:16-21`, register in `lib.rs:65-67`, and grant `dialog:default` + a scoped
`fs:allow-write-text-file` in `capabilities/default.json:6`. **Touchpoints:**
`Cargo.toml:21` (append deps), `lib.rs:66` (append `.plugin(...)`), `capabilities/default.json:6`
(append perms), `ChatPanel.tsx:218`, `research/page.tsx:101`.

### 3.4 Updater — decide explicitly
Current inert-by-design is honest. Two options:
- **(a) Keep off, remove dead weight:** drop `tauri-plugin-updater` (`Cargo.toml:21`), the
  `.plugin(tauri_plugin_updater::...)` line (`lib.rs:67`), and `"updater:default"`
  (`capabilities/default.json:6`). Smaller binary, nothing to certify.
- **(b) Turn on (post-signing only):** follow `DESKTOP.md:78-90` — `signer generate`, add a
  `plugins.updater` block to `tauri.conf.json`, flip `createUpdaterArtifacts:true`
  (`tauri.conf.json:38`), add `TAURI_SIGNING_*` secrets. CI already gates `latest.json` on the
  secret (`release-desktop.yml:87`). **Do (a) for first signed release; (b) is a follow-up.**

### 3.5 Icons (R6 polish) — `src-tauri/icons/`
Regenerate from one 1024² master: `bun tauri icon path/to/icon-1024.png`. Replaces the
undersized `.icns`/`.ico`/`32x32.png`. **Touchpoint:** `src-tauri/icons/*` (regenerated).

### 3.6 CSP cleanup (optional) — `tauri.conf.json:24`
Desktop only calls the gateway (no direct provider fetch in the bundle). The 9 provider hosts
in `connect-src` are vestigial; trimming to `'self' http://localhost:8788 http://localhost:8787`
reduces attack surface. Verify nothing else uses them first. **Touchpoint:** `tauri.conf.json:24`.

---

## 4. SIGNING / NOTARIZATION PLAN

The env plumbing already exists in `release-desktop.yml:46-70`; what's missing is HUMAN certs
+ (Windows) a `signCommand` in config. Marked `[HUMAN]` (accounts/certs, off-repo) vs
`[CODE]` (config/secrets we can wire).

### 4A. macOS — Developer ID + notarytool
- `[HUMAN]` Enroll in Apple Developer Program (YS Ventures LLC), create a **Developer ID
  Application** cert, export `.p12`, create an app-specific password, note the 10-char Team ID.
- `[CODE]` Already mapped in `release-desktop.yml:57-63`: `APPLE_CERTIFICATE`,
  `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`,
  `APPLE_PASSWORD`(←app-specific pw), `APPLE_TEAM_ID`. Add them as repo secrets (`[HUMAN]` enters
  values; mapping is done).
- Result: tauri-action signs the `.app`, builds a signed `.dmg`, and notarizes via notarytool
  + staples. Certify with `spctl -a -vv` (M-R6). **No code change to tauri.conf.json needed for
  macOS** — Tauri reads `APPLE_SIGNING_IDENTITY` from env.

### 4B. Windows — Authenticode (Azure Trusted Signing)
- `[HUMAN]` Stand up Azure Trusted Signing (account, signing profile, cert) → `AZURE_CLIENT_ID`,
  `AZURE_CLIENT_SECRET`, `AZURE_TENANT_ID`. Secrets already referenced
  (`release-desktop.yml:68-70`).
- `[CODE]` **MISSING and required:** add `bundle.windows.signCommand` to `tauri.conf.json`
  invoking the Azure signing tool (`relic`/`trusted-signing-cli`) over the built artifact.
  Without it the `.msi`/`.exe` ship UNSIGNED regardless of the `AZURE_*` secrets (per
  `DESKTOP.md:63-67`). **Touchpoint:** new `bundle.windows.signCommand` in `tauri.conf.json:27-39`.
  Alternative (simpler if you have an OV/EV `.pfx`): classic `signtool` via `certificateThumbprint`
  — but EV certs are `[HUMAN]` hardware-token bound and don't fit headless CI; Trusted Signing is
  the CI-friendly path.
- Certify: `signtool verify /pa` + SmartScreen does not hard-block (W-R6).

### 4C. Linux — no OS notarization
- No Gatekeeper/SmartScreen equivalent. `[CODE]` publish SHA-256 checksums for deb/rpm/AppImage
  alongside the release; optionally GPG-sign the AppImage and `.deb` repo metadata.
- `[HUMAN]` (optional) a GPG release key. Not a launch blocker.

### Updater signing (cross-OS, only if 3.4(b))
`[HUMAN]` run `tauri signer generate`; `[CODE]` add `plugins.updater.pubkey`+`endpoints`,
`createUpdaterArtifacts:true`, secrets `TAURI_SIGNING_PRIVATE_KEY(_PASSWORD)`. Already wired in
CI (`release-desktop.yml:50-53,87`).

---

## 5. CI DESIGN — build + sign on tags, all three OSes

**Good news: it already exists.** `release-desktop.yml` is a 3-OS matrix
(`macos-latest`/`windows-latest`/`ubuntu-latest`, `release-desktop.yml:14-24`), tag-driven on
`desktop-v*`, with every signing secret wired and Linux deps installed. The DESIGN DELTAS:

1. **[CODE] Add the Windows `signCommand`** (§4B) — the one config gap that keeps Windows
   unsigned even with secrets present.
2. **[CODE] Add a Rust/Tauri PR-gate** so R1 regressions are caught BEFORE a tag. Today
   `ci.yml` `build-apps` only does the Next.js build (`ci.yml:222-228`) and the `apps` matrix
   only typechecks (`ci.yml:130-135`) — **a broken `lib.rs` or `Cargo.toml` ships to the tag
   build unseen.** Add a `desktop-native` job (ubuntu, WebKitGTK deps) running
   `cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml` (and `cargo test` for the
   keyring cmds) on PRs. Cheap (no full bundle) and turns R1-Linux into a PR gate.
3. **[CODE] Post-build smoke / artifact assertions** in `release-desktop.yml` after the
   tauri-action step: assert the expected bundle files exist per target, and on macOS run
   `spctl -a -vv` / `codesign --verify` to FAIL the release if signing silently no-op'd (today a
   missing cert just yields an unsigned bundle with a green build — easy to ship unsigned by
   accident).
4. **[HUMAN] Manual clean-machine certification gate** — R2–R5 (launch, keyring round-trip,
   interop, menu/Find/export/PTY) **cannot be automated headlessly** (no Secret Service, no GUI,
   no real keychain in CI). Keep these as a documented manual checklist (this §2) run on a clean
   VM/host per OS before promoting a prerelease to release. CI proves R1+R6-signing; humans prove
   R2–R5+R7.
5. **[CODE] (optional) flip `prerelease:true`→ gated** (`release-desktop.yml:80`) only after the
   manual checklist passes, to keep the public `/download` "beta" copy honest (`DESKTOP.md:18`).

Pipeline shape after deltas:
```
PR:   ci.yml { apps typecheck, build-apps next, + NEW desktop-native cargo check/test }
tag desktop-v*:  release-desktop.yml matrix(mac/win/linux)
                 → bun build → tauri build → sign(secrets) → NEW assert bundles+signing
                 → publish prerelease  →  [HUMAN] §2 manual cert  →  promote
```

---

## 6. RISKS (ranked)

- **RISK-1 (P0, cross-crate keyring interop):** desktop `keyring v3` vs gateway
  `@napi-rs/keyring ^1.3.0` are different implementations at different major versions. Service
  (`"zintus"`) and account (provider id) match, but the on-disk credential record format is
  per-OS and per-version. If they diverge, a desktop-saved key is invisible to the chat path and
  the "standalone" story breaks — **exactly the class of bug `d0d4e27` was meant to kill, just
  one layer deeper.** Only R4 (desktop-write → `zintus keys list`/chat) on EACH OS certifies it.
  Highest residual risk on **Windows** (Credential Manager target naming) and **Linux** (Secret
  Service attribute schema). Mitigation if it fails: pin both sides to the same keyring-rs major,
  or have the gateway read via the desktop's own command, or standardize the entry attributes
  explicitly on both sides.
- **RISK-2 (P0, toolchain-only):** R1–R5 are unproven on every OS. Current green tests
  (`tauri.test.ts`) exercise the JS shim with a mocked `invoke` — they prove argument shape, **not
  that the Rust command runs, that the OS keychain accepts the write, or that the webview renders.**
  Need a real Rust toolchain on each of macOS/Windows/Linux.
- **RISK-3 (P1, export):** `Blob`+`a.download` (`ChatPanel.tsx:226`, `research/page.tsx:104`)
  likely silently no-ops in WKWebView/WebKitGTK. Until 3.3 lands + R5c passes, "Export" may
  appear to work and write nothing.
- **RISK-4 (P1, Windows signing config):** secrets are wired but `signCommand` is absent
  (`tauri.conf.json` has no `bundle.windows.signCommand`) → Windows ships UNSIGNED even with all
  `AZURE_*` set, and the green build hides it. §5-delta-3 (assert signing) is the guardrail.
- **RISK-5 (P1, no PR-level native gate):** a `lib.rs`/`Cargo.toml` break only surfaces at the
  tag build (`ci.yml` never compiles Rust). §5-delta-2 fixes.
- **RISK-6 (P2, Linux runtime deps):** AppImage needs FUSE; keyring needs a live Secret Service.
  Clean-machine R2/R3 must be on a desktop session, not headless. Document in `/download`.
- **RISK-7 (P2, menu/Find honesty):** until 3.1/3.2 land, the app advertises ⌘⇧F but has no
  search and no native menu — a visible "fake feature" vs Claude/Cursor desktop. Cosmetic but
  launch-credibility relevant.
- **RISK-8 (P2, icons):** undersized `.icns`/`.ico` (§3.5) → blurry app icon, and macOS
  notarization is pickier about malformed icon assets. Regenerate before R6.

---

## 7. Ordered execution checklist

1. `[CODE]` Land feature gaps: native menu (3.1), real Find (3.2), Tauri-fs export (3.3),
   updater decision (3.4a remove), icons (3.5), optional CSP trim (3.6).
2. `[CODE]` Add `desktop-native` PR job (§5-2) + release-time bundle/signing assertions (§5-3).
3. `[HUMAN]` macOS Developer ID + app-specific pw + Team ID → repo secrets (§4A).
4. `[HUMAN]` Azure Trusted Signing creds → secrets; `[CODE]` add `signCommand` (§4B).
5. Build per OS (§2 A/B/C), run R1→R5 manual checklist on clean machines — **R4 interop is the
   gate**.
6. Tag `desktop-v*`, let `release-desktop.yml` build+sign, verify R6 (`spctl`/`signtool`).
7. Run R7 clean-machine install per OS; only then promote off "beta" and update `/download`.

**Bottom line:** the keyring CODE fix and service-name alignment are correct and verified in
source; CI/signing plumbing is ~90% there (one Windows `signCommand` gap). The entire remaining
risk is RUNTIME — and the crux is RISK-1: a real desktop-write → gateway-read round-trip on
macOS, Windows, AND Linux. No amount of TS testing substitutes for it.
