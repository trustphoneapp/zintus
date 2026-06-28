# MOBILE re-verification — post tool/structured build (2026-06-28)

Re-audit of the MOBILE track after the tool-calling / structured-output build.
Branch `feat/tool-calling` (HEAD `6bcd097`, same tip as `feat/multimodal-image-input`);
the tool/structured work is **uncommitted in the working tree** (`packages/types` modified).
READ-ONLY. Supersedes the deltas in `../04-mobile.md` + `../11-design-mobile.md`.

## Scope of the type-system change inspected
Working-tree diff to `@zintus/types` (uncommitted) adds, in `route.ts`:
`ToolCallContentBlock` / `ToolResultContentBlock` (route.ts:32,43), widens
`ContentBlock` to a **4-way union** (route.ts:53-58, was Text|Image), plus
`JsonSchema`/`ToolDefinition`/`ToolChoice`/`ResponseFormat`/`ResolvedResponseFormat`
(route.ts:69-128) and tool fields on the request/result types. `stream.ts` adds
`tools?`/`responseFormat?` to `StreamChatOptions` and `toolCall?` to `StreamChunk`
(stream.ts:24,30,71). All re-exported via `index.ts:23-52`.

## (1) Does the widened type surface raise mobile rebase cost? — **UNCHANGED**
No. Mobile consumes **none** of the new surface.
- `git grep` for `StreamChunk|ContentBlock|ToolCall|ToolResult|ResponseFormat|ToolDefinition|isContentBlockArray|imageCount|requiresVision` across `feat/mobile-serious-app:apps/mobile` → **zero hits**. The serious app's `chat.ts:1-6` imports only `ChatMessage, ContextMode, ProviderId, RoutingStrategy`; it parses SSE by hand and never touches `@zintus/types` `StreamChunk`.
- Both apps read `content` only as text. `textOf()` (route.ts:44) filters `type === "text"` and silently ignores the two new tool block variants, so the 2→4 `ContentBlock` widening adds **no new narrowing obligation** to mobile.
- The rebase cost is therefore still wholly dominated by the **original** `ChatMessage.content: string → string|ContentBlock[]` change (already adapted on `feat/tool-calling` in `messages.ts` via `textOf`, messages.ts:1,36). The tool/structured additions are **orthogonal and additive** to the mobile-consumed surface — they do not widen it. M0 rebase cost from `11-design-mobile.md` stands unchanged.

## (2) Is mobile still entirely its own track? — **UNCHANGED**
Yes. `git status --porcelain | grep apps/mobile` → **NONE**; the tool/structured build touched only `packages/types` (+ web/cli/gateway). Divergence vs the real app is **still 80/7** (`git rev-list --left-right --count HEAD...feat/mobile-serious-app`), merge-base still `7c50799`. No mobile code on this branch, committed or working-tree.

## (3) Does the basic app still typecheck? — **UNCHANGED (green)**
`bun run --filter '@zintus/mobile' typecheck` → **Exited code 0** against the widened working-tree types. The 4-way `ContentBlock` / new `StreamChunk.toolCall` do not break the basic app (it never references them). Mobile remains in the typecheck filter (`package.json:12`).

## (4) Launch blockers — all STILL-OPEN, all [HUMAN]/device — **BLOCKER**
Re-confirmed on `HEAD:apps/mobile` (basic app; same gaps on serious-app per prior audits):
- **Streaming on device — BLOCKER.** `chat.ts:53` global `fetch`, `:74-75` no-body throw, `:78` `response.body.getReader()`; no `expo/fetch`/polyfill. Almost certainly dies in a release JS engine. Device/EAS-only to certify.
- **Android cleartext — BLOCKER.** `app.json` has no `usesCleartextTraffic` / `expo-build-properties` (grep empty) → release build can't reach `http://LAN:8788`.
- **EAS dead on arrival — BLOCKER/[HUMAN].** `app.json` no `extra.eas.projectId`; `eas.json` `appVersionSource:"remote"` + no `submit` block → `eas build` fails without `eas init` (Expo login).
- Consent gate / Play AI-report / encryption-export counsel: unchanged from `11-design-mobile.md`.

## VERDICT
The tool/structured build changed the MOBILE picture in **no** material way. It widened
`@zintus/types` but only along axes mobile never consumes, so rebase cost, track
isolation, and the basic-app typecheck are all **UNCHANGED**; the three launch
blockers (streaming, Android cleartext, EAS wiring) remain **open and [HUMAN]/device-gated**.
Net: **UNCHANGED** on (1)(2)(3); **BLOCKER** stands on (4).
