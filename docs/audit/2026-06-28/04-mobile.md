# MOBILE re-verification (2026-06-28)

Re-audit of `apps/mobile` (iOS + Android) on branch `feat/multimodal-image-input`
@ HEAD `6bcd097` (2026-06-28). Independent re-check of prior report
`docs/audit/2026-06-26/04-mobile.md`. Bar: **store-submittable**. Source READ-ONLY;
git read commands + `git show <branch>:<path>` used to inspect the other branch.

## BRANCH REALITY (headline) — UNCHANGED, now worse-positioned

The serious mobile app is **still not on this checkout.** It lives only on
`feat/mobile-serious-app`, which has now **diverged** from the line of development:

- `git rev-list --left-right --count HEAD...feat/mobile-serious-app` → **`80  7`**.
  i.e. the current branch carries **80 commits the serious app does not have**
  (the cross-surface parity / honesty / security work), and the serious app
  carries **7 commits never merged** (the rich mobile app).
- Merge-base is `7c50799` (local `main`, 2026-06-26 15:18). The two branches
  forked there; serious-app's last commit `0f0399e` is 2026-06-26 17:26 and has
  seen **no work since**. Against `origin/main` the serious app is `80 7` as well
  (`origin/main...feat/mobile-serious-app` = `80  7`) — local `main` is itself
  stale vs origin, but the conclusion holds: serious-app is ~80 commits behind
  current development, not the "~47 behind" of the prior pass. The gap widened.
- The 7 serious-app commits (`git log --oneline HEAD..feat/mobile-serious-app`):
  `228232c` moat-in-chat + composer + history, `927767a` onboarding/Deep
  Research/history, `d195ae8` Providers control center + Private Mode,
  `eed0863` file attachments, `3b605d0` Projects + one-tap local runtime,
  `7a7a52b` voice-fallback/doctor docs, `0f0399e` defers multimodal image (#5).
- `git diff --stat HEAD feat/mobile-serious-app -- apps/mobile`: **26 files,
  +4499 / −280**. Files present ONLY on serious-app: `app/history.tsx`,
  `app/onboarding.tsx`, `app/projects.tsx`, `app/research.tsx`,
  `components/{ChatMessageBubble,Markdown,ResponseFooter}.tsx`,
  `lib/{attachments,chat-mode,consent,data-flow,history,onboarding,projects,
  provider-intel,research,route-options}.ts`, `BUILD-STATUS.md`. On
  serious-app, `app/index.tsx` is +1043/−… vs the basic 443-line screen here.

→ Every FEATURE-MATRIX mobile ✅ for stop / markdown / footer / history /
PrivateMode / keyTest / file / voice / consent / report / research / projects
remains **UNVERIFIABLE on this branch and ABSENT here.** The current branch is
still a single-screen text-chat demo. **Mobile is its own track:** none of the
80 commits of parity/security work on this branch touched the real mobile app,
and the real mobile app's branch is now badly behind. Shipping mobile means a
**branch-merge decision first**, then an **EAS release build** to certify — and
the serious-app branch carries the *same* unfixed P0s below (verified by
`git show feat/mobile-serious-app:apps/mobile/app.json`).

## VERDICT (this branch)
- **iOS: NOT submittable.** On-device streaming still relies on
  `response.body.getReader()` with no RN ReadableStream polyfill
  (`lib/chat.ts:74,78`); no pre-send consent gate (Apple 5.1.2(i)).
- **Android: NOT submittable.** Still no `usesCleartextTraffic` /
  `networkSecurityConfig` → a release build (API 28+ default) cannot reach the
  `http://LAN:8788` gateway → non-functional. No AI-output report control.

## Classification of prior mobile P0/P1/P2

### P0
- **Streaming broken on device — STILL-OPEN (this branch; same on serious-app).**
  `lib/chat.ts:53` calls the global `fetch` (not `expo/fetch`); `:74` throws
  "Gateway returned no response body" when `response.body` is null; `:78`
  `response.body.getReader()`. React Native's `fetch` does not implement
  `Response.body`/`ReadableStream`. Grep across `apps/mobile` (excl.
  node_modules) for `ReadableStream|polyfill|expo/fetch|react-native-fetch-api|
  web-streams` → **zero hits.** `app/_layout.tsx` polyfills only
  `react-native-get-random-values`. No unit test covers the stream path (the
  passing test only checks URL resolution). **High confidence broken; needs an
  on-device/EAS build to make 100% certain.** Fix: `expo/fetch` streaming, or
  `react-native-fetch-api` + `react-native-polyfill-globals`.
- **Android cleartext — STILL-OPEN.** `app.json:21-28` (android block) has no
  `usesCleartextTraffic` and no `expo-build-properties` plugin / network-security
  config. `git show feat/mobile-serious-app:apps/mobile/app.json` → same gap, so
  the "real" app does not fix it either. Won't surface in an Expo dev client;
  only a release build exposes it. Fix: `expo-build-properties`
  `android.usesCleartextTraffic:true` (or an RFC1918-scoped network config).
- **No consent gate — STILL-OPEN (this branch).** Grep `consent|Consent` across
  `app/` + `lib/` → **zero hits.** `app/index.tsx:88 send()` calls `streamChat`
  directly; the first message hits a 3rd-party provider with zero disclosure
  (Apple 5.1.2(i) risk). `lib/consent.ts` exists only on serious-app — FIXED
  there, ABSENT here.

### P1
- **Play Gen-AI report control missing — STILL-OPEN.** No report-AI affordance in
  `app/index.tsx`; `ResponseFooter.tsx` (which the prior pass tied to this) is
  serious-app-only.
- **Providers key flow misleads local/LAN users + reviewers — STILL-OPEN.**
  `components/ProviderSheet.tsx:97 saveKey()` → `pushKeyToGateway`
  (`lib/gateway-key-push.ts:54`), which at `:63-65` calls `resolveSessionId()`
  and returns `"Not connected to Zintus Cloud"` when no cloud session exists.
  Local mirror (`setApiKey`, `:91`) runs **only after** a successful cloud push.
  On a pure local-LAN gateway, "Add key" (`providers.tsx:206`) cannot save in
  the primary local-first path — the BYOK happy-path is dead without Zintus Cloud.
- **VALIDATE_URL default `http://localhost:3000` — STILL-OPEN.** `lib/limits.ts:11-12`
  default `http://localhost:3000/api/validate` = the phone itself on-device.
  Works only via the `createProvider().validateKey` fallback in
  `lib/validate.ts:23` (catch branch) — and that fallback puts the plaintext key
  on whatever validate path runs. Honest fallback, but the default is wrong for
  a device.

### P2
- **Unbounded 5s health poll — STILL-OPEN.** `app/index.tsx:58`
  `setInterval(..., 5000)` not `AppState`-scoped → polls in background → battery.
- **Copy uses Share, not clipboard — STILL-OPEN.** `app/index.tsx:82`
  `Share.share({ message })` instead of `Clipboard.setStringAsync`.

### Other prior findings
- **Stop generation MISSING — STILL-OPEN.** `app/index.tsx` composer (`:282-311`)
  has Send only; `send()` (`:111`) calls `streamChat` **without** a `signal`,
  though `streamChat` (`lib/chat.ts:28`) accepts one. No abort path in the UI.
- **Markdown / footer / history / projects / research MISSING — STILL-OPEN here**
  (plain `<Text>` at `app/index.tsx:246`). FIXED on serious-app only.
- **Image/file/voice input MISSING — STILL-OPEN here** (no picker, no
  `lib/attachments.ts`). FIXED on serious-app only.
- **No standalone key TEST — STILL-OPEN.** Only validate-on-save
  (`ProviderSheet.tsx:87`).
- **Remote SSE live feed no-ops — STILL-OPEN (honest).** `app/remote.tsx:106`
  `typeof EventSource !== "undefined" ? EventSource : null` — undefined in RN
  Hermes, no `react-native-sse` dep → live updates dead; one-shot fetch works.

### NEW / REGRESSED
- No regressions found in the basic app vs the prior pass — the code is
  byte-stable on the same blockers (line numbers shifted by ≤4: prior `chat.ts:74`
  → now `:74/:78`; substance identical).
- **NEW (positioning):** the serious-app branch's staleness grew from ~47 to ~80
  commits behind, so a future merge will be a larger conflict surface against the
  parity/security work — a real, growing integration risk, not just a deferral.

## ATS / CLEARTEXT
- **iOS configured ✅:** `app.json:13-19` `NSAllowsLocalNetworking:true` +
  `NSLocalNetworkUsageDescription`; `ITSAppUsesNonExemptEncryption:false` set
  (counsel-gated — x25519 key push is not auto-exempt; confirm with legal).
- **Android NOT configured 🔴** — the single biggest Android blocker; unchanged on
  both branches.

## EAS BLOCKERS — all STILL-OPEN
- **No `projectId`.** Grep `projectId|extra` in `app.json`/`eas.json` → none.
  `eas.json:4` `appVersionSource:"remote"` *requires* a linked project →
  `eas build` fails. Run `eas init` (needs Expo login). [HUMAN]
- **No `submit` block in `eas.json`** → no Apple ASC app id / Google service-account
  JSON. [HUMAN]
- Bundle IDs `com.zintus.app` (iOS + Android), scheme `zintus`. Icons real-sized
  except `assets/notification-icon.png` = **216 B** (likely a stub).

## TESTS RUN
- `bun test apps/mobile/lib/gateway-url-resolve.test.ts` → **6 pass / 0 fail**
  (11 expects). This only proves URL *resolution* (`lib/gateway-url-resolve.ts`
  is intentionally RN-free for bun testability). It does **not** exercise the
  network/stream path — the actual P0. No automated coverage exists for streaming,
  consent, cleartext, or key-push; all require an **on-device / EAS release build**.

## ONLY AN EAS/DEVICE BUILD CAN VERIFY
- Whether streaming actually yields tokens on Hermes (the `response.body` failure)
  or silently throws.
- Whether an Android **release** APK/AAB can reach the cleartext LAN gateway.
- Consent-gate presence at runtime, deep-link auth exchange, iPad layout,
  notification icon rendering, and that `eas build`/`submit` even start (they
  cannot today without `projectId` + submit creds).

## HUMAN-only
Xcode + CocoaPods (this env is CLI-only), Apple Developer + Google Play accounts,
`eas init` (Expo login) + submit credentials, encryption-export counsel for the
x25519 push (`ITSAppUsesNonExemptEncryption`), a live privacy URL + a demo
gateway for review. **DECISION required:** ship the basic branch, or merge
`feat/mobile-serious-app` (now ~80 commits behind, carrying its own unfixed P0s
above) before any store push.

---

## VERDICT (one paragraph)
Re-verified: nothing material changed for mobile since 2026-06-26, and the branch
situation degraded. This checkout is still the **basic single-screen demo** — no
stop, no markdown, no history/projects/research, no attachments, no consent gate
— while the "serious" app remains stranded on `feat/mobile-serious-app`, now
**~80 commits behind** the current line of work (up from ~47) and itself still
carrying every release-blocking P0. All three P0s are STILL-OPEN on the shippable
branch: on-device streaming is almost certainly broken (`lib/chat.ts:74,78`
`response.body.getReader()`, zero RN ReadableStream/`expo/fetch` polyfills
anywhere), Android cleartext is unconfigured in `app.json` (so a release build
can't reach the LAN gateway — true on *both* branches), and there is no pre-send
consent gate (`grep consent` → nothing). The one green test
(`gateway-url-resolve`, 6/0) only proves URL math and gives false comfort.
EAS itself is dead on arrival (no `projectId`, no `submit` block). **Mobile is
NOT store-submittable on iOS or Android, it is a distinct track requiring a
branch-merge decision plus an EAS release build to certify, and the cost of that
merge is rising every week it is deferred.**
