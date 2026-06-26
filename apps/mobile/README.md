# Zintus Mobile

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

### Gateway URL

Start the gateway on your computer with `zintus serve`. The app finds it
automatically: it derives the host from the Metro bundler URL (your machine's
LAN IP on a physical device, `10.0.2.2` on the Android emulator) and uses the
gateway port `8788`. No IP to hand-edit for the common dev case.

To override, set it in-app under **Settings → Gateway**, or pin a fixed URL with
`EXPO_PUBLIC_GATEWAY_URL` (e.g. a production gateway). Resolution order:
in-app setting → `EXPO_PUBLIC_GATEWAY_URL` → auto-detected dev host → `localhost`.

Key validation uses `EXPO_PUBLIC_VALIDATE_URL` (defaults to
`http://localhost:3000/api/validate`) and falls back to a local provider check
when unreachable, so it works on-device without configuration:

```bash
EXPO_PUBLIC_VALIDATE_URL=https://your-app.vercel.app/api/validate bun run start
```

## Features

| Feature | Implementation |
|---------|----------------|
| Chat | Inverted `FlatList`, `KeyboardAvoidingView`, streaming via `@zintus/providers` |
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
3. Set up store credentials: `eas credentials` (EAS-managed signing). There is no
   `submit` block in `eas.json` — submit creds live in EAS / GitHub secrets, never
   the repo (see `TESTING.md`).
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
