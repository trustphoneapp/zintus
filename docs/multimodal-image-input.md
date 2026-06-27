# Multimodal Image Input

Honest image understanding for Zintus. Shipped on `feat/multimodal-image-input`
as PRs 1–7. This documents what's real, the privacy/security model, and the
[HUMAN] smoke gate before any of the 🟡 rows flip to ✅.

## What it does (and refuses to do)

- **Zintus does not read images by itself.** An image is only ever understood by
  a **vision-capable model**. If no vision-capable provider/model is available,
  the request **fails** with a clear `unsupported_capability` error + provider
  suggestions — it is **never** silently downgraded to text-only, and **never**
  faked with an injected `[Image: filename]` note.
- **Images are EXIF/GPS-stripped before they're sent** (re-encode/container
  surgery in `@zintus/media`). Output blocks are marked `exifStripped: true`.
- **Image bytes never touch the Zintus relay.** They go device → local gateway →
  the **user-chosen vision provider** (the same BYOK/LAN path as text). They are
  never logged, never put in traces, and never passed through Tokzen compression.
- **v1 accepts only `image/jpeg`, `image/png`, `image/webp`.** Rejected: SVG
  (XML/script surface), GIF, video, PDF, remote image URLs, image generation.
- **Max 4 images per request.** Processed images are capped at 4 MB, longest edge
  2048 px.

## Surfaces

| Surface | Status | Notes |
|---|---|---|
| **Web chat** | 🟡 code-complete | File picker / drag-drop / paste (jpeg/png/webp), thumbnail + processed size + "EXIF stripped" badge, max-4, pre-send vision warning, 422 handling, "Image analyzed by {provider}". Browser path uses canvas (decode→resize→re-encode→strip). Logic + build green; the canvas run + a keyed Gemini call are the smoke gate. |
| **CLI** | 🟡 code-complete | `zintus chat "…" --image a.png --image b.png` (repeatable, max 4), Node path. **Limitation:** Node has no pixel codec, so it can't resize/re-compress — an image > 2048 px or > 4 MB is **rejected with a clear error** ("resize first"), never silently passed. EXIF-strip is real in Node. Mutually exclusive with `--workspace`/`--diff` (the compile path is text-only). |
| **Mobile** | ❌ deferred | Image UI out of scope for v1. |
| **Desktop** | ❌ deferred | Image UI out of scope for v1. |

## Provider vision support

Vision is **model-specific**, never whole-provider (`supportsVision(provider, model)`):

- **Gemini** — ✅ default `gemini-2.5-flash` (+ other gemini vision models) map
  image blocks to `inlineData`.
- **OpenRouter / xAI** — vision is model-specific and **left unmapped** until a
  route is explicitly verified + tested. Not enabled in v1.
- **Ollama / LM Studio** — never globally vision; require a runtime-**detected**
  local vision model (LLaVA / Qwen-VL / Moondream / Gemma-vision). Not auto-asserted.
- **Groq / Cerebras / DeepSeek / Cohere / Fireworks / HF** — text-only.

## Architecture (PR map)

1. **PR1** `@zintus/types` content blocks (`ContentBlock`, `ChatMessage.content:
   string | ContentBlock[]`, helpers) + `@zintus/schemas` validation + model-aware
   `supportsVision`. Backward compatible (string content unchanged).
2. **PR2** `@zintus/media` `processImage` — mime sniff, size guard, EXIF strip,
   (browser) resize/re-encode. Never logs/throws image bytes.
3. **PR3** Gateway: max-4, vision gate, **Tokzen bypass for image requests**,
   `unsupported_capability` error, `X-Zintus-Vision-Provider/-Images/-Image-Bytes/
   -Exif-Stripped` headers. Router: filters candidates to vision-capable; throws
   `unsupported_capability` if none (incl. a forced non-vision provider).
4. **PR4** Gemini adapter: blocks → `parts` (`inlineData`); rejects images in
   system messages; assistant turns stay text-only.
5. **PR5** Web UI. **PR6** CLI `--image`. **PR7** this doc + the matrix.

## What this branch deliberately does NOT touch

No Stripe, referrals, managed keys, paid tiers, credit ledger, overflow proxy,
Pro upsell, or "upgrade to use images." Image routing uses the same free BYOK
path; the only thing that changes is *which* model can serve the request.

## [HUMAN] final smoke gate (flips 🟡 → ✅)

Verified in CI: `bun run typecheck` 0 errors, `bun run test` 0 failures, web
`next build` succeeds, no base64 in logs/errors (tested). **Still required on a
real machine:**

1. Start the gateway (`zintus serve`), add a Gemini key.
2. Web: attach a screenshot, ask "what is in this image?" → confirm Gemini
   describes it; confirm no image data in gateway logs.
3. Web: select **Groq** + attach an image → confirm the `unsupported_capability`
   message + suggestions (no crash, no silent switch).
4. CLI: `zintus chat "what is in this?" --image ./shot.png` → same behavior; a
   non-vision provider returns the clear capability error; oversized image is
   rejected with the "resize first" message.
