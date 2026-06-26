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

## Battery & Performance

> Added 2026-06-26. Current guidance for **Expo SDK ~56 / RN 0.85 / Reanimated v4
> + worklets**. This app opens long-lived streaming fetches to a local gateway,
> polls health on a timer, and will add camera/audio/Deep-Research flows — every
> one of those is a battery/radio risk if done naively. Sources are dated at the
> end of this section.

### TL;DR for this app
The phone's **cellular/Wi-Fi radio is the dominant battery cost**, not the CPU.
A radio that is woken every few seconds never gets to sleep, so a 5 s health poll
costs far more than its payload suggests. The two governing rules:

1. **Do work only while the user is looking at it.** Scope timers/streams to
   screen focus (`useFocusEffect`) *and* app foreground (`AppState`), and tear
   them down on blur/background.
2. **Never keep a socket or timer alive in the background to "stay fresh".**
   Both OSes will throttle or kill it anyway (iOS suspends ~seconds after
   background; Android Doze suspends network), and a workaround (background timer,
   persistent socket, background-recording entitlement) is a **battery killer and
   a store-review/Doze red flag**. Use push (`expo-notifications`/FCM) to wake the
   app instead. [A-Doze][A-iOSbg][R-bgsvc]

---

### 1. Frequent `setInterval` polling — why 5 s is bad, and the fix
A `setInterval` poll forces a radio wake + TLS handshake on every tick. At 5 s
that is **~720 wakes/hour**; the radio's high-power "tail" (it stays in a high
state for seconds after each request) means it effectively never idles, which is
the classic mobile battery anti-pattern. Polling that continues in the background
"wastes battery and bandwidth" and should be paused. [R-appstate][R-timers]

**Recommended pattern (apply to every poller in this app):**
- **Scope to focus:** start the interval in `useFocusEffect`, not a bare
  `useEffect([])`. In a **Tabs** navigator (this app's `_layout.tsx`) blurred
  screens stay *mounted*, so a bare-`useEffect` interval keeps firing on every
  other tab forever — strictly worse than "only while focused".
- **Pause on background:** subscribe to `AppState`; clear the interval on
  `background`/`inactive`, restart (and do one immediate refresh) on `active`.
  States are `active | background | inactive`; `AppState.addEventListener('change', …)`
  returns a subscription you `.remove()` in cleanup. [R-appstate]
- **Back off when nothing's happening:** widen the period when the answer keeps
  coming back the same (e.g. 5 s → 15 s → 30 s when the gateway has been online/
  offline unchanged), reset to fast on a state change or user action.
- **Prefer event-driven over polling** where a channel exists: the `remote.tsx`
  detail screen already uses SSE (`/stream`) for live status — that's the right
  model; the 10 s `/api/sessions` list poll is the fallback, and should obey the
  rules above. For true background freshness, use a push notification, **not** a
  background timer. [A-Doze][R-bgsvc]

### 2. Streaming / long-lived fetch (SSE) — abort, don't leak
A streaming `fetch` + `reader.read()` loop holds a socket and keeps the radio in
a high-power state for the whole stream. If the user navigates away or
backgrounds mid-stream and you don't cancel, the socket leaks and the radio stays
awake until the server closes. **Always drive it with an `AbortController`** and
call `abort()` in the `useEffect`/`useFocusEffect` cleanup; ignore the resulting
`AbortError`. [R-abort][R-cleanup]

- Create `const ac = new AbortController()` per request, pass `ac.signal` to
  `fetch`, and `return () => ac.abort()` from the effect.
- On `AppState → background`, **abort in-flight chat streams** (and the health
  poll's fetch). iOS suspends the process within seconds of backgrounding and
  will tear the connection down uncleanly anyway; aborting first is cleaner and
  saves the radio tail. [A-iOSbg]
- **Deep Research (long stream):** this is the highest-risk flow. Keep the screen
  in the foreground while it runs; consider `expo-keep-awake` **only while the
  stream is active and the screen is focused**, and release it the instant the
  stream ends or the screen blurs. Do **not** try to continue a Deep-Research
  stream in the background — design it to resume/reconnect on foreground, and use
  a completion **push notification** if the user leaves. Surface progress via the
  staged events you already stream; don't add a separate progress poll.
- For background *transfers* specifically (not chat), iOS's only sanctioned path
  is a **background `URLSession`** managed by the system — not reachable from
  RN's `fetch`, another reason to keep streaming a foreground-only activity.
  [A-iOSbg]

### 3. Reanimated v4 / worklets — animation battery & list jank
The repo ships `react-native-reanimated@4.3.1` + `react-native-worklets@0.8.3`
but currently animates nothing custom (only RN `ActivityIndicator`s). Guidance
before adding animations: [SW-perf][SW-work]
- **Run animation on the UI thread** via shared values + worklets; never drive
  per-frame work from JS. **Read a `sharedValue.value` only inside a worklet /
  `useAnimatedStyle`** — reading it on the JS thread forces a thread sync and
  causes jank. [SW-perf]
- **No always-on / infinite animations.** A `withRepeat(..., -1)` loop (spinner,
  pulsing dot, gradient) runs every frame forever and prevents the UI thread from
  idling — measurable battery drain. Prefer static states or animate only on a
  transition, and **stop** loops when the element is offscreen/blurred. The
  existing "Thinking…" `ActivityIndicator` is fine because it only mounts while a
  message streams.
- **Animate non-layout props** (`transform`, `opacity`) over layout props
  (`width/height/top/left`) — layout props recalc every frame. Stay under **~100
  simultaneous animated components on low-end Android** (500 iOS). [SW-perf]
- Keep worklet bodies tiny; memoize gestures/frame-callbacks with
  `useMemo`/`useCallback`, "particularly important for `FlatList` items". [SW-perf]

### 4. Chat `FlatList` re-renders (the real per-token cost today)
During streaming, `onChunk` calls `setMessages(cur => cur.map(...))` **on every
token**, and the `FlatList` uses an **inline `renderItem`/`keyExtractor` with no
memoization** — so the entire visible list re-renders on every streamed token.
This is the most impactful CPU/jank smell that exists *right now* (Deep Research
will make it worse with high-frequency staged events). Fix per RN's FlatList
guide: [RN-flatlist]
- Extract the bubble into a `React.memo` component; wrap `renderItem` in
  `useCallback`; hoist `keyExtractor`.
- **Throttle stream→state updates** (e.g. coalesce tokens with a short rAF/timer
  buffer, ~16–50 ms) instead of `setState` per token; only the streaming bubble
  needs to update, not the whole array.
- Tune `windowSize` (default 21 → ~5–10), `maxToRenderPerBatch`,
  `initialNumToRender`; add `removeClippedSubviews` for long histories. Skip
  `getItemLayout` (chat bubbles are variable-height). [RN-flatlist]

### 5. Image capture & compression (forward-looking; not yet in deps)
When adding `expo-image-picker` / `expo-camera` / `expo-image-manipulator`:
[E-picker][E-manip]
- **Resize before upload, on-device.** Pick with a sane `quality` (e.g. 0.6–0.8),
  then `ImageManipulator.manipulate()` to cap the long edge (~1280–1920 px) and
  re-encode (WEBP/JPEG) before sending. A full-res 12 MP frame is tens of MB in
  memory and a long radio-on upload. [E-manip]
- **Don't hold full-res bitmaps in JS/state.** Work from URIs; manipulate to a new
  file and upload the file, not a base64 blob in memory (base64 inflates ~33% and
  doubles peak memory).
- Iterate quality down to a target size (e.g. ≤2 MB) rather than uploading raw.
  EXIF/orientation handling is cheap relative to the resize; do it in the same
  manipulate pass. [E-manip]
- Release the camera (unmount `expo-camera`) as soon as capture is done — an open
  camera session is a heavy power draw.

### 6. Audio recording for dictation (forward-looking; use `expo-audio`)
`expo-av` is deprecated (removed in SDK 55); use **`expo-audio`**. [E-audio]
- **Hold the mic session only for the dictation.** Start on press, **stop and
  release promptly** on finish/cancel; prefer the hook (`useAudioRecorder`/
  component lifecycle) so the session is torn down on unmount. A live mic session
  is a continuous power draw. [E-audio]
- **Do NOT enable `enableBackgroundRecording`.** Background mic recording is a
  major battery cost *and* a store-review red flag; dictation is a foreground,
  user-initiated action only. [E-audio]
- Prefer short, on-device-friendly clips; if transcription is server-side, send
  the compressed clip in one shot (radio tail) rather than streaming raw audio.

### 7. Background execution rules (battery **and** store compliance)
What this app must **not** do:
- **Android Doze** suspends network access, ignores wake locks, and defers
  `JobScheduler`/sync/alarms to brief "maintenance windows" that get rarer the
  longer the device is idle — and a **foreground service does not exempt you**
  (it prevents process death, not CPU/network throttling). So **background
  polling/sockets simply won't run reliably** and will be flagged. Use FCM/push
  for backend-initiated updates instead of a persistent connection. [A-Doze][A-power][R-bgsvc]
- **iOS** suspends the app within seconds of backgrounding; background work is
  not guaranteed and is throttled by battery/Low-Power-Mode. The only sanctioned
  background networking is a system-managed **background `URLSession`** (transfers,
  not live chat). Don't fake background liveness. [A-iOSbg]
- **Net rule for Zintus mobile:** no background timers, no background sockets, no
  background audio. All polling/streaming is **foreground + focused** only; pause
  on `AppState` background. Anything that must reach the user in the background
  goes through `expo-notifications`. This keeps the app battery-friendly *and*
  store-compliant.

### 8. Local storage — `expo-sqlite` + MMKV without thrashing
- **MMKV** (`react-native-mmkv`, used in `lib/cloud.ts`/config) is synchronous and
  cheap — correct for small hot values (session token, selected provider, config).
  Don't put large/append-heavy chat history in it.
- **`expo-sqlite`** for history: enable **WAL** (`PRAGMA journal_mode = WAL`) and
  **batch writes in a transaction** (`withTransactionAsync`) — wrapping many
  inserts in one transaction turns N disk syncs into one (orders-of-magnitude
  fewer fsyncs, less wakeup). Use **prepared statements** for repeated inserts.
  Never write a row per streamed token; persist the final message once (or
  debounce), and read with `LIMIT`/pagination for the list. [E-sqlite]

### Zintus-specific remediation checklist (prioritized, file:line)

**P0 — always-on battery drain / leaks (do first):**
- [ ] **`apps/mobile/app/index.tsx:49-63`** — health poll is a bare `useEffect([])`
  with `setInterval(refresh, 5000)` (**line 58**). In the Tabs nav it runs forever,
  even when Chat is blurred. Move into `useFocusEffect`; add an `AppState` listener
  that clears on `background`/`inactive` and refreshes+restarts on `active`; add
  **exponential backoff** (5→15→30 s) while status is unchanged.
- [ ] **`apps/mobile/app/index.tsx:52`** — `fetchGatewayHealth()` is called with **no
  signal** though `lib/gateway.ts:37-44` already accepts one. Pass an
  `AbortController.signal`; `abort()` in cleanup and on background so in-flight
  polls don't outlive focus.
- [ ] **`apps/mobile/app/index.tsx:111` + `apps/mobile/lib/chat.ts:39-65`** —
  `streamChat()` accepts `signal` but `send()` never creates/passes an
  `AbortController`, so the streaming `fetch` + `reader.read()` loop
  (`chat.ts:87-122`) **cannot be cancelled**. Hold a controller in a ref, pass
  `signal`, `abort()` on unmount/blur/background. **Critical for Deep Research's
  long stream** (socket + radio leak otherwise).

**P1 — focus/background scoping for the Remote tab:**
- [ ] **`apps/mobile/app/remote.tsx:74-79`** — 10 s `setInterval(loadSessions, 10_000)`
  (**line 77**) is a bare `useEffect`, not focus/AppState-scoped, and
  `fetchCloudSessions` (`lib/cloud.ts:81-88`) has no abort. Scope to focus, pause
  on background, add backoff, thread an `AbortSignal` through `cloud.ts`.
- [ ] **`apps/mobile/app/remote.tsx:102-142`** — SSE `EventSource` for the selected
  session closes on effect cleanup (good) but **stays open when the app
  backgrounds**. Add an `AppState` listener to `es.close()` on `background` and
  reopen on `active`.

**P2 — render cost (matters now, worse with Deep Research):**
- [ ] **`apps/mobile/app/index.tsx:117-124` + `214-280`** — per-token
  `setMessages(map)` re-renders the whole `FlatList`; `renderItem` (**line 231**)
  and `keyExtractor` (**line 217**) are inline/unmemoized. Extract a `React.memo`
  bubble, `useCallback` the `renderItem`, **throttle/coalesce** stream updates
  (~16–50 ms), and set `windowSize`/`maxToRenderPerBatch`/`removeClippedSubviews`.

**P3 — hygiene / forward-looking:**
- [ ] **`apps/mobile/lib/cloud.ts:46,82,118,130,139`** — none of the relay fetches
  take a signal; add optional `AbortSignal` params so callers (esp. the polled
  `fetchCloudSessions`) can cancel.
- [ ] **`apps/mobile/app/_layout.tsx:42`** — cold-start `setTimeout(...,300)` is a
  one-shot and **is** cleared in cleanup (line 53) — *OK, no change*, listed so it
  isn't re-flagged. The 300 ms is a heuristic, not a battery issue.
- [ ] **History store** — when chat history lands in `expo-sqlite`, enable WAL +
  batch in `withTransactionAsync`; persist final messages (not per-token).
- [ ] **Future camera/audio** — resize via `expo-image-manipulator` before upload;
  release camera/mic sessions immediately; **never** `enableBackgroundRecording`.

**Store-compliance flags (call-outs, not just battery):**
- Background mic recording (`enableBackgroundRecording`) — review red flag; keep
  dictation foreground-only. [E-audio]
- Do not add background timers / persistent background sockets / foreground
  services to keep polls or streams alive — defeated by Doze/iOS-suspension and a
  battery/review liability; use `expo-notifications` for background reach.
  [A-Doze][A-iOSbg][R-bgsvc]

### Sources (accessed 2026-06-26)
- [R-appstate] Digital Thrive — *Using AppState in React Native to Improve Performance* — https://digitalthriveai.com/en-us/resources/web-development/using-appstate-react-native-improve-performance/
- [R-timers] DEV — *Efficiently Managing Timers in a React Native App (background/foreground)* — https://dev.to/shivampawar/efficiently-managing-timers-in-a-react-native-app-overcoming-background-foreground-timer-state-issues-map
- [R-abort] DEV — *Handling HTTP Requests in React with AbortController* — https://dev.to/davidecannerozzi/handling-http-requests-in-react-with-abortcontroller-53jn
- [R-cleanup] Medium (Kulwindar Singh, Dec 2025) — *useEffect Cleanup Patterns in React Native* — https://medium.com/@saundhkulwindar/useeffect-cleanup-patterns-in-react-native-4503916faa96
- [R-bgsvc] CoderCrafter — *React Native Background Services: A No-BS Guide for 2025* — https://codercrafter.in/blogs/react-native/react-native-background-services-a-no-bs-guide-for-2025
- [SW-perf] Software Mansion — *Reanimated · Performance* (official) — https://docs.swmansion.com/react-native-reanimated/docs/guides/performance/
- [SW-work] Software Mansion — *Reanimated · Worklets* (official) — https://docs.swmansion.com/react-native-reanimated/docs/guides/worklets/
- [RN-flatlist] React Native — *Optimizing FlatList Configuration* (official) — https://reactnative.dev/docs/optimizing-flatlist-configuration
- [A-Doze] Android Developers — *Optimize for Doze and App Standby* (official) — https://developer.android.com/training/monitoring-device-state/doze-standby
- [A-power] Android Developers — *Power management resource limits* (official) — https://developer.android.com/topic/performance/power/power-details
- [A-iOSbg] AppsOnAir — *iOS Background Execution Limits: What Every Developer Must Know (2026)* — https://www.appsonair.com/blogs/background-execution-limits-in-ios-what-every-developer-must-know
- [E-manip] Expo — *ImageManipulator* (official) — https://docs.expo.dev/versions/latest/sdk/imagemanipulator/
- [E-picker] Expo — *ImagePicker* (official) — https://docs.expo.dev/versions/latest/sdk/imagepicker/
- [E-audio] Expo — *Audio (expo-audio)* (official) — https://docs.expo.dev/versions/latest/sdk/audio/
- [E-sqlite] Expo — *SQLite* (official) — https://docs.expo.dev/versions/latest/sdk/sqlite/

## When you're done
- [ ] `bun run typecheck` (mobile) — 0 errors
- [ ] `bun run doctor:mobile` — 20/21 (only the known duplicate-deps false-positive)
- [ ] `npx expo start` — loads on a device / Expo Go
- [ ] PR opened, not merged
