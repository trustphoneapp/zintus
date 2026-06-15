# MultipleAI Mobile

Expo SDK 56 app with streaming chat, secure API key storage, local quota ledger, and push notifications for quota warnings.

## Prerequisites

- [Bun](https://bun.sh) or npm
- [Expo Go](https://expo.dev/go) on a device, or iOS Simulator / Android Emulator
- [EAS CLI](https://docs.expo.dev/build/setup/) for production builds (`npm i -g eas-cli`)

## Development

```bash
cd apps/mobile
bun install
bun run start
```

Set `EXPO_PUBLIC_VALIDATE_URL` to your web app validate proxy (defaults to `http://localhost:3000/api/validate`):

```bash
EXPO_PUBLIC_VALIDATE_URL=https://your-app.vercel.app/api/validate bun run start
```

On a physical device, replace `localhost` with your machine's LAN IP for Metro and the validate URL.

## Features

| Feature | Implementation |
|---------|----------------|
| Chat | Inverted `FlatList`, `KeyboardAvoidingView`, streaming via `@multipleai/providers` |
| Keys | `expo-secure-store` per provider |
| Quota | `expo-sqlite` ledger (mirrors CLI/desktop schema) |
| Warnings | `expo-notifications` when quota drops below 20% |
| Providers UI | `@gorhom/bottom-sheet` key modal + quota bars |
| Styling | NativeWind 4 + Tailwind v3 |

## Tabs

- **Chat** — streaming messages with provider selector sheet
- **Providers** — quota bars, add/update/remove keys
- **Usage** — per-provider usage summary

## EAS Build

1. Log in: `eas login`
2. Link project (first time): `eas init` — updates `app.json` `extra.eas.projectId`
3. Configure credentials in `eas.json` submit section
4. Build:

```bash
# Internal testing (TestFlight / Android Internal)
eas build --profile preview --platform all

# Production store release
eas build --profile production --platform all
```

## EAS Submit (TestFlight + Android Internal Testing)

After a successful build:

```bash
# iOS → TestFlight
eas submit --platform ios --profile production

# Android → Internal testing track
eas submit --platform android --profile production
```

Update placeholders in `eas.json`:

- `submit.production.ios.appleId` — Apple ID email
- `submit.production.ios.ascAppId` — App Store Connect app ID
- `submit.production.ios.appleTeamId` — 10-character team ID
- `submit.production.android.serviceAccountKeyPath` — Google Play JSON key path

## Project structure

```
app/           Expo Router tabs (chat, providers, usage)
components/    ProviderSheet, QuotaBar
lib/           chat, keys, quota, limits, notifications, validate
```
