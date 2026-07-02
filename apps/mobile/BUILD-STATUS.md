# Zintus Mobile — "Serious AI App" build status

Branch `feat/mobile-serious-app` (merged to main). Tracks the upgrade from basic
text chat to a serious cross-platform (Android + iOS) AI app.

## Store-readiness pass (2026-07-02) — see `STORE-SUBMISSION.md`
- **Real branded app icon** (was a blank purple square → guaranteed rejection):
  regenerated iOS `icon.png`/`adaptive-icon.png` as the purple-gradient +
  chevron mark, 1024² opaque.
- **Minimal Android permissions** (`POST_NOTIFICATIONS` only) + a
  `blockedPermissions` denylist for camera/mic/location/media/contacts/overlay
  (Play "unused permission" fix — the app genuinely uses none).
- **iOS privacy manifest** (`NSPrivacyTracking:false`, no collected data,
  required-reason API entries) — Apple-required since 2024.
- **Contextual notification permission**: no cold-launch request; a
  Settings → Notifications opt-in requests it on tap; notify paths gate on the
  opt-in + granted state.
- **eas.json** gains a `submit.production` block ([HUMAN] credentials).

## Verification gates (run before calling anything done)
- root `bun run typecheck` (all packages + web/desktop/mobile) — **EXIT 0**
- `bun test apps/mobile/lib/gateway-url-resolve.test.ts` — **6/6**
- `bun run doctor:mobile` (`npx expo-doctor`) — **20/21 passed, EXIT 1**.
  (2026-07-02: the "patch version mismatches" check — expo/expo-constants/
  expo-notifications/expo-router/expo-splash-screen — is now GREEN after
  aligning those 5 to the SDK-56-expected patch ranges in package.json; that
  was a genuine fix, 2 failing checks → 1.) The one remaining
  failure is "no duplicate dependencies": bun's workspace symlink layout exposes
  multiple links to the SAME versions of expo / expo-font / expo-linking /
  expo-constants / expo-modules-core / @expo/dom-webview / @expo/log-box /
  expo-file-system. Same version (not a conflict) → Metro resolves one copy and
  EAS de-dupes on prebuild, so it's the benign kind. Pre-existing (the list is
  dominated by packages that predate the file-input deps). **Proof of harmless =
  a successful EAS build [HUMAN].**
- EAS Android + iOS preview builds + real-device smoke — **[HUMAN]** (accounts/devices)

## Feature status
| # | Feature | Status | Notes |
|---|---------|--------|-------|
| 4 | Intelligence footer (mandatory) | DONE | headers + metadata SSE frame → ResponseFooter under every answer; route/options actions |
| 3 | Message rendering | DONE | dep-free Markdown (headings/lists/tables/code+copy); copy/retry/regenerate/report |
| 2 | Production composer | DONE | multiline, Stop, mode+provider chips, long-press override, offline-disabled, KAV |
| 1 | Onboarding | DONE | 5-step first-run; gateway+key+sample; persisted; skippable |
| 9 | Conversation history | DONE | expo-sqlite store + list/search/rename/delete/continue |
| 8 | Deep Research | DONE | /v1/research SSE stages, source cards, export, save-to-history (needs gateway search key) |
| 11 | Private Mode | DONE | header shield toggle (persisted block_training) + tradeoff explainer + composer Private mode; provider training badges |
| 12 | Providers control center | DONE | Test button, est-cost (pricing catalog), route/options recommendation + cheapest alt; training badge; key add/update/remove |
| 13 | Local runtimes | DONE (one-tap) | "Use <runtime> (on-device)" button routes chat to local; detection still via cloud session (local /v1/status lacks runtime list — gateway gap, noted) |
| 10 | Projects/workspaces | DONE | lib/projects.ts + screen: create/edit/delete, instructions→system message, default provider/private, per-project chat list |
| 6 | File input | DONE (text formats) | expo-document-picker + expo-file-system; on-device text extraction → string schema; chips + privacy notice. PDF/binary flagged unsupported on-device (honest) |
| 7 | Voice dictation | FALLBACK shipped | spec-required "unavailable fallback" is in (honest message, never auto-sends). Full STT = add expo-speech-recognition to a dev/preview build + purpose strings — [HUMAN]/EAS (can't verify a device speech session here) |
| 5 | Image input | DEFERRED (own PR) | scoped in `docs/multimodal-image-plan.md`: needs multimodal ChatMessage.content (types+schemas+providers+gateway+router) + a provider vision-capability field BEFORE any client UI is meaningful; then expo-image-picker + EXIF strip. A picker button alone would be non-functional, so intentionally not shipped |

## Compliance work folded in (from store research)
- Apple 5.1.2(i): pre-send consent gate before first provider send — DONE (lib/consent.ts).
- Play Gen-AI / Apple 1.2: in-app "report/flag AI response" control — DONE (chat action).
- Battery: focus+AppState-scoped health poll w/ backoff + abort, cancellable streaming,
  throttled+memoized list — DONE (see docs/agents/MOBILE.md).

## Sandbox constraints
- Direct `npx expo install` times out (RN Directory check); npm registry itself is reachable,
  so deps install via `bun add <pkg>` with an SDK-56 version. Native modules can't be
  EAS-built/verified here — that's [HUMAN]/EAS.
- Kept the app dep-light on purpose (hand-rolled Markdown instead of markdown-it).

## [HUMAN] / decisions still open
- Play target API 36 before 2026-08-31 (currently SDK 56 default) — confirm via EAS output.
- iOS `ITSAppUsesNonExemptEncryption`: app does its own x25519 key push, so `false` is
  NOT automatically correct — counsel call (see docs/store/ios-listing.md §4).
- Reviewer demo path (app is non-functional without gateway+key) — stand up a demo gateway
  or built-in demo mode (docs/store/review-notes.md).
- iOS purpose strings + Android permissions/blockedPermissions land with image/file/voice.
- Privacy policy naming providers + retention must go live.
