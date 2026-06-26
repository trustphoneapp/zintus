# MOBILE Agent

**Owns:** `apps/mobile/` (Expo / React Native)
**Risk:** MEDIUM — needs a store build to ship.

## Source of truth
| Fact | Where |
|---|---|
| Expo SDK / deps | `apps/mobile/package.json` |
| BYOK key push | `apps/mobile/lib/gateway-key-push.ts` |
| Provider screen | `apps/mobile/app/providers.tsx` |
| Gateway URL resolution | `apps/mobile/lib/gateway-url-resolve.ts` (+ `.test.ts`) |
| Crypto | `packages/crypto-e2e/src/index.ts` (shared) |

## Stack (from `package.json`)
Expo SDK **~56**, `expo-router` (~6, file-based), `expo-secure-store` (~15).

## Decisions you must NOT reverse

### BYOK key push — relay never sees plaintext
`lib/gateway-key-push.ts`:
1. Fetch the gateway's public key from relay status.
2. Encrypt the API key with **x25519 (`@noble`)** — see `@zintus/crypto-e2e`.
3. Send as a `set_key` control message via the relay.
4. Store locally in **`expo-secure-store`**.

Use `@noble` (pure JS, RN-safe). **WebCrypto x25519 is NOT available in React
Native** — do not reach for it. The relay forwards opaque ciphertext only.

### Provider screen detection comes from the gateway
`app/providers.tsx` shows "On your system" (Ollama/LM Studio) + "Connect a
provider" (BYOK). Local-runtime detection comes from **gateway status**, not from
pinging `localhost` — the phone can't reach the user's home machine.

### Gateway URL resolution order
`lib/gateway-url-resolve.ts`: saved URL → env var → dev host → localhost.
Covered by `lib/gateway-url-resolve.test.ts` — keep it passing.

## Rules
- No WebCrypto x25519 — `@noble` only.
- No `localhost` pings for detection — use gateway status.
- `expo-secure-store` for all key storage.

## Release config (read before tagging `mobile-v*`)

### One-time: EAS project id (`eas init`)
`app.json` intentionally has **no** `extra.eas.projectId` — we do not commit a
fake/borrowed id. Before the first release build, the owner runs once:
```bash
cd apps/mobile && eas init   # links the slug to an EAS project, writes extra.eas.projectId
```
`eas build` (and `.github/workflows/release-mobile.yml`) **cannot run a release
without it**. If you want a cheap guard, add a step to `release-mobile.yml` that
fails fast when the id is absent, e.g. before the `eas build` step:
```yaml
- run: node -e "process.exit(require('./apps/mobile/app.json').expo.extra?.eas?.projectId?0:1)"
  # or: grep -q '"projectId"' apps/mobile/app.json
```
Source: [Expo — Configuration with eas.json](https://docs.expo.dev/eas/json/),
[Expo environment variables in EAS](https://docs.expo.dev/eas/environment-variables/).

### Store submission (`eas submit`) — no creds in the repo
The `submit` block was **removed from `eas.json`** on purpose: it previously held
placeholder Apple creds (`appleId: you@example.com`, `ascAppId: 0000000000`,
`appleTeamId: XXXXXXXXXX`) which would mis-submit or fail. Per Expo guidance,
submit creds should never be committed. To re-add when real creds exist, prefer
an App Store Connect **API key** over Apple-ID/password and keep secrets in env:
```jsonc
// eas.json
"submit": {
  "production": {
    "ios": {
      "ascApiKeyPath": "./asc-api-key.p8",   // gitignored
      "ascApiKeyId": "...", "ascApiKeyIssuerId": "...",
      "appleTeamId": "...", "ascAppId": "..."
    },
    "android": { "serviceAccountKeyPath": "./google-service-account.json", "track": "internal" }
  }
}
```
Add the `.p8` / `*-service-account.json` files to `.gitignore`; for CI pass
`EXPO_APPLE_APP_SPECIFIC_PASSWORD` (or the ASC API key) via repo secrets, not the
repo. Source: [Expo — Submit to the Apple App Store](https://docs.expo.dev/submit/ios/),
[Expo — local credentials](https://docs.expo.dev/app-signing/local-credentials/).

### Android output: AAB for store, APK for QA
`eas.json` `production.android.buildType = "app-bundle"` → produces an **AAB**,
the format Play requires for new apps/updates (APK is rejected on the store).
The `preview` profile keeps `buildType: "apk"` for direct-install/sideload QA.
Don't flip production back to `apk`. (Target API level: new Play apps must target
Android 16 / API 36+ by **Aug 31 2026**.)

### Version
`app.json` `version` is **0.2.0** (aligned with the repo's 0.2.0 line). Bump it
per release. Build numbers auto-increment via `eas.json` `production.autoIncrement`
(versionCode/buildNumber tracked remotely, `cli.appVersionSource = "remote"`).

### Release workflow vars / assets
- `.github/workflows/release-mobile.yml` (tag `mobile-v*` or manual dispatch)
  reads repo **vars** `EXPO_PUBLIC_VALIDATE_URL`, `EXPO_PUBLIC_RELAY_URL` and
  **secret** `EXPO_TOKEN`.
- `EXPO_PUBLIC_VALIDATE_URL` → deployed web `/api/validate` (worker/Vercel URL).
  Used by `lib/limits.ts`; defaults to `http://localhost:3000/api/validate` for
  local dev. Set it as a build-time env (`EXPO_PUBLIC_*` is inlined at build).
- `EXPO_PUBLIC_RELAY_URL` → Zintus Cloud relay (`lib/cloud.ts`); defaults to
  `https://relay.zintus.ai`. Only set the var to override (staging/self-host).
- The `eas-submit` job uploads the latest build to the stores
  (`eas submit --platform all --profile production --latest`). It runs only when
  repo var `MOBILE_SUBMIT_ENABLED == 'true'` and `EXPO_TOKEN` is set, so a repo
  without store creds skips cleanly; it's a separate job from `eas-build`.
- `assets/` already contains every file `app.json` references: `icon.png`,
  `splash-icon.png`, `notification-icon.png`, `favicon.png`, and the three
  `android-icon-*` adaptive-icon layers — verified present, nothing missing.

## Known: `expo-doctor` duplicate native deps (false-positive)

`expo-doctor` reports **duplicate native module dependencies** (same-version
copies of `expo`, `expo-constants`, `expo-font`, etc. in Bun's content-addressed
store). This is a **Bun/Expo compatibility artifact, not a real duplicate**:
the copies are the same version, forked only by Expo 56's circular peer graph,
and they resolve to distinct `.bun` store paths. **Reinstall does not fix it**
(the store regenerates deterministically; Bun has no `dedupe`), and `overrides`
can't collapse same-version copies. Run the check from the app dir
(`bun run doctor:mobile`, or `cd apps/mobile && npx expo-doctor`) — from the repo
root it also fails the Metro check because the `expo` CLI bin isn't on PATH there.

**Resolution:** Run `eas build --profile preview` after `eas login` to confirm
autolinking succeeds in EAS's managed environment. If the build passes, this
warning is a confirmed false-positive and can be suppressed.

**Status:** Unverified pending first EAS build. JS/TS gate is green; this is
strictly a native-autolinking question only a real build can answer. See
`apps/mobile/README.md` → "expo-doctor notes" for the full diagnosis.

## When you're done
- [ ] `bun run typecheck` (mobile) — 0 errors
- [ ] `bun run doctor:mobile` — 20/21 (only the known duplicate-deps false-positive)
- [ ] `npx expo start` — loads on a device / Expo Go
- [ ] PR opened, not merged
