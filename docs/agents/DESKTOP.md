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

### Shares the web/gateway model
The desktop app is a thin shell over the same gateway + web surfaces. Don't
re-implement routing/keys here — reuse `@zintus/*` and the gateway. Keys live in
the OS keychain (`@zintus/keychain`).

## When you're done
- [ ] `bun run typecheck` (desktop) — 0 errors
- [ ] App launches locally
- [ ] PR opened, not merged
