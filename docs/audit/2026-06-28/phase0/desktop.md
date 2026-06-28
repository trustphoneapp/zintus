# Phase 0 — From-disk audit: **Desktop** (apps/desktop + src-tauri)

Branch `feat/zintus-10-10`. Read-only. Desktop is **allowed its own native idiom**
(Tauri webview over a static Next export) but must surface the same TRUTHS as web.
Legend: ✅ real (code + UI/API path) · 🟡 partial/unverified · ❌ absent · 🔒 gated
(needs native build / signing / device — not codeable in the webview path).

> Architecture truth: desktop is **gateway-only**. All routing/quota/cooldown/cost
> accounting live in the gateway (single source of truth shared with CLI). The
> webview never runs a router (`lib/chat-client.ts:81-119`, `lib/providers.ts:26-55`).
> Provider keys are the ONE place the desktop owns native state — via the Rust
> keyring commands, which only execute inside a real Tauri build.

## Capability matrix

| Row | Status | Evidence |
|---|---|---|
| chat | ✅ | `app/_components/ChatPanel.tsx:269-313` send → `streamChat` → `lib/gateway.ts:365` SSE stream; threads in `lib/store.ts:129` |
| markdown | ✅ | `MessageBubble.tsx:171-177` renders `Markdown`; `app/_components/Markdown.tsx` |
| image input | ❌ (honest) | `ChatPanel.tsx:38-39` TEXT_EXT excludes images; `:98-119,533-538` image files set `imageNotice` "Images aren't supported yet"; gateway 422 vision refusal handled `:236-249` + `gateway.ts:284-297`. No image content block reaches a provider. |
| file input | 🟡 | Hidden `<input type=file>` text-only extract on-device `ChatPanel.tsx:549-559,98-119`; rendered as fenced `[File: …]` blocks `:47-51`. No native dialog; `tauri.conf.json` `dragDropEnabled:false` so no drag-drop. Browser-input idiom, unverified in WKWebView. |
| voice input | ❌ | No mic/speech/STT anywhere (grep: none). |
| tool calling | ✅ | Tools toggle persisted `ChatPanel.tsx:87-92,439-464`; bounded 5-round execute→feed-back loop `:137-229`; 3 local browser-safe tools `lib/web-tools.ts:157-213`; tool-call cards `MessageBubble.tsx:52-83,185-199`. Tests: `lib/web-tools.test.ts`. Real round-trip. |
| structured output | 🟡 | Display-only: auto-detects a JSON-only answer and renders a "JSON output"/"Structured output" code block `MessageBubble.tsx:42-50,151-204`. No `response_format`/`json_schema` request UI; ChatPanel never passes the `structured` prop. Cannot *request* structured output. |
| deep research | ✅ | `app/research/page.tsx` full multi-stage (plan→search→read→synthesize→answer) with cited sources + export; `lib/research.ts` via gateway; requires gateway search key. |
| compare | ❌ | No side-by-side/multi-provider compare UI. Only a single provider override `<select>`. |
| projects | ✅ | `app/projects/page.tsx` (CRUD, instructions, default provider, private default); injected as leading system msg `ChatPanel.tsx:272-277`; `lib/projects.ts`. |
| provider keys | 🔒 | Code-fix landed: `lib/tauri.ts:24-65` calls real `invoke("keyring_get/set/delete")`; Rust commands `src-tauri/src/lib.rs:18-41`; `SERVICE="zintus"` matches gateway `:12`; `Cargo.toml:17` keyring v3 native; capability grants `core:default`. UI `ProvidersScreen.tsx:23-46`. **Needs a native Rust build to execute** — in the static `out/` webview `isTauri()` is false and `getKey` returns null (`tauri.ts:32-42`). Commit `d0d4e27`. Unverified without device build. |
| BYOK vault | 🔒 | The vault IS the OS keyring above — same 🔒. macOS Keychain / Win Credential Mgr / Secret Service via keyring crate `Cargo.toml:17`. |
| local runtime | 🟡 | ollama/lmstudio always `hasKey=true` `tauri.ts:67-72`; appear in provider list `providers.ts:38`; embedded terminal can launch them `TerminalPane.tsx:85-94`. No local-runtime cards / start-stop / model pull UI. |
| routing strategies | ✅ | fastest/capability/economy in chat `ChatPanel.tsx:465-476` + settings `app/settings/page.tsx:9-30`; sent to gateway `gateway.ts:411`. |
| route reason | 🟡 | `routed → {provider}` badge `ChatPanel.tsx:387-391`; "via {strategy}" meta strip `MessageBubble.tsx:208-211`; RouteOptions reason on cooldown/low-quota `RouteOptionsPanel`. No persistent top-of-answer "why this route" explainer. |
| quota display | ✅ | `QuotaBar` on Providers + Usage `ProvidersScreen.tsx:147`, `usage/page.tsx:118`; from gateway `/v1/status` `gateway.ts:65-78`. |
| compression savings | ✅ | `CompressionBadge` from derived `X-Zintus-*` headers `gateway.ts:141-166`; per-response saved-vs-Sonnet `MessageBubble.tsx:218-223`; Usage aggregate `usage/page.tsx:42-60,140-187`. |
| usage/activity | 🟡 | Usage page shows live quota + savings snapshot `app/usage/page.tsx`. No historical activity timeline / per-request log (`/v1/activity` not consumed). |
| model catalog | ❌ | No model browse/filter. Provider override is a flat `PROVIDER_IDS` `<select>` `ChatPanel.tsx:413-419`; no per-model price/context/vision/tools metadata. |
| pricing catalog | ❌ | No pricing browse. Only derived per-response USD estimates appear in footer. |
| API docs | n/a | Desktop is a client; docs are a gateway concern. |
| OpenAI-compatible API | n/a | Desktop consumes the gateway's `/v1/chat/completions`; exposes no API. |
| account/auth | ❌ | No sign-in. Local-first; optional `NEXT_PUBLIC_GATEWAY_TOKEN` bearer only `gateway.ts:13-17`. |
| security | 🟡 | Strict CSP `tauri.conf.json` (script-src 'self', pinned connect-src); keyring secrets stay native; first-send consent gate `ChatPanel.tsx:593-620`, `lib/consent.ts`; Private Mode `:420-438`. No code-signing/notarization config → 🔒 (below). |
| observability | 🟡 | Gateway-offline banner `AppShell.tsx:157-199`; report-bad-response stored locally `MessageBubble.tsx:122-143`. No telemetry/metrics surface (gateway owns OTel). |
| billing/paid overflow | ❌ | None present. Consistent with no-custody/free-core; no Stripe/credits in desktop (grep: none). |
| referral/node marketplace | ❌ | None (grep: none). |

## Specifics asked

1. **Tool calling is real.** Persisted Tools toggle, bounded stateless execute→feed-back
   loop (max 5 rounds), 3 local eval-free tools, streamed tool-call reassembly
   (`gateway.ts:321-363`), and on-bubble call cards. Not API-only plumbing. ✅
2. **Image input** is **honestly refused** at two layers: client filters image files
   with an inline notice (`ChatPanel.tsx:98-119,533-538`) and the gateway's vision 422
   is rendered with provider suggestions (`:236-249`). No silent failure, no false claim.
3. **Structured output UI** is **display-only** (auto-render JSON answers). There is **no
   request path** (no `response_format`/schema toggle). 🟡 — the renderer exists but is
   dormant for actual structured-output requests.
4. **Provider-key keyring fix is in place but device-gated 🔒.** `lib/tauri.ts` now invokes
   the real Rust commands (was a dead `tauri-plugin-keyring-api` no-op); `lib.rs` registers
   them and uses `SERVICE="zintus"` so desktop-entered keys land in the same OS-keychain
   entry the gateway reads. It **cannot be exercised without `bun tauri dev`/a native build**
   — the shipped static export can't reach the keyring (`isTauri()===false`). Unit-tested
   (`lib/tauri.test.ts`) but runtime-unverified until a device build (commit `d0d4e27`).
5. **Native file dialog / export are NOT native.** No `tauri-plugin-dialog` in
   `Cargo.toml`. Export = Blob + `<a download>` (`ChatPanel.tsx:344-359`,
   `research/page.tsx:102-111`); file attach = hidden web `<input>`. These rely on
   WKWebView honoring browser download/file semantics and are **unverified** in the actual
   Tauri webview. 🟡
6. **Cockpit presence:** Providers screen is a credible **Provider Control Center** —
   connected/missing, quota bars, cooldown, and RouteOptions "why unavailable / best next
   action" (`ProvidersScreen.tsx:101-191`). **Model catalog ❌** and **activity history 🟡**
   are the cockpit gaps.
7. **False/overstated claims found:**
   - `MessageBubble.tsx:91` comment says structured output is supported, but ChatPanel
     never requests/passes it → renderer is dormant (display-only). Overstated.
   - `usage/page.tsx:30` says quota comes from "the gateway /health endpoint"; the code
     actually reads `/v1/status` (`gateway.ts:65-78`). Stale comment, not a UI lie.
   - No image/voice claims exist in UI — honesty bar held.

## Brutal priorities toward 10/10 (desktop)

**P0**
- 🔒 [HUMAN/device] **Native build + verify the keyring path end-to-end.** The single most
  load-bearing desktop feature (BYOK) is code-complete but never run in a real build. Until
  `bun tauri dev` proves `keyring_set/get` round-trips into the OS keychain the gateway
  reads, provider keys are unproven on desktop.
- 🔒 [HUMAN] **Code signing + notarization** (macOS Developer ID/notarize, Windows
  Authenticode). `tauri.conf.json` has publisher but **no signing identity**; unsigned
  builds won't launch cleanly. Blocks any real distribution.
- **Verify export + file-attach in the Tauri webview** (or switch to `tauri-plugin-dialog` /
  `fs`). Browser `<a download>` / `<input type=file>` may silently fail in WKWebView.

**P1**
- **Models Catalog UI** (❌): the biggest parity gap vs web/OpenRouter — searchable
  per-model catalog with price/context/vision/tools/local/privacy, "Use this model".
- **Structured-output request UI** (🟡→✅): add a JSON/schema toggle so the existing renderer
  is actually reachable; mirror web.
- **Activity/usage history** (🟡): consume `/v1/activity` for a request timeline, not just a
  live quota snapshot.

**P2**
- **Compare** (❌) view (multi-provider side-by-side).
- **Local-runtime cards** (🟡): start/stop/model-pull for ollama/lmstudio beyond the raw
  terminal.
- **Updater activation**: `tauri-plugin-updater` is wired but `createUpdaterArtifacts:false`
  and unsigned → 🔒 inert until signing lands.

**P3**
- Persistent top-of-answer route-reason explainer (calm-composer / Phase 6 idiom).
- Fix stale `/health` comment in `usage/page.tsx` and the structured-output comment in
  `MessageBubble.tsx`.
