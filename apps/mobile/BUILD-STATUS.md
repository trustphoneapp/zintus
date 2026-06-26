# Zintus Mobile — "Serious AI App" build status

Branch `feat/mobile-serious-app`. Tracks the upgrade from basic text chat to a
serious cross-platform (Android + iOS) AI app. Updated as the loop progresses.

## Verification gates (run before calling anything done)
- root `bun run typecheck` (all packages + web/desktop/mobile) — currently **EXIT 0**
- `bun test apps/mobile/lib/gateway-url-resolve.test.ts` — **6/6**
- `bun run doctor:mobile` — needs network; run on a connected machine
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
| 13 | Local runtimes | PARTIAL | shown via cloud session; TODO: one-tap Use Local; local /v1/status lacks runtime list (gateway gap) |
| 10 | Projects/workspaces | TODO | thread store already carries project_id |
| 6 | File input | DONE (text formats) | expo-document-picker + expo-file-system; on-device text extraction → string schema; chips + privacy notice. PDF/binary flagged unsupported on-device (honest) |
| 7 | Voice dictation | TODO (needs deps + dev client) | expo-speech-recognition + expo-audio; foreground-only; never auto-send |
| 5 | Image input | BLOCKED | needs cross-package multimodal content + provider vision-capability field, then expo-image-picker |

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
