# Store / Release Secrets & Variables (NAMES ONLY — no values)

Every CI secret/var needed to build, sign, and submit the Zintus apps, by name
and purpose. **Never commit values.** Store secrets in GitHub repo/Org
**Secrets**; non-sensitive build-time config in repo **Variables**. Confirm the
exact names referenced by each workflow before relying on them (see "Where
referenced").

> Grounded in `docs/agents/MOBILE.md`, `docs/agents/DESKTOP.md`,
> `docs/agents/OPS.md`, `apps/mobile/app.json`, and
> `apps/desktop/src-tauri/tauri.conf.json`. Names marked **[planned]** are not
> wired yet (the signing/submit steps don't exist in the workflows today) — add
> them when wiring the corresponding step.

---

## Mobile — Expo / EAS (`.github/workflows/release-mobile.yml`)

| Name | Kind | Purpose | Where referenced |
|---|---|---|---|
| `EXPO_TOKEN` | Secret | Authenticates `eas build` / `eas submit` to the Expo account. | `release-mobile.yml` (per MOBILE.md) |
| `EXPO_PUBLIC_VALIDATE_URL` | Variable | Build-time (`EXPO_PUBLIC_*` inlined). Deployed web `/api/validate` URL used by `apps/mobile/lib/limits.ts`. Defaults to `http://localhost:3000/api/validate` for dev. | `release-mobile.yml`, `lib/limits.ts` |
| `EXPO_PUBLIC_RELAY_URL` | Variable | Build-time relay base URL the app's gateway-URL resolution / relay client uses (`https://relay.zintus.ai`). Inlined at build. | mobile build env |

### iOS submit credentials — **[planned]** (re-add `eas.json submit` only with real creds)
Prefer an **App Store Connect API key** over Apple ID/password (per MOBILE.md).

| Name | Kind | Purpose |
|---|---|---|
| `ASC_API_KEY_P8` (or `ascApiKeyPath` file) | Secret | App Store Connect API key (`.p8`) for `eas submit` to App Store / notary-adjacent ASC auth. Keep `.p8` gitignored. |
| `ASC_API_KEY_ID` | Secret | ASC API key id. |
| `ASC_API_KEY_ISSUER_ID` | Secret | ASC API key issuer id. |
| `APPLE_TEAM_ID` | Secret | Apple Developer Team id. |
| `ASC_APP_ID` | Secret | App Store Connect app (Apple) id for the listing. |
| `EXPO_APPLE_APP_SPECIFIC_PASSWORD` | Secret | Alternative to ASC API key (Apple ID + app-specific password) — only if not using the API key. |

### Android submit credentials — **[planned]**
| Name | Kind | Purpose |
|---|---|---|
| `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` | Secret | Play Console service-account JSON for `eas submit` to a Play track (e.g. `internal`). Keep the JSON gitignored; never commit. |

---

## Desktop — Tauri (`.github/workflows/release-desktop.yml`)

### Tauri updater signing (read today, no-ops while updater is OFF)
| Name | Kind | Purpose | Where referenced |
|---|---|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | Secret | Contents (or path) of `~/.tauri/zintus.key` — signs updater artifacts. No-op while `updater.active = false`. | `release-desktop.yml` (per DESKTOP.md) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Secret | Password set at `tauri signer generate`. | `release-desktop.yml` |

### macOS OS code-signing + notarization — **[planned]** (NOT wired; see `mac-distribution.md`)
| Name | Kind | Purpose |
|---|---|---|
| `APPLE_CERTIFICATE` | Secret | Base64 Developer ID Application cert (`.p12`) for `codesign`. |
| `APPLE_CERTIFICATE_PASSWORD` | Secret | Password for the `.p12`. |
| `APPLE_SIGNING_IDENTITY` | Secret/Var | The "Developer ID Application: …" identity string. |
| `APPLE_ID` | Secret | Apple ID used for notarization (if not using ASC API key). |
| `APPLE_PASSWORD` | Secret | App-specific password for that Apple ID (notarization). |
| `APPLE_TEAM_ID` | Secret | Team id for notarization. |
| (or reuse ASC API key trio) `ASC_API_KEY_P8` / `ASC_API_KEY_ID` / `ASC_API_KEY_ISSUER_ID` | Secret | `notarytool` auth via ASC API key (preferred over Apple ID/password). |

### Windows Authenticode signing — **[planned]** (NOT wired; OV is fine for SmartScreen)
| Name | Kind | Purpose |
|---|---|---|
| `WINDOWS_CERTIFICATE` | Secret | Base64 Authenticode code-signing cert (`.pfx`). |
| `WINDOWS_CERTIFICATE_PASSWORD` | Secret | Password for the `.pfx`. |

---

## Relay (already deployed — for context, see `docs/agents/OPS.md`)
Not store secrets, but the app depends on the relay being live. Set via
`wrangler secret put`: `GOOGLE_CLIENT_ID`, `RESEND_API_KEY`, `STRIPE_*`,
optional `SENTRY_DSN`. Vars: `RELAY_BASE_URL`, `COOKIE_DOMAIN`.

---

## [HUMAN] One-time account / infra setup (no automation can do these)

- [ ] **Apple Developer Program** enrollment — **$99/yr**. Required for iOS App
      Store submission AND macOS Developer ID signing/notarization.
- [ ] **Google Play Developer** account — **$25 one-time**. Required for Play
      submission.
- [ ] **EAS project linked** — run `cd apps/mobile && eas init` once (writes
      `extra.eas.projectId`; release builds fail without it — per MOBILE.md).
- [ ] **App records created** in App Store Connect (Apple) and Play Console
      (package `com.zintus.app`), to obtain `ASC_APP_ID` etc.
- [ ] **Relay deployed + healthy** — `curl https://relay.zintus.ai/health` →
      `{"ok":true}` (Remote tab / Zintus Cloud depends on it).
- [ ] **Demo gateway** stood up for App/Play review (see `review-notes.md`).
- [ ] **Privacy policy** (`https://www.zintus.ai/privacy`) finalized with counsel
      (currently DRAFT) and **account-deletion page**
      (`https://www.zintus.ai/account/delete`) live before submission.
- [ ] **Code-signing certs obtained** (Apple Developer ID Application; Windows
      Authenticode OV) before flipping the desktop signing steps on.

---

## Rules
- Secret **values** never live in the repo, in `eas.json`, or in `app.json`.
  Pass via GitHub Secrets / EAS environment; keep `.p8` / `*-service-account.json`
  / `.p12` / `.pfx` gitignored.
- Prefer **ASC API key** over Apple ID + app-specific password (per MOBILE.md).
- The desktop **OS signing** secrets are placeholders for **[planned]** steps —
  builds are unsigned beta until those steps are wired (see `mac-distribution.md`).
