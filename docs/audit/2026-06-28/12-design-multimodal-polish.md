# Design — Multimodal Image Polish + Cross-Surface / Provider Gaps

Date: 2026-06-28 · Branch: `feat/multimodal-image-input` @ `6bcd097`
Scope: DESIGN ONLY. Read-only on source. This document grounds every claim in
real code (file:line) and proposes the next increment: *latest-image-focus*
polish, thumbnail UX polish, desktop/mobile image UI, and the remaining
provider-vision mapping — all capability-honest, no upsell.

## 0. Provenance check — the prior plan doc

- The roadmap referenced `docs/multimodal-image-plan.md` from
  `feat/mobile-serious-app`. That file is **not on `main`** and **not on this
  branch** (`git ls-tree main … | grep multimodal` → nothing).
- What *is* present is `docs/multimodal-image-input.md` (this branch only), the
  shipped PR1–7 record. It is the authoritative prior doc; this design builds on
  it. The surface matrix there marks **Web 🟡, CLI 🟡, Desktop ❌, Mobile ❌**
  (`docs/multimodal-image-input.md:26-31`).

---

## 1. "Latest-image-focus" — precise definition + design

### 1.1 What the term actually means in this codebase

"Latest-image-focus" is the **invariant that, across a multi-turn /
multi-image conversation, the vision model only ever attends to the image(s)
attached to the single most-recent user turn that carried images.** Earlier
images are never re-sent. This falls out of three real facts:

1. **Image bytes are never persisted.** The stored thread history keeps only
   text + image *metadata* (name/mime/bytes/dims/exif), never base64. The
   user bubble is built from `sentImageMeta` (`UiImageMeta[]`), explicitly
   "image METADATA (never base64)" — `apps/web/app/(app)/chat/page.tsx:502-516`.
   `ThreadMessage.content` is typed `string` only
   (`packages/types/src/conversation.ts:10-12`).

2. **Follow-up turns send ONLY the latest user message.** For an existing
   thread the wire payload is `[{ role:"user", content: userMessageContent }]`
   — "server owns context afterwards"
   (`apps/web/app/(app)/chat/page.tsx:541-544`; regenerate mirrors this at
   `:610-617`). So the model receives exactly the current turn's blocks; prior
   turns contribute nothing image-wise.

3. **Even the new-thread full-history path carries images on the current turn
   only.** A brand-new thread starts empty, so the first send's history is a
   single user message; that message is the only one whose `content` is a
   `ContentBlock[]` (`:489-500`). Older bubbles in `messages` are plain strings.

The in-memory `lastSentImagesRef` holds **only the most recent turn's blocks**,
overwritten on every send (`:164-167`, `:466-467`), and is the sole reason
*Regenerate* can re-send the same image (`:579-609`). After a reload it's empty,
and Regenerate honestly refuses rather than silently dropping the image
(`:583-592`, notice "Re-attach the image to regenerate this turn").

**Within a single turn**, focus = *all* images of that turn (max 4), text-first
then images in order — `buildImageMessageContent`
(`apps/web/lib/image-attachments.ts:49-54`) → Gemini `userParts` maps each to
`inlineData` preserving order (`packages/providers/src/providers/gemini.ts:20-29`).
Assistant turns are forced text-only (`gemini.ts:48-52`); images in a *system*
message hard-throw (`gemini.ts:35-41`).

### 1.2 The design for it (make the implicit invariant explicit + honest)

The behavior is correct but **invisible** — a user who attached a screenshot
three turns ago may assume the model still "sees" it. Polish, no wire changes:

- **D1.1 — Focus indicator in the composer.** When the active thread already has
  ≥1 prior image turn and the user is composing a new message *without* a fresh
  attachment, show a passive hint: "Earlier images aren't re-sent — attach again
  to ask about one." Drive it off `messages.some(m => m.images?.length)` and the
  current `attachments` count. Pure UI; no new state crosses the wire.

- **D1.2 — Per-turn "analyzed" provenance stays pinned to its bubble.** Today
  the post-send confirmation ("Image analyzed by {provider}") is a transient
  composer *notice* (`:379-382`) that's cleared on next keystroke (`:917-921`).
  Move/duplicate that attribution onto the **stored user (or assistant) bubble**
  so each image turn permanently records which vision provider saw it — extend
  `UiImageMeta` with optional `analyzedBy?: ProviderId` set from
  `result.meta?.provider ?? result.providerId`. This makes focus auditable per
  turn instead of a vanishing toast.

- **D1.3 — Document the no-replay contract in code.** Add a short invariant
  comment block at the single-message send site (`:541-544`) naming
  "latest-image-focus" so the next reader doesn't "fix" it into replaying stale
  bytes (which is impossible anyway — bytes aren't kept — and would be a privacy
  regression).

- **D1.4 — Multi-image ordering is already correct; add a regression test** that
  asserts a 3-image turn maps to `[text, img, img, img]` in order and that a
  4-image turn is the cap (gateway 413 at `apps/gateway/src/handler.ts:615-621`,
  composer cap `image-attachments.ts:23`/`37-39`).

No change to: persistence model, relay isolation, Tokzen bypass
(`handler.ts:690-692`), or the single-message follow-up payload. The invariant
stays; we only surface it.

---

## 2. Thumbnail UX polish design

### 2.1 What exists

- **Composer chips** (`apps/web/app/(app)/chat/page.tsx:852-896`): per attachment
  a thumbnail `<img src={previewUrl}>` (object URL of the *original* file — never
  sent), filename, processed size `formatImageBytes(block.bytes)`, and an "EXIF
  stripped" badge with a title tooltip. Remove button revokes the object URL
  (`:238-245`).
- **Sent bubble** (`apps/web/app/_components/MessageBubble.tsx:97-157`): renders
  `message.images` with the preview (if the object URL survives), an `onError`
  fallback to a chip, and a caption `name · size · EXIF stripped`.
- **Lifecycle**: object URLs are transferred from composer to bubble on send
  (not revoked — `:520-523`) and freed on unmount (`:221-229`).

### 2.2 Gaps + polish design

- **T1 — Object URL leak after reload / thread switch.** Preview URLs only live
  in memory; after reload the bubble's `previewUrl` is dead and falls back to the
  chip (good), but the URLs created for the *current session's* prior threads are
  never revoked on thread switch — only on unmount (`:221-229`). Design: revoke
  on the `activeThreadId` change effect (`:208-212`) for bubbles leaving view, or
  track a per-URL ref-count. Low severity (browser frees on navigation) but a
  real polish item.
- **T2 — No lightbox / full-size view.** Thumbnails are fixed-size; there is no
  click-to-zoom. Design: click a thumbnail (composer or bubble) → modal showing
  the original `previewUrl` at natural size with the metadata caption. Pure
  client, no bytes leave.
- **T3 — Processing affordance.** `processImage` is `await`ed inline
  (`:271-283`) with no spinner; a large source can stall the chip's appearance.
  Design: insert a pending chip immediately (skeleton + filename), replace it
  with the real thumbnail when `processImage` resolves, or drop it on error.
- **T4 — Dimensions in the caption.** Blocks already carry `width/height`
  (`ImageContentBlock`, `packages/types/src/route.ts:20-21`) but the composer
  meta shows only bytes (`:868-870`). Add `1024×768` to the chip + bubble caption
  for honesty about what was actually sent (resized).
- **T5 — Alt text / a11y.** Thumbnails use `alt={att.name}` (`:864`) — fine — but
  the EXIF badge and remove buttons should keep their current `aria-label`s
  (`:889`); extend the new lightbox with focus-trap + Esc.
- **T6 — Shared component.** Extract a `<ImageChip>` / `<ImageThumb>` from the
  inline JSX so web, desktop, and (RN-adapted) mobile render identically and the
  polish lands once. This is the bridge into §3.

---

## 3. Cross-surface gap plan — desktop + mobile image UI (mirror web)

### 3.1 Confirmed: no image UI on desktop or mobile today

- **Desktop** (`apps/desktop`, Tauri + Next static export). `ChatPanel.tsx`
  *actively rejects* images: `if (file.type.startsWith("image/")) {
  setImageNotice(true); continue; }`
  (`apps/desktop/app/_components/ChatPanel.tsx:81-84`). The chat client and
  gateway client type `content` as **`string` only**
  (`apps/desktop/lib/chat-client.ts:11`, `apps/desktop/lib/gateway.ts:254`).
  No `@zintus/media` import anywhere in `apps/desktop`
  (grep: zero hits).
- **Mobile** (`apps/mobile`, Expo/React Native). Composer is a bare `TextInput`
  (`apps/mobile/app/index.tsx:282-283`), no file picker, no `@zintus/media`, no
  image path at all (grep: zero hits).

### 3.2 Desktop design — direct mirror of web (low effort)

Tauri runs a real browser webview, so `hasCanvasSupport()` is **true**
(`packages/media/src/shared.ts:412-417`) — the genuine browser
decode/resize/re-encode/EXIF path runs unchanged. Plan:

1. **Widen the content type** to `string | ContentBlock[]` in
   `apps/desktop/lib/chat-client.ts:9-12` and the `streamGatewayChat` param
   (`apps/desktop/lib/gateway.ts:253-254`). The gateway already accepts blocks.
2. **Replace the reject** at `ChatPanel.tsx:81-84` with the web image branch:
   `acceptImageFile` → `processImage(file, {name})` → store an `ImageAttachment`
   with `previewUrl` + `block`; reuse `apps/web/lib/image-attachments.ts`
   helpers (or lift them to a shared lib — see §6).
3. **Render** the shared `<ImageChip>` (§2 T6) in the composer + desktop
   `MessageBubble`, with the same EXIF badge and metadata.
4. **Vision guard + provenance** identical to web: `providerCanSeeImages` warn
   before send, "Image analyzed by …" from `X-Zintus-Vision-Provider`.
5. **Drag-drop / paste**: webview supports both, mirror `:743-746` and `:931-933`.

Risk: minimal — same runtime, same package. Mostly type-widening + UI lift.

### 3.3 Mobile design — the hard one (no canvas, no node:fs)

React Native has **neither `OffscreenCanvas` nor `node:fs`**, so
`@zintus/media`'s `processImage` has **no working path** there
(`packages/media/src/index.ts:46-47` picks browser-or-node; RN satisfies
neither). This is the core mobile design problem; options:

- **Option A (recommended) — add a third media runtime path.** Introduce
  `processImageNative()` alongside `browser.ts`/`node.ts`, using
  `expo-image-manipulator` to decode→resize (longest edge ≤2048)→re-encode to
  JPEG/PNG (re-encoding drops EXIF as a side-effect), then run the **existing
  runtime-agnostic** `detectMime` + container `stripMetadata`
  (`packages/media/src/shared.ts:194-208`, `286-403`) on the result to keep the
  *same* hard EXIF guarantee and emit the identical `ImageContentBlock`
  (`exifStripped: true`). Gate selection on an explicit `runtime: "native"`
  option or an RN capability probe, since `hasCanvasSupport()` is false on RN
  (would otherwise mis-route to the node path, which then throws
  `UNSUPPORTED_INPUT` on a Blob — acceptable fail-closed, but Option A is the
  real fix).
- **Option B (interim) — pick via `expo-image-picker`, send a clear
  "not yet supported" notice** mirroring desktop's old `setImageNotice`, so the
  surface is honest until Option A lands. Zero risk, ships the picker UI.

Mobile plan once Option A exists:
1. Add `expo-image-picker` (camera roll + camera) to the composer
   (`apps/mobile/app/index.tsx`).
2. Widen the mobile gateway client `content` to `string | ContentBlock[]`.
3. Reuse `image-attachments` logic helpers (RN-safe — they're pure, no DOM).
4. Render a native thumbnail row (RN `<Image>`), EXIF badge, size, remove.
5. Same vision guard + provenance as web/desktop.

Risk: Option A must be **proven to strip GPS** on a real photo (camera-roll
images carry GPS) — this is a security gate, not cosmetic.

---

## 4. Provider-coverage gap — capability-honest expansion

### 4.1 Reality of the provider registry

There is **no `anthropic` and no `openai` provider** in this repo. `ProviderId`
(`packages/types/src/provider-id.ts:1-13`) is: cerebras, groq, gemini,
openrouter, cohere, mistral, deepseek, fireworks, xai, huggingface, lmstudio,
ollama. Every non-Gemini provider is wired through the **OpenAI-compatible**
adapter (`packages/providers/src/factory.ts:17-30`,
`packages/providers/src/openai-compat.ts`).

- **Only Gemini maps images.** `gemini.ts:20-29` maps blocks → `inlineData`.
- **`openai-compat.ts` does NOT map content blocks.** It serializes `messages`
  verbatim into the request body (`openai-compat.ts:73-89`, line `messages,`).
  If a `ContentBlock[]` reached it, the provider would receive
  `{type:"image", data, mimeType, bytes, …}` — **not** OpenAI's
  `{type:"image_url", image_url:{url}}` shape — and silently ignore/400. This is
  exactly why the router gates these providers off.
- **The gate is real and honest.** `supportsVision` is model-specific
  (`packages/providers/src/capabilities.ts:94-99`); `VISION_MODELS` lists
  **gemini only** (`:75-83`). The router filters image requests to
  vision-capable candidates and throws `unsupported_capability` if none — incl.
  a force-selected non-vision provider (`packages/router/src/factory.ts:523-534`).
  The gateway returns the no-upsell `UNSUPPORTED_VISION_ERROR` 422
  (`apps/gateway/src/handler.ts:93-110`, `:626-627`, `:797-800`). CLI maps the
  same bare error to actionable text (`apps/cli/src/commands/chat-content.ts`
  `normalizeChatError`).

So the "gap" is: **OpenRouter (vision models), xAI Grok-vision, Mistral
(Pixtral), local Ollama/LM Studio vision models** are all left unmapped — by
design, until verified.

### 4.2 How to add a provider capability-honestly

Two-part change, **both required together** so the registry stays the single
source of truth:

1. **Add an image mapper to `openai-compat.ts`.** A `toOpenAiContent(content)`
   that maps `text → {type:"text", text}` and `image →
   {type:"image_url", image_url:{ url:`data:${mimeType};base64,${data}` }}`,
   applied per message before the body build (`openai-compat.ts:73-89`). This is
   the OpenAI multimodal wire shape that OpenRouter/xAI/Mistral accept. Text-only
   messages keep emitting plain strings (back-compat).

2. **Register the specific vision model** in `VISION_MODELS`
   (`capabilities.ts:75-83`), e.g.
   `openrouter: new Set(["…vision model id…"])`, `xai: new Set(["grok-2-vision-…"])`,
   `mistral: new Set(["pixtral-…"])`. **Never** flip a whole provider's default
   `vision` flag (`capabilities.ts:40-51`) unless its default model is itself
   vision — the model-specific set is the honesty mechanism.

**Hard-error invariant (already enforced, keep it):** a non-vision model asked
to see an image must fail, never degrade. The chain `supportsVision` →
router filter (`factory.ts:528-534`) → gateway 422 (`handler.ts:626-627`)
guarantees this. Adding a mapper without registering the model = still gated
off (safe). Registering a model without a mapper would be a bug — so land the
mapper first, then the registry entry, then the VCR test.

**Local providers (ollama/lmstudio)** stay special: vision is
runtime-*detected*, never statically asserted (`capabilities.ts:69-83` comment,
`supportsVision` returns false at `:91-98`). Their design is a gateway-side
probe of the running model — out of scope for this increment; document as a
known follow-up.

### 4.3 Honesty audit of the current matrix vs. code

`docs/multimodal-image-input.md:33-43` claims OpenRouter/xAI "left unmapped",
local "runtime-detected", others "text-only". This **matches code exactly**
(`VISION_MODELS` = gemini-only, `openai-compat` has no image mapper). No drift.
Mistral/Pixtral is the one easy honest win (clear vision model, OpenAI-compat
wire) and should be the first §4.2 candidate to verify.

---

## 5. Owner-run verification (needs a live Gemini key/quota)

CI already proves: typecheck 0, tests 0 failures, web `next build`, no base64 in
logs/errors. The following **cannot** run in CI and need the owner's keyed
machine (extends `docs/multimodal-image-input.md:66-79`):

1. **Latest-image-focus, multi-turn (the new polish target).**
   - `zintus serve`, add a Gemini key.
   - Web: attach `shotA.png`, ask "what is in this image?" → Gemini describes A.
   - Same thread, next turn, **no** new attachment, ask "what about the colors?"
     → confirm the answer is about A *only because the server kept context* and
     that the gateway log for turn 2 shows **no image bytes** re-sent
     (single-message payload, `page.tsx:541-544`).
   - Turn 3: attach `shotB.jpg`, ask "and this one?" → Gemini describes B, and
     the turn-2/turn-1 image is **not** re-sent (verify via gateway request log
     image count header `X-Zintus-Images` = 1).
2. **Multi-image single turn.** Attach 3 images in one turn → confirm Gemini
   references all three in order; confirm a 5th attach is blocked client-side
   ("up to 4", `page.tsx:264-269`) and a forged 5-image body returns 413
   (`handler.ts:615-621`).
3. **Provenance + thumbnails.** Confirm "Image analyzed by Gemini" appears and
   (post-polish) is pinned to the bubble; thumbnails render from the original
   (not the sent bytes); EXIF badge present.
4. **GPS strip proof (security gate).** Send a real phone photo with GPS EXIF →
   capture the outbound request bytes (gateway debug) → run `exiftool` on the
   decoded base64 → **must show no GPS/EXIF**. Repeat per surface added.
5. **Capability hard-error.** Force **Groq** + attach image → 422
   `unsupported_capability` with suggestions, no crash, no silent switch
   (web + CLI: `handler.ts:626-627`, CLI `normalizeChatError`).
6. **CLI Node limits.** `zintus chat "what is this?" --image ./shot.png` works;
   an oversized image is rejected with the "resize first" message
   (`chat-content.ts` `describeImageError` OUTPUT/DIMENSIONS branches), never
   silently passed.
7. **(If §4 Mistral/Pixtral landed)** Select that model + image → real
   description; confirm a non-vision Mistral model still 422s.
8. **(If §3 desktop/mobile landed)** Repeat 1–5 per surface; GPS-strip proof is
   mandatory on mobile Option A.

---

## 6. Test plan + risks

### 6.1 Tests (mirror the existing honest-logic style)

- **Unit (run in CI, no key):**
  - Content mapping: extend `packages/types/src/content.test.ts` with a 3-image
    ordering assertion (§1.4).
  - `openai-compat` `toOpenAiContent`: new test — text→text, image→image_url
    data-URL, never leaks base64 in any thrown error (mirror
    `apps/cli/src/commands/chat-content.test.ts:113-160` "never leaks base64").
  - `supportsVision`: add cases for any newly-registered model id
    (`capabilities.test.ts` style) — true for the vision model, false for the
    provider's default.
  - Router: extend `packages/router/src/factory.test.ts:263-303` — a newly
    vision-capable provider now *serves* an image request; a non-vision sibling
    still throws `unsupported_capability`.
  - Shared `image-attachments` helpers reused by desktop/mobile: keep
    `apps/web/lib/image-attachments.test.ts` green after any lift to a shared lib.
  - Mobile Option A: a `processImageNative` test that feeds known GPS-tagged
    bytes and asserts `stripMetadata` output has no EXIF (reuse the
    `packages/media/src/images.test.ts` fixtures).
- **VCR / provider (gated):** add a recorded cassette for the new vision route
  (pattern: `packages/providers/src/vcr.test.ts`) so the wire shape is pinned
  without a live key in CI.
- **Build gates:** desktop `next build` (static export) and mobile typecheck
  after content-type widening.

### 6.2 Risks

- **R1 — Mobile EXIF guarantee (high).** `expo-image-manipulator` re-encode is
  not a *proven* metadata strip on its own; Option A's mandatory
  `stripMetadata` pass + the §5.4 `exiftool` gate is the control. Do not ship
  mobile images without it.
- **R2 — `hasCanvasSupport()` mis-routing on RN (medium).** RN has no canvas, so
  the dispatcher (`packages/media/src/index.ts:46-47`) would fall to the node
  path and throw `UNSUPPORTED_INPUT` on a Blob. Fail-closed (safe) but wrong UX;
  Option A must add explicit native dispatch.
- **R3 — openai-compat regression (medium).** Adding `toOpenAiContent` touches
  the path every text provider uses. Text-only messages MUST keep emitting plain
  strings; assert this so no existing provider regresses.
- **R4 — Object-URL lifetime (low).** §2 T1 leak; bounded by navigation, but fix
  on thread switch.
- **R5 — Capability drift (low, guarded).** Registering a vision model without
  the mapper, or vice-versa, breaks honesty. Land mapper → registry → test in
  that order; the router gate fails *closed* if they're out of step.
- **R6 — Relay isolation must hold on new surfaces (high).** Desktop/mobile must
  use the same device→gateway→provider BYOK path; image bytes must never touch
  the Zintus relay, never be logged, and must bypass Tokzen
  (`handler.ts:690-692`). Re-verify per surface (§5.4 + log inspection).

### 6.3 Sequencing (smallest honest increments)

1. **Polish-only, no wire change:** §1.2 (focus indicator + pinned provenance +
   invariant comment), §2 (thumbnail T1–T6, shared `<ImageChip>`). Owner verify
   §5.1–5.4 on Gemini.
2. **Desktop mirror** (§3.2) — low risk, reuses browser media path.
3. **Provider win** (§4.2) — Mistral/Pixtral first (clear vision model + OpenAI
   wire), mapper→registry→VCR.
4. **Mobile** (§3.3 Option B picker first for honesty, then Option A native
   media path behind the §5.4 GPS gate).

Each step keeps the core contract: *Zintus never reads an image itself; only a
vision-capable model does, or the request fails clearly.*
