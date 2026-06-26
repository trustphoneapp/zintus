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

## `expo-doctor` notes

**Always run it from this directory** (or `bun run doctor:mobile` from the repo
root). The `expo` CLI is a project-local bin; running `expo-doctor` from the
monorepo root fails the Metro check with *"Cannot determine the project's Expo
SDK version because the module `expo` is not installed"* (really `expo: command
not found`, exit 127) — an invocation artifact, **not** a project defect.
Canonical result from here: **20/21**, the one real failure being duplicate
native deps (below).

### Metro / Tailwind config resolution — FIXED

`metro.config.js` passes **absolute** paths for NativeWind's `input` and
`configPath` (anchored to `__dirname`). NativeWind runs `path.resolve()` on
both, which is cwd-relative; in this Bun monorepo `expo-doctor` (and Metro)
evaluate the config from the **workspace root**, where the old relative
`"./global.css"` / default `"tailwind.config"` resolved to
`<repo-root>/tailwind.config` and failed with *"Cannot find module
.../zintus/tailwind.config"*. Absolute paths make it cwd-independent.

### Duplicate native dependencies — KNOWN, needs an EAS build or a PM decision

`expo-doctor`'s one remaining failure ("duplicate native module dependencies")
is a **Bun + Expo monorepo limitation, not version skew, and not locally
fixable by config**. Verified facts:

- The flagged copies resolve to **distinct realpaths** in Bun's content-addressed
  store (`node_modules/.bun/<pkg>@<ver>+<hash>`) — genuine physical duplicates,
  not symlink aliases.
- They are the **same version** (e.g. `expo-constants@56.0.18` has **20** store
  variants), forked only by peer-resolution context because Expo 56's peer graph
  is heavily circular (`expo ↔ @expo/cli ↔ @expo/log-box ↔ expo-router`). So
  `overrides` (which pin versions) cannot collapse them.
- A clean reinstall does **not** help: the store is regenerated deterministically
  and every variant is referenced by the live graph (app + `expo` + `expo-router`).
  Verified by inspection; do not waste a destructive `rm -rf node_modules` on it.
- Bun 1.3.x has **no `dedupe` command**.
- (Orphaned `expo@52` copies from a prior SDK exist in the store but are **not**
  in the lockfile and are **not** what the check flags — cosmetic only.)

The only real resolutions — both outside a local code change:

1. **Prove harmless via a real native build**: `eas build --profile preview
   --platform all` (needs `eas login`). EAS resolves deps in its own builder; if
   autolinking succeeds and the app boots, the duplicates are cosmetic for our
   dep set and the doctor check is a known false-positive we can suppress.
2. **Migrate the mobile workspace's package manager** (npm/pnpm/yarn hoist
   differently and avoid the peer-fork). This is an architecture decision with
   monorepo-wide implications.

Until one of those is done, treat iOS/Android **native release as unverified**.
JS/TS is fine (typecheck + tests green); this is strictly a native-autolinking
question that only a real build can answer.
