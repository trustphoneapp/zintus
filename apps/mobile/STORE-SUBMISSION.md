# Zintus Mobile — Store Submission Runbook

State after the 2026-07-02 store-readiness pass. The **app config is now
store-shaped**; what remains is EAS builds + accounts + device verification
(the parts that need your Apple/Google credentials and a device).

## What's done in code/config (2026-07-02)

- **Real app icon.** The iOS `icon.png` (and `adaptive-icon.png`) were a blank
  purple square — a guaranteed rejection. Regenerated as the branded mark
  (purple gradient + the blue chevron routing arrow) at 1024², opaque. Android
  keeps its adaptive foreground/background/monochrome trio.
- **Minimal Android permissions.** `android.permissions` is now exactly
  `POST_NOTIFICATIONS`; a `blockedPermissions` list explicitly strips the
  camera/mic/location/media/contacts/overlay permissions Expo modules can pull
  in transitively. This is the fix for Play Console "unused permission" flags.
  The app genuinely uses none of them (DocumentPicker needs no permission).
- **iOS privacy manifest.** `ios.privacyManifests` declares
  `NSPrivacyTracking: false`, no collected data types, and the required-reason
  API entries for the Apple APIs the Expo modules touch (UserDefaults CA92.1,
  file timestamp C617.1, disk space E174.1, boot time 35F9.1). Apple has
  required this since 2024.
- **Contextual notification permission.** The app no longer requests
  notification permission on cold launch (a store-guideline violation + a
  rejection risk). It's now an explicit **Settings → Notifications** opt-in that
  requests the OS permission only on that tap; every notify path checks the
  opt-in + granted state and never prompts in the background.
- **ATS.** Only `NSAllowsLocalNetworking` (needed for the LAN gateway) — not
  arbitrary loads. `NSLocalNetworkUsageDescription` explains why.
- **Versioning.** `runtimeVersion: { policy: "appVersion" }` for OTA safety;
  `eas.json` uses remote `appVersionSource` + `autoIncrement`, so build numbers
  are managed by EAS (no manual `buildNumber`/`versionCode`).
- **eas.json** has `development`/`preview`/`production` build profiles (channels
  wired) **and** a `submit.production` block (placeholders for your ASC app id /
  Apple team id / Play service-account key).

## [HUMAN] to actually ship — in order

1. **Link the EAS project.** `cd apps/mobile && eas init` → replace
   `extra.eas.projectId` in `app.json` (`REPLACE_WITH_EAS_PROJECT_ID`).
2. **Preview builds + device smoke.**
   ```bash
   eas build --profile preview --platform android   # APK
   eas build --profile preview --platform ios       # needs an Apple account
   ```
   Install on a real device and walk: onboarding → add a provider key → chat →
   history → projects → research → settings (flip the Notifications toggle,
   confirm the OS prompt appears only on that tap). This is the doctor
   "duplicate deps" proof (a green EAS build ⇒ the bun-store link duplication is
   the harmless kind).
3. **Store metadata.** Fill `docs/store/ios-listing.md` +
   `docs/store/play-listing.md`; both stores require a **privacy policy URL**
   (the web `/privacy` page, once deployed) and a support URL.
4. **Production builds + submit.**
   ```bash
   eas build --profile production --platform all
   # fill eas.json submit.production placeholders first:
   eas submit --profile production --platform ios      # ASC app id + team id
   eas submit --profile production --platform android  # play-service-account.json
   ```
5. **Data-safety / privacy questionnaires.** In both consoles answer per the
   BYOK model: no data collected by Zintus, keys stay in the OS keystore,
   prompts go device → your gateway → the provider you chose. The iOS privacy
   manifest already encodes this; keep the App Privacy answers consistent.

## Enabling real voice dictation (optional dev step)

The mic button uses `expo-speech-recognition` when it's present in a dev/preview
build; otherwise it shows an honest "unavailable" fallback (it is NOT a hard
dependency because it can't be verified on a simulator/CI). To turn it on:

```bash
cd apps/mobile
npx expo install expo-speech-recognition
```
Then in `app.json`: remove `android.permission.RECORD_AUDIO` from
`blockedPermissions`, add it to `permissions`, and add the iOS
`NSMicrophoneUsageDescription` + `NSSpeechRecognitionUsageDescription` purpose
strings. Rebuild — the mic button will dictate into the composer (it never
auto-sends a transcript). No app code changes needed; `lib/speech.ts` already
guards the integration.

## Known non-blocker

`expo-doctor` reports **20/21** — the one failure is bun's isolated-store
linking the SAME dependency version from two locations (expo / expo-router
subtrees). Identical versions, so Metro bundles one copy and a green EAS build
confirms it's harmless. Not a real duplicate; documented in `BUILD-STATUS.md`.
