# CORE RUNTIME — re-verification audit (2026-06-28)

Branch `feat/multimodal-image-input` @ `6bcd097`. Independent re-read of the
ACTUAL code for the prior `2026-06-26/01-core-runtime.md` P0/P1/P2 list, plus the
claims that landed this session. Every classification below was verified against
source, not the changelog. Targeted suites run green (`packages/providers`,
`packages/router`, `packages/types`, `packages/media`, `packages/memory`,
`packages/cache`, plus `packages/engine/src/*`); the only "failures" seen were
stale **`packages/engine/dist/*.test.js`** compiled artifacts a directory glob
picks up — the canonical `bun run test` enumerates `src` paths and never globs
`dist`, so they are not real (the `src` engine test passes 5/5).

## VERDICT (one line)
Materially stronger than 2026-06-26: Private-Mode honesty, the capability
registry, the multimodal image path (types→schema→media→Gemini→router filter),
honest memory/embedding labeling, real OTel timing, and the two ledger holes are
all genuinely fixed in code with tests. It is **still NOT 10/10**: tool/function
calling and structured/JSON output remain entirely absent (only forward-looking
registry *flags* exist), "capability"/"quality" routing is still a relocated
static brand-rank (not per-model), and tokzen's savings ratio still scopes to
compressed segments with an all-OpenAI tokenizer. One NEW defense-in-depth gap:
`openai-compat` serializes the internal image block verbatim, leaning entirely on
the router filter.

---

## P0 (prior list)

- **P0-1 No tool/function calling — STILL-OPEN.** A repo-wide grep for
  `response_format|tool_calls|tool_choice|functionDeclarations|json_schema`
  (excluding `dist`/tests) returns **exactly one** hit: `capabilities.ts`. So the
  only "tools/json" presence is the registry's *boolean flags*
  (`capabilities.ts:31-34,41-51`) — nothing consumes them. `RouteRequest`
  (`types/route.ts:90-134`) and `StreamChatOptions` still have no
  `tools`/`tool_choice`; no provider emits `tool_calls`; the engine has no tool
  loop. The only "tool" sent upstream remains the OpenRouter `web_search`
  pseudo-tool (`openai-compat.ts:83-85`). Disqualifying vs ChatGPT/Claude/
  Gemini/Cursor for agentic use.

- **P0-2 Private-Mode silent leak — FIXED** (`2bfd0af`). Closed on three sides,
  with tests:
  1. `data-policies.ts:142-144` `mayTrainOnUserData()` returns `true` for
     anything whose `trainsOnData !== false`, so `"unknown"` providers
     (openrouter/deepseek/xai/huggingface) are now treated as may-train — the
     exact leak the prior audit named.
  2. `router/factory.ts:512-521` filters candidates by `!mayTrainOnUserData` (or
     explicit allow) under `blockTrainingProviders`; the filter is skipped only
     when it would strand the request (`filtered.length > 0` guard).
  3. The strand-fallback is no longer silent: `factory.ts:752-755` sets
     `privacyHonored = allowed || !mayTrain` on the winner, typed + documented at
     `types/route.ts:151-166` ("Surfaces MUST render … not honored"). Coverage:
     `router/factory.test.ts:137-244` asserts `true`, `false` (strand), `true`
     (explicit allow), and `undefined` (mode off). Honest now.

## P1 (prior list)

- **P1-1 "semantic memory" is keyword-hash — FIXED as an HONESTY issue**
  (`5cd4afa`). `embeddings.ts:3-14,27-49` now labels the fallback non-semantic,
  exposes `embeddingMode()`, stores it as `"fallback-hash-v1"`, and emits a
  one-time stderr warning on first real use (observed in the test run). The
  *capability* is unchanged (default is still keyword-hash token-overlap unless
  `OLLAMA_HOST` is set) — but it is no longer presented as semantic, which is
  what the prior P1 was about.

- **P1-2 wrong-fact extraction — FIXED** (`bad2f13`). `extract.ts:43-196` now
  captures modal+clause (preserves negation), rejects conversational reactions
  (`REACTION_LEADS`) and first-person narrative (`NARRATIVE_LEADS`), skips
  questions (`isQuestion`), splits to sentences so a match can't span ideas, and
  requires an actionable object (`hasActionableObject`, ≥2 content words). "I
  can't believe this works" → lead `believe` → dropped (`:179`). Also now
  multimodal-safe via `textOf(turn.content)` (`:204`).

- **P1-3 "capability"/"quality" routing = static brand opinion — PARTIALLY
  ADDRESSED, substantively STILL-OPEN.** The rank now lives in the data-driven
  registry (`capabilities.ts:39-67` `capabilityTier`) and is wired into routing
  via `providerCapabilityTier` (`priority.ts:2,83,89,103,113`), so there is one
  source of truth — a real improvement. **But the numbers are the same static
  per-provider ordering** (gemini 1 … groq 10), explicitly "unchanged so routing
  order is preserved" (`capabilities.ts:21-22`, `priority.ts:4-8`). It is still a
  hardcoded provider opinion, not per-model capability routing; Groq/Cerebras
  serving Llama-3.3-70B still rank last. Relocation, not behavior change.

- **P1-4 tokzen ratio scoped to compressed segments — STILL-OPEN.**
  `pipeline.ts:32-44` `mergeResults` still sums `originalTokens`/
  `compressedTokens` over **only the transformed `results`** (segments pushed
  when `transforms.length > 0`), so a request with one compressed block beside a
  large untouched user message reports a ratio for the block, not the whole
  request. And `count.ts:2,5` `countTokensFast` still uses `gpt-tokenizer`
  (OpenAI BPE) for ALL providers — the `_model` arg is ignored — so absolute
  tokens-saved for Llama/Gemini stay approximate. (The savings *ledger* itself is
  separate and uses real provider-reported tokens — see LEDGER below.)

## P2 (prior list)

- **Failed request debits daily REQUEST budget — FIXED** (`b4194cf`).
  `quota-ledger.ts:374-382`: `billable = input.status === "success"` now gates the
  ENTIRE daily `applyUsage` update (request count + token cost), not just tokens.
  Failed/rate-limited attempts still write to `usage_log` with zero tokens
  (`:391-392`) so the rolling 60s RPM/TPM window and error-streak health are
  unaffected. Coverage: `quota-ledger.test.ts:37-66`.

- **OTel synthetic span offsets — FIXED** (`8fbd44f`). `otel.ts:72-104,140-181`
  builds spans from REAL `startMs/endMs/attemptEndsMs` (monotonic
  `nowEpochMs()`), reconstructing attempt starts as `realEnd − measured latency`.
  Crucially the engine actually captures and passes them: `engine.ts:443`
  (`otelStartMs`), `:565` (`attemptEndsMs.push(nowEpochMs())` per attempt),
  `:529-535,619-626` (passes `startMs/endMs/attemptEndsMs`). Not a stub; export
  is real OTLP/HTTP POST (`:205-220`).

- **vec0 `INSERT OR REPLACE` UNIQUE-constraint risk — FIXED** (`d62601b`,
  `bfa657c`). `memory-store.ts:545-548,573-576` now uses the DELETE-then-INSERT
  idiom for vec0 rows by rowid, with comments explaining vec0 rejects the upsert.

- **TPM over-reserve at fixed 1024 — FIXED/MITIGATED** (`856d301`).
  `factory.ts:125` `DEFAULT_OUTPUT_RESERVE_TOKENS = 4096`;
  `reservedOutputTokens` (`:133-138`) honors a positive `maxTokens` exactly and
  falls back to 4096. `estimateReserveTokens` (`:200-205`) adds it to the input
  estimate. Still an estimate, not a hard cap — `recordUsage` reconciles on
  completion (the comment is honest about only SHRINKING the under-reserve
  window, not erasing it). Reasonable.

- **No JSON mode / `response_format` — STILL-OPEN.** Same grep as P0-1: absent
  everywhere except the registry flag.

- **`redact.ts` misses UUID / generic-format tokens — STILL-OPEN (documented).**
  `redact.ts:18-27` covers prefixed keys (csk-/sk-/AIza/gsk_/xai-/hf_ + Stripe)
  but not bare `\S{8,}` Cohere/Mistral/Fireworks keys or UUID-style virtual keys
  — acknowledged in its own header (`:4-7`). Low severity; callers must still
  avoid logging raw key material.

## MULTIMODAL (role #9) — the prior "vapor" is now BUILT and honest
The 2026-06-26 report called the multimodal plan vapor and the runtime text-only
end-to-end. That is no longer true; the path exists and is capability-honest:

- **Types** (`types/route.ts:7-88`, `6a26517`): `ContentBlock = TextContentBlock
  | ImageContentBlock`; `ImageContentBlock` carries raw base64 (no `data:`),
  bounded mime, `exifStripped: true`; `ChatMessage.content: string |
  ContentBlock[]` (back-compatible). Helpers `textOf`, `imageCount`,
  `requiresVision`, `sanitizeForLogs` (elides bytes for logs).
- **Schema edge** (`schemas/index.ts:28-56`): `ImageBlockSchema` enforces
  `exifStripped: z.literal(true)` (un-stripped images rejected), refuses a
  `data:` prefix, bounds `bytes`, restricts mime to jpeg/png/webp. Strong.
- **Capability registry** (`capabilities.ts:75-99`): `VISION_MODELS` is
  deliberately narrow/model-specific — only Gemini default-vision models mapped;
  OpenRouter/xAI/local stay UNMAPPED until a route is verified. `supportsVision`
  is model-aware (no whole-provider assumption).
- **Media processor** (`packages/media`, `9c0c79d`): genuinely solid —
  magic-byte-only mime detection, SVG/GIF/PDF/TIFF/BMP rejected (`shared.ts:160-208`),
  REAL container-level EXIF/GPS/XMP/text stripping for jpeg (APPn/COM),
  png (chunk allow-list), webp (EXIF/XMP chunk drop + VP8X flag clear)
  (`shared.ts:286-403`); browser path resizes/re-compresses via canvas, Node path
  honestly REJECTS oversize rather than silently passing (`node.ts:46-99`); bytes
  never logged or thrown. `exifStripped: true` is honest (set only after strip).
- **Gemini provider** (`providers/gemini.ts:22-61`): user parts → `inlineData`,
  order preserved; assistant turns stay text-only; an image in a SYSTEM message
  throws (never silently dropped).
- **Router vision filter** (`factory.ts:528-535`): an image request is filtered
  to vision-capable provider+model; if none remain (incl. a forced non-vision
  provider) it throws `unsupported_capability` — HARD ERROR, never a silent
  text-only downgrade. Coverage: `factory.test.ts:263-303`.
- **Cross-cutting string consumers handled:** token estimate
  (`token-estimate.ts:26` `textOf`), L1 cache key includes full content incl.
  image bytes (`cache.ts:365-371`) and the semantic-cache query flattens via
  `textOf` (`cache.ts:539-541`), memory extract uses `textOf`. The old
  "everything assumes string" concern is addressed.

**NEW finding (defense-in-depth, low severity): `openai-compat.ts:75` serializes
`messages` verbatim into the upstream body.** It does not defensively reject an
`ImageContentBlock`; it relies ENTIRELY on the router's vision filter to keep
images away (no openai-compat default model is vision-capable in the registry).
If an image block ever reached it (a direct/forced call bypassing the router
filter), it would emit the internal `{type:"image",data,...}` shape — NOT
OpenAI's `{type:"image_url",...}` — i.e. a malformed body, not a clean
capability rejection. Text-only `ContentBlock[]` arrays serialize as valid
OpenAI `{type:"text"}` parts, so those are fine. Recommend a guard in
openai-compat that throws `unsupported_capability` on any image block.

## LEDGER / QUOTA (role #10) — honest and tighter than before
- In-flight admission still synchronous/race-free: `tryReserveProvider`
  (`factory.ts:212-223`) reserves before the awaited dispatch (`:561`); release on
  every terminal path (`:578-586,737-742`).
- Output reserve raised 1024→4096 with `maxTokens` honored exactly (P2 above) —
  shrinks the TPM-overshoot window for TPM-bound providers.
- Failed requests no longer debit the daily budget (P2 above).
- **Savings valuation is honest** (`quota-ledger.ts:263-288`): `savingsUsd`
  counts only `status='success'` rows, groups by (provider, model) and values
  each at its own `paidEquivalentUsdPerMTok`, using REAL logged token counts
  (provider-reported where available; `factory.ts:667-668` prefers
  `reportedUsage`). Because failures now log zero tokens, they can't inflate
  savings. No silent over-claim found.

## DOC-DRIFT (re-checked)
- The prior "`docs/multimodal-image-plan.md` is vapor" is now moot — the feature
  shipped as code (PRs `6a26517`/`5396d7c`/`9c0c79d`) with tests; verify any
  remaining doc references point at the implementation, not a plan.
- "capability"/"quality" still presented anywhere as model-/context-aware would
  remain inaccurate: routing is a relocated static provider tier (P1-3).
- Memory now self-labels the keyword-hash fallback honestly (P1-1) — the prior
  "presented as semantic" drift is corrected at the source.

## COMPETITOR GAPS (still true)
1. Tool/function calling + MCP — absent (only registry flags). 2. Structured/JSON
output — absent. 3. Vision — now real but single-provider (Gemini default only);
no openai-compat `image_url` route wired. 4. Per-MODEL capability routing — still
per-provider tier. 5. Structured stream events (tool_calls/citations) — absent.

## WHAT TESTS DON'T COVER
- No test exercises `openai-compat` with an `ImageContentBlock` (the verbatim
  passthrough above is unguarded and untested).
- No live-provider smoke for the Gemini `inlineData` vision path (mocks only);
  the real `usageMetadata`/SSE multimodal round-trip is unverified on a real key.
- `privacyHonored` is unit-tested in the router but I did not verify any SURFACE
  (web/CLI/desktop) actually renders the "not honored — used X" signal — that is
  out of this scope but is the half that makes the field meaningful.
- tokzen whole-request ratio vs compressed-segment ratio has no test asserting
  the presented number matches the whole request.
- vec0 DELETE-then-INSERT is unverifiable on macOS (the bug it fixes is
  Linux/CI-only); trust the CI run.

---

## Honest verdict — core runtime
This session did real, code-level work, not changelog theater: Private Mode is now
literally honest (`"unknown"` providers filtered + a typed `privacyHonored`
strand signal, all unit-tested), the multimodal image path is genuinely built and
capability-honest end-to-end (magic-byte validation, real EXIF/GPS stripping,
schema that rejects un-stripped images, a model-specific vision filter that hard-
errors instead of silently downgrading), memory stops lying about "semantic"
recall and stops inventing constraint facts, OTel timing is measured not
synthesized, and the two ledger holes (failed-request debit, fixed-1024 reserve)
are closed with the savings ledger valuing only real successful tokens per model.
That is a credible, honest BYOK/local-first runtime — clearly beta-worthy on the
Gemini-vision + text paths. It is still not a 10/10 launch surface: tool/function
calling and structured/JSON output are entirely absent (the registry only carries
forward-looking flags nothing consumes), "capability"/"quality" routing is a
relocated static brand-rank rather than per-model capability, tokzen's savings
ratio still scopes to compressed segments with an all-OpenAI tokenizer, and
`openai-compat` would serialize a malformed image body if the router filter were
ever bypassed. Fix those — chiefly tools + structured output, real per-model
capability routing, and an openai-compat image guard — before claiming capability
parity.
