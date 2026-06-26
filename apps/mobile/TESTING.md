# Mobile release testing (TestFlight / Android internal)

Zintus mobile is **BYOK** (users bring their own provider keys). There is no
managed-key/paid pooling in the app, so store builds need no billing config —
only the public validate/relay URLs and store accounts.

## [HUMAN] one-time setup (needs accounts / credentials)

These run **once** by the owner and cannot be done by an agent — they create
accounts, write a real `extra.eas.projectId`, and register signing credentials.

```bash
export PATH="$HOME/.bun/bin:$PATH"
cd apps/mobile

# 1. Authenticate the Expo account.
eas login                       # [HUMAN] — interactive

# 2. Link the slug to an EAS project. Writes extra.eas.projectId into app.json.
#    We intentionally DO NOT commit a fake/borrowed projectId, so eas build (and
#    .github/workflows/release-mobile.yml) cannot run a release until this runs.
eas init                        # [HUMAN] — writes app.json extra.eas.projectId

# 3. Register signing credentials (interactive). For Android, accept EAS-managed
#    Play App Signing (Google holds the app signing key, EAS holds the upload key
#    — required for new Play apps). For iOS, let EAS manage the distribution cert
#    + provisioning profile, or supply your own.
eas credentials                 # [HUMAN] — Android upload key + iOS dist cert
```

### [HUMAN] store accounts + submit credentials

- **Apple:** an Apple Developer Program membership. Create an **App Store Connect
  API key** (App Store Connect → Users and Access → Integrations → App Store
  Connect API → +): download the `.p8`, note the Key ID + Issuer ID. Prefer the
  ASC API key over Apple-ID/password. Keep the `.p8` out of the repo (gitignored
  or an EAS secret).
- **Google:** a Google Play Console account ($25 one-time) and a **service
  account JSON** with the *Release apps to testing tracks* permission. Keep the
  JSON out of the repo.
- Provide these to EAS via `eas credentials` / EAS-managed credentials, or as a
  gitignored submit block in `eas.json`. **Never commit them.**

## Build profiles (`eas.json`)

| Profile | Android output | Use |
|---|---|---|
| `development` | dev client | local dev on a device/simulator |
| `preview` | **APK** (`buildType: apk`) | sideload / internal QA — installs directly |
| `production` | **AAB** (`buildType: app-bundle`) | Play Store + App Store |

Play requires the **AAB** (Android App Bundle) format for new apps/updates — an
APK is not accepted on the store. The `production` profile is set to
`app-bundle`; keep `preview` as `apk` for direct-install QA.

> Target API level: as of **Aug 31 2026**, new Play apps/updates must target
> Android 16 (API 36)+. Expo SDK 56 already targets a compliant API level; verify
> with `eas build` output before the deadline.

## Internal testing builds

```bash
export PATH="$HOME/.bun/bin:$PATH"
cd apps/mobile
bun install

# iOS simulator (development client)
eas build --profile development --platform ios

# Android APK for internal testers (sideload)
eas build --profile preview --platform android

# Production store builds (iOS .ipa + Android .aab)
eas build --profile production --platform all
```

## Submit to stores

The repo `submit` block was removed on purpose (no committed creds). Submit reads
EAS-managed credentials registered via `eas credentials` / `eas login`.

```bash
# After a production build completes
eas submit --platform all --profile production --latest
# or per-platform:
eas submit --platform ios --profile production --latest
eas submit --platform android --profile production --latest
```

CI does this automatically in `.github/workflows/release-mobile.yml`
(`eas-submit` job) when the repo var `MOBILE_SUBMIT_ENABLED=true` and the
`EXPO_TOKEN` secret are set; otherwise it skips cleanly.

## TestFlight (iOS)

1. Run a `production` iOS build via EAS.
2. `eas submit` uploads to App Store Connect.
3. Add internal testers in App Store Connect → TestFlight.
4. App Store privacy: the app collects no analytics; declare data use accordingly.
   `ITSAppUsesNonExemptEncryption: false` is already set in `app.json` (the app
   uses only standard HTTPS/x25519 BYOK crypto — export-exempt).
5. Verify: streaming chat, provider sheet, secure-store keys, quota notifications.

## Android internal testing

1. Run `preview` for an APK (sideload) or `production` for the AAB.
2. Upload the AAB to the Play Console internal testing track via `eas submit`.
3. Complete the Play **Data safety** form (BYOK keys stored on-device via
   expo-secure-store; no data sold/shared).
4. Verify: expo-sqlite quota, expo-notifications warnings, MMKV settings persistence.

## Required build-time env

`EXPO_PUBLIC_*` vars are inlined at build time — set before `eas build`. See
`apps/mobile/.env.example`.

- `EXPO_PUBLIC_VALIDATE_URL` — **REQUIRED for store builds** (deployed
  `/api/validate`). Defaults to `localhost:3000` which a shipped app cannot reach.
  In CI: repo var `EXPO_PUBLIC_VALIDATE_URL`.
- `EXPO_PUBLIC_RELAY_URL` — optional, defaults to `https://relay.zintus.ai`.
  In CI: repo var `EXPO_PUBLIC_RELAY_URL`.

## Local dev (no EAS)

```bash
bun run start
# Press i / a for simulator. MMKV and native modules require a dev client for full parity.
```
