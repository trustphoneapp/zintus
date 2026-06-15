# Mobile release testing (TestFlight / Android internal)

## Prerequisites

1. Create an Expo account and run `eas init` in `apps/mobile` to set a real `projectId` in `app.json`.
2. Set `EXPO_PUBLIC_VALIDATE_URL` to your deployed web `/api/validate` or Cloudflare worker URL.
3. Configure `eas.json` submit credentials (Apple ID, ASC app ID, Google service account).

## Internal testing builds

```bash
export PATH="$HOME/.bun/bin:$PATH"
cd apps/mobile
bun install

# iOS simulator (development client)
eas build --profile development --platform ios

# Android APK for internal testers
eas build --profile preview --platform android

# Production store builds
eas build --profile production --platform all
```

## Submit to stores

```bash
# After production build completes
eas submit --platform ios --profile production
eas submit --platform android --profile production
```

## TestFlight (iOS)

1. Run a `production` or `preview` iOS build via EAS.
2. `eas submit` uploads to App Store Connect.
3. Add internal testers in App Store Connect → TestFlight.
4. Verify: streaming chat, provider sheet, secure-store keys, quota notifications.

## Android internal testing

1. Run `preview` profile for APK or `production` for AAB.
2. Upload AAB to Play Console internal testing track via `eas submit`.
3. Verify: expo-sqlite quota, expo-notifications warnings, MMKV settings persistence.

## Local dev (no EAS)

```bash
bun run start
# Press i / a for simulator. MMKV and native modules require dev client for full parity.
```
