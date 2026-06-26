# Plan: multimodal image input (mobile #5) — scoped, deferred

Image attach on mobile is **not** a mobile-only task. Decided 2026-06-26 to ship
the rest of `feat/mobile-serious-app` first and do this as its own PR because it
changes the production-audited **execution plane** (types → schemas → providers →
gateway → router). A picker button without this backend is a dead end, so none
was shipped.

## Why it's blocked today (evidence)

- `ChatMessage.content` is `string` only — `packages/types/src/route.ts:5-8`.
- Wire schema enforces `content: z.string()` — `packages/schemas/src/index.ts:18-21`.
- `Provider.streamChat(messages)` takes string content only —
  `packages/types/src/provider.ts:29-32`.
- No image/base64/multipart path in the chat handler —
  `apps/gateway/src/handler.ts:510-916`.
- No vision/modality capability field anywhere — `ProviderMetadata`
  (`packages/providers/src/provider-metadata.ts:12-41`), `Provider`
  (`packages/types/src/provider.ts:22-34`). Only the prose word "multimodal" in
  Gemini's description.
- Research takes no attachments — `packages/schemas/src/index.ts:98-105`.

## Change set (in dependency order)

1. **types** (`packages/types`)
   - `ContentPart = { type: "text"; text: string } | { type: "image"; image: { dataUrl?: string; url?: string; mimeType: string } }`.
   - `ChatMessage.content: string | ContentPart[]` (keep `string` as the common case).
   - Add `vision?: boolean` (or `modalities: ("text"|"image")[]`) to `Provider` and
     `ProviderMetadata`.

2. **schemas** (`packages/schemas`)
   - `content` zod → `z.union([z.string(), z.array(ContentPartSchema)])`. Add a
     base64/size guard for inline images. Keep backward-compat (string still valid).

3. **providers** (`packages/providers`)
   - Set the new capability flag per provider (Gemini = true; most current BYOK
     providers = false). Source from each provider's real API support.
   - In each `streamChat`, map `ContentPart[]` to that provider's vision wire format
     (OpenAI-style `image_url` parts for OpenRouter/compatible; Gemini `inlineData`).
     Providers without vision must reject image parts with a clear error.
   - Pricing/token-estimate: account for image tokens where the provider bills them.

4. **router** (`packages/router`)
   - Thread `ContentPart[]` through untouched. In Auto mode, when any message has an
     image part, **filter candidates to vision-capable providers** (the auto-route
     requirement) and fail with a helpful message if none are keyed.

5. **gateway** (`apps/gateway`)
   - Pass multimodal content through `handleChatCompletions`. Tokzen compresses only
     the text parts (leave image parts intact). Enforce a body-size cap for inline
     images. Update `openapi-spec` + its test.
   - Optional: add attachments to `/v1/research` (`ResearchRequestSchema`).

6. **mobile** (`apps/mobile`)
   - `bun add expo-image-picker@~56.0.x expo-image-manipulator@~56.0.x`.
   - `lib/images.ts`: gallery + camera pick → `expo-image-manipulator` resize +
     **EXIF strip** (re-encode) + size cap → data URL `ContentPart`.
   - Compose image parts into the user message (alongside `lib/attachments.ts` text).
   - Capability check before send; in Auto mode rely on the router's vision filter;
     clear error when the pinned provider has no vision.
   - **app.json**: add `NSCameraUsageDescription`, `NSPhotoLibraryUsageDescription`
     (+ `NSPhotoLibraryAddUsageDescription` if saving). Audit the generated
     AndroidManifest; `expo-image-picker` auto-adds `RECORD_AUDIO` — drop it via
     `android.blockedPermissions` if camera-only. See `docs/store/*` permission tables.

## Test impact
- Update provider contract tests, `handler.test.ts`/`contracts.test.ts`,
  `openapi-spec.test.ts`, schema tests. Add a VCR fixture for one real vision call
  (Gemini) so the multimodal path is regression-covered. Keep the existing 294 green.

## Acceptance
Photograph a screen/document on a phone, ask about it, get an answer from a
vision-capable provider (auto-routed), with the image EXIF-stripped and the
data-destination consent shown before send.
