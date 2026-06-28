# Phase 0 — From-disk audit: **Android + iOS** (apps/mobile)

Date: 2026-06-28 · Auditor columns: **Android** and **iOS** · Read-only (git only, no branch switch).
Monorepo `/Users/yashwanthsurabhi/Projects/zintus`. Audit branch context `feat/zintus-10-10`.

> **One codebase, two stores.** Mobile is a single Expo / React Native app (Expo SDK 56,
> RN 0.85, expo-router). Android and iOS run the **same JS/TS** — so a capability's
> code status is identical across the two columns. The columns diverge **only** on
> native config / device blockers (iOS ATS vs Android cleartext, store/EAS). Each row
> below gives one code status (shared) plus per-platform device caveats where they differ.

## Two branches — which app is "real"

- **`feat/zintus-10-10` (THIS branch) = the BASIC app.** Plain chat (no markdown, no moat
  footer), provider control center, BYOK key push, cloud/relay pairing, usage. No history,
  projects, research, attachments, Private Mode, or rich composer.
- **`feat/mobile-serious-app` = the SERIOUS app.** Adds the chat-parity layer: markdown
  renderer, per-response "intelligence" footer (provider/route reason/Tokzen savings/quota),
  conversation history, projects, deep research, file attachments (text-only), Private Mode,
  onboarding, one-tap local runtime. **This is the app to benchmark.**

Read the serious app with `git show feat/mobile-serious-app:apps/mobile/<path>` (do NOT switch).

## (1) True divergence

`git rev-list --left-right --count origin/main...feat/mobile-serious-app` → **`80  7`**.

- Merge-base `7c50799` dated **2026-06-26** (2 days ago). origin/main has moved **80 commits**
  since; `feat/mobile-serious-app` carries **7** mobile-only commits on top of that stale base.
- The 7 serious commits (`git log origin/main..feat/mobile-serious-app`):
  `228232c` moat footer+composer+history · `927767a` onboarding/research/history ·
  `d195ae8` providers center + Private Mode · `eed0863` file attachments (on-device text) ·
  `3b605d0` Projects + one-tap local runtime · `7a7a52b` docs (voice fallback/doctor) ·
  `0f0399e` docs scoping deferred image input (#5).
- **Risk:** the serious app's 7 chat-parity commits are **not on the path to main** and sit on
  a base now 80 commits stale (main has since landed billing/test/typecheck/engine fixes —
  `bbd7a85`, `8fbd44f`, `1644e80`, `d0d4e27`, `6bcd097`…). They must be rebased onto current
  main; the basic-app foundation (cloud, key-push, providers, remote) already exists on BOTH
  branches, so the rebase is the 7 commits' *additive* files, but `app/index.tsx`,
  `lib/chat.ts`, `package.json`, `app.json` are touched on both and will conflict.

## (2) Chat parity (serious app)

| Composer / chat element | Status | Evidence |
|---|---|---|
| Markdown render | ✅ | `components/Markdown.tsx` (hand-rolled: headings, bold/italic, code+Copy, lists, tables, quotes, links); used by `ChatMessageBubble.tsx:965` only AFTER stream completes (mid-stream is plain text). |
| Image picker / camera | ❌ | No `expo-image-picker`/camera dep (`package.json`). Attachment `＋` is a **text-file picker only**; images/PDF flagged `unsupported` (`lib/attachments.ts:605`, `app/index.tsx:401`). Honestly DEFERRED in `BUILD-STATUS.md:34`. |
| Voice input | 🟡 | 🎤 button is a **placeholder** that opens an "On-device dictation isn't enabled in this build yet" alert (`app/index.tsx:471` `voiceUnavailable`). Honest fallback, no real dictation; no `expo-speech-recognition` dep. |
| Provider picker | ✅ | Chip in header + composer routes to `/providers` (`app/index.tsx`); `components/ProviderSheet.tsx`; one-shot override on long-press Send (`setOverrideVisible`). |
| Route reason | ✅ | `ResponseFooter.tsx:1168` renders `routeOptions.reason` from `GET /v1/route/options`. |
| Compression footer (moat) | ✅ | `ResponseFooter.tsx` "Tokzen −N%", original→compressed tokens, $ saved, "≈ cheaper than Claude Sonnet" — from gateway response headers + `metadata` SSE frame (`lib/chat.ts:323,448`). |
| Tool-call display | ❌ | No `tool_call`/tool-result rendering anywhere in `apps/mobile`. |
| Quota / reset | ✅ | `ResponseFooter.tsx:1150` % free-tier left + reset ETA + colored dot; `components/QuotaBar.tsx`. |
| Low-quota actions | ✅ | BYOK-only chips (compress/switch/local/wait) — **no paid overflow** (`lib/route-options.ts:13`). |
| Privacy / consent | ✅ | Pre-send consent modal (Apple 5.1.2(i)) `app/index.tsx:380`; Private Mode `block_training` (`lib/chat-mode.ts`, `lib/data-flow.ts`). |
| Report response | ✅ | In-chat report (Play Gen-AI / Apple 1.2) `app/index.tsx:441`. |

Basic app (THIS branch) chat = plain `<Text>` bubbles, no markdown/footer/consent/attachments
(`app/index.tsx`, `lib/chat.ts` — no `ResponseMeta`).

## (3) Known blockers — 🔒 device track

| Blocker | Status | Evidence / fix |
|---|---|---|
| **Streaming** | 🔒 **device** (codeable) | BOTH branches use `response.body.getReader()` (`lib/chat.ts:407`, `lib/research.ts`). RN's global `fetch` does **not** expose a readable `body` stream; **no `expo/fetch` import anywhere** (grep empty). On device, `response.body` is null → throws "Gateway returned no response body", or buffers with no streaming. **Fix is codeable:** swap to `import { fetch } from "expo/fetch"` (SDK 56 streaming fetch) — but only verifiable on a dev build → device track. |
| **Android cleartext** | 🔒 **device** (codeable) | `app.json` Android block has **no** `usesCleartextTraffic`/network-security-config. Gateway is LAN HTTP (`http://<lan-ip>:port`), so RN **release** builds block it on Android. Fix codeable (`android.usesCleartextTraffic:true` or domain config) but device-verified. iOS is fine (see §4). |
| **EAS projectId** | 🔒 **device** | `app.json` has **no** `extra.eas.projectId` and **no** `owner`. EAS build/submit will fail until set. `eas.json` profiles exist. Pure device/account track. |
| Notifications | 🔒 device | `expo-notifications` configured; push needs EAS creds + device. |

## (4) iOS specifics

- **ATS:** `app.json` ios.infoPlist → `NSAppTransportSecurity.NSAllowsLocalNetworking:true` +
  `NSLocalNetworkUsageDescription` set. LAN HTTP gateway works on iOS without the Android
  cleartext problem. ✅
- **Encryption-exempt:** `ITSAppUsesNonExemptEncryption:false` set → no annual self-classification
  prompt at submit. ✅ (Note: app *does* ship x25519 E2E crypto via `@zintus/crypto-e2e`; the
  exempt flag is the standard "only standard/exempt crypto" claim — fine for HTTPS/standard, but
  worth a legal/export glance given bespoke crypto.)
- **Bundle id** `com.zintus.app`, supportsTablet. No `NSCameraUsageDescription` /
  `NSMicrophoneUsageDescription` — correct (no camera/mic shipped yet); MUST be added before
  image/voice ship (`TESTING.md:140`).

## (5) False / overstated claims

- **None egregious** — the serious app is unusually honest (image input openly DEFERRED in
  `BUILD-STATUS.md`; voice is an explicit "not enabled yet" fallback, not a fake button).
- **Watch items:**
  - **"Streaming chat" is overstated** until `expo/fetch` lands — `getReader()` does not stream
    on-device with RN's `fetch`. The throttled-flush UI (`STREAM_FLUSH_MS`) implies live tokens
    that likely won't appear on a real build.
  - **`EXPO_PUBLIC_GATEWAY_TOKEN`** (`lib/chat.ts:266`, gateway/research/route-options) is an
    `EXPO_PUBLIC_` var → **embedded in the shipped JS bundle**. Empty by default (so not a live
    leak), but any real value committed/CI-injected would be extractable. (Parallels the web
    fix `bbd7a85` "no gateway token in public bundle".) Flag for security review.
  - **Markdown is render-only after completion** — fine, but not "live markdown streaming."
  - **"Compare"** is only `regenerate` cycling to the *next* provider (`app/index.tsx:430`),
    not a side-by-side compare. Don't market as Compare.

## Capability matrix — Android / iOS

Code status shared (same JS). `S` = serious branch, `B` = basic/THIS branch. Device caveat noted.

| Capability | Android | iOS | Evidence / branch |
|---|---|---|---|
| chat | 🟡 | 🟡 | Works as request/response; 🔒 streaming on device (`lib/chat.ts:407`, both). S adds rich UI. |
| markdown | ✅ (S) / ❌ (B) | ✅ (S) / ❌ (B) | `components/Markdown.tsx` (S only). |
| image input | ❌ | ❌ | No picker/camera; text-only attach. DEFERRED `BUILD-STATUS.md:34`. |
| file input | 🟡 (S) / ❌ (B) | 🟡 (S) / ❌ (B) | `lib/attachments.ts` on-device **text** extraction only; PDFs/binaries `unsupported`. |
| voice input | 🟡 (S) / ❌ (B) | 🟡 (S) / ❌ (B) | Placeholder "unavailable" alert `app/index.tsx:471`. No dep. |
| tool calling | ❌ | ❌ | No tool_call send or display in `apps/mobile`. |
| structured output | ❌ | ❌ | No `response_format`/`json_schema` in mobile. |
| deep research | ✅ (S) / ❌ (B) | ✅ (S) / ❌ (B) | `lib/research.ts` + `app/research.tsx` SSE; needs gateway Tavily/Serper key. 🔒 streaming caveat. |
| compare | ❌ (regenerate≈🟡) | ❌ | `regenerate` cycles next provider (S); not true compare. |
| projects | ✅ (S) / ❌ (B) | ✅ (S) / ❌ (B) | `lib/projects.ts`, `app/projects.tsx` (S): per-project provider/instructions/private default. |
| provider keys | ✅ | ✅ | `app/providers.tsx` + `ProviderSheet` + `lib/keys.ts` (expo-secure-store). Both branches. |
| BYOK vault | ✅ | ✅ | `lib/keys.ts` (expo-secure-store) + E2E push `lib/gateway-key-push.ts` (x25519, ciphertext-only over relay). Both branches. |
| local runtime | ✅ | ✅ | Ollama/LM Studio cards from gateway `localRuntimes` (`app/providers.tsx`); S adds one-tap. Detection only — no on-phone model. |
| routing strategies | ✅ | ✅ | `lib/chat-mode.ts` (auto/fastest/cheapest/private) + Settings strategy; sent as `strategy`. Both (S richer). |
| route reason | ✅ (S) / ❌ (B) | ✅ (S) / ❌ (B) | `ResponseFooter.tsx:1168` ← `/v1/route/options`. |
| quota display | ✅ | ✅ | `QuotaBar.tsx`, `lib/quota.ts`, `app/usage.tsx`, footer (S). Both branches. |
| compression savings | ✅ (S) / ❌ (B) | ✅ (S) / ❌ (B) | `ResponseFooter.tsx` + `lib/chat.ts` `ResponseMeta` (S); Settings savings summary both. |
| usage / activity | 🟡 | 🟡 | `app/usage.tsx` live quota + savings (both); history `lib/history.ts` (S). No `/v1/activity` history feed. |
| model catalog | ❌ | ❌ | Provider-keyed only; no per-model `/v1/models` catalog UI on mobile. |
| pricing catalog | 🟡 | 🟡 | `route-options.ts` alternatives carry `estInputPer1M/estOutputPer1M`; no browsable pricing UI. |
| account / auth | ✅ | ✅ | `lib/cloud.ts` deep-link one-time-token → session cookie in **MMKV** (not AsyncStorage); `app/remote.tsx`. Both branches. |
| security | ✅ | ✅ | expo-secure-store keys, E2E x25519, MMKV session, on-device file extraction, consent gate. ⚠ `EXPO_PUBLIC_GATEWAY_TOKEN` bundle-embedded (empty default). |
| observability | 🟡 | 🟡 | `traceId` captured (`lib/chat.ts:440`) but not surfaced; latency/tokens shown in footer (S). No client telemetry. |
| billing / paid overflow | 🔒 (intentional) | 🔒 | No paid/overflow path by design — BYOK only, `MANAGED_KEYS_AVAILABLE=false` (`route-options.ts:13`). Correct absence. |
| referral / node marketplace | ❌ (intentional) | ❌ | No mobile references (correctly gated off per roadmap). |

## (6) Brutal P0–P3 toward a consistent 10/10

### Codeable (gate-able, no device/store needed)
- **P0 — Rebase the 7 serious commits onto current main.** The benchmark app sits on a 2-day-stale
  base behind 80 commits; nothing ships until it's on main. Resolve conflicts in `index.tsx`,
  `chat.ts`, `package.json`, `app.json`.
- **P0 — Promote serious→one app.** The basic chat on `feat/zintus-10-10` (no markdown/footer/
  consent) breaks the "one Zintus" consistency rule vs web. Make the serious chat the only chat.
- **P0 — Swap streaming to `expo/fetch`.** `getReader()` on RN `fetch` is the core
  correctness bug; codeable now, device-verify later. Without it "streaming chat" is a false claim.
- **P1 — Tool-call display.** Web/CLI/gateway already do tool calling; mobile shows nothing →
  consistency gap. Render tool calls/results in `ChatMessageBubble`.
- **P1 — Structured-output surface.** Mirror web's JSON/schema affordance.
- **P1 — Live markdown during stream** (currently plain text mid-stream) once streaming is fixed.
- **P2 — Model catalog + pricing UI** (Phase 1/2 dependency): per-model `/v1/models` browse,
  matching web — today mobile is provider-keyed only.
- **P2 — `/v1/activity` usage history feed** (Phase 5) to match Pro surface.
- **P3 — True Compare** (side-by-side), replacing the `regenerate`-cycles-provider hack.
- **P3 — Surface `traceId` / observability** for support parity.

### 🔒 EAS / device / store track (parallel, non-gating)
- **P0 🔒 — `extra.eas.projectId` + `owner`** in `app.json`; first EAS dev build.
- **P0 🔒 — Android cleartext** config for LAN HTTP gateway; verify on a release-style build.
- **P1 🔒 — Verify `expo/fetch` streaming** actually streams on physical Android + iOS.
- **P1 🔒 — Image input PR (#5):** multimodal `ChatMessage.content` (types→schema→providers→
  gateway→router + provider vision flag) THEN `expo-image-picker` + EXIF strip + iOS
  `NSCameraUsageDescription` + Android `RECORD_AUDIO` block (`TESTING.md:140`).
- **P2 🔒 — Voice:** `expo-speech-recognition` in a dev/preview build; mic purpose strings; never auto-send.
- **P2 🔒 — Security review** of `EXPO_PUBLIC_GATEWAY_TOKEN` bundle exposure + iOS encryption-exempt
  claim vs shipped x25519 crypto.
