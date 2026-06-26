# DESKTOP Agent

**Owns:** `apps/desktop/` (Tauri app)
**Risk:** MEDIUM — needs a signed build to ship cleanly.

## Source of truth
| Fact | Where |
|---|---|
| App / Tauri config | `apps/desktop/` (`package.json`, `src-tauri/`) |
| Release workflow | `.github/workflows/release-desktop.yml` |

## Decisions you must NOT reverse

### Build / release
Desktop builds are produced by `release-desktop.yml` (Tauri, macOS/Windows/Linux)
and **published as a GitHub Release** (via `tauri-apps/tauri-action`) on a
`desktop-v*` tag. Until the `[HUMAN]` certs below are added as secrets, builds are
"unsigned beta" (Gatekeeper/SmartScreen may warn). The `/download` web page links
the Releases page and says "beta" — keep that honest; don't claim signed builds
until OS code-signing is wired.

## Release procedure
The workflow is **tag-driven**. To cut a release:
```bash
# 1. Bump the version in all three (must match):
#    apps/desktop/src-tauri/tauri.conf.json -> version
#    apps/desktop/package.json              -> version
#    apps/desktop/src-tauri/Cargo.toml      -> version
# 2. Merge to main, then tag (tag MUST match the version, prefixed desktop-v):
git tag desktop-v0.2.0
git push origin desktop-v0.2.0
```
`release-desktop.yml` then, per matrix target
(`universal-apple-darwin` / `x86_64-pc-windows-msvc` / `x86_64-unknown-linux-gnu`):
builds the frontend + native bundle, signs IF the secrets below exist, and
publishes a **prerelease** GitHub Release named `Zintus Desktop desktop-v0.2.0`
with the bundles attached (`.dmg`/`.app`, `.msi`/`.exe`, AppImage/`.deb`).
`latest.json` (the updater feed) is uploaded **only** when
`TAURI_SIGNING_PRIVATE_KEY` is set — see "Updater is OFF" below.

### `[HUMAN]` signing secrets (GitHub repo → Settings → Secrets → Actions)
None of these are hardcoded; the workflow reads them via `secrets.*` and a dry run
without them still produces (unsigned) bundles. Add them to actually sign:

| Platform | Secret | What it is |
|---|---|---|
| Updater | `TAURI_SIGNING_PRIVATE_KEY` | contents of `~/.tauri/zintus.key` |
| Updater | `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | password set at `signer generate` |
| macOS | `APPLE_CERTIFICATE` | base64 of the Developer ID `.p12` (`openssl base64 -in cert.p12`) |
| macOS | `APPLE_CERTIFICATE_PASSWORD` | the `.p12` export password |
| macOS | `APPLE_SIGNING_IDENTITY` | e.g. `Developer ID Application: YS Ventures LLC (TEAMID)` |
| macOS | `APPLE_ID` | Apple ID used for notarization |
| macOS | `APPLE_APP_SPECIFIC_PASSWORD` | app-specific pw → workflow maps it to `APPLE_PASSWORD` |
| macOS | `APPLE_TEAM_ID` | 10-char Apple Developer Team ID |
| Windows | `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET` / `AZURE_TENANT_ID` | Azure Trusted Signing creds (see Windows note below) |

Sources: [Tauri — GitHub pipeline](https://v2.tauri.app/distribute/pipelines/github/),
[Tauri — macOS code signing](https://v2.tauri.app/distribute/sign/macos/),
[Tauri — Windows code signing](https://v2.tauri.app/distribute/sign/windows/),
[Tauri env vars](https://v2.tauri.app/reference/environment-variables/),
[tauri-action](https://github.com/tauri-apps/tauri-action).

`[HUMAN]` **Windows** signing is wired as env only: the modern path is
**Azure Trusted Signing**, which needs `bundle.windows.signCommand` (invoking
`relic`/the Azure CLI) added to `tauri.conf.json` plus the `AZURE_*` secrets. Until
that `signCommand` exists the `.msi`/`.exe` ships unsigned. See
[Tauri — Windows code signing](https://v2.tauri.app/distribute/sign/windows/).

### Updater is OFF until signing is wired
`src-tauri/tauri.conf.json` → `bundle.updater.active` is **`false`** with an empty
`pubkey`. This is deliberate: an *active* updater with an empty/unsigned key is a
foot-gun (a Tauri v2 build with `active: true` needs a real `pubkey`, and an
unsigned `latest.json` can't be verified). `active: false` matches the "unsigned
beta" reality and the `/download` "beta" copy. Do **not** flip it to `true` until
you generate a signing keypair and paste the public half into `pubkey`.

To enable auto-update later (one-time, `[HUMAN]`):
```bash
cd apps/desktop && bun run tauri signer generate -w ~/.tauri/zintus.key
# 1. paste contents of ~/.tauri/zintus.key.pub into tauri.conf.json -> bundle.updater.pubkey
# 2. set bundle.updater.active = true
# 3. set bundle.createUpdaterArtifacts = true   (currently explicitly `false`)
# 4. add TAURI_SIGNING_PRIVATE_KEY + TAURI_SIGNING_PRIVATE_KEY_PASSWORD as repo secrets
```
With those four in place the next `desktop-v*` tag produces signed `.sig`
artifacts and `release-desktop.yml` publishes `latest.json` automatically — its
`includeUpdaterJson` input is gated on `TAURI_SIGNING_PRIVATE_KEY` being set, so a
half-configured updater never ships a broken feed.
Source: [Tauri v2 — Updater plugin](https://v2.tauri.app/plugin/updater/).

### Release signing checklist (`release-desktop.yml`)
`.github/workflows/release-desktop.yml` (tag `desktop-v*`) now reads **all**
signing secrets via `secrets.*` (none hardcoded) and never fails when they are
absent — a dry run still publishes unsigned bundles. The full secret list +
meaning is in the "`[HUMAN]` signing secrets" table above. State today:
- **Updater signing** (`TAURI_SIGNING_*`): no-op while `updater.active = false`.
- **macOS Developer ID + notarization** (`APPLE_*`): wired; certs `[HUMAN]`-pending.
- **Windows Authenticode** (`AZURE_*`): env wired; needs `signCommand` in
  `tauri.conf.json` + `[HUMAN]` Azure Trusted Signing setup before it signs.
Until the macOS/Windows certs exist, Gatekeeper / SmartScreen warn — keep
`/download` honest about "beta".
Source: [Tauri v2 — Updater plugin](https://v2.tauri.app/plugin/updater/).

### Shares the web/gateway model
The desktop app is a thin shell over the same gateway + web surfaces. Don't
re-implement routing/keys here — reuse `@zintus/*` and the gateway. Keys live in
the OS keychain (`@zintus/keychain`).

## When you're done
- [ ] `bun run typecheck` (desktop) — 0 errors
- [ ] App launches locally
- [ ] PR opened, not merged
