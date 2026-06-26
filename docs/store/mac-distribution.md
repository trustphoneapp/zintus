# macOS Distribution — Direct Download (GitHub Releases)

Distribution plan for the **Zintus desktop** app (`apps/desktop/`, Tauri v2,
`identifier app.zintus.desktop`, `publisher "YS Ventures LLC"`,
`version 0.0.1` from `src-tauri/tauri.conf.json`).

> **Mac App Store (MAS) is OUT OF SCOPE — Phase 2.** Tauri is **not configured
> for MAS** (no App Sandbox entitlements, no MAS provisioning, no `mas` bundle
> target). Current targets: `bundle.targets = "all"` for **direct download via
> GitHub Releases**. MAS would require sandboxing + a separate distribution
> certificate + provisioning profile; revisit in Phase 2.

---

## Current reality (keep this honest)

Per `docs/agents/DESKTOP.md` and `src-tauri/tauri.conf.json`:

- Builds are produced by `.github/workflows/release-desktop.yml` (Tauri,
  macOS/Windows/Linux) and published on **GitHub Releases**.
- The workflow does **Tauri-updater signing only — NOT Apple OS code-signing or
  notarization**. So macOS builds are currently **unsigned beta**: Gatekeeper
  will warn ("cannot be opened because the developer cannot be verified" /
  damaged-app style messages), and the user must right-click → Open or clear the
  quarantine attribute.
- The `/download` web page links the Releases page and says **"beta"** — keep
  that copy honest. **Do not claim "signed" or "notarized" until the steps below
  are actually done.**
- `bundle.updater.active = false`, `pubkey = ""` — auto-update is off until a
  signing keypair is generated (see DESKTOP.md). Don't flip it on without a real
  pubkey.

**Status today: NOT signed, NOT notarized. Direct-download beta only.**

---

## Target state — notarized direct-download (what "done" looks like) `[HUMAN]`

macOS requires **notarization** for any app distributed outside the Mac App
Store (hard requirement since macOS 10.15 Catalina). Gatekeeper checks for a
**Developer ID Application** signature + a stapled notarization ticket.

One-time prerequisites `[HUMAN]`:
1. Apple Developer Program membership ($99/yr) — see `SECRETS.md`.
2. Create a **Developer ID Application** certificate (Xcode or
   Certificates, Identifiers & Profiles).
3. Create an **App Store Connect API key** (or app-specific password) for
   `notarytool` auth.

Per-release pipeline (to wire into `release-desktop.yml`) `[HUMAN]`:
1. **Code-sign** the `.app` with the Developer ID Application cert
   (`codesign --deep --options runtime`, Hardened Runtime enabled).
2. **Notarize** via `xcrun notarytool submit <artifact> --wait` using the ASC
   API key. (`altool` is dead — `notarytool` only, since Nov 1 2023.)
3. **Staple** the ticket: `xcrun stapler staple <artifact>` (so Gatekeeper
   verifies offline).
4. Upload the stapled `.dmg`/`.app` to the GitHub Release.

Tauri integration: set the macOS signing identity + notarization creds as env
in the workflow. The required secret NAMES are listed in `SECRETS.md`
(`APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`,
`APPLE_ID` / `APPLE_TEAM_ID` / `APPLE_PASSWORD` or ASC API key trio).

---

## Auto-update (Tauri updater) — separate from OS signing

- Currently OFF (`updater.active = false`). To enable later (one-time), per
  DESKTOP.md: `bun run tauri signer generate -w ~/.tauri/zintus.key`, paste the
  public half into `tauri.conf.json → bundle.updater.pubkey`, set
  `updater.active = true` and `bundle.createUpdaterArtifacts = true`.
- The workflow already reads `TAURI_SIGNING_PRIVATE_KEY` /
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`; they are no-ops while the updater is off.
- **Tauri-updater signing ≠ Apple notarization.** You need *both* for a
  trustworthy auto-updating notarized macOS app.

---

## Windows (same direct-download channel)

- Currently **unsigned** → **SmartScreen** will warn ("Windows protected your
  PC"). Keep `/download` "beta" copy honest.
- To fix `[HUMAN]`: obtain an **Authenticode** code-signing certificate (OV or
  EV) and sign the installer/exe in `release-desktop.yml`.
- **2026 note:** since March 2024, **EV certificates no longer grant instant
  SmartScreen reputation** — EV and OV now build reputation equally through
  download volume / file-hash history. So an OV cert is sufficient for
  SmartScreen purposes; reputation accrues over downloads regardless. (EV is
  only mandatory for kernel/WHQL driver signing, which Zintus does not ship.)
  Don't pay the EV premium expecting to skip SmartScreen warnings.

---

## Linux

- Built by the same workflow (AppImage/deb per Tauri targets); no notarization
  concept. Direct download from Releases. No action needed beyond honest "beta".

---

## Pre-distribution checklist

- [ ] `/download` copy says "beta / unsigned" until signing+notarization land.
- [ ] macOS: Developer ID cert + `notarytool` notarize + staple wired `[HUMAN]`.
- [ ] Windows: Authenticode (OV is fine for SmartScreen) signing wired `[HUMAN]`.
- [ ] Updater stays OFF until a real `pubkey` exists (per DESKTOP.md).
- [ ] MAS deferred to Phase 2 (Tauri not sandbox/MAS-configured).

---

## Sources (2026)
- [Signing Mac Software with Developer ID](https://developer.apple.com/developer-id/)
- [Notarizing macOS software before distribution](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)
- [Customizing the notarization workflow (notarytool / stapler)](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow)
- [SmartScreen reputation for Windows app developers](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)
- [Which Code Signing Certificate do I Need? EV or OV? (EV no longer bypasses SmartScreen since 2024)](https://www.ssl.com/faqs/which-code-signing-certificate-do-i-need-ev-ov/)
- [Tauri v2 — Updater plugin](https://v2.tauri.app/plugin/updater/)
