# Postbuild Review — Cross-Provider IMAGE Mapper + Vision Registry

Date: 2026-06-28 · Branch: `feat/tool-calling` · Suite 971 green
Scope: `packages/providers/src/openai-compat.ts` (image mapper) +
`packages/providers/src/capabilities.ts` (openrouter VISION_MODELS).
Design: `docs/audit/2026-06-28/12-design-multimodal-polish.md`. READ-ONLY.

Honesty bar: 10/10. Verdict: **PASS** — ships honest. One latent edge-case
RISK (image co-located with a tool block) that no real turn produces today.

---

## (1) Are the registered openrouter vision models REAL + correctly named? — CORRECT

`capabilities.ts:110-113`:
```
openrouter: new Set([
  "meta-llama/llama-3.2-90b-vision-instruct",
  "meta-llama/llama-3.2-11b-vision-instruct",
]),
```
Both ids are genuine OpenRouter model slugs (the Llama 3.2 Vision-Instruct
multimodal family, OpenAI-compatible `image_url` chat route). The vendor prefix
`meta-llama/`, the `-vision-instruct` suffix, and the 90B/11B variants all match
OpenRouter's catalog naming convention used elsewhere in the registry
(`capabilities.ts:63` default `meta-llama/llama-3.3-70b-instruct:free`). No typo,
no hallucinated `:free`/version tail appended to a vision id. The header comment
(`:98-101`) correctly scopes them as model-specific vision routes, not a
provider-wide flag. **CORRECT.**

## (2) Gemini-only default-vision invariant preserved? — CORRECT

`supportsVision("openrouter")` with NO model → `MODEL_CAPABILITIES.openrouter.vision`
= `false` (`capabilities.ts:63`, `:129`). The openrouter default
(`llama-3.3-70b-instruct:free`) is NOT in `VISION_MODELS.openrouter`, and the
registry default flag is untouched. Only the two explicit 3.2-vision ids return
true. Every other provider default still `vision:false` except gemini
(`:62`). The model-specific allowlist is the sole honesty mechanism — the
provider default flag was **not** flipped (design §4.2 rule honored). **CORRECT.**

## (3) Mapper preserves order + never leaks base64 to logs? — CORRECT

- **Order:** `toOpenAiContentParts` (`openai-compat.ts:51-64`) iterates `content`
  in array order, pushing `text`→`{type:"text"}` then `image`→`{type:"image_url"}`
  in situ. Text-first-then-images (or any interleave) is preserved exactly as the
  composer built it — mirrors Gemini's order-preserving `inlineData` map. **CORRECT.**
- **No base64 in logs:** the `data:${mimeType};base64,${data}` string is produced
  ONLY inside the request body passed to `JSON.stringify` at `openai-compat.ts:306-321`;
  it is never `console`-logged, never thrown. The one error path,
  `assertOkResponse` (`utils.ts:294-300`), reads the provider's **response** body —
  not the request — so base64 cannot reach the thrown `ProviderHttpError` message.
  Gateway gate (`handler.ts:688`) reaffirms bytes are never logged/relayed/Tokzen'd.
  **CORRECT.**

## (4) Coexists with tool_call / tool_result mapping (no clobbering)? — CORRECT, with edge-case RISK

`toOpenAiMessages` (`:98-154`) branches mutually-exclusively per turn:
`tool_result`s always emit their own `role:"tool"` messages first (`:120-126`),
then a single if/else: `toolCalls>0` → assistant+`tool_calls`; else
`toolResults>0` → text-only; else **`content.some(image)`** → multimodal parts
(`:143-146`); else → joined text. The image branch only fires when no tool blocks
are present, so it never overwrites or is overwritten by tool mapping. Text-only
arrays still collapse to a plain string (back-compat R3 preserved). **CORRECT.**

- **RISK (latent, severity LOW):** a single turn carrying BOTH a tool block AND an
  image would drop the image — `toolCalls>0`/`toolResults>0` win and
  `toOpenAiContentParts` is never reached (and even if reached, it skips tool
  blocks). No code path in this repo produces such a turn (image turns are pure
  user-content; tool turns are model/tool-generated), so it is unreachable today,
  but the if/else priority makes the image a silent loser rather than a
  hard-error. Worth a guard comment if image+tool turns ever become possible.

## (5) Non-vision model — does the router gate fail closed (no silent drop)? — CORRECT

Two independent fail-closed gates:
- **Router** (`router/src/factory.ts:562-568`): `requiresVision(messages)` →
  filter candidates by `supportsVision(id, request.model)`; empty →
  `throw "unsupported_capability"`. A forced non-vision openrouter (default
  model, or any model not in the set) is filtered out and hard-errors. With
  `request.model` undefined, `supportsVision` returns the default flag (false for
  openrouter) → correctly rejected.
- **Gateway explicit-provider gate** (`handler.ts:702-704`): `hasImages &&
  body.provider && !supportsVision(body.provider, body.model)` → `422
  UNSUPPORTED_VISION_ERROR` before routing. No silent image drop, no text-only
  fallback. The mapper-without-registry-entry case stays gated OFF (safe), exactly
  per design §4.2 ordering. **CORRECT.**

## (6) Efficiency — CORRECT (acceptably cheap)

Per image-bearing message: 2 `filter` passes (tool_result/tool_call) + `textOf`
+ one `some()` + one `toOpenAiContentParts` linear pass. All O(n) in block count
(n ≤ ~6: text + ≤4 images). The early `!isContentBlockArray` fast-path
(`:106-109`) keeps plain-string turns allocation-free. The base64 data-URL is
built once per image with a single template literal — no copy/re-encode. No
redundant JSON serialization. **Not INEFFICIENT.** Micro-note: the
filter/filter/some trio re-scans `content` ~4×, but n is tiny — not worth fusing.

## (7) What's still ❌ (deferred to design fleet)

- **Desktop image UI** ❌ — `apps/desktop` still actively rejects images
  (`ChatPanel.tsx:81-84`), content typed `string` only. Deferred (design §3.2).
- **Mobile image UI** ❌ — no picker, no `@zintus/media` path; RN has no
  canvas/node:fs so `processImage` has no runtime (design §3.3 Option A/B). The
  GPS-strip security gate (§5.4/R1) is mandatory before mobile ships.
- **Other OpenAI-compat vision providers** still UNMAPPED by design: xAI
  Grok-vision, Mistral/Pixtral, local ollama/lmstudio (runtime-detected). The
  mapper now exists for them, but they remain gated off until their model ids are
  verified + registered + VCR-tested (design §4.2 sequencing). This is honest, not
  a gap — the registry is the single source of truth.
- **No VCR cassette** yet pinning the new openrouter image wire shape (design §6.1
  lists it as the gated test) — unit-only coverage so far.

---

## Classification summary

| # | Item | file:line | Verdict |
|---|------|-----------|---------|
| 1 | openrouter vision model ids real/named | `capabilities.ts:110-113` | CORRECT |
| 2 | gemini-only default-vision invariant | `capabilities.ts:63,129` | CORRECT |
| 3a | mapper preserves block order | `openai-compat.ts:51-64` | CORRECT |
| 3b | base64 never logged/thrown | `openai-compat.ts:306`, `utils.ts:294` | CORRECT |
| 4 | coexists w/ tool_call/tool_result | `openai-compat.ts:111-150` | CORRECT |
| 4e | image+tool-block turn drops image | `openai-compat.ts:128-146` | RISK (latent, unreachable today) |
| 5 | non-vision model fails closed | `factory.ts:562-568`, `handler.ts:702` | CORRECT |
| 6 | mapper efficiency | `openai-compat.ts:51-64` | CORRECT |
| 7 | desktop/mobile/other-provider UI | (deferred) | ❌ by design |
