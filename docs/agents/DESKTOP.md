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
and published via GitHub Releases. The workflow does **Tauri-updater signing
only — not OS code-signing**, so builds are currently "unsigned beta"
(Gatekeeper/SmartScreen may warn). The `/download` web page links the Releases
page and says "beta" — keep that honest; don't claim signed builds until OS
code-signing is wired.

### Updater is OFF until signing is wired
`src-tauri/tauri.conf.json` → `bundle.updater.active` is **`false`** with an empty
`pubkey`. This is deliberate: an *active* updater with an empty/unsigned key is a
foot-gun (a Tauri v2 build with `active: true` needs a real `pubkey`, and an
unsigned `latest.json` can't be verified). `active: false` matches the "unsigned
beta" reality and the `/download` "beta" copy. Do **not** flip it to `true` until
you generate a signing keypair and paste the public half into `pubkey`.

To enable auto-update later (one-time):
```bash
cd apps/desktop && bun run tauri signer generate -w ~/.tauri/zintus.key
# paste contents of ~/.tauri/zintus.key.pub into tauri.conf.json -> bundle.updater.pubkey
# then set bundle.updater.active = true (and bundle.createUpdaterArtifacts = true)
```
Source: [Tauri v2 — Updater plugin](https://v2.tauri.app/plugin/updater/).

### Release signing checklist (`release-desktop.yml`)
`.github/workflows/release-desktop.yml` (tag `desktop-v*`) does **Tauri-updater
signing only — NOT OS code-signing/notarization**. It reads two repo secrets,
which only matter once the updater is re-enabled:
- `TAURI_SIGNING_PRIVATE_KEY` — contents (or path) of `~/.tauri/zintus.key`.
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — the password set at `signer generate`.
While `updater.active` is `false` these secrets are effectively no-ops (no
updater artifacts are produced/signed). Still **missing** (so Gatekeeper /
SmartScreen will warn — keep `/download` honest about "beta"):
- macOS: Apple Developer ID cert + notarization (`APPLE_CERTIFICATE`,
  `APPLE_ID`, `APPLE_TEAM_ID`, `APPLE_PASSWORD`).
- Windows: Authenticode code-signing cert.
Source: [Tauri v2 — Updater plugin](https://v2.tauri.app/plugin/updater/).

### Shares the web/gateway model
The desktop app is a thin shell over the same gateway + web surfaces. Don't
re-implement routing/keys here — reuse `@zintus/*` and the gateway. Keys live in
the OS keychain (`@zintus/keychain`).

## When you're done
- [ ] `bun run typecheck` (desktop) — 0 errors
- [ ] App launches locally
- [ ] PR opened, not merged
