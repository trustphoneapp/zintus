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
4. App Store privacy: declare the third-party-AI data sharing (Apple 5.1.2(i) —
   the app sends prompts/files to user-chosen providers; see
   `docs/store/ios-listing.md`). `ITSAppUsesNonExemptEncryption: false` is set in
   `app.json`, but because the app runs its OWN x25519 key exchange (not just OS
   TLS) for the BYOK key push, `false` is **not automatically correct** — this is
   a counsel-gated [HUMAN] decision (two defensible paths in `ios-listing.md` §4).
5. Verify the feature smoke matrix below.

## Android internal testing

1. Run `preview` for an APK (sideload) or `production` for the AAB.
2. Upload the AAB to the Play Console internal testing track via `eas submit`.
3. Complete the Play **Data safety** form (BYOK keys stored on-device via
   expo-secure-store; no data sold/shared).
4. Verify: expo-sqlite quota, expo-notifications warnings, MMKV settings persistence.

## Feature smoke matrix (real device, after EAS preview install)

Run on a physical Android device and a physical iPhone (and an iPad — `supportsTablet`).

| Area | What to check |
|---|---|
| Onboarding | first launch routes to onboarding; gateway health check; add+test a free-tier key; sample prompt prefills chat; Skip → limited state |
| Gateway | auto-detected URL works; manual URL in Settings; offline banner + send disabled when gateway down |
| Chat | multiline composer; streaming; **Stop** cancels mid-stream; markdown (headings/lists/tables/code + copy code); copy/retry/regenerate/report |
| Response footer | after each answer: provider·model, compression % + tokens/cost saved, "saved vs Claude", quota %, route reason, low-quota actions |
| Consent | first provider send shows the data-destination consent sheet (Apple 5.1.2(i)); reversible in Settings |
| Private Mode | 🛡 toggle persists; explainer on first enable; training providers refused |
| Files | ＋ picks a .txt/.md/.csv/.json/code file; chip + remove; privacy notice; content reaches the model; PDF/binary → honest "can't read on-device" |
| Deep Research | Research tab runs `/v1/research`; staged progress; source cards/links; export; save-to-history (needs a Tavily/Serper key on the gateway) |
| History | New/History; thread list; search; rename; delete; continue hydrates a thread |
| Projects | create/edit/delete; New chat in project applies instructions (system msg) + defaults; project badge in chat |
| Providers | add/update/remove/**test** keys; quota; est-cost; recommendation banner; one-tap **Use local** (Ollama/LM Studio) |
| Voice | 🎤 shows the unavailable fallback (full STT requires expo-speech-recognition in the dev build) |
| Cloud | `zintus://auth` deep-link login; Remote tab |

## Permissions audit (after `eas build` / prebuild)

- Current shipped natives need **no** runtime permissions beyond network +
  SecureStore. `expo-document-picker` uses the system file UI (no storage
  permission). `expo-notifications` requests notification permission at runtime.
- **Before image/voice ship:** add iOS purpose strings (`NSCameraUsageDescription`,
  `NSMicrophoneUsageDescription`, `NSPhotoLibraryUsageDescription`,
  `NSSpeechRecognitionUsageDescription`) and audit the **generated AndroidManifest**
  — `expo-image-picker` auto-adds `RECORD_AUDIO`; drop it via
  `android.blockedPermissions` if camera-only. See `docs/store/*` for the
  per-store justification tables.
- Verify the final manifest/Info.plist from EAS output — do not assume.

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
